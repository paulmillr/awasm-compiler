import * as P from 'micro-packed';
import * as js from './js.ts';
import { allocateMemSpec, memOps, memoryProxy } from './memory.ts';
import { Module, array, type Flags } from './module.ts';
import * as rewrites from './rewrites.ts';
import type { TypeName } from './types.ts';
import * as types from './types.ts';
import * as utils from './utils.ts';
import * as wasm from './wasm.ts';
import * as workers from './workers.ts';

// Main idea: instead of creating AST from parsing strings (what is real compilers do),
// we just create tree using some DSL-like structure

export type NodeIdx = string;
type Opts = Record<string, any>;
type Memory = Record<string, ReturnType<typeof allocateMemSpec>>;

export type NodeMap = {
  op: { op: string; type: TypeName; args: NodeIdx[]; opts: Opts };
  module: { name: string; opts: Opts; memory: Memory; nodes: Node[] };
  function: {
    name: string;
    inputs: TypeName[];
    outputs: NodeIdx[];
    nodes: Node[];
    opts: Opts;
    memOps: Record<string, { write?: NodeIdx; reads: NodeIdx[] }>;
    embedPos: number;
    embedFns: Record<string, any>;
  };
  block: {
    name?: string;
    args: NodeIdx[];
    outputs: NodeIdx[];
    opts: Opts;
    shape: any;
    nodes: Node[];
  };
  loop: {
    name?: string;
    args: NodeIdx[];
    outputs: NodeIdx[];
    opts: Opts;
    shape: any;
    nodes: Node[];
  };
};

export type Node = { [K in keyof NodeMap]: { kind: K } & NodeMap[K] }[keyof NodeMap];
export type NodeOf<K extends keyof NodeMap> = Extract<Node, { kind: K }>;
type K = keyof NodeMap;
/**
 * Narrow graph node kind on type level
 */
export function as<Ks extends readonly K[]>(n: Node, ...ks: Ks): NodeOf<Ks[number]>;
export function as(n: Node, ...ks: K[]) {
  if (!ks.includes(n.kind as K)) throw new Error(`expected ${ks.join('|')}, got ${n.kind}`);
  return n; // typed via the generic overload
}
/**
 * Type guard for node type
 */
export const is = <Ks extends readonly K[]>(n: Node, ...ks: Ks): n is NodeOf<Ks[number]> =>
  ks.includes(n.kind as K);
/**
 * Check if graph node is operation
 */
export function isOp<const O extends readonly string[], N extends { kind: Node['kind'] }>(
  n: N,
  ...ops: O
): n is N & NodeOf<'op'> & { op: O[number] } {
  // runtime check
  if ((n as any).kind !== 'op') return false;
  return ops.length === 0 ? true : (ops as readonly string[]).includes((n as any).op);
}
/**
 * Symbolic representation of variable. Can be used to index into memory array because of 'toString' method whichs creates JSON
 */
export class FnOp {
  idx: NodeIdx;
  constructor(idx: NodeIdx) {
    if (typeof idx !== 'string') throw new Error('FnOp: wrong idx=' + idx);
    this.idx = idx;
  }
  toString() {
    return JSON.stringify({ idx: this.idx });
  }
}
/**
 * Main compiler opts, all rewrites/flavors of code generation defined via this.
 */
export type CompilerOpts = Flags & {
  lowerU64?: boolean;
  lowerSIMD?: boolean;
  lowerSmallInt?: boolean;
  rawWasm?: boolean; // returns raw wasm instead of js boilerplate
  rawWasmInstr?: boolean;
  optimize?: boolean;
  opt_i32xi32?: boolean;
  optExtMul?: boolean;
  patternMemoryEndianess?: boolean;
  lowerU64Arg?: boolean;
  lowerPattern?: boolean;
  lowerPatternJS?: boolean;
  lowerWasm?: boolean;

  // wasm low level (both js and wasm)
  wasmBlockType?: boolean;
  wasmTee?: boolean;
  wasmTeeSimd?: boolean;

  freeze?: boolean; // Object.freeze on module stuff
  reuseModule?: boolean; // Cache module at instantiation for re-use
  importMemory?: boolean;
  noMaximumLimit?: boolean;
  wasmAsHex?: boolean; // Use hex template literal instead of base64+atob for embedded wasm
  // JS only (emitter)
  jsOpsPerFn?: number;
  jsArgPerFn?: number;
  jsOutPerFn?: number;
  jsStateArray?: boolean;
  jsOutObject?: boolean;

  // batch selectors
  useThreads?: boolean;
  useSIMD?: boolean;

  // Threads
  threadLimit?: number;
  customWorkerCode?: string;
  customWorkerCodeInit?: string;
};

const DefaultOpts: CompilerOpts = {
  freeze: true,
  optimize: true,
  lowerSmallInt: true,
  lowerPattern: true,
  wasmBlockType: true,
  wasmTee: true,
  optExtMul: true,
};
const DefaultOptsJS: CompilerOpts = {
  lowerU64: true,
  lowerSIMD: true,
  patternMemoryEndianess: true,
  wasmTee: false, // useless for js
  opt_i32xi32: true,
};

const DefaultOptsWASM: CompilerOpts = {
  lowerWasm: true,
  useSIMD: true,
  // Flags
  nativeSIMD: true,
  native64bit: true,
};

export type StateShape = FnOp | StateShape[] | { [k: string]: StateShape };
const FnOpShape = utils.Shape<FnOp>((x): x is FnOp => x instanceof FnOp);
type NDOp = utils.ND<FnOp>;

