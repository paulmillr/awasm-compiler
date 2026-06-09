// Small runtime executor
// Runs stull in runtime instead of compilation. Useful for debug and if
// you want to run module in very slow mode without compilation
import type { TArg } from '@scure/base';
import * as P from 'micro-packed';
import type { CompilerOpts, ModuleGraph } from './codegen.ts';
import { allocateMemSpec, memoryProxy } from './memory.ts';
import { Module, array } from './module.ts';
import type { TypeName } from './types.ts';
import * as types from './types.ts';
import { IntType, ScalarType, SignedType, Width64, opsForType } from './types.ts';

const _32n = /* @__PURE__ */ BigInt(32);
const U32_MASK_N = /* @__PURE__ */ BigInt(0xffffffff);

const split64 = (signed: boolean, x: bigint): { r0: number; r1: number } => {
  const u = BigInt.asUintN(64, x);
  const lo = Number(u & U32_MASK_N) >>> 0;
  const hiU = Number((u >> _32n) & U32_MASK_N) >>> 0;
  return { r0: lo, r1: signed ? hiU | 0 : hiU };
};
/**
 * Runtime version of 'types.ts/genType'
 */
function getTypes(mod: any) {
  const typeRes: Record<string, any> = {};
  const convert: Record<any, any> = {};
  const addConvert = (aType: TypeName, bType: TypeName, fn: any) => {
    if (!convert[aType]) convert[aType] = {};
    convert[aType][bType] = fn;
  };
  const noopArr = (x: any) => [x];
  const noop = (x: any) => x;
  for (const aType of ScalarType) {
    for (const bType of ScalarType) {
      if (aType === bType) addConvert(aType, bType, noopArr);
      else {
        addConvert(aType, bType, (value: any) => {
          if (
            IntType.has(aType) &&
            IntType.has(bType) &&
            !Width64.has(aType) &&
            !Width64.has(bType)
          ) {
            const sizeFrom = types.sizeof(bType);
            const sizeTo = types.sizeof(aType);
            if (sizeFrom > sizeTo && sizeFrom % sizeTo === 0) {
              if (Array.isArray(value)) throw new Error('split: array value not supported');
              const widthFrom = sizeFrom * 8;
              const widthTo = sizeTo * 8;
              const maskFrom = widthFrom === 32 ? 0xffffffff : (1 << widthFrom) - 1;
              const maskTo = widthTo === 32 ? 0xffffffff : (1 << widthTo) - 1;
              const u = (value >>> 0) & maskFrom;
              const parts = [];
              const count = sizeFrom / sizeTo;
              for (let i = 0; i < count; i++) {
                let part = (u >>> (i * widthTo)) & maskTo;
                if (SignedType.has(aType) && widthTo < 32)
                  part = (part << (32 - widthTo)) >> (32 - widthTo);
                parts.push(part);
              }
              return parts;
            }
          }
          if (
            IntType.has(aType) &&
            IntType.has(bType) &&
            Width64.has(bType) &&
            !Width64.has(aType)
          ) {
            if (Array.isArray(value)) throw new Error('split: array value not supported');
            const sizeFrom = types.sizeof(bType);
            const sizeTo = types.sizeof(aType);
            if (sizeFrom > sizeTo && sizeFrom % sizeTo === 0) {
              const widthTo = sizeTo * 8;
              const parts = [];
              const count = sizeFrom / sizeTo;
              for (let i = 0; i < count; i++) {
                const word = i < count / 2 ? value.r0 >>> 0 : value.r1 >>> 0;
                const shift = (i % (count / 2)) * widthTo;
                let part = widthTo === 32 ? word : (word >>> shift) & ((1 << widthTo) - 1);
                if (SignedType.has(aType) && widthTo < 32)
                  part = (part << (32 - widthTo)) >> (32 - widthTo);
                else if (SignedType.has(aType) && widthTo === 32) part = part | 0;
                else if (!SignedType.has(aType) && widthTo === 32) part = part >>> 0;
                parts.push(part);
              }
              return parts;
            }
          }
          if (
            Width64.has(aType) &&
            IntType.has(aType) &&
            Array.isArray(value) &&
            value.length === 2 &&
            (bType === 'i32' || bType === 'u32')
          ) {
            const r0 = value[0] >>> 0;
            const r1 = SignedType.has(aType) ? value[1] | 0 : value[1] >>> 0;
            return [{ r0, r1 }];
          }
          const fn = mod[`${aType}_from_${bType}`];
          let args = Array.isArray(value) ? value : [value];
          if (Width64.has(bType)) args = args.map((i) => [i.r0, i.r1]).flat() as any;
          let res = fn(...args);
          if (Width64.has(aType)) return [res];
          if (typeof res === 'number') return [res];
          return [res.r0, res.r1];
        });
      }
      for (const lanes of [2, 4, 8, 16]) {
        const bTypeVec = `${bType}x${lanes}` as TypeName;
        if (!types.SIMDType.has(bTypeVec)) continue;
        if (aType === bType) {
          addConvert(aType, bTypeVec, noop);
          addConvert(bTypeVec, aType, (x: any) => [new Array(lanes).fill(x)]);
        } else {
          addConvert(aType, bTypeVec, (x: number[]) =>
            x.map((i) => convert[aType][bType](i)).flat()
          );
          addConvert(bTypeVec, aType, (x: any) => [
            new Array(lanes).fill(convert[bType][aType](x)[0]),
          ]);
        }
      }
    }
  }
  for (const aType of ScalarType) {
    for (const bType of ScalarType) {
      for (const lanes of [2, 4, 8, 16]) {
        const aVec = `${aType}x${lanes}` as TypeName;
        const bVec = `${bType}x${lanes}` as TypeName;
        if (!types.SIMDType.has(aVec) || !types.SIMDType.has(bVec)) continue;
        addConvert(aVec, bVec, (x: any[]) => {
          if (x.length === 0) return [];
          const first = convert[aType][bType](x[0]);
          const count = first.length;
          if (count === 1) return [x.map((i) => convert[aType][bType](i)[0])];
          const parts = new Array(count);
          for (let i = 0; i < count; i++) parts[i] = new Array(lanes);
          for (let j = 0; j < lanes; j++) {
            const res = convert[aType][bType](x[j]);
            for (let i = 0; i < count; i++) parts[i][j] = res[i];
          }
          return parts;
        });
      }
    }
  }
  const addSimdExtend = (fromType: TypeName, toType: TypeName) => {
    if (!types.SIMDType.has(fromType) || !types.SIMDType.has(toType)) return;
    const lanesFrom = types.lanesOf(fromType);
    const lanesTo = types.lanesOf(toType);
    const fromLane = types.ScalarOf(fromType);
    const toLane = types.ScalarOf(toType);
    if (lanesFrom !== lanesTo * 2) return;
    if (types.sizeof(toLane) !== types.sizeof(fromLane) * 2) return;
    if (!convert[toLane] || !convert[toLane][fromLane]) return;
    if (convert[toType] && convert[toType][fromType]) return;
    addConvert(toType, fromType, (x: any[]) => {
      const conv = convert[toLane][fromLane];
      const lo = new Array(lanesTo);
      const hi = new Array(lanesTo);
      for (let i = 0; i < lanesTo; i++) {
        lo[i] = conv(x[i])[0];
        hi[i] = conv(x[i + lanesTo])[0];
      }
      return [lo, hi];
    });
  };
  addSimdExtend('i8x16', 'i16x8');
  addSimdExtend('u8x16', 'u16x8');
  addSimdExtend('i16x8', 'i32x4');
  addSimdExtend('u16x8', 'u32x4');
  const castConv = (toType: TypeName, fromType: TypeName, value: any) => {
    if (fromType === toType) return [value];
    const fn = mod[`${toType}_cast_${fromType}`];
    if (!fn) throw new Error(`cast(${fromType} -> ${toType}): missing op`);
    let args = Array.isArray(value) ? value : [value];
    if (Width64.has(fromType) && IntType.has(fromType))
      args = args.map((i) => [i.r0, i.r1]).flat() as any;
    let res = fn(...args);
    if (Width64.has(toType) && IntType.has(toType)) return [res];
    if (typeof res === 'number') return [res];
    return [res.r0, res.r1];
  };
  const castVec = (fromType: TypeName, toType: TypeName, value: any[]) => {
    if (!Array.isArray(value)) throw new Error(`cast(${fromType} -> ${toType}): expected vector`);
    const fromLane = types.ScalarOf(fromType);
    const toLane = types.ScalarOf(toType);
    if (types.sizeof(fromLane) !== types.sizeof(toLane))
      throw new Error(`cast(${fromType} -> ${toType}): size mismatch`);
    const fromLanes = types.lanesOf(fromType);
    const toLanes = types.lanesOf(toType);
    let out = value.map((v) => castConv(toLane, fromLane, v)[0]);
    if (toLanes > fromLanes) {
      const zero = Width64.has(toLane) && IntType.has(toLane) ? { r0: 0, r1: 0 } : 0;
      for (let i = out.length; i < toLanes; i++) out.push(zero);
    } else if (toLanes < fromLanes) out = out.slice(0, toLanes);
    return out;
  };

  for (const typeName of ScalarType) {
    const is64 = Width64.has(typeName) && IntType.has(typeName);
    const isSigned = SignedType.has(typeName);
    let _const = (i: number) => i;
    if (is64) _const = (i: number) => split64(isSigned, BigInt(i)) as any;
    const res: Record<string, any> = {};
    for (const op of opsForType(typeName)) {
      const fn = mod[`${typeName}_${op}`];
      if (is64) {
        if (types.opsShifts.has(op)) res[op] = (A: any, shift: number) => fn(A.r0, A.r1, shift);
        else if (types.opsVariadic.has(op))
          res[op] = (...args: any) =>
            args.reduceRight((A: any, B: any) => fn(A.r0, A.r1, B.r0, B.r1));
        else if (types.ops2Arg.has(op)) res[op] = (A: any, B: any) => fn(A.r0, A.r1, B.r0, B.r1);
        else if (types.ops1Arg.has(op)) res[op] = (A: any) => fn(A.r0, A.r1);
      } else {
        res[op] = types.opsVariadic.has(op)
          ? (...args: number[]) => args.reduceRight((a: number, b: number) => fn(a, b))
          : fn;
      }
    }
    if (typeName === 'i8' || typeName === 'u8') res.swapEndianness = (A: number) => A;
    if (typeName === 'i16' || typeName === 'u16') {
      res.swapEndianness = (A: number) => {
        const v = ((A & 0xff) << 8) | ((A >>> 8) & 0xff);
        return typeName === 'i16' ? (v << 16) >> 16 : v & 0xffff;
      };
    }
    const T = Object.freeze({
      name: typeName,
      const: _const,
      select: (cond: number, a: number, b: number) => (cond ? a : b),
      laneOffsets: (offset: number = 0) => _const(offset),
      from: (oType: any, value: any) => convert[typeName][oType](value),
      fromN: (oType: any, value: any) => convert[typeName][oType](value)[0],
      to: (oType: any, value: any) => convert[oType][typeName](value),
      toN: (oType: any, value: any) => convert[oType][typeName](value)[0],
      castFrom: (fromType: TypeName, value: any) => castConv(typeName, fromType, value)[0],
      castTo: (toType: TypeName, value: any) => castConv(toType, typeName, value)[0],
      ...res,
    }) as any;
    typeRes[typeName] = T;
    // Goal here is to re-use basic types to create SIMD stuff on top (so we don't generate in typeMod)
    for (const lanes of [2, 4, 8, 16]) {
      const vTypeName = `${typeName}x${lanes}` as TypeName;
      if (!types.SIMDType.has(vTypeName)) continue;
      const lanesArr = new Array(lanes).fill(1);
      const rol = (v: any[], k: number) => {
        const n = v.length;
        if (!n) return [];
        k %= n;
        if (k < 0) k += n;
        return k ? v.slice(k).concat(v.slice(0, k)) : v.slice();
      };
      const res: Record<string, any> = {};
      const isI64Lane = types.Width64.has(vTypeName) && types.IntType.has(vTypeName);
      const laneSigned = isI64Lane && SignedType.has(vTypeName);
      const encodeVals = (vals: any[]) => {
        if (!isI64Lane) return types.TypeCoders[vTypeName].encode(vals as any);
        const bigs = vals.map((v) =>
          laneSigned
            ? BigInt.asIntN(64, (BigInt(v.r1) << _32n) | BigInt(v.r0 >>> 0))
            : BigInt.asUintN(64, (BigInt(v.r1) << _32n) | BigInt(v.r0 >>> 0))
        );
        return types.TypeCoders[vTypeName].encode(bigs as any);
      };
      const decodeVals = (bytes: TArg<Uint8Array>) => {
        const vals = types.TypeCoders[vTypeName].decode(bytes as any);
        if (!isI64Lane) return vals;
        return vals.map((v: bigint) => split64(laneSigned, v));
      };
      const maskVecType = types.maskType(vTypeName);
      const maskLaneType = types.ScalarOf(maskVecType);
      const maskIs64 = Width64.has(maskLaneType);
      const MASK_TRUE = maskIs64 ? { r0: 0xffff_ffff, r1: 0xffff_ffff } : 0xffffffff;
      const MASK_FALSE = maskIs64 ? { r0: 0, r1: 0 } : 0;
      const checkLane = (lane: number) => types.SIMDUtils.checkLane(lanes, lane);
      for (const op of opsForType(vTypeName)) {
        if (op === 'swapEndianness') {
          if (types.Width8.has(vTypeName)) {
            res[op] = (A: number[]) => A.slice();
            continue;
          }
          const mask = types.Width16.has(vTypeName)
            ? Array.from({ length: 16 }, (_, i) => i ^ 1)
            : types.SIMDUtils.MASKS[types.Width32.has(vTypeName) ? '32x4' : '64x2'].reverseBytes;
          res[op] = (A: number[]) => {
            const bytes = encodeVals(A as any);
            const out = new Uint8Array(bytes.length);
            // Handle virtual SIMD sizes so decode sees exact byte length.
            if (bytes.length <= mask.length) {
              const m = mask.slice(0, bytes.length);
              for (let i = 0; i < m.length; i++) out[i] = bytes[m[i]];
            } else {
              for (let i = 0; i < bytes.length; i++) {
                const src = Math.floor(i / 16) * 16 + mask[i % 16];
                if (src < bytes.length) out[i] = bytes[src];
              }
            }
            return decodeVals(out);
          };
          continue;
        }
        const curOp = T[op];
        const toMaskLane = (x: any) => (x ? MASK_TRUE : MASK_FALSE);
        if (types.opsCompare.has(op)) {
          if (types.ops2Arg.has(op))
            res[op] = (A: number[], B: number[]) => A.map((a, j) => toMaskLane(curOp(a, B[j])));
          else if (types.ops1Arg.has(op))
            res[op] = (A: number[]) => A.map((a) => toMaskLane(curOp(a)));
        } else if (types.opsVariadic.has(op))
          res[op] = (...args: any) =>
            args.reduceRight((A: number[], B: number[]) => A.map((i, j) => curOp(i, B[j])));
        else if (types.opsShifts.has(op))
          res[op] = (value: number[], shift: number) => value.map((i) => curOp(i, shift));
        else if (types.ops2Arg.has(op))
          res[op] = (A: number[], B: number[]) => A.map((i, j) => curOp(i, B[j]));
        else if (types.ops1Arg.has(op)) res[op] = (A: number[]) => A.map(curOp);
      }
      let select = (cond: number, a: number, b: number) => {
        // simd masks
        if (Array.isArray(cond)) return cond.map((i, j) => (i ? (a as any)[j] : (b as any)[j]));
        return cond ? a : b;
      };
      if (maskIs64) {
        select = (cond: number, a: number, b: number) => {
          // simd masks
          if (Array.isArray(cond))
            return cond.map((i, j) => (i.r0 || i.r1 ? (a as any)[j] : (b as any)[j]));
          return cond ? a : b;
        };
      }
      const virt: Record<string, number> = {};
      const minLanes = types.lanesOf(types.minSimdType(typeName));
      if (minLanes < lanes) virt.pairCount = lanes / minLanes;
      else if (minLanes > lanes) virt.maskCount = lanes;
      const constVec = (a: any) => {
        // Runtime const should accept vector literals (arrays), not just splats.
        if (Array.isArray(a)) {
          return a.map((v) => (isI64Lane && typeof v === 'object' ? v : T.const(v)));
        }
        return lanesArr.map((_i) => T.const(a));
      };
      typeRes[vTypeName] = Object.freeze({
        name: vTypeName,
        // TODO: add simd cond support?
        const: constVec,
        select,
        from: (oType: any, value: any) => convert[vTypeName][oType](value),
        fromN: (oType: any, value: any) => convert[vTypeName][oType](value)[0],
        to: (oType: any, value: any) => convert[oType][vTypeName](value),
        toN: (oType: any, value: any) => convert[oType][vTypeName](value)[0],
        castFrom: (fromType: TypeName, value: any) => castVec(fromType, vTypeName, value),
        castTo: (toType: TypeName, value: any) => castVec(vTypeName, toType, value),
        ...res,
        ...virt,
        laneOffsets: (offset = 0) => lanesArr.map((_i, j) => T.const(offset + j)),
        splat: (x: number) => new Array(lanes).fill(x),
        extractLane: (val: any[], idx: number) => val[checkLane(idx)],
        replaceLane: (val: any[], idx: number, value: any) => {
          const res = Array.from(val);
          res[checkLane(idx)] = value;
          return res;
        },
        interleave: (vectors: any[]) => {
          const vecCount = vectors.length / lanes;
          const out = [];
          for (let i = 0; i < vecCount; i++) {
            for (let r = 0; r < lanes; r++) {
              const vec = new Array(lanes);
              for (let c = 0; c < lanes; c++) vec[c] = vectors[c * vecCount + i][r];
              out.push(vec);
            }
          }
          return out;
        },
        deinterleave: (vectors: any[]) => {
          const streams = new Array(lanes).fill(0).map(() => [] as any[]);
          for (let i = 0; i < vectors.length; i += lanes) {
            for (let r = 0; r < lanes; r++) {
              const vec = new Array(lanes);
              for (let c = 0; c < lanes; c++) vec[c] = vectors[i + c][r];
              streams[r].push(vec);
            }
          }
          return streams.flat();
        },
        rol,
        ror: (v: any[], k: number) => rol(v, -k),
        shuffleLanes: (lhs: any[], rhs: any[], pattern: number[]) => {
          const concat = lhs.concat(rhs);
          return pattern.map((i) => concat[types.SIMDUtils.checkLane(lanes * 2, i)]);
        },
        swizzle: (lhs: any[], mask: any[]) => {
          // Byte-level swizzle with per-16B chunk semantics, matching i8x16.swizzle.
          const bytes = encodeVals(lhs as any);
          const maskBytes = types.TypeCoders.u8x16.encode(mask as any);
          const out = new Uint8Array(bytes.length);
          for (let i = 0; i < out.length; i++) {
            const m = maskBytes[i % 16];
            if (m >= 16) continue;
            const src = Math.floor(i / 16) * 16 + m;
            if (src < bytes.length) out[i] = bytes[src];
          }
          return decodeVals(out);
        },
        shuffle: (lhs: any[], rhs: any[], pattern: number[]) => {
          const a = encodeVals(lhs as any);
          const b = encodeVals(rhs as any);
          if (pattern.length !== a.length) throw new Error('shuffle: wrong pattern length');
          const src = new Uint8Array(a.length + b.length);
          src.set(a);
          src.set(b, a.length);
          const out = new Uint8Array(a.length);
          for (let i = 0; i < pattern.length; i++) {
            const p = pattern[i];
            if (!Number.isInteger(p) || p < 0 || p >= src.length)
              throw new Error('shuffle: wrong pattern index');
            out[i] = src[p];
          }
          return decodeVals(out);
        },
      });
    }
  }
  return Object.freeze(typeRes);
}

