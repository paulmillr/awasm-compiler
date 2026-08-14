import * as P from 'micro-packed';
import {
  type CompilerOpts,
  type FnOp,
  type ModuleGraph,
  type Node,
  type NodeIdx,
  type NodeOf,
  as,
  is,
  isOp,
} from './codegen.ts';
import * as types from './types.ts';
import { type GetOpsFnOp, type TypeName } from './types.ts';
import * as utils from './utils.ts';

const _0n = /* @__PURE__ */ BigInt(0);
const _1n = /* @__PURE__ */ BigInt(1);
const _32n = /* @__PURE__ */ BigInt(32);
const U8_MASK_N = /* @__PURE__ */ BigInt(0xff);
const U32_MASK_N = /* @__PURE__ */ BigInt(0xffffffff);
const U64_SIGN_N = /* @__PURE__ */ BigInt('0x8000000000000000');

/** Per-node rewrite callback used by `TreeDAG.rewrite`. */
export type Rewrite = (node: Node, args: FnOp[], idx: NodeIdx) => FnOp | undefined;
/** Factory shape for rewrites that close over one module graph. */
export type RewriteFn = (fn: ModuleGraph, opts?: CompilerOpts) => Rewrite;

// These instructions can produce or propagate NaNs. Bit-preserving/sign-only operations such as
// load, store, reinterpret, abs, neg, and copysign intentionally stay outside this set.
const NaNProducingFloatOps = new Set([
  'add',
  'sub',
  'mul',
  'div',
  'rem',
  'min',
  'max',
  'sqrt',
  'ceil',
  'floor',
  'trunc',
  'nearest',
  'demote_f64',
  'promote_f32',
  'demote_f64x2_zero',
  'promote_low_f32x4',
  'pmin',
  'pmax',
  'relaxed_madd',
  'relaxed_nmadd',
  'relaxed_min',
  'relaxed_max',
]);

/**
 * Replaces NaNs produced by floating-point instructions with a fixed positive-canonical NaN.
 *
 * The raw instruction is cloned directly into the graph so construction CSE cannot return the
 * node currently being rewritten. The WeakSet makes the transformation stable across the rewrite
 * fixpoint without leaking an internal marker into emitted instructions.
 */
export function deterministicNaN(fn: ModuleGraph, _opts: CompilerOpts = {}): Rewrite {
  const rawInstructions = new WeakSet<Node>();
  return (node, _args, idx) => {
    if (
      node.kind !== 'op' ||
      rawInstructions.has(node) ||
      !types.FloatType.has(node.type) ||
      !NaNProducingFloatOps.has(node.op)
    )
      return;

    const rawNode = utils.deepClone(node);
    const rawIdx = fn.ops.add(rawNode, undefined, `deterministicNaN:${idx}`);
    rawInstructions.add(fn.ops.get(rawIdx));
    const raw = fn.byIdx(rawIdx);
    const T = fn.types[node.type];
    return T.select(T.ne(raw, raw), T.const(NaN), raw);
  };
}

// These are very self-contained, so even if they small it is reasonable to move out them.
// Maybe even separate files?
const constKey = (value: any): string | undefined => {
  if (typeof value === 'number') {
    if (Number.isNaN(value)) return 'number:NaN';
    if (Object.is(value, -0)) return 'number:-0';
    return `number:${value}`;
  }
  if (typeof value === 'bigint') return `bigint:${value.toString()}`;
  if (utils.isBytes(value)) return `bytes:${Array.from(value).join(',')}`;
  return undefined;
};
const nonReusableOps = new Set([
  'arg',
  'nodeOutput',
  'virtual',
  'call',
  'load',
  'store',
  'fill',
  'copy',
  'br',
  'br_if',
]);
const reusableOp = (op: string) => !nonReusableOps.has(op) && !op.startsWith('atomic');
const commutativeIntOp = (op: string) => types.opsVariadic.has(op) || op === 'eq' || op === 'ne';
// CSE keys only need a deterministic operand order; numeric path ordering burns time decoding.
const argCmp = (a: NodeIdx, b: NodeIdx) => (a < b ? -1 : a > b ? 1 : 0);
// Keep this as a keying rule, not a rewrite: returning fn.op(sortedArgs) can hand
// back the same cached node and make the rewrite fixpoint spin forever.
const keyArgs = (type: TypeName, op: string, args: NodeIdx[]): NodeIdx[] => {
  if (args.length < 2 || !commutativeIntOp(op) || !types.IntType.has(type)) return args;
  if (args.length === 2) return argCmp(args[0], args[1]) <= 0 ? args : [args[1], args[0]];
  return args.slice().sort(argCmp);
};
const keyArgsString = (type: TypeName, op: string, args: NodeIdx[]): string => {
  if (args.length === 0) return '';
  if (args.length === 1) return args[0];
  if (args.length === 2 && commutativeIntOp(op) && types.IntType.has(type)) {
    const a = args[0];
    const b = args[1];
    return argCmp(a, b) <= 0 ? `${a}|${b}` : `${b}|${a}`;
  }
  if (args.length > 2 && commutativeIntOp(op) && types.IntType.has(type))
    return args.slice().sort(argCmp).join('|');
  if (args.length === 2) return `${args[0]}|${args[1]}`;
  return args.join('|');
};
const emptyOpts = (opts: Record<string, any>) => {
  for (const _ in opts) return false;
  return true;
};
// Integer-only: reassociating floats changes IEEE rounding/NaN/-0 behavior.
const variadicCSE = (type: TypeName, op: string, opts: Record<string, any>) =>
  types.IntType.has(type) && types.opsVariadic.has(op) && emptyOpts(opts);
const versioned = <K, V>(fn: ModuleGraph, load: (key: K) => V) => {
  let version = -1;
  let cache = new Map<K, V>();
  return (key: K): V => {
    if (version !== fn.ops.version) {
      version = fn.ops.version;
      cache = new Map();
    }
    if (!cache.has(key)) cache.set(key, load(key));
    return cache.get(key)!;
  };
};
export const pureOpKey = (
  type: TypeName,
  op: string,
  args: NodeIdx[],
  opts: Record<string, any>
): string | undefined => {
  if (!reusableOp(op)) return;
  if (op === 'const') {
    let keys = 0;
    let hasValue = false;
    for (const k in opts) {
      keys++;
      if (k === 'value') hasValue = true;
      else if (k === 'type') {
        if (opts.type !== type) return;
      } else return;
    }
    if (!hasValue || keys > 2) return;
    const valueKey = constKey(opts.value);
    if (valueKey === undefined) return;
    return `${type}|${op}|${keyArgsString(type, op, args)}|${valueKey}`;
  } else if (!emptyOpts(opts)) return;
  return `${type}|${op}|${keyArgsString(type, op, args)}`;
};

// Transitive zero-pressure test: a value computable from args/consts alone (pure ops, no
// memory/control deps). Shared by cse (subset reuse safety) and icse (clonability cut).
// Memo is keyed by node OBJECT, not idx: cleanup() toposorts scopes and REUSES indices, so an
// idx-keyed memo goes stale across sweeps (icse once treated a load as stable through a slot
// a mul had vacated and cloned it forever).
const stableValues = (fn: ModuleGraph) => {
  const stable = new WeakMap<object, boolean>();
  const getNode = versioned(fn, (idx: NodeIdx) => fn.ops.get(idx));
  const stableValue = (idx: NodeIdx, stack = new Set<object>()): boolean => {
    const node = getNode(idx);
    const hit = stable.get(node);
    if (hit !== undefined) return hit;
    if (stack.has(node)) return false;
    stack.add(node);
    let ok = false;
    if (isOp(node, 'arg', 'const')) ok = true;
    else if (node.kind === 'op') {
      if (reusableOp(node.op)) ok = node.args.every((arg) => stableValue(arg, stack));
    }
    stack.delete(node);
    stable.set(node, ok);
    return ok;
  };
  return stableValue;
};

export function cse(fn: ModuleGraph, opts: CompilerOpts = {}): Rewrite {
  const seenVariadic = new Map<string, { idx: NodeIdx; args: NodeIdx[] }[]>();
  const protectedVariadic = new Set<NodeIdx>();
  // Subset reuse evaluates the subset before the leftover args; do not move memory/control deps.
  const stableValue = stableValues(fn);
  const getNode = versioned(fn, (idx: NodeIdx) => fn.ops.get(idx));
  const exists = versioned(fn, (idx: NodeIdx) => fn.ops.exists(idx));
  const parentOf = versioned(fn, (idx: NodeIdx) => utils.Path.parent(idx).parent);
  const dominates = (scope: NodeIdx, target: NodeIdx) =>
    scope === target || utils.Path.isParent(scope, target);
  const pinned = versioned(fn, (idx: NodeIdx) => {
    const parent = getNode(parentOf(idx));
    if (is(parent, 'function', 'block', 'loop') && parent.outputs.includes(idx)) return true;
    if (is(parent, 'function')) {
      for (const k in parent.memOps) {
        const op = parent.memOps[k];
        if (op.write === idx || op.reads.includes(idx)) return true;
      }
    }
    return false;
  });
  const flattenArgs = (node: Extract<Node, { kind: 'op' }>, idx: NodeIdx) => {
    const parent = utils.Path.parent(idx).parent;
    const out: NodeIdx[] = [];
    const consumed = new Set<NodeIdx>();
    let changed = false;
    for (const arg of node.args) {
      const argNode = getNode(arg);
      if (
        isOp(argNode, node.op) &&
        argNode.type === node.type &&
        emptyOpts(argNode.opts) &&
        parentOf(arg) === parent
      ) {
        const users = fn.ops.usedBy.get(arg);
        let times = 0;
        for (const a of node.args) if (a === arg) times++;
        if (
          times === 1 &&
          users?.size === 1 &&
          users.has(idx) &&
          !pinned(arg) &&
          !protectedVariadic.has(arg)
        ) {
          out.push(...argNode.args);
          consumed.add(arg);
          changed = true;
          continue;
        }
      }
      out.push(arg);
    }
    return { args: out, changed, consumed };
  };
  const restWithout = (args: NodeIdx[], subsetKey: NodeIdx[]) => {
    const left = subsetKey.slice();
    const rest: NodeIdx[] = [];
    // Match subsets by canonical key, but keep remaining args in their original evaluation order.
    for (const arg of args) {
      const pos = left.indexOf(arg);
      if (pos === -1) rest.push(arg);
      else left.splice(pos, 1);
    }
    if (left.length) return;
    return rest;
  };
  const bestSubsets = (
    group: string,
    args: NodeIdx[],
    idx: NodeIdx,
    parent: NodeIdx,
    consumed: Set<NodeIdx>
  ) => {
    const candidates = seenVariadic.get(group);
    if (!candidates) return;
    let rest = args.slice();
    const hits: { idx: NodeIdx; args: NodeIdx[] }[] = [];
    const hitIdx = new Set<NodeIdx>();
    for (;;) {
      let best: { idx: NodeIdx; args: NodeIdx[]; rest: NodeIdx[] } | undefined;
      for (const cur of candidates) {
        if (
          cur.idx === idx ||
          consumed.has(cur.idx) ||
          hitIdx.has(cur.idx) ||
          cur.args.length < 2 ||
          cur.args.length > rest.length
        )
          continue;
        const nextRest = restWithout(rest, cur.args);
        if (!nextRest) continue;
        if (!exists(cur.idx)) continue;
        // Only reuse subsets whose defining scope dominates this use; child/sibling scopes are control-dependent.
        if (!dominates(parentOf(cur.idx), parent)) continue;
        if (!pinned(cur.idx) && !fn.ops.usedBy.get(cur.idx)?.size) continue;
        if (!stableValue(cur.idx)) continue;
        if (!hits.length && !nextRest.length) continue;
        if (!best || cur.args.length > best.args.length) best = { ...cur, rest: nextRest };
      }
      if (!best) break;
      hits.push(best);
      hitIdx.add(best.idx);
      rest = best.rest;
    }
    if (!hits.length) return;
    return { hits, args: [...hits.map((i) => i.idx), ...rest] };
  };
  const rebuild = (node: NodeOf<'op'>, args: NodeIdx[]) =>
    fn.op(
      node.type,
      node.op,
      args.map((i) => fn.byIdx(i))
    );
  return (node, _args, idx) => {
    if (node.kind === 'function') {
      seenVariadic.clear();
      return;
    }
    if (!isOp(node)) return;
    const parent = parentOf(idx);
    if (variadicCSE(node.type, node.op, node.opts)) {
      const group = `${node.type}|${node.op}`;
      // Flattened scalar64 reducers lengthen Wasm live ranges around saved block state. Keep the
      // binary tree for that backend/type boundary; JS and narrower/vector reducers still flatten.
      const preserveTree =
        opts.lowerWasm && types.ScalarType.has(node.type) && types.sizeof(node.type) === 8;
      const flat = preserveTree
        ? { args: node.args, changed: false, consumed: new Set<NodeIdx>() }
        : flattenArgs(node, idx);
      const subsets = bestSubsets(group, flat.args, idx, parent, flat.consumed);
      if (subsets) {
        for (const subset of subsets.hits) protectedVariadic.add(subset.idx);
        return rebuild(node, subsets.args);
      }
      if (flat.changed) return rebuild(node, flat.args);
      let cur = seenVariadic.get(group);
      if (!cur) seenVariadic.set(group, (cur = []));
      const args = keyArgs(node.type, node.op, node.args);
      if (args.length >= 2) cur.push({ idx, args });
    }
    return;
  };
}

// Inverse CSE: clone shared values per use so they reach emission as single-use chains and
// fuse into consumer expressions. Production codegen pressure-gates this for tee-less JS;
// Wasm keeps tee-based materialization and skips the pass.
// Root cause it attacks (task log 2026-07-02): generator-source value sharing emits as
// long-lived materializations on wasm and one-op-per-const statements on JS, while the naive
// per-use-recompute shape (CLEAN) wins both platforms through the same pipeline.
// Cut: SINGLE-OP clones only — a pure op whose args are each a leaf (arg/const) OR a value
// that stays materialized anyway (2+ live users; the clone references its var, so recompute
// costs exactly one op and revives nothing — the R2 remat lesson). This is clean's measured
// shape: it holds loads in vars and re-emits only the top op per use (blake512's
// `(sigma ^ m_var)`, keccak's B-lane xors). The transitive-cone variant (v0) was measured
// out: it clones per PATH, keccak wasm 51->146KB / js 53->188KB, and the JS function falls
// off V8's optimizing tier (same cliff as graph-level unroll, +38.9%). Single-op clones are
// linear in uses by construction. A per-value fan-out budget also bounds that linear cost:
// high-fanout values are cheaper to keep materialized than to recompute for every consumer.
// Runs OUTSIDE the main rewrite fixpoint (after lowerWasm, see codegen.rewrite): cse subset
// reuse and construction CSE are direct antagonists, and motion must not hoist fresh clones
// away from the consumers they were built next to. Clones of empty-opts pure ops carry a
// unique {icse:n} marker so the per-scope construction cache cannot re-merge them.
export function icse(fn: ModuleGraph, opts: CompilerOpts = {}): Rewrite {
  let n = 0;
  // usedBy retains entries for removed nodes (motion filters the same way) — counting
  // ghosts here made the pass re-clone the same value forever.
  const live = (idx: NodeIdx) => {
    let res = 0;
    for (const u of fn.ops.usedBy.get(idx) || []) if (fn.ops.exists(u)) res++;
    return res;
  };
  // "Free" clone input: leaves cost nothing to reference; a 2+-user value stays a var either
  // way, so the clone reads it like the original did. Single-user non-leaf args would inline
  // their body into the clone (cone growth) — those keep the sharing.
  const freeArg = (idx: NodeIdx) => isOp(fn.ops.get(idx), 'arg', 'const') || live(idx) >= 2;
  // Clones are terminal: firing into a clone would re-clone its multi-user args next sweep
  // and unroll whole chains per path — v0's explosion through a second channel.
  const clones = new WeakSet<object>();
  // ALU consumers only. Memory consumers measured out twice: address-only cloning is a JS
  // no-op (+0.23 tie — on wasm addresses fold into load offset opts and never fire), and an
  // address shared between a load and its wipe-store gets computed TWICE when cloned (md5-js
  // flipped -1.15 win -> +2.0 loss vs clean on exactly that shape). Control/memory ops also
  // keep original args — rebuilding them risks their linkage semantics.
  const cloneInto = (node: Node) =>
    is(node, 'op') &&
    // JS lowers rotates to two shifts that each read operand 0; Wasm retains one native opcode.
    (opts.lowerWasm || !isOp(node, 'rotl', 'rotr')) &&
    reusableOp(node.op);
  const ownerOf = (idx: NodeIdx) =>
    fn.ops.getStack(idx).find(({ node }) => is(node, 'function'))?.node;
  // Single-binary-operator ops only: recomputing `(a + b)` per use is cheaper than
  // holding a named value across rounds (sha256 -5.7, blake512 -13). Composite-emission
  // ops (rotl -> `(x<<n)|(x>>>m)`: 3 ops, arg read twice) cost more per use than the
  // var reference they replace — ripemd-JS +18.5 / md5 +2.9 / blake3 +1.7 were exactly
  // the rotation-heavy kernels. opsVariadic is the existing name for this class.
  // CSE flattens reducers, so the variadic-op set alone also admits costly 3+-operand clones.
  // Known residual: blake3-js pays 2.7-5.5% here (still ~10% ahead of clean). Its 2-user
  // G links are shape-identical to blake512/keccak's 2-user WINNERS on every probed
  // feature (user count v7, single-user fusion paths v8 — both falsified; task log
  // 2026-07-03). Lowered-width provenance now exists for scheduling, but is intentionally
  // not used as an ICSE selector without a full generic benchmark board.
  // All-or-nothing: cloning pays only when the pass can RETIRE the value — every live
  // user must itself be a clonable-into ALU op (and not a terminal clone), and the value
  // must not be pinned (weak-linked or a scope output). One unclonable user keeps the
  // var alive, making every clone a redundant recompute (md5's +4-address chain: links
  // held by load+wipe-store were also cloned into successor adds — pure waste).
  const candidate = (idx: NodeIdx, positions?: Map<NodeIdx, number>) => {
    const node = fn.ops.get(idx);
    const users = live(idx);
    if (
      !is(node, 'op') ||
      isOp(node, 'arg', 'const') ||
      !types.opsVariadic.has(node.op) ||
      node.args.length !== 2 ||
      clones.has(node) ||
      !node.args.every(freeArg) ||
      users < 2 ||
      users > 16 ||
      fn.ops.usedWeak.get(idx)?.size
    )
      return;
    const parent = fn.ops.get(utils.Path.parent(idx).parent);
    if (is(parent, 'function', 'block', 'loop') && parent.outputs.includes(idx)) return;
    let end = positions?.get(idx);
    if (positions && end === undefined) return;
    for (const user of fn.ops.usedBy.get(idx)!) {
      if (!fn.ops.exists(user)) continue;
      const userNode = fn.ops.get(user);
      if (!cloneInto(userNode) || clones.has(userNode)) return;
      if (!positions) continue;
      const pos = positions.get(user);
      if (pos === undefined) return;
      if (pos > end!) end = pos;
    }
    return { node, end };
  };
  const enabled = new WeakSet<object>();
  if (opts.icseOps) {
    const functions = new Map<object, NodeIdx[]>();
    fn.ops.iter((node, idx) => {
      if (!is(node, 'op')) return;
      const owner = ownerOf(idx);
      if (!owner) return;
      const entries = functions.get(owner) || [];
      entries.push(idx);
      functions.set(owner, entries);
    });
    for (const [owner, entries] of functions) {
      const positions = new Map(entries.map((idx, pos) => [idx, pos]));
      const pressure = new Int32Array(entries.length + 1);
      for (let pos = 0; pos < entries.length; pos++) {
        const idx = entries[pos];
        const value = candidate(idx, positions);
        if (!value) continue;
        pressure[pos]++;
        pressure[value.end! + 1]--;
      }
      let live = 0;
      for (const change of pressure) {
        live += change;
        if (live < 64) continue;
        enabled.add(owner);
        break;
      }
    }
  }
  return (node, args, _idx) => {
    if (!is(node, 'op') || !cloneInto(node) || clones.has(node)) return;
    if (opts.icseOps) {
      const owner = ownerOf(_idx);
      if (!owner || !enabled.has(owner)) return;
    }
    let changed = false;
    const newArgs = args.map((arg) => {
      const value = candidate(arg.idx);
      if (!value) return arg;
      changed = true;
      n++;
      const clone = fn.op(
        value.node.type,
        value.node.op,
        value.node.args.map((i) => fn.byIdx(i)),
        Object.keys(value.node.opts).length ? { ...value.node.opts } : { icse: n }
      );
      clones.add(fn.ops.get(clone.idx));
      return clone;
    });
    if (!changed) return;
    return fn.op(node.type, node.op, newArgs, node.opts);
  };
}

