import * as types from './types.ts';
import type { TypeName } from './types.ts';

export type Bits = { known: bigint; value: bigint };
export type Range = { min: bigint; max: bigint };
export type Fact = { bits?: Bits; range?: Range };
type SignExtend = { value: string; shift: bigint; type: TypeName };

type Op = {
  kind: 'op';
  op: string;
  type: TypeName;
  args: string[];
  opts: Record<string, any>;
  fact?: Fact;
};
type GraphNode = {
  kind: string;
  fact?: Fact;
  op?: string;
  type?: TypeName;
  args?: string[];
  opts?: Record<string, any>;
};
type Graph = { ops: { get(idx: string): GraphNode } };
type Ranges = (Range | undefined)[];
type RangeOp = (type: TypeName, args: Ranges) => Range | undefined;

const _0n = BigInt(0),
  _1n = BigInt(1),
  _32n = BigInt(32);

const retType = (node: Op): TypeName => {
  if (types.opsCompare.has(node.op)) return types.maskType(node.type);
  if (node.op === 'extract_lane') return types.ScalarOf(node.type);
  if (node.op === 'reinterpret_i32') return 'f32';
  if (node.op === 'reinterpret_i64') return 'f64';
  if (node.op === 'to_i32_low' || node.op === 'to_i32_high') return node.opts.type as TypeName;
  return node.type;
};
const scalarInt = (type: TypeName) => types.IntType.has(type) && types.ScalarType.has(type);
const width = (type: TypeName) => types.sizeof(type) * 8;
const full = (type: TypeName) => (_1n << BigInt(width(type))) - _1n;
const cleanBits = (type: TypeName, bits: Bits): Bits => {
  const mask = full(type);
  const known = bits.known & mask;
  return { known, value: bits.value & known & mask };
};
const bits = (type: TypeName, known: bigint, value: bigint): Fact => {
  const b = cleanBits(type, { known, value });
  return { bits: b, range: rangeFromBits(type, b) };
};
const exact = (type: TypeName, value: number | bigint): Fact => {
  const raw = BigInt(value);
  const v = BigInt.asUintN(width(type), raw);
  // Ranges follow the typed comparison domain; bits stay in unsigned storage form.
  const r = types.SignedType.has(type) ? BigInt.asIntN(width(type), raw) : v;
  return { bits: { known: full(type), value: v }, range: { min: r, max: r } };
};
const intRange = (bits: bigint): Range => ({
  min: -(_1n << (bits - _1n)),
  max: (_1n << (bits - _1n)) - _1n,
});
const typeRange = (type: TypeName): Range => {
  if (!types.SignedType.has(type)) return { min: _0n, max: full(type) };
  return intRange(BigInt(width(type)));
};
const rangeFromBits = (type: TypeName, b: Bits): Range | undefined => {
  if (types.SignedType.has(type)) return;
  const mask = full(type);
  const one = b.known & b.value;
  const unknown = mask & ~b.known;
  return { min: one, max: one | unknown };
};
const opNode = (fn: Graph, idx: string): Op | undefined => {
  const node = fn.ops.get(idx);
  return node.kind === 'op' ? (node as Op) : undefined;
};
const get = (fn: Graph, idx: string): Fact | undefined => opNode(fn, idx)?.fact;
const typeWeight = (type?: TypeName) => {
  if (!type) return 1;
  if (types.SIMDType.has(type) || /x\d+$/.test(type)) return 4;
  if (type === 'i64' || type === 'u64' || type === 'f64') return 2;
  return 1;
};
const constValue = (fn: Graph, idx: string): bigint | undefined => {
  const node = opNode(fn, idx);
  if (!node) return;
  if (node.op === 'const') return BigInt(node.opts.value);
  const b = node.fact?.bits;
  return b && b.known === full(node.type) ? b.value : undefined;
};
const intersect = (type: TypeName, a: Bits, b: Bits): Bits => {
  const known = a.known & b.known & ~(a.value ^ b.value);
  return cleanBits(type, { known, value: a.value & known });
};
const unionRange = (a?: Range, b?: Range): Range | undefined => {
  if (!a || !b) return;
  return { min: a.min < b.min ? a.min : b.min, max: a.max > b.max ? a.max : b.max };
};
const foldRange = (type: TypeName, args: Ranges, mul = false): Range | undefined => {
  if (types.SignedType.has(type)) return;
  let min = mul ? _1n : _0n;
  let max = min;
  for (const r of args) {
    if (!r || r.min < _0n) return;
    min = mul ? min * r.min : min + r.min;
    max = mul ? max * r.max : max + r.max;
    // Folded range facts are valid only when the result is proven not to wrap.
    if (max > full(type)) return;
  }
  return { min, max };
};
const binaryRange = (
  type: TypeName,
  args: Ranges,
  op: 'sub' | 'div' | 'rem'
): Range | undefined => {
  if (types.SignedType.has(type) || args.length !== 2) return;
  const [a, b] = args;
  if (!a || !b || a.min < _0n || b.min < _0n) return;
  if (op === 'sub') {
    if (a.min < b.max) return;
    return { min: a.min - b.max, max: a.max - b.min };
  }
  // Division facts must not reason through the trapping zero-divisor path.
  if (b.min <= _0n) return;
  if (op === 'div') return { min: a.min / b.max, max: a.max / b.min };
  // Remainder is below both the dividend maximum and the nonzero divisor maximum.
  const max = a.max < b.max ? a.max : b.max - _1n;
  return { min: _0n, max };
};
const shift = (type: TypeName, a: Bits, n: bigint, op: string): Bits => {
  const w = BigInt(width(type));
  const s = Number(n & (w - _1n));
  const mask = full(type);
  if (s === 0) return cleanBits(type, a);
  if (op === 'shl') {
    const low = (_1n << BigInt(s)) - _1n;
    return cleanBits(type, { known: (a.known << BigInt(s)) | low, value: a.value << BigInt(s) });
  }
  const high = mask ^ ((mask >> BigInt(s)) & mask);
  if (!types.SignedType.has(type)) {
    return cleanBits(type, { known: (a.known >> BigInt(s)) | high, value: a.value >> BigInt(s) });
  }
  const sign = _1n << (w - _1n);
  const signKnown = !!(a.known & sign);
  const signOne = !!(a.value & sign);
  return cleanBits(type, {
    known: (a.known >> BigInt(s)) | (signKnown ? high : _0n),
    value: (a.value >> BigInt(s)) | (signKnown && signOne ? high : _0n),
  });
};
const rotate = (type: TypeName, a: Bits, n: bigint, left: boolean): Bits => {
  const w = BigInt(width(type));
  const s = n & (w - _1n);
  const mask = full(type);
  if (s === _0n) return cleanBits(type, a);
  const l = left ? s : w - s;
  const r = w - l;
  return cleanBits(type, {
    known: ((a.known << l) | (a.known >> r)) & mask,
    value: ((a.value << l) | (a.value >> r)) & mask,
  });
};
const bitwise = (type: TypeName, op: string, args: (Bits | undefined)[]): Fact | undefined => {
  const mask = full(type);
  if (op === 'xor') {
    let known = mask;
    let value = _0n;
    for (const a of args) {
      if (!a) return bits(type, _0n, _0n);
      known &= a.known;
      value ^= a.value;
    }
    return bits(type, known, value);
  }
  if (op !== 'and' && op !== 'or') return;
  const and = op === 'and';
  let one = and ? mask : _0n;
  let zero = and ? _0n : mask;
  for (const a of args) {
    const ones = a ? a.known & a.value : _0n;
    const zeros = a ? a.known & ~a.value : _0n;
    one = and ? one & ones : one | ones;
    zero = and ? zero | zeros : zero & zeros;
  }
  return bits(type, one | zero, one);
};
const load = (type: TypeName, node: Op): Fact | undefined => {
  const bits = width(type);
  const size = node.opts.size || bits;
  if (typeof size !== 'number' || size <= 0 || size > bits) return;
  if (size === bits) return { range: typeRange(type) };
  if (types.SignedType.has(type)) return { range: intRange(BigInt(size)) };
  const low = (_1n << BigInt(size)) - _1n;
  return {
    bits: cleanBits(type, { known: full(type) ^ low, value: _0n }),
    range: { min: _0n, max: low },
  };
};
const signedRange = (type: TypeName, shift: bigint): Range => intRange(BigInt(width(type)) - shift);
const signExtend = (
  fn: Graph,
  type: TypeName,
  node: Op,
  value = (idx: string) => constValue(fn, idx)
): SignExtend | undefined => {
  if (node.op !== 'shr' || !types.SignedType.has(type) || !types.ScalarType.has(type)) return;
  const shift = value(node.args[1]);
  const src = opNode(fn, node.args[0]);
  if (shift === undefined || !src || src.op !== 'shl' || src.type !== type) return;
  const left = value(src.args[1]);
  const w = BigInt(width(type));
  const s = shift & (w - _1n);
  if (left === undefined || (left & (w - _1n)) !== s || s === _0n) return;
  return { value: src.args[0], shift: s, type };
};
// Operation names are caller-provided, so inherited object keys must not dispatch range logic.
const rangeOps = new Map<string, RangeOp>();
for (const op of ['add', 'mul'])
  rangeOps.set(op, (type, args) => foldRange(type, args, op === 'mul'));