const getPosLanes = (region: any, pos?: number) => {
  if (pos === undefined) pos = region.pos;
  const lanes = region.lanes && region.lanes.offset !== undefined ? region.lanes.lanes : 1;
  const offset = region.lanes && region.lanes.offset !== undefined ? region.lanes.offset : 0;
  const res = [];
  for (let i = 0; i < lanes; i++) res.push(pos! + i * offset);
  return res;
};
/**
 * Runtime version of 'memory.ts/memOps'
 */
function memOps(
  { view, buf }: TArg<{ view: DataView; buf: Uint8Array }>,
  f: ModuleGraph,
  name: string,
  region: any,
  path: (number | string)[]
): any {
  const res: Record<string, any> = { name, path, region };
  const { i64 } = f.types;

  function load(type: TypeName, pos: number, opts: any = {}, swapEndianess = false): any {
    // 1. Scalar Path
    if (types.ScalarType.has(type)) {
      const isSigned = SignedType.has(type);
      let res;
      if (opts.size === 8 && isSigned) res = view.getInt8(pos);
      else if (opts.size === 8 && !isSigned) res = view.getUint8(pos);
      else if (opts.size === 16 && isSigned) res = view.getInt16(pos, !swapEndianess);
      else if (opts.size === 16 && !isSigned) res = view.getUint16(pos, !swapEndianess);
      else if (type === 'i8') res = view.getInt8(pos);
      else if (type === 'u8') res = view.getUint8(pos);
      else if (type === 'i16') res = view.getInt16(pos, !swapEndianess);
      else if (type === 'u16') res = view.getUint16(pos, !swapEndianess);
      else if (type === 'i32' || (opts.size === 32 && isSigned))
        res = view.getInt32(pos, !swapEndianess);
      else if (type === 'u32' || (opts.size === 32 && !isSigned))
        res = view.getUint32(pos, !swapEndianess);
      else if (type === 'f32') res = view.getFloat32(pos, !swapEndianess);
      else if (type === 'f64') res = view.getFloat64(pos, !swapEndianess);
      else if (type === 'i64' || type === 'u64') {
        const lPos = !swapEndianess ? pos : pos + 4;
        const hPos = !swapEndianess ? pos + 4 : pos;
        const l = view.getUint32(lPos, !swapEndianess);
        const h =
          type === 'i64'
            ? view.getInt32(hPos, !swapEndianess)
            : view.getUint32(hPos, !swapEndianess);
        return { r0: l, r1: h };
      }
      return res;
    }
    // 2. SIMD Path
    const lanes = types.lanesOf(type);
    const scalarType = types.ScalarOf(type);
    const step = types.sizeof(scalarType);
    const res = new Array(lanes);
    for (let i = 0; i < lanes; i++) {
      res[i] = load(scalarType, pos + i * step, opts, swapEndianess);
    }
    return res;
  }

  function store(type: TypeName, pos: number, val: any, opts: any = {}, swapEndianess = false) {
    // 1. Scalar Path
    if (types.ScalarType.has(type)) {
      if (type === 'i64' || type === 'u64') {
        if (opts.size === 8 || opts.size === 16 || opts.size === 32) val = val.r0;
        else {
          view.setUint32(pos, !swapEndianess ? val.r0 : val.r1, !swapEndianess);
          view.setUint32(pos + 4, !swapEndianess ? val.r1 : val.r0, !swapEndianess);
          return;
        }
      }
      const isSigned = type.startsWith('i');
      if (opts.size === 8 && isSigned) view.setInt8(pos, val);
      else if (opts.size === 8 && !isSigned) view.setUint8(pos, val);
      else if (opts.size === 16 && isSigned) view.setInt16(pos, val, !swapEndianess);
      else if (opts.size === 16 && !isSigned) view.setUint16(pos, val, !swapEndianess);
      else if (type === 'i8') view.setInt8(pos, val);
      else if (type === 'u8') view.setUint8(pos, val);
      else if (type === 'i16') view.setInt16(pos, val, !swapEndianess);
      else if (type === 'u16') view.setUint16(pos, val, !swapEndianess);
      else if (type === 'i32' || (opts.size === 32 && isSigned))
        view.setInt32(pos, val, !swapEndianess);
      else if (type === 'u32' || (opts.size === 32 && !isSigned))
        view.setUint32(pos, val, !swapEndianess);
      else if (type === 'f32') view.setFloat32(pos, val, !swapEndianess);
      else if (type === 'f64') view.setFloat64(pos, val, !swapEndianess);
      return;
    }
    // 2. SIMD Path
    const lanes = types.lanesOf(type);
    const scalarType = types.ScalarOf(type);
    const step = types.sizeof(scalarType);
    for (let i = 0; i < lanes; i++) store(scalarType, pos + i * step, val[i], opts, swapEndianess);
  }

  function getInfo(region: any, pos?: number, _type?: TypeName) {
    const offsets = getPosLanes(region, pos);
    const lanes = offsets.length;
    let type =
      _type !== undefined
        ? _type
        : region.spec.kind === 'scalar'
          ? region.spec.type
          : region.spec.kind === 'array'
            ? region.spec.type.kind === 'scalar'
              ? region.spec.type.type
              : undefined
            : undefined;
    if (!type) return { offsets, lanes, type, isSimd: false };
    const typeSize = types.sizeof(type); // original type size
    let isSimd = types.SIMDType.has(type);
    let laneType;
    if (isSimd) {
      laneType = types.ScalarOf(type);
    } else if (lanes !== 1) {
      laneType = type;
      type = `${type}x${lanes}`;
      isSimd = true;
    }
    // Don't vectorize if already vectorized
    return {
      offsets,
      type,
      laneType,
      typeSize,
      isSimd,
      lanes,
    };
  }

  function tmp(region: any, opts: any = {}, pos?: number, _type?: TypeName, swapEndianess = false) {
    const { offsets, lanes, type, laneType } = getInfo(region, pos, _type);
    if (!type) throw new Error('no type');
    let size = opts.size;
    return {
      load: () => {
        if (lanes === 1) return load(type, offsets[0] as number, { ...opts, size }, swapEndianess);
        const res = [];
        for (let i = 0; i < lanes; i++)
          res.push(load(laneType || type, offsets[i] as number, { ...opts, size }, swapEndianess));
        return res;
      },
      store: (value: any) => {
        if (lanes === 1)
          return void store(type, offsets[0] as number, value, { ...opts, size }, swapEndianess);
        const vals = Array.isArray(value) ? value : Array(lanes).fill(value);
        for (let i = 0; i < lanes; i++) {
          store(laneType || type, offsets[i] as number, vals[i], { ...opts, size }, swapEndianess);
        }
      },
    };
  }
  const atomicOp = (
    type: TypeName,
    op: string,
    width: 1 | 2 | 4 | undefined,
    ...args: number[]
  ) => {
    // Runtime is single-threaded; model atomic memory effects without blocking/thread scheduling.
    if (op === 'fence') return;
    if (op === 'notify') return 0;
    if (op === 'wait') throw new Error('runtime atomic wait is not implemented');
    const size = width === undefined ? undefined : width * 8;
    const cell = tmp(
      region,
      size === undefined ? {} : { size },
      undefined,
      type,
      region.opts.swapEndianness
    );
    const old = cell.load();
    if (op === 'load') return old;
    if (op === 'store') return void cell.store(args[0]);
    if (op === 'xchg') {
      cell.store(args[0]);
      return old;
    }
    if (op === 'cmpxchg') {
      if (old === args[0]) cell.store(args[1]);
      return old;
    }
    let next;
    if (op === 'add') next = old + args[0];
    else if (op === 'sub') next = old - args[0];
    else if (op === 'and') next = old & args[0];
    else if (op === 'or') next = old | args[0];
    else if (op === 'xor') next = old ^ args[0];
    else throw new Error('runtime atomic op is not implemented: ' + op);
    cell.store(next);
    return old;
  };
  function getMut(type: TypeName) {
    const T = (f.types as any)[type];
    const mut: Record<string, any> = {
      exchange: (...args: [number]) => {
        const old = res.get();
        res.set(args[0]);
        return old;
      },
      compareExchange: (expected: number, replacement: number) => {
        const old = res.get();
        const equal = T.eq(old, expected); // whatever your eq op is
        const next = T.select(equal, replacement, old);
        res.set(next);
        return old;
      },
    };
    const genOp =
      (op: string) =>
      (...args: number[]) => {
        const val = res.get();
        res.set(T[op](val, ...args));
        return val;
      };
    for (const op of opsForType(type)) mut[op] = genOp(op);
    return mut;
  }

  const pos = region.pos;
  const { type, typeSize, offsets, laneType } = getInfo(region);
  Object.assign(res, { type });
  // type exists is either on scalar or array of scalars
  if (!type) return res;
  // Byte level + as16/as32.
  // TODO: clenaup!
  const getByteWidth = (spec: any) =>
    spec.kind === 'scalar' && spec.size !== undefined ? spec.size : undefined;
  if (region.spec.kind === 'array' ? getByteWidth(region.spec.type) : getByteWidth(region.spec)) {
    const byteWidth =
      region.spec.kind === 'array' ? getByteWidth(region.spec.type) : getByteWidth(region.spec);
    const width = { 1: 8, 2: 16, 4: 32 }[byteWidth as 1 | 2 | 4];
    if (byteWidth === 1) {
      Object.assign(res, {
        copyFrom({ region: srcRegion }: any, len?: number) {
          const srcOffsets = getPosLanes(srcRegion);
          const dstOffsets = getPosLanes(region);
          if (srcOffsets.length !== dstOffsets.length && srcOffsets.length !== 1)
            throw new Error('wrong offsets length');
          if (len === undefined) len = Math.min(region.size as number, srcRegion.size as number);
          for (let i = 0; i < dstOffsets.length; i++) {
            const srcOffset = (srcOffsets.length === 1 ? srcOffsets[0] : srcOffsets[i]) as number;
            buf.copyWithin(dstOffsets[i], srcOffset, srcOffset + len);
          }
        },
        fill(value: number, len?: number) {
          if (len === undefined) len = region.paddedSize as number;
          const offsets = getPosLanes(region);
          for (const pos of offsets) buf.fill(value, pos, pos + (len as number));
        },
        zero: (len?: number) => res.fill(0, len),
        read: (type: TypeName, size?: 8 | 16 | 32) => tmp(region, { size }, undefined, type).load(),
        write: (type: TypeName, value: number, size?: 8 | 16 | 32) =>
          tmp(region, { size }, undefined, type).store(value),
      });
    }
    // Should exists on byte level
    if (!types.IntType.has(type)) throw new Error('wrong type on byteView');
    if (region.spec.kind === 'array') {
      const count = Math.ceil(region.size / byteWidth);
      if (count * byteWidth > region.paddedSize) {
        throw new Error(
          `memOps/byteView: size=${region.size} is not enough for byteWidth=${byteWidth}`
        );
      }
      Object.assign(res, {
        get(): number[] {
          const res = [];
          let curPos = pos;
          for (let i = 0; i < count; i++) {
            res.push(tmp(region, { size: width }, curPos + i * byteWidth).load());
          }
          return res;
        },
        set(values: number[]): void {
          if (values.length !== count)
            throw new Error(`set/array: wrong length=${values.length}, expected: ${count}`);
          const res = [];
          let curPos = pos;
          for (let i = 0; i < count; i++) {
            res.push(tmp(region, { size: width }, curPos + i * byteWidth).store(values[i]));
          }
          return res as any as void;
        },
      });
    } else {
      Object.assign(res, {
        get: (): number => tmp(region, { size: width }).load(),
        set: (value: number) => tmp(region, { size: width }).store(value),
      });
      const atomics: Record<string, any> = {
        store: (value: number) => atomicOp(type, 'store', byteWidth, value),
      };
      if (types.UnsignedType.has(type)) {
        Object.assign(atomics, {
          load: () => atomicOp(type, 'load', byteWidth),
          exchange: (v: number) => atomicOp(type, 'xchg', byteWidth, v),
          compareExchange: (expected: number, value: number) =>
            atomicOp(type, 'cmpxchg', byteWidth, expected, value),
        });
        for (const op of types.opsAtomics)
          atomics[op] = (v: number) => atomicOp(type, op, byteWidth, v);
      }
      res.atomics = atomics;
      res.mut = getMut(type);
    }
    return res;
  }
  const isScalar = region.spec.kind === 'scalar';
  if (region.spec.kind === 'array') {
    Object.assign(res, {
      get(): any[] {
        const res = [];
        if (offsets.length > 1) {
          for (let i = 0; i < region.count!; i++) {
            const vec = new Array(offsets.length);
            for (let l = 0; l < offsets.length; l++) {
              let val = load(
                laneType || type,
                offsets[l] + i * typeSize!,
                {},
                region.opts.swapEndianness
              );
              vec[l] = val;
            }
            res.push(vec);
          }
          return res;
        }
        let curPos = region.pos;
        for (let i = 0; i < region.count!; i++) {
          let val = load(type, curPos, {}, region.opts.swapEndianness);
          res.push(val);
          curPos += typeSize!;
        }
        return res;
      },
      set(values: any[]): void {
        if (offsets.length > 1) {
          for (let i = 0; i < region.count!; i++) {
            const vec = values[i];
            for (let l = 0; l < offsets.length; l++) {
              let val = vec[l];
              store(
                laneType || type,
                offsets[l] + i * typeSize!,
                val,
                {},
                region.opts.swapEndianness
              );
            }
          }
          return;
        }
        let curPos = region.pos;
        for (let i = 0; i < region.count!; i++) {
          let val = values[i];
          store(type, curPos, val, {}, region.opts.swapEndianness);
          curPos += typeSize!;
        }
      },
    });
  } else if (isScalar) {
    Object.assign(res, {
      get() {
        let value = tmp(region, undefined, undefined, undefined, region.opts.swapEndianness).load();
        return value;
      },
      set(value: number) {
        return tmp(region, undefined, undefined, undefined, region.opts.swapEndianness).store(
          value
        );
      },
    });
    // Add atomics
    if (types.IntType.has(type) && types.ScalarType.has(type)) {
      const atomics: Record<string, any> = {
        // Loads/stores at this scalar address
        store: (value: number) => atomicOp(type, 'store', undefined, value),
        notify: (count: number = 1) => atomicOp(type, 'notify', undefined, count),
        fence: () => atomicOp(type, 'fence', undefined),
        wait: (expected: number, timeout: number = -1) =>
          atomicOp(
            type,
            'wait',
            undefined,
            expected,
            typeof timeout === 'number' ? i64.const(timeout) : (timeout as any)
          ),
        load: () => atomicOp(type, 'load', undefined),
        exchange: (v: number) => atomicOp(type, 'xchg', undefined, v),
        compareExchange: (expected: number, value: number) =>
          atomicOp(type, 'cmpxchg', undefined, expected, value),
      };
      for (const op of types.opsAtomics)
        atomics[op] = (v: number) => atomicOp(type, op, undefined, v);
      res.atomics = atomics;
    }
    res.mut = getMut(type);
  }
  return res;
}
/**
 * Runtime version of 'codegen.ts/genScope'
 */
