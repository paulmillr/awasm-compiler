// This is just AST builder.
// We can't have any compiler stuff in here, since it could be required by a runtime.
// But we can have a lot of types!
// Bonus: typescript acts as type-checker for this mini-language.
// Whole thing without types is small enough: just 30 lines.
import type { MemoryOpts } from './memory.ts';
import type {
  IntType,
  MaskType,
  OpsAtomics,
  OpsFnForType,
  SIMDType,
  ScalarOf,
  ScalarType,
  TypeName,
} from './types.ts'; // Can import only types here!
import { aarray, type ND } from './utils.ts';

/** Shift mask value used by integer shift operations. */
export type ShiftMask = Val<'u32'>;
type AddrDyn = Val<'u32'>;
/** Static or dynamic wasm32 memory address. */
export type Addr = number | Val<'u32'>;
/** Static or dynamic i32 shift amount. */
export type Shift = number | Val<'i32'>;
/** i32/u32 condition value used by control-flow helpers. */
export type Cond = Val<'i32'> | Val<'u32'>;

// Phantom type
// Brand
declare const brandSym: unique symbol;

/** Branded compiler value carrying its Wasm type and optional generic phantom. */
// S invariant; G phantom. When G=never, drop the field entirely.
export type Val<S extends TypeName, G = unknown> = symbol & {
  readonly [brandSym]: (x: S) => S;
} & ([G] extends [never] ? {} : { readonly __g?: G });

// OPS
type Expand<T> = T extends infer O ? { [K in keyof O]: O[K] } : never;

/** Typed operation surface available for compiler values of a specific type. */
export type GetOps<T extends TypeName, G = unknown> = Expand<
  {
    name: T & G;
    size: number;
    const: (v: number | bigint) => Val<T, G>;
    laneOffsets: (offset?: number) => Val<T, G>; // 0 for scalar, lane id for SIMD
    select: (cond: Val<MaskType<T>, G> | Val<'u32'>, a: Val<T, G>, b: Val<T, G>) => Val<T, G>;
    // conversions across *type names* (value shapes come from TV)
    to: <Dst extends TypeName>(t: Dst, v: Val<T, G> | Val<T, G>[]) => Val<Dst>[];
    from: <Src extends TypeName>(f: Src, v: Val<Src> | Val<Src>[]) => Val<T, G>[];
    toN: <Dst extends TypeName>(t: Dst, v: Val<T, G> | Val<T, G>[]) => Val<Dst>;
    fromN: <Src extends TypeName>(f: Src, v: Val<Src> | Val<Src>[]) => Val<T, G>;
    castFrom: <Src extends TypeName>(f: Src, v: Val<Src, G>) => Val<T, G>;
    castTo: <Dst extends TypeName>(t: Dst, v: Val<T, G>) => Val<Dst>;
  } & ([T] extends [SIMDType]
    ? {
        // virtual types
        pairCount?: number;
        laneCount?: number;
        extractLane: (x: Val<T, G>, lane: number) => Val<ScalarOf<T>, G>;
        replaceLane: (x: Val<T, G>, lane: number, v: Val<ScalarOf<T>, G>) => Val<T, G>;
        shuffle: (a: Val<T, G>, b: Val<T, G>, pat: number[]) => Val<T, G>;
        shuffleLanes: (a: Val<T, G>, b: Val<T, G>, pat: number[]) => Val<T, G>;
        swizzle: (a: Val<T, G>, mask: Val<T, G>) => Val<T, G>;
        rol: (x: Val<T, G>, n: number) => Val<T, G>;
        ror: (x: Val<T, G>, n: number) => Val<T, G>;
        splat: (s: Val<ScalarOf<T>, G>) => Val<T, G>;
        interleave: (xs: Val<T, G>[]) => Val<T, G>[];
        deinterleave: (xs: Val<T, G>[]) => Val<T, G>[];
      }
    : {}) &
    OpsFnForType<T, Val<T, G>, Shift, Val<MaskType<T>, G>>
>;

