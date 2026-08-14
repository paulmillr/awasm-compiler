import type { TArg } from '@scure/base';
import * as P from 'micro-packed';
import { as, FnOp, toWasm, type CompilerOpts, type ModuleGraph } from './codegen.ts';
import * as js from './js.ts';
import type { GetOps, Val } from './module.ts'; // Circular type-definitions, yay!
import { Module, struct, type RetType } from './module.ts';
import * as utils from './utils.ts';

const _1n = /* @__PURE__ */ BigInt(1);
const _63n = /* @__PURE__ */ BigInt(63);
const _64n = /* @__PURE__ */ BigInt(64);
const I64_MASK_N = /* @__PURE__ */ BigInt(-1);
const U64_MASK_N = /* @__PURE__ */ BigInt('0xffffffffffffffff');
const I_MASK = -1;
const U32_MASK = 0xffff_ffff;
const U16_MASK = 0xffff;
const U8_MASK = 0xff;

// NOTE: separate from type metadata for tree-shaking in runtime.
/** Binary coders for every scalar and SIMD compiler type. */
export const TypeCoders: Record<TypeName, P.CoderType<any>> = /* @__PURE__ */ utils.deepFreeze({
  i8: P.I8,
  u8: P.U8,
  i16: P.I16LE,
  u16: P.U16LE,
  i32: P.I32LE,
  u32: P.U32LE,
  f32: utils.F32LE,
  i64: P.I64LE,
  u64: P.U64LE,
  f64: utils.F64LE,
  i128: P.I128LE,
  u128: P.U128LE,
  i256: P.I256LE,
  u256: P.U256LE,
  // SIMD 128-bit
  i128x2: /* @__PURE__ */ P.array(2, P.I128LE),
  u128x2: /* @__PURE__ */ P.array(2, P.U128LE),
  i128x4: /* @__PURE__ */ P.array(4, P.I128LE),
  u128x4: /* @__PURE__ */ P.array(4, P.U128LE),
  i128x8: /* @__PURE__ */ P.array(8, P.I128LE),
  u128x8: /* @__PURE__ */ P.array(8, P.U128LE),
  i128x16: /* @__PURE__ */ P.array(16, P.I128LE),
  u128x16: /* @__PURE__ */ P.array(16, P.U128LE),
  // SIMD 256-bit
  i256x2: /* @__PURE__ */ P.array(2, P.I256LE),
  u256x2: /* @__PURE__ */ P.array(2, P.U256LE),
  i256x4: /* @__PURE__ */ P.array(4, P.I256LE),
  u256x4: /* @__PURE__ */ P.array(4, P.U256LE),
  i256x8: /* @__PURE__ */ P.array(8, P.I256LE),
  u256x8: /* @__PURE__ */ P.array(8, P.U256LE),
  i256x16: /* @__PURE__ */ P.array(16, P.I256LE),
  u256x16: /* @__PURE__ */ P.array(16, P.U256LE),
  // SIMD 8-bit
  i8x2: /* @__PURE__ */ P.array(2, P.I8),
  u8x2: /* @__PURE__ */ P.array(2, P.U8),
  i8x4: /* @__PURE__ */ P.array(4, P.I8),
  u8x4: /* @__PURE__ */ P.array(4, P.U8),
  i8x8: /* @__PURE__ */ P.array(8, P.I8),
  u8x8: /* @__PURE__ */ P.array(8, P.U8),
  i8x16: /* @__PURE__ */ P.array(16, P.I8),
  u8x16: /* @__PURE__ */ P.array(16, P.U8),
  // SIMD 16-bit
  i16x2: /* @__PURE__ */ P.array(2, P.I16LE),
  u16x2: /* @__PURE__ */ P.array(2, P.U16LE),
  i16x4: /* @__PURE__ */ P.array(4, P.I16LE),
  u16x4: /* @__PURE__ */ P.array(4, P.U16LE),
  i16x8: /* @__PURE__ */ P.array(8, P.I16LE),
  u16x8: /* @__PURE__ */ P.array(8, P.U16LE),
  i16x16: /* @__PURE__ */ P.array(16, P.I16LE),
  u16x16: /* @__PURE__ */ P.array(16, P.U16LE),
  // SIMD 32-bit
  i32x2: /* @__PURE__ */ P.array(2, P.I32LE),
  u32x2: /* @__PURE__ */ P.array(2, P.U32LE),
  f32x2: /* @__PURE__ */ P.array(2, utils.F32LE),
  i32x4: /* @__PURE__ */ P.array(4, P.I32LE),
  u32x4: /* @__PURE__ */ P.array(4, P.U32LE),
  f32x4: /* @__PURE__ */ P.array(4, utils.F32LE),
  i32x8: /* @__PURE__ */ P.array(8, P.I32LE),
  u32x8: /* @__PURE__ */ P.array(8, P.U32LE),
  f32x8: /* @__PURE__ */ P.array(8, utils.F32LE),
  i32x16: /* @__PURE__ */ P.array(16, P.I32LE),
  u32x16: /* @__PURE__ */ P.array(16, P.U32LE),
  f32x16: /* @__PURE__ */ P.array(16, utils.F32LE),
  // SIMD 64-bit
  i64x2: /* @__PURE__ */ P.array(2, P.I64LE),
  u64x2: /* @__PURE__ */ P.array(2, P.U64LE),
  f64x2: /* @__PURE__ */ P.array(2, utils.F64LE),
  i64x4: /* @__PURE__ */ P.array(4, P.I64LE),
  u64x4: /* @__PURE__ */ P.array(4, P.U64LE),
  f64x4: /* @__PURE__ */ P.array(4, utils.F64LE),
  i64x8: /* @__PURE__ */ P.array(8, P.I64LE),
  u64x8: /* @__PURE__ */ P.array(8, P.U64LE),
  f64x8: /* @__PURE__ */ P.array(8, utils.F64LE),
  i64x16: /* @__PURE__ */ P.array(16, P.I64LE),
  u64x16: /* @__PURE__ */ P.array(16, P.U64LE),
  f64x16: /* @__PURE__ */ P.array(16, utils.F64LE),
});

// prettier-ignore
const TYPES = {
  i8:    { signed: true,  float: false, width: 8,  lanes: 1 },
  u8:    { signed: false, float: false, width: 8,  lanes: 1 },
  i16:   { signed: true,  float: false, width: 16, lanes: 1 },
  u16:   { signed: false, float: false, width: 16, lanes: 1 },
  i32:   { signed: true,  float: false, width: 32, lanes: 1 },
  u32:   { signed: false, float: false, width: 32, lanes: 1 },
  f32:   { signed: true,  float: true,  width: 32, lanes: 1 },
  i64:   { signed: true,  float: false, width: 64, lanes: 1 },
  u64:   { signed: false, float: false, width: 64, lanes: 1 },
  f64:   { signed: true,  float: true,  width: 64, lanes: 1 },
  i128:  { signed: true,  float: false, width: 128, lanes: 1 },
  u128:  { signed: false, float: false, width: 128, lanes: 1 },
  i256:  { signed: true,  float: false, width: 256, lanes: 1 },
  u256:  { signed: false, float: false, width: 256, lanes: 1 },
  // SIMD 8-bit
  i8x2:  { signed: true,  float: false, width: 8,  lanes: 2 },
  u8x2:  { signed: false, float: false, width: 8,  lanes: 2 },
  i8x4:  { signed: true,  float: false, width: 8,  lanes: 4 },
  u8x4:  { signed: false, float: false, width: 8,  lanes: 4 },
  i8x8:  { signed: true,  float: false, width: 8,  lanes: 8 },
  u8x8:  { signed: false, float: false, width: 8,  lanes: 8 },
  i8x16: { signed: true,  float: false, width: 8,  lanes: 16 },
  u8x16: { signed: false, float: false, width: 8,  lanes: 16 },
  // SIMD 16-bit
  i16x2: { signed: true,  float: false, width: 16, lanes: 2 },
  u16x2: { signed: false, float: false, width: 16, lanes: 2 },
  i16x4: { signed: true,  float: false, width: 16, lanes: 4 },
  u16x4: { signed: false, float: false, width: 16, lanes: 4 },
  i16x8: { signed: true,  float: false, width: 16, lanes: 8 },
  u16x8: { signed: false, float: false, width: 16, lanes: 8 },
  i16x16:{ signed: true,  float: false, width: 16, lanes: 16 },
  u16x16:{ signed: false, float: false, width: 16, lanes: 16 },
  // SIMD 32-bit
  i32x2: { signed: true,  float: false, width: 32, lanes: 2 },
  u32x2: { signed: false, float: false, width: 32, lanes: 2 },
  f32x2: { signed: true,  float: true,  width: 32, lanes: 2 },
  i32x4: { signed: true,  float: false, width: 32, lanes: 4 },
  u32x4: { signed: false, float: false, width: 32, lanes: 4 },
  f32x4: { signed: true,  float: true,  width: 32, lanes: 4 },
  i32x8: { signed: true,  float: false, width: 32, lanes: 8 },
  u32x8: { signed: false, float: false, width: 32, lanes: 8 },
  f32x8: { signed: true,  float: true,  width: 32, lanes: 8 },
  i32x16:{ signed: true,  float: false, width: 32, lanes: 16 },
  u32x16:{ signed: false, float: false, width: 32, lanes: 16 },
  f32x16:{ signed: true,  float: true,  width: 32, lanes: 16 },
  // SIMD 64-bit
  i64x2: { signed: true,  float: false, width: 64, lanes: 2 },
  u64x2: { signed: false, float: false, width: 64, lanes: 2 },
  f64x2: { signed: true,  float: true,  width: 64, lanes: 2 },
  i64x4: { signed: true,  float: false, width: 64, lanes: 4 },
  u64x4: { signed: false, float: false, width: 64, lanes: 4 },
  f64x4: { signed: true,  float: true,  width: 64, lanes: 4 },
  i64x8: { signed: true,  float: false, width: 64, lanes: 8 },
  u64x8: { signed: false, float: false, width: 64, lanes: 8 },
  f64x8: { signed: true,  float: true,  width: 64, lanes: 8 },
  i64x16:{ signed: true,  float: false, width: 64, lanes: 16 },
  u64x16:{ signed: false, float: false, width: 64, lanes: 16 },
  f64x16:{ signed: true,  float: true,  width: 64, lanes: 16 },
  // SIMD 128-bit
  i128x2:  { signed: true,  float: false, width: 128, lanes: 2 },
  u128x2:  { signed: false, float: false, width: 128, lanes: 2 },
  i128x4:  { signed: true,  float: false, width: 128, lanes: 4 },
  u128x4:  { signed: false, float: false, width: 128, lanes: 4 },
  i128x8:  { signed: true,  float: false, width: 128, lanes: 8 },
  u128x8:  { signed: false, float: false, width: 128, lanes: 8 },
  i128x16: { signed: true,  float: false, width: 128, lanes: 16 },
  u128x16: { signed: false, float: false, width: 128, lanes: 16 },
  // SIMD 256-bit
  i256x2:  { signed: true,  float: false, width: 256, lanes: 2 },
  u256x2:  { signed: false, float: false, width: 256, lanes: 2 },
  i256x4:  { signed: true,  float: false, width: 256, lanes: 4 },
  u256x4:  { signed: false, float: false, width: 256, lanes: 4 },
  i256x8:  { signed: true,  float: false, width: 256, lanes: 8 },
  u256x8:  { signed: false, float: false, width: 256, lanes: 8 },
  i256x16: { signed: true,  float: false, width: 256, lanes: 16 },
  u256x16: { signed: false, float: false, width: 256, lanes: 16 },
} as const;