for (const op of ['sub', 'div', 'rem'] as const)
  rangeOps.set(op, (type, args) => binaryRange(type, args, op));

export const infer = (fn: Graph, node: Op): Fact | undefined => {
  const type = retType(node);
  if (!scalarInt(type)) return;
  if (types.opsCompare.has(node.op)) return bits('u32', full('u32') ^ _1n, _0n);
  if (node.op === 'const') return exact(type, node.opts.value);
  if (node.op === 'arg') {
    const scope = node.opts.scope;
    if (typeof scope === 'string') {
      const parent = fn.ops.get(scope);
      // Block entry args are aliases for the fixed input values; loop args are updated by backedges.
      if (parent.kind === 'block' && parent.args)
        return get(fn, parent.args[node.opts.pos]) || { range: typeRange(type) };
    }
    return { range: typeRange(type) };
  }
  if (node.op === 'load') return load(type, node);
  if (node.op === 'clz' || node.op === 'ctz' || node.op === 'popcnt')
    return { range: { min: _0n, max: BigInt(width(type)) } };
  const range = rangeOps.get(node.op)?.(
    type,
    node.args.map((idx) => get(fn, idx)?.range)
  );
  if (range) return { range };
  const signed = signExtend(fn, type, node);
  if (signed) return { range: signedRange(type, signed.shift) };
  const args = node.args.map((idx) => get(fn, idx)?.bits);
  if (node.op === 'and' || node.op === 'or' || node.op === 'xor')
    return bitwise(type, node.op, args);
  if (node.op === 'not' && args[0]) return bits(type, args[0].known, ~args[0].value);
  const shifting = node.op === 'shl' || node.op === 'shr';
  if (shifting || node.op === 'rotl' || node.op === 'rotr') {
    const n = constValue(fn, node.args[1]);
    if (n !== undefined && (shifting || args[0])) {
      const a = args[0] || { known: _0n, value: _0n };
      const out = shifting ? shift(type, a, n, node.op) : rotate(type, a, n, node.op === 'rotl');
      return bits(type, out.known, out.value);
    }
  }
  if (node.op === 'select') {
    const a = get(fn, node.args[0]);
    const b = get(fn, node.args[1]);
    const out: Fact = { range: unionRange(a?.range, b?.range) };
    if (a?.bits && b?.bits) out.bits = intersect(type, a.bits, b.bits);
    return out.bits || out.range ? out : undefined;
  }
  if ((node.op === 'cast' || node.op === 'smallCast' || node.op === 'wrap_i64') && args[0])
    return bits(type, args[0].known, args[0].value);
  if ((node.op === 'extend_i32_u' || node.op === 'extend_i32_s') && args[0]) {
    const low = (_1n << _32n) - _1n;
    if (node.op === 'extend_i32_u')
      return bits(type, (args[0].known & low) | (full(type) ^ low), args[0].value & low);
    const sign = _1n << BigInt(31);
    const high = full(type) ^ low;
    const signKnown = !!(args[0].known & sign);
    const signOne = !!(args[0].value & sign);
    return bits(
      type,
      (args[0].known & low) | (signKnown ? high : _0n),
      args[0].value | (signKnown && signOne ? high : _0n)
    );
  }
  return;
};

export const weight = (fn: Graph) => {
  const memo: Record<string, number> = {};
  const active = new Set<string>();
  const calc = (idx: string): number => {
    const cached = memo[idx];
    if (cached !== undefined) return cached;
    if (active.has(idx)) return 1;
    active.add(idx);
    const node = fn.ops.get(idx);
    let res = 1;
    if (node.kind === 'op') {
      const op = node as Op;
      if (op.op === 'cast' && op.args[0]) res = calc(op.args[0]);
      else {
        // Max-child cost avoids double-counting shared cones in scheduling decisions.
        let child = 0;
        for (const arg of op.args) child = Math.max(child, calc(arg));
        res = (op.op === 'const' ? 0 : typeWeight(op.type)) + child;
      }
    }
    active.delete(idx);
    memo[idx] = res;
    return res;
  };
  return calc;
};

export const __TEST = { full, retType, typeWeight };