export function motion(fn: ModuleGraph, _opts: CompilerOpts = {}): Rewrite {
  const stable = new Map<NodeIdx, boolean>();
  const parentOf = (idx: NodeIdx) => utils.Path.parent(idx).parent;
  const scopes = (idx: NodeIdx, kind?: 'block' | 'loop' | 'function') =>
    fn.ops
      .getStack(idx)
      .filter(({ node }) => (kind ? node.kind === kind : is(node, 'block', 'loop', 'function')));
  const pinned = (idx: NodeIdx) => {
    if (fn.ops.usedWeak.get(idx)?.size) return true;
    const parent = fn.ops.get(parentOf(idx));
    if (is(parent, 'function', 'block', 'loop') && parent.outputs.includes(idx)) return true;
    for (const cur of scopes(idx, 'function')) {
      const node = as(cur.node, 'function');
      for (const k in node.memOps) {
        const op = node.memOps[k];
        if (op.write === idx || op.reads.includes(idx)) return true;
      }
    }
    return false;
  };
  const stableValue = (idx: NodeIdx, stack = new Set<NodeIdx>()): boolean => {
    const hit = stable.get(idx);
    if (hit !== undefined) return hit;
    if (stack.has(idx) || pinned(idx)) return false;
    stack.add(idx);
    const node = fn.ops.get(idx);
    let ok = false;
    if (isOp(node, 'arg', 'const')) ok = true;
    else if (node.kind === 'op') {
      const key = pureOpKey(node.type, node.op, node.args, node.opts);
      if (key !== undefined) ok = node.args.every((arg) => stableValue(arg, stack));
    }
    stack.delete(idx);
    stable.set(idx, ok);
    return ok;
  };
  const addAt = (parent: NodeIdx, node: Extract<Node, { kind: 'op' }>) =>
    fn.byIdx(
      fn.ops.add(
        {
          kind: 'op',
          type: node.type,
          op: node.op,
          args: node.args.slice(),
          opts: utils.deepClone(node.opts),
        },
        parent
      )
    );
  const crossesIntoLoop = (from: NodeIdx, target: NodeIdx) => {
    const fromLoops = new Set(scopes(from, 'loop').map((i) => i.idx));
    for (const cur of scopes(target, 'loop')) if (!fromLoops.has(cur.idx)) return true;
    return false;
  };
  const hoistTarget = (idx: NodeIdx, node: Extract<Node, { kind: 'op' }>) => {
    const loops = scopes(idx, 'loop');
    const loop = loops[loops.length - 1]?.idx;
    if (!loop) return;
    for (const arg of node.args) if (arg === loop || utils.Path.isParent(loop, arg)) return;
    const target = parentOf(loop);
    if (target !== parentOf(idx)) return target;
    return;
  };
  const sinkTarget = (idx: NodeIdx) => {
    const users = Array.from(fn.ops.usedBy.get(idx) || []).filter((user) => fn.ops.exists(user));
    if (!users.length) return;
    const parent = parentOf(idx);
    const blocks = scopes(users[0], 'block')
      .map((i) => i.idx)
      .filter((block) => utils.Path.isParent(parent, block) && !crossesIntoLoop(idx, block))
      .reverse();
    for (const block of blocks) {
      const contains = users.every((user) => {
        const userNode = fn.ops.get(user);
        return !is(userNode, 'block', 'loop') && utils.Path.isParent(block, user);
      });
      if (contains) return block;
    }
    return;
  };
  return (node, _args, idx) => {
    if (!isOp(node) || pureOpKey(node.type, node.op, node.args, node.opts) === undefined) return;
    if (!stableValue(idx)) return;
    const target = hoistTarget(idx, node) || sinkTarget(idx);
    if (!target || target === parentOf(idx)) return;
    return addAt(target, node);
  };
}

function loweringUtils(
  fn: ModuleGraph,
  node: Node,
  args: FnOp[],
  idx: NodeIdx,
  getLowerType: (t: TypeName) => TypeName | undefined,
  isVirtual: (node: Node) => boolean,
  createVirtual: (type: TypeName, prevLanes: FnOp[], opts?: Record<string, any>) => FnOp
) {
  const getConst = (idx: NodeIdx) => {
    const node = as(fn.ops.get(idx), 'op');
    if (!node) throw new Error('getConst: no node');
    if (isVirtual(node) && node.opts.value !== undefined) return node.opts.value;
    if (node.op !== 'const') throw new Error('getConst: not const');
    return node.opts.value;
  };

  const getArg = (idx: NodeIdx) => {
    const node = fn.ops.get(idx);
    if (isVirtual(node) && node.kind === 'op') return node.args.map((i) => fn.byIdx(i));
    return undefined;
  };
  const prev = args ? args.map((i) => getArg(i.idx)) : [];
  const mapPrevChanged = (values: NodeIdx[]) => {
    let changed = false;
    const res = [];
    for (let v of values) {
      const prevNode = fn.ops.get(v);
      if (prevNode.kind === 'op' && isVirtual(prevNode)) {
        res.push(...prevNode.args);
        changed = true;
      } else res.push(v);
    }
    return { res, changed };
  };
  const virt = createVirtual;
  const mapPrev = (values: NodeIdx[]) => mapPrevChanged(values).res;

  function expandVirtual(lst: NodeIdx[]) {
    let changed = false;
    const res = [];
    for (let i = 0; i < lst.length; i++) {
      const o = lst[i];
      const oNode = fn.ops.get(o);
      if (oNode.kind === 'op' && isVirtual(oNode)) {
        res.push(...oNode.args);
        changed = true;
      } else res.push(o);
    }
    return { res, changed };
  }

  function mapBlocks(): FnOp | undefined {
    let changed = false;
    if (isOp(node, 'store', 'load', 'call', 'fill', 'copy', 'br', 'br_if')) {
      const { changed: changedWeak, res } = mapPrevChanged(node.opts.weak || []);
      if (changedWeak) {
        node.opts.weak = res.map((i) => fn.ops.weak(i));
        changed = true;
      }
    }
    // blocks/loops
    // - update block/loop
    // - update arg inside
    // - update br/br_if inside
    // - update nodeOutput in siblings
    // same can be used for simd/u64/fn arg lowering
    // we also need to split outputs. but we can do only after processing all childrens!
    if (is(node, 'block', 'loop')) {
      const virtualArgs = prev.map((_i, j) => j).filter((i) => !!prev[i]);
      if (virtualArgs.length) {
        const remap = []; // remap[old] = new
        const newArgs = [];
        for (let i = 0; i < args.length; i++) {
          if (!virtualArgs.includes(i)) {
            remap.push(newArgs.push(args[i]) - 1);
          } else {
            if (!prev[i]) throw new Error('no prev');
            const parts = [];
            for (let j = 0; j < prev[i]!.length; j++) parts.push(newArgs.push(prev[i]![j]) - 1);
            const prevType = as(fn.ops.get(args[i].idx), 'op').type;
            remap.push({ type: prevType, parts });
          }
        }
        node.args = newArgs.map((i) => i.idx);
        if (!node.opts.remap) node.opts.remap = [];
        node.opts.remap.push(remap);
        return fn.byIdx(idx);
      }
      // note: we can do this only after processing all childrens, which means next iteration
      if (node.args.length !== node.outputs.length) {
        const { res: newOutputs, changed } = expandVirtual(node.outputs);
        if (changed) {
          node.outputs = newOutputs;
          return fn.byIdx(idx);
        }
      }
    } else if (isOp(node, 'arg', 'nodeOutput')) {
      let prevNode;
      if (node.op === 'arg') {
        prevNode = fn.ops.get(node.opts.scope ? node.opts.scope : '');
      } else {
        prevNode = fn.ops.get(node.args![0]);
      }
      // TODO: should we just pass function as scope too?
      if (prevNode.opts && prevNode.opts.remap) {
        const curEpoch = node.opts?.epoch || 0;
        const remap = prevNode.opts.remap[curEpoch];
        if (remap) {
          const newPos = remap[node.opts.pos];
          if (typeof newPos === 'number') {
            node.opts.pos = newPos;
            node.opts.epoch = curEpoch + 1;
            return fn.byIdx(idx);
          } else if (newPos && (getLowerType(as(node, 'op').type) || getLowerType(newPos.type))) {
            const parts = newPos.parts.map((i: any) => {
              const opts = { epoch: curEpoch + 1, pos: i, scope: node.opts.scope };
              const lowerType = getLowerType(as(node, 'op').type) || getLowerType(newPos.type);
              if (!lowerType) throw new Error('wrong lower type');
              return node.kind === 'op' && node.op === 'nodeOutput'
                ? fn.op(lowerType, 'nodeOutput', [args[0]], opts)
                : fn.op(lowerType, 'arg', [], opts);
            });
            return createVirtual(newPos.type, parts);
          }
        }
      }
    } else if (isOp(node, 'br', 'br_if')) {
      const { res: newArgs, changed } = expandVirtual(node.args);
      if (changed) {
        node.args = newArgs;
        return fn.byIdx(idx);
      }
    }
    if (changed) return fn.byIdx(idx);
    return;
  }

  function skipNode() {
    if (node.kind !== 'op') return true;
    if (isVirtual(node)) return true;
    const lower = getLowerType(node.type);
    if (!lower) return true;
    return false;
  }

  function elemwiseVirtual(): FnOp {
    node = as(node, 'op');
    const loType = getLowerType(node.type);
    if (!loType) throw new Error('elemwiseVirtual: no lower type for ' + node.type);
    // determine number of parts from the first split arg (u64:2, simd: lanes)
    const firstSplit = prev.find(Boolean);
    if (!firstSplit) throw new Error('elemwiseVirtual: no split operands provided');
    const parts = firstSplit!.length;
    // (optional) sanity: all split operands must have same arity
    for (const p of prev)
      if (p && p.length !== parts) throw new Error('elemwiseVirtual: arity mismatch');
    const outParts: FnOp[] = new Array(parts);
    for (let k = 0; k < parts; k++) {
      // build operand list for this part k
      const ops: FnOp[] = new Array(args.length);
      for (let j = 0; j < args.length; j++) {
        const pj = prev[j];
        if (pj)
          ops[j] = pj[k]; // take split piece j.k
        else ops[j] = args[j]; // already at lower type OR scalar allowed by op
      }
      outParts[k] = fn.op(loType, node.op, ops, utils.deepClone(node.opts));
    }
    return createVirtual(node.type, outParts);
  }

  return { getConst, isVirtual, prev, mapPrev, getArg, mapBlocks, skipNode, elemwiseVirtual, virt };
}
/**
 * Lowers wide integer operations into half-width virtual parts.
 *
 * @param fn - Function graph whose nodes may be lowered.
 * @param _opts - Compiler options. {@link CompilerOpts}
 * @param bits - Wide integer bit width to lower.
 * @returns Rewrite callback for `TreeDAG.rewrite`.
 * @throws If the requested bit width is unsupported. {@link Error}
 * @example
 * ```js
 * import { Module } from '@awasm/compiler/module.js';
 * import { ModuleGraph } from '@awasm/compiler/codegen.js';
 * import { lowerWideInt } from '@awasm/compiler/rewrites.js';
 *
 * lowerWideInt(new ModuleGraph('demo', {}, new Module('demo'), {}));
 * ```
 */
