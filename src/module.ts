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
import type { ND } from './utils.ts';

export type ShiftMask = Val<'u32'>;
type AddrDyn = Val<'u32'>;
export type Addr = number | Val<'u32'>;
export type Shift = number | Val<'i32'>;
export type Cond = Val<'i32'> | Val<'u32'>;

// Phantom type
// Brand
declare const brandSym: unique symbol;

// S invariant; G phantom. When G=never, drop the field entirely.
export type Val<S extends TypeName, G = unknown> = symbol & {
  readonly [brandSym]: (x: S) => S;
} & ([G] extends [never] ? {} : { readonly __g?: G });

// OPS
type Expand<T> = T extends infer O ? { [K in keyof O]: O[K] } : never;

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

// /*
// type T1Ops = "swapEndianness" | "add" | "mul" | "sub" | "div" | "rem" | "min" | "max" | "eq" | "ne" | "lt" | "gt" | "le" | "ge" | "eqz" | "and" | "or" | "xor" | "andnot" | "not" | "clz" | "ctz" | "popcnt" | "shr" | "shl" | "rotr" | "rotl" | "name" | "size" | "const" | "laneOffsets" | "select" | "to" | "from" | "toN" | "fromN"
// */
//type T2Ops = StrUnion<keyof GetOps<'f64x4'>>;
// /*
// type T2Ops = "sub" | "name" | "select" | "const" | "eqz" | "eq" | "ne" | "lt" | "gt" | "le" | "ge" | "abs" | "neg" | "ceil" | "floor" | "trunc" | "nearest" | "sqrt" | "add" | "mul" | "div" | "min" | "max" | "copysign" | "shuffle" | "splat" | "size" | "swapEndianness" | "rem" | "isNaN" | "laneOffsets" | "to" | "from" | "toN" | "fromN" | "extractLane" | "replaceLane" | "shuffleLanes" | "rol" | "ror" | "interleave" | "deinterleave"
// */

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

export interface ScalarSpec<T extends TypeName, Generic = unknown, Size extends number = number> {
  kind: 'scalar';
  type: T;
  generic: Generic; // optional bound generic
  opts: Readonly<MemoryOpts>;
  size?: Size;
}
export function scalar<T extends TypeName | GenericMemType<any, any>>(
  type: T,
  opts: MemoryOpts = {}
): ScalarSpec<MemGenericType<T>, T extends GenericMemType<any, infer G> ? G : unknown> {
  return { kind: 'scalar', type, opts } as any;
}

export interface StructSpec<F extends Record<string, AnySpecReal> = Record<string, AnySpecReal>> {
  kind: 'struct';
  fields: { [K in keyof F]: F[K] };
  opts: Readonly<MemoryOpts>;
}
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

export interface ArraySpec<
  T extends AnySpecReal = AnySpecReal,
  S extends readonly number[] = readonly number[],
> {
  kind: 'array';
  type: T;
  readonly sizes: S;
  opts: Readonly<MemoryOpts>;
}
export function array<T extends AnySpec, const S extends readonly number[]>(
  type: T,
  opts: MemoryOpts,
  ...sizes: S
): CollapseArray<T, S> {
  if (sizes.length === 0 || (sizes.length === 1 && sizes[0] === 0)) throw new Error('array: empty');
  let t = type as any;
  if (typeof t === 'string') t = scalar(t as any);
  if (t.kind === 'array')
    return (array as any)(t.type, { ...opts, ...t.opts }, ...sizes, ...t.sizes);
  return { kind: 'array', type: t, sizes, opts } as any;
}

export type MemoryOptsWidth = MemoryOpts & {
  width: 8 | 16 | 32 | 64;
};

export type SegMeta = AnySpecReal;

export type Segs = Record<string, SegMeta>;
type GenericMemType<T extends TypeName, G extends T> = { type: T; generic: G };
// identity at runtime, carries phantom types only
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