/** Open interface backing the public `TypeName` string union. */
export interface TypeDict extends Record<keyof typeof TYPES, unknown> {}
/** Every known compiler type name. */
export type TypeName = keyof TypeDict;
// Derive sets from predicates
type LooseSet<T extends string> = Set<T> & { has(v: string): v is T };
type ArrVal<T extends readonly unknown[]> = T[number];
const opsCompareFloatItems = /* @__PURE__ */ (() => ['isNaN'] as const)();
const opsCompareBaseItems = /* @__PURE__ */ (() =>
  ['eq', 'ne', 'lt', 'gt', 'le', 'ge', 'eqz'] as const)();
const opsBasicItems = /* @__PURE__ */ (() =>
  [
    'swapEndianness',
    'add',
    'mul',
    'sub',
    'div',
    'rem',
    'min',
    'max',
    ...opsCompareBaseItems,
  ] as const)();
const opsShiftsItems = /* @__PURE__ */ (() => ['shr', 'shl', 'rotr', 'rotl'] as const)();
const opsIntItems = /* @__PURE__ */ (() =>
  ['and', 'or', 'xor', 'andnot', 'not', 'clz', 'ctz', 'popcnt', ...opsShiftsItems] as const)();
const opsSignedItems = /* @__PURE__ */ (() => ['abs', 'neg'] as const)();
const opsCompareItems = /* @__PURE__ */ (() =>
  [...opsCompareBaseItems, ...opsCompareFloatItems] as const)();
const opsFloatItems = /* @__PURE__ */ (() =>
  ['sqrt', 'ceil', 'floor', 'trunc', 'nearest', 'copysign', ...opsCompareFloatItems] as const)();
const opsAtomicsItems = /* @__PURE__ */ (() => ['add', 'sub', 'and', 'or', 'xor'] as const)();
const opsVariadicItems = /* @__PURE__ */ (() =>
  ['add', 'mul', 'and', 'xor', 'or', 'min', 'max'] as const)();
const ops1ArgItems = /* @__PURE__ */ (() =>
  [
    'swapEndianness',
    'not',
    'clz',
    'ctz',
    'popcnt',
    'abs',
    'neg',
    'sqrt',
    'ceil',
    'floor',
    'trunc',
    'nearest',
    'eqz',
    'isNaN',
  ] as const)();
const ops2ArgItems = /* @__PURE__ */ (() =>
  [
    'and',
    'or',
    'xor',
    'andnot',
    'add',
    'mul',
    'sub',
    'div',
    'rem',
    'min',
    'max',
    'copysign',
    'eq',
    'ne',
    'lt',
    'gt',
    'le',
    'ge',
  ] as const)();
type OpsCompareFloatName = ArrVal<typeof opsCompareFloatItems>;
type OpsCompareBaseName = ArrVal<typeof opsCompareBaseItems>;
/** Basic arithmetic and comparison operation name union. */
export type OpsBasic = ArrVal<typeof opsBasicItems>;
/** Shift and rotate operation name union. */
export type OpsShifts = ArrVal<typeof opsShiftsItems>;
/** Integer-only operation name union. */
export type OpsInt = ArrVal<typeof opsIntItems>;
/** Signed-number operation name union. */
export type OpsSigned = ArrVal<typeof opsSignedItems>;
/** Comparison operation name union. */
export type OpsCompare = ArrVal<typeof opsCompareItems>;
/** Floating-point-only operation name union. */
export type OpsFloat = ArrVal<typeof opsFloatItems>;
/** Atomic read-modify-write operation name union. */
export type OpsAtomics = ArrVal<typeof opsAtomicsItems>;
/** Variadic operation name union. */
export type OpsVariadic = ArrVal<typeof opsVariadicItems>;
/** Unary operation name union. */
export type Ops1Arg = ArrVal<typeof ops1ArgItems>;
/** Binary operation name union. */
export type Ops2Arg = ArrVal<typeof ops2ArgItems>;
const filter = <K extends TypeName>(pred: (d: (typeof TYPES)[K]) => boolean): LooseSet<K> =>
  utils.deepFreeze(
    new Set(
      Object.entries(TYPES)
        .filter(([_, d]) => pred(d as any))
        .map(([k]) => k)
    )
  ) as any;
type FilterKeys<T, P> = { [K in keyof T]: T[K] extends P ? K : never }[keyof T];
/** Type names whose lane width is 32 bits. */
export type Width32 = FilterKeys<typeof TYPES, { width: 32 }>;
/** Type names whose lane width is 32 bits. */
export const Width32 = /* @__PURE__ */ filter((d) => d.width === 32) as LooseSet<Width32>;
/** Type names whose lane width is 16 bits. */
export type Width16 = FilterKeys<typeof TYPES, { width: 16 }>;
/** Type names whose lane width is 16 bits. */
export const Width16 = /* @__PURE__ */ filter((d) => d.width === 16) as LooseSet<Width16>;
/** Type names whose lane width is 8 bits. */
export type Width8 = FilterKeys<typeof TYPES, { width: 8 }>;
/** Type names whose lane width is 8 bits. */
export const Width8 = /* @__PURE__ */ filter((d) => d.width === 8) as LooseSet<Width8>;
/** Type names whose lane width is 64 bits. */
export type Width64 = FilterKeys<typeof TYPES, { width: 64 }>;

/** Type names whose lane width is 64 bits. */
export const Width64 = /* @__PURE__ */ filter((d) => d.width === 64) as LooseSet<Width64>;
/** Scalar type names with exactly one lane. */
export type ScalarType = FilterKeys<typeof TYPES, { lanes: 1 }>;
/** Scalar type names with exactly one lane. */
export const ScalarType = /* @__PURE__ */ filter((d) => d.lanes === 1) as LooseSet<ScalarType>;
/** SIMD type names with more than one lane. */
export type SIMDType = Exclude<TypeName, ScalarType>;
/** SIMD type names with more than one lane. */
export const SIMDType = /* @__PURE__ */ filter((d) => d.lanes > 1) as LooseSet<SIMDType>;
/** Floating-point type names. */
export type FloatType = FilterKeys<typeof TYPES, { float: true }>;
/** Floating-point type names. */
export const FloatType = /* @__PURE__ */ filter((d) => d.float) as LooseSet<FloatType>;
/** Integer type names. */
export type IntType = FilterKeys<typeof TYPES, { float: false }>;
/** Integer type names. */
export const IntType = /* @__PURE__ */ filter((d) => !d.float) as LooseSet<IntType>;
/** Signed type names. */
export type SignedType = FilterKeys<typeof TYPES, { signed: true }>;
/** Signed type names. */
export const SignedType = /* @__PURE__ */ filter((d) => d.signed) as LooseSet<SignedType>;
/** Unsigned type names. */
export type UnsignedType = FilterKeys<typeof TYPES, { signed: false }>;
/** Unsigned type names. */
export const UnsignedType = /* @__PURE__ */ filter((d) => !d.signed) as LooseSet<UnsignedType>;
/** 128-bit and 256-bit integer type names. */
export type BigIntType = FilterKeys<typeof TYPES, { float: false; width: 128 | 256 }>;
/** 128-bit and 256-bit integer type names. */
export const BigIntType = /* @__PURE__ */ filter(
  (d) => !d.float && (d.width === 128 || d.width === 256)
) as LooseSet<BigIntType>;
/** Scalar 128-bit and 256-bit integer type names. */
export type BigIntScalarType = Extract<BigIntType, ScalarType>;
/** Scalar 128-bit and 256-bit integer type names. */
export const BigIntScalarType = /* @__PURE__ */ filter(
  (d) => d.lanes === 1 && !d.float && (d.width === 128 || d.width === 256)
) as LooseSet<BigIntScalarType>;
/** Scalar and SIMD integer type names narrower than 32 bits. */
export type SmallIntType = FilterKeys<typeof TYPES, { float: false; width: 8 | 16 }>;
/** Scalar and SIMD integer type names narrower than 32 bits. */
export const SmallIntType = /* @__PURE__ */ filter(
  (d) => !d.float && (d.width === 8 || d.width === 16)
) as LooseSet<SmallIntType>;
// Build the public name list through a pure call so single-export bundles can drop it when unused.
/** Runtime list of non-bigint type names used by generators. */
export const TypeName: TypeName[] = /* @__PURE__ */ (() =>
  utils.deepFreeze(
    Object.keys(TYPES).filter((k) => !BigIntType.has(k as TypeName)) as TypeName[]
  ))();

/** Scalar lane type extracted from a scalar or SIMD type name. */
export type ScalarOf<N extends TypeName> = N extends `${infer P}x${number}`
  ? Extract<P, TypeName>
  : N;
/**
 * Returns the scalar lane type for a scalar or SIMD type name.
 *
 * @param t - Type name to inspect.
 * @returns Scalar lane type name.
 * @example
 * ```js
 * ScalarOf('u32x4');
 * ```
 */
export const ScalarOf = <T extends TypeName>(t: T): ScalarOf<T> => {
  if (typeof t !== 'string') throw new TypeError(`"t" expected string, got type=${typeof t}`);
  return t.split('x')[0] as ScalarOf<T>;
};

/** SIMD lane count extracted from a type name. */
export type LanesOf<N extends TypeName> = N extends `${string}x${infer L extends number}`
  ? L extends number
    ? L
    : never
  : 1;

/**
 * Returns the lane count for a scalar or SIMD type name.
 *
 * @param type - Type name to inspect.
 * @returns Number of lanes, with scalars returning `1`.
 * @example
 * ```js
 * lanesOf('u32x4');
 * ```
 */
export function lanesOf(type: TypeName): 1 | 2 | 4 | 8 | 16 {
  if (typeof type !== 'string')
    throw new TypeError(`"type" expected string, got type=${typeof type}`);
  if (type.endsWith('x16')) return 16;
  if (type.endsWith('x8')) return 8;
  if (type.endsWith('x4')) return 4;
  if (type.endsWith('x2')) return 2;
  return 1;
}

/**
 * Returns the byte size of one value of a type.
 *
 * @param type - Type name to inspect.
 * @returns Byte size including all lanes for SIMD types.
 * @example
 * ```js
 * sizeof('u32x4');
 * ```
 */