export function lowerWideInt(fn: ModuleGraph, _opts: CompilerOpts = {}, bits = 64): Rewrite {
  if (typeof bits !== 'number')
    throw new TypeError(`"bits" expected number, got type=${typeof bits}`);
  if (!Number.isSafeInteger(bits)) throw new RangeError(`"bits" expected integer, got ${bits}`);
  if (![64, 128, 256].includes(bits)) throw new Error(`lowerWideInt: unsupported width ${bits}`);
  const wordBits = bits / 2;
  const wordBytes = wordBits / 8;
  const signedWord = `i${wordBits}` as TypeName;
  const unsignedWord = `u${wordBits}` as TypeName;
  const constOf = (t: TypeName, v: number | bigint) => {
    const useBig = types.sizeof(t) >= 8;
    const value = typeof v === 'bigint' ? v : useBig ? BigInt(v) : v;
    return fn.op(t, 'const', [], { value });
  };
  const getLowerType = (t: TypeName) => {
    if (bits === 64 && (t === 'i64' || t === 'u64')) return signedWord;
    if (t === `i${bits}`) return signedWord;
    if (t === `u${bits}`) return unsignedWord;
    return undefined;
  };
  const isVirt = (node: Node) =>
    node.kind === 'op' && node.op === 'virtual' && !!getLowerType(node.type);
  const createVirtual = (type: TypeName, parts: FnOp[], opts?: Record<string, any>) =>
    fn.op(type, 'virtual', parts, opts);

  return (node, args, idx) => {
    const {
      getConst,
      isVirtual: _isVirtual,
      prev,
      mapPrev,
      mapBlocks,
      skipNode,
      virt,
    } = loweringUtils(fn, node, args, idx, getLowerType, isVirt, createVirtual);

    const mb = mapBlocks();
    if (mb) return mb;
    if (bits === 64 && isOp(node, 'wrap_i64')) {
      return prev[0]![0];
    }
    if (bits === 64 && isOp(node, 'reinterpret_i64'))
      return fn.op(node.type, 'reinterpret_i32', [...prev[0]!]);
    if (bits === 64 && isOp(node, 'convert_i64_s', 'convert_i64_u')) {
      const [lo, hi] = prev[0]!;
      const isUnsigned = node.op === 'convert_i64_u';
      const { f64 } = fn.types;
      // lo is always unsigned, hi is signed/unsigned depending on op
      const loF = fn.op('f64', 'convert_i32_u', [lo]);
      const hiF = fn.op('f64', isUnsigned ? 'convert_i32_u' : 'convert_i32_s', [hi]);
      const scale = f64.const(2 ** 32);
      const result = f64.add(loF, fn.op('f64', 'mul', [hiF, scale]));
      if (node.type === 'f32') return fn.op('f32', 'demote_f64', [result]);
      return result;
    }
    if (bits === 64 && isOp(node, 'atomic.wait') && prev[2])
      return fn.op(node.type, 'atomic.wait', [args[0], args[1], ...prev[2]], node.opts);
    if (skipNode()) return undefined;
    node = as(node, 'op');

    const isSigned = node.type.startsWith('i');
    const lowType = getLowerType(node.type);
    if (!lowType) return;
    const lowSigned = signedWord;
    const lowUnsigned = unsignedWord;
    const cast = (t: TypeName, v: FnOp) => {
      const from = as(fn.ops.get(v.idx), 'op').type;
      return t === from ? v : fn.op(t, 'cast', [v], { from });
    };
    const useCast = wordBits !== 32;
    const U = (v: FnOp) => (useCast && lowUnsigned !== lowType ? cast(lowUnsigned, v) : v);
    const S = (v: FnOp) => (useCast && lowSigned !== lowType ? cast(lowSigned, v) : v);
    const LT = lowType;
    const markWide = (value: FnOp) => {
      const lowered = as(fn.ops.get(value.idx), 'op');
      lowered.wide = Math.max(lowered.wide || 0, bits);
      return value;
    };
    // Mark operations created from a logical wide value, not their entire function: native
    // u32 rounds often share a function with a u64 byte counter and need a different schedule.
    const opLT = (op: string, args: FnOp[]) => markWide(fn.op(LT, op, args));
    const opU = (op: string, args: FnOp[]) =>
      markWide(
        fn.op(
          wordBits === 32 ? 'u32' : lowUnsigned,
          op,
          args.map((v) => U(v))
        )
      );
    const opS = (op: string, args: FnOp[]) =>
      markWide(
        fn.op(
          lowSigned,
          op,
          args.map((v) => S(v))
        )
      );
    const opB = (op: string, args: FnOp[]) =>
      markWide(fn.op(wordBits === 32 ? LT : 'u32', op, args));
    const toLT = (v: FnOp) => {
      const vType = as(fn.ops.get(v.idx), 'op').type;
      if (vType === LT) return v;
      if (vType === 'u32' || vType === 'i32') {
        if (LT === 'u32' || LT === 'i32') return fn.op(LT, 'cast', [v], { from: vType });
        const vU = vType === 'u32' ? v : fn.op('u32', 'cast', [v], { from: vType });
        return opLT('select', [one, zero, vU]);
      }
      return v;
    };
    const zero = constOf(LT, 0);
    const one = constOf(LT, 1);
    const neg1 = constOf(LT, -1);
    const wordMask = constOf(LT, wordBits - 1);
    const bitMask = constOf(LT, bits - 1);
    const wordConst = constOf(LT, wordBits);
    const pairOf = (i: number) => prev[i];
    const widenArg = (i: number, mode: 'add' | 'arith' | 'store') => {
      const arg = args[i];
      const argType = as(fn.ops.get(arg.idx), 'op').type;
      // u128 div emits 32-bit booleans used in u64 sub/mul arithmetic.
      if ((argType === 'u32' || (mode === 'arith' && argType === 'i32')) && node.type === 'u64')
        return [arg, zero];
      if (argType === 'i32' && node.type === 'i64')
        return [arg, opS('shr', [arg, constOf(LT, 31)])];
      if (mode === 'add' && argType === node.type && (node.type === 'u64' || node.type === 'i64')) {
        const argNode = as(fn.ops.get(arg.idx), 'op');
        if (argNode.op === 'cast' && (argNode.opts.from === 'u32' || argNode.opts.from === 'i32')) {
          const src = fn.byIdx(argNode.args[0]);
          if (argNode.opts.from === 'u32') return [src, zero];
          return [src, opS('shr', [src, constOf(LT, 31)])];
        }
      }
      if (
        mode === 'store' &&
        (argType === 'u64' || argType === 'i64') &&
        (node.type === 'u64' || node.type === 'i64')
      )
        return (fn.types as any)[argType].to(LT, arg);
      return;
    };

    const carryFromAdd = (a: FnOp, b: FnOp, sum: FnOp): FnOp => {
      const a_and_b = opLT('and', [a, b]);
      const a_or_b = opLT('or', [a, b]);
      const not_sum = opLT('xor', [sum, neg1]);
      const gen = opLT('or', [a_and_b, opLT('and', [a_or_b, not_sum])]);
      const carry = opU('shr', [gen, constOf(LT, wordBits - 1)]);
      return cast(LT, carry);
    };
    const U32 = U32_MASK_N;
    if (isOp(node, 'arg')) {
      // NOTE: we don't replace node here, instead we create new one and use it everywhere.
      // TODO: Bigint lowering is kinda broken, we cannot call functions with u64 arg anyway.
      if (!node.opts.loweredU64 && !node.opts.scope) {
        const arg = fn.op(node.type, 'arg', [], {
          type: node.type,
          pos: node.opts.pos,
          loweredU64: true,
        });
        const l = fn.op(lowType, 'low_big', [arg]);
        const h = fn.op(lowType, 'high_big', [arg]);
        return virt(node.type, [l, h]);
      }
    } else if (isOp(node, 'const')) {
      const v = node.opts.value;
      if (bits === 64) {
        const loU = v & U32;
        const hiU = (v >> _32n) & U32;
        const l = fn.op(LT, 'const', [], { value: Number(types.u32ToI32(loU)) });
        const h = fn.op(LT, 'const', [], { value: Number(types.u32ToI32(hiU)) });
        return virt(node.type, [l, h], { value: v });
      }
      const lo = v & ((_1n << BigInt(wordBits)) - _1n);
      const hi = (v >> BigInt(wordBits)) & ((_1n << BigInt(wordBits)) - _1n);
      const l = constOf(LT, lo);
      const h = constOf(LT, hi);
      return virt(node.type, [l, h], { value: v });
    } else if (isOp(node, 'load')) {
      const weak = mapPrev(node.opts.weak || []).map((i) => fn.ops.weak(i));
      const strong = mapPrev(node.opts.strong || []);
      const args = [fn.byIdx(node.args[0])];
      const lPos = node.opts.swapEndianness ? wordBytes : 0;
      const hPos = node.opts.swapEndianness ? 0 : wordBytes;
      const opts: Record<string, any> = { ...node.opts, weak, strong };
      if (opts.size === bits) delete opts.size;
      const l = fn.op(lowType, 'load', args, {
        ...opts,
        offset: (opts.offset || 0) + (opts.size ? 0 : lPos),
      });
      const h = opts.size
        ? node.type.startsWith('i')
          ? opS('shr', [l, constOf(LT, wordBits - 1)])
          : zero
        : fn.op(lowType, 'load', args, {
            ...opts,
            offset: (opts.offset || 0) + hPos,
          });
      return virt(node.type, [l, h]);
    } else if (isOp(node, 'store')) {
      const p = prev[1] || widenArg(1, 'store');
      if (!p) {
        console.error('lowerU64', p, node.args[1], fn.ops.get(node.args[1]), node);
        console.error('GRAPH', fn.ops.format());
        throw new Error('lowerU64: no previous');
      }
      const weak = mapPrev(node.opts.weak || []).map((i) => fn.ops.weak(i));
      const strong = mapPrev(node.opts.strong || []);
      const opts: Record<string, any> = {
        ...node.opts,
        weak,
        strong,
        isMut: true,
        source: 'lowerU64',
      };
      if (opts.size === bits) delete opts.size;
      const lPos = node.opts.swapEndianness ? wordBytes : 0;
      const hPos = node.opts.swapEndianness ? 0 : wordBytes;
      const l = fn.op(lowType, 'store', [fn.byIdx(node.args[0]), p[0]], {
        ...opts,
        offset: (opts.offset || 0) + (opts.size ? 0 : lPos),
      });
      node.opts.isMut = false; // allow removing
      if (opts.size) return l;
      const h = fn.op(lowType, 'store', [fn.byIdx(node.args[0]), p[1]], {
        ...opts,
        strong: [l.idx],
        offset: (opts.offset || 0) + hPos,
        source: 'lowerU64/h-nosize',
      });
      return h;
    } else if (isOp(node, 'rotr', 'rotl', 'shl', 'shr')) {
      const v = pairOf(0);
      if (!v) throw new Error('rotr: missing prev pair for arg0');
      const [l, h] = v;
      const shiftNode = as(fn.ops.get(args[1].idx), 'op');
      const shiftIsConst =
        shiftNode.op === 'const' || (_isVirtual(shiftNode) && shiftNode.opts.value !== undefined);
      if (!shiftIsConst) {
        const s = prev[1]![0] as FnOp;
        const rotrDyn = (s: FnOp): [FnOp, FnOp] => {
          const s0 = opLT('and', [s, bitMask]); // 0..bits-1
          const k = opLT('and', [s0, wordMask]); // 0..wordBits-1
          const inv = opLT('sub', [wordConst, k]); // wordBits-k
          const hi =
            wordBits === 32 ? opU('shr', [s0, constOf(LT, 5)]) : opLT('ge', [s0, wordConst]); // 0/1
          const is0 = opLT('eqz', [s0]);
          const isW = opLT('eq', [s0, wordConst]);

          const A = opU('shr', [h, k]); // h >>> k
          const B = opU('shr', [l, k]); // l >>> k
          const C = opLT('shl', [h, inv]); // h << (wordBits-k)
          const D = opLT('shl', [l, inv]); // l << (wordBits-k)

          const H0 = opLT('or', [A, D]);
          const L0 = opLT('or', [B, C]);

          const H1 = opLT('or', [B, C]);
          const L1 = opLT('or', [A, D]);

          let H = opLT('select', [H1, H0, hi]);
          let L = opLT('select', [L1, L0, hi]);

          H = opLT('select', [l, H, isW]);
          L = opLT('select', [h, L, isW]);
          H = opLT('select', [h, H, is0]);
          L = opLT('select', [l, L, is0]);

          return [L, H];
        };

        if (node.op === 'rotr') {
          return virt(node.type, rotrDyn(s));
        }
        if (node.op === 'rotl') {
          const s0 = opLT('and', [s, bitMask]);
          const sR = opLT('and', [opLT('sub', [zero, s0]), bitMask]);
          return virt(node.type, rotrDyn(sR));
        }
        if (node.op === 'shl') {
          const s0 = opLT('and', [s, bitMask]);
          const k = opLT('and', [s0, wordMask]);
          const inv = opLT('sub', [wordConst, k]);
          const hi =
            wordBits === 32 ? opU('shr', [s0, constOf(LT, 5)]) : opLT('ge', [s0, wordConst]);
          const is0 = opLT('eqz', [s0]);

          const H0 = opLT('or', [opLT('shl', [h, k]), opU('shr', [l, inv])]);
          const L0 = opLT('shl', [l, k]);

          const H1 = opLT('shl', [l, k]);
          const L1 = zero;

          let H = opLT('select', [H1, H0, hi]);
          let L = opLT('select', [L1, L0, hi]);

          H = opLT('select', [h, H, is0]);
          L = opLT('select', [l, L, is0]);
          return virt(node.type, [L, H]);
        }
        if (node.op === 'shr' && !isSigned) {
          const s0 = opLT('and', [s, bitMask]);
          const k = opLT('and', [s0, wordMask]);
          const inv = opLT('sub', [wordConst, k]);
          const hi =
            wordBits === 32 ? opU('shr', [s0, constOf(LT, 5)]) : opLT('ge', [s0, wordConst]);
          const is0 = opLT('eqz', [s0]);

          const H0 = opU('shr', [h, k]);
          const L0 = opLT('or', [opU('shr', [l, k]), opLT('shl', [h, inv])]);

          const H1 = zero;
          const L1 = opU('shr', [h, k]);

          let H = opLT('select', [H1, H0, hi]);
          let L = opLT('select', [L1, L0, hi]);

          H = opLT('select', [h, H, is0]);
          L = opLT('select', [l, L, is0]);
          return virt(node.type, [L, H]);
        }
        if (node.op === 'shr' && isSigned) {
          const s0 = opLT('and', [s, bitMask]);
          const k = opLT('and', [s0, wordMask]);
          const inv = opLT('sub', [wordConst, k]);
          const hi =
            wordBits === 32 ? opU('shr', [s0, constOf(LT, 5)]) : opLT('ge', [s0, wordConst]);
          const is0 = opLT('eqz', [s0]);

          const H0 = opS('shr', [h, k]);
          const L0 = opLT('or', [opU('shr', [l, k]), opLT('shl', [h, inv])]);

          const sign = opS('shr', [h, constOf(LT, wordBits - 1)]);
          const H1 = sign;
          const L1 = opS('shr', [h, k]);

          let H = opLT('select', [H1, H0, hi]);
          let L = opLT('select', [L1, L0, hi]);

          H = opLT('select', [h, H, is0]);
          L = opLT('select', [l, L, is0]);
          return virt(node.type, [L, H]);
        }
        throw new Error('unknown shift op/type');
      }
      if (isOp(node, 'rotr', 'rotl')) {
        // arg0 = value (i64), arg1 = shift (must be const here)
        const s0 = Number(getConst(node.args[1]) & BigInt(bits - 1)); // 0..bits-1
        let s = node.op === 'rotl' ? (bits - s0) & (bits - 1) : s0;
        let H: FnOp, L: FnOp;
        if (s === 0) {
          return virt(node.type, [l, h]);
        } else if (s < wordBits) {
          const sh = constOf(LT, s);
          const inv = constOf(LT, wordBits - s);
          H = opLT('or', [opU('shr', [h, sh]), opLT('shl', [l, inv])]);
          L = opLT('or', [opU('shr', [l, sh]), opLT('shl', [h, inv])]);
        } else if (s === wordBits) {
          H = l;
          L = h;
        } else {
          const sh2 = constOf(LT, s - wordBits);
          const inv = constOf(LT, bits - s);
          H = opLT('or', [opLT('shl', [h, inv]), opU('shr', [l, sh2])]);
          L = opLT('or', [opLT('shl', [l, inv]), opU('shr', [h, sh2])]);
        }
        return virt(node.type, [L, H]);
      } else if (isOp(node, 'shr')) {
        const s = Number(getConst(node.args[1]) & BigInt(bits - 1));
        let H: FnOp, L: FnOp;
        if (s === 0) {
          H = h;
          L = l;
        } else if (s < wordBits) {
          const sh = constOf(LT, s);
          const inv = constOf(LT, wordBits - s);
          H = isSigned ? opS('shr', [h, sh]) : opU('shr', [h, sh]);
          L = opLT('or', [opU('shr', [l, sh]), opLT('shl', [h, inv])]);
        } else if (!isSigned && s === wordBits) {
          H = zero;
          L = h;
        } else {
          const k = constOf(LT, s - wordBits);
          const sign = isSigned ? opS('shr', [h, constOf(LT, wordBits - 1)]) : zero;
          H = isSigned ? sign : zero;
          L = isSigned ? opS('shr', [h, k]) : opU('shr', [h, k]);
        }
        return virt(node.type, [L, H]);
      } else if (isOp(node, 'shl')) {
        const s = Number(getConst(node.args[1]) & BigInt(bits - 1));
        let H: FnOp, L: FnOp;
        if (s === 0) {
          H = h;
          L = l;
        } else if (s < wordBits) {
          const sh = constOf(LT, s);
          const inv = constOf(LT, wordBits - s);
          H = opLT('or', [opLT('shl', [h, sh]), opU('shr', [l, inv])]);
          L = opLT('shl', [l, sh]);
        } else if (s === wordBits) {
          H = l;
          L = zero;
        } else {
          const sh2 = constOf(LT, s - wordBits);
          H = opLT('shl', [l, sh2]);
          L = zero;
        }
        return virt(node.type, [L, H]);
      } else {
        throw new Error('unknown rotate op');
      }
    } else if (isOp(node, 'xor', 'not', 'and', 'or', 'andnot')) {
      const widenArg = (i: number) => {
        const arg = args[i];
        const argType = as(fn.ops.get(arg.idx), 'op').type;
        if (argType === 'u32' && node.type === 'u64') return [arg, zero];
        if (argType === 'i32' && node.type === 'i64')
          return [arg, opS('shr', [arg, constOf(LT, 31)])];
        if (
          (argType === 'u64' || argType === 'i64') &&
          (node.type === 'u64' || node.type === 'i64')
        )
          return (fn.types as any)[argType].to(LT, arg);
        if (argType === node.type && (node.type === 'u64' || node.type === 'i64')) {
          const argNode = as(fn.ops.get(arg.idx), 'op');
          if (
            argNode.op === 'cast' &&
            (argNode.opts.from === 'u32' || argNode.opts.from === 'i32')
          ) {
            const src = fn.byIdx(argNode.args[0]);
            if (argNode.opts.from === 'u32') return [src, zero];
            return [src, opS('shr', [src, constOf(LT, 31)])];
          }
        }
        return;
      };
      const pairs = args.map((_i, j) => pairOf(j) || widenArg(j));
      if (pairs.some((p) => !p)) throw new Error('elemwiseVirtual: no split operands provided');
      const loType = getLowerType(node.type);
      if (!loType) throw new Error('elemwiseVirtual: no lower type for ' + node.type);
      const firstSplit = pairs.find(Boolean);
      if (!firstSplit) {
        console.error('lowerU64/no-split', fn.ops.format());
        throw new Error('elemwiseVirtual: no split operands provided');
      }
      const parts = firstSplit.length;
      for (const p of pairs)
        if (p && p.length !== parts) throw new Error('elemwiseVirtual: arity mismatch');
      const outParts: FnOp[] = new Array(parts);
      const opts = utils.deepClone(node.opts);
      for (let k = 0; k < parts; k++) {
        const ops: FnOp[] = new Array(args.length);
        for (let j = 0; j < args.length; j++) {
          const pj = pairs[j];
          ops[j] = pj ? pj[k] : args[j];
        }
        outParts[k] = markWide(fn.op(loType, node.op, ops, opts));
      }
      return virt(node.type, outParts);
    } else if (isOp(node, 'add')) {
      // Gather pairs
      const pairs = node.args.map((i, j) => {
        const p = pairOf(j) || widenArg(j, 'add');
        if (!p) {
          console.error('lowerU64', fn.ops.format());
          throw new Error('add: missing prev pair for arg ' + i);
        }
        return p;
      });
      if (pairs.some((p) => !p)) return;

      // Left fold: (H,L) += each (h,l), propagating carry every step
      let H: FnOp | null = null;
      let L: FnOp | null = null;
      for (const [l, h] of pairs) {
        if (H === null) {
          H = h;
          L = l;
          continue;
        }
        const sumL = opLT('add', [L!, l]); // low wraps mod 2^wordBits
        const carry = carryFromAdd(L!, l, sumL); // 0 or 1
        const sumH0 = opLT('add', [H!, h]);
        const sumH = opLT('add', [sumH0, carry]); // add carry into high
        L = sumL;
        H = sumH;
      }
      // Single-arg or empty add fallback (shouldn't happen, but be safe)
      if (H === null) {
        H = zero;
        L = zero;
      }
      return virt(node.type, [L!, H]);
    } else if (isOp(node, 'sub')) {
      const A = pairOf(0) || widenArg(0, 'arith');
      const B = pairOf(1) || widenArg(1, 'arith');
      if (!A || !B) throw new Error('sub: missing prev pair for args');
      const diffL = opLT('sub', [A[0], B[0]]);
      // borrow = ((~A.l & B.l) | (~(A.l ^ B.l) & diffL)) >>> 31
      const notA = opLT('xor', [A[0], neg1]);
      const axb = opLT('xor', [A[0], B[0]]);
      const notAxB = opLT('xor', [axb, neg1]);
      const t0 = opLT('and', [notA, B[0]]);
      const t1 = opLT('and', [notAxB, diffL]);
      const t = opLT('or', [t0, t1]);
      const borrow = cast(LT, opU('shr', [t, constOf(LT, wordBits - 1)])); // 0 or 1
      const diffH0 = opLT('sub', [A[1], B[1]]);
      const diffH = opLT('sub', [diffH0, borrow]);
      return virt(node.type, [diffL, diffH]);
    } else if (isOp(node, 'neg')) {
      const A = pairOf(0);
      if (!A) throw new Error('neg: missing prev pair for arg');
      const diffL = opLT('add', [opLT('xor', [A[0], neg1]), one]); // low: ~l + 1
      const carry = opLT('eqz', [A[0]]); // carry into high iff l == 0
      const diffH = opLT('add', [opLT('xor', [A[1], neg1]), carry]); // high: ~h + carry
      return virt(node.type, [diffL, diffH]);
    } else if (isOp(node, 'mul')) {
      // Gather pairs
      const pairs = node.args.map((i: string, j: number) => {
        const p = pairOf(j) || widenArg(j, 'arith');
        if (!p) {
          throw new Error('mul: missing prev pair for arg ' + i);
        }
        return p;
      });
      if (pairs.some((p) => !p)) return;

      // hi of (word * word) using 16-bit partials + carries (wordBits >= 32)
      const mulWordHi = (a: FnOp, b: FnOp): FnOp => {
        const MASK16 = constOf(LT, 0xffff);
        const S16 = constOf(LT, 16);

        const a0 = opLT('and', [a, MASK16]);
        const a1 = opU('shr', [a, S16]);
        const b0 = opLT('and', [b, MASK16]);
        const b1 = opU('shr', [b, S16]);

        const p0 = opLT('mul', [a0, b0]);
        const m1 = opLT('mul', [a1, b0]);
        const m2 = opLT('mul', [a0, b1]);
        const c = opLT('add', [m1, m2]);
        const cC = carryFromAdd(m1, m2, c);

        const cSh = opLT('shl', [c, S16]);
        const loSum = opLT('add', [p0, cSh]);
        const loC = carryFromAdd(p0, cSh, loSum);

        const hiBase = opLT('mul', [a1, b1]);
        const cHi = opU('shr', [c, S16]);
        const cHiFix = opLT('shl', [cC, S16]);

        return opLT('add', [hiBase, cHi, cHiFix, loC]);
      };

      const mulWide = (A: { h: FnOp; l: FnOp }, B: { h: FnOp; l: FnOp }) => {
        const lo0 = opLT('mul', [A.l, B.l]);
        const hi0 = mulWordHi(A.l, B.l);
        const x1 = opLT('mul', [A.l, B.h]);
        const x2 = opLT('mul', [A.h, B.l]);

        const H = opLT('add', [hi0, x1, x2]);
        const L = opLT('or', [lo0, zero]);
        return { h: H, l: L };
      };

      // Left-fold multiply across N args. Identity is 1.
      let H: FnOp, L: FnOp;
      if (pairs.length === 0) {
        H = zero;
        L = one;
      } else {
        H = pairs[0][1];
        L = pairs[0][0];
        for (let i = 1; i < pairs.length; i++) {
          const pair = pairs[i];
          if (true) {
            // TODO: this is stupid. we need some more generic with optimizer.
            const isZero = (op: any) => {
              const node = as(fn.ops.get(op.idx), 'op');
              if (node.op === 'const' && node.opts.value == 0) return true;
              if (node.op === 'and') {
                return node.args.map((i) => fn.byIdx(i)).some(isZero);
              }
              return;
            };
            // Special case for 32*32
            if (bits === 64 && isZero(pair[1]) && isZero(H)) {
              let a = pair[0];
              let b = L;
              // a,b: i32 (unsigned semantics)
              const mask16 = constOf(LT, 0xffff);
              const s16 = constOf(LT, 16);
              // 16-bit halves
              const aL = opLT('and', [a, mask16]);
              const bL = opLT('and', [b, mask16]);
              const aH = opU('shr', [a, s16]);
              const bH = opU('shr', [b, s16]);
              // 4 partials (minimal)
              const ll = opLT('mul', [aL, bL]);
              const hl = opLT('mul', [aH, bL]);
              const lh = opLT('mul', [aL, bH]);
              const hh = opLT('mul', [aH, bH]);
              // split once, reuse
              const ll_lo = opLT('and', [ll, mask16]);
              const ll_hi = opU('shr', [ll, s16]);
              const hl_lo = opLT('and', [hl, mask16]);
              const hl_hi = opU('shr', [hl, s16]);
              // carry over the middle 16s
              const carry = opLT('add', [ll_hi, hl_lo, lh]);
              // low and high 32
              const low = opLT('or', [opLT('shl', [carry, s16]), ll_lo]);
              const high = opLT('add', [hh, hl_hi, opU('shr', [carry, s16])]);
              H = high;
              L = low;
              continue;
            }
          }
          const r = mulWide({ h: H, l: L }, { h: pair[1], l: pair[0] });
          H = r.h;
          L = r.l;
        }
      }
      return virt(node.type, [L, H]);
    } else if (isOp(node, 'select')) {
      const h = opLT('select', [prev[0]![1], prev[1]![1], args[2]]);
      const l = opLT('select', [prev[0]![0], prev[1]![0], args[2]]);
      return virt(node.type, [l, h]);
    } else if (bits === 64 && isOp(node, 'extend_i32_u')) {
      const h = constOf(LT, 0);
      const l = args[0];
      return virt(node.type, [l, h]);
    } else if (bits === 64 && isOp(node, 'extend_i32_s')) {
      const l = args[0];
      const h = opS('shr', [l, constOf(LT, 31)]);
      return virt(node.type, [l, h]);
    } else if (
      bits === 64 &&
      isOp(node, 'trunc_f32_s', 'trunc_f32_u', 'trunc_f64_s', 'trunc_f64_u')
    ) {
      const isF32 = node.op.includes('f32');
      const isSigned = node.op.endsWith('_s');
      let val = args[0];
      if (isF32) val = fn.op('f64', 'promote_f32', [val]);
      val = fn.op('f64', 'trunc', [val]);
      // hi = floor(val / 2^32) - floor for correct negative handling
      const { f64 } = fn.types;
      const scale = f64.const(2 ** 32);
      const divided = f64.div(val, scale);
      const hiF = f64.floor(divided);
      const hi = fn.op('i32', isSigned ? 'trunc_f64_s' : 'trunc_f64_u', [hiF]);
      // lo = val - hiF * 2^32 (always unsigned)
      const hiScaled = f64.mul(hiF, scale);
      const remainder = f64.sub(val, hiScaled);
      const lo = fn.op('i32', 'trunc_f64_u', [remainder]);
      return virt(node.type, [lo, hi]);
    } else if (isOp(node, 'clz')) {
      const lo = prev[0]![0],
        hi = prev[0]![1];
      const hiZero = opLT('eqz', [hi]);
      const clzHi = opLT('clz', [hi]);
      const clzLo = opLT('add', [constOf(LT, wordBits), opLT('clz', [lo])]);
      const res = opLT('select', [clzLo, clzHi, hiZero]);
      return virt(node.type, [res, zero]);
    } else if (isOp(node, 'ctz')) {
      const lo = prev[0]![0],
        hi = prev[0]![1];
      const loZero = opLT('eqz', [lo]);
      const ctzLo = opLT('ctz', [lo]);
      const ctzHi = opLT('add', [constOf(LT, wordBits), opLT('ctz', [hi])]);
      const res = opLT('select', [ctzHi, ctzLo, loZero]);
      return virt(node.type, [res, zero]);
    } else if (isOp(node, 'popcnt')) {
      const lo = prev[0]![0],
        hi = prev[0]![1];
      const res = opLT('add', [opLT('popcnt', [lo]), opLT('popcnt', [hi])]);
      return virt(node.type, [res, zero]);
    } else if (isOp(node, 'abs')) {
      const [l, h] = prev[0]!;
      const mask = opS('shr', [h, constOf(LT, wordBits - 1)]); // sign extend
      const xorL = opLT('xor', [l, mask]);
      const xorH = opLT('xor', [h, mask]);
      const negMask = opLT('sub', [zero, mask]); // 0 or 1
      const sumL = opLT('add', [xorL, negMask]);
      const carry = opLT('and', [negMask, opLT('eqz', [l])]);
      const sumH = opLT('add', [xorH, carry]);
      return virt(node.type, [sumL, sumH]);
    } else if (isOp(node, 'min', 'max')) {
      const isMax = node.op === 'max';
      const signedCmp = node.type.startsWith('i');
      let result = prev[0]!;
      for (let i = 1; i < prev.length; i++) {
        const other = prev[i]!;
        const [aLo, aHi] = result;
        const [bLo, bHi] = other;
        // Compare hi parts (signed or unsigned based on type)
        const hiLt = signedCmp ? opS('lt', [aHi, bHi]) : opU('lt', [aHi, bHi]);
        const hiEq = opLT('eq', [aHi, bHi]);
        // Compare lo parts (always unsigned)
        const loLt = opU('lt', [aLo, bLo]);
        // a < b: (hi_a < hi_b) || (hi_a == hi_b && lo_a < lo_b)
        const aLtB = opB('or', [hiLt, opB('and', [hiEq, loLt])]);
        // min: pick a if a < b, else b
        // max: pick b if a < b, else a
        const resLo = isMax ? opLT('select', [bLo, aLo, aLtB]) : opLT('select', [aLo, bLo, aLtB]);
        const resHi = isMax ? opLT('select', [bHi, aHi, aLtB]) : opLT('select', [aHi, bHi, aLtB]);
        result = [resLo, resHi];
      }
      return virt(node.type, result);
    } else if (
      isOp(node, 'eqz', 'eq', 'ne', 'lt', 'gt', 'le', 'ge') &&
      (node.type === `i${bits}` || node.type === `u${bits}`)
    ) {
      const isSigned = node.type.startsWith('i');
      // helpers
      const lt64 = (Ah: FnOp, Al: FnOp, Bh: FnOp, Bl: FnOp): FnOp => {
        const hiLT = isSigned ? opS('lt', [Ah, Bh]) : opU('lt', [Ah, Bh]);
        const hiEQ = opLT('eq', [Ah, Bh]);
        const loLT = opU('lt', [Al, Bl]);
        return opB('or', [hiLT, opB('and', [hiEQ, loLT])]); // a<b
      };
      if (node.op === 'eqz') {
        const a = pairOf(0);
        if (!a) throw new Error('eqz64: missing prev pair for arg0');
        // Keep the operand width so another wide-lowering pass can split 128/256-bit comparisons.
        return opLT('eq', [opLT('or', [a[1], a[0]]), zero]);
      } else {
        const a = pairOf(0),
          b = pairOf(1);
        if (!a || !b) throw new Error(node.op + '64: missing prev pair(s)');
        if (node.op === 'eq') {
          return opB('and', [opLT('eq', [a[1], b[1]]), opLT('eq', [a[0], b[0]])]);
        } else if (node.op === 'ne') {
          // ne = !eq
          const both = opB('and', [opLT('eq', [a[1], b[1]]), opLT('eq', [a[0], b[0]])]);
          return opB('eqz', [both]);
        } else if (node.op === 'lt') {
          return lt64(a[1], a[0], b[1], b[0]);
        } else if (node.op === 'gt') {
          return lt64(b[1], b[0], a[1], a[0]); // b<a
        } else if (node.op === 'le') {
          return opB('eqz', [lt64(b[1], b[0], a[1], a[0])]); // !(b<a)
        } else if (node.op === 'ge') {
          return opB('eqz', [lt64(a[1], a[0], b[1], b[0])]); // !(a<b)
        } else throw 'lowerU64/comparisons: not implemented: ' + node.op;
      }
    } else if (isOp(node, 'div', 'rem')) {
      // UB: callers must ensure integer div/rem operands are valid. Adding traps here
      // needs an execution-model decision for corrupted state, batch functions, and threads.
      const a = pairOf(0),
        b = pairOf(1);
      if (!a || !b) throw new Error(node.op + '64: missing prev pair(s)');
      const Ah = a[1],
        Al = a[0],
        Bh = b[1],
        Bl = b[0];

      const Z = zero,
        ONE = one,
        NEG1 = neg1;

      // (unsigned) 64-bit < and >=
      const lt64u = (Ah: FnOp, Al: FnOp, Bh: FnOp, Bl: FnOp) =>
        opB('or', [opU('lt', [Ah, Bh]), opB('and', [opLT('eq', [Ah, Bh]), opU('lt', [Al, Bl])])]);
      const ge64u = (Ah: FnOp, Al: FnOp, Bh: FnOp, Bl: FnOp) =>
        toLT(opB('eqz', [lt64u(Ah, Al, Bh, Bl)]));

      // R = (R<<1) | bit
      const shl1_with_bit = (Rh: FnOp, Rl: FnOp, bit: FnOp) => ({
        h: opLT('or', [opLT('shl', [Rh, ONE]), opU('shr', [Rl, constOf(LT, wordBits - 1)])]),
        l: opLT('or', [opLT('shl', [Rl, ONE]), opLT('and', [bit, ONE])]),
      });

      // conditional two's-complement negate with mask m∈{0,-1}
      const neg64_mask = (H: FnOp, L: FnOp, m: FnOp) => {
        const Lx = opLT('xor', [L, m]),
          Hx = opLT('xor', [H, m]);
        const inc = opLT('and', [m, ONE]);
        const sL = opLT('add', [Lx, inc]);
        const carry = opU('lt', [sL, Lx]);
        const sH = opLT('add', [Hx, carry]);
        return { h: sH, l: sL };
      };

      // Unsigned 64-bit division with remainder via 64-step restoring division
      const udivrem64 = (Ah: FnOp, Al: FnOp, Bh: FnOp, Bl: FnOp) => {
        let Qh = Z,
          Ql = Z,
          Rh = Z,
          Rl = Z;
        for (let i = bits - 1; i >= 0; i--) {
          const bit =
            i >= wordBits
              ? opLT('and', [opU('shr', [Ah, constOf(LT, i - wordBits)]), ONE])
              : opLT('and', [opU('shr', [Al, constOf(LT, i)]), ONE]);

          ({ h: Rh, l: Rl } = shl1_with_bit(Rh, Rl, bit));

          const ge = ge64u(Rh, Rl, Bh, Bl); // 0 or 1 in LT
          const m = opLT('neg', [ge]); // 0 or -1 in LT
          const Blm = opLT('and', [Bl, m]),
            Bhm = opLT('and', [Bh, m]);

          const borrow = opU('lt', [Rl, Blm]);
          const nL = opLT('sub', [Rl, Blm]);
          const nH = opLT('sub', [opLT('sub', [Rh, Bhm]), borrow]);
          Rh = nH;
          Rl = nL;

          if (i >= wordBits) Qh = opLT('or', [Qh, opLT('shl', [ge, constOf(LT, i - wordBits)])]);
          else Ql = opLT('or', [Ql, opLT('shl', [ge, constOf(LT, i)])]);
        }
        return { qh: Qh, ql: Ql, rh: Rh, rl: Rl };
      };

      // Signed wrapper: quotient sign = aNeg^bNeg, remainder sign = aNeg
      const sdivrem64 = (Ah: FnOp, Al: FnOp, Bh: FnOp, Bl: FnOp) => {
        const aNeg = opS('lt', [Ah, Z]),
          bNeg = opS('lt', [Bh, Z]);
        const aMask = opLT('mul', [aNeg, NEG1]),
          bMask = opLT('mul', [bNeg, NEG1]);
        const Aabs = neg64_mask(Ah, Al, aMask);
        const Babs = neg64_mask(Bh, Bl, bMask);
        const { qh, ql, rh, rl } = udivrem64(Aabs.h, Aabs.l, Babs.h, Babs.l);
        const qMask = opLT('mul', [opLT('xor', [aNeg, bNeg]), NEG1]);
        const Q = neg64_mask(qh, ql, qMask);
        const R = neg64_mask(rh, rl, aMask);
        return { qh: Q.h, ql: Q.l, rh: R.h, rl: R.l };
      };
      const { qh, ql, rh, rl } = isSigned ? sdivrem64(Ah, Al, Bh, Bl) : udivrem64(Ah, Al, Bh, Bl);
      if (node.op === 'div') {
        return virt(node.type, [ql, qh]);
      } else if (node.op === 'rem') {
        return virt(node.type, [rl, rh]);
      } else throw new Error('unreachable div/rem variant');
    } else if (isOp(node, 'pattern')) {
      // Most basic lowering: build two 32-bit patterns.
      // Allowed: each 32-bit output half comes entirely from either low(0..3) or high(4..7) input bytes.
      // Disallowed: mixing bytes from both halves within the same 32-bit output (would need extra nodes).
      if (node.args.length !== 1) throw new Error('u64.pattern: multiple args not supported');
      const pat: number[] = node.opts.pattern;
      if (!Array.isArray(pat) || pat.length !== wordBytes * 2)
        throw new Error('u64.pattern: need pattern');
      const A = prev[0];
      if (!A) throw new Error('u64.pattern: missing prev pair');
      const mkHalf = (start: number) => {
        const seg = pat.slice(start, start + wordBytes);
        const fromL = seg.every((b) => b >= 0 && b < wordBytes);
        const fromH = seg.every((b) => b >= wordBytes && b < wordBytes * 2);
        if (!fromL && !fromH) throw new Error('pattern: cross-half mixing not supported');
        const local = seg.map((b) => (fromH ? b - wordBytes : b));
        const src = fromH ? A[1] : A[0];
        return fn.op(lowType, 'pattern', [src], { pattern: local });
      };

      const Lp = mkHalf(0);
      const Hp = mkHalf(wordBytes);
      return fn.op(node.type, 'virtual', [Lp, Hp]);
    } else if (bits === 64 && isOp(node, 'reinterpret_f64')) {
      const L = fn.op(lowType, 'reinterpret_f64_low', args);
      const H = fn.op(lowType, 'reinterpret_f64_high', args);
      return fn.op(node.type, 'virtual', [L, H]);
    } else if (isOp(node, 'cast')) {
      const A = pairOf(0);
      if (!A) throw new Error('u64.cast: missing prev pair');
      return virt(node.type, A);
    } else {
      console.error('lowerU64/OPS', fn.ops.format());
      console.error('lowerU64/NODE', node);
      throw new Error('not implemented');
    }
    return;
  };
}
/**
 * Lowers `u64` and `i64` operations into two 32-bit parts.
 *
 * @param fn - Function graph whose nodes may be lowered.
 * @param opts - Compiler options. {@link CompilerOpts}
 * @returns Rewrite callback for `TreeDAG.rewrite`.
 * @throws If wide-integer lowering sees an unsupported node shape. {@link Error}
 * @example
 * ```js
 * import { Module } from '@awasm/compiler/module.js';
 * import { ModuleGraph } from '@awasm/compiler/codegen.js';
 * import { lowerU64 } from '@awasm/compiler/rewrites.js';
 *
 * lowerU64(new ModuleGraph('demo', {}, new Module('demo'), {}));
 * ```
 */