// type StrUnion<T> = T extends string ? `${T}` : never;
// type T1Ops = StrUnion<keyof GetOps<'u32'>>;

/*
type T1Ops =
  | "swapEndianness" | "add" | "mul" | "sub" | "div" | "rem" | "min" | "max"
  | "eq" | "ne" | "lt" | "gt" | "le" | "ge" | "eqz" | "and" | "or" | "xor"
  | "andnot" | "not" | "clz" | "ctz" | "popcnt" | "shr" | "shl" | "rotr"
  | "rotl" | "name" | "size" | "const" | "laneOffsets" | "select" | "to"
  | "from" | "toN" | "fromN"
*/
//type T2Ops = StrUnion<keyof GetOps<'f64x4'>>;
/*
type T2Ops =
  | "sub" | "name" | "select" | "const" | "eqz" | "eq" | "ne" | "lt" | "gt"
  | "le" | "ge" | "abs" | "neg" | "ceil" | "floor" | "trunc" | "nearest"
  | "sqrt" | "add" | "mul" | "div" | "min" | "max" | "copysign" | "shuffle"
  | "splat" | "size" | "swapEndianness" | "rem" | "isNaN" | "laneOffsets"
  | "to" | "from" | "toN" | "fromN" | "extractLane" | "replaceLane"
  | "shuffleLanes" | "rol" | "ror" | "interleave" | "deinterleave"
*/

// Nested memory regions
type AnySpecReal = ScalarSpec<TypeName, any> | StructSpec | ArraySpec;
type AnySpec = TypeName | GenericMemType<TypeName, any> | AnySpecReal;
type MemGenericBase<X> =
  X extends GenericMemType<infer TT, any> ? Extract<TT, TypeName> : Extract<X, TypeName>;
type MemGenericParam<X> = X extends GenericMemType<any, infer G> ? G : unknown;

type Normalized<T extends AnySpec> = T extends TypeName
  ? ScalarSpec<T, unknown>
  : T extends GenericMemType<any, any>
    ? ScalarSpec<MemGenericBase<T>, MemGenericParam<T>>
    : T extends ScalarSpec<infer TS, infer TG>
      ? ScalarSpec<TS, TG>
      : T extends StructSpec<infer F>
        ? StructSpec<{ [K in keyof F]: Normalized<F[K]> }>
        : T extends ArraySpec<infer E, infer S>
          ? ArraySpec<Normalized<E>, S>
          : never;

/** Memory specification for one scalar value. */
export interface ScalarSpec<T extends TypeName, Generic = unknown, Size extends number = number> {
  /** Discriminator for scalar memory nodes. */
  kind: 'scalar';
  /** Scalar type stored in memory. */
  type: T;
  /** Optional bound generic carried through typed memory access. */
  generic: Generic;
  /** Memory layout options for this scalar. */
  opts: Readonly<MemoryOpts>;
  /** Optional byte size override for byte-view scalar aliases. */
  size?: Size;
}
/**
 * Builds a scalar memory specification.
 *
 * @param type - Scalar type or generic scalar wrapper.
 * @param opts - Memory layout options. {@link MemoryOpts}
 * @returns Scalar memory specification.
 * @example
 * ```js
 * scalar('u32');
 * ```
 */
export function scalar<T extends TypeName | GenericMemType<any, any>>(
  type: T,
  opts: MemoryOpts = {}
): ScalarSpec<MemGenericType<T>, T extends GenericMemType<any, infer G> ? G : unknown> {
  return { kind: 'scalar', type, opts } as any;
}

/** Memory specification for a struct with named fields. */
export interface StructSpec<F extends Record<string, AnySpecReal> = Record<string, AnySpecReal>> {
  /** Discriminator for struct memory nodes. */
  kind: 'struct';
  /** Field specifications by field name. */
  fields: { [K in keyof F]: F[K] };
  /** Memory layout options for this struct. */
  opts: Readonly<MemoryOpts>;
}
/**
 * Builds a struct memory specification.
 *
 * @param fields - Field specifications by field name.
 * @param opts - Memory layout options. {@link MemoryOpts}
 * @returns Struct memory specification with shorthand string fields normalized.
 * @throws If the struct has no fields. {@link Error}
 * @example
 * ```js
 * struct({ word: 'u32' });
 * ```
 */