export const sizeof = (type: TypeName): number => {
  if (typeof type !== 'string')
    throw new TypeError(`"type" expected string, got type=${typeof type}`);
  // Required in runtime, otherwise would be: return TypeCoders[type].size!;
  return (TYPES[type].width / 8) * lanesOf(type);
};

/**
 * Adds a lane suffix to a scalar type, leaving SIMD types unchanged.
 *
 * @param type - Scalar or SIMD type name.
 * @param lanes - Lane count to add to scalar types.
 * @returns SIMD type name.
 * @example
 * ```js
 * addLanes('u32', 4);
 * ```
 */
export const addLanes = (type: TypeName, lanes: number): SIMDType =>
  (ScalarType.has(type) ? `${type}x${lanes}` : type) as SIMDType;

/**
 * Returns the smallest native-width SIMD type for a scalar lane type.
 *
 * @param type - Scalar or SIMD type name.
 * @returns SIMD type with at least 128-bit total width.
 * @example
 * ```js
 * minSimdType('u32');
 * ```
 */
export const minSimdType = (type: TypeName): SIMDType => {
  if (typeof type !== 'string')
    throw new TypeError(`"type" expected string, got type=${typeof type}`);
  return addLanes(
    type,
    TYPES[type].width === 64 ? 2 : TYPES[type].width === 32 ? 4 : TYPES[type].width === 16 ? 8 : 16
  ) as SIMDType;
};

/**
 * Normalizes unsigned integer type names to their signed-width equivalent.
 *
 * @param t - Type name to normalize.
 * @returns Type name with an `i` prefix for integer widths.
 * @example
 * ```js
 * normSignedness('u32x4');
 * ```
 */
export const normSignedness = (t: TypeName): TypeName => {
  if (typeof t !== 'string') throw new TypeError(`"t" expected string, got type=${typeof t}`);
  return t.replace('u', 'i') as TypeName;
};

/** Mask result type for comparisons over a source type. */
export type MaskType<T extends TypeName> = T extends SIMDType
  ? Extract<
      `${T extends Width64
        ? 'u64'
        : T extends Width32
          ? 'u32'
          : T extends Width16
            ? 'u16'
            : 'u8'}x${LanesOf<T>}`,
      TypeName
    >
  : 'u32';

/**
 * Returns the comparison mask type for a source type.
 *
 * @param type - Source type name.
 * @returns `u32` for scalars or lane-matched unsigned SIMD mask type.
 * @example
 * ```js
 * maskType('i16x8');
 * ```
 */
export const maskType = <T extends TypeName>(type: T): MaskType<T> => {
  if (!SIMDType.has(type)) return 'u32' as MaskType<T>;
  if (Width64.has(type)) return addLanes('u64', lanesOf(type)) as MaskType<T>;
  if (Width32.has(type)) return addLanes('u32', lanesOf(type)) as MaskType<T>;
  if (Width16.has(type)) return addLanes('u16', lanesOf(type)) as MaskType<T>;
  return addLanes('u8', lanesOf(type)) as MaskType<T>;
};

const defSet = <const T extends readonly string[]>(arr: T): LooseSet<T[number]> =>
  utils.deepFreeze(new Set(arr)) as LooseSet<T[number]>;
const opsCompareFloat: LooseSet<OpsCompareFloatName> = /* @__PURE__ */ defSet(opsCompareFloatItems);
const opsCompareBase: LooseSet<OpsCompareBaseName> = /* @__PURE__ */ defSet(opsCompareBaseItems);
/** Basic arithmetic and comparison operation names. */
export const opsBasic: LooseSet<OpsBasic> = /* @__PURE__ */ defSet(opsBasicItems);
/** Shift and rotate operation names. */
export const opsShifts: LooseSet<OpsShifts> = /* @__PURE__ */ defSet(opsShiftsItems);
/** Integer-only operation names. */
export const opsInt: LooseSet<OpsInt> = /* @__PURE__ */ defSet(opsIntItems);
/** Signed-number operation names. */
export const opsSigned: LooseSet<OpsSigned> = /* @__PURE__ */ defSet(opsSignedItems);
/** Comparison operation names. */
export const opsCompare: LooseSet<OpsCompare> = /* @__PURE__ */ defSet(opsCompareItems);
/** Floating-point-only operation names. */
export const opsFloat: LooseSet<OpsFloat> = /* @__PURE__ */ defSet(opsFloatItems);
/** Atomic read-modify-write operation names. */
export const opsAtomics: LooseSet<OpsAtomics> = /* @__PURE__ */ defSet(opsAtomicsItems);
/** Variadic operation names. */
export const opsVariadic: LooseSet<OpsVariadic> = /* @__PURE__ */ defSet(opsVariadicItems);
/** Unary operation names. */
export const ops1Arg: LooseSet<Ops1Arg> = /* @__PURE__ */ defSet(ops1ArgItems);
/** Binary operation names. */
export const ops2Arg: LooseSet<Ops2Arg> = /* @__PURE__ */ defSet(ops2ArgItems);

/** Any supported non-atomic operation name. */
export type OpName = OpsBasic | OpsShifts | OpsInt | OpsSigned | OpsCompare | OpsFloat;

type OpsForType<T extends TypeName> =
  | OpsBasic
  | (T extends FloatType ? OpsFloat : never)
  | (T extends SignedType ? OpsSigned : never)
  | (T extends IntType ? OpsInt : never);

/**
 * Returns operation names valid for a type.
 *
 * @param type - Type whose operation set is requested.
 * @returns Set of valid operation names for that type.
 * @example
 * ```js
 * opsForType('u32');
 * ```
 */
export function opsForType<T extends TypeName>(type: T): LooseSet<OpsForType<T>> {
  const sets: LooseSet<string>[] = [opsBasic, opsCompareBase];
  if (FloatType.has(type)) sets.push(opsFloat, opsCompareFloat);
  if (SignedType.has(type)) sets.push(opsSigned);
  if (IntType.has(type)) sets.push(opsInt, opsShifts);
  return new Set(sets.flatMap((s) => [...s])) as LooseSet<OpsForType<T>>;
}

type SigRetForOp<O extends OpName, V, Mask> = O extends OpsCompare ? Mask : V;
// prettier-ignore
type SigForOp<O extends OpName, V, Shift, Mask> =
  O extends OpsShifts ? (value: V, shift: Shift) => SigRetForOp<O, V, Mask> :
  O extends OpsVariadic ? (...args: V[]) => SigRetForOp<O, V, Mask> :
  O extends Ops2Arg ? (a: V, b: V) => SigRetForOp<O, V, Mask> :
  O extends Ops1Arg ? (a: V) => SigRetForOp<O, V, Mask> :
  never;

/** Operation function signatures specialized for a value representation. */
export type OpsFnForType<T extends TypeName, V, Shift, Mask> = {
  [K in OpsForType<T>]: SigForOp<K, V, Shift, Mask>;
};

function checkType(fn: ModuleGraph, type: TypeName, op: FnOp) {
  const nodeType = nodeRetType(fn, op);
  if (normSignedness(nodeType) !== normSignedness(type)) {
    console.error('NODE', fn.ops.get(op.idx));
    throw new Error(`wrong type: ${nodeType}, expected: ${type}`);
  }
}