function genScope(mg: ModuleGraph, m: Module<any, any>, opts: CompilerOpts) {
  const mgNode = as(mg.ops.root, 'module');
  const memory = mgNode.memory;
  function allMemLinks() {
    const strong = [];
    const weak = [];
    const fnRoot = mg.getCurFn().node;
    for (const k in memory) {
      if (!fnRoot.memOps[k]) fnRoot.memOps[k] = { reads: [] };
      const m = fnRoot.memOps[k];
      if (m.write !== undefined) strong.push(m.write);
      weak.push(...m.reads.map((i) => mg.ops.weak(i)));
    }
    return { strong, weak };
  }
  function injectAllMem(op: FnOp) {
    const fnRoot = mg.getCurFn().node;
    for (const k in memory) {
      const m = fnRoot.memOps[k];
      m.write = op.idx;
      m.reads = [];
    }
  }
  const getType = (t: TypeName, lanes: number = 1) => {
    const type = types.SIMDType.has(t) || lanes === 1 ? t : `${t}x${lanes}`;
    return (mg.types as any)[type];
  };
  const flags: Flags = {
    nativeSIMD: opts.nativeSIMD,
    native64bit: opts.native64bit,
    threads: opts.useThreads,
  };
  const scope = {
    types: mg.types,
    getType,
    getTypeGeneric: getType,
    flags,
    memory: {} as Record<string, any>,
    functions: {} as Record<string, any>,
    rawFn: mg,
    print(...args: (string | NDOp)[]) {
      const { u32 } = this.types;
      const convertRec = (x: NDOp): NDOp => {
        if (Array.isArray(x)) return x.map(convertRec) as any;
        x = x as FnOp;
        const as32 = u32.from(types.nodeRetType(mg, x), x);
        return as32.length == 1 ? as32[0] : as32;
      };
      args = args.map((i) => (typeof i === 'string' ? i : convertRec(i)));
      const varArgs = [];
      const runtimeArgs = [];
      for (const a of args) {
        if (typeof a === 'string') runtimeArgs.push({ type: 'string', a });
        else {
          const shape = FnOpShape.decode(a);
          const argsArg = [];
          for (let i = 0, j = varArgs.length; i < shape.flat.length; i++, j++)
            argsArg.push(`args[${j}]`);
          varArgs.push(...shape.flat);
          runtimeArgs.push(FnOpShape.encode(shape.shape, argsArg as any));
        }
      }
      const toExpr = (v: any): string => {
        if (Array.isArray(v)) return `[${v.map(toExpr).join(',')}]`;
        if (v && typeof v === 'object' && v.type === 'string') return JSON.stringify(v.a);
        if (typeof v === 'string') {
          // v is "args[NN]" (your encode path guarantees this)
          return `(${v}>>>0)`;
        }
        throw new Error('runtimeArgs: unsupported entry');
      };
      const exprList = runtimeArgs.map(toExpr).join(',');
      const cb = `(...args)=>console.log(${exprList})`;
      const fnNode = mg.getCurFn().node;
      const dbgFnName = `_debug_${fnNode.name}_${fnNode.embedPos++}`;
      fnNode.embedFns[dbgFnName] = {
        import: true,
        inputs: varArgs.map((_i) => 'i32'),
        outputs: [],
        cb,
      };
      const { weak, strong } = allMemLinks();
      const call = mg.op('i32', 'call', varArgs, {
        name: dbgFnName,
        weak,
        strong,
        outTypes: [],
        inputsCnt: varArgs.length,
        isMut: true,
      });
      injectAllMem(call);
    },
    namedBlock<State extends StateShape[]>(
      name: string | undefined,
      input: State,
      cb: (...args: State) => State,
      isLoop = false
    ): State {
      const { shape, flat } = FnOpShape.decode(input);
      const blockIdx = mg.ops.add({
        kind: isLoop ? 'loop' : 'block', // same structure, different behavior
        name,
        args: flat.map((i) => i.idx),
        // save shape here too? to check in br/brIf
        shape,
        nodes: [],
        outputs: [],
        opts: {},
      });
      const blockNode = as(mg.ops.get(blockIdx), 'block', 'loop');

      mg.ops.scope(blockIdx, () => {
        // create internal block variables
        const args = flat.map((i, j) => {
          const argType = types.nodeRetType(mg, i);
          return mg.op(argType, 'arg', [], { pos: j, scope: blockIdx });
        });
        const out = cb(...(FnOpShape.encode(shape, args || []) as any)) || [];
        if (!FnOpShape.validate(shape, out)) throw new Error('wrong output shape');
        blockNode.outputs = FnOpShape.decode(out).flat.map((i) => i.idx);
        mg.ops.set(blockIdx, { ...blockNode });
      });
      const root = mg.getCurFn().node;
      for (const k in root.memOps) {
        const ms = root.memOps[k];
        if (ms.write !== undefined && utils.Path.isParent(blockIdx, ms.write)) {
          ms.write = blockIdx;
        }
        for (let i = 0; i < ms.reads.length; i++) {
          if (utils.Path.isParent(blockIdx, ms.reads[i])) {
            ms.reads[i] = utils.Path.addFlagsFrom(blockIdx, ms.reads[i]);
          }
        }
      }
      // return outputs
      const res = [];
      for (let i = 0; i < blockNode.outputs!.length; i++) {
        const type = as(mg.ops.get(blockNode.outputs![i]), 'op').type;
        res.push(mg.op(type, 'nodeOutput', [mg.byIdx(blockIdx)], { pos: i }));
      }
      return FnOpShape.encode(shape, res);
    },
    block<State extends StateShape[]>(
      inputs: State,
      cb: (...args: State) => State,
      isLoop = false
    ): State {
      return this.namedBlock(undefined, inputs, cb, isLoop);
    },
    // Control flow
    brIf<State extends StateShape[]>(
      depth: string | number,
      cond: FnOp | undefined,
      ...outputs: State
    ) {
      const stackBlocks = mg.getStackBlocks();
      if (typeof depth === 'string') {
        for (let i = 0; i < stackBlocks.length; i++) {
          if (stackBlocks[i].node.name === depth) {
            depth = i;
            break;
          }
        }
        if (typeof depth === 'string') {
          throw new Error('cannot find block label');
        }
      }
      if (typeof depth === 'string') throw new Error('labels not implemented');
      // If we break outer block, we need return exact shape of outer block state
      const parent = stackBlocks[depth];
      if (!parent || parent.node.kind === 'function' || parent.node.kind === 'module')
        throw new Error(`br: no parent (depth=${depth})`);
      const { shape } = parent.node;
      if (!FnOpShape.validate(shape, outputs)) {
                throw new Error('wrong output shape for branch');
      }
      const args = FnOpShape.decode(outputs).flat;
      const { strong, weak } = allMemLinks();
      const res = mg.op('i32', cond ? 'br_if' : 'br', cond ? [...args, cond] : [...args], {
        depth,
        strong,
        weak,
      });
      injectAllMem(res);
      return res;
    },
    br<State extends StateShape[]>(depth: string | number, ...outputs: State) {
      return this.brIf(depth, undefined, ...outputs);
    },
    // high level loops
    continueIf(cond: FnOp | undefined, label: string | undefined, ...rest: FnOp[]) {
      return this.brIf(label ? `${label}.loop.body` : 0, cond, ...rest);
    },
    continue(label: string | undefined, ...rest: FnOp[]) {
      return this.continueIf(undefined, label, ...rest);
    },
    breakIf(cond: FnOp | undefined, label: string | undefined, ...rest: FnOp[]) {
      return this.brIf(label ? `${label}` : 2, cond, ...rest);
    },
    break(label: string | undefined, ...rest: FnOp[]) {
      return this.breakIf(undefined, label, ...rest);
    },
    // This is weirder, but easier to implement
    doWhile<State extends StateShape[]>(
      state: State,
      cond: (...s: State) => FnOp, // i32
      body: (...s: State) => State,
      label?: string
    ): State {
      // TODO: make breakIf/continueIf with doWhile too!
      return this.namedBlock(label, state, (...state) => {
        return this.namedBlock(
          label ? `${label}.loop` : undefined,
          state,
          (...st: State) => {
            const afterBody = body(...st) || [];
            const c = cond(...afterBody);
            this.brIf(0, c, ...afterBody); // continue current loop with updated state
            return afterBody; // Fallthrough: loop result is afterBody
          },
          /*isLoop=*/ true
        );
      });
    },
    forLoop<State extends StateShape[]>(
      state: State,
      cond: (...s: State) => FnOp, // i32
      inc: (...s: State) => State,
      body: (...s: State) => State,
      label?: string
    ): State {
      const i32 = this.types.i32;
      // Guard block carries the loop state and returns the final state.
      return this.namedBlock(label, state, (...state: State) => {
        // Loop block: check cond at the very top; if false -> break to guard.
        const c0 = cond(...state);
        this.brIf(0, i32.eqz(c0), ...state);
        return this.doWhile(
          state,
          cond, // cond is evaluated on the state *after* body+inc
          (...s: State) => {
            // guard block, so 'break 0' will do 'continue', 'break 1' will exit
            const afterBody = this.namedBlock(label ? `${label}.loop.body` : undefined, s, body);
            return inc(...afterBody);
          },
          label
        );
      });
    },
    // Same as doN, but does at least once
    doN1<State extends StateShape[]>(
      state: State,
      N: FnOp | number,
      body: (cnt: FnOp, ...s: State) => State,
      label?: string
    ): State {
      const { u32 } = this.types;
      if (typeof N === 'number') N = u32.const(N);
      const [_, ...res] = this.doWhile<[FnOp, ...State]>(
        [u32.const(0), ...state], // i = 0
        (i, ..._state) => u32.lt(i, N), // i<N
        (i, ...state) => [u32.add(i, u32.const(1)), ...body(i, ...state)] as [FnOp, ...State],
        label
      );
      return res;
    },
    doN<State extends StateShape[]>(
      state: State,
      N: FnOp | number,
      body: (cnt: FnOp, ...s: State) => State,
      label?: string
    ): State {
      const { u32 } = this.types;
      if (typeof N === 'number') N = u32.const(N);
      const [_, ...res] = this.forLoop<[FnOp, ...State]>(
        [u32.const(0), ...state], // i = 0
        (i, ..._state) => u32.lt(i, N), // i<N
        (i, ...state) => [u32.add(i, u32.const(1)), ...state] as [FnOp, ...State], // i++
        (i, ...state) => [i, ...(body(i, ...state) || [])] as [FnOp, ...State],
        label
      );
      return res;
    },
    ifElse<State extends StateShape[] = []>(
      cond: FnOp,
      state: State,
      ifBody: (...s: State) => State,
      elseBody?: (...s: State) => State
    ): State {
      const { i32 } = this.types;
      if (!elseBody) {
        return scope.block(state, (...s: State) => {
          scope.brIf(0, i32.eqz(cond), ...s);
          return ifBody(...s);
        });
      }
      return scope.block(state, (...s: State) => {
        s = scope.block(s, (...s: State) => {
          scope.brIf(0, i32.eqz(cond), ...s);
          const thenBody = ifBody(...s);
          scope.br(1, ...(thenBody || []));
          return thenBody;
        });
        // cond == 0 -> take ELSE (branch to current block with elseRes)
        return elseBody(...s);
      });
    },
  };
  for (const name in memory) {
    scope.memory[name] = memoryProxy(mg as any, name, memory[name].pre, memOps);
  }
  for (const name in m.functions) {
    scope.functions[name] = {
      call(...args: FnOp[]) {
        const curFn = m.functions[name];
        if (!curFn) throw new Error('unknown function: ' + name);
        const outTypes = types.normRetType(curFn.outputs);
        if (args.length !== curFn.inputs.length)
          throw new Error(`wrong args: ${args.length} !== ${curFn.inputs.length}`);
        // Call depends on all memory operations (we have no idea what function will do with memory)
        const { weak, strong } = allMemLinks();
        const call = mg.op('i32', 'call', args, {
          name,
          weak,
          strong,
          outTypes,
          inputsCnt: args.length,
          isMut: true,
        });
        injectAllMem(call);
        const res = [];
        for (let i = 0; i < outTypes.length; i++) {
          res.push(mg.op(outTypes[i] as TypeName, 'nodeOutput', [call], { pos: i }));
        }
        return res;
      },
      // small halper to call only if condition is true
      callIf(cond: FnOp, ...args: FnOp[]) {
        return scope.ifElse<[]>(cond, [], () => {
          this.call(...args);
          return [];
        });
      },
    };
  }
  return scope;
}
/**
 * Per module graph container (compiler specific utils on top of TreeDAG)
 */