function genScope(typeMod: any, _mod: Module, memoryExport: TArg<Uint8Array>, segments: any) {
  const isBr = (e: any): e is BrSentinel => !!e && e.__br === 1;
  type BrSentinel = { __br: 1; depth: number | string; values: any[] };
  const mkBr = (depth: number | string, values: any[]): BrSentinel => ({ __br: 1, depth, values });
  type StateShape = any;
  type FnOp = any;
  const typeOps = getTypes(typeMod);
  const mapBr = (d: number | string, label?: string): number | string => {
    if (typeof d === 'number') return d;
    if (!label) return d;
    if (d === `${label}.loop.body`) return 0;
    if (d === `${label}`) return 2;
    return d;
  };
  const handleLoopBr = <State extends any[]>(
    e: any,
    label: string | undefined
  ): { kind: 0 | 2; state: State } => {
    if (!isBr(e)) throw e;
    const d0 = mapBr(e.depth, label);
    if (typeof d0 === 'string') throw e; // label not ours
    if (d0 === 0 || d0 === 2) return { kind: d0, state: e.values as State };
    if (d0 > 2) throw mkBr(d0 - 3, e.values);
    throw mkBr(d0, e.values);
  };
  const doNCounterState = <State extends any[]>(
    e: any,
    label: string | undefined,
    state: State,
    width: number
  ): State => {
    // Codegen doN/doN1 carries [counter, ...state] internally, but runtime
    // exposes the counter as a callback argument and must strip it on labeled branches.
    if (
      isBr(e) &&
      typeof e.depth === 'string' &&
      label &&
      (e.depth === label || e.depth === `${label}.loop.body`) &&
      state.length === width + 1
    )
      return state.slice(1) as State;
    return state;
  };
  const normState = <State extends any[]>(s: any): State => (s ? (s as State) : ([] as any));
  // Runtime scalarizes batchFn kernels with `lanes=1`, so keep the same
  // scalar-vs-SIMD lookup rule as codegen instead of asking for `u32x1`.
  const getType = (name: TypeName, lanes: number = 1) =>
    typeOps[lanes === 1 || types.SIMDType.has(name) ? name : types.addLanes(name, lanes)];
  const scope = {
    types: typeOps,
    getType,
    getTypeGeneric: getType,
    flags: {},
    memory: {} as Record<string, any>,
    functions: {} as Record<string, any>,
    print: (...args: (number | string)[]) => console.log(...args),
    namedBlock<State extends StateShape[]>(
      name: string | undefined,
      input: State,
      cb: (...args: State) => State,
      isLoop = false
    ): State {
      let state = input;
      for (;;) {
        try {
          return cb(...state);
        } catch (e) {
          if (!isBr(e)) throw e;
          // label branch: only handle if it's *our* label, otherwise bubble up unchanged
          if (typeof e.depth === 'string') {
            if (name !== undefined && e.depth === name) {
              if (!isLoop) return e.values as State;
              state = e.values as State;
              continue;
            }
            throw e; // not for us
          }
          // numeric depth: normal unwind
          if (e.depth === 0) {
            if (!isLoop) return e.values as State;
            state = e.values as State;
            continue;
          }
          throw mkBr(e.depth - 1, e.values);
        }
      }
    },
    block<State extends StateShape[]>(
      inputs: State,
      cb: (...args: State) => State,
      isLoop = false
    ): State {
      return this.namedBlock(undefined, inputs, cb, isLoop);
    },
    brIf<State extends StateShape[]>(
      depth: string | number,
      cond: FnOp | undefined,
      ...outputs: State
    ) {
      if (cond === undefined || cond) throw mkBr(depth, outputs);
    },
    br<State extends StateShape[]>(depth: string | number, ...outputs: State) {
      return this.brIf(depth, undefined, ...outputs);
    },
    continueIf(cond: number | undefined, label: string | undefined, ...rest: any[]) {
      return (this as any).brIf(label ? `${label}.loop.body` : 0, cond, ...rest);
    },
    continue(label: string | undefined, ...rest: any[]) {
      return (this as any).continueIf(undefined, label, ...rest);
    },
    breakIf(cond: number | undefined, label: string | undefined, ...rest: any[]) {
      return (this as any).brIf(label ? `${label}` : 2, cond, ...rest);
    },
    break(label: string | undefined, ...rest: any[]) {
      return (this as any).breakIf(undefined, label, ...rest);
    },
    doWhile<State extends StateShape[]>(
      state: State,
      cond: (...s: State) => FnOp,
      body: (...s: State) => State,
      label?: string
    ): State {
      for (;;) {
        try {
          state = normState<State>(body(...state));
        } catch (e) {
          const h = handleLoopBr<State>(e, label);
          if (h.kind === 2) return h.state;
          state = h.state; // continue: then evaluate cond
        }
        if (cond(...state)) continue;
        return state;
      }
    },
    forLoop<State extends StateShape[]>(
      state: State,
      cond: (...s: State) => FnOp,
      inc: (...s: State) => State,
      body: (...s: State) => State,
      label?: string
    ): State {
      for (; cond(...state); state = inc(...state)) {
        try {
          state = normState<State>(body(...state));
        } catch (e) {
          const h = handleLoopBr<State>(e, label);
          if (h.kind === 2) return h.state;
          state = h.state; // continue
        }
      }
      return state;
    },
    doN<State extends StateShape[]>(
      state: State,
      N: FnOp | number, // runtime: number
      body: (cnt: FnOp, ...s: State) => State,
      label?: string
    ) {
      const n = N as number;
      const width = state.length;
      for (let i = 0; i < n; i++) {
        try {
          state = normState<State>(body(i, ...state));
        } catch (e) {
          const h = handleLoopBr<State>(e, label);
          const s = doNCounterState(e, label, h.state, width);
          if (h.kind === 2) return s;
          state = s; // continue
        }
      }
      return state;
    },
    doN1<State extends StateShape[]>(
      state: any,
      N: number,
      body: (cnt: number, ...s: State) => State,
      label?: string
    ) {
      let cnt = 0;
      const width = state.length;
      for (;;) {
        try {
          state = normState<State>(body(cnt, ...state));
        } catch (e) {
          const h = handleLoopBr<State>(e, label);
          const s = doNCounterState(e, label, h.state, width);
          if (h.kind === 2) return s;
          state = s; // continue
        }
        if (++cnt >= N) return state;
      }
    },
    ifElse<State extends any[] = []>(
      cond: number,
      state: State,
      ifBody: (...s: State) => State,
      elseBody?: (...s: State) => State
    ): State {
      const asState = (x: any): State =>
        x === undefined ? ([] as any) : Array.isArray(x) ? (x as any) : ([x] as any);
      if (!elseBody) {
        return cond ? asState(ifBody(...state)) : state;
      }
      return cond ? asState(ifBody(...state)) : asState(elseBody(...state));
    },
  };
  for (const name in segments)
    scope.memory[name] = memoryProxy(
      scope as any,
      name,
      segments[name].pre,
      memOps.bind(null, { view: new DataView(memoryExport.buffer), buf: memoryExport }) as any,
      true
    );

  return scope;
}