export function struct<F extends Record<string, AnySpec>>(
  fields: F,
  opts: MemoryOpts = {}
): StructSpec<{ [K in keyof F]: Normalized<F[K]> }> {
  if (Object.keys(fields).length === 0) throw new Error('struct: no fields');
  const nf: Record<string, AnySpec> = {};
  for (const k in fields) {
    const v = fields[k];
    nf[k] = typeof v === 'string' ? scalar(v as TypeName) : v;
  }
  return { kind: 'struct', fields: nf as any, opts };
}

type CollapseArray<T extends AnySpec, S extends readonly number[]> =
  T extends ArraySpec<infer E, infer S0 extends readonly number[]>
    ? CollapseArray<E, [...S, ...S0]>
    : ArraySpec<Normalized<T>, S>;

/** Memory specification for a multidimensional array. */
export interface ArraySpec<
  T extends AnySpecReal = AnySpecReal,
  S extends readonly number[] = readonly number[],
> {
  /** Discriminator for array memory nodes. */
  kind: 'array';
  /** Element memory specification. */
  type: T;
  /** Positive extents for every array dimension. */
  readonly sizes: S;
  /** Memory layout options for this array. */
  opts: Readonly<MemoryOpts>;
}
/**
 * Builds an array memory specification.
 *
 * @param type - Element type or element memory specification.
 * @param opts - Memory layout options. {@link MemoryOpts}
 * @param sizes - Positive safe-integer extents for every array dimension.
 * @returns Array memory specification with nested arrays collapsed into one shape.
 * @throws If no dimension is supplied or a dimension is invalid. {@link Error}
 * @example
 * ```js
 * array('u32', {}, 4);
 * ```
 */
export function array<T extends AnySpec, const S extends readonly number[]>(
  type: T,
  opts: MemoryOpts,
  ...sizes: S
): CollapseArray<T, S> {
  if (sizes.length === 0) throw new Error('array: empty');
  // Memory layout uses extents as multiplicative region sizes.
  let count = 1;
  for (const s of sizes) {
    if (!Number.isSafeInteger(s) || s <= 0) throw new Error('wrong array size');
    count *= s;
    if (!Number.isSafeInteger(count)) throw new Error('wrong array size');
  }
  let t = type as any;
  if (typeof t === 'string') t = scalar(t as any);
  if (t.kind === 'array')
    return (array as any)(t.type, { ...opts, ...t.opts }, ...sizes, ...t.sizes);
  return { kind: 'array', type: t, sizes, opts } as any;
}

/** Memory options plus an explicit integer width for low-level byte views. */
export type MemoryOptsWidth = MemoryOpts & {
  width: 8 | 16 | 32 | 64;
};

/** Any normalized top-level memory segment specification. */
export type SegMeta = AnySpecReal;

/** Named memory segment registry. */
export type Segs = Record<string, SegMeta>;
type GenericMemType<T extends TypeName, G extends T> = { type: T; generic: G };

/**
 * Carries a narrower generic scalar type through memory typing.
 *
 * @param t - Concrete scalar type to carry as a phantom generic.
 * @returns Runtime identity value with generic type metadata.
 * @example
 * ```js
 * toGeneric('u32');
 * ```
 */
export function toGeneric<T extends TypeName, G extends T>(t: G): GenericMemType<T, G> {
  return t as any;
}
type MemGenericType<X> = X extends { type: infer TT extends TypeName } ? TT : Extract<X, TypeName>;

type ResolvedVal<S extends AnySpec> =
  S extends ScalarSpec<infer T, infer G>
    ? Val<T, G>
    : S extends ArraySpec<infer E, infer Sizes>
      ? MultiDimArray<ResolvedVal<E>, Sizes>
      : S extends StructSpec<infer F>
        ? { [K in keyof F]: ResolvedVal<F[K]> }
        : never;