type SIMDZip = { encode(values: FnOp[]): FnOp[]; decode(values: FnOp[]): FnOp[] };
type SIMDMaskPair = { even: number[]; odd: number[] };
type SIMDMasks = {
  '64x2': SIMDMaskPair & { identity: number[]; reverse: number[]; reverseBytes: number[] };
  '32x4': SIMDMaskPair & {
    interleave: { low: number[]; high: number[] };
    reverse: number[];
    transpose: SIMDMaskPair;
    reverseBytes: number[];
  };
  '16x8': SIMDMaskPair & {
    interleave: { low: number[]; high: number[] };
    transpose: SIMDMaskPair;
    reverse: number[];
    reverseBytes: number[];
  };
  '8x16': SIMDMaskPair & {
    interleave: { low: number[]; high: number[] };
    transpose: SIMDMaskPair;
  };
};
type SIMDUtilsAPI = {
  checkLane(lanes: number, lane: number): number;
  checkShufflePattern(bytes: number, pattern: number[]): number[];
  shuffleLanes(laneSize: number, pattern: number[], bytes?: number): number[];
  MASKS: SIMDMasks;
  zip32(f: GetOpsFnOp<SIMDType>): SIMDZip;
  zip64Single(f: GetOpsFnOp<SIMDType>, v: FnOp[]): FnOp[];
  zip64(f: GetOpsFnOp<SIMDType>): SIMDZip;
  zipPow2(f: GetOpsFnOp<SIMDType>, masks: SIMDMaskPair): SIMDZip;
  getZip(f: GetOpsFnOp<SIMDType>): SIMDZip;
  interleaveStream(f: GetOpsFnOp<SIMDType>): SIMDZip;
};
/** Shared SIMD lane, shuffle, and interleave helpers used by codegen and rewrites. */
export const SIMDUtils: SIMDUtilsAPI = /* @__PURE__ */ utils.deepFreeze({
  checkLane: (lanes: number, lane: number) => {
    if (!Number.isSafeInteger(lane) || lane < 0 || lane >= lanes)
      throw new Error(`invalid SIMD lane: ${lane} not in [0, ${lanes})`);
    return lane;
  },
  checkShufflePattern: (bytes: number, pattern: number[]) => {
    utils.aarray(pattern, 'pattern');
    if (pattern.length !== bytes)
      throw new Error(`invalid SIMD shuffle pattern length: ${pattern.length}, expected ${bytes}`);
    for (const i of pattern) SIMDUtils.checkLane(bytes * 2, i);
    return pattern;
  },
  // Convert lane pattern to byte pattern
  shuffleLanes: (laneSize: number, pattern: number[], bytes = 32) => {
    utils.aarray(pattern, 'pattern');
    // Default is two v128 inputs: 2 * v128.size = 2 * 16 = 32 bytes.
    const x = utils.chunks(utils.seq(bytes), laneSize);
    return pattern.flatMap((i) => {
      SIMDUtils.checkLane(x.length, i);
      return x[i];
    });
  },
  MASKS: {
    '64x2': {
      identity: [0, 1],
      even: [0, 2],
      odd: [1, 3],
      reverse: [1, 0],
      reverseBytes: [7, 6, 5, 4, 3, 2, 1, 0, 15, 14, 13, 12, 11, 10, 9, 8],
    },
    '32x4': {
      even: [0, 2, 4, 6],
      odd: [1, 3, 5, 7],
      interleave: { low: [0, 4, 1, 5], high: [2, 6, 3, 7] },
      reverse: [3, 2, 1, 0],
      transpose: { even: [0, 4, 2, 6], odd: [1, 5, 3, 7] },
      reverseBytes: [3, 2, 1, 0, 7, 6, 5, 4, 11, 10, 9, 8, 15, 14, 13, 12],
    },
    '16x8': {
      even: [0, 2, 4, 6, 8, 10, 12, 14],
      odd: [1, 3, 5, 7, 9, 11, 13, 15],
      interleave: { low: [0, 8, 1, 9, 2, 10, 3, 11], high: [4, 12, 5, 13, 6, 14, 7, 15] },
      transpose: { even: [0, 8, 2, 10, 4, 12, 6, 14], odd: [1, 9, 3, 11, 5, 13, 7, 15] },
      reverse: [3, 2, 1, 0, 7, 6, 5, 4],
      reverseBytes: [1, 0, 3, 2, 5, 4, 7, 6, 9, 8, 11, 10, 13, 12, 15, 14],
    },
    '8x16': {
      even: [0, 2, 4, 6, 8, 10, 12, 14, 16, 18, 20, 22, 24, 26, 28, 30],
      odd: [1, 3, 5, 7, 9, 11, 13, 15, 17, 19, 21, 23, 25, 27, 29, 31],
      interleave: {
        low: [0, 16, 1, 17, 2, 18, 3, 19, 4, 20, 5, 21, 6, 22, 7, 23],
        high: [8, 24, 9, 25, 10, 26, 11, 27, 12, 28, 13, 29, 14, 30, 15, 31],
      },
      transpose: {
        even: [0, 16, 2, 18, 4, 20, 6, 22, 8, 24, 10, 26, 12, 28, 14, 30],
        odd: [1, 17, 3, 19, 5, 21, 7, 23, 9, 25, 11, 27, 13, 29, 15, 31],
      },
    },
  },
  zip32: (f: GetOpsFnOp<SIMDType>) => ({
    encode: (v: FnOp[]) => {
      const { low, high } = SIMDUtils.MASKS['32x4'].interleave;
      // A0=[a0..a3], A1=[b0..b3], A2=[c0..c3], A3=[d0..d3]
      const acLo = f.shuffleLanes(v[0], v[2], low); //  [a0,c0,a1,c1]
      const acHi = f.shuffleLanes(v[0], v[2], high); // [a2,c2,a3,c3]
      const bdLo = f.shuffleLanes(v[1], v[3], low); //  [b0,d0,b1,d1]
      const bdHi = f.shuffleLanes(v[1], v[3], high); // [b2,d2,b3,d3]
      return [
        f.shuffleLanes(acLo, bdLo, low), //  [a0,b0,c0,d0]
        f.shuffleLanes(acLo, bdLo, high), // [a1,b1,c1,d1]
        f.shuffleLanes(acHi, bdHi, low), //  [a2,b2,c2,d2]
        f.shuffleLanes(acHi, bdHi, high), // [a3,b3,c3,d3]
      ];
    },
    decode: (v: FnOp[]) => {
      const { even, odd } = SIMDUtils.MASKS['32x4'];
      // recover ac/bd low/high groups from output pairs
      const acLo = f.shuffleLanes(v[0], v[1], even); // [a0,c0,a1,c1]
      const bdLo = f.shuffleLanes(v[0], v[1], odd); //  [b0,d0,b1,d1]
      const acHi = f.shuffleLanes(v[2], v[3], even); // [a2,c2,a3,c3]
      const bdHi = f.shuffleLanes(v[2], v[3], odd); //  [b2,d2,b3,d3]
      // rebuild A,B,C,D
      return [
        f.shuffleLanes(acLo, acHi, even), // A: [a0,a1,a2,a3]
        f.shuffleLanes(bdLo, bdHi, even), // B: [b0,b1,b2,b3]
        f.shuffleLanes(acLo, acHi, odd), //  C: [c0,c1,c2,c3]
        f.shuffleLanes(bdLo, bdHi, odd), //  D: [d0,d1,d2,d3]
      ];
    },
  }),
  zip64Single: (f: GetOpsFnOp<SIMDType>, v: FnOp[]) => {
    const { even, odd } = SIMDUtils.MASKS['64x2'];
    // A[0]=[a0,a1], A[1]=[b0,b1]  ->  [a0,b0], [a1,b1]
    return [f.shuffleLanes(v[0], v[1], even), f.shuffleLanes(v[0], v[1], odd)];
  },
  zip64: (f: GetOpsFnOp<SIMDType>) => ({
    encode: (values: FnOp[]) => SIMDUtils.zip64Single(f, values),
    decode: (values: FnOp[]) => SIMDUtils.zip64Single(f, values),
  }),
  zipPow2: (f: GetOpsFnOp<SIMDType>, masks: { even: number[]; odd: number[] }) => {
    const { even, odd } = masks;
    const transpose = (values: FnOp[]) => {
      let cur = values.slice();
      for (let step = 1; step < cur.length; step *= 2) {
        const next = cur.slice();
        for (let i = 0; i < cur.length; i += step * 2) {
          for (let j = 0; j < step; j++) {
            const a = i + j;
            const b = a + step;
            next[a] = f.shuffleLanes(cur[a], cur[b], even);
            next[b] = f.shuffleLanes(cur[a], cur[b], odd);
          }
        }
        cur = next;
      }
      return cur;
    };
    return {
      encode: transpose,
      decode: transpose,
    };
  },
  getZip: (f: GetOpsFnOp<SIMDType>) => {
    const lanes = lanesOf(f.name);
    if (lanes === 4) return SIMDUtils.zip32(f);
    else if (lanes === 2) return SIMDUtils.zip64(f);
    else if (lanes === 8) return SIMDUtils.zipPow2(f, SIMDUtils.MASKS['16x8']);
    else if (lanes === 16) return SIMDUtils.zipPow2(f, SIMDUtils.MASKS['8x16']);
    throw new Error('wrong number of lanes (only 2, 4, 8, 16 supported)');
  },
  interleaveStream: (f: GetOpsFnOp<SIMDType>) => ({
    // Encodes sequantial chunks of data into SIMD friendly format: [chunk0, chunk1] -> [chunk0[0], chunk1[1], ...]
    // simd version to raw bytes
    encode(values: FnOp[]) {
      checkInterleave(f.name, values);
      const lanes = lanesOf(f.name);
      const perStream = (values.length / lanes) | 0;
      const out: FnOp[] = [];
      for (let t = 0; t < perStream; t++) {
        // load one vector from each stream block
        const A: FnOp[] = [];
        for (let s = 0; s < lanes; s++) A.push(values[s * perStream + t]);
        const zip = SIMDUtils.getZip(f as any);
        out.push(...zip.encode(A));
      }
      return out;
    },
    // raw bytes to simd version
    decode(values: FnOp[]) {
      checkInterleave(f.name, values);
      const lanes = lanesOf(f.name);
      const perStream = (values.length / lanes) | 0;
      // process tiles of `lanes` interleaved vectors
      const out = values.slice();
      for (let t = 0; t < perStream; t++) {
        const base = t * lanes;
        const zip = SIMDUtils.getZip(f as any);
        const r = zip.decode(values.slice(base, base + lanes));
        for (let i = 0; i < r.length; i++) out[i * perStream + t] = r[i];
      }
      return out;
    },
  }),
});

/**
 * Reinterprets a signed 32-bit value as unsigned.
 *
 * @param x - Number or bigint to wrap to 32 bits.
 * @returns Unsigned 32-bit bigint.
 * @example
 * ```js
 * i32ToU32(-1);
 * ```
 */
export const i32ToU32 = (x: number | bigint): bigint => {
  if (typeof x !== 'number' && typeof x !== 'bigint')
    throw new TypeError(`"x" expected number or bigint, got type=${typeof x}`);
  return BigInt.asUintN(32, BigInt(x));
};
/**
 * Reinterprets a signed 64-bit value as unsigned.
 *
 * @param x - Number or bigint to wrap to 64 bits.
 * @returns Unsigned 64-bit bigint.
 * @example
 * ```js
 * i64ToU64(-1n);
 * ```
 */
export const i64ToU64 = (x: number | bigint): bigint => BigInt.asUintN(64, BigInt(x));
/**
 * Reinterprets an unsigned 32-bit value as signed.
 *
 * @param x - Number or bigint to wrap to 32 bits.
 * @returns Signed 32-bit bigint.
 * @example
 * ```js
 * u32ToI32(0xffff_ffff);
 * ```
 */
export const u32ToI32 = (x: number | bigint): bigint => {
  if (typeof x !== 'number' && typeof x !== 'bigint')
    throw new TypeError(`"x" expected number or bigint, got type=${typeof x}`);
  return BigInt.asIntN(32, BigInt(x));
};
/**
 * Reinterprets an unsigned 64-bit value as signed.
 *
 * @param x - Number or bigint to wrap to 64 bits.
 * @returns Signed 64-bit bigint.
 * @example
 * ```js
 * u64ToI64(0xffff_ffff_ffff_ffffn);
 * ```
 */
export const u64ToI64 = (x: number | bigint): bigint => BigInt.asIntN(64, BigInt(x));

function checkInterleave(type: TypeName, values: FnOp[]) {
  const lanes = lanesOf(type);
  if (!Array.isArray(values)) throw new Error('interleave: expected array');
  if (values.length % lanes !== 0)
    throw new Error('interleave: values.length not multiple of lanes');
  return values;
}

type MapVals<A extends readonly unknown[], To> = { [I in keyof A]: ReplaceVal<A[I], To> };

// prettier-ignore
/** Replaces branded compiler values inside a type with another representation. */
export type ReplaceVal<T, To> =
  T extends Val<any, any> ? To :   // replace branded value type
  T extends (...args: infer A) => infer R ? (...args: MapVals<A, To>) => ReplaceVal<R, To> : // functions
  // T extends readonly (infer U)[] ? readonly ReplaceVal<U, To>[] : // tuples
  T extends (infer U)[] ? ReplaceVal<U, To>[] : // arrays
  T extends object ? { [K in keyof T]: ReplaceVal<T[K], To> } : // objects
  T; // primitives