export type ScalarAtomics<T extends TypeName, G> = {
  load(): Val<T, G>;
  store(v: Val<T, G> | number): void;
  exchange(v: Val<T, G> | number): Val<T, G>;
  compareExchange(expected: Val<T, G> | number, replacement: Val<T, G> | number): Val<T, G>;
  // Synchronization (Implied address = this scalar)
  notify(count?: Val<'u32'> | number): Val<'u32'>; // Returns count of woken waiters
  wait(expected: Val<T, G> | number, timeout: Val<'i64'> | number): Val<'u32'>; // Returns 0 (ok), 1 (timeout), 2 (not equal)
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

export type MemorySurface<M extends Segs> = {
  [K in keyof M]: ResolveMem<Normalized<M[K]>>;
};

export type FnDef<In extends readonly TypeName[], Ret> = { inputs: In; ret: Ret };
export type FnRegistry = Record<string, FnDef<readonly TypeName[], unknown>>;

type TupleVals<A extends readonly TypeName[]> = {
  [K in keyof A]: A[K] extends TypeName ? Val<A[K]> : never;
};

type C = Val<'u32'>; // condition type
type N = number | Val<'u32'>; // loop count / index

export type ControlFlow = {
  block<S extends readonly unknown[]>(
    state: [...S],
    body: (...s: [...S]) => S['length'] extends 0 ? [...S] | void : [...S] | S[number][]
  ): [...S];
  namedBlock<S extends readonly unknown[]>(
    label: string,
    state: [...S],
    body: (...s: [...S]) => S['length'] extends 0 ? [...S] | void : [...S] | S[number][]
  ): [...S];
  brIf<S extends readonly unknown[]>(depth: string | number, cond: Cond, ...outputs: [...S]): void;
  br<S extends readonly unknown[]>(depth: string | number, ...outputs: [...S]): void;
  continueIf(cond: Cond, label?: string, ...rest: unknown[]): void;
  breakIf(cond: Cond, label?: string, ...rest: unknown[]): void;
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
  doN1<S extends readonly unknown[]>(
    state: [...S],
    cnt: N,
    body: (cnt: C, ...s: [...S]) => S['length'] extends 0 ? [...S] | void : [...S] | S[number][],
    label?: string
  ): [...S];
  doN1<T>(state: readonly T[], cnt: N, body: (cnt: C, ...s: T[]) => T[], label?: string): T[];
  doN<S extends readonly unknown[]>(
    state: [...S],
    cnt: N,
    body: (cnt: C, ...s: [...S]) => S['length'] extends 0 ? [...S] | void : [...S] | S[number][],
    label?: string
  ): [...S];
  doN<T>(state: readonly T[], cnt: N, body: (cnt: C, ...s: T[]) => T[], label?: string): T[];
  ifElse<S extends readonly unknown[]>(
    cond: C,
    state: [...S],
    ifBody: (...s: [...S]) => S['length'] extends 0 ? [...S] | void : [...S] | S[number][],
    elseBody?: (...s: [...S]) => S['length'] extends 0 ? [...S] | void : [...S] | S[number][]
  ): [...S];
};

export type ScopeTypes = {
  [N in TypeName]: GetOps<N>;
};

export type Flags = { nativeSIMD?: boolean; native64bit?: boolean; threads?: boolean };

export type Scope<M extends Segs = {}, F = {}> = {
  flags: Flags;
  types: ScopeTypes;
  getTypeGeneric<Fam extends TypeName, G extends Fam>(t: G, lanes?: number): GetOps<Fam, G>;
  getType<T extends TypeName>(t: T, lanes?: number): GetOps<T, unknown>;
  print(...args: (string | ND<Val<any, any>>)[]): void;
  functions: {
    [K in keyof F]: F[K] extends { inputs: infer In extends readonly TypeName[]; ret: infer Ret }
      ? {
          call: (...args: TupleVals<In>) => Ret;
          callIf: (cond: Cond, ...args: TupleVals<In>) => Ret;
        }
      : never;
  };
  memory: MemorySurface<M>;
} & ControlFlow;

type BatchOpts = { lanes: number; perThread?: number };

export type RetType = TypeName | readonly TypeName[] | 'void';
/**
 * A builder that accumulates memory and function definitions. Pass it to toWasm() or toJs() to generate executable code.
 */
export class Module<M extends Segs = {}, F extends FnRegistry = {}> {
  readonly name: string;
  readonly memory: M;
  readonly functions: F;
  constructor(name: string) {
    this.name = name;
    this.memory = {} as any;
    this.functions = {} as any;
  }
  use<NM extends Segs, NF extends FnRegistry>(
    f: (m: Module<M, F>) => Module<NM, NF>
  ): Module<NM, NF> {
    return f(this);
  }
  mem<Name extends string, Spec extends ArraySpec | StructSpec>(
    name: Name,
    spec: Spec
  ): Module<M & { [K in Name]: Spec }, F> {
    if ((this as any).memory[name]) throw new Error('array already exists:' + name);
    (this as any).memory[name] = spec as any;
    return this as any;
  }
  batchMem<Name extends string, Spec extends ArraySpec | StructSpec>(
    name: Name,
    spec: Spec
  ): Module<M & { [K in Name]: CollapseArray<Spec, [number]> & { batch: true } }, F> {
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
    if (this.functions[name]) throw new Error('function already exists:' + name);
    this.functions[name] = { inputs, outputs, cb } as any;
    return this as any;
  }
  /*
  Batched function:
  - callback looks like (s, lanes (1 or N if simd), pos, perBatchSize, ...some args)
  - can be called as (batchPos, batchLen, perBatchSize)
  - 'perBatchSize' is how much each batch thing will do, mainly for per thread allocation. We pass it as is into
    callback but use for per thread work allocation.
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
    if (this.functions[name]) throw new Error('function already exists:' + name);
    if (!Number.isSafeInteger(opts.lanes))
      throw new Error(`batch function opts: wrong lanes: ${opts.lanes}`);
    this.functions[name] = { inputs, outputs: 'void', cb, opts, batch: true } as any;
    return this as any;
  }
  clone() {
    const res = new Module(this.name);
    (res as any).functions = { ...this.functions };
    (res as any).memory = { ...this.memory };
    return res;
  }
}