type DropFirst<T extends unknown[]> = T extends [any, ...infer U] ? U : T;

type MutOps<T extends TypeName, G> = {
  [K in keyof GetOps<T, G>]: GetOps<T, G>[K] extends (...args: any) => any
    ? (...args: DropFirst<Parameters<GetOps<T, G>[K]>>) => ReturnType<GetOps<T, G>[K]>
    : never;
} & {
  exchange(v: Val<T, G>): Val<T, G>;
  compareExchange(expected: Val<T, G>, replacement: Val<T, G>): Val<T, G>;
};

/** Atomic operation surface for integer scalar memory views. */
export type ScalarAtomics<T extends TypeName, G> = {
  /**
   * Emits an atomic load.
   *
   * @returns Loaded scalar value.
   */
  load(): Val<T, G>;
  /**
   * Emits an atomic store.
   *
   * @param v - Value to store.
   */
  store(v: Val<T, G> | number): void;
  /**
   * Emits an atomic exchange.
   *
   * @param v - Replacement value.
   * @returns Previous scalar value.
   */
  exchange(v: Val<T, G> | number): Val<T, G>;
  /**
   * Emits an atomic compare-exchange.
   *
   * @param expected - Value expected in memory.
   * @param replacement - Value written when the expected value matches.
   * @returns Previous scalar value.
   */
  compareExchange(expected: Val<T, G> | number, replacement: Val<T, G> | number): Val<T, G>;
  /**
   * Emits an atomic notify on this scalar address.
   *
   * @param count - Maximum number of waiters to notify.
   * @returns Count of woken waiters.
   */
  notify(count?: Val<'u32'> | number): Val<'u32'>;
  /**
   * Emits an atomic wait on this scalar address.
   *
   * @param expected - Expected scalar value.
   * @param timeout - Timeout in nanoseconds.
   * @returns Wait status: `0` ok, `1` timeout, or `2` not equal.
   */
  wait(expected: Val<T, G> | number, timeout: Val<'i64'> | number): Val<'u32'>;
  /** Emits an atomic fence. */
  fence(): void;
} & { [K in OpsAtomics]: (v: Val<T, G> | number) => Val<T, G> };

type IsByte<S extends AnySpecReal> =
  S extends ScalarSpec<any, any, infer Size> ? (Size extends 1 ? true : false) : false;

type MemScalarBase<T extends TypeName, G> = {
  get(): Val<T, G>;
  set(v: Val<T, G> | number): void;
  type: T;
  mut: MutOps<T, G>;
  atomics: [T] extends [ScalarType & IntType] ? ScalarAtomics<T, G> : undefined;
};

// Combined type: Base & (ByteMethods if Size is 1)
// We accept Size here (defaulting to number)
type MemScalar<T extends TypeName, G = unknown, Size extends number = number> = MemScalarBase<
  T,
  G
> &
  (Size extends 1 ? ByteRW : {});

// Calculate the return type of an array index (Peel one dimension)
type ArrayDest<E extends ArraySpec> = E['sizes'] extends readonly [
  any,
  ...infer Rest extends readonly number[],
]
  ? Rest extends readonly []
    ? ResolveMem<E['type']> // No dims left -> Resolve Element
    : ResolveMem<ArraySpec<E['type'], Rest>> // Dims left -> Return smaller MemArray
  : never;

type MultiDimArray<T, Sizes extends readonly number[]> = Sizes extends readonly [
  any,
  ...infer Rest extends readonly number[],
]
  ? MultiDimArray<T[], Rest>
  : T;

type ByteRW = {
  read<T extends TypeName>(type: T, size?: 8 | 16 | 32): Val<T>;
  write<T extends TypeName>(type: T, value: Val<T> | number, size?: 8 | 16 | 32): void;
};

type ByteView = {
  copyFrom(region: any, len?: Addr): void;
  fill(value: Addr, len?: Addr): void;
  zero(len?: Addr): void;
} & ByteRW;