export class ModuleGraph {
  ops: utils.TreeDAG<Node>;
  types: ReturnType<typeof types.genTypes>;
  scope: ReturnType<typeof genScope>;
  constructor(name: string, memory: Memory, mod: Module, opts: CompilerOpts) {
    this.ops = new utils.TreeDAG<Node>(
      { kind: 'module', name, nodes: [], memory, opts: {} },
      {
        formatNode: (node) => {
          if (node.kind === 'module') return `module.${node.name}`;
          if (node.kind === 'function')
            return `function.${node.name}(${node.inputs.join(', ')}, outputs=${node.outputs.join(', ')})`;
          if (is(node, 'block', 'loop'))
            return `${node.kind}.${node.name || ''}(${node.args.join(', ')}, outputs=${node.outputs.join(', ')})`;
          if (node.kind === 'op') {
            const opts = Object.entries(node.opts || {}).map(([k, v]) => `${k}=${v}`);
            const args = [...(node.args || []), ...opts];
            return `${node.type}.${node.op}(${args.join(', ')})`;
          }
          throw new Error('unknown node');
        },
        getEdges: (node, idx) => {
          const res = [];
          if (is(node, 'op', 'block', 'loop')) res.push(...node.args);
          if (node.opts) {
            if (node.opts.strong !== undefined) res.push(...node.opts.strong);
            if (node.opts.cond !== undefined) res.push(node.opts.cond);
            if (node.opts.src !== undefined) res.push(node.opts.src);
            if (node.opts.weak !== undefined) res.push(...node.opts.weak);
          }
          if (is(node, 'function', 'loop', 'block'))
            res.push(...node.outputs.filter((i) => !i.startsWith(idx)));
          return res;
        },
        mapEdges: (g, node, mapping, partial) => {
          if (is(node, 'op', 'block', 'loop'))
            node.args = g.applyMapping(node.args, mapping, partial);
          if (node.opts) {
            if (node.opts.cond)
              node.opts.cond = g.applyMappingSingle(node.opts.cond, mapping, partial);
            if (node.opts.weak) node.opts.weak = g.applyMapping(node.opts.weak, mapping, partial);
            if (node.opts.strong)
              node.opts.strong = g.applyMapping(node.opts.strong, mapping, partial);
            if (node.opts.src)
              node.opts.src = g.applyMappingSingle(node.opts.src, mapping, partial);
            if (node.opts.scope)
              node.opts.scope = g.applyMappingSingle(node.opts.scope, mapping, partial);
          }
          if (is(node, 'function', 'loop', 'block'))
            node.outputs = g.applyMapping(node.outputs, mapping, partial);
          if (is(node, 'function')) {
            for (const k in node.memOps) {
              node.memOps[k].reads = g.applyMapping(node.memOps[k].reads, mapping, partial);
              if (node.memOps[k].write !== undefined)
                node.memOps[k].write = g.applyMappingSingle(node.memOps[k].write, mapping, partial);
            }
          }
        },
        isUsed: (parent, node, idx, flags) => {
          if (isOp(node, 'br', 'br_if')) return true; // never remove branches
          // Can remove in theory, but need to check if br_if/br inside jumps to parent
          if (is(node, 'block', 'loop', 'function')) return true;
          parent = as(parent, 'loop', 'function', 'block');
          return (parent.outputs || []).includes(idx) || flags.has('isMut');
        },
        getFlags: (node) => {
          return [node.opts?.isMut ? 'isMut' : undefined];
        },
      }
    );
    this.types = types.genTypes(this) as any;
    this.scope = genScope(this, mod, opts);
  }
  byIdx(idx: string) {
    return new FnOp(idx);
  }
  getStackBlocks() {
    const res = [];
    for (let i = 0; i < this.ops.stack.length; i++) {
      const idx = this.ops.stack[this.ops.stack.length - 1 - i];
      const node = this.ops.get(idx);
      if (!is(node, 'module', 'function', 'block', 'loop'))
        throw new Error(`unknown type on stack: ${node.kind}`);
      res.push({ idx, node });
    }
    return res;
  }
  getCurFn() {
    const stack = this.getStackBlocks();
    const fns = stack.filter((i) => i.node.kind === 'function');
    if (fns.length !== 1) {
      throw new Error('more than one function on stack');
    }
    return { idx: fns[0].idx, node: as(fns[0].node, 'function') };
  }
  // Ops
  op(type: TypeName, op: string, args: FnOp[], opts: Record<string, any> = {}) {
    for (const a of args) {
      if (!(a instanceof FnOp)) {
        throw new Error('wrong arg: ' + typeof a);
      }
    }
    const node = { kind: 'op' as const, type, op, args: args.map((i) => i.idx), opts };
    //node.opts.stack = new Error().stack;
    const res = new FnOp(this.ops.add(node));
    return res;
  }
  subgraph<K extends 'function' | 'module' | 'block' | 'loop'>(
    kind: K,
    name: string,
    opts: Omit<NodeMap[K], 'name' | 'kind' | 'nodes'>,
    cb: (t: this, idx: NodeIdx) => void
  ) {
    const scopeIdx = this.ops.add({ kind, name, ...opts, nodes: [] } as NodeOf<K>);
    this.ops.scope(scopeIdx, () => cb(this, scopeIdx));
    return scopeIdx;
  }
  // dd
  addFn(name: string, fnDef: any) {
    return this.subgraph(
      'function',
      name,
      { inputs: [], outputs: [], memOps: {}, opts: {}, embedFns: {}, embedPos: 0 },
      (_mod, fnIdx) => {
        const fnNode = as(this.ops.get(fnIdx), 'function');
        let out = fnDef.cb(
          this.scope,
          ...fnDef.inputs.map((type: TypeName, pos: number) => {
            fnNode.inputs.push(type);
            return this.op(type, 'arg', [], { pos });
          })
        );
        if (out) {
          if (!Array.isArray(out)) out = [out];
          fnNode.outputs = out.map((i: FnOp) => i.idx);
        }
      }
    );
  }
  rewrite(opts: CompilerOpts) {
    const curRewrites: Record<string, utils.Rewrite<Node>> = {};
    const getRewrite = (x: rewrites.RewriteFn): utils.Rewrite<Node> => {
      const inner = x(this, opts);
      return (node, idx) => {
        if (!is(node, 'op', 'block', 'loop', 'function')) return;
        const args = node.kind === 'function' ? [] : node.args.map((i) => this.byIdx(i));
        const res = inner(node, args, idx);
        if (res === undefined) return;
        if (!res.idx || !(res instanceof FnOp)) {
          throw new Error('wrong rewrite res');
        }
        return res.idx;
      };
    };
    if (opts.lowerU64Arg) curRewrites.lowerU64Arg = getRewrite(rewrites.lowerU64Arg);
    // Should be before anything
    curRewrites.lowerVirtualSIMDMask = getRewrite(rewrites.lowerVirtualSIMDMask);
    curRewrites.lowerVirtualSIMDPairs = getRewrite(rewrites.lowerVirtualSIMDPairs);
    curRewrites.lowerBigIntSIMD = getRewrite(rewrites.lowerBigIntSIMD);
    // NOTE: we are adding optimize after each step since it may catch stuff that would be harder to catch after lowering
    if (opts.optimize) curRewrites.optimize = getRewrite(rewrites.optimize);
    if (opts.lowerSIMD) curRewrites.lowerSIMD = getRewrite(rewrites.lowerSIMD);
    if (opts.lowerSmallInt) curRewrites.lowerSmallInt = getRewrite(rewrites.lowerSmallInt);
    if (opts.lowerPattern) curRewrites.lowerPattern = getRewrite(rewrites.lowerPattern);
    if (opts.optimize) curRewrites.optimizeSIMD = getRewrite(rewrites.optimize);

    if (opts.lowerU64) {
      curRewrites.lowerWideInt256 = getRewrite((fn, o) => rewrites.lowerWideInt(fn, o, 256));
      curRewrites.lowerWideInt128 = getRewrite((fn, o) => rewrites.lowerWideInt(fn, o, 128));
      curRewrites.lowerWideInt64 = getRewrite((fn, o) => rewrites.lowerWideInt(fn, o, 64));
    }
    if (opts.optimize) curRewrites.optimizeU64 = getRewrite(rewrites.optimize);

    if (opts.lowerWasm) curRewrites.lowerWasm = getRewrite(rewrites.lowerWasm);
    curRewrites.lowerSmallIntWasm = getRewrite(rewrites.lowerSmallInt);
    if (opts.optimize) curRewrites.optimizeWASM = getRewrite(rewrites.optimize);
    //if (opts.lowerU64Arg)
    if (opts.lowerPatternJS) curRewrites.lowerPatternJS = getRewrite(rewrites.lowerPatternJS);
    const DEBUG = false;
    this.ops.rewrite(curRewrites, undefined, DEBUG, DEBUG ? () => checkFn(this) : undefined);
    checkFn(this, true);
  }
  toInstrs(opts: CompilerOpts) {
    const fns: any[] = [];
    const modNode = as(this.ops.root, 'module');
    const { memory } = modNode;
    for (let i = 0; i < modNode.nodes!.length; i++) {
      const fnIdx = String(i);
      const node = modNode.nodes[i];
      if (node.kind !== 'function') continue;
      this.ops.scope(fnIdx, () => {
        fns.push({ name: node.name, ...toInstr(this, memory, opts) });
      });
    }
    return fns;
  }
}
/**
 * Converts TreeDAG function into stack based list of instructions
 */