export function lowerU64(fn: ModuleGraph, opts: CompilerOpts = {}): Rewrite {
  return lowerWideInt(fn, opts, 64);
}
/**
 * Creates the basic constant-folding optimizer rewrite.
 *
 * @param fn - Function graph whose nodes may be optimized.
 * @param opts - Compiler options. {@link CompilerOpts}
 * @returns Rewrite callback for `TreeDAG.rewrite`.
 * @example
 * ```js
 * import { Module } from '@awasm/compiler/module.js';
 * import { ModuleGraph } from '@awasm/compiler/codegen.js';
 * import { optimize } from '@awasm/compiler/rewrites.js';
 *
 * optimize(new ModuleGraph('demo', {}, new Module('demo'), {}));
 * ```
 */
export function optimize(fn: ModuleGraph, opts: CompilerOpts = {}): Rewrite {
  const runtimeTypes = types.genRuntimeTypes();
  const isConst = (arg: FnOp) => {
    const node = fn.ops.get(arg.idx);
    return node.kind === 'op' && node.op === 'const';
  };
  const getConst = (arg: FnOp) => {
    const { idx } = arg;
    const node = fn.ops.get(idx);
    if (!node) throw new Error('getConst: no node');
    if (node.kind !== 'op' || node.op !== 'const') throw new Error('getConst: not const');
    return node.opts.value;
  };
  const getFact = (arg: FnOp) => {
    const node = fn.ops.get(arg.idx);
    return node.kind === 'op' ? node.fact : undefined;
  };
  const fullMask = (type: TypeName) => (_1n << BigInt(types.sizeof(type) * 8)) - _1n;
  const isBoolFact = (arg: FnOp) => {
    const range = getFact(arg)?.range;
    return !!range && range.min >= _0n && range.max <= _1n;
  };
  const isLowMask = (mask: bigint) => mask >= _0n && (mask & (mask + _1n)) === _0n;
  const maskCovers = (arg: FnOp, mask: bigint, cleared: bigint) => {
    const fact = getFact(arg);
    const bits = fact?.bits;
    if (bits && (bits.known & ~bits.value & cleared) === cleared) return true;
    if (!isLowMask(mask)) return false;
    const range = fact?.range;
    if (range && range.min >= _0n && range.max <= mask) return true;
    const node = opNode(arg);
    if (
      !node ||
      !isOp(node, 'div', 'rem') ||
      types.SignedType.has(node.type) ||
      !types.ScalarType.has(node.type)
    )
      return false;
    // Keep the trapping op in place: zero divisors still trap before the removed mask would run.
    const left = getFact(fn.byIdx(node.args[0]))?.range;
    if (left && left.min >= _0n && left.max <= mask) return true;
    const right = getFact(fn.byIdx(node.args[1]))?.range;
    return node.op === 'rem' && !!right && right.max > _0n && right.max - _1n <= mask;
  };
  const opNode = (arg: FnOp) => {
    const node = fn.ops.get(arg.idx);
    return node.kind === 'op' ? node : undefined;
  };
  const isConstValue = (arg: FnOp, value: number | bigint) =>
    isConst(arg) && BigInt(getConst(arg)) === BigInt(value);
  const constLike = (arg: FnOp) => {
    if (isConst(arg)) return BigInt(getConst(arg));
    const fact = getFact(arg);
    const type = types.normType(types.nodeRetType(fn, arg)) as TypeName;
    if (fact?.bits && fact.bits.known === fullMask(type)) return fact.bits.value;
    return;
  };
  const constOfBits = (type: TypeName, value: bigint) => {
    const width = types.sizeof(type) * 8;
    const raw = types.SignedType.has(type)
      ? BigInt.asIntN(width, value)
      : BigInt.asUintN(width, value);
    return (fn.types as any)[type].const(raw);
  };
  const foldBigIntConst = (node: Extract<Node, { kind: 'op' }>, args: FnOp[]) => {
    const width = types.sizeof(node.type) * 8;
    const vals = args.map((arg) => BigInt(getConst(arg)));
    const wrap = (value: bigint) => constOfBits(node.type, value);
    // Exact facts already fold literal comparisons, bitwise ops, shifts, and rotates.
    // Keep arithmetic whose wrapping/signed/division behavior facts do not fully represent.
    if (isOp(node, 'add')) return wrap(vals.reduce((acc, value) => acc + value, _0n));
    if (isOp(node, 'mul')) return wrap(vals.reduce((acc, value) => acc * value, _1n));
    const int = types.SignedType.has(node.type) ? BigInt.asIntN : BigInt.asUintN;
    if (isOp(node, 'sub')) return wrap(int(width, vals[0]) - int(width, vals[1]));
    if (isOp(node, 'div', 'rem')) {
      const b = int(width, vals[1]);
      if (b === _0n) return;
      const a = int(width, vals[0]);
      return wrap(node.op === 'div' ? a / b : a % b);
    }
    return;
  };
  const truthy32 = (arg: FnOp) => {
    const node = opNode(arg);
    if (!node) return;
    if (node.op === 'ne' && ['i32', 'u32'].includes(node.type)) {
      const args = node.args.map((idx) => fn.byIdx(idx));
      if (isConst(args[0]) && getConst(args[0]) == 0) return args[1];
      if (isConst(args[1]) && getConst(args[1]) == 0) return args[0];
    }
    if (node.op !== 'eqz') return;
    const inner = opNode(fn.byIdx(node.args[0]));
    if (!inner || inner.op !== 'eqz') return;
    const value = fn.byIdx(inner.args[0]);
    const type = `${types.normType(types.nodeRetType(fn, value))}`;
    if (type === 'i32' || type === 'u32') return value;
    return;
  };
  let selectDepsVersion = -1;
  let selectDeps = new WeakMap<object, boolean>();
  const dependsOnSelect = (arg: FnOp, seen = new Set<object>()): boolean => {
    if (selectDepsVersion !== fn.ops.version) {
      selectDepsVersion = fn.ops.version;
      selectDeps = new WeakMap();
    }
    const node = opNode(arg);
    if (!node) return false;
    const cached = selectDeps.get(node);
    if (cached !== undefined) return cached;
    if (seen.has(node)) return false;
    seen.add(node);
    let res = false;
    if (node.op === 'select') res = true;
    else if (!isOp(node, 'arg', 'const', 'load', 'store', 'call', 'fill', 'copy', 'br', 'br_if')) {
      // Profiled Noble target builds spend most optimizer time re-walking this predicate.
      // The graph version keeps the cache local to a stable rewrite snapshot.
      res = node.args.some((idx) => dependsOnSelect(fn.byIdx(idx), seen));
    }
    seen.delete(node);
    selectDeps.set(node, res);
    return res;
  };
  const zeroFact = (arg: FnOp) => {
    const fact = getFact(arg);
    // Facts describe the logical pseudo-type before BigInt lowering, so keep its full width here.
    const type = types.nodeRetType(fn, arg);
    const bits = fact?.bits;
    if (bits) {
      if (bits.known === fullMask(type) && bits.value === _0n) return true;
      if ((bits.known & bits.value) !== _0n) return false;
    }
    const range = fact?.range;
    if (range) {
      if (range.min === _0n && range.max === _0n) return true;
      if (range.min > _0n || range.max < _0n) return false;
    }
    return;
  };
  const cmpRange = (
    op: string,
    a: { min: bigint; max: bigint },
    b: { min: bigint; max: bigint }
  ) => {
    if (op === 'eq' || op === 'ne') {
      const disjoint = a.max < b.min || b.max < a.min;
      const exact = a.min === a.max && b.min === b.max && a.min === b.min;
      const res = disjoint ? false : exact ? true : undefined;
      return op === 'ne' && res !== undefined ? !res : res;
    }
    if (op === 'gt' || op === 'ge') return cmpRange(op === 'gt' ? 'lt' : 'le', b, a);
    if (op === 'lt') return a.max < b.min ? true : a.min >= b.max ? false : undefined;
    if (op === 'le') return a.max <= b.min ? true : a.min > b.max ? false : undefined;
    return;
  };
  const knownCmp = (op: string, type: TypeName, a: FnOp, b: FnOp) => {
    if (op === 'eq' || op === 'ne') {
      const ab = getFact(a)?.bits;
      const bb = getFact(b)?.bits;
      if (ab && bb) {
        const mask = fullMask(type);
        const known = ab.known & bb.known & mask;
        if (((ab.value ^ bb.value) & known) !== _0n) return op === 'ne';
        if ((ab.known & mask) === mask && (bb.known & mask) === mask) return op === 'eq';
      }
    }
    const ar = getFact(a)?.range;
    const br = getFact(b)?.range;
    return ar && br ? cmpRange(op, ar, br) : undefined;
  };
  const boolConstCmp = (node: Node, args: FnOp[]) => {
    if (!isOp(node, 'eq', 'ne') || args.length !== 2) return;
    if (!types.IntType.has(node.type) || !types.ScalarType.has(node.type)) return;
    const leftConst = isConst(args[0]);
    const rightConst = isConst(args[1]);
    if (leftConst === rightConst) return;
    const raw = getConst(leftConst ? args[0] : args[1]);
    // SIMD constants are byte arrays; this fold is only for scalar numeric boolean compares.
    if (typeof raw !== 'number' && typeof raw !== 'bigint') return;
    if (typeof raw === 'number' && !Number.isInteger(raw)) return;
    const value = BigInt(raw);
    if (value !== _0n && value !== _1n) return;
    const arg = leftConst ? args[1] : args[0];
    if (!isBoolFact(arg)) return;
    const type = types.normType(types.nodeRetType(fn, arg));
    const T = (fn.types as any)[type];
    const same = node.op === 'eq' ? value === _1n : value === _0n;
    return same ? arg : T.eqz(arg);
  };
  const foldMemoryOffset = (node: Node, args: FnOp[]) => {
    if (!isOp(node, 'load', 'store')) return;
    const addr = opNode(args[0]);
    if (!addr || addr.op !== 'add' || addr.type !== 'u32') return;
    const baseArgs = [];
    let offset = BigInt(node.opts.offset || 0);
    let max = _0n;
    let hasConst = false;
    for (const idx of addr.args) {
      const arg = fn.byIdx(idx);
      if (isConst(arg)) {
        const c = BigInt(getConst(arg));
        if (c < _0n) return;
        offset += c;
        hasConst = true;
        continue;
      }
      const range = getFact(arg)?.range;
      if (!range || range.min < _0n) return;
      max += range.max;
      baseArgs.push(arg);
    }
    const limit = fullMask('u32');
    if (!hasConst || offset > limit || max + offset > limit) return;
    const base =
      baseArgs.length === 0
        ? fn.types.u32.const(0)
        : baseArgs.length === 1
          ? baseArgs[0]
          : fn.op('u32', 'add', baseArgs);
    const opts = { ...node.opts, offset: Number(offset) };
    if (node.op === 'load') return fn.op(node.type, 'load', [base], opts);
    return fn.op(node.type, 'store', [base, args[1]], opts);
  };
  const isPow2 = (n: bigint): boolean => n > _0n && (n & (n - _1n)) === _0n;
  const ctzBig = (n: bigint) => {
    let k = 0;
    for (; (n & _1n) === _0n; k++, n >>= _1n);
    return k;
  };
  const signedRange = (type: TypeName, shift: bigint) => {
    const w = BigInt(types.sizeof(type) * 8);
    const bits = w - shift;
    return { min: -(_1n << (bits - _1n)), max: (_1n << (bits - _1n)) - _1n };
  };
  const signExtendParts = (node: Node, args: FnOp[]) => {
    if (!isOp(node, 'shr') || !types.SignedType.has(node.type) || !types.ScalarType.has(node.type))
      return;
    const right = constLike(args[1]);
    if (right === undefined) return;
    const src = opNode(args[0]);
    if (!src || src.op !== 'shl' || src.type !== node.type) return;
    const left = constLike(fn.byIdx(src.args[1]));
    if (left === undefined) return;
    const w = BigInt(types.sizeof(node.type) * 8);
    const mask = w - _1n;
    const shift = right & mask;
    if (shift === _0n || (left & mask) !== shift) return;
    return { value: fn.byIdx(src.args[0]), shift, type: node.type };
  };
  const signExtendArg = (arg: FnOp) => {
    const node = opNode(arg);
    if (!node) return;
    return signExtendParts(
      node,
      node.args.map((idx) => fn.byIdx(idx))
    );
  };
  const foldSignExtend = (node: Node, args: FnOp[]) => {
    const parts = signExtendParts(node, args);
    if (!parts) return;
    const range = getFact(parts.value)?.range;
    const signed = signedRange(parts.type, parts.shift);
    if (range && range.min >= signed.min && range.max <= signed.max) return parts.value;
    return;
  };
  const foldShiftMask = (node: Node, args: FnOp[]) => {
    if (!isOp(node, 'shl') || !types.IntType.has(node.type) || !types.ScalarType.has(node.type))
      return;
    const shift = constLike(args[1]);
    if (shift === undefined) return;
    const width = BigInt(types.sizeof(node.type) * 8);
    const s = shift & (width - _1n);
    if (s === _0n) return;
    const src = opNode(args[0]);
    if (!src || src.op !== 'and' || src.type !== node.type) return;
    // A left shift discards high source bits; masks that only clear those bits are dead.
    const needed = (_1n << (width - s)) - _1n;
    let changed = false;
    const keep = [];
    for (const idx of src.args) {
      const arg = fn.byIdx(idx);
      if (!isConst(arg)) {
        keep.push(arg);
        continue;
      }
      const mask = BigInt(getConst(arg)) & fullMask(node.type);
      if ((mask & needed) === needed) {
        changed = true;
        continue;
      }
      keep.push(arg);
    }
    if (!changed || keep.length === 0) return;
    const value = keep.length === 1 ? keep[0] : fn.op(node.type, 'and', keep);
    return fn.op(node.type, 'shl', [value, args[1]], node.opts);
  };
  return (node, args, _idx) => {
    if (node.kind !== 'op') return;
    const mem = foldMemoryOffset(node, args);
    if (mem) return mem;
    const sign = foldSignExtend(node, args);
    if (sign) return sign;
    const shift = foldShiftMask(node, args);
    if (shift) return shift;
    if (isOp(node, 'br_if')) {
      const cond = truthy32(args[args.length - 1]);
      if (cond) return fn.op(node.type, node.op, [...args.slice(0, -1), cond], node.opts);
    }
    if (isOp(node, 'select')) {
      const cond = truthy32(args[2]);
      if (cond) return fn.op(node.type, node.op, [args[0], args[1], cond], node.opts);
    }
    if (isOp(node, 'load', 'store', 'const', 'arg', 'fill', 'copy', 'call', 'br_if', 'br')) return;
    if (isOp(node, 'virtualPairs', 'virtualPairsArg', 'virtualMask')) return;
    if (node.op.includes('atomic')) return;
    const allBigConst = types.BigIntScalarType.has(node.type) && args.every(isConst);
    const rawType = types.nodeRetType(fn, fn.byIdx(_idx));
    const rawBig = types.BigIntType.has(rawType);
    // Big-int pseudo-types cannot be normalized; only literal constants use their raw type here.
    const retType = (rawBig ? rawType : types.normType(rawType)) as TypeName;
    if (
      types.IntType.has(retType) &&
      types.ScalarType.has(retType) &&
      (!rawBig || allBigConst) &&
      !dependsOnSelect(fn.byIdx(_idx))
    ) {
      const bits = node.fact?.bits;
      const mask = fullMask(retType);
      if (bits && (bits.known & mask) === mask) return constOfBits(retType, bits.value & mask);
    }
    if (
      isOp(node, 'eq', 'ne', 'lt', 'gt', 'le', 'ge') &&
      types.IntType.has(node.type) &&
      types.ScalarType.has(node.type)
    ) {
      const known =
        dependsOnSelect(args[0]) || dependsOnSelect(args[1])
          ? undefined
          : knownCmp(node.op, node.type, args[0], args[1]);
      if (known !== undefined) return (fn.types as any)[types.maskType(node.type)].const(+known);
    }
    const boolCmp = boolConstCmp(node, args);
    if (boolCmp) return boolCmp;
    if (
      isOp(node, 'eqz') &&
      types.IntType.has(node.type) &&
      types.ScalarType.has(node.type) &&
      !dependsOnSelect(args[0])
    ) {
      // Fact-based eqz folding can erase producer evaluation; keep data selects visible for constant-time shapes.
      const zero = zeroFact(args[0]);
      if (zero !== undefined) return (fn.types as any)[types.maskType(node.type)].const(+zero);
    }
    if (types.BigIntType.has(node.type))
      return allBigConst ? foldBigIntConst(node, args) : undefined;
    const T = (fn.types as any)[node.type];
    if (
      isOp(node, 'select') &&
      (node.type === 'i32' || node.type === 'u32') &&
      ['i32', 'u32'].includes(`${types.normType(types.nodeRetType(fn, args[2]))}`)
    ) {
      const C = (fn.types as any)[types.normType(types.nodeRetType(fn, args[2]))];
      if (isConstValue(args[0], 1) && isConstValue(args[1], 0)) {
        if (isBoolFact(args[2])) return args[2];
        return C.ne(args[2], C.const(0));
      }
      if (isConstValue(args[0], 0) && isConstValue(args[1], 1)) return C.eqz(args[2]);
    }
    if (isOp(node, 'eq') && types.IntType.has(node.type) && types.ScalarType.has(node.type)) {
      if (isConst(args[0]) && getConst(args[0]) == 0) return T.eqz(args[1]);
      if (isConst(args[1]) && getConst(args[1]) == 0) return T.eqz(args[0]);
    }
    if (isOp(node, 'eqz') && types.IntType.has(node.type) && types.ScalarType.has(node.type)) {
      const inner = opNode(args[0]);
      if (inner?.op === 'eqz') {
        const value = fn.byIdx(inner.args[0]);
        if (isBoolFact(value)) return value;
      }
    }
    if (node.op === 'swizzle' && isConst(args[1]) && types.sizeof(node.type) === 16) {
      const maskBytes = getConst(args[1]) as Uint8Array;
      if (maskBytes.length === 16 && maskBytes.every((i) => i >= 0 && i < 16)) {
        return fn.op(node.type, 'shuffle', [args[0], args[0]], { pattern: Array.from(maskBytes) });
      }
    }

    const exec = (args: FnOp[]) => {
      node = as(node, 'op');
      if (!args.every(isConst)) throw new Error('exec: not all constants');
      if (node.op === 'shuffle') {
        const bytes = P.utils.concatBytes(...args.map(getConst).map((i) => i));
        const value = Uint8Array.from(node.opts.pattern.map((i: number) => bytes[i]));
        return fn.op(node.type, 'const', [], { value });
      }
      if (node.op === 'swizzle') {
        const bytes = getConst(args[0]) as Uint8Array;
        const maskBytes = getConst(args[1]) as Uint8Array;
        const out = new Uint8Array(bytes.length);
        for (let i = 0; i < out.length; i++) {
          const m = maskBytes[i % 16];
          if (m >= 16) continue;
          const src = Math.floor(i / 16) * 16 + m;
          if (src < bytes.length) out[i] = bytes[src];
        }
        return fn.op(node.type, 'const', [], { value: out });
      }
      if (node.op === 'splat') return T.const(getConst(args[0]));
      if (node.op === 'replace_lane' || node.op === 'extract_lane') {
        const C = types.TypeCoders[node.type];
        const vec = C.decode(getConst(args[0]));
        if (node.op === 'replace_lane') {
          const value = getConst(args[1]);
          vec[node.opts.lane] = value;
          return fn.op(node.type, 'const', [], { value: C.encode(vec) });
        } else if (node.op === 'extract_lane') {
          return fn.op(types.ScalarOf(node.type), 'const', [], { value: vec[node.opts.lane] });
        } else throw new Error('not implemented');
      }
      const typeOps = runtimeTypes[node.type];
      if (!typeOps || !typeOps[node.op]) return;
      let value = typeOps[node.op](...args.map(getConst));
      // wasm returns signed versions
      if (node.type === 'u32') value = types.i32ToU32(value);
      if (node.type === 'u64') value = types.i64ToU64(value);
      if (types.SIMDType.has(node.type)) {
        return fn.op(node.type, 'const', [], { value });
      }
      return fn.types[node.type].const(value);
    };
    // all args constant
    const noExec: string[] = [];
    if (args.every(isConst) && !noExec.includes(node.op)) return exec(args);
    if (isOp(node, 'shl', 'shr', 'rotl', 'rotr') && args.length === 2 && isConst(args[1])) {
      // Constant-aware n-grams exposed zero shifts after variadic neutral folding had already run.
      if (getConst(args[1]) == 0) return args[0];
    }
    if (
      isOp(node, 'div', 'rem') &&
      types.IntType.has(node.type) &&
      types.ScalarType.has(node.type) &&
      args.length === 2 &&
      isConst(args[1])
    ) {
      // div/rem are not variadic, so they need their own constant-right operand fold.
      const c = BigInt(getConst(args[1]));
      if (c === _1n) return node.op === 'div' ? args[0] : T.const(0);
      if (!types.SignedType.has(node.type) && isPow2(c)) {
        const k = ctzBig(c);
        if (node.op === 'div') return T.shr(args[0], k);
        return T.and(args[0], constOfBits(node.type, c - _1n));
      }
    }
    if (isOp(node, 'and') && types.IntType.has(node.type) && types.ScalarType.has(node.type)) {
      const full = fullMask(node.type);
      for (let i = 0; i < args.length; i++) {
        if (!isConst(args[i])) continue;
        const mask = BigInt(getConst(args[i])) & full;
        const cleared = full & ~mask;
        if (cleared === _0n) continue;
        if (isLowMask(mask)) {
          let changed = false;
          const mapped = args.map((arg, j) => {
            if (i === j) return arg;
            const sx = signExtendArg(arg);
            if (!sx) return arg;
            const srcMask = (_1n << (BigInt(types.sizeof(sx.type) * 8) - sx.shift)) - _1n;
            if (mask > srcMask) return arg;
            changed = true;
            return sx.value;
          });
          if (changed) return fn.op(node.type, 'and', mapped);
        }
        // Value facts let us remove masks even when a local/tee separates producer and consumer.
        if (!args.some((arg, j) => i !== j && maskCovers(arg, mask, cleared))) continue;
        const keep = args.filter((_arg, j) => i !== j);
        if (keep.length === 1) return keep[0];
        return fn.op(node.type, 'and', keep);
      }
    }
    // extmul instead of mul when possible
    if (node.op === 'mul' && ['u64x2', 'i64x2'].includes(node.type) && opts.optExtMul) {
      const T = fn.types[node.type] as GetOpsFnOp<any>;
      const coder = types.TypeCoders[node.type];
      const isMask32 = (idx: string) => {
        const node = as(fn.ops.get(idx), 'op');
        if (node.op !== 'const') return;
        const value = node.opts.value;
        const rawValue = coder.decode(value) as any as bigint[];
        for (const v of rawValue) if (v !== U32_MASK_N) return false;
        return true;
      };
      const isAnd32 = (idx: string) => {
        const node = as(fn.ops.get(idx), 'op');
        if (node.op !== 'and') return;
        const args = node.args;
        const notMask = [];
        let hasMask = false;
        for (let i = 0; i < args.length; i++) {
          if (isMask32(args[i])) hasMask = true;
          else notMask.push(args[i]);
        }
        if (hasMask) return notMask;
        return;
      };
      const andArgs = node.args.map((i) => isAnd32(i));
      if (andArgs.every((i) => i !== undefined)) {
        const andArgs2 = andArgs.map((i) => {
          if (i.length === 1) return fn.byIdx(i[0]);
          return T.and(...i.map((i) => fn.byIdx(i)));
        });
        const { u32x4 } = fn.types;
        return fn.op(
          node.type,
          'extmul_low_i32x4_u',
          andArgs2.map((i) => u32x4.shuffleLanes(i, i, [0, 2, 0, 2]))
        );
      }
    }
    // at this point everything with all constant args is merged
    if (types.opsVariadic.has(node.op)) {
      // one value -> replace with node
      if (args.length === 1) return args[0];
      // mutilple constants -> fold to one
      const argsVar: any = [];
      const argsConst: any = [];
      for (const a of args) {
        (isConst(a) ? argsConst : argsVar).push(a);
      }
      if (argsConst.length > 1) {
        const merged = exec(argsConst);
        return fn.op(node.type, node.op, [...argsVar, merged]);
      }
      if (argsConst.length === 1) {
        let c = getConst(argsConst[0]);
        if (types.SIMDType.has(node.type)) {
          const parts = types.TypeCoders[node.type].decode(c as Uint8Array);
          let allSame = true;
          for (let i = 1; i < parts.length; i++) if (parts[0] !== parts[i]) allSame = false;
          c = allSame ? parts[0] : undefined;
        }
        if (c !== undefined) {
          const A = () => {
            if (!isOp(node)) throw new Error('unreachable');
            return fn.op(node.type, node.op, [...argsVar]);
          };
          // a^0 = a, a | 0 = a, a + 0 = a
          if (isOp(node, 'xor', 'or', 'add') && c == 0) return A();
          // Float multiply by zero preserves NaN, so only integer-ish mul can fold to zero.
          if (isOp(node, 'and') && c == 0) return T.const(0);
          if (isOp(node, 'mul') && c == 0 && !types.FloatType.has(node.type)) return T.const(0);
          // a & -1 = a, a & mask = a
          if (types.IntType.has(node.type)) {
            const mask = types.getMask(types.ScalarOf(node.type));
            if (isOp(node, 'xor') && c == mask) return T.not(A());
            if (isOp(node, 'and') && (c == -1 || c == mask)) return A();
            if (isOp(node, 'or') && (c == -1 || c == mask)) return T.const(mask);
          }
          // a * 1 = a
          if (isOp(node, 'mul') && c == 1) return A();
          if (isOp(node, 'mul') && types.SignedType.has(node.type) && c == -1) return T.neg(A());
          // a / 1 = a
          if (isOp(node, 'div') && c == 1) return A();
          if (isOp(node, 'div') && types.SignedType.has(node.type) && c == -1) return T.neg(A());
          // a % 1 = 0
          if (isOp(node, 'rem') && c == 1) return T.const(0);
          if (isOp(node, 'rem') && types.SignedType.has(node.type) && c == -1) return T.const(0);

          if (types.IntType.has(node.type)) {
            const abs = c < 0 ? -c : c;
            if (isPow2(BigInt(abs))) {
              const k = ctzBig(BigInt(abs));
              const mask = (_1n << BigInt(k)) - _1n;
              if (isOp(node, 'mul')) {
                if (types.SignedType.has(node.type) && c < 0) return T.neg(T.shl(A(), k));
                else if (c > 0) return T.shl(A(), k);
              }
              if (isOp(node, 'div', 'rem')) {
                if (types.SignedType.has(node.type)) {
                  // signed, trunc-toward-zero: q = (a + ((a >> (W-1)) & (2^k-1))) >> k
                  const a = A();
                  const W = types.Width64.has(node.type) ? 64 : 32;
                  const sign = T.shr(a, W - 1); // 0 or -1 (arith shift)
                  const bias = T.and(sign, T.const(mask)); // 0..(2^k-1)
                  const qabs = T.shr(T.add(a, bias), k); // trunc(a / 2^k)
                  if (isOp(node, 'div')) return c < 0 ? T.neg(qabs) : qabs;
                  // r = a - qabs * 2^k ; divisor sign doesn't matter for remainder
                  else return T.sub(a, T.shl(qabs, k));
                } else {
                  // unsigned: a / 2^k = a >> k ; a % 2^k = a & (2^k-1)
                  if (isOp(node, 'div')) return T.shr(A(), k);
                  return T.and(A(), T.const(mask));
                }
              }
            }
          }
          //console.log('Variadic op', node.op, c, c == 0);
        }
      } else if (argsConst.length) throw new Error('unexpected');
    }
    if (isOp(node, 'and') && types.IntType.has(node.type) && types.ScalarType.has(node.type)) {
      for (let i = 0; i < args.length; i++) {
        const not = opNode(args[i]);
        if (!not || not.op !== 'not' || not.type !== node.type) continue;
        const keep = args.filter((_arg, j) => j !== i);
        if (!keep.length) continue;
        const left = keep.length === 1 ? keep[0] : fn.op(node.type, 'and', keep);
        return T.andnot(left, fn.byIdx(not.args[0]));
      }
    }
  };
}
/**
 * Lowers SIMD operations to scalar lane operations.
 *
 * @param fn - Function graph whose SIMD nodes may be lowered.
 * @param _opts - Compiler options. {@link CompilerOpts}
 * @param filter - Optional predicate selecting which SIMD types are lowered.
 * @returns Rewrite callback for `TreeDAG.rewrite`.
 * @example
 * ```js
 * import { Module } from '@awasm/compiler/module.js';
 * import { ModuleGraph } from '@awasm/compiler/codegen.js';
 * import { lowerSIMD } from '@awasm/compiler/rewrites.js';
 *
 * lowerSIMD(new ModuleGraph('demo', {}, new Module('demo'), {}));
 * ```
 */