type MemArray<E extends ArraySpec> = {
  [n: number]: ArrayDest<E>;
  [s: symbol]: ArrayDest<E>;
  length: number;
  // Utils
  lanes(lanes: number): MemArray<E>;
  reshape<const S extends readonly Addr[]>(
    ...sizes: S
  ): ResolveMem<ArraySpec<E['type'], { [K in keyof S]: S[K] extends number ? S[K] : number }>>;
  flat(): ResolveMem<ArraySpec<E['type'], [number]>>;
  range(pos?: number | Addr, len?: Addr): MemArray<E>;
  as<T extends TypeName>(type: T): MemArray<ArraySpec<ScalarSpec<T, unknown>, E['sizes']>>;
  as8<T extends IntType = 'u32'>(
    type?: T
  ): ResolveMem<ArraySpec<ScalarSpec<T, unknown, 1>, [number]>>;
  as16<T extends IntType = 'u32'>(type?: T): ResolveMem<ArraySpec<ScalarSpec<T>, [number]>>;
  as32<T extends IntType = 'u32'>(type?: T): ResolveMem<ArraySpec<ScalarSpec<T>, [number]>>;
  get(): ResolvedVal<E>;
  set(v: ResolvedVal<E>): void;
} & (IsByte<E['type']> extends true ? ByteView : {});

type MemStruct<F extends Record<string, AnySpecReal>> = {
  // Recursive field access
  [K in keyof F]: ResolveMem<F[K]>;
} & {
  get(): { [K in keyof F]: ResolvedVal<F[K]> };
  set(v: { [K in keyof F]: ResolvedVal<F[K]> }): void;
  as8<T extends IntType = 'u32'>(
    type?: T
  ): ResolveMem<ArraySpec<ScalarSpec<T, unknown, 1>, [number]>>;
};

type ResolveMem<S extends AnySpec> =
  S extends ScalarSpec<infer T, infer G, infer Size>
    ? MemScalar<T, G, Size>
    : S extends ArraySpec
      ? MemArray<S>
      : S extends StructSpec<infer F>
        ? MemStruct<F>
        : never;

/** Runtime memory access surface generated from a memory segment registry. */
export type MemorySurface<M extends Segs> = {
  [K in keyof M]: ResolveMem<Normalized<M[K]>>;
};

/** Function signature metadata stored in a module function registry. */
export type FnDef<In extends readonly TypeName[], Ret> = {
  /** Input type names in call order. */
  inputs: In;
  /** Callback return value type tracked by TypeScript. */
  ret: Ret;
};
/** Named function definition registry. */
export type FnRegistry = Record<string, FnDef<readonly TypeName[], unknown>>;

type TupleVals<A extends readonly TypeName[]> = {
  [K in keyof A]: A[K] extends TypeName ? Val<A[K]> : never;
};

type C = Val<'u32'>; // condition type
type N = number | Val<'u32'>; // loop count / index