function toInstr(fn: ModuleGraph, memory: Memory, opts: CompilerOpts = {}) {
  const { node: fnNode, idx: fnNodeIdx } = fn.getCurFn();
  const inputIds: Record<string, number> = {};
  let lastIdx = 0;
  const locals: { type: string; count: number }[] = [];
  const getNextId = (type: TypeName, isInput = false) => {
    type = types.normType(type) as TypeName;
    if (!isInput) {
      const lastRun = locals[locals.length - 1];
      if (lastRun && lastRun.type === type) {
        lastRun.count++;
      } else locals.push({ type, count: 1 });
    }
    return lastIdx++;
  };
  for (const i of fnNode.inputs) {
    getNextId(i, true);
    if (inputIds[i] === undefined) inputIds[i] = 0;
    inputIds[i]++;
  }
  const getNodeType = (node: Node): types.WasmType => {
    node = as(node, 'op');
    let type: types.WasmType = node.type as types.WasmType;
    if (node.type === 'u32') type = 'i32';
    if (node.type === 'u64') type = 'i64';
    if (node.type === 'u8x16') type = 'i8x16';
    if (node.type === 'u16x8') type = 'i16x8';
    if (node.type === 'u32x4') type = 'i32x4';
    if (node.type === 'u64x2') type = 'i64x2';
    // some simd instructions are generic, but we want types everywhere to know how to lower instructions:
    // otherwise we will lower stuff to i64 only then to find out it was i32
    if (
      types.SIMDType.has(node.type) &&
      ['store', 'load', 'and', 'xor', 'or', 'andnot', 'const', 'not', 'bitselect'].includes(node.op)
    ) {
      type = 'v128';
    }
    return type;
  };

  const getNodeTag = (node: Node) => {
    if (node.kind !== 'op') return node.kind;
    let type = getNodeType(node);
    let op = node.op;
    if (
      ['shr', 'div', 'rem', 'lt', 'gt', 'le', 'ge', 'min', 'max'].includes(node.op) &&
      types.IntType.has(node.type)
    ) {
      op += node.type.startsWith('i') ? '_s' : '_u';
    }
    return `${type}.${op}`;
  };
  type Instr = any;
  const varIdx: Record<NodeIdx, number> = {};
  const callIdx: Record<NodeIdx, number[]> = {};
  const usedBy = fn.ops.getUsedBy();
  const singleUsed: Record<NodeIdx, Instr[]> = {};
  const singleUserArgs: Record<NodeIdx, number> = {};
  const teeCache: Record<NodeIdx, { varIdx: number; ops: Instr[] }> = {};
  const isUsedByLoop: Record<NodeIdx, number> = {};
  const isUsedByBlock: Record<NodeIdx, number> = {};

  for (const [i, users] of usedBy) {
    let usedInLoop = 0;
    let usedInBlock = 0;
    for (const u of users) {
      // Check if used inside loop that on deeper level than node itself, so we don't
      // re-calculate stuff in loop. NOTE: this affects only inlining here,
      // more generic solution is needed in for of rewrites (in addition, not instead).
      const stack = fn.ops.getStack(u);
      const iParent = utils.Path.parent(i).parent;
      for (let j = stack.length - 1; j >= 0; j--) {
        const cur = stack[j];
        if (!utils.Path.isParent(iParent, cur.idx)) break;
        if (cur.node.kind === 'loop') usedInLoop++;
        if (cur.node.kind === 'block') usedInBlock++;
      }
      const n = fn.ops.get(u);
      if (is(n, 'op', 'block', 'loop')) {
        const maxUses = n.args.filter((j) => j === i).length;
        if (!singleUserArgs[i]) singleUserArgs[i] = 0;
        singleUserArgs[i] = Math.max(singleUserArgs[i], maxUses);
      }
    }
    isUsedByLoop[i] = usedInLoop;
    isUsedByBlock[i] = usedInBlock;
  }
  // TODO: cleanup, very ugly!
  const getRetTypes = (lst: NodeIdx[]) =>
    lst.map((i) => types.normType(types.nodeRetType(fn, fn.byIdx(i))));
  const processNode = (idx: string) => {
    const getArg = (arg: string, consume: boolean = true) => {
      if (opts.wasmTee && teeCache[arg]) {
        return { TAG: 'local.tee_cache', idx: arg, at: idx };
      }
      const n = fn.ops.get(arg) as Node; // const n: utils.TreeNode<Node>
      if (isOp(n, 'nodeOutput')) {
        const outs = callIdx[n.args[0]];
        if (!outs) throw new Error('nodeOutput: callIdx missing');
        return { TAG: 'local.get', data: BigInt(outs[n.opts.pos]) };
      }
      if (isOp(n, 'arg') && n.opts.scope) {
        const outs = callIdx[n.opts.scope];
        if (!outs) throw new Error('arg/scope: callIdx missing');
        return { TAG: 'local.get', data: BigInt(outs[n.opts.pos]) };
      }
      if (isOp(n, 'const')) {
        let data = n.opts.value;
        if (utils.isBytes(data)) data = P.I128LE.decode(data);
        if (!types.FloatType.has(n.type)) data = BigInt(data);
        if (n.type === 'u64') data = types.u64ToI64(data);
        if (n.type === 'u32') data = types.u32ToI32(data);
        return { TAG: getNodeTag(n), data };
      }
      if (isOp(n, 'cast')) return getArg(n.args[0], false);
      if (singleUsed[arg] !== undefined) {
        const res = singleUsed[arg];
        if (consume) delete singleUsed[arg]; // will throw if used more than once!
        return res;
      }
      if (varIdx[arg] !== undefined) {
        return { TAG: 'local.get', data: BigInt(varIdx[arg]) };
      }
      throw new Error(`unknown arg=${arg}`);
    };
    const ops: any[] = [];
    const pushOps = (o: any) => {
      if (!Array.isArray(o)) ops.push(o);
      else {
        for (const i of o) ops.push(i);
      }
    };

    const n = fn.ops.get(idx);
    const nPath = utils.Path.decode(idx).path;
    if (n.kind === 'function') {
      for (let i = 0; i < n.nodes!.length; i++) {
        if (!n.nodes![i]) continue;
        pushOps(processNode(utils.Path.encode([...nPath, i])));
      }
      pushOps(n.outputs.flatMap((i) => getArg(i)));
      ops.push({ TAG: 'end' });
      return ops;
    }
    if (isOp(n, 'arg')) {
      const scope = n.opts.scope;
      if (scope === undefined) varIdx[idx] = n.opts.pos; // function param
      return [];
    }
    if (isOp(n, 'nodeOutput')) {
    }
    if (isOp(n, 'const', 'nodeOutput')) return [];
    if (isOp(n, 'cast')) return [];

    const argIdxs: string[] = n.kind === 'module' ? [] : n.args;
    const argInstrs = argIdxs.map((i) => getArg(i)); // array of objs OR arrays
    pushOps(argInstrs.flat());
    let isVoid = false;

    const parentNode = as(fn.ops.get(utils.Path.parent(idx).parent), 'function', 'loop', 'block');
    const canInline =
      !n.opts.isMut &&
      !parentNode.outputs.includes(idx) &&
      !isOp(n, 'load', 'addCarry', 'carry', 'store') &&
      !isUsedByLoop[idx];
    const ownerCnt = usedBy.get(idx)?.size || 0;
    const singleUser = ownerCnt === 1 && canInline && singleUserArgs[idx] <= 1;

    const getMemArg = (n: Node) => {
      n = as(n, 'op');
      const maxSizeAlign = ({ 8: 0, 16: 1, 32: 2, 64: 3 } as any)[n.opts.size];
      const maxTypeAlign = ({ i32: 2, u32: 2, f32: 2, i64: 3, u64: 3, f64: 3 } as any)[n.type];
      let maxAlign = Math.min(
        maxSizeAlign !== undefined ? maxSizeAlign : 4,
        maxTypeAlign !== undefined ? maxTypeAlign : 4
      );
      if (n.opts.use32x2) maxAlign = 3;
      let align = n.opts.align || 0;
      {
        const pos = fn.ops.get(n.args[0]);
        if (isOp(pos, 'const'))
          align = utils.wasmAlign((n.opts.offset || 0) + Number(pos.opts.value));
        // else align = 0;           // reset align if non-constant node
      }
      align = Math.min(align, maxAlign); // clamp
      const offset = n.opts.rawOffset
        ? n.opts.offset || 0
        : memory[n.opts.name].pos + (n.opts.offset || 0);
      return {
        align,
        offset,
        swapEndianness: n.opts.swapEndianness,
      };
    };

    const TAG = getNodeTag(n);
    if (
      isOp(
        n,
        'abs',
        'sqrt',
        'ceil',
        'floor',
        'trunc',
        'nearest',
        'isNaN',
        'isNegZero',
        'rotr',
        'rotl',
        'shr',
        'shl',
        'sub',
        'not',
        'div',
        'rem',
        // comparisons
        'eqz',
        'eq',
        'ne',
        'lt',
        'gt',
        'le',
        'ge',
        'neg',
        'andnot',
        'ctz',
        'clz',
        'popcnt',
        // vectors
        'bitselect',
        //
        'extend_i32',
        'extend_i32_u',
        'extend_i32_s',
        'extend_low_i32x4_s',
        'extend_low_i32x4_u',
        'extend_high_i32x4_s',
        'extend_high_i32x4_u',
        'extend_low_i8x16_s',
        'extend_low_i8x16_u',
        'extend_high_i8x16_s',
        'extend_high_i8x16_u',
        'extend_low_i16x8_s',
        'extend_low_i16x8_u',
        'extend_high_i16x8_s',
        'extend_high_i16x8_u',
        'extmul_low_i8x16_s',
        'extmul_low_i8x16_u',
        'extmul_high_i8x16_s',
        'extmul_high_i8x16_u',
        'extmul_low_i16x8_s',
        'extmul_low_i16x8_u',
        'extmul_high_i16x8_s',
        'extmul_high_i16x8_u',
        'trunc_f32_s',
        'trunc_f32_u',
        'trunc_f64_s',
        'trunc_f64_u',
        'convert_f32_s',
        'convert_f32_u',
        'convert_f64_s',
        'convert_f64_u',
        'convert_i32_s',
        'convert_i32_u',
        'convert_i64_s',
        'convert_i64_u',
        'demote_f64',
        'promote_f32',
        'copysign',
        // js only!
        'low_big',
        'high_big',
        'splat',
        'reinterpret_f32',
        'reinterpret_i32',
        'reinterpret_f64',
        'reinterpret_f64_low',
        'reinterpret_f64_high',
        'reinterpret_i64'
      )
    )
      ops.push({ TAG });
    else if (isOp(n, 'wrap_i64')) ops.push({ TAG: `i32.wrap_i64` });
    else if (isOp(n, 'shuffle')) ops.push({ TAG: `i8x16.${n.op}`, data: n.opts.pattern });
    else if (isOp(n, 'swizzle')) ops.push({ TAG: `i8x16.${n.op}` });
    else if (
      isOp(
        n,
        'xor',
        'or',
        'and',
        'add',
        'mul',
        'min',
        'max',
        'extmul_low_i32x4_u',
        'extmul_low_i32x4_s',
        'extmul_high_i32x4_u',
        'extmul_high_i32x4_s'
      )
    ) {
      for (let i = 1; i < argIdxs.length; i++) ops.push({ TAG });
    }
    // TMP
    else if (isOp(n, 'addCarry', 'carry')) ops.push({ TAG });
    else if (isOp(n, 'select')) ops.push({ TAG: 'select' });
    else if (isOp(n, 'load', 'store')) {
      const data = getMemArg(n);
      const isVec = types.SIMDType.has(n.type);
      const getLane = () => {
        const vecLaneBytes = types.sizeof(types.ScalarOf(n.type));
        const factor = vecLaneBytes / (n.opts.size / 8);
        return n.opts.lane * factor;
      };
      if (isOp(n, 'load')) {
        if (isVec && n.opts.lane !== undefined) {
          if (!n.opts.size) throw new Error('no size on load_lane');
          const src = getArg(n.opts.src);
          pushOps(src);
          ops.push({ TAG: `${TAG}${n.opts.size}_lane`, data: { lane: getLane(), mem: data } });
        } else {
          let tag = TAG;
          if (n.type === 'i32' && n.opts.size === 8) tag = 'i32.load8_s';
          else if (['u32'].includes(n.type) && n.opts.size == 8) tag = 'i32.load8_u';
          else if (['i32', 'u32'].includes(n.type) && n.opts.size == 32) tag = TAG;
          else if (n.type === 'i32' && n.opts.size === 16) tag = 'i32.load16_s';
          else if (n.type === 'u32' && n.opts.size === 16) tag = 'i32.load16_u';
          else if (n.type === 'i64' && n.opts.size == 8) tag = 'i64.load8_s';
          else if (n.type === 'u64' && n.opts.size == 8) tag = 'i64.load8_u';
          else if (n.type === 'i64' && n.opts.size === 16) tag = 'i64.load16_s';
          else if (n.type === 'u64' && n.opts.size === 16) tag = 'i64.load16_u';
          else if (n.type === 'i64' && n.opts.size === 32) tag = 'i64.load32_s';
          else if (n.type === 'u64' && n.opts.size === 32) tag = 'i64.load32_u';
          else if (n.type.startsWith('i') && n.opts.use32x2) tag = 'v128.load32x2_s';
          else if (n.type.startsWith('u') && n.opts.use32x2) tag = 'v128.load32x2_u';
          else if (n.opts.size !== undefined)
            throw new Error(`unknown size load: ${n.opts.size} (${n.type})`);
          ops.push({ TAG: tag, data: data });
        }
      } else if (n.op === 'store') {
        if (isVec && n.opts.lane !== undefined) {
          if (!n.opts.size) throw new Error('no size on store_lane');
          ops.push({ TAG: `${TAG}${n.opts.size}_lane`, data: { lane: getLane(), mem: data } });
        } else {
          let tag = TAG;
          if (['i32', 'u32'].includes(n.type) && n.opts.size === 8) tag = 'i32.store8';
          else if (['i32', 'u32'].includes(n.type) && n.opts.size === 16) tag = 'i32.store16';
          else if (['i32', 'u32', 'f32'].includes(n.type) && n.opts.size === 32) tag = TAG;
          else if (['i64', 'u64'].includes(n.type) && n.opts.size === 8) tag = 'i64.store8';
          else if (['i64', 'u64'].includes(n.type) && n.opts.size === 16) tag = 'i64.store16';
          else if (['i64', 'u64'].includes(n.type) && n.opts.size === 32) tag = 'i64.store32';
          else if (n.opts.size !== undefined) {
            throw new Error(`unknown size store: ${n.opts.size} (${n.type})`);
          }
          ops.push({ TAG: tag, data: data });
        }
        isVoid = true;
      }
    } else if (n.kind === 'op' && n.op.startsWith('atomic')) {
      if (['atomic.fence', 'atomic.pause'].includes(n.op) || n.op.includes('store')) isVoid = true;
      let data;
      if (!['atomic.fence', 'atomic.pause'].includes(n.op)) {
        data = getMemArg(n);
      }
      if (['atomic.fence', 'atomic.pause', 'atomic.notify'].includes(n.op)) {
        ops.push({ TAG: n.op, data });
      } else {
        ops.push({ TAG, data });
      }
    } else if (isOp(n, 'extract_lane')) {
      let tag = TAG;
      if (n.type === 'i8x16' || n.type === 'u8x16') {
        tag = `i8x16.extract_lane_${n.type.startsWith('i') ? 's' : 'u'}`;
      } else if (n.type === 'i16x8' || n.type === 'u16x8') {
        tag = `i16x8.extract_lane_${n.type.startsWith('i') ? 's' : 'u'}`;
      }
      ops.push({ TAG: tag, data: n.opts.lane });
    } else if (isOp(n, 'replace_lane')) {
      ops.push({ TAG, data: n.opts.lane });
    } else if (isOp(n, 'call')) {
      ops.push({ TAG: 'call', data: n.opts.name, opts: n.opts });
      const outIdx = [];
      for (let i = n.opts.outTypes.length - 1; i >= 0; i--) {
        const type = n.opts.outTypes[i];
        const setId = getNextId(type, false);
        ops.push({ TAG: 'local.set', data: BigInt(setId) });
        outIdx.unshift(setId);
      }
      callIdx[idx] = outIdx;
      isVoid = true;
    } else if (is(n, 'block', 'loop')) {
      const argTypes = getRetTypes(n.args);
      const outTypes = getRetTypes(n.outputs); // same as args
      const blockType = !opts.wasmBlockType ? 'void' : { inputs: argTypes, outputs: outTypes };
      // We have input state in stack (because of args)
      const outIdx: number[] = [];
      for (let i = 0; i < n.args?.length; i++) {
        const setId = getNextId(argTypes[i] as TypeName, false);
        outIdx.push(setId);
      }
      callIdx[idx] = outIdx; // can do this once
      const saveState = () => {
        for (let i = outIdx.length - 1; i >= 0; i--)
          ops.push({ TAG: 'local.set', data: BigInt(outIdx[i]) });
      };
      // save arguments to state
      if (!opts.wasmBlockType) saveState();
      ops.push({ TAG: n.kind, data: blockType, hoist: outIdx });
      if (opts.wasmBlockType) saveState();
      for (let i = 0; i < n.nodes!.length; i++) {
        if (!n.nodes![i]) continue;
        pushOps(processNode(utils.Path.encode([...nPath, i])));
      }
      pushOps(n.outputs.flatMap((i) => getArg(i)));
      // we have outputs on stack!
      if (!opts.wasmBlockType) saveState();
      ops.push({ TAG: 'end' });
      // save returned state
      if (opts.wasmBlockType) saveState();
      isVoid = true;
    } else if (isOp(n, 'br_if', 'br')) {
      const { path } = utils.Path.decode(idx);
      const parentIdx = [];
      for (let i = 0; i < path.length; i++) parentIdx.push(utils.Path.encode(path.slice(0, i)));
      const parents = parentIdx
        .map((idx) => ({ idx, node: fn.ops.get(idx) }))
        .filter((i) => ['loop', 'block'].includes(i.node.kind));

      const pDepth = parents[parents.length - n.opts.depth - 1];
      const outIdx = callIdx[pDepth.idx];
      if (!opts.wasmBlockType && n.op === 'br_if' && n.args.length > 1) {
        if (opts.wasmTee) throw new Error('wasmTee not supported in non wasmBlockType');
        // requires guard block
        ops.length = 0; // remove args
        const condInstr = argInstrs[argInstrs.length - 1];
        const yieldInstrs = argInstrs.slice(0, outIdx.length);
        ops.push({ TAG: 'block', data: 'void' }); // guard
        pushOps(condInstr);
        ops.push({ TAG: 'i32.eqz' });
        ops.push({ TAG: 'br_if', data: 0n }); // skip assign+branch if cond==0
        // assign yields -> parent's locals, in order
        for (let i = 0; i < outIdx.length; i++) {
          pushOps(yieldInstrs[i]);
          ops.push({ TAG: 'local.set', data: BigInt(outIdx[i]) });
        }
        ops.push({ TAG: 'br', data: BigInt(n.opts.depth + 1) });
        ops.push({ TAG: 'end' });
      } else {
        if (!opts.wasmBlockType) {
          for (let i = outIdx.length - 1; i >= 0; i--)
            ops.push({ TAG: 'local.set', data: BigInt(outIdx[i]) });
        }
        ops.push({ TAG: n.op, data: BigInt(n.opts.depth) });
        // won't eat wholes stack if condition failed: need to drop
        const len = n.args.length - (n.op === 'br_if' ? 1 : 0);
        if (opts.wasmBlockType) for (let i = 0; i < len; i++) ops.push({ TAG: 'drop' });
      }
      isVoid = true;
    } else if (isOp(n, 'fill')) {
      ops.push({ TAG: 'memory.fill', data: 0 });
      isVoid = true;
    } else if (isOp(n, 'copy')) {
      ops.push({ TAG: 'memory.copy', data: { src: 0, dst: 0 } });
      isVoid = true;
    } else {
      const fnNode = as(fn.ops.root, 'function');
      console.error(fnNode.name, fn.ops.format());
      console.error('UNKNOWN NODE', idx, n, fn.ops.usedBy.get(idx), fn.ops.usedWeak.get(idx));
      throw new Error('processNode: unknown node');
    }
    if (!isVoid) {
      if (singleUser) {
        singleUsed[idx] = ops.slice();
        return []; // remember stack value, but do nothing
      }
      // NOTE: this is return type!
      let typeName = types.normType(types.nodeRetType(fn, fn.byIdx(idx)));
      const setId = getNextId(typeName as TypeName, false);
      if (
        opts.wasmTee &&
        canInline &&
        !isUsedByBlock[idx] &&
        (opts.wasmTeeSimd || typeName !== 'v128')
      ) {
        // TODO: this is fragile and will break if tee is re-inlined again
        // Also, loops
        const owners = usedBy.get(idx);
        if (owners && owners.size && utils.Path.isSiblings(owners)) {
          ops.push({ TAG: 'local.tee', data: BigInt(setId) });
          teeCache[idx] = { varIdx: setId, ops: ops.slice() };
          return []; // remember stack value, but do nothing
        }
      }
      varIdx[idx] = setId;
      ops.push({ TAG: 'local.set', data: BigInt(setId) });
    }
    return ops;
  };
  let ops = processNode(fnNodeIdx);
  if (opts.wasmTee) {
    // We cannot know which consumer is first before linearization, so we insert tee here
    const teeUsed = new Set();
    const newOps = [];
    const expandRec = (op: any): any[] => {
      if (op.TAG !== 'local.tee_cache') return [op];
      const { varIdx, ops } = teeCache[op.idx];
      if (teeUsed.has(op.idx)) return [{ TAG: 'local.get', data: BigInt(varIdx), info: 'first' }];
      else {
        teeUsed.add(op.idx);
        return ops.map((i) => expandRec(i)).flat();
      }
    };
    for (const op of ops) newOps.push(...expandRec(op));
    ops = newOps;
  }

  const res = {
    inputs: fnNode.inputs.map((i) => types.normType(i)),
    outputs: getRetTypes(fnNode.outputs),
    export: true,
    locals,
    instructions: ops,
  };

  // console.log('------', this.name, res.inputs);
  // console.dir(ops, { depth: null });
  return res;
}
/**
 * Validates that function has valid memory structure
 */