/**
 * Builds the scalar runtime interpreter for a module.
 *
 * @param typeModFn - Factory returning runtime type helper functions.
 * @param mod - Source module definition.
 * @param _opts - Compiler options. {@link CompilerOpts}
 * @param debug - Whether runtime argument count checks are enabled.
 * @returns Factory returning the cached runtime instance.
 * @throws If memory allocation or runtime import resolution fails. {@link Error}
 * @example
 * ```js
 * import { Module } from '@awasm/compiler/module.js';
 * import { genRuntimeTypes } from '@awasm/compiler/types.js';
 * import { toRuntime } from '@awasm/compiler/runtime.js';
 *
 * const mod = new Module('demo')
 *   .fn('zero', [], 'u32', (f) => f.types.u32.const(0));
 * toRuntime(genRuntimeTypes, mod)();
 * ```
 */
export function toRuntime(
  typeModFn: any,
  mod: any,
  _opts: CompilerOpts = {},
  debug = false
): () => any {
  if (typeof typeModFn !== 'function')
    throw new TypeError(`"typeModFn" expected function, got type=${typeof typeModFn}`);
  if (!(mod instanceof Module))
    throw new TypeError(`"mod" expected Module, got type=${typeof mod}`);
  if (!P.utils.isPlainObject(_opts))
    throw new TypeError(`"opts" expected object, got type=${typeof _opts}`);
  if (typeof debug !== 'boolean')
    throw new TypeError(`"debug" expected boolean, got type=${typeof debug}`);
  const typeMod = typeModFn();
  // Memory
  const memory: Record<any, any> = {};
  // Runtime is scalar interpretation, not compiled SIMD/threads output;
  // batch callbacks run with lanes=1.
  const BATCH_SIZE = 1;
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
  const memoryU8 = new Uint8Array(memPos);
  const functions: any = {};
  const exports: any = {};
  const scope = genScope(typeMod, mod, memoryU8, memory);
  for (const name in mod.functions) {
    const { inputs, cb, batch, import: isImport } = mod.functions[name];
    if (isImport) {
      functions[name] = (...args: any[]) => {
        if (!cb) throw new Error(`runtime import missing callback: ${name}`);
        return cb(...args);
      };
    } else if (batch) {
      functions[name] = (
        batchPos: number,
        batchLen: number,
        perBatchSize: number,
        ...args: any[]
      ) => {
        for (let i = 0; i < batchLen; i++) {
          cb(scope, 1, batchPos + i, perBatchSize, ...args);
        }
      };
    } else {
      functions[name] = (...args: any[]) => {
        if (debug && args.length !== inputs.length)
          throw new Error(`wrong args.length=${args.length}, expected=${inputs.length}`);
        const res = cb(scope, ...args);
        return Array.isArray(res) && res.length === 1 ? res[0] : res;
      };
    }
    if (!isImport) exports[name] = functions[name];
    (scope.functions as any)[name] = {
      call: (...args: any[]) => {
        const res = functions[name](...args);
        return Array.isArray(res) ? res : [res];
      },
      callIf: (cond: number, ...args: any[]) => {
        if (cond) functions[name](...args);
      },
    };
  }
  Object.freeze(scope);

  const segments: Record<string, any> = {};
  for (const [name, s] of Object.entries(memory)) {
    const sub = (s as any).pre.subRegions;
    if (!sub) continue;
    for (const [k, [pos, len, chunksCount, chunkSize]] of Object.entries(sub) as any) {
      const regionName = k ? `${name}.${k}` : name;
      // Main View
      if (len >= chunkSize) segments[regionName] = new Uint8Array(memoryU8.buffer, pos, len);
      // Chunks View
      const chunkLen = Math.min(len, chunkSize);
      const chunks = new Array(chunksCount);
      for (let i = 0; i < chunksCount; i++) {
        chunks[i] = new Uint8Array(memoryU8.buffer, pos + i * chunkSize, chunkLen);
      }
      segments[`${regionName}_chunks`] = Object.freeze(chunks);
    }
  }
  // Runtime intentionally caches one interpreter instance, like compiled reuseModule mode.
  const res = Object.freeze({ memory: memoryU8, segments: Object.freeze(segments), ...exports });
  return () => res;
}