/** Control-flow helper surface available inside module function callbacks. */
export type ControlFlow = {
  /**
   * Emits an anonymous block around a stateful body.
   *
   * @param state - Values carried through the block.
   * @param body - Callback that emits block body instructions.
   * @returns Updated state values.
   */
  block<S extends readonly unknown[]>(
    state: [...S],
    body: (...s: [...S]) => S['length'] extends 0 ? [...S] | void : [...S] | S[number][]
  ): [...S];
  /**
   * Emits a named block around a stateful body.
   *
   * @param label - Branch label for nested control helpers.
   * @param state - Values carried through the block.
   * @param body - Callback that emits block body instructions.
   * @returns Updated state values.
   */
  namedBlock<S extends readonly unknown[]>(
    label: string,
    state: [...S],
    body: (...s: [...S]) => S['length'] extends 0 ? [...S] | void : [...S] | S[number][]
  ): [...S];
  /**
   * Emits a conditional branch.
   *
   * @param depth - Numeric branch depth or named label.
   * @param cond - Branch condition.
   * @param outputs - Values returned to the destination block.
   */
  brIf<S extends readonly unknown[]>(depth: string | number, cond: Cond, ...outputs: [...S]): void;
  /**
   * Emits an unconditional branch.
   *
   * @param depth - Numeric branch depth or named label.
   * @param outputs - Values returned to the destination block.
   */
  br<S extends readonly unknown[]>(depth: string | number, ...outputs: [...S]): void;
  /**
   * Continues the current or named loop when a condition is true.
   *
   * @param cond - Continue condition.
   * @param label - Optional loop label.
   * @param rest - Loop state values.
   */
  continueIf(cond: Cond, label?: string, ...rest: unknown[]): void;
  /**
   * Breaks the current or named block when a condition is true.
   *
   * @param cond - Break condition.
   * @param label - Optional block label.
   * @param rest - Block output values.
   */
  breakIf(cond: Cond, label?: string, ...rest: unknown[]): void;
  /**
   * Emits a do-while loop.
   *
   * @param state - Values carried through loop iterations.
   * @param cond - Loop continuation condition.
   * @param body - Callback that emits one loop body.
   * @param label - Optional loop label.
   * @returns Updated state values.
   */
  doWhile<S extends readonly unknown[]>(
    state: [...S],
    cond: (...s: [...S]) => Cond,
    body: (...s: [...S]) => S['length'] extends 0 ? [...S] | void : [...S] | S[number][],
    label?: string
  ): [...S];
  doWhile<S extends readonly unknown[]>(
    state: [...S],
    cond: () => Cond,
    body: (...s: [...S]) => S['length'] extends 0 ? [...S] | void : [...S] | S[number][],
    label?: string
  ): [...S];
  /**
   * Emits a for-style loop.
   *
   * @param state - Initial loop state values.
   * @param cond - Loop continuation condition.
   * @param inc - Callback that computes the next loop state.
   * @param body - Callback that emits one loop body.
   * @param label - Optional loop label.
   * @returns Updated state values.
   */
  forLoop<S extends readonly unknown[]>(
    state: [...S],
    cond: (...s: [...S]) => Cond,
    inc: (...s: [...S]) => S['length'] extends 0 ? [...S] | void : [...S] | S[number][],
    body: (...s: [...S]) => S['length'] extends 0 ? [...S] | void : [...S] | S[number][],
    label?: string
  ): [...S];
  forLoop<S extends readonly unknown[]>(
    state: [...S],
    cond: () => Cond,
    inc: (...s: [...S]) => S['length'] extends 0 ? [...S] | void : [...S] | S[number][],
    body: (...s: [...S]) => S['length'] extends 0 ? [...S] | void : [...S] | S[number][],
    label?: string
  ): [...S];
  /**
   * Emits a counted loop whose body receives the current counter.
   *
   * @param state - Initial loop state values.
   * @param cnt - Static or dynamic iteration count.
   * @param body - Callback that emits one loop body.
   * @param label - Optional loop label.
   * @returns Updated state values.
   */
  doN1<S extends readonly unknown[]>(
    state: [...S],
    cnt: N,
    body: (cnt: C, ...s: [...S]) => S['length'] extends 0 ? [...S] | void : [...S] | S[number][],
    label?: string
  ): [...S];
  doN1<T>(state: readonly T[], cnt: N, body: (cnt: C, ...s: T[]) => T[], label?: string): T[];
  /**
   * Emits a counted loop with the same counter contract as `doN1`.
   *
   * @param state - Initial loop state values.
   * @param cnt - Static or dynamic iteration count.
   * @param body - Callback that emits one loop body.
   * @param label - Optional loop label.
   * @returns Updated state values.
   */
  doN<S extends readonly unknown[]>(
    state: [...S],
    cnt: N,
    body: (cnt: C, ...s: [...S]) => S['length'] extends 0 ? [...S] | void : [...S] | S[number][],
    label?: string
  ): [...S];
  doN<T>(state: readonly T[], cnt: N, body: (cnt: C, ...s: T[]) => T[], label?: string): T[];
  /**
   * Emits an if/else block with state threading.
   *
   * @param cond - Branch condition.
   * @param state - Values carried through both branches.
   * @param ifBody - Callback for the true branch.
   * @param elseBody - Optional callback for the false branch.
   * @returns Updated state values.
   */
  ifElse<S extends readonly unknown[]>(
    cond: C,
    state: [...S],
    ifBody: (...s: [...S]) => S['length'] extends 0 ? [...S] | void : [...S] | S[number][],
    elseBody?: (...s: [...S]) => S['length'] extends 0 ? [...S] | void : [...S] | S[number][]
  ): [...S];
};