export function lowerSIMD(
  fn: ModuleGraph,
  _opts: CompilerOpts = {},
  filter?: (type: TypeName) => boolean
): Rewrite {
  return (node, args, idx) => {
    const allowType = (type: TypeName) => types.SIMDType.has(type) && (!filter || filter(type));
    // v128 is very wrong type here. we need to use real simd types, otherwise we can
    // have v128.virtual with 4 lanes (u32x4) and then v128.virtual with 2 lanes (u64x2)
    // which will break everything
    const { prev, mapPrev, skipNode, mapBlocks, elemwiseVirtual, virt, getArg } = loweringUtils(
      fn,
      node,
      args,
      idx,
      (t) => (t && allowType(t) ? types.ScalarOf(t) : undefined),
      (node) => node.kind === 'op' && allowType(node.type) && node.op === 'virtual',
      (type, parts, opts) => fn.op(type, 'virtual', parts, opts)
    );
    const mb = mapBlocks();
    if (mb) return mb;
    if (skipNode()) return;
    node = as(node, 'op');
    if (!allowType(node.type)) return;
    const lType = types.ScalarOf(node.type);
    const lTypeObj = fn.types[lType];
    const lanes = types.lanesOf(node.type);
    const laneSize = types.sizeof(lType);
    const U32 = fn.types.u32;
    const U64 = fn.types.u64;
    const I32 = fn.types.i32;
    const byteZero = U32.const(0);
    const isSmallScalar = (t: TypeName) => types.SmallIntType.has(t) && types.ScalarType.has(t);
    const laneBits = (t: TypeName, v: FnOp) => {
      if (t === 'f32')
        return { bits: fn.op('i32', 'reinterpret_f32', [v]), bitsType: 'u32' as const };
      if (t === 'f64')
        return { bits: fn.op('i64', 'reinterpret_f64', [v]), bitsType: 'u64' as const };
      if (t === 'i64' || t === 'u64') return { bits: v, bitsType: 'u64' as const };
      if (isSmallScalar(t))
        return { bits: fn.op('u32', 'smallCast', [v], { from: t }), bitsType: 'u32' as const };
      return { bits: v, bitsType: 'u32' as const };
    };
    const bytesFromLanes = (t: TypeName, values: FnOp[]) => {
      const size = types.sizeof(t);
      const out: FnOp[] = [];
      for (const v of values) {
        const { bits, bitsType } = laneBits(t, v);
        if (bitsType === 'u32') {
          for (let i = 0; i < size; i++) {
            const shifted = i ? U32.shr(bits, i * 8) : bits;
            out.push(U32.and(shifted, U32.const(0xff)));
          }
        } else {
          for (let i = 0; i < size; i++) {
            const shifted = i ? U64.shr(bits, I32.const(i * 8)) : bits;
            const byte64 = U64.and(shifted, U64.const(U8_MASK_N));
            out.push(fn.op('u32', 'wrap_i64', [byte64]));
          }
        }
      }
      return out;
    };
    const lanesFromBytes = (t: TypeName, bytes: FnOp[]) => {
      const size = types.sizeof(t);
      const count = types.lanesOf(node.type);
      const out: FnOp[] = [];
      const getByte = (i: number) => (i < bytes.length ? bytes[i] : byteZero);
      for (let lane = 0; lane < count; lane++) {
        const start = lane * size;
        if (size > 4) {
          let acc = U64.const(_0n);
          for (let i = 0; i < size; i++) {
            const part = U64.shl(U64.fromN('u32', getByte(start + i)), i * 8);
            acc = i ? U64.or(acc, part) : part;
          }
          if (t === 'f64') out.push(fn.op('f64', 'reinterpret_i64', [acc]));
          else out.push(acc);
        } else {
          let acc = byteZero;
          for (let i = 0; i < size; i++) {
            const part = i ? U32.shl(getByte(start + i), i * 8) : getByte(start + i);
            acc = i ? U32.or(acc, part) : part;
          }
          if (t === 'f32') out.push(fn.op('f32', 'reinterpret_i32', [acc]));
          else if (isSmallScalar(t)) out.push(fn.op(t, 'smallCast', [acc], { from: 'u32' }));
          else out.push(acc);
        }
      }
      return out;
    };
    if (isOp(node, 'const')) {
      const val = types.TypeCoders[node.type].decode(node.opts.value) as any as bigint[] | number[];
      const nodePrev = [];
      for (let i = 0, pos = 0; i < lanes; i++, pos += laneSize) {
        nodePrev.push(fn.op(lType, 'const', [], { value: val[i] }));
      }
      return virt(node.type, nodePrev);
    } else if (isOp(node, 'cast')) {
      const fromType = node.opts.from as TypeName | undefined;
      const src = prev[0];
      if (!fromType || !types.SIMDType.has(fromType)) throw new Error('cast: missing from type');
      if (!src) throw new Error('cast: missing arg');
      const bytes = bytesFromLanes(types.ScalarOf(fromType), src);
      const out = lanesFromBytes(types.ScalarOf(node.type), bytes);
      return virt(node.type, out);
    } else if (isOp(node, 'swizzle')) {
      const src = prev[0];
      const mask = prev[1];
      if (!src || !mask) throw new Error('swizzle: missing args');
      if (!Array.isArray(mask)) throw new Error('swizzle: mask must be vector');
      const bytes = bytesFromLanes(lType, src);
      const maskBytes = mask.map((m) => fn.op('u32', 'smallCast', [m], { from: lType }));
      const outBytes: FnOp[] = [];
      const total = bytes.length;
      for (let i = 0; i < total; i++) {
        const chunkBase = Math.floor(i / 16) * 16;
        const maskVal = maskBytes[i % 16] || byteZero;
        let acc = byteZero;
        for (let j = 0; j < 16; j++) {
          const srcIdx = chunkBase + j;
          const srcByte = srcIdx < total ? bytes[srcIdx] : byteZero;
          const cond = U32.eq(maskVal, U32.const(j));
          acc = U32.select(cond, srcByte, acc);
        }
        outBytes.push(acc);
      }
      const out = lanesFromBytes(lType, outBytes);
      return virt(node.type, out);
    } else if (isOp(node, 'shl', 'shr', 'rotr', 'rotl')) {
      if (args.length !== 2) throw new Error('wrong args length');
      const nodePrev = [];
      for (let chunk = 0; chunk < lanes; chunk++) {
        const T = fn.types[lType];
        nodePrev.push(fn.op(lType, node.op, [prev[0]![chunk], T.fromN('i32', args[1])]));
      }
      return virt(node.type, nodePrev);
    } else if (
      isOp(
        node,
        'add',
        'sub',
        'and',
        'or',
        'not',
        'xor',
        'mul',
        'div',
        'rem',
        'neg',
        'andnot',
        'abs',
        'sqrt',
        'ceil',
        'floor',
        'trunc',
        'nearest',
        'ctz',
        'clz',
        'popcnt',
        'div',
        'rem',
        'copysign',
        'min',
        'max'
      )
      // Generic case, just do same op on chunks
    ) {
      return elemwiseVirtual();
    } else if (isOp(node, 'eq', 'ne', 'lt', 'gt', 'le', 'ge', 'isNaN', 'eqz')) {
      // these are specific, we need to return bitmask here!
      const maskType = types.maskType(node.type);
      const lmaskType = types.ScalarOf(maskType);
      const mT = fn.types[lmaskType];
      const nodePrev = [];
      for (let chunk = 0; chunk < lanes; chunk++) {
        // returns i32
        const op = fn.op(
          lType,
          node.op,
          node.args.map((_i, j) => prev[j]![chunk])
        );
        const value = mT.select(op, mT.const(types.getMask(lmaskType)), mT.const(0));
        nodePrev.push(value);
      }
      return virt(node.type, nodePrev);
    } else if (isOp(node, 'select')) {
      const a = prev[0];
      const b = prev[1];
      if (!a || !b) throw new Error('lowerSIMD: no prev!');
      const nodePrev = [];
      for (let chunk = 0; chunk < lanes; chunk++) {
        nodePrev.push(fn.op(lType, node.op, [a[chunk], b[chunk], fn.byIdx(node.args[2])]));
      }
      return virt(node.type, nodePrev);
    } else if (isOp(node, 'bitselect')) {
      const a = prev[0];
      const b = prev[1];
      const cond = prev[2];
      const maskType = types.maskType(node.type);
      const lmaskType = types.ScalarOf(maskType);
      const mT = fn.types[lmaskType];
      if (!a || !b || !cond) throw new Error('lowerSIMD/bitselect: missing args');
      if (!Array.isArray(cond)) throw new Error('lowerSIMD/bitselect: mask must be vector');
      const maskWidth = types.sizeof(lmaskType) * 8;
      const maskFull = BigInt.asUintN(maskWidth, BigInt(types.getMask(lmaskType)));
      const constMask = (op: FnOp) => {
        const n = as(fn.ops.get(op.idx), 'op');
        if (n.op !== 'const') return;
        const retType = types.nodeRetType(fn, op);
        if (!types.IntType.has(retType) || types.sizeof(retType) !== types.sizeof(lmaskType))
          return;
        const value = n.opts.value;
        if (typeof value !== 'number' && typeof value !== 'bigint') return;
        if (typeof value === 'number' && !Number.isInteger(value)) return;
        const bits = BigInt.asUintN(maskWidth, typeof value === 'bigint' ? value : BigInt(value));
        if (bits === _0n) return 'zero';
        if (bits === maskFull) return 'full';
        return;
      };
      const isBooleanMask = (op: FnOp): boolean => {
        const constKind = constMask(op);
        if (constKind) return true;
        const n = as(fn.ops.get(op.idx), 'op');
        if (n.op !== 'select') return false;
        const left = isBooleanMask(fn.byIdx(n.args[0]));
        const right = isBooleanMask(fn.byIdx(n.args[1]));
        return left && right;
      };
      const bitselFloat = (lane: number) => {
        const aBits = laneBits(lType, a[lane]);
        const bBits = laneBits(lType, b[lane]);
        const T = aBits.bitsType === 'u64' ? U64 : U32;
        const axb = T.xor(aBits.bits, bBits.bits);
        const t = T.and(axb, cond[lane]);
        const out = T.xor(bBits.bits, t);
        if (lType === 'f64') return fn.op('f64', 'reinterpret_i64', [out]);
        return fn.op('f32', 'reinterpret_i32', [out]);
      };
      const nodePrev = [];
      for (let lane = 0; lane < lanes; lane++) {
        // Keep the old fast scalar select for comparison masks;
        // arbitrary Wasm masks need bitwise selection.
        if (isBooleanMask(cond[lane]))
          nodePrev.push(fn.op(lType, 'select', [b[lane], a[lane], mT.eqz(cond[lane])]));
        else if (types.FloatType.has(lType)) nodePrev.push(bitselFloat(lane));
        else {
          const axb = fn.op(lType, 'xor', [a[lane], b[lane]]);
          const t = fn.op(lType, 'and', [axb, cond[lane]]);
          nodePrev.push(fn.op(lType, 'xor', [b[lane], t]));
        }
      }
      return virt(node.type, nodePrev);
    } else if (isOp(node, 'load')) {
      const weak = mapPrev(node.opts.weak || []).map((i) => fn.ops.weak(i));
      const strong = mapPrev(node.opts.strong || []);
      const nodePrev = [];
      if (node.opts.lane !== undefined) {
        const src = getArg(node.opts.src);
        if (!src) throw new Error('load_lane without src');
        for (const p of src) nodePrev.push(p);
        nodePrev[node.opts.lane] = fn.op(lType, 'load', [fn.byIdx(node.args[0])], {
          ...node.opts,
          src: undefined,
          weak,
          strong,
          offset: node.opts.offset || 0,
          source: 'lowerSIMD/lane',
        });
      } else {
        for (let i = 0, pos = 0; i < lanes; i++, pos += laneSize) {
          nodePrev.push(
            fn.op(lType, 'load', [fn.byIdx(node.args[0])], {
              ...node.opts,
              src: undefined,
              weak,
              strong,
              offset: (node.opts.offset || 0) + pos,
              source: 'lowerSIMD',
            })
          );
        }
      }
      return virt(node.type, nodePrev);
    } else if (isOp(node, 'store')) {
      const p = prev[1];
      if (!p) throw new Error('lowerSIMD: no prev!');
      const weak = mapPrev(node.opts.weak || []).map((i) => fn.ops.weak(i));
      const nodePrev = [];
      let strong = mapPrev(node.opts.strong || []);
      if (node.opts.lane !== undefined) {
        for (let i = 0, pos = 0; i < lanes; i++, pos += laneSize) {
          if (i !== node.opts.lane) {
            nodePrev.push(lTypeObj.const(0));
            continue;
          }
          const nodePart = fn.op(lType, 'store', [fn.byIdx(node.args[0]), p[i]], {
            ...node.opts,
            weak,
            strong,
            offset: node.opts.offset,
            isMut: true,
            source: 'lowerSIMD/lane',
          });
          nodePrev.push(nodePart);
        }
      } else {
        for (let i = 0, pos = 0; i < lanes; i++, pos += laneSize) {
          const nodePart = fn.op(lType, 'store', [fn.byIdx(node.args[0]), p[i]], {
            ...node.opts,
            weak,
            strong,
            offset: (node.opts.offset || 0) + pos,
            isMut: true,
            source: `lowerSIMD(${lType}, ${JSON.stringify(node)})`,
          });
          nodePrev.push(nodePart);
          strong = [nodePart.idx];
        }
      }
      return nodePrev[node.opts.lane !== undefined ? node.opts.lane : nodePrev.length - 1];
    } else if (isOp(node, 'shuffle')) {
      const p = prev;
      const nodePattern = node.opts.pattern as number[];
      // names inside dimensions?
      const d = utils.NamedDimensions({
        arg: node.args.length,
        chunk: lanes,
        idx: laneSize,
      });
      const patternIndices = d.chunks(
        'idx',
        nodePattern.map((i: number) => d.key.decode(i))
      );
      const nodePrev: any[] = [];
      for (const elm of patternIndices) {
        const args = [];
        const elmPat = [];
        const argPosMap: Record<string, number> = {};
        let lastArgPos = 0;
        for (const { arg, chunk, idx } of elm) {
          if (argPosMap[`${arg}-${chunk}`] === undefined) {
            args.push(p[arg]![chunk]); // arguments of new element
            argPosMap[`${arg}-${chunk}`] = lastArgPos++;
          }
          const argPos = argPosMap[`${arg}-${chunk}`];
          elmPat.push(laneSize * argPos + idx); // indices of pattern.
        }
        nodePrev.push(fn.op(lType, 'pattern', args, { pattern: elmPat }));
      }
      return virt(node.type, nodePrev);
    } else if (node.op === 'extract_lane') {
      const p = prev[0];
      if (!p) throw new Error('no prev arg');
      return p[node.opts.lane];
    } else if (node.op === 'replace_lane') {
      const nodePrev = Array.from(prev[0]!);
      nodePrev[node.opts.lane] = args[1];
      return virt(node.type, nodePrev);
    } else if (node.op === 'splat') {
      const nodePrev = [];
      for (let i = 0; i < lanes; i++) {
        nodePrev.push(fn.byIdx(node.args[0]));
      }
      return virt(node.type, nodePrev);
    } else if (
      node.op === 'extend_low_i8x16_s' ||
      node.op === 'extend_low_i8x16_u' ||
      node.op === 'extend_high_i8x16_s' ||
      node.op === 'extend_high_i8x16_u' ||
      node.op === 'extend_low_i16x8_s' ||
      node.op === 'extend_low_i16x8_u' ||
      node.op === 'extend_high_i16x8_s' ||
      node.op === 'extend_high_i16x8_u' ||
      node.op === 'extend_low_i32x4_s' ||
      node.op === 'extend_low_i32x4_u' ||
      node.op === 'extend_high_i32x4_s' ||
      node.op === 'extend_high_i32x4_u' ||
      node.op === 'extmul_low_i8x16_s' ||
      node.op === 'extmul_low_i8x16_u' ||
      node.op === 'extmul_high_i8x16_s' ||
      node.op === 'extmul_high_i8x16_u' ||
      node.op === 'extmul_low_i16x8_s' ||
      node.op === 'extmul_low_i16x8_u' ||
      node.op === 'extmul_high_i16x8_s' ||
      node.op === 'extmul_high_i16x8_u' ||
      node.op === 'extmul_low_i32x4_s' ||
      node.op === 'extmul_low_i32x4_u' ||
      node.op === 'extmul_high_i32x4_s' ||
      node.op === 'extmul_high_i32x4_u'
    ) {
      const p = prev[0];
      const p2 = prev[1];
      if (!p) throw new Error('lowerSIMD: missing arg');
      const fromLane = node.op.includes('i8x16')
        ? node.op.endsWith('_s')
          ? 'i8'
          : 'u8'
        : node.op.includes('i16x8')
          ? node.op.endsWith('_s')
            ? 'i16'
            : 'u16'
          : node.op.endsWith('_s')
            ? 'i32'
            : 'u32';
      const start = node.op.includes('high') ? lanes : 0;
      const nodePrev = [];
      for (let i = 0; i < lanes; i++) {
        const src = p[start + i];
        if (!src) throw new Error('lowerSIMD: extend src missing');
        const widen = (src: FnOp) =>
          isSmallScalar(fromLane)
            ? fn.op(lType, 'smallCast', [src], { from: fromLane })
            : fn.op(lType, `extend_i32${node.op.endsWith('_s') ? '_s' : '_u'}`, [src]);
        // 32-bit sources widen through scalar i64 ops; lowerWideInt
        // splits those after SIMD lowering.
        const a = widen(src);
        if (node.op.startsWith('extmul_')) {
          if (!p2) throw new Error('lowerSIMD: extmul missing arg');
          const srcB = p2[start + i];
          if (!srcB) throw new Error('lowerSIMD: extmul src missing');
          const b = widen(srcB);
          nodePrev.push(fn.op(lType, 'mul', [a, b]));
        } else {
          nodePrev.push(a);
        }
      }
      return virt(node.type, nodePrev);
    } else throw new Error(`lowerSIMD: not imeplemented! ${node.type}.${node.op}`);
  };
}