/** Operation helper surface specialized to raw `FnOp` values. */
export type GetOpsFnOp<T extends TypeName> = ReplaceVal<GetOps<T>, FnOp>;
function genType<T extends TypeName>(fn: ModuleGraph, name: T): GetOpsFnOp<T> {
  const lanes = lanesOf(name);
  const coder = TypeCoders[name];
  const isBig = BigIntType.has(name);
  const res: Record<string, any> = {
    name,
    const: (value: number | bigint) => {
      if ((Width64.has(name) && IntType.has(name)) || isBig) value = BigInt(value);
      else {
        value = Number(value);
        // Keep f64 constants at JS double precision; only f32 lanes are rounded before encoding.
        if (FloatType.has(name) && Width32.has(name)) value = Math.fround(value);
      }
      const bytes = coder.encode(SIMDType.has(name) ? new Array(lanes).fill(value) : value);
      return fn.op(name, 'const', [], { value: SIMDType.has(name) ? bytes : value, type: name });
    },
    laneOffsets: (offset?: number) => res['const'](0 + (offset || 0)),
    select: (cond: FnOp, a: FnOp, b: FnOp) => {
      const condNode = fn.ops.get(cond.idx);
      if (condNode.kind !== 'op') throw new Error('wrong condNode');
      if (SIMDType.has(name) && normSignedness(name) === normSignedness(condNode.type)) {
        return fn.op(name, 'bitselect', [a, b, cond]);
      }
      // these will be like u64.eq(something), which returns i32 which we can use in normal select
      return fn.op(name, 'select', [a, b, cond]);
    },
    swapEndianness: (lhs: FnOp) => {
      if (SIMDType.has(name)) {
        if (Width8.has(name)) return lhs;
        if (Width16.has(name))
          return fn.op(name, 'shuffle', [lhs, lhs], { pattern: utils.seq(16).map((i) => i ^ 1) });
        return fn.op(name, 'shuffle', [lhs, lhs], {
          pattern: SIMDUtils.MASKS[Width32.has(name) ? '32x4' : '64x2'].reverseBytes,
        });
      }
      if (name === 'i8' || name === 'u8' || name === 'i16' || name === 'u16')
        return fn.op(name, 'swapEndianness', [lhs]);
      // arm/x86 asm has nice instructions for bswap, but v8 won't create them from code (only dataview stuff).
      // byteswap for u64 is 8 shifts + 8 ands (mask), then something like 4 or, which is a lot.
      // fortunately we have SIMD where we can do this in 1 instrct (swizzle would be rev32/rev64 on vector)
      const vTypeName = minSimdType(name);
      const vT = fn.types[vTypeName];
      const a = convert(fn, name, vTypeName, lhs)[0]; // splat
      const b = vT.swapEndianness(a);
      return convert(fn, vTypeName, name, b)[0]; // extract lanes
    },
    // Conversion
    to: (tType: TypeName, value: FnOp | FnOp[]) => convert(fn, name, tType, value),
    from: (fType: TypeName, value: FnOp | FnOp[]) => convert(fn, fType, name, value),
    toN: (tType: TypeName, value: FnOp | FnOp[]) => convert(fn, name, tType, value)[0],
    fromN: (fType: TypeName, value: FnOp | FnOp[]) => convert(fn, fType, name, value)[0],
    castFrom: (fType: TypeName, value: FnOp) => cast(fn, fType, name, value)[0],
    castTo: (tType: TypeName, value: FnOp) => cast(fn, name, tType, value)[0],
  };

  for (const op of opsForType(name)) {
    if (res[op]) continue;
    if (opsShifts.has(op)) {
      res[op] = (value: FnOp, shift: number | FnOp) => {
        const { i32 } = fn.types;
        if (typeof shift === 'number') shift = isBig ? res.const(shift) : i32.const(shift);
        checkType(fn, name, value);
        if (!isBig) {
          checkType(fn, 'i32', shift as FnOp);
          if (
            !SIMDType.has(name) &&
            name !== 'i8' &&
            name !== 'u8' &&
            name !== 'i16' &&
            name !== 'u16'
          )
            shift = res.fromN('i32', shift);
        } else {
          checkType(fn, name, shift as FnOp);
        }
        return fn.op(name, op, [value, shift as FnOp]);
      };
    } else if (ops1Arg.has(op) || ops2Arg.has(op)) {
      res[op] = (...args: FnOp[]) => {
        if (!opsVariadic.has(op)) {
          if (ops1Arg.has(op) && args.length !== 1)
            throw new Error(`wrong argument length: ${args.length}, expected 1`);
          if (ops2Arg.has(op) && args.length !== 2)
            throw new Error(`wrong argument length: ${args.length}, expected 2`);
        }
        for (const a of args) checkType(fn, name, a);
        return fn.op(name, op, args);
      };
    }
  }
  if (SIMDType.has(name)) {
    const interleave = SIMDUtils.interleaveStream(res as any);
    const laneCoder = TypeCoders[ScalarOf(name)];
    Object.assign(res, {
      laneOffsets: (offset?: number) => {
        let vals = utils.seq(lanes);
        if (offset !== undefined) vals = vals.map((i) => i + offset);
        if (name.includes('i64') || name.includes('u64')) vals = vals.map(BigInt) as any;
        const value = coder.encode(vals);
        return fn.op(name, 'const', [], { value, type: name });
      },
      splat: (lhs: FnOp) => fn.op(name, 'splat', [lhs]),
      shuffle: (lhs: FnOp, rhs: FnOp, pattern: number[]) =>
        fn.op(name, 'shuffle', [lhs, rhs], {
          pattern: SIMDUtils.checkShufflePattern(sizeof(name), pattern),
        }),
      // per lane shuffle (easier to read)
      shuffleLanes: (lhs: FnOp, rhs: FnOp, pattern: number[]) =>
        res.shuffle(lhs, rhs, SIMDUtils.shuffleLanes(laneCoder.size!, pattern, sizeof(name) * 2)),
      swizzle: (lhs: FnOp, mask: FnOp) => fn.op(name, 'swizzle', [lhs, mask]),
      interleave: (values: FnOp[]) => interleave.encode(checkInterleave(name, values)),
      deinterleave: (values: FnOp[]) => interleave.decode(checkInterleave(name, values)),
      rol: (v: FnOp, k: number) =>
        res.shuffleLanes(
          v,
          v,
          Array.from({ length: lanes }, (_, i) => (i + (((k % lanes) + lanes) % lanes)) % lanes)
        ),
      ror: (v: FnOp, k: number) => res['rol'](v, (lanes - (k % lanes)) % lanes),
      extractLane: (lhs: FnOp, lane: number) =>
        fn.op(name, 'extract_lane', [lhs], { lane: SIMDUtils.checkLane(lanes, lane) }),
      replaceLane: (lhs: FnOp, lane: number, laneValue: FnOp) =>
        fn.op(name, 'replace_lane', [lhs, laneValue], {
          lane: SIMDUtils.checkLane(lanes, lane),
        }),
      /*
Pairwise reductions:
t1 = shuffle1([a,b,c,d])         // [b,*,d,*]
t2 = op([a,b,c,d], t1)           // [a⊕b,*,c⊕d,*]
t3 = shuffle2(t2)                // [c⊕d,*,*,*]  (lane2 -> 0)
final = op(t2, t3)               // (a⊕b) ⊕ (c⊕d)
  */
    });
  }
  return res as GetOpsFnOp<T>;
}

/**
 * Returns an all-ones scalar mask for integer scalar types.
 *
 * @param type - Integer scalar type name.
 * @returns JavaScript number or bigint mask matching the type width.
 * @throws If the type is not an implemented integer scalar. {@link Error}
 * @example
 * ```js
 * getMask('u32');
 * ```
 */
export function getMask(
  type: TypeName
):
  | typeof I64_MASK_N
  | typeof U64_MASK_N
  | typeof I_MASK
  | typeof U32_MASK
  | typeof U16_MASK
  | typeof U8_MASK {
  if (type === 'i64') return I64_MASK_N;
  else if (type === 'u64') return U64_MASK_N;
  else if (type === 'i32') return I_MASK;
  else if (type === 'u32') return U32_MASK;
  else if (type === 'i16') return I_MASK;
  else if (type === 'u16') return U16_MASK;
  else if (type === 'i8') return I_MASK;
  else if (type === 'u8') return U8_MASK;
  else throw new Error('not implemented');
}