/** Operation helpers indexed by every supported type name. */
export type ScopeTypes = {
  [N in TypeName]: GetOps<N>;
};

/** Feature flags active while emitting one function. */
export type Flags = {
  /** Native SIMD operations may be emitted. */
  nativeSIMD?: boolean;
  /** Native 64-bit operations may be emitted instead of lowered 32-bit pairs. */
  native64bit?: boolean;
  /** Threaded code generation is active. */
  threads?: boolean;
};

/** Function callback scope used to build typed compiler IR. */
export type Scope<M extends Segs = {}, F = {}> = {
  /** Active compiler feature flags. */
  flags: Flags;
  /** Typed operation helpers by type name. */
  types: ScopeTypes;
  /**
   * Gets operation helpers for a generic scalar family.
   *
   * @param t - Concrete generic type.
   * @param lanes - Optional SIMD lane count.
   * @returns Operation helpers for the requested generic family.
   */
  getTypeGeneric<Fam extends TypeName, G extends Fam>(t: G, lanes?: number): GetOps<Fam, G>;
  /**
   * Gets operation helpers for a type.
   *
   * @param t - Concrete type name.
   * @param lanes - Optional SIMD lane count.
   * @returns Operation helpers for the requested type.
   */
  getType<T extends TypeName>(t: T, lanes?: number): GetOps<T, unknown>;
  /**
   * Emits debug print values in supported targets.
   *
   * @param args - Strings or nested compiler values to print.
   */
  print(...args: (string | ND<Val<any, any>>)[]): void;
  /** Callable function registry visible from this callback. */
  functions: {
    [K in keyof F]: F[K] extends { inputs: infer In extends readonly TypeName[]; ret: infer Ret }
      ? {
          call: (...args: TupleVals<In>) => Ret;
          callIf: (cond: Cond, ...args: TupleVals<In>) => Ret;
        }
      : never;
  };
  /** Typed memory access surface visible from this callback. */
  memory: MemorySurface<M>;
} & ControlFlow;

type BatchOpts = { lanes: number; perThread?: number };

/** Public function return type specifier. */
export type RetType = TypeName | readonly TypeName[] | 'void';
const checkName = (name: string) => {
  if (typeof name !== 'string')
    throw new TypeError(`"name" expected string, got type=${typeof name}`);
};
const checkFnName = (name: string) => {
  checkName(name);
  // Wrappers always expose memory and segments, so functions cannot safely use those public names.
  if (name === 'memory' || name === 'segments') throw new Error('reserved function name: ' + name);
};
/**
 * A builder that accumulates memory and function definitions.
 * Pass it to toWasm() or toJs() to generate executable code.
 *
 * @param name - Module name used in generated wrappers and imports.
 * @example
 * ```js
 * const mod = new Module('demo')
 *   .fn('zero', [], 'u32', (f) => f.types.u32.const(0));
 * mod.clone();
 * ```
 */