function checkFn(fn: ModuleGraph, final = false) {
  fn.ops.check();
  const memOps: Record<string, Record<string, { write?: NodeIdx; reads: NodeIdx[] }>> = {};
  const fmt = (n: Node) => fn.ops.opts.formatNode!(n);
  const checkLoad = (node: Node, idx: NodeIdx, name: string) => {
    const curFnIdx = fn.getCurFn().idx;
    if (!memOps[curFnIdx]) memOps[curFnIdx] = {};
    if (!memOps[curFnIdx][name]) memOps[curFnIdx][name] = { reads: [] };
    const ms = memOps[curFnIdx][name];
    if (ms.write !== undefined) {
      if (!(node.opts.strong || []).includes(utils.Path.normDepth(idx, ms.write))) {
        throw new Error(`check(${fmt(node)}): read without strong link on write`);
      }
      if (ms.reads.length) {
        throw new Error(`check(${fmt(node)}}): ms.write with non-empty reads`);
      }
    }
    ms.write = undefined;
    ms.reads.push(idx);
  };
  const checkStore = (node: Node, idx: NodeIdx, name: string) => {
    const curFnIdx = fn.getCurFn().idx;
    if (!memOps[curFnIdx]) memOps[curFnIdx] = {};
    if (!memOps[curFnIdx][name]) memOps[curFnIdx][name] = { reads: [] };
    const ms = memOps[curFnIdx][name];
    if (ms.write !== undefined) {
      if (ms.reads.length) {
        throw new Error(`check(${fmt(node)}): ms.write with non-empty reads`);
      }
      if (!(node.opts.strong || []).includes(utils.Path.normDepth(idx, ms.write))) {
        console.error(fn.ops.format());
        console.error('NODE:', idx, node);
        console.error('MS', ms);
        throw new Error(`check(${fmt(node)}): no strong link on previous write`);
      }
    } else {
      for (const r of ms.reads) {
        if (!(node.opts.weak || []).includes(utils.Path.normDepth(idx, fn.ops.weak(r)))) {
          throw new Error(`check(${fmt(node)}): missing link on previous read`);
        }
      }
    }
    ms.write = idx;
    ms.reads = [];
  };
  fn.ops.iter((node, idx) => {
    if (node.kind !== 'op') return;
    if (node.op === 'virtual' && final) {
      //console.error('FORMAT', fn.ops.format());
      const usedBy = fn.ops.getUsedBy();
      console.error('NODE', idx, node);
      const users = Array.from(usedBy.get(idx) || []);
      console.error('USED BY', users);
      for (const u of users) console.error('USER', u, fn.ops.get(u));
      throw new Error('virtual node');
    }
    if (node.op.includes('atomic')) checkStore(node, idx, node.opts.name);
    if (!['load', 'store', 'call', 'fill', 'copy', 'br', 'br_if'].includes(node.op)) return;
    if (node.op === 'load') checkLoad(node, idx, node.opts.name);
    else if (['store', 'fill'].includes(node.op)) checkStore(node, idx, node.opts.name);
    else if (['call', 'br', 'br_if'].includes(node.op)) {
      const curFnIdx = fn.getCurFn().idx;
      if (memOps[curFnIdx]) {
        for (const k in memOps[curFnIdx]) checkStore(node, idx, k);
      }
    } else if (node.op === 'copy') {
      checkStore(node, idx, node.opts.name);
      if (node.opts.srcName !== node.opts.name) checkLoad(node, idx, node.opts.srcName);
    }
  });
}
/**
 * Common module compilation
 */