function convert(
  f: ModuleGraph,
  fromType: TypeName,
  toType: TypeName,
  value: FnOp | FnOp[]
): FnOp[] {
  if (typeof fromType !== 'string') throw new Error(`wrong type: ${fromType}`);
  if (typeof toType !== 'string') throw new Error(`wrong type: ${toType}`);
  const T = f.types[toType] as GetOpsFnOp<any>;
  const F = f.types[fromType] as GetOpsFnOp<any>;
  const smallScalar = (t: TypeName) => SmallIntType.has(t) && ScalarType.has(t);
  const bigScalar = (t: TypeName) => BigIntScalarType.has(t);
  const bigParts = (t: TypeName) => sizeof(t) / 8;
  const bigPartType = (t: TypeName) => (t.startsWith('i') ? 'i64' : 'u64') as TypeName;
  const sameSignedness = (a: TypeName, b: TypeName) => a.startsWith('i') === b.startsWith('i');
  if (bigScalar(fromType) || bigScalar(toType)) {
    if (SIMDType.has(fromType) || SIMDType.has(toType))
      throw new Error('big-int SIMD not supported');
    if (!sameSignedness(fromType, toType))
      throw new Error(`convert(${fromType} -> ${toType}): signedness mismatch`);
    if (bigScalar(toType)) {
      const partType = bigPartType(toType);
      const parts = bigParts(toType);
      const partOps = f.types[partType] as GetOpsFnOp<any>;
      const zero = partOps.const(0);
      const shift63 = partOps.const(63);
      const fill = (v: FnOp) =>
        partType.startsWith('i') ? f.op(partType, 'shr', [v, shift63]) : zero;
      const makeVirtual = (vals: FnOp[]) => [f.op(toType, 'virtual', vals)];
      if (Array.isArray(value)) {
        if (fromType === partType && value.length === parts) return makeVirtual(value);
        if ((fromType === 'u32' || fromType === 'i32') && value.length === parts * 2) {
          const out = [];
          for (let i = 0; i < parts; i++) {
            const lo = value[i * 2];
            const hi = value[i * 2 + 1];
            out.push(convert(f, fromType, partType, [lo, hi])[0]);
          }
          return makeVirtual(out);
        }
        throw new Error(`convert(${fromType} -> ${toType}): wrong length`);
      }
      if (fromType === 'u32' || fromType === 'i32' || fromType === 'u64' || fromType === 'i64') {
        const lo = convert(f, fromType, partType, value)[0];
        const hi = fill(lo);
        return makeVirtual([lo, ...new Array(parts - 1).fill(hi)]);
      }
      throw new Error(`convert(${fromType} -> ${toType}): not implemented`);
    }
    if (!bigScalar(fromType)) throw new Error(`convert(${fromType} -> ${toType}): not implemented`);
    const partType = bigPartType(fromType);
    const parts = bigParts(fromType);
    let vals = Array.isArray(value) ? value : undefined;
    if (!vals) {
      const node = as(f.ops.get((value as FnOp).idx), 'op');
      if (node.op === 'virtual') vals = node.args.map((i) => f.byIdx(i));
    }
    if (!vals || vals.length !== parts)
      throw new Error(`convert(${fromType} -> ${toType}): wrong length`);
    if (toType === partType) return vals;
    if (toType === 'u32' || toType === 'i32') {
      const out = [];
      for (const part of vals) out.push(...convert(f, partType, toType, part));
      return out;
    }
    throw new Error(`convert(${fromType} -> ${toType}): not implemented`);
  }
  if (
    IntType.has(fromType) &&
    IntType.has(toType) &&
    !SIMDType.has(fromType) &&
    !SIMDType.has(toType)
  ) {
    const sizeFrom = sizeof(fromType);
    const sizeTo = sizeof(toType);
    if (sizeFrom > sizeTo && sizeFrom % sizeTo === 0) {
      if (Array.isArray(value)) throw new Error('not implemented');
      const count = sizeFrom / sizeTo;
      const parts = [];
      for (let i = 0; i < count; i++) {
        const shift = i * sizeTo * 8;
        const part = shift === 0 ? value : F.shr(value, shift);
        parts.push(f.op(toType, 'smallCast', [part], { from: fromType }));
      }
      return parts;
    }
  }
  if (
    !SIMDType.has(fromType) &&
    !SIMDType.has(toType) &&
    (smallScalar(fromType) || smallScalar(toType))
  ) {
    if (Array.isArray(value)) throw new Error('not implemented');
    return [f.op(toType, 'smallCast', [value], { from: fromType })];
  }
  if (SIMDType.has(toType) && BigIntType.has(ScalarOf(toType)) && !SIMDType.has(fromType)) {
    if (Array.isArray(value)) {
      if (value.length !== lanesOf(toType)) throw new Error('lanes!==value.length');
      let acc = T.const(0);
      for (let i = 0; i < value.length; i++) acc = T.replaceLane(acc, i, value[i]);
      return [acc];
    }
    const laneType = ScalarOf(toType) as TypeName;
    const laneVal = convert(f, fromType, laneType, value)[0];
    return convert(f, laneType, toType, laneVal);
  }
  // Basic
  if (fromType === 'f32' && toType === 'f64') {
    if (Array.isArray(value)) throw new Error('not implemented');
    return [f.op(toType, 'promote_f32', [value])];
  } else if (fromType === 'f64' && toType === 'f32') {
    if (Array.isArray(value)) throw new Error('not implemented');
    return [f.op(toType, 'demote_f64', [value])];
  } else if (
    (fromType === 'f32' || fromType === 'f64') &&
    (toType === 'i32' || toType === 'u32' || toType === 'i64' || toType === 'u64')
  ) {
    if (Array.isArray(value)) throw new Error('not implemented');
    const sign = toType.startsWith('i') ? '_s' : '_u';
    const resultType = toType.includes('64') ? 'i64' : 'i32';
    return [f.op(resultType, `trunc_${fromType}${sign}`, [value])];
  } else if (
    (fromType === 'i32' || fromType === 'u32' || fromType === 'i64' || fromType === 'u64') &&
    (toType === 'f32' || toType === 'f64')
  ) {
    if (Array.isArray(value)) throw new Error('not implemented');
    const sign = fromType.startsWith('i') ? '_s' : '_u';
    const srcType = fromType.includes('64') ? 'i64' : 'i32';
    return [f.op(toType, `convert_${srcType}${sign}`, [value])];
  } else if (
    (fromType === 'i8x16' || fromType === 'u8x16') &&
    (toType === 'i16x8' || toType === 'u16x8')
  ) {
    if (Array.isArray(value)) throw new Error('non implemented');
    const sign = fromType.startsWith('i') ? '_s' : '_u';
    return [
      f.op(toType, `extend_low_i8x16${sign}`, [value]),
      f.op(toType, `extend_high_i8x16${sign}`, [value]),
    ];
  } else if (
    (fromType === 'i16x8' || fromType === 'u16x8') &&
    (toType === 'i32x4' || toType === 'u32x4')
  ) {
    if (Array.isArray(value)) throw new Error('non implemented');
    const sign = fromType.startsWith('i') ? '_s' : '_u';
    return [
      f.op(toType, `extend_low_i16x8${sign}`, [value]),
      f.op(toType, `extend_high_i16x8${sign}`, [value]),
    ];
  } else if (
    (fromType === 'i32x4' || fromType === 'u32x4') &&
    (toType === 'i64x2' || toType === 'u64x2')
  ) {
    if (Array.isArray(value)) throw new Error('non implemented');
    const sign = fromType.startsWith('i') ? '_s' : '_u';
    return [
      f.op(toType, `extend_low_i32x4${sign}`, [value]),
      f.op(toType, `extend_high_i32x4${sign}`, [value]),
    ];
  } else if (
    (fromType === 'i32x2' || fromType === 'u32x2') &&
    (toType === 'i64x2' || toType === 'u64x2')
  ) {
    if (Array.isArray(value)) throw new Error('non implemented');
    const sign = fromType.startsWith('i') ? '_s' : '_u';
    return [f.op(toType, `extend_low_i32x4${sign}`, [value])];
  } else if (
    (fromType === 'u64x2' || fromType === 'i64x2') &&
    (toType === 'u32x2' || toType === 'i32x2')
  ) {
    const { u32x4 } = f.types;
    const zero = u32x4.const(0);
    if (Array.isArray(value)) throw new Error('not supported');
    return [
      u32x4.shuffleLanes(value, zero, [0, 2, 4, 4]),
      u32x4.shuffleLanes(value, zero, [1, 3, 4, 4]),
    ];
  } else if (
    (fromType === 'u64x4' || fromType === 'i64x4') &&
    (toType === 'u32x4' || toType === 'i32x4')
  ) {
    if (Array.isArray(value)) throw new Error('not supported');
    return [
      f.op(fromType, 'to_i32_low', [value], { type: toType }),
      f.op(fromType, 'to_i32_high', [value], { type: toType }),
    ];
  } else if ((fromType === 'u32' || fromType === 'i32') && (toType === 'u64' || toType === 'i64')) {
    // depends on source only
    // i64.from(i32) -> i64.extend_i32_s
    // i64.from(u32) -> i64.extend_i32_u
    // u64.from(i32) -> i64.extend_i32_s
    // u64.from(u32) -> i64.extend_i32_u
    // 1-arg: true extension (depends on source signedness)
    const sign = fromType.startsWith('i') ? '_s' : '_u';
    const op = `extend_i32${sign}`;
    // 2-arg: value is already split [lo, hi] => PACK BITS, do NOT sign-extend lo
    if (Array.isArray(value)) {
      if (value.length !== 2) throw new Error('wrong length');
      const lo32 = value[0];
      const hi32 = value[1];
      const lo = f.op(toType, 'extend_i32_u', [lo32]);
      const hi = f.op(toType, 'extend_i32_u', [hi32]);
      return [T.or(T.shl(hi, 32), lo)];
    }
    const val = value;
    return [f.op(toType, op, [val])];
  } else if (
    (fromType === 'u64' && toType === 'u32') ||
    (fromType === 'i64' && toType === 'i32') ||
    (fromType === 'u64' && toType === 'i32') ||
    (fromType === 'i64' && toType === 'u32')
  ) {
    if (Array.isArray(value) && value.length !== 1) throw new Error('wrong length');
    const val = Array.isArray(value) ? value[0] : value;
    //console.log('to i64', this.ops.get(val.idx), new Error().stack);
    // lo, hi
    return [f.op(toType, 'wrap_i64', [val]), f.op(toType, 'wrap_i64', [F.shr(val, 32)])];
  } else if (
    fromType === toType ||
    (fromType === 'i32' && toType === 'u32') ||
    (fromType === 'u32' && toType === 'i32') ||
    (fromType === 'i64' && toType === 'u64') ||
    (fromType === 'u64' && toType === 'i64')
  ) {
    return Array.isArray(value) ? value : [value];
  } else if (
    ['i32', 'u32'].includes(fromType) &&
    ['u64x2', 'i64x2', 'i64x4', 'u64x4'].includes(toType)
  ) {
    // TODO: simplify this?
    const t = convert(f, fromType, 'u64', value)[0];
    return convert(f, 'u64', toType, t);
  } else if (
    ['i64', 'u64'].includes(fromType) &&
    ['u32x4', 'i32x4', 'u32x2', 'i32x2'].includes(toType)
  ) {
    const sType = toType.split('x')[0] as TypeName;
    const chunks = convert(f, fromType, sType, value);
    return chunks.map((i) => convert(f, sType, toType, i)[0]);
  } else if (
    (fromType === 'i32' && toType === 'u32x4') ||
    (fromType === 'u32' && toType === 'i32x4') ||
    (fromType === 'i64' && toType === 'u64x2') ||
    (fromType === 'u64' && toType === 'i64x2')
  ) {
    const sType = toType.split('x')[0] as TypeName;
    const x = convert(f, fromType, sType, value as FnOp)[0];
    return convert(f, sType, toType, x);
  } else if ((fromType === 'i32' && toType === 'u64') || (fromType === 'u32' && toType === 'i64')) {
    // TODO: just normalize signedness?
    const sType = (
      toType.startsWith('u') ? fromType.replace('i', 'u') : fromType.replace('u', 'i')
    ) as TypeName;
    const x = convert(f, fromType, sType, value as FnOp)[0];
    return convert(f, sType, toType, x);
  } else if (
    SIMDType.has(fromType) &&
    SIMDType.has(toType) &&
    lanesOf(fromType) === lanesOf(toType) &&
    sizeof(fromType) !== sizeof(toType)
  ) {
    const lanes = lanesOf(fromType);
    const fromLane = ScalarOf(fromType) as TypeName;
    const toLane = ScalarOf(toType) as TypeName;
    const toOps = T as GetOpsFnOp<any>;
    const build = (vals: FnOp[]) => {
      let acc = toOps.const(0);
      for (let i = 0; i < lanes; i++) acc = toOps.replaceLane(acc, i, vals[i]);
      return acc;
    };
    if (Array.isArray(value)) {
      if (value.length !== lanes) throw new Error('lanes!==value.length');
      const convs = value.map((v) => convert(f, fromLane, toLane, v));
      const parts = convs[0]?.length || 0;
      if (!parts) throw new Error('empty conversion');
      for (const c of convs) if (c.length !== parts) throw new Error('conversion arity mismatch');
      const outs = [];
      for (let p = 0; p < parts; p++) outs.push(build(convs.map((c) => c[p])));
      return outs;
    }
    const convs = utils.seq(lanes).map((i) => {
      const lane = (F as any).extractLane(value, i);
      return convert(f, fromLane, toLane, lane);
    });
    const parts = convs[0]?.length || 0;
    if (!parts) throw new Error('empty conversion');
    for (const c of convs) if (c.length !== parts) throw new Error('conversion arity mismatch');
    const outs = [];
    for (let p = 0; p < parts; p++) outs.push(build(convs.map((c) => c[p])));
    return outs;
  } else if (
    SIMDType.has(fromType) &&
    SIMDType.has(toType) &&
    sizeof(fromType) === sizeof(toType)
  ) {
    if (Array.isArray(value)) throw new Error('not supported');
    return [f.op(toType, 'cast', [value], { from: fromType })];
  } else if (normSignedness(toType).startsWith(`${normSignedness(fromType)}x`)) {
    if (Array.isArray(value)) {
      if (value.length !== lanesOf(toType)) throw new Error('lanes!==value.length');
      let acc = T.const(0);
      for (let i = 0; i < value.length; i++) acc = T.replaceLane(acc, i, value[i]);
      return [acc];
    }
    // chunk -> vector: splat
    return [(T as any).splat(value)];
  } else if (normSignedness(fromType).startsWith(`${normSignedness(toType)}x`)) {
    if (Array.isArray(value)) return value.map((i) => convert(f, fromType, toType, i)).flat(1);
    // vector -> chunk: extractLanes
    return utils.seq(lanesOf(fromType)).map((i) => F.extractLane(value, i)); // vector -> scalar
  }
  throw new Error(`convert(${fromType} -> ${toType}): not implemented`);
}