/**
 * Lowers bigint SIMD helper nodes.
 *
 * @param fn - Function graph whose nodes may be lowered.
 * @param opts - Compiler options. {@link CompilerOpts}
 * @returns Rewrite callback for `TreeDAG.rewrite`.
 * @example
 * ```js
 * import { Module } from '@awasm/compiler/module.js';
 * import { ModuleGraph } from '@awasm/compiler/codegen.js';
 * import { lowerBigIntSIMD } from '@awasm/compiler/rewrites.js';
 *
 * lowerBigIntSIMD(new ModuleGraph('demo', {}, new Module('demo'), {}));
 * ```
 */
export function lowerBigIntSIMD(fn: ModuleGraph, opts: CompilerOpts = {}): Rewrite {
  return lowerSIMD(fn, opts, (type) => types.BigIntType.has(types.ScalarOf(type)));
}

// Remove no-op casts so single-use analysis sees the real producer.
/**
 * Lowers 8-bit and 16-bit integer operations through 32-bit operations.
 *
 * @param fn - Function graph whose nodes may be lowered.
 * @param _opts - Compiler options. {@link CompilerOpts}
 * @returns Rewrite callback for `TreeDAG.rewrite`.
 * @example
 * ```js
 * import { Module } from '@awasm/compiler/module.js';
 * import { ModuleGraph } from '@awasm/compiler/codegen.js';
 * import { lowerSmallInt } from '@awasm/compiler/rewrites.js';
 *
 * lowerSmallInt(new ModuleGraph('demo', {}, new Module('demo'), {}));
 * ```
 */
