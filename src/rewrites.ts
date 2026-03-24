import * as P from 'micro-packed';
import {
  type CompilerOpts,
  type FnOp,
  type ModuleGraph,
  type Node,
  type NodeIdx,
  as,
  is,
  isOp,
} from './codegen.ts';
import * as types from './types.ts';
import { type GetOpsFnOp, type TypeName } from './types.ts';
import * as utils from './utils.ts';

export type Rewrite = (node: Node, args: FnOp[], idx: NodeIdx) => FnOp | undefined;
export type RewriteFn = (fn: ModuleGraph, opts?: CompilerOpts) => Rewrite;

// These are very self-contained, so even if they small it is reasonable to move out them.
// Maybe even separate files?

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
 * Lower u64/i64 into two u32/i32
 */
export function lowerWideInt(fn: ModuleGraph, _opts: CompilerOpts = {}, bits = 64): Rewrite {
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
    const opLT = (op: string, args: FnOp[]) => fn.op(LT, op, args);
    const opU = (op: string, args: FnOp[]) =>
      fn.op(
        wordBits === 32 ? 'u32' : lowUnsigned,
        op,
        args.map((v) => U(v))
      );
    const opS = (op: string, args: FnOp[]) =>
      fn.op(
        lowSigned,
        op,
        args.map((v) => S(v))
      );
    const opB = (op: string, args: FnOp[]) => fn.op(wordBits === 32 ? LT : 'u32', op, args);
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

    const carryFromAdd = (a: FnOp, b: FnOp, sum: FnOp): FnOp => {
      const a_and_b = opLT('and', [a, b]);
      const a_or_b = opLT('or', [a, b]);
      const not_sum = opLT('xor', [sum, neg1]);
      const gen = opLT('or', [a_and_b, opLT('and', [a_or_b, not_sum])]);
      const carry = opU('shr', [gen, constOf(LT, wordBits - 1)]);
      return cast(LT, carry);
    };
    const U32 = 0xffff_ffffn;
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
        const hiU = (v >> 32n) & U32;
        const l = fn.op(LT, 'const', [], { value: Number(types.u32ToI32(loU)) });
        const h = fn.op(LT, 'const', [], { value: Number(types.u32ToI32(hiU)) });
        return virt(node.type, [l, h], { value: v });
      }
      const lo = v & ((1n << BigInt(wordBits)) - 1n);
      const hi = (v >> BigInt(wordBits)) & ((1n << BigInt(wordBits)) - 1n);
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
      const widenArg = () => {
        const arg = args[1];
        const argType = as(fn.ops.get(arg.idx), 'op').type;
        if (argType === 'u32' && node.type === 'u64') return [arg, zero];
        if (argType === 'i32' && node.type === 'i64')
          return [arg, opS('shr', [arg, constOf(LT, 31)])];
        if (
          (argType === 'u64' || argType === 'i64') &&
          (node.type === 'u64' || node.type === 'i64')
        )
          return (fn.types as any)[argType].to(LT, arg);
        return;
      };
      const p = prev[1] || widenArg();
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
        outParts[k] = fn.op(loType, node.op, ops, opts);
      }
      return virt(node.type, outParts);
    } else if (isOp(node, 'add')) {
      // Gather pairs
      const widenArg = (i: number) => {
        const arg = args[i];
        const argType = as(fn.ops.get(arg.idx), 'op').type;
        if (argType === 'u32' && node.type === 'u64') return [arg, zero];
        if (argType === 'i32' && node.type === 'i64')
          return [arg, opS('shr', [arg, constOf(LT, 31)])];
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
      const pairs = node.args.map((i, j) => {
        const p = pairOf(j) || widenArg(j);
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
      const widenArg = (i: number) => {
        const arg = args[i];
        const argType = as(fn.ops.get(arg.idx), 'op').type;
        // u128 div emits 32-bit booleans used in u64 arithmetic; widen to keep lowering stable.
        if ((argType === 'u32' || argType === 'i32') && node.type === 'u64') return [arg, zero];
        if (argType === 'i32' && node.type === 'i64')
          return [arg, opS('shr', [arg, constOf(LT, 31)])];
        return;
      };
      const A = pairOf(0) || widenArg(0);
      const B = pairOf(1) || widenArg(1);
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
      const widenArg = (i: number) => {
        const arg = args[i];
        const argType = as(fn.ops.get(arg.idx), 'op').type;
        if ((argType === 'u32' || argType === 'i32') && node.type === 'u64') return [arg, zero];
        if (argType === 'i32' && node.type === 'i64')
          return [arg, opS('shr', [arg, constOf(LT, 31)])];
        return;
      };
      const pairs = node.args.map((i: string, j: number) => {
        const p = pairOf(j) || widenArg(j);
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
        // (h|l) == 0
        return opB('eq', [opLT('or', [a[1], a[0]]), zero]);
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
 * Lower u64/i64 into two u32/i32
 */
export function lowerU64(fn: ModuleGraph, opts: CompilerOpts = {}): Rewrite {
  return lowerWideInt(fn, opts, 64);
}
/**
 * Basic optimizer with constant folding
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
  const isPow2 = (n: bigint): boolean => n > 0n && (n & (n - 1n)) === 0n;
  const ctzBig = (n: bigint) => {
    let k = 0;
    for (; (n & 1n) === 0n; k++, n >>= 1n);
    return k;
  };
  return (node, args, _idx) => {
    if (node.kind !== 'op') return;
    if (isOp(node, 'load', 'store', 'const', 'arg', 'fill', 'copy', 'call', 'br_if', 'br')) return;
    if (isOp(node, 'virtualPairs', 'virtualPairsArg', 'virtualMask')) return;
    if (node.op.includes('atomic')) return;
    if (types.BigIntType.has(node.type)) return;
    const T = (fn.types as any)[node.type];
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
    // extmul instead of mul when possible
    if (node.op === 'mul' && ['u64x2', 'i64x2'].includes(node.type) && opts.optExtMul) {
      const T = fn.types[node.type] as GetOpsFnOp<any>;
      const coder = types.TypeCoders[node.type];
      const isMask32 = (idx: string) => {
        const node = as(fn.ops.get(idx), 'op');
        if (node.op !== 'const') return;
        const value = node.opts.value;
        const rawValue = coder.decode(value) as any as bigint[];
        for (const v of rawValue) if (v !== 0xffff_ffffn) return false;
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
          // NOTE: for floats: NaN * 0 = NaN, but we will return zero here.
          // a^0 = a, a | 0 = a, a + 0 = a
          if (isOp(node, 'xor', 'or', 'add') && c == 0) return A();
          // a & 0 = 0, a * 0 = 0
          if (isOp(node, 'and', 'mul') && c == 0) return T.const(0);
          // a & -1 = a, a & mask = a
          if (types.IntType.has(node.type)) {
            const mask = types.getMask(types.ScalarOf(node.type));
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
              const mask = (1n << BigInt(k)) - 1n;
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
  };
}
/**
 * Lower SIMD operations to scalar ones
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
            const byte64 = U64.and(shifted, U64.const(0xffn));
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
          let acc = U64.const(0n);
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
      const cond = prev[2]; // EXPECT per-lane mask: 0 or all-ones
      const maskType = types.maskType(node.type);
      const lmaskType = types.ScalarOf(maskType);
      const mT = fn.types[lmaskType];
      if (!a || !b || !cond) throw new Error('lowerSIMD/bitselect: missing args');
      if (!Array.isArray(cond)) throw new Error('lowerSIMD/bitselect: mask must be vector');
      const nodePrev = [];
      for (let lane = 0; lane < lanes; lane++) {
        // this would be easier to catch in optimizer after lowering
        // // out = b ^ ((a ^ b) & m)
        // const axb = fn.op(lType, 'xor', [a[lane], b[lane]]);
        // const t = fn.op(lType, 'and', [axb, m[lane]]);
        // const out = fn.op(lType, 'xor', [b[lane], t]);
        nodePrev.push(fn.op(lType, 'select', [b[lane], a[lane], mT.eqz(cond[lane])]));
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
      node.op === 'extmul_low_i8x16_s' ||
      node.op === 'extmul_low_i8x16_u' ||
      node.op === 'extmul_high_i8x16_s' ||
      node.op === 'extmul_high_i8x16_u' ||
      node.op === 'extmul_low_i16x8_s' ||
      node.op === 'extmul_low_i16x8_u' ||
      node.op === 'extmul_high_i16x8_s' ||
      node.op === 'extmul_high_i16x8_u'
    ) {
      const p = prev[0];
      const p2 = prev[1];
      if (!p) throw new Error('lowerSIMD: missing arg');
      const fromLane = node.op.includes('i8x16')
        ? node.op.endsWith('_s')
          ? 'i8'
          : 'u8'
        : node.op.endsWith('_s')
          ? 'i16'
          : 'u16';
      const start = node.op.includes('high') ? lanes : 0;
      const nodePrev = [];
      for (let i = 0; i < lanes; i++) {
        const src = p[start + i];
        if (!src) throw new Error('lowerSIMD: extend src missing');
        const a = fn.op(lType, 'smallCast', [src], { from: fromLane });
        if (node.op.startsWith('extmul_')) {
          if (!p2) throw new Error('lowerSIMD: extmul missing arg');
          const srcB = p2[start + i];
          if (!srcB) throw new Error('lowerSIMD: extmul src missing');
          const b = fn.op(lType, 'smallCast', [srcB], { from: fromLane });
          nodePrev.push(fn.op(lType, 'mul', [a, b]));
        } else {
          nodePrev.push(a);
        }
      }
      return virt(node.type, nodePrev);
    } else throw new Error(`lowerSIMD: not imeplemented! ${node.type}.${node.op}`);
  };
}

export function lowerBigIntSIMD(fn: ModuleGraph, opts: CompilerOpts = {}): Rewrite {
  return lowerSIMD(fn, opts, (type) => types.BigIntType.has(types.ScalarOf(type)));
}

// Remove no-op casts so single-use analysis sees the real producer.
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
  const normalize = (t: TypeName, v: FnOp) => {
    const { signed, width, mask } = info(t);
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
    if (isOp(node, 'nodeOutput')) return fn.op(base, 'nodeOutput', [args[0]], node.opts);
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
      throw 'not implemented';
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
        return fn.op(nativeType, 'load', [args[0]], {
          ...utils.deepClone(node.opts),
          // use32x2: node.type.endsWith('32x2'),
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
 * Lower '.shuffle' like pattern on scalars into load/store in JS for swapEndianness
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
export function lowerU64Arg(fn: ModuleGraph, _opts: CompilerOpts = {}): Rewrite {
  const normType = (inp: TypeName) => (inp === 'i64' ? 'i32' : 'u32');
  const perFn: Record<
    string,
    {
      inputsRemap?: Record<number, number | number[]>;
      outputsRemap?: Record<number, number | number[]>;
    }
  > = {};
  const remapped = new Set();
  const callArgs: Record<string, FnOp[]> = {};
  return (node, _args, idx) => {
    if (node.kind === 'function') {
      const newInputs: TypeName[] = [];
      const inputsRemap: Record<number, number | number[]> = {};
      let inputsChanged = false;
      for (let i = 0; i < node.inputs.length; i++) {
        const inp = node.inputs[i];
        if (inp === 'i64' || inp === 'u64') {
          newInputs.push(normType(inp));
          newInputs.push(normType(inp));
          inputsRemap[i] = [newInputs.length - 2, newInputs.length - 1]; // low, high
          inputsChanged = true;
        } else {
          newInputs.push(inp);
          inputsRemap[i] = newInputs.length - 1;
        }
      }
      // Fix outputs
      const newOutputs: NodeIdx[] = [];
      const outputsRemap: Record<NodeIdx, number | number[]> = {};
      let outputsChanged = false;
      for (let i = 0; i < node.outputs.length; i++) {
        const out = node.outputs[i];
        const n = fn.ops.get(out);
        const retType = types.nodeRetType(fn, fn.byIdx(out));
        if (n.kind === 'op' && ['i64', 'u64'].includes(retType)) {
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
        inputsRemap: inputsChanged ? inputsRemap : undefined,
        outputsRemap: outputsChanged ? outputsRemap : undefined,
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
        if (remapped.has(node)) return;
        const t = callArgs[node.args[0]];
        if (!t) return;
        if (!t[node.opts.pos]) throw new Error('cannot find call arg');
        remapped.add(node);
        return t[node.opts.pos];
      } else if (node.op === 'call') {
        if (remapped.has(node)) return;
        if (!perFn[node.opts.name]) return;
        const { inputsRemap, outputsRemap } = perFn[node.opts.name];
        // Fix call args
        if (inputsRemap) {
          const newArgs = [];
          for (let i = 0; i < node.args.length; i++) {
            const map = inputsRemap[i];
            if (Array.isArray(map)) {
              const prevArg = node.args[i];
              const prevType = as(fn.ops.get(prevArg), 'op').type;
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
            const curType = node.opts.outTypes[i];
            if (Array.isArray(map)) {
              newOutTypes.push(normType(curType), normType(curType));
              const l = fn.op(normType(curType), 'nodeOutput', [fn.byIdx(idx)], { pos: map[0] });
              const h = fn.op(normType(curType), 'nodeOutput', [fn.byIdx(idx)], { pos: map[1] });
              const T = (fn.types as any)[curType];
              newCallArgs.push(T.fromN(normType(curType), [l, h]));
            } else {
              newOutTypes.push(node.opts.outTypes[map]);
              const type = node.opts.outTypes[map];
              newCallArgs.push(fn.op(type, 'nodeOutput', [fn.byIdx(idx)], { pos: map }));
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
        let lanes = types.lanesOf(node.type);
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
        const S = T.const(0x8000_0000_0000_0000n);
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
    let value = args[0];
    if (types.FloatType.has(node.type))
      value = U.fromN(iType, fn.op(iType, `reinterpret_${node.type}`, [value]));
    else if (node.type !== uType) value = U.fromN(node.type, value);
    let acc = U.const(0);
    for (let outByte = 0; outByte < size; outByte++) {
      let b = U.and(U.shr(value, pattern[outByte] * 8), U.const(0xff));
      if (outByte) b = U.shl(b, outByte * 8);
      acc = outByte ? U.or(acc, b) : b;
    }
    if (types.FloatType.has(node.type))
      return fn.op(node.type, `reinterpret_${iType}`, [U.toN(iType, acc)]);
    else if (node.type !== uType) return T.fromN(uType, acc);
    return acc;
  };
}