function cast(f: ModuleGraph, fromType: TypeName, toType: TypeName, value: FnOp): FnOp[] {
  if (fromType === toType) return [value];
  const isScalar = (t: TypeName) => !SIMDType.has(t);
  const isSmall = (t: TypeName) => SmallIntType.has(t) && ScalarType.has(t);
  if (Array.isArray(value)) throw new Error('cast: arrays not supported');
  let ok = false;

  if (isScalar(fromType) && isScalar(toType)) {
    if (FloatType.has(fromType) || FloatType.has(toType)) {
      if (fromType === 'f32' && (toType === 'i32' || toType === 'u32')) {
        const bits = f.op('i32', 'reinterpret_f32', [value]);
        return [f.op(toType, 'cast', [bits], { from: 'i32' })];
      }
      if ((fromType === 'i32' || fromType === 'u32') && toType === 'f32')
        return [f.op('f32', 'reinterpret_i32', [value])];
      if (fromType === 'f64' && (toType === 'i64' || toType === 'u64')) {
        const bits = f.op('i64', 'reinterpret_f64', [value]);
        return [f.op(toType, 'cast', [bits], { from: 'i64' })];
      }
      if ((fromType === 'i64' || fromType === 'u64') && toType === 'f64')
        return [f.op('f64', 'reinterpret_i64', [value])];
      throw new Error(`cast(${fromType} -> ${toType}): size mismatch`);
    }
    const sizeMismatch = sizeof(fromType) !== sizeof(toType);
    if (sizeMismatch) {
      if (isSmall(fromType) || isSmall(toType)) {
        if (!(
          (isSmall(fromType) && (toType === 'i32' || toType === 'u32')) ||
          (isSmall(toType) && (fromType === 'i32' || fromType === 'u32'))
        ))
          throw new Error(`cast(${fromType} -> ${toType}): size mismatch`);
      } else throw new Error(`cast(${fromType} -> ${toType}): size mismatch`);
    }
    ok = true;
  }
  if (SIMDType.has(fromType) && SIMDType.has(toType)) {
    const fromLane = ScalarOf(fromType);
    const toLane = ScalarOf(toType);
    if (sizeof(fromLane) !== sizeof(toLane))
      throw new Error(`cast(${fromType} -> ${toType}): size mismatch`);
    if (lanesOf(fromType) !== lanesOf(toType))
      throw new Error(`cast(${fromType} -> ${toType}): size mismatch`);
    if (sizeof(fromType) !== sizeof(toType))
      throw new Error(`cast(${fromType} -> ${toType}): size mismatch`);
    ok = true;
  }
  if (!ok) throw new Error(`cast(${fromType} -> ${toType}): not implemented`);
  return [f.op(toType, 'cast', [value], { from: fromType })];
}

function genSIMDPairs<T extends TypeName>(f: ModuleGraph, typeName: T): GetOpsFnOp<T> {
  const nativeType = minSimdType(ScalarOf(typeName));
  const count = lanesOf(typeName) / lanesOf(nativeType);
  const res = genType(f, typeName);
  Object.assign(res, {
    pairCount: count,
    // Actual logic inside lowering
    interleave: (values: FnOp[]) =>
      values.map((_v, pos) =>
        f.op(typeName, 'interleave', checkInterleave(typeName, values), { pos })
      ),
    deinterleave: (values: FnOp[]) =>
      values.map((_v, pos) =>
        f.op(typeName, 'deinterleave', checkInterleave(typeName, values), { pos })
      ),
  });

  return res as GetOpsFnOp<T>;
}

function genSIMDBigInt<T extends TypeName>(f: ModuleGraph, typeName: T): GetOpsFnOp<T> {
  return genType(f, typeName) as GetOpsFnOp<T>;
}

function genSIMDMask<T extends TypeName>(f: ModuleGraph, typeName: T): GetOpsFnOp<T> {
  const res: Record<string, any> = genType(f, typeName);
  const count = lanesOf(typeName);
  const nativeType = minSimdType(ScalarOf(typeName));
  const innerLanes = lanesOf(nativeType);
  Object.assign(res, {
    maskCount: count,
    shuffleLanes: (lhs: FnOp, rhs: FnOp, pattern: number[]) => {
      utils.aarray(pattern, 'pattern');
      for (const i of pattern)
        if (i < 0 || i >= 2 * count) throw new Error(`pattern OOB: ${i} not in [0, ${2 * count})`);
      const res = pattern.map((i) => Math.floor(i / count) * innerLanes + (i % count));
      while (res.length < innerLanes) res.push(0); // pad to exact
      return f.op(typeName, 'shuffle', [lhs, rhs], {
        pattern: SIMDUtils.shuffleLanes(sizeof(ScalarOf(typeName)), res),
      });
    },
    // Re-uses u64x2 zipper, not generic!
    interleave: (values: FnOp[]) =>
      SIMDUtils.interleaveStream(res as any).encode(checkInterleave(typeName, values)),
    deinterleave: (values: FnOp[]) =>
      SIMDUtils.interleaveStream(res as any).decode(checkInterleave(typeName, values)),
  });
  return res as GetOpsFnOp<T>;
}
type AllTypes = { [K in TypeName]: GetOpsFnOp<K> };
/**
 * Creates operation helpers for every compiler type in one function graph.
 *
 * @param fn - Function graph that receives generated operations.
 * @returns Operation helper table by type name.
 * @example
 * ```js
 * import { Module } from '@awasm/compiler/module.js';
 * import { ModuleGraph } from '@awasm/compiler/codegen.js';
 * import { genTypes } from '@awasm/compiler/types.js';
 *
 * genTypes(new ModuleGraph('demo', {}, new Module('demo'), {}));
 * ```
 */
export function genTypes(fn: ModuleGraph): AllTypes {
  const res: Record<string, any> = {};
  for (const type of ScalarType) {
    res[type] = genType(fn, type);
    if (BigIntScalarType.has(type)) {
      const laneList = [2, 4, 8, 16];
      for (const lanes of laneList) {
        const simdType = addLanes(type, lanes);
        res[simdType] = genSIMDBigInt(fn, simdType);
      }
      continue;
    }
    const nativeLanes = lanesOf(minSimdType(type));
    const laneList = [2, 4, 8, 16];
    for (const lanes of laneList) {
      const simdType = addLanes(type, lanes);
      if (nativeLanes < lanes) res[simdType] = genSIMDPairs(fn, simdType);
      else if (nativeLanes > lanes) res[simdType] = genSIMDMask(fn, simdType);
      else res[simdType] = genType(fn, simdType);
    }
  }
  return res as AllTypes;
}

/** Result type returned by `genTypes`. */
export type TypesRes = ReturnType<typeof genTypes>;
/** Value types supported by the raw Wasm backend. */
export type WasmType =
  | 'i32'
  | 'i64'
  | 'f32'
  | 'f64'
  | 'v128'
  | 'i32x4'
  | 'i64x2'
  | 'f32x4'
  | 'f64x2'
  | 'i8x16'
  | 'i16x8';
/** Core Wasm value type used after compiler type normalization. */
export type WasmValueType = 'i32' | 'i64' | 'f32' | 'f64' | 'v128';

/**
 * Normalizes compiler type names to core Wasm value types.
 *
 * @param type - Compiler type name.
 * @returns Wasm value type name used in function signatures.
 * @throws If a bigint-only type cannot be represented by this backend. {@link Error}
 * @example
 * ```js
 * normType('u32');
 * ```
 */
export function normType(type: TypeName): WasmValueType {
  if (SIMDType.has(type)) return 'v128';
  if (BigIntType.has(type)) throw new Error(`normType(${type}): big-int not supported in codegen`);
  if (['i8', 'u8', 'i16', 'u16'].includes(type)) return 'i32';
  if (type === 'u32') return 'i32';
  if (type === 'u64') return 'i64';
  return type as WasmValueType;
}

/**
 * Normalizes a public return type specifier into Wasm result types.
 *
 * @param type - Return type specifier.
 * @returns Zero or more Wasm result type names.
 * @example
 * ```js
 * normRetType(['u32', 'f64']);
 * ```
 */
export function normRetType(type: RetType): WasmValueType[] {
  if (type === 'void') return [];
  return (Array.isArray(type) ? type : [type]).map((i) => normType(i));
}

/**
 * Computes the compiler type returned by an operation node.
 *
 * @param f - Function graph that owns the operation.
 * @param op - Operation handle whose return type is inspected.
 * @returns Compiler type name returned by the operation.
 * @example
 * ```js
 * import { Module } from '@awasm/compiler/module.js';
 * import { ModuleGraph } from '@awasm/compiler/codegen.js';
 * import { nodeRetType } from '@awasm/compiler/types.js';
 *
 * const graph = new ModuleGraph('demo', {}, new Module('demo'), {});
 * const op = graph.op('u32', 'const', [], { value: 0, type: 'u32' });
 * nodeRetType(graph, op);
 * ```
 */
export function nodeRetType(f: ModuleGraph, op: FnOp): TypeName {
  if (!P.utils.isPlainObject(f) || !('ops' in f))
    throw new TypeError(`"f" expected ModuleGraph, got type=${typeof f}`);
  if (!(op instanceof FnOp)) throw new TypeError(`"op" expected FnOp, got type=${typeof op}`);
  const node = as(f.ops.get(op.idx), 'op');
  let res = node.type;
  if (opsCompare.has(node.op)) return maskType(node.type);
  if (node.op === 'extract_lane') return ScalarOf(res);
  if (node.op === 'reinterpret_f32' || node.op === 'reinterpret_f64') return node.type;
  if (node.op === 'reinterpret_i32') return 'f32';
  if (node.op === 'reinterpret_i64') return 'f64';
  if (node.op === 'to_i32_low' || node.op === 'to_i32_high') return node.opts.type as TypeName;
  //console.log('NODE RET TYPE', node, res);
  return res;
}

/**
 * Builds the helper module used by runtime type operations.
 *
 * @param opts - Options controlling conversion and cast helper generation.
 * @returns Module containing per-operation runtime helper functions.
 * @example
 * ```js
 * genRuntimeTypeMod({ conversions: false });
 * ```
 */