export function lowerSmallInt(fn: ModuleGraph, _opts: CompilerOpts = {}): Rewrite {
  const isSmall = (t: TypeName) => types.SmallIntType.has(t) && types.ScalarType.has(t);
  const info = (t: TypeName) => {
    const width = t.endsWith('8') ? 8 : 16;
    const signed = t.startsWith('i');
    const mask = width === 8 ? 0xff : 0xffff;
    const base = (signed ? 'i32' : 'u32') as TypeName;
    return { width, signed, mask, base };
  };
  const signExtend = (v: FnOp, width: number) => {
    const shift = fn.types.i32.const(32 - width);
    const shl = fn.op('i32', 'shl', [v, shift]);
    return fn.op('i32', 'shr', [shl, shift]);
  };
  const zeroExtend = (v: FnOp, mask: number) => {
    return fn.op('u32', 'and', [v, fn.types.u32.const(mask)]);
  };
  const constNum = (idx: string) => {
    const node = fn.ops.get(idx);
    return isOp(node, 'const') ? Number(node.opts.value) : undefined;
  };
  const canDropSourceNorm = (idx: string) => {
    const node = fn.ops.get(idx);
    if (!isOp(node)) return false;
    if (isOp(node, 'arg', 'nodeOutput')) return true;
    const ret = types.nodeRetType(fn, fn.byIdx(idx));
    return !isSmall(ret) && !types.SIMDType.has(ret);
  };
  const normalizedSource = (v: FnOp): { value: FnOp; width: number } | undefined => {
    const node = fn.ops.get(v.idx);
    if (isOp(node, 'and')) {
      for (let i = 0; i < node.args.length; i++) {
        const mask = constNum(node.args[i]);
        if (mask !== 0xff && mask !== 0xffff) continue;
        const value = node.args.find((_arg, j) => j !== i);
        if (value && canDropSourceNorm(value))
          return { value: fn.byIdx(value), width: mask === 0xff ? 8 : 16 };
      }
    }
    if (!isOp(node, 'shr')) return;
    const right = constNum(node.args[1]);
    if (right !== 16 && right !== 24) return;
    const src = fn.ops.get(node.args[0]);
    if (!isOp(src, 'shl') || constNum(src.args[1]) !== right) return;
    if (!canDropSourceNorm(src.args[0])) return;
    return { value: fn.byIdx(src.args[0]), width: 32 - right };
  };
  const normalize = (t: TypeName, v: FnOp) => {
    const { signed, width, mask } = info(t);
    const src = normalizedSource(v);
    // Narrowing observes only low target bits; keep small producers visible for later lowering.
    if (src && width <= src.width) v = src.value;
    if (signed) return signExtend(v, width);
    return zeroExtend(v, mask);
  };
  const castFromSmall = (fromType: TypeName, v: FnOp) => normalize(fromType, v);
  return (node, args) => {
    if (node.kind === 'function') {
      let changed = false;
      const inputs = node.inputs.map((t: TypeName) => {
        if (!isSmall(t)) return t;
        changed = true;
        return info(t).base;
      }) as TypeName[];
      if (changed) node.inputs = inputs;
      return;
    }
    if (node.kind !== 'op') return;
    if (node.op === 'smallCast') {
      const fromType = node.opts.from as TypeName | undefined;
      if (!fromType) throw new Error('smallCast: missing from type');
      if (types.SIMDType.has(fromType) || types.SIMDType.has(node.type))
        throw new Error('smallCast: SIMD not supported');
      if (fromType === node.type) return args[0];
      const toType = node.type;
      const fromSmall = isSmall(fromType);
      const toSmall = isSmall(toType);
      const fromSigned = fromType.startsWith('i');
      const toSigned = toType.startsWith('i');
      const toBase = (toSigned ? 'i32' : 'u32') as TypeName;
      const fromBase = (fromSigned ? 'i32' : 'u32') as TypeName;
      if (fromSmall && toSmall && info(toType).width <= info(fromType).width) {
        // Target normalization only reads low target bits; source normalization would be discarded.
        return normalize(toType, args[0]);
      }
      const asI32 = () => {
        if (fromType === 'i32' || fromType === 'u32') return args[0];
        if (fromType === 'i64' || fromType === 'u64') return fn.op(fromBase, 'wrap_i64', [args[0]]);
        if (fromType === 'f32' || fromType === 'f64') {
          const sign = toSigned ? '_s' : '_u';
          return fn.op(toBase, `trunc_${fromType}${sign}`, [args[0]]);
        }
        if (fromSmall) return castFromSmall(fromType, args[0]);
        throw new Error(`smallCast: unsupported from ${fromType}`);
      };
      if (toSmall) {
        const val = asI32();
        return normalize(toType, val);
      }
      if (toType === 'i32' || toType === 'u32') return asI32();
      if (toType === 'i64' || toType === 'u64') {
        const sign = fromSigned ? '_s' : '_u';
        return fn.op(toType, `extend_i32${sign}`, [asI32()]);
      }
      if (toType === 'f32' || toType === 'f64') {
        const sign = fromSigned ? '_s' : '_u';
        return fn.op(toType, `convert_i32${sign}`, [asI32()]);
      }
      throw new Error(`smallCast: unsupported to ${toType}`);
    }
    if (isOp(node, 'call')) {
      let changed = false;
      const outTypes = node.opts.outTypes.map((t: TypeName) => {
        if (!isSmall(t)) return t;
        changed = true;
        return info(t).base;
      }) as TypeName[];
      if (changed) node.opts.outTypes = outTypes;
    }
    if (!isSmall(node.type)) return;
    const { base, width, mask } = info(node.type);
    const norm = (v: FnOp) => normalize(node.type, v);
    if (isOp(node, 'const')) return norm(fn.op(base, 'const', [], { value: node.opts.value }));
    if (isOp(node, 'arg'))
      return norm(
        fn.op(base, 'arg', [], { type: base, pos: node.opts.pos, scope: node.opts.scope })
      );
    if (isOp(node, 'nodeOutput')) {
      const out = fn.op(base, 'nodeOutput', [args[0]], node.opts);
      const src = fn.ops.get(args[0].idx);
      // Imported JS callbacks can return out-of-range numbers; keep the declared small domain.
      if (isOp(src, 'call') && src.opts.isImport) return norm(out);
      return out;
    }
    if (isOp(node, 'load')) {
      const size = node.opts.size !== undefined ? node.opts.size : width;
      return fn.op(base, 'load', [args[0]], { ...node.opts, size });
    }
    if (isOp(node, 'store')) {
      const size = node.opts.size !== undefined ? node.opts.size : width;
      return fn.op(base, 'store', [args[0], args[1]], { ...node.opts, size });
    }
    if (isOp(node, 'pattern')) {
      const pattern = node.opts.pattern as number[] | undefined;
      const size = width / 8;
      if (!pattern || pattern.length !== size) throw new Error('pattern: wrong length');
      const U = fn.types.u32;
      let acc = U.const(0);
      for (let outByte = 0; outByte < size; outByte++) {
        const pat = pattern[outByte];
        const argIdx = Math.floor(pat / size);
        const byteIdx = pat % size;
        const arg = args[argIdx];
        if (!arg) throw new Error('pattern: missing arg');
        const src = zeroExtend(arg, mask);
        const byte = byteIdx
          ? U.and(U.shr(src, byteIdx * 8), U.const(0xff))
          : U.and(src, U.const(0xff));
        const part = outByte ? U.shl(byte, outByte * 8) : byte;
        acc = outByte ? U.or(acc, part) : part;
      }
      return norm(acc);
    }
    if (isOp(node, 'swapEndianness')) {
      if (width === 8) return norm(args[0]);
      const U = fn.types.u32;
      const a = zeroExtend(args[0], mask);
      const lo = U.and(a, U.const(0xff));
      const hi = U.and(U.shr(a, 8), U.const(0xff));
      return norm(U.or(U.shl(lo, 8), hi));
    }
    if (isOp(node, 'clz')) {
      const U = fn.types.u32;
      const a = zeroExtend(args[0], mask);
      const base = U.sub(U.clz(a), U.const(32 - width));
      return norm(base);
    }
    if (isOp(node, 'ctz')) {
      const U = fn.types.u32;
      const a = zeroExtend(args[0], mask);
      const cnt = U.ctz(a);
      const limit = U.const(width);
      const tooBig = U.gt(cnt, limit);
      return norm(U.select(tooBig, limit, cnt));
    }
    if (isOp(node, 'popcnt')) {
      const U = fn.types.u32;
      const a = zeroExtend(args[0], mask);
      return norm(U.popcnt(a));
    }
    if (isOp(node, 'shl', 'shr')) {
      // WASM masks shift counts by lane width; keep JS/runtime aligned for small ints.
      const shift = fn.op('i32', 'and', [args[1], fn.types.i32.const(width - 1)]);
      return norm(fn.op(base, node.op, [args[0], shift], node.opts));
    }
    if (isOp(node, 'rotr', 'rotl')) {
      // Rotate within the lane width instead of 32-bit rotate.
      const shift = fn.op('i32', 'and', [args[1], fn.types.i32.const(width - 1)]);
      const inv = fn.op('i32', 'sub', [fn.types.i32.const(width), shift]);
      const U = fn.types.u32;
      const val = zeroExtend(args[0], mask);
      if (node.op === 'rotr') {
        const lo = U.shr(val, shift);
        const hi = U.shl(val, inv);
        return norm(U.or(lo, hi));
      }
      const lo = U.shl(val, shift);
      const hi = U.shr(val, inv);
      return norm(U.or(lo, hi));
    }
    if (types.opsCompare.has(node.op)) return fn.op(base, node.op, args, node.opts);
    if (isOp(node, 'cast')) return norm(args[0]);
    return norm(fn.op(base, node.op, args, node.opts));
  };
}

function addWeak(fn: ModuleGraph, oldIdx: NodeIdx, newIdx: NodeIdx) {
  const weak = fn.ops.usedWeak.get(oldIdx);
  if (weak) {
    for (const w of weak) {
      const wn = utils.deepClone(fn.ops.get(w));
      const newWeak = fn.ops.weak(newIdx);
      if (wn.opts.weak && !wn.opts.weak.includes(newWeak)) {
        wn.opts.weak = wn.opts.weak.concat(newWeak);
        fn.ops.set(w, wn);
      }
    }
  }
}

/**
 * Lower virtual SIMD types based on multiple native elements (u32x8 (virtual) over 2xu32x4 (native))
 */
/**
 * Lowers virtual SIMD pair values to native SIMD chunks.
 *
 * @param fn - Function graph whose virtual SIMD nodes may be lowered.
 * @param _opts - Compiler options. {@link CompilerOpts}
 * @returns Rewrite callback for `TreeDAG.rewrite`.
 * @example
 * ```js
 * import { Module } from '@awasm/compiler/module.js';
 * import { ModuleGraph } from '@awasm/compiler/codegen.js';
 * import { lowerVirtualSIMDPairs } from '@awasm/compiler/rewrites.js';
 *
 * lowerVirtualSIMDPairs(new ModuleGraph('demo', {}, new Module('demo'), {}));
 * ```
 */
export function lowerVirtualSIMDPairs(fn: ModuleGraph, _opts?: CompilerOpts): Rewrite {
  return (node, args, idx) => {
    const isPairType = (type: TypeName) =>
      (fn.types[type] as GetOpsFnOp<any>).pairCount !== undefined;
    const getNativeType = (type: TypeName) => {
      const t = fn.types[type] as any;
      return (t.pairNativeType as TypeName) || types.minSimdType(types.ScalarOf(type));
    };
    const { mapBlocks, skipNode, elemwiseVirtual, virt, prev } = loweringUtils(
      fn,
      node,
      args,
      idx,
      (t) => (t && isPairType(t) ? getNativeType(t) : undefined),
      (node) => node.kind === 'op' && node.op === 'virtual',
      (type, parts, opts) => fn.op(type, 'virtual', parts, opts)
    );
    const mb = mapBlocks();
    if (mb) return mb;
    if (skipNode() || !isOp(node)) return;
    const T = fn.types[node.type] as GetOpsFnOp<any>;
    const nativeType = getNativeType(node.type);
    const nativeT = fn.types[nativeType] as any;
    const lanesNative = types.lanesOf(nativeType);
    const lanes = types.lanesOf(node.type);
    const count = T.pairCount!;
    const typeAlign = utils.wasmAlign(types.sizeof(node.type));
    const getLane = (lane: number) => ({
      lane: lane % lanesNative,
      laneArg: Math.floor(lane / lanesNative),
    });
    if (node.op === 'load') {
      if (node.opts.lane !== undefined) {
        const src = as(fn.ops.get(node.opts.src), 'op');
        if (src.op !== 'virtual' || src.type !== node.type) throw new Error('wrong load/lane');
        const parts = src.args.slice();
        const { lane, laneArg } = getLane(node.opts.lane);
        const size = types.sizeof(nativeType);
        const op = fn.op(nativeType, 'load', [args[0]], {
          ...utils.deepClone(node.opts),
          src: parts[laneArg],
          lane: lanesNative === 1 ? undefined : lane,
          offset: lanesNative === 1 ? (node.opts.offset || 0) + laneArg * size : node.opts.offset,
          source: 'lowerVirtualSIMDPairs/lane',
        });
        addWeak(fn, idx, op.idx);
        parts[laneArg] = op.idx;
        return virt(
          node.type,
          parts.map((i) => fn.byIdx(i)),
          { ...src.opts }
        );
      } else {
        const parts = [];
        const size = types.sizeof(nativeType);
        for (let i = 0; i < count; i++) {
          const op = fn.op(nativeType, 'load', [args[0]], {
            ...utils.deepClone(node.opts),
            offset: (node.opts.offset || 0) + i * size,
            source: 'lowerVirtualSIMDPairs/lane',
          });
          parts.push(op);
        }
        for (const p of parts) addWeak(fn, idx, p.idx);
        return virt(node.type, parts);
      }
    } else if (node.op === 'store') {
      const align =
        node.opts.align !== undefined ? Math.min(node.opts.align, typeAlign) : undefined;
      if (node.opts.lane === undefined) {
        const parts = [];
        let strong = (node.opts.strong || []).slice();
        let weak = (node.opts.weak || []).slice();
        for (let i = 0; i < count; i++) {
          const size = types.sizeof(nativeType);
          const cur = fn.op(nativeType, 'store', [args[0], prev[1]![i]], {
            ...utils.deepClone(node.opts),
            weak,
            strong,
            offset: (node.opts.offset || 0) + i * size,
            align,
            isMut: true,
            source: 'lowerVirtualSIMDPairs',
          });
          parts.push(cur);
          strong = [cur.idx];
          weak = [];
        }
        return utils.last(parts);
      } else {
        const { lane, laneArg } = getLane(node.opts.lane);
        const size = types.sizeof(nativeType);
        return fn.op(nativeType, 'store', [args[0], prev[1]![laneArg]], {
          ...utils.deepClone(node.opts),
          align,
          lane: lanesNative === 1 ? undefined : lane,
          offset: lanesNative === 1 ? (node.opts.offset || 0) + laneArg * size : node.opts.offset,
          source: 'lowerVirtualSIMDPairs/lane',
        });
      }
    } else if (node.op === 'const') {
      const chunks = utils.chunkBytes(node.opts.value, types.sizeof(nativeType));
      if (chunks.length !== count) throw new Error('wrong const size');
      const ops = chunks.map((i) =>
        fn.op(nativeType, 'const', [], { value: i, source: 'lowerVirtualSIMDPairs/const' })
      );
      return virt(node.type, ops);
    } else if (types.opsShifts.has(node.op)) {
      const parts = prev[0]!.map((i) => fn.op(nativeType, node.op, [i, args[1]]));
      return virt(node.type, parts);
    } else if (node.op === 'splat') {
      const parts = [];
      for (let i = 0; i < count; i++) {
        parts.push(lanesNative === 1 ? args[0] : fn.op(nativeType, node.op, [args[0]]));
      }
      return virt(node.type, parts);
    } else if (node.op === 'replace_lane' || node.op === 'extract_lane') {
      const { lane, laneArg } = getLane(node.opts.lane);
      if (node.op === 'extract_lane') {
        if (lanesNative === 1) return prev[0]![laneArg];
        return nativeT.extractLane(prev[0]![laneArg], lane);
      }
      if (node.op === 'replace_lane') {
        const parts = Array.from(prev[0]!);
        parts[laneArg] =
          lanesNative === 1 ? args[1] : nativeT.replaceLane(parts[laneArg], lane, args[1]);
        return virt(node.type, parts);
      } else throw new Error('not implemented');
    } else if (node.op === 'shuffle') {
      // Default 16 bytes pattern for swapEndianness, todo: fix
      if (node.opts.pattern.length === 16) return elemwiseVirtual();
      const pattern = node.opts.pattern as number[];
      const laneSize = types.sizeof(types.ScalarOf(node.type));
      const typeSize = types.sizeof(node.type);
      if (pattern.length !== typeSize)
        throw new Error('lowerVirtualSIMDPairs/shuffle: wrong pattern length');
      if (!prev[0] || !prev[1])
        throw new Error('lowerVirtualSIMDPairs/shuffle: expected virtual args');
      const lanePattern = [];
      for (let outLane = 0; outLane < lanes; outLane++) {
        const pos = outLane * laneSize;
        const base = pattern[pos];
        if (!Number.isInteger(base) || base < 0 || base >= typeSize * 2 || base % laneSize)
          throw new Error(
            'lowerVirtualSIMDPairs/shuffle: only lane-aligned patterns are supported'
          );
        for (let i = 1; i < laneSize; i++) {
          if (pattern[pos + i] !== base + i)
            throw new Error(
              'lowerVirtualSIMDPairs/shuffle: only lane-aligned patterns are supported'
            );
        }
        lanePattern.push(base / laneSize);
      }
      const parts = [];
      for (let part = 0; part < count; part++) {
        let out = nativeT.const(0);
        for (let lane = 0; lane < lanesNative; lane++) {
          const srcLane = lanePattern[part * lanesNative + lane];
          const srcArg = srcLane >= lanes ? 1 : 0;
          const srcParts = prev[srcArg]!;
          const src = getLane(srcLane % lanes);
          const srcPart = srcParts[src.laneArg];
          const value = lanesNative === 1 ? srcPart : nativeT.extractLane(srcPart, src.lane);
          out = lanesNative === 1 ? value : nativeT.replaceLane(out, lane, value);
        }
        parts.push(out);
      }
      return virt(node.type, parts);
    } else if (node.op === 'to_i32_low' || node.op === 'to_i32_high') {
      const pattern = node.op === 'to_i32_low' ? [0, 2, 4, 6] : [1, 3, 5, 7];
      const parts = prev[0]!;
      if (!parts || parts.length !== 2) throw new Error('wrap_i64_*: expected 2 parts');
      return (fn.types[node.opts.type as TypeName] as GetOpsFnOp<any>).shuffleLanes(
        parts[0],
        parts[1],
        pattern
      );
    } else if (node.op === 'interleave' || node.op === 'deinterleave') {
      const pos = node.opts.pos as number;
      const t1 = prev.map((x) => x!).flat();
      let groups;
      if (node.op === 'interleave') {
        // t2 = utils.interleave(...utils.chunks(t1, t1.length / count))
        const t2 = utils.interleave(...utils.chunks(t1, t1.length / count));
        const x = nativeT.interleave(t2 as any); // FnOp[]
        // utils.interleave(...utils.deinterleave(x, inner.lanes).map((i) => utils.chunks(i, count)))
        groups = utils.interleave(
          ...utils.deinterleave(x, lanesNative).map((i: any[]) => utils.chunks(i, count))
        ) as FnOp[][];
      } else {
        const t2 = utils
          .interleave(
            ...utils.deinterleave(t1, count).map((i: any[]) => utils.chunks(i, lanesNative))
          )
          .flat(Infinity) as any[];
        const x = nativeT.deinterleave(t2);
        groups = utils.chunks(
          utils
            .deinterleave(x, count)
            .map((i: any[]) => utils.chunks(i, count * lanesNative))
            .flat(Infinity),
          count
        ) as FnOp[][];
      }
      const outs = groups.map((parts) => virt(node.type, parts));
      return outs[pos];
    } else {
      return elemwiseVirtual();
    }
  };
}
/**
 * Lower virtual SIMD types created from masking lanes of native element (u32x2 (virtual) over u32x4 (native))
 */
/**
 * Lowers virtual SIMD mask values to native SIMD chunks.
 *
 * @param fn - Function graph whose virtual SIMD mask nodes may be lowered.
 * @param _opts - Compiler options. {@link CompilerOpts}
 * @returns Rewrite callback for `TreeDAG.rewrite`.
 * @example
 * ```js
 * import { Module } from '@awasm/compiler/module.js';
 * import { ModuleGraph } from '@awasm/compiler/codegen.js';
 * import { lowerVirtualSIMDMask } from '@awasm/compiler/rewrites.js';
 *
 * lowerVirtualSIMDMask(new ModuleGraph('demo', {}, new Module('demo'), {}));
 * ```
 */
export function lowerVirtualSIMDMask(fn: ModuleGraph, _opts?: CompilerOpts): Rewrite {
  return (node, args, _idx) => {
    if (!isOp(node)) return;
    const T = (fn.types as any)[node.type];
    const isMask = T.maskCount !== undefined;
    if (!isMask) return;
    const laneType = types.ScalarOf(node.type);
    const nativeType = types.minSimdType(laneType);
    const typeAlign = utils.wasmAlign(types.sizeof(node.type));
    if (node.op === 'load') {
      const T = (fn.types as any)[node.type];
      if (T.maskCount === undefined) return;
      if (node.opts.lane !== undefined) {
        // per lane is same, we just lower type
        return fn.op(nativeType, 'load', [args[0]], {
          ...utils.deepClone(node.opts),
          src: node.opts.src,
          source: 'lowerVirtualMask/lane',
        });
      } else {
        // There is two ways to do u32x2:
        // - low half of vector(lanes 0, 1)
        //   - second half is unused, could be optimized away
        //   - generalizes to u32x3 and stuff
        //   - we can do size64 load into low half, but js doesn't support currently
        // - zero extend first lane into [0, 1] and second into [2, 3]
        //   - easy to convert to u64x2
        //   - no store32x2
        //   - need to zero high lanes if we want to "easy convert to u64x2"
        //
        // just load whole thing (16 bytes), ignore stuff that is unsused
        const activeBytes = types.sizeof(laneType) * T.maskCount;
        const zeroLoad = activeBytes === 4 || activeBytes === 8 ? activeBytes * 8 : undefined;
        return fn.op(nativeType, 'load', [args[0]], {
          ...utils.deepClone(node.opts),
          // Native zero-loads preserve low active lanes without over-reading the unused half.
          zeroLoad,
          source: 'lowerVirtualSIMDMask',
        });
      }
    } else if (node.op === 'store') {
      const align =
        node.opts.align !== undefined ? Math.min(node.opts.align, typeAlign) : undefined;
      if (node.opts.size !== undefined && node.opts.lane === undefined) {
        // special case, store single lane here.
        throw new Error('not implemented');
      } else if (node.opts.lane === undefined) {
        const prev = [];
        let strong = (node.opts.strong || []).slice();
        let weak = (node.opts.weak || []).slice();
        for (let i = 0; i < T.maskCount; i++) {
          const cur = fn.op(nativeType, 'store', args, {
            ...utils.deepClone(node.opts),
            weak,
            strong,
            offset: (node.opts.offset || 0) + i * types.sizeof(laneType),
            size: types.sizeof(laneType) * 8,
            lane: i,
            align,
            isMut: true,
            source: 'lowerVirtualSIMDMask',
          });
          prev.push(cur);
          strong = [cur.idx];
          weak = [];
        }
        return utils.last(prev);
      } else {
        // lane is no-op
        return fn.op(nativeType, 'store', args, {
          ...utils.deepClone(node.opts),
          align,
          source: 'lowerVirtualMaskPairs/lane',
        });
      }
    } else {
      const opts = { ...node.opts };
      if (node.op === 'const') {
        const padded = new Uint8Array(16);
        padded.set(node.opts.value);
        opts.value = padded;
      }
      return fn.op(nativeType, node.op, args, {
        ...opts,
        activeLanes: T.maskCount,
        source: 'lowerVirtualSIMDMask/op',
      });
    }
  };
}
/**
 * Lowers scalar byte-pattern operations into backend-friendly operations.
 *
 * @param fn - Function graph whose pattern nodes may be lowered.
 * @param opts - Compiler options. {@link CompilerOpts}
 * @returns Rewrite callback for `TreeDAG.rewrite`.
 * @example
 * ```js
 * import { Module } from '@awasm/compiler/module.js';
 * import { ModuleGraph } from '@awasm/compiler/codegen.js';
 * import { lowerPattern } from '@awasm/compiler/rewrites.js';
 *
 * lowerPattern(new ModuleGraph('demo', {}, new Module('demo'), {}));
 * ```
 */