export function toMod(m: Module<any, any>, opts: CompilerOpts = {}) {
  let mod = m.clone();

  let BATCH_SIZE = 1;
  if (opts.useSIMD) BATCH_SIZE *= 4;
  if (opts.useThreads) BATCH_SIZE *= 10 * 1024;

  mod = workers.addBatch(mod, opts);
  if (opts.useThreads) mod = workers.addThreads(mod, opts);

  // For each memory segment we have stream of operations:
  // - read has strong link on previous write (if any)
  // - write has weak link on previous reads (all) OR strong link on previous write (if write,write)
  // This should create behavior:
  // - we can re-order reads and remove them
  // - write always exist and won't be removed from graph
  // - write position is always the same
  const memory: Record<string, any> = {};
  let memPos = 0;
  for (const [name, def] of Object.entries(mod.memory) as any) {
    if (def.kind) {
      if (memory[name]) throw new Error('memory already defined');
      const spec = def.opts.batch ? (array as any)(def, {}, BATCH_SIZE) : def;
      const { pos, opts, pre } = allocateMemSpec(memPos, spec);
      memory[name] = { ...opts, pre };
      memPos = pos;
    }
  }
  const moduleNode = new ModuleGraph(mod.name, memory, mod, opts);
  const importFns: Record<string, any> = {};
  const importEmbed: js.ImportEmbed = { env: {} };
  for (const [name, fnDef] of Object.entries(mod.functions) as any) {
    if (fnDef.import) {
      importFns[name] = {
        inputs: fnDef.inputs.map((i: any) => types.normType(i)),
        outputs: types.normRetType(fnDef.outputs),
        module: fnDef.module,
      };
      if (fnDef.cb) {
        const mod = fnDef.module || 'env';
        if (!importEmbed[mod]) importEmbed[mod] = {};
        importEmbed[mod][name] = fnDef.cb.toString();
      }
      continue;
    }
    const fnIdx = moduleNode.addFn(name, fnDef);
    const fnNode = as(moduleNode.ops.get(fnIdx), 'function');
    for (const k in fnNode.embedFns) {
      const { inputs, outputs, cb } = fnNode.embedFns[k];
      importFns[k] = { inputs, outputs };
      importEmbed['env'][k] = cb;
    }
  }
  const fns = [];
  if (opts.useThreads)
    fns.push({ name: 'initWorkers', inputs: ['i32'], outputs: [], import: true });
  for (const name in importFns) fns.push({ name, ...importFns[name], import: true });
  moduleNode.rewrite(opts);
  fns.push(...moduleNode.toInstrs(opts));
  // Always sort functions, so there are minimal changes in generated code
  fns.sort((a, b) => a.name.localeCompare(b.name));
  const wasmMod = {
    name: mod.name,
    memory: {
      size: memPos,
      export: true,
      import: opts.importMemory || opts.useThreads,
      maximum: opts.noMaximumLimit && !opts.useThreads ? undefined : memPos,
      shared: opts.useThreads,
    },
    functions: fns as any,
  };
  return { wasmMod, memory, importEmbed };
}

/**
 * Compiles `Module` to WASM
 */
export function toWasm(m: Module, opts: CompilerOpts = {}) {
  opts = { ...DefaultOpts, ...DefaultOptsWASM, ...opts };
  const { wasmMod, memory, importEmbed } = toMod(m, opts);
  // console.dir(wasmMod.functions, { depth: null, maxArrayLength: null });
  const jsCode = js.wrapWASM(wasmMod, wasm.createWasm(wasmMod), importEmbed, opts);
  return js.wrapModule(wasmMod, jsCode, memory, importEmbed, opts);
}

/**
 * Compiles `Module` to JS
 */
export function toJs(m: Module, opts: CompilerOpts = {}) {
  opts = { ...DefaultOpts, ...DefaultOptsJS, ...opts };
  const { wasmMod, memory, importEmbed } = toMod(m, opts);
  // console.dir(wasmMod.functions, { depth: null, maxArrayLength: null });
  const code = js.createJS(wasmMod, importEmbed, opts);
  return js.wrapModule(wasmMod, code, memory, importEmbed, opts);
}