export function genRuntimeTypeMod(opts: { conversions?: boolean; casts?: boolean } = {}): Module {
  if (!P.utils.isPlainObject(opts))
    throw new TypeError(`"opts" expected object, got type=${typeof opts}`);
  const conversions = opts.conversions !== false;
  const casts = opts.casts !== false;
  const mod = new Module('runtimeTypes');
  const isSmall = (t: TypeName) => SmallIntType.has(t) && ScalarType.has(t);
  const canCastScalar = (fromType: TypeName, toType: TypeName) => {
    if (fromType === toType) return true;
    if (FloatType.has(fromType) || FloatType.has(toType)) {
      return (
        (fromType === 'f32' && (toType === 'i32' || toType === 'u32')) ||
        ((fromType === 'i32' || fromType === 'u32') && toType === 'f32') ||
        (fromType === 'f64' && (toType === 'i64' || toType === 'u64')) ||
        ((fromType === 'i64' || fromType === 'u64') && toType === 'f64')
      );
    }
    if (sizeof(fromType) === sizeof(toType)) return true;
    return (
      (isSmall(fromType) && (toType === 'i32' || toType === 'u32')) ||
      (isSmall(toType) && (fromType === 'i32' || fromType === 'u32'))
    );
  };
  for (const typeName of ScalarType) {
    if (BigIntType.has(typeName)) continue;
    for (const op of opsForType(typeName)) {
      const outType = opsCompare.has(op) ? 'u32' : typeName;
      if (opsShifts.has(op)) {
        mod.fn(`${typeName}_${op}`, [typeName, 'i32'], typeName, (f, A, shift) => {
          return [(f.types[typeName] as any)[op](A, shift)];
        });
      } else if (ops1Arg.has(op)) {
        mod.fn(`${typeName}_${op}`, [typeName], outType, (f, A) => {
          return [(f.types[typeName] as any)[op](A)];
        });
      } else {
        mod.fn(`${typeName}_${op}`, [typeName, typeName], outType, (f, A, B) => {
          return [(f.types[typeName] as any)[op](A, B)];
        });
      }
    }
    if (conversions) {
      for (const oType of ScalarType) {
        if (oType === typeName) continue;
        if (BigIntType.has(oType)) continue;
        mod.fn(`${typeName}_from_${oType}`, [oType], typeName, (f, A) => {
          return f.types[typeName].from(oType, A);
        });
      }
    }
    if (casts) {
      for (const oType of ScalarType) {
        if (oType === typeName) continue;
        if (BigIntType.has(oType)) continue;
        if (!canCastScalar(oType, typeName)) continue;
        mod.fn(`${typeName}_cast_${oType}`, [oType], typeName, (f, A) => {
          return [f.types[typeName].castFrom(oType, A)];
        });
      }
    }
  }
  return mod;
}

/** Compiler options used for the runtime type helper module. */
export const TYPE_MOD_OPTS: CompilerOpts = /* @__PURE__ */ utils.deepFreeze({
  lowerPatternJS: true,
  lowerU64Arg: true,
  lowerSmallInt: true,
  jsOutObject: true,
});

// this allows us to do constant folding and stuff
let runtimeTypesCache: any;
/**
 * Generates executable runtime type helpers for optimizer constant folding.
 *
 * @returns Cached runtime type helper object.
 * @example
 * ```js
 * genRuntimeTypes();
 * ```
 */
export function genRuntimeTypes(): any {
  if (runtimeTypesCache) return runtimeTypesCache;
  const m = genRuntimeTypeMod({ conversions: false, casts: false });
  // Low level stuff
  for (const typeName of ['i32', 'u32'] as const) {
    m.fn(`${typeName}_wrap_i64`, ['i64'], typeName, (f, A) => {
      return [(f as any).rawFn.op(typeName, 'wrap_i64', [A])];
    });
    m.fn(`${typeName}_reinterpret_f32`, ['f32'], typeName, (f, A) => {
      return [(f as any).rawFn.op(typeName, 'reinterpret_f32', [A])];
    });
  }
  for (const typeName of ['i64', 'u64'] as const) {
    m.fn(`${typeName}_extend_i32_u`, ['i32'], typeName, (f, A) => {
      return [(f as any).rawFn.op(typeName, 'extend_i32_u', [A])];
    });
    m.fn(`${typeName}_extend_i32_s`, ['i32'], typeName, (f, A) => {
      return [(f as any).rawFn.op(typeName, 'extend_i32_s', [A])];
    });
    m.fn(`${typeName}_reinterpret_f64`, ['f64'], typeName, (f, A) => {
      return [(f as any).rawFn.op(typeName, 'reinterpret_f64', [A])];
    });
  }
  m.fn(`f32_reinterpret_i32`, ['i32'], 'f32', (f, A) => {
    return [(f as any).rawFn.op('f32', 'reinterpret_i32', [A])];
  });
  m.fn(`f64_reinterpret_i64`, ['i64'], 'f64', (f, A) => {
    return [(f as any).rawFn.op('f64', 'reinterpret_i64', [A])];
  });
  for (const typeName of ScalarType) {
    if (BigIntType.has(typeName)) continue;
    m.fn(`${typeName}_select`, ['i32', typeName, typeName], typeName, (f, cond, A, B) => {
      return [f.types[typeName].select(cond as any, A as any, B as any)];
    });
  }
  // Disabled optimization to avoid recursion (used for constant folding).
  const mWasm = js.exec(toWasm(m, { optimize: false }));
  const res: any = {};
  for (const typeName of ['i32', 'u32', 'i64', 'u64'] as const) {
    const tRes: any = {};
    // prettier-ignore
    for (const opName of [
      'add',
      'mul',
      'and',
      'xor',
      'or',
      'div',
      'sub',
      'rotl',
      'rotr',
      'shl',
      'shr',
      'eq',
      'ne',
      'lt',
      'gt',
      'le',
      'ge',
    ] as const) {
      if (['shl', 'shr', 'rotl', 'rotr'].includes(opName) && (typeName === 'i64' || typeName === 'u64')) {
        // Match wasm BigInt64 readback in tests: return signed BigInt for both i64/u64.
        tRes[opName] = (a: any, b: any) => {
          const aa = BigInt(a);
          const bb = BigInt(b) & _63n;
          const mask = (_1n << _64n) - _1n;
          const u = BigInt.asUintN(64, aa);
          if (opName === 'shl') {
            const res = BigInt.asUintN(64, u << bb);
            return BigInt.asIntN(64, res);
          }
          if (opName === 'shr') {
            if (typeName === 'u64') return BigInt.asIntN(64, BigInt.asUintN(64, u >> bb));
            return BigInt.asIntN(64, BigInt.asIntN(64, aa) >> bb);
          }
          const rot = opName === 'rotl' ? bb : (_64n - bb) & _63n;
          const res = BigInt.asUintN(64, ((u << rot) | (u >> ((_64n - rot) & _63n))) & mask);
          return BigInt.asIntN(64, res);
        };
        continue;
      }
      tRes[opName] = (...args: any) => args.reduce(mWasm[`${typeName}_${opName}`]);
    }
    for (const opName of ['not', 'eqz', 'ctz', 'clz', 'popcnt'] as const) {
      tRes[opName] = (...args: any) => mWasm[`${typeName}_${opName}`](args[0]);
    }
    if (['i32', 'u32'].includes(typeName)) {
      tRes['wrap_i64'] = (...args: any) => mWasm[`${typeName}_wrap_i64`](args[0]);
    }
    if (['i64', 'u64'].includes(typeName)) {
      tRes['extend_i32_u'] = (...args: any) => mWasm[`${typeName}_extend_i32_u`](args[0]);
      tRes['extend_i32_s'] = (...args: any) => mWasm[`${typeName}_extend_i32_s`](args[0]);
    }
    res[typeName] = tRes;
  }
  const simdCache = new Map<SIMDType, any>();
  const buildSimd = (typeName: SIMDType) => {
    const mSimd = new Module('runtimeTypesSimd');
    const laneType = ScalarOf(typeName);
    mSimd.mem(
      `state_${typeName}`,
      struct({
        A: typeName,
        B: typeName,
        C: typeName,
        D: typeName,
      })
    );
    for (const opName of opsForType(typeName)) {
      if (opsShifts.has(opName)) {
        mSimd.fn(`${typeName}_${opName}`, ['i32'], 'void', (f, shift) => {
          const T = f.getType(typeName);
          const { A, D } = (f.memory as any)[`state_${typeName}`];
          D.set(T[opName](A.get(), shift));
        });
      } else {
        mSimd.fn(`${typeName}_${opName}`, [], 'void', (f) => {
          const T = f.getType(typeName);
          const { A, B, D } = (f.memory as any)[`state_${typeName}`];
          if (ops1Arg.has(opName)) {
            D.set(T[opName](A.get()));
          } else {
            D.set(T[opName](A.get(), B.get()));
          }
        });
      }
    }
    mSimd.fn(`${typeName}_swizzle`, [], 'void', (f) => {
      const T = f.getType(typeName);
      const { A, B, D } = (f.memory as any)[`state_${typeName}`];
      D.set(T.swizzle(A.get(), B.get()));
    });
    mSimd.fn(`${typeName}_splat`, [laneType], 'void', (f, A) => {
      const T = f.getType(typeName);
      const { D } = (f.memory as any)[`state_${typeName}`];
      D.set(T.splat(A));
    });
    // Disabled optimization to avoid recursion (used for constant folding).
    const mSimdWasm = js.exec(toWasm(mSimd, { optimize: false }));
    const tRes: any = {};
    // we cannot use vectorized stuff in args, so we have to write them to buffer
    function call(
      opName: string,
      a?: TArg<Uint8Array>,
      b?: TArg<Uint8Array>,
      c?: TArg<Uint8Array>,
      shift?: number
    ) {
      const A = mSimdWasm.segments[`state_${typeName}.A`];
      const B = mSimdWasm.segments[`state_${typeName}.B`];
      const C = mSimdWasm.segments[`state_${typeName}.C`];
      const D = mSimdWasm.segments[`state_${typeName}.D`];
      if (a) A.set(a);
      if (b) B.set(b);
      if (c) C.set(c);
      // Shift count is scalar, unlike vector operands stored in helper memory.
      if (shift === undefined) mSimdWasm[`${typeName}_${opName}`]();
      else mSimdWasm[`${typeName}_${opName}`](shift);
      return D.slice();
    }
    for (const op of opsForType(typeName)) {
      if (opsShifts.has(op))
        tRes[op] = (value: TArg<Uint8Array>, shift: number) =>
          call(op, value, undefined, undefined, shift);
      else if (opsVariadic.has(op) || ops2Arg.has(op))
        tRes[op] = (...args: any) => args.reduce((acc: any, i: any) => call(op, acc, i));
      else if (ops1Arg.has(op)) tRes[op] = (...args: any) => call(op, args[0]);
    }
    tRes.swizzle = (...args: any) => call('swizzle', args[0], args[1]);
    return tRes;
  };
  const out = new Proxy(res, {
    get(target, prop) {
      if (typeof prop !== 'string') return (target as any)[prop];
      if (prop in target) return (target as any)[prop];
      if (!SIMDType.has(prop as TypeName)) return (target as any)[prop];
      const typeName = prop as SIMDType;
      if (BigIntType.has(typeName)) return;
      let cached = simdCache.get(typeName);
      if (!cached) {
        cached = buildSimd(typeName);
        simdCache.set(typeName, cached);
        (target as any)[prop] = cached;
      }
      return cached;
    },
  });
  runtimeTypesCache = out;
  return out;
}