export class Module<M extends Segs = {}, F extends FnRegistry = {}> {
  readonly name: string;
  readonly memory: M;
  readonly functions: F;
  constructor(name: string) {
    if (typeof name !== 'string')
      throw new TypeError(`"name" expected string, got type=${typeof name}`);
    this.name = name;
    this.memory = {} as any;
    this.functions = {} as any;
  }
  use<NM extends Segs, NF extends FnRegistry>(
    f: (m: Module<M, F>) => Module<NM, NF>
  ): Module<NM, NF> {
    if (typeof f !== 'function')
      throw new TypeError(`"f" expected function, got type=${typeof f}`);
    return f(this);
  }
  mem<Name extends string, Spec extends ArraySpec | StructSpec>(
    name: Name,
    spec: Spec
  ): Module<M & { [K in Name]: Spec }, F> {
    checkName(name);
    if ((this as any).memory[name]) throw new Error('array already exists:' + name);
    (this as any).memory[name] = spec as any;
    return this as any;
  }
  batchMem<Name extends string, Spec extends ArraySpec | StructSpec>(
    name: Name,
    spec: Spec
  ): Module<M & { [K in Name]: CollapseArray<Spec, [number]> & { batch: true } }, F> {
    checkName(name);
    if ((this as any).memory[name]) throw new Error('array already exists:' + name);
    (this as any).memory[name] = { ...spec, opts: { ...spec.opts, batch: true } } as any;
    return this as any;
  }
  /*
  We can import js function:
  - if cb is empty: we just require it to be passed via env
  - if cb is non-empty we do fn.toString(). This is very fragile, but significantly
    better that writing function inside of a string.
    NOTE: function will be executed in scope of module
  */
  importFn<
    Name extends string,
    In extends readonly TypeName[],
    Out extends RetType,
    CB extends (...args: TupleVals<In>) => any,
  >(
    name: Name,
    inputs: In,
    outputs: Out,
    cb?: CB,
    module?: string
  ): Module<M, F & { [P in Name]: FnDef<In, ReturnType<CB>> & { out: Out } }> {
    checkFnName(name);
    aarray(inputs, 'inputs');
    if (module !== undefined && typeof module !== 'string')
      throw new TypeError(`"module" expected string, got type=${typeof module}`);
    if (this.functions[name]) throw new Error('function already exists:' + name);
    this.functions[name] = { inputs, outputs, cb, module, import: true } as any;
    return this as any;
  }
  fn<
    Name extends string,
    In extends readonly TypeName[],
    Out extends RetType,
    CB extends (s: Scope<M, F & { [P in Name]: FnDef<In, any> }>, ...args: TupleVals<In>) => any,
  >(
    name: Name,
    inputs: In,
    outputs: Out,
    cb: CB
  ): Module<M, F & { [P in Name]: FnDef<In, ReturnType<CB>> }> {
    checkFnName(name);
    aarray(inputs, 'inputs');
    if (typeof cb !== 'function')
      throw new TypeError(`"cb" expected function, got type=${typeof cb}`);
    if (this.functions[name]) throw new Error('function already exists:' + name);
    this.functions[name] = { inputs, outputs, cb } as any;
    return this as any;
  }
  /*
  Batched function:
  - callback looks like (s, lanes (1 or N if simd), pos, perBatchSize, ...some args)
  - can be called as (batchPos, batchLen, perBatchSize)
  - 'perBatchSize' is how much each batch thing will do, mainly for per thread allocation.
    We pass it as is into callback but use for per thread work allocation.
  */
  batchFn<
    Name extends string,
    Opts extends BatchOpts,
    In extends readonly TypeName[],
    CB extends (
      s: Scope<M, F & { [P in Name]: FnDef<In, any> }>,
      lanes: number,
      pos: AddrDyn,
      ...args: TupleVals<In>
    ) => any,
  >(
    name: Name,
    opts: Opts,
    inputs: In,
    cb: CB
  ): Module<M, F & { [P in Name]: FnDef<In, ReturnType<CB>> }> {
    checkFnName(name);
    aarray(inputs, 'inputs');
    if (typeof cb !== 'function')
      throw new TypeError(`"cb" expected function, got type=${typeof cb}`);
    if (this.functions[name]) throw new Error('function already exists:' + name);
    if (!Number.isSafeInteger(opts.lanes) || opts.lanes < 1)
      throw new Error(`batch function opts: wrong lanes: ${opts.lanes}`);
    this.functions[name] = { inputs, outputs: 'void', cb, opts, batch: true } as any;
    return this as any;
  }
  clone(): Module<M, F> {
    const res = new Module(this.name);
    (res as any).functions = { ...this.functions };
    (res as any).memory = { ...this.memory };
    return res as Module<M, F>;
  }
}