export function lowerPattern(fn: ModuleGraph, opts: CompilerOpts = {}): Rewrite {
  function isswapEndianness(lst: number[]) {
    if (lst[0] !== lst.length - 1) return false;
    for (let i = 1; i < lst.length; i++) {
      if (lst[i] !== lst[i - 1] - 1) return false;
    }
    return true;
  }
  function isDirect(lst: number[]) {
    for (let i = 0; i < lst.length; i++) {
      if (lst[i] !== i) return false;
    }
    return true;
  }
  return (node, args, idx) => {
    if (node.kind === 'op' && node.op === 'store' && opts.patternMemoryEndianess) {
      const value = as(fn.ops.get(args[1].idx), 'op');
      if (value.op !== 'pattern') return;
      if (value.args.length !== 1) throw new Error('lowerPattern: multiple args (store)');
      if (isswapEndianness(value.opts.pattern) && value.args.length === 1) {
        const n = utils.deepClone(node);
        n.args[1] = value.args[0];
        n.opts.swapEndianness = !n.opts.swapEndianness;
        return fn.byIdx(fn.ops.add(n));
      }
    }
    if (node.kind !== 'op' || node.op !== 'pattern') return;
    if (args.length !== 1) {
      console.error('lowerPattern/ARGS', idx, args);
      throw new Error('lowerPattern: multiple args (load)');
    }
    if (isDirect(node.opts.pattern) && args.length === 1) return args[0];
    if (opts.patternMemoryEndianess && args.length === 1) {
      const arg = as(fn.ops.get(args[0].idx), 'op');
      if (arg.op === 'load') {
        if (arg.type !== node.type) throw new Error('lowerPattern: type mismatch');
        if (isswapEndianness(node.opts.pattern)) {
          const n = utils.deepClone(arg);
          n.opts.swapEndianness = !n.opts.swapEndianness;
          const newIdx = fn.ops.add(n);
          addWeak(fn, args[0].idx, newIdx);
          return fn.byIdx(newIdx);
        } else {
          throw new Error('unknown pattern');
        }
      }
    }
    // for others: do rotate and stuff?
    //throw new Error(`lowerPattern: not implemented! ${node.type}.${node.op}(${idx})`);
    return;
  };
}
/**
 * Lower function arguments/outputs from u64/i64 into two u32/i32
 */
/**
 * Lowers imported and exported 64-bit function ABI values to 32-bit pairs.
 *
 * @param fn - Function graph whose call ABI nodes may be lowered.
 * @param _opts - Compiler options. {@link CompilerOpts}
 * @returns Rewrite callback for `TreeDAG.rewrite`.
 * @example
 * ```js
 * import { Module } from '@awasm/compiler/module.js';
 * import { ModuleGraph } from '@awasm/compiler/codegen.js';
 * import { lowerU64Arg } from '@awasm/compiler/rewrites.js';
 *
 * lowerU64Arg(new ModuleGraph('demo', {}, new Module('demo'), {}));
 * ```
 */
export function lowerU64Arg(fn: ModuleGraph, _opts: CompilerOpts = {}): Rewrite {
  type Remap = Record<number, number | number[]>;
  type FnRemap = {
    inputsRemap?: Remap;
    outputsRemap?: Remap;
    outputTypes?: TypeName[];
  };
  const normType = (inp: TypeName) => (inp === 'i64' ? 'i32' : 'u32');
  const isWide = (inp: TypeName) => inp === 'i64' || inp === 'u64';
  const remapTypes = (lst: TypeName[]) => {
    const newTypes: TypeName[] = [];
    const remap: Remap = {};
    let changed = false;
    for (let i = 0; i < lst.length; i++) {
      const inp = lst[i];
      if (isWide(inp)) {
        const t = normType(inp);
        newTypes.push(t, t);
        remap[i] = [newTypes.length - 2, newTypes.length - 1]; // low, high
        changed = true;
      } else {
        newTypes.push(inp);
        remap[i] = newTypes.length - 1;
      }
    }
    return { changed, newTypes, remap: changed ? remap : undefined };
  };
  const perFn: Record<string, FnRemap> = {};
  const remapped = new Set();
  const callArgs: Record<string, (() => FnOp)[]> = {};
  return (node, _args, idx) => {
    if (node.kind === 'function') {
      const {
        changed: inputsChanged,
        newTypes: newInputs,
        remap: inputsRemap,
      } = remapTypes(node.inputs);
      // Fix outputs
      const newOutputs: NodeIdx[] = [];
      const outputsRemap: Remap = {};
      const outputTypes: TypeName[] = [];
      let outputsChanged = false;
      for (let i = 0; i < node.outputs.length; i++) {
        const out = node.outputs[i];
        const n = fn.ops.get(out);
        const retType = types.nodeRetType(fn, fn.byIdx(out));
        outputTypes.push(retType);
        if (n.kind === 'op' && isWide(retType)) {
          fn.ops.scope(idx, () => {
            const T = fn.types[retType];
            const [l, h] = T.to(normType(retType), fn.byIdx(out));
            newOutputs.push(l.idx);
            newOutputs.push(h.idx);
          });
          outputsRemap[i] = [newOutputs.length - 2, newOutputs.length - 1];
          outputsChanged = true;
        } else {
          newOutputs.push(out);
          outputsRemap[i] = newOutputs.length - 1;
        }
      }
      if (inputsChanged) node.inputs = newInputs;
      if (outputsChanged) node.outputs = newOutputs;
      perFn[node.name] = {
        inputsRemap,
        outputsRemap: outputsChanged ? outputsRemap : undefined,
        outputTypes: outputsChanged ? outputTypes : undefined,
      };
      // TODO: this will cause moving node to different idx which will break scoping (?!)
      //if (inputsChanged || outputsChanged) return fn.byIdx(idx);
    }
    if (is(node, 'op')) {
      const fnNode = fn.getCurFn().node;
      if (node.op === 'arg') {
        const inputRemap = perFn[fnNode.name].inputsRemap;
        if (!inputRemap) return;
        const remap = inputRemap[node.opts.pos];
        if (!remap) return;
        if (Array.isArray(remap)) {
          const args = remap.map((idx) =>
            fn.op(normType(node.type), 'arg', [], { type: normType(node.type), pos: idx })
          );
          const T = fn.types[node.type];
          return T.fromN(normType(node.type), args);
        } else {
          node.opts.pos = remap;
          return fn.byIdx(idx);
        }
      } else if (node.op === 'nodeOutput') {
        if (node.opts.loweredU64Arg) return;
        if (remapped.has(node)) return;
        const t = callArgs[node.args[0]];
        if (!t) return;
        if (!t[node.opts.pos]) throw new Error('cannot find call arg');
        remapped.add(node);
        return t[node.opts.pos]();
      } else if (node.op === 'call') {
        if (remapped.has(node)) return;
        const importRemap = (): FnRemap | undefined => {
          if (!node.opts.isImport) return;
          const inputTypes = node.opts.inputTypes as TypeName[] | undefined;
          const outputTypes = node.opts.outputTypes as TypeName[] | undefined;
          const inputsRemap = inputTypes ? remapTypes(inputTypes).remap : undefined;
          const outputsRemap = outputTypes ? remapTypes(outputTypes).remap : undefined;
          if (!inputsRemap && !outputsRemap) return;
          return { inputsRemap, outputsRemap, outputTypes };
        };
        const remapInfo = perFn[node.opts.name] || importRemap();
        if (!remapInfo) return;
        const { inputsRemap, outputsRemap, outputTypes } = remapInfo;
        // Fix call args
        if (inputsRemap) {
          const newArgs = [];
          for (let i = 0; i < node.args.length; i++) {
            const map = inputsRemap[i];
            if (Array.isArray(map)) {
              const prevArg = node.args[i];
              const inputTypes = node.opts.inputTypes as TypeName[] | undefined;
              const prevType = inputTypes ? inputTypes[i] : as(fn.ops.get(prevArg), 'op').type;
              const T = fn.types[prevType];
              const newArg = T.to(normType(prevType), fn.byIdx(prevArg));
              newArgs.push(...newArg.map((i: any) => i.idx));
            } else {
              newArgs.push(node.args[i]);
            }
          }
          node.args = newArgs;
          node.opts.inputsCnt = newArgs.length;
        }
        // Fix call outputs
        if (outputsRemap) {
          const newOutTypes = [];
          const newCallArgs = [];
          for (let i = 0; i < node.opts.outTypes.length; i++) {
            const map = outputsRemap[i];
            const curType = outputTypes ? outputTypes[i] : node.opts.outTypes[i];
            if (Array.isArray(map)) {
              newOutTypes.push(normType(curType), normType(curType));
              // Create replacement nodes only when the old nodeOutput is rewritten; cleanup can
              // otherwise remove pre-created nodes before the original output is visited.
              newCallArgs.push(() => {
                const l = fn.op(normType(curType), 'nodeOutput', [fn.byIdx(idx)], {
                  pos: map[0],
                  loweredU64Arg: true,
                });
                const h = fn.op(normType(curType), 'nodeOutput', [fn.byIdx(idx)], {
                  pos: map[1],
                  loweredU64Arg: true,
                });
                const T = (fn.types as any)[curType];
                return T.fromN(normType(curType), [l, h]);
              });
            } else {
              // `map` is the post-split output position; the type still
              // comes from the original slot.
              const type = node.opts.outTypes[i];
              newOutTypes.push(type);
              newCallArgs.push(() =>
                fn.op(type, 'nodeOutput', [fn.byIdx(idx)], { pos: map, loweredU64Arg: true })
              );
            }
          }
          callArgs[idx] = newCallArgs;
          node.opts.outTypes = newOutTypes;
        }
        remapped.add(node);
        if (inputsRemap || outputsRemap) return fn.byIdx(idx);
      }
    }
    return;
  };
}
/**
 * Implement operations not available in wasm (such as 'not')
 */
/**
 * Lowers compiler IR nodes to native Wasm instruction shapes.
 *
 * @param fn - Function graph whose nodes may be lowered.
 * @param _opts - Compiler options. {@link CompilerOpts}
 * @returns Rewrite callback for `TreeDAG.rewrite`.
 * @example
 * ```js
 * import { Module } from '@awasm/compiler/module.js';
 * import { ModuleGraph } from '@awasm/compiler/codegen.js';
 * import { lowerWasm } from '@awasm/compiler/rewrites.js';
 *
 * lowerWasm(new ModuleGraph('demo', {}, new Module('demo'), {}));
 * ```
 */
export function lowerWasm(fn: ModuleGraph, _opts: CompilerOpts = {}): Rewrite {
  // Handle weirdness inside wasm op encoding
  return (node, args, _idx) => {
    if (node.kind !== 'op') return;
    const T = fn.types[node.type] as GetOpsFnOp<any>;
    const size = types.sizeof(node.type);
    const lanes = types.lanesOf(node.type);
    if (types.SIMDType.has(node.type)) {
      if (['rotr', 'rotl'].includes(node.op)) {
        const { i32 } = fn.types;
        const [valArg, shiftArg] = args;
        const bitWidth = (size / lanes) * 8;
        const shiftNode = fn.ops.get(shiftArg.idx);
        if (shiftNode.kind !== 'op' || shiftNode.type !== 'i32' || shiftNode.op !== 'const') {
          // throw new Error('wrong shift node');
          const MASK = bitWidth - 1;
          const s = i32.and(shiftArg, i32.const(MASK));
          // s2 = (-s) & MASK  // == (bitWidth - s) & MASK, avoids special-casing
          const s2 = i32.and(i32.sub(i32.const(0), s), i32.const(MASK));
          const uType = node.type.replace('i', 'u') as any;
          if (node.op === 'rotl') {
            const shr_u = fn.op(uType, 'shr', [valArg, s2]);
            return T.or(T.shl(valArg, s), shr_u);
          } else {
            // rotr
            const shr_u = fn.op(uType, 'shr', [valArg, s]);
            return T.or(T.shl(valArg, s2), shr_u);
          }
        }
        let shift = shiftNode.opts.value;
        if (node.op === 'rotr') shift = bitWidth - shift;
        const MASK = bitWidth - 1;
        shift &= MASK;
        if (!shift) return valArg;
        if (shift % 8 === 0) {
          if (bitWidth === 32) {
            // prettier-ignore
            const masks: Record<number, number[]> = {
              8: [3, 0, 1, 2, 7, 4, 5, 6, 11, 8, 9, 10, 15, 12, 13, 14],
              16: [2, 3, 0, 1, 6, 7, 4, 5, 10, 11, 8, 9, 14, 15, 12, 13],
              24: [1, 2, 3, 0, 5, 6, 7, 4, 9, 10, 11, 8, 13, 14, 15, 12],
            };
            return fn.op(node.type, 'shuffle', [valArg, valArg], { pattern: masks[shift] });
          }
          if (bitWidth === 64) {
            // prettier-ignore
            const masks: Record<number, number[]> = {
              8: [7, 0, 1, 2, 3, 4, 5, 6, 15, 8, 9, 10, 11, 12, 13, 14],
              16: [6, 7, 0, 1, 2, 3, 4, 5, 14, 15, 8, 9, 10, 11, 12, 13],
              24: [5, 6, 7, 0, 1, 2, 3, 4, 13, 14, 15, 8, 9, 10, 11, 12],
              32: [4, 5, 6, 7, 0, 1, 2, 3, 12, 13, 14, 15, 8, 9, 10, 11],
              40: [3, 4, 5, 6, 7, 0, 1, 2, 11, 12, 13, 14, 15, 8, 9, 10],
              48: [2, 3, 4, 5, 6, 7, 0, 1, 10, 11, 12, 13, 14, 15, 8, 9],
              56: [1, 2, 3, 4, 5, 6, 7, 0, 9, 10, 11, 12, 13, 14, 15, 8],
            };
            return fn.op(node.type, 'shuffle', [valArg, valArg], { pattern: masks[shift] });
          }
        }
        // rotation always uses unsigned variant even for signed types
        const shr_u = fn.op(node.type.replace('i', 'u') as any, 'shr', [
          valArg,
          i32.const(bitWidth - shift),
        ]);
        return T.or(T.shl(valArg, shift), shr_u);
      }
      if (
        ['ctz', 'clz', 'popcnt', 'div', 'rem', 'copysign'].includes(node.op) ||
        (node.op === 'mul' && (node.type === 'i8x16' || node.type === 'u8x16'))
      ) {
        const laneType = types.ScalarOf(node.type);
        let lanes: number = types.lanesOf(node.type);
        if (node.opts.activeLanes) lanes = Math.min(lanes, node.opts.activeLanes);
        const res: FnOp[] = [];
        for (let i = 0; i < lanes; i++) {
          const laneArgs = args.map((arg) => T.extractLane(arg, i));
          res.push(fn.op(laneType, node.op, laneArgs));
        }
        let v = T.splat(res[0]);
        for (let i = 1; i < lanes; i++) v = T.replaceLane(v, i, res[i]);
        return v;
      }
      // No unsigned comparisons in wasm :(
      if (node.type === 'u64x2' && ['lt', 'gt', 'le', 'ge'].includes(node.op)) {
        const { i64x2 } = fn.types;
        const S = T.const(U64_SIGN_N);
        return i64x2[node.op as 'lt' | 'gt' | 'le' | 'ge'](T.xor(args[0], S), T.xor(args[1], S));
      }
    }
    if (node.op === 'not' && ['i32', 'u32', 'i64', 'u64'].includes(node.type)) {
      return T.xor(args[0], T.const(types.getMask(node.type)));
    }
    if (node.op === 'neg' && types.IntType.has(node.type) && types.SignedType.has(node.type))
      return T.sub(T.const(0), args[0]);
    if (node.op === 'andnot') return T.and(args[0], T.not(args[1]));
    if (node.op === 'abs' && types.IntType.has(node.type))
      return T.select(T.ge(args[0], T.const(0)), args[0], T.neg(args[0]));
    if (node.op === 'eqz' && (types.FloatType.has(node.type) || types.SIMDType.has(node.type)))
      return T.eq(args[0], T.const(0));
    if (types.FloatType.has(node.type) && node.op === 'isNaN') return T.ne(args[0], args[0]);
    if (node.op === 'rem' && types.FloatType.has(node.type)) {
      const [a, b] = args;
      const { f64 } = fn.types;
      const a64 = node.type === 'f32' ? fn.op('f64', 'promote_f32', [a]) : a;
      const b64 = node.type === 'f32' ? fn.op('f64', 'promote_f32', [b]) : b;
      const q = f64.trunc(f64.div(a64, b64));
      const r64 = f64.sub(a64, fn.op('f64', 'mul', [q, b64]));
      return node.type === 'f32' ? fn.op('f32', 'demote_f64', [r64]) : r64;
    }
    if (types.IntType.has(node.type) && ['min', 'max'].includes(node.op)) {
      return args.reduce((a, b) => T.select(T[node.op === 'min' ? 'le' : 'ge'](a, b), a, b));
    }
    return;
  };
}
/*
Lower copysign:
;; stack: a b
f32x4.abs        ;; absA
i32x4.splat 0x80000000
v128.bitselect   ;; (b & signMask) | (absA & ~signMask)


absA = f32x4.abs(a) (clears sign bit, preserves payload bits)
signMask = i32x4.splat(0x80000000)
res = v128.bitselect(b, absA, signMask)
*/

/**
 * Implement generic 'shuffle'-like pattern on scalars.  Mostly quick hack for runtime typeMod.
 */
/**
 * Lowers remaining byte-pattern operations for the JavaScript backend.
 *
 * @param fn - Function graph whose pattern nodes may be lowered.
 * @param _opts - Compiler options. {@link CompilerOpts}
 * @returns Rewrite callback for `TreeDAG.rewrite`.
 * @example
 * ```js
 * import { Module } from '@awasm/compiler/module.js';
 * import { ModuleGraph } from '@awasm/compiler/codegen.js';
 * import { lowerPatternJS } from '@awasm/compiler/rewrites.js';
 *
 * lowerPatternJS(new ModuleGraph('demo', {}, new Module('demo'), {}));
 * ```
 */
export function lowerPatternJS(fn: ModuleGraph, _opts: CompilerOpts = {}): Rewrite {
  return (node, args, _idx) => {
    if (node.kind !== 'op') return;
    if (node.op !== 'pattern') return;
    const uType = types.Width64.has(node.type) ? 'u64' : 'u32';
    const iType = types.Width64.has(node.type) ? 'i64' : 'i32';
    const U = fn.types[uType];
    const T = fn.types[node.type];
    const pattern = node.opts.pattern as number[];
    const size = types.sizeof(node.type);
    if (!pattern || pattern.length !== size) throw new Error('pattern: wrong length');
    const values = args.map((arg) => {
      if (types.FloatType.has(node.type))
        return U.fromN(iType, fn.op(iType, `reinterpret_${node.type}`, [arg]));
      if (node.type !== uType) return U.fromN(node.type, arg);
      return arg;
    });
    let acc = U.const(0);
    for (let outByte = 0; outByte < size; outByte++) {
      const pat = pattern[outByte];
      if (!Number.isInteger(pat) || pat < 0 || pat >= args.length * size)
        throw new Error(`pattern: wrong index ${pat}`);
      const value = values[Math.floor(pat / size)];
      const byteIdx = pat % size;
      let b = U.and(U.shr(value, byteIdx * 8), U.const(0xff));
      if (outByte) b = U.shl(b, outByte * 8);
      acc = outByte ? U.or(acc, b) : b;
    }
    if (types.FloatType.has(node.type))
      return fn.op(node.type, `reinterpret_${iType}`, [U.toN(iType, acc)]);
    else if (node.type !== uType) return T.fromN(uType, acc);
    return acc;
  };
}
