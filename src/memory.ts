import { type ModuleGraph, FnOp } from './codegen.ts';
import type { ArraySpec, ScalarSpec, StructSpec } from './module.ts';
import {
  type TypeName,
  BigIntType,
  IntType,
  SIMDType,
  ScalarType,
  UnsignedType,
  lanesOf,
  minSimdType,
  opsAtomics,
  opsForType,
  sizeof,
} from './types.ts';
import { lcm, omit, align as utilsAlign, last as utilsLast, wasmAlign } from './utils.ts';

/**
 * Per memory region options
 */
export type MemoryOpts = {
  swapEndianness?: boolean;
  noInterleave?: boolean;
  align?: number; // starting pos % align = 0
  alignEnd?: number; // end % pad = 0
  batch?: boolean;
};

/**
 * Memory region representation
 */
export type MemOpts = {
  pos: number;
  size: number;
  paddedSize: number; // full size of region with alignment block
  align?: number; // power of two (as in wasm)
  count?: number; // for arrays
  lanes?: number; // for vectorized arrays
  type?: TypeName; // for arrays
  pre?: any;
  subRegions?: Record<string, [number, number, number, number]>;
};

const getArrayCount = (spec: ArraySpec) => ({ count: prod(spec.sizes) });

function getAlignOpts(spec: ArraySpec | StructSpec | ScalarSpec<any>) {
  let align = spec.opts.align;
  if (align === undefined) {
    if (spec.kind === 'scalar') {
      align = spec.size ? spec.size : sizeof(spec.type); // align scalars to size
    } else if (spec.kind === 'array') align = 16; // arrays always aligned to 16 by default (simd related loading)
  }
  let alignEnd = spec.opts.alignEnd;
  if (alignEnd === undefined) {
    if (spec.kind === 'array') alignEnd = 16; // at the end too, we don't want vector op for leftovers touch anything outside
  }
  align = align === undefined ? 1 : align;
  alignEnd = alignEnd === undefined ? 1 : alignEnd;
  const opts: MemoryOpts = omit(spec.opts, 'align', 'alignEnd');
  return { align, alignEnd, opts };
}

type Aligned = {
  spec: ArraySpec | StructSpec | ScalarSpec<any>;
  size: number;
  paddedSize: number;
  count?: number;
  align: number;
  alignEnd: number;
  opts: MemoryOpts;
  inner?: Aligned;
  fields?: Record<string, Aligned>;
};

function checkRegion<T extends Aligned | RegionExpr>(region: T): T {
  const checkAddr = (a: MulExpr) => {
    if (typeof a === 'number') {
      if (!Number.isSafeInteger(a)) throw new Error(`checkRegion: wrong addr/pos: ${a}`);
    }
  };
  for (const i of ['size', 'paddedSize'] as const) checkAddr(region[i]);
  for (const i of ['count'] as const) if (region[i]) checkAddr(region[i]);
  if (!region.spec) throw new Error('checkRgion: no spec');
  if (region.spec.kind === 'array') {
    for (const i of ['count', 'inner'] as const) {
      if (region[i] === undefined) throw new Error(`checkRegion: array missing field=${i}`);
    }
  }
  if (region.spec.kind === 'struct') {
    for (const i of ['fields'] as const) {
      if (region[i] === undefined) throw new Error(`checkRegion: struct missing field=${i}`);
    }
  }
  return region;
}

function getSize(spec: ArraySpec | StructSpec | ScalarSpec<any>, noPad = false): Aligned {
  // Rules:
  // - align of structure is lcm of all fields alignments + own align
  // - alignEnd affects only padded size of element itself
  const addPaddedSize = (item: Omit<Aligned, 'paddedSize'>): Aligned => ({
    ...item,
    paddedSize: noPad ? item.size : utilsAlign(item.size, alignEnd),
  });
  let { align, alignEnd, opts } = getAlignOpts(spec);
  if (spec.kind === 'scalar') {
    const size = spec.size !== undefined ? spec.size : sizeof(spec.type);
    return addPaddedSize({ spec, size, align, alignEnd, opts });
  } else if (spec.kind === 'array') {
    let inner = getSize(spec.type);
    if (isSymbolicArr(spec)) return checkRegion(getSymbolicArray(spec, inner));
    const { count } = getArrayCount(spec);
    align = lcm(align, inner.align);
    inner = { ...inner, paddedSize: utilsAlign(inner.paddedSize, inner.align) }; // make sure next element is aligned
    const size = inner.paddedSize * count;
    return checkRegion(
      addPaddedSize({
        spec,
        inner,
        size,
        count,
        align,
        alignEnd,
        opts,
      })
    );
  } else if (spec.kind === 'struct') {
    let size = 0;
    const keys = Object.keys(spec.fields);
    const fields: Record<string, Aligned> = {};
    // collect && apply align
    for (const k of keys) {
      const cur = getSize(spec.fields[k]);
      align = lcm(align, cur.align);
      fields[k] = cur;
    }
    for (let i = 0; i < keys.length; i++) {
      const k = keys[i];
      const cur = fields[k];
      if (i !== 0) {
        const prev = fields[keys[i - 1]];
        const padPrev = utilsAlign(size, cur.align) - size;
        prev.paddedSize += padPrev;
        size += padPrev;
      }
      size += cur.paddedSize;
    }
    return checkRegion(addPaddedSize({ spec, fields, size, align, alignEnd, opts }));
  } else throw new Error('getSize: unknown node type');
}

type RegionExpr = Aligned & {
  pos: number | PosExpr;
  chunks?: number;
  subRegions?: Record<string, [number, number, number, number]>;
};
/**
 * Generates size/position of memory element inside global buffer based on alignment/padding
 */
export function allocateMemSpec(
  pos: number,
  t: StructSpec | ArraySpec
): { pos: number; opts: MemOpts; pre: RegionExpr } {
  const item = getSize(t) as RegionExpr;
  const subRegions: Record<string, [number, number, number, number]> = {};
  // Walk over substructures and scalar, save
  const walk = (
    startPos: number,
    item: RegionExpr,
    path?: string,
    chunk?: { count: number; size: number }
  ) => {
    const key = path || '';
    subRegions[key] = [0, 0, 0, 0]; // sort parent first
    if (path === undefined) startPos = utilsAlign(startPos, item.align); // root align
    if (startPos % item.align !== 0) throw new Error('unaligned cursor');
    item.pos = startPos;
    if (item.spec.kind === 'struct') {
      let curPos = startPos;
      for (const k in item.fields)
        curPos = walk(curPos, (item.fields as any)[k], path ? `${path}.${k}` : k, chunk);
    }
    if (chunk) {
    } else if (item.spec.kind === 'array' && (item.spec.type.opts.batch || item.spec.opts.batch)) {
      // We walk max at depth 1, but don't advance
      if (item.spec.type.kind === 'struct' && chunk === undefined) {
        walk(startPos, item.inner! as any, path, {
          count: item.count!,
          size: item.inner!.paddedSize,
        });
      }
      chunk = {
        count: item.spec.sizes[0],
        size: item.inner!.paddedSize * prod(item.spec.sizes!.slice(1)),
      };
    } else {
      chunk = { count: 1, size: item.size };
    }
    subRegions[key] = [item.pos, item.size, chunk.count, chunk.size];
    return startPos + item.paddedSize;
  };
  pos = walk(pos, item);
  item.subRegions = subRegions;
  return { pos, opts: item as any, pre: item };
}

function isSymbolicArr(spec: ArraySpec) {
  if (spec.kind !== 'array') throw new Error('isSymbolicArr: not array');
  return !spec.sizes.every((i) => typeof i === 'number');
}

function getSymbolicArray(spec: ArraySpec, inner: Aligned): Aligned {
  if (!isSymbolicArr(spec)) throw new Error('getSymbolicArrCount: non-symbolic');
  const count = PosExpr.mul(...spec.sizes);
  const size = PosExpr.mul(inner.paddedSize, count);
  return {
    spec,
    inner,
    size,
    paddedSize: size,
    count,
  } as any;
}

export function getRegionInfo(
  opts: RegionExpr,
  key: string | number | FnOp,
  skipChecks = false
): RegionExpr {
  const spec = opts.spec;
  if (spec.kind === 'array') {
    if (typeof key !== 'number' && typeof key !== 'object')
      throw new Error(`getRegionInfo: wrong key for array=${key}`);
    if (!skipChecks && typeof key === 'number' && (key < 0 || key >= spec.sizes[0]))
      throw new Error(`getRegionInfo: key out of bounds=${key} [0..${spec.sizes[0]})`);
    const dimSize = PosExpr.mul(
      opts.inner!.paddedSize,
      PosExpr.mul((opts.spec as ArraySpec).sizes.slice(1))
    );
    const pos = PosExpr.add(opts.pos, PosExpr.term(key, dimSize));
    if (spec.sizes.length > 1) {
      // still same array
      const newSpec = { ...spec, sizes: spec.sizes.slice(1) };
      if (isSymbolicArr(newSpec)) {
        return checkRegion({
          ...getSymbolicArray(newSpec, opts.inner!),
          pos,
          opts: { ...opts.opts },
        });
      }
      if (typeof dimSize !== 'number')
        throw new Error('getRegionInfo: symbolic size on non-symbolic path');
      return checkRegion({ ...getSize(newSpec, false), pos, opts: { ...opts.opts } });
    } else {
      const res = {
        ...opts.inner,
        pos,
        opts: { ...opts.opts, ...opts.inner!.opts }, // propagate opts
      };
      return res as any;
    }
  } else if (spec.kind === 'struct') {
    if (typeof key !== 'string') throw new Error(`getRegionInfo: struct key is not string=${key}`);
    const item = opts.fields![key];
    if (!item) throw new Error(`getRegionInfo: struct unknown key: ${key}`);
    let pos = opts.pos;
    for (const k in opts.fields) {
      if (k === key) break;
      pos = PosExpr.add(pos, opts.fields[k].paddedSize);
    }
    return { ...item, pos, opts: { ...opts.opts, ...item.opts } };
  } else throw new Error(`getRegionInfo: wrong region ${spec.kind} key=${key}`);
}

export function getRegionInfoPath(cur: RegionExpr, ...keys: (string | number | FnOp)[]) {
  for (const k of keys) cur = getRegionInfo(cur, k) as any;
  return cur;
}

const prod = (xs: readonly number[]) => {
  //if (!xs.length) throw new Error('empty length');
  let p = 1;
  for (let i = 0; i < xs.length; i++) p *= xs[i];
  return p;
};

type MulExpr = number | (number | FnOp)[]; // flat product of integers and size symbols
type PosExpr = { base: number; baseMul: MulExpr[]; syms: FnOp[]; coeffs: MulExpr[] };
export const PosExpr = {
  // PosExpr
  isNum: (p: number | PosExpr): p is number => typeof p === 'number',
  isExpr: (p: number | PosExpr): p is PosExpr => !PosExpr.isNum(p),
  canon: (e: PosExpr): number | PosExpr => {
    return e.syms.length === 0 && e.coeffs.length === 0 && e.baseMul.length === 0 ? e.base : e;
  },
  toExpr: (p: number | PosExpr): PosExpr =>
    typeof p === 'number' ? { base: p, baseMul: [], syms: [], coeffs: [] } : p,
  term(sym: number | FnOp, coeff: number | MulExpr): number | PosExpr {
    let c = PosExpr.mul(coeff);
    if (c === 0) return 0;
    if (typeof sym === 'number') {
      if (typeof c === 'number') return c * sym;
      c = PosExpr.mul(c, sym);
      if (c === 0) return 0;
      return { base: 0, baseMul: [c], syms: [], coeffs: [] };
    }
    return { base: 0, baseMul: [], syms: [sym], coeffs: [c] };
  },
  // the single arithmetic op
  add(a: number | PosExpr, b: number | PosExpr): number | PosExpr {
    if (typeof a === 'number' && typeof b === 'number') return a + b;
    const ea = PosExpr.toExpr(a);
    const eb = PosExpr.toExpr(b);
    const e: PosExpr = {
      base: ea.base + eb.base,
      baseMul: ea.baseMul.concat(eb.baseMul),
      syms: ea.syms.concat(eb.syms),
      coeffs: ea.coeffs.concat(eb.coeffs),
    };
    return PosExpr.canon(e);
  },
  madd(a: number | PosExpr, b: number | PosExpr, k: number): number | PosExpr {
    if (k === 0) return a;
    if (k === 1) return PosExpr.add(a, b);
    if (typeof a === 'number' && typeof b === 'number') return a + k * b;
    const eb = PosExpr.toExpr(b);
    const scaled: PosExpr = {
      base: eb.base * k,
      baseMul: eb.baseMul.map((m) => PosExpr.mul(k, m)),
      syms: eb.syms.slice(),
      coeffs: eb.coeffs.map((m) => PosExpr.mul(k, m)),
    };
    return PosExpr.add(a, scaled);
  },
  eval(e: PosExpr, values: number[]) {
    let sum = e.base;
    let n = Math.min(e.syms.length, e.coeffs.length, values.length);
    for (let i = 0; i < n; i++) sum += (e.coeffs[i] as number) * values[i];
    return sum;
  },
  evalSymSize(f: ModuleGraph, pos: MulExpr | number) {
    const { u32 } = f.types;
    const posMul = PosExpr.mul(pos);
    const posArr = (Array.isArray(posMul) ? posMul : [posMul])
      .flat(Infinity)
      .map((i) => (typeof i === 'number' ? u32.const(i) : i));
    if (posArr.length === 1) return posArr[0];
    return u32.mul(...posArr);
  },
  evalSym(f: ModuleGraph, pos: PosExpr | number) {
    const { u32 } = f.types;
    const ctzPow2 = (n: number): number => (n === 0 ? 32 : wasmAlign(n)); // treat 0 as +∞ (i.e., no restriction); 32 is safe sentinel for min()
    const ctzMul = (m: MulExpr) => {
      if (typeof m === 'number') return ctzPow2(m);
      let min = 32;
      for (const fct of m) if (typeof fct === 'number') min = Math.min(min, ctzPow2(fct));
      return min;
    };
    // no symbolic form -> constant
    if (!PosExpr.isExpr(pos)) return { pos, align: ctzPow2(pos) };
    const mul = (...args: (FnOp | number)[]) =>
      u32.mul(...args.flat(Infinity).map((i) => (typeof i === 'number' ? u32.const(i) : i)));
    const e = pos;
    const syms = e.syms.map((s: any) => f.byIdx(s.idx));
    // Build minimal expression
    let C = e.base;
    const terms: any[] = [];
    if (e.coeffs.length !== syms.length) throw new Error('wrong length');
    for (const x of e.baseMul) terms.push(mul(x as any));
    const n = Math.min(e.coeffs.length, syms.length);
    for (let i = 0; i < n; i++) {
      const c = e.coeffs[i];
      if (c === 0) continue;
      const s = syms[i];
      terms.push(c === 1 ? s : mul(s, c as any));
    }
    let expr: any;
    if (terms.length === 0) expr = u32.const(C);
    else if (C !== 0) expr = u32.add(...terms, u32.const(C));
    else if (terms.length === 1) expr = terms[0];
    else expr = u32.add(...terms);
    // Alignment lower bound (power-of-two)
    let minCtz = ctzPow2(C);
    for (const m of e.baseMul) minCtz = Math.min(minCtz, ctzMul(m));
    for (const k of e.coeffs) minCtz = Math.min(minCtz, ctzMul(k));
    return { pos: expr, align: Math.min(31, minCtz) };
  },
  // MulExpr
  mul: (...xs: MulExpr[]): MulExpr => {
    xs = xs.flat(Infinity) as MulExpr[];
    let k = 1;
    const rest: FnOp[] = [];
    for (const x of xs) {
      if (typeof x === 'number') {
        if (x === 0) return 0; // <-- annihilator
        k *= x;
      } else rest.push(x as any as FnOp);
    }
    rest.sort((a, b) => (a.idx < b.idx ? -1 : a.idx > b.idx ? 1 : 0));
    return rest.length ? (k !== 1 ? [k, ...rest] : rest) : k;
  },
} as const;

type View = RegionExpr & {
  idx(path: number | string | FnOp): View;
};

function basicView(f: ModuleGraph, region: RegionExpr, skipChecks = false): View {
  return {
    ...region,
    idx(path) {
      return basicView(f, getRegionInfo(region, path, skipChecks) as any, skipChecks);
    },
  };
}

function byteView(
  f: ModuleGraph,
  region: RegionExpr,
  byteSize: 1 | 2 | 4,
  type: TypeName = 'u32',
  skipChecks = false
): View {
  // NOTE: we allow view to go into padding
  const tail = region.size % byteSize;
  if (tail && tail > region.paddedSize - region.size)
    throw new Error('not enough padding to cast byteView');
  let count;
  let paddedSize;
  if (region.spec.kind === 'array' && isSymbolicArr(region.spec)) {
    if (byteSize !== 1) throw new Error('byteView: symbolic arr with byteSize!=1');
    count = region.size;
    paddedSize = region.paddedSize;
  } else {
    count = Math.ceil(region.size / byteSize);
    paddedSize = Math.floor(region.paddedSize / byteSize) * byteSize;
  }
  const scalarSpec = { kind: 'scalar', type, size: byteSize, opts: {} } as ScalarSpec<any, any>;
  const item = getSize(
    {
      kind: 'array',
      type: scalarSpec,
      sizes: [count],
      opts: {},
    },
    true
  );
  return basicView(
    f,
    checkRegion({
      ...item,
      paddedSize,
      pos: region.pos,
    }),
    skipChecks
  );
}

function rangeView(
  f: ModuleGraph,
  region: View,
  pos?: number | FnOp,
  len?: number | FnOp,
  skipChecks = false
): View {
  if (region.spec.kind !== 'array') throw new Error('range: non-array');
  if (pos === undefined && len === undefined) return region; // nop
  if (pos !== undefined && typeof pos !== 'number' && len === undefined)
    throw new Error('range: symbolic pos without range');
  if (pos === undefined) pos = 0;
  if (len === undefined) {
    len = region.spec.sizes[0];
    if (typeof len !== 'number') throw new Error('symbolic length');
    if (typeof pos === 'number') len -= pos;
  }
  if (typeof pos === 'number' && typeof len === 'number' && pos + len > region.spec.sizes[0]) {
    throw new Error(`rangeView: out-of-bounds: ${pos + len} > ${region.spec.sizes[0]}`);
  }
  const isOverrun = typeof pos === 'number' && pos === region.spec.sizes[0];
  const realPos = isOverrun ? PosExpr.add(region.pos, region.size) : region.idx(pos).pos;
  // we need here: total size, total padded size, count
  const spec: ArraySpec = {
    kind: 'array',
    type: region.spec.type,
    sizes: [len as any, ...region.spec.sizes.slice(1)],
    opts: region.spec.opts,
  };
  const item = getSize(spec, undefined);
  const rangeRegion: RegionExpr = checkRegion({
    pos: realPos,
    ...item,
    paddedSize: item.size,
    opts: region.opts,
  });
  return basicView(f, rangeRegion, skipChecks); // Nothing specific here
}

function castView(f: ModuleGraph, region: RegionExpr, toType: TypeName, skipChecks = false) {
  const typeSize = sizeof(toType);
  const spec = region.spec as any;
  if (spec.kind === 'struct') throw new Error('castView: cast on struct');
  if (spec.kind === 'array' && spec.type.kind !== 'scalar')
    throw new Error('castView: cast on array of struct');
  let newSpec;
  let count;
  let newSizes;
  if (region.spec.kind === 'array') {
    if (spec.type.type === toType) return basicView(f, region, skipChecks);
    const fromType = spec.type.type;
    if (spec.type.size) {
      if (!IntType.has(toType)) throw new Error('castView: non-int on byteView');
      const newScalarSpec = { ...region.spec.type, type: toType };
      const newSpec = { ...region.spec, type: newScalarSpec };
      const res = { ...region, spec: newSpec, inner: { ...region.inner, spec: newScalarSpec } };
      return basicView(f, checkRegion(res as any), skipChecks);
    }
    const fromSize = sizeof(fromType);
    const lastDim: number = utilsLast((region.spec as ArraySpec).sizes as number[]);
    let lastDimScaled;
    if (!(typeSize % fromSize)) {
      // Join elements
      const scale = typeSize / fromSize;
      // need to divide here (less elements)
      if (lastDim % scale)
        throw new Error(`castView: cannot scale array: ${lastDim} is not divisible by ${scale}`);
      lastDimScaled = lastDim / scale;
    } else if (!(fromSize % typeSize)) {
      // Split elements
      const scale = fromSize / typeSize;
      lastDimScaled = lastDim * scale;
    } else throw new Error(`castView: cannot cast ${fromSize} to ${typeSize}`);
    newSizes = [...spec.sizes.slice(0, -1), lastDimScaled];
    newSpec = { ...spec, type: { ...spec.type, type: toType }, sizes: newSizes };
    count = getArrayCount(newSpec).count;
  } else if (region.spec.kind === 'scalar') {
    if (region.spec.type === toType) return basicView(f, region);
    if (spec.size) {
      if (!IntType.has(toType as any)) throw new Error('castView: non-int on byteView');
      return basicView(f, { ...region, spec: { ...region.spec, type: toType } }, skipChecks);
    }
    if (region.size < typeSize) throw new Error('castView/scalar: not enough data');
    const fromType = spec.type;
    const fromSize = sizeof(fromType);
    if (fromSize % typeSize)
      throw new Error(`castView/scalar: cannot cast ${fromSize} -> ${typeSize} bytes`);
    count = fromSize / typeSize;
    newSpec = {
      kind: 'array',
      type: { ...region.spec, kind: 'scalar', type: toType },
      sizes: [count],
      opts: { ...region.spec.opts },
    };
    newSizes = [count];
  } else {
    throw new Error('castView: unexpected case');
  }
  return basicView(
    f,
    checkRegion({
      ...region,
      spec: newSpec as any,
      inner: getSize(newSpec.type as any, undefined),
      count,
    }),
    skipChecks
  );
}

function reshapeView(
  f: ModuleGraph,
  region: RegionExpr,
  skipChecks: boolean,
  ...sizes: (number | FnOp)[]
) {
  const spec = region.spec;
  if (spec.kind !== 'array') throw new Error('reshapeView: not array');
  // Simple case, everything is number
  if (!skipChecks && sizes.every((i) => typeof i === 'number')) {
    const newCount = prod(sizes);
    if (newCount !== region.count)
      throw new Error(
        `reshapeView: wrong total amount of elements: ${newCount}, expected ${region.count}`
      );
  }
  return basicView(f, checkRegion({ ...region, spec: { ...spec, sizes } } as any), skipChecks);
}
type ProxyContext = {
  lanes?: {
    lanes: number;
    offset?: MulExpr;
  };
};
/**
 * Creates main user interface over memory region using memOps function for actual implementation
 */
export function memoryProxy(
  f: ModuleGraph,
  name: string,
  region: RegionExpr,
  memOpsFn: typeof memOps,
  skipChecks = false
) {
  const mk = (view: View, path: (string | number | FnOp)[], ctx: ProxyContext): any => {
    if (!path) throw new Error('empty path');
    const region = omit(view, 'idx', 'align', 'alignEnd', 'inner', 'fields');
    const handle = memOpsFn(f, name, { ...region, ...ctx } as any, path);
    Object.assign(handle, {
      range: (pos?: number | FnOp, len?: number) => {
        return mk(rangeView(f, view, pos, len, skipChecks), path, ctx);
      },
      length: region.spec.kind === 'array' && region.spec.sizes![0],
      reshape: (...sizes: any[]) => {
        if (region.spec.kind !== 'array')
          throw new Error('reshape(): only allowed on arrays/byte-array views');
        return mk(reshapeView(f, view, skipChecks, ...sizes), path, ctx);
      },
      flat: () => {
        if (region.spec.kind !== 'array')
          throw new Error('flat(): only allowed on arrays/byte-array views');
        return handle.reshape(region.count);
      },
      as: (toType: TypeName) => mk(castView(f, view, toType, skipChecks), path, ctx),
      lanes: (lanes: number) => {
        if (lanes === 1) return mk(view, path, omit(ctx, 'lanes'));
        return mk(view, path, { ...ctx, lanes: { lanes } });
      },
    });
    for (const byteSize of [1, 2, 4] as const) {
      handle[`as${byteSize * 8}`] = (type: TypeName = 'u32') =>
        mk(byteView(f, view, byteSize, type, skipChecks), path, ctx);
    }
    if (region.spec.kind === 'array') {
      // TODO: fix
      function dimsTotal(dims: readonly number[]): number {
        let t = 1;
        for (let i = 0; i < dims.length; i++) t *= dims[i] | 0;
        return t | 0;
      }
      function lin2multi(idx: number, dims: readonly number[]): number[] {
        // row-major: dims = [d0, d1, ..., dn-1]
        const out = new Array(dims.length);
        for (let k = dims.length - 1; k >= 0; k--) {
          const d = dims[k] | 0;
          out[k] = idx % d;
          idx = (idx / d) | 0;
        }
        return out;
      }
      function reshapeFlatToDims<T>(flat: T[], dims: readonly number[]): any[] {
        let idx = 0;
        const rec = (d: number): any => {
          const n = dims[d];
          const arr = new Array(n);
          if (d === dims.length - 1) {
            for (let i = 0; i < n; i++, idx++) arr[i] = flat[idx];
            return arr;
          }
          for (let i = 0; i < n; i++) arr[i] = rec(d + 1);
          return arr;
        };
        const res = rec(0);
        if (idx !== flat.length) throw new Error('reshape: size mismatch');
        return res;
      }
      function flattenStrictShape<T>(
        nested: any,
        dims: readonly number[],
        d = 0,
        out: T[] = []
      ): T[] {
        if (d === dims.length) {
          out.push(nested as T);
          return out;
        }
        if (!Array.isArray(nested) || nested.length !== dims[d]) {
          throw new Error(
            `set shape mismatch at dim ${d}: expected ${dims[d]}, got ${Array.isArray(nested) ? nested.length : 'non-array'}`
          );
        }
        for (let i = 0; i < dims[d]; i++) flattenStrictShape<T>(nested[i], dims, d + 1, out);
        return out;
      }
      const elem = region.spec.type;
      const dims: number[] = (region.spec.sizes || []) as number[];
      if (elem && elem.kind === 'struct') {
        Object.assign(handle, {
          get: () => {
            const total = dimsTotal(dims);
            const flat: any[] = new Array(total);
            for (let i = 0; i < total; i++) {
              const idxs = lin2multi(i, dims);
              let cur = view;
              for (const i of idxs) cur = cur.idx(i);
              flat[i] = mk(cur, path.concat(...idxs), ctx).get();
            }
            return reshapeFlatToDims(flat, dims);
          },
          set: (nestedVals: any) => {
            const flatObjs = flattenStrictShape<any>(nestedVals, dims);
            const total = dimsTotal(dims);
            if (flatObjs.length !== total)
              throw new Error('set: total size mismatch for array-of-structs');
            const flatRet: any[] = new Array(total);
            for (let i = 0; i < total; i++) {
              const idxs = lin2multi(i, dims);
              // child struct.set returns an object of field store nodes (per our struct.set above)
              let cur = view;
              for (const i of idxs) cur = cur.idx(i);
              flatRet[i] = mk(cur, path.concat(...idxs), ctx).set(flatObjs[i]);
            }
            return reshapeFlatToDims(flatRet, dims);
          },
        });
      } else if (region.spec.sizes.length > 1) {
        const prevGet = handle.get;
        const prevSet = handle.set;
        Object.assign(handle, {
          get: () => reshapeFlatToDims(prevGet(), dims),
          set: (nestedVals: any) => prevSet(flattenStrictShape<any>(nestedVals, dims)),
        });
      }
    }
    if (region.spec.kind === 'struct') {
      Object.assign(handle, {
        get: () => {
          const { fields } = region.spec as StructSpec;
          const outObj: Record<string, any> = {};
          // spec order: Object.keys preserves insertion order of `fields`
          for (const k of Object.keys(fields))
            outObj[k] = mk(view.idx(k), path.concat(k), ctx).get();
          return outObj;
        },
        set: (obj: Record<string, any>): void => {
          const { fields } = region.spec as StructSpec;
          const ret: Record<string, any> = {};
          for (const k of Object.keys(obj)) {
            if (!(k in fields)) throw new Error('Unknown struct field: ' + k);
            ret[k] = mk(view.idx(k), path.concat(k), ctx).set(obj[k]);
          }
          return ret as any; // debug return, type remains void to TS
        },
      });
    }
    const handler: ProxyHandler<any> = {
      get(target, p) {
        if (p in target) return (target as any)[p];
        if (typeof p === 'symbol') throw new Error('symbols not supported');
        let idx: string | number | FnOp = p as string;
        if (typeof p === 'string' && p.startsWith('{') && p.endsWith('}')) {
          idx = f.byIdx(JSON.parse(p).idx) as FnOp;
        }
        if (typeof p === 'string' && /^\d+$/.test(p)) idx = Number(p);
        let curCtx = ctx;
        // bind lanes to specific pos
        if (ctx.lanes && ctx.lanes.offset === undefined) {
          if (typeof idx === 'number') view.idx(idx + ctx.lanes.lanes - 1); // will throw on OOB
          if (region.spec.kind !== 'array') throw new Error(`lanes: not array ${region.spec.kind}`);
          const offset = PosExpr.mul(
            view.inner!.paddedSize,
            PosExpr.mul((view.spec as ArraySpec).sizes.slice(1))
          );
          curCtx = { ...ctx, lanes: { ...ctx.lanes, offset } };
        }
        return mk(view.idx(idx), path.concat(idx), curCtx);
      },
      set() {
        throw new Error('Proxy is read-only; use .set(...) on the handle');
      },
      has(_t, p) {
        return p === 'length' || p === Symbol.iterator || p === Symbol.toStringTag;
      },
    };
    return new Proxy(handle, handler);
  };
  return mk(basicView(f, region, skipChecks), [], {});
}

type RegionFull = RegionExpr & ProxyContext;

export function memOps(
  f: ModuleGraph,
  name: string,
  region: RegionFull,
  path: (number | string | FnOp)[]
): any {
  const res: Record<string, any> = { name, path, region };
  const { u32, i64 } = f.types;
  const getPos = (region: RegionExpr) => PosExpr.evalSym(f, region.pos);
  const getPosLanes = (region: RegionFull, pos?: number | PosExpr) => {
    if (pos === undefined) pos = region.pos;
    // we need custom pos here!
    const lanes = region.lanes && region.lanes.offset !== undefined ? region.lanes.lanes : 1;
    const offset = region.lanes && region.lanes.offset !== undefined ? region.lanes.offset : 0;
    const res = [];
    for (let i = 0; i < lanes; i++)
      res.push(PosExpr.evalSym(f, PosExpr.add(pos, PosExpr.term(i, offset))));
    return res;
  };

  const addPos = (curPos: number | FnOp, size: number) =>
    typeof curPos === 'number' ? curPos + size : u32.add(curPos, u32.const(size));
  const posSym = (pos: FnOp | number) => (typeof pos === 'number' ? u32.const(pos) : pos);

  function memOpts(name: string, pos: FnOp | number, opts: any = {}) {
    const fRoot = f.getCurFn().node;
    if (!fRoot.memOps[name]) fRoot.memOps[name] = { reads: [] };
    const ms = fRoot.memOps[name];
    const _opts = {
      ...opts,
      name,
      strong: ms.write !== undefined ? [ms.write] : [],
      rawOffset: true,
    };
    if (typeof pos === 'number') {
      if (_opts.offset === undefined) {
        _opts.offset = pos;
        pos = u32.const(0);
      } else {
        pos = u32.const(pos);
      }
    }
    return { pos, opts: _opts, ms };
  }
  function load(type: TypeName, pos: FnOp | number, opts: any = {}) {
    const o = memOpts(name, pos, opts);
    const res = f.op(type, 'load', [o.pos], o.opts);
    o.ms.reads.push(res.idx);
    return res;
  }
  function store(type: TypeName, pos: FnOp | number, value: FnOp, opts: any = {}) {
    const o = memOpts(name, pos, opts);
    const res = f.op(type, 'store', [o.pos, value], {
      ...o.opts,
      weak: o.ms.reads.map((i) => f.ops.weak(i)),
      isMut: true,
    });
    o.ms.write = res.idx;
    o.ms.reads = [];
    return res;
  }

  function getInfo(region: RegionFull, pos?: PosExpr | number, _type?: TypeName) {
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
    const typeSize = sizeof(type); // original type size
    let isSimd = SIMDType.has(type);
    let laneType;
    if (isSimd) {
      laneType = lanesOf(type);
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

  function tmp(region: RegionFull, opts: any = {}, pos?: PosExpr | number, _type?: TypeName) {
    const { offsets, lanes, type, typeSize } = getInfo(region, pos, _type);
    if (!type) throw new Error('no type');
    const bitWidth = 8 * typeSize!;
    const T = (f.types as any)[type];
    let size = opts.size;
    if (lanes !== 1 && size === undefined) size = bitWidth;
    let align = opts.align;
    if (size) align = wasmAlign(size / 8);
    return {
      load: () => {
        let acc = T.const(0);
        for (let i = 0; i < offsets.length; i++) {
          acc = load(type, offsets[i].pos, {
            ...opts,
            align: opts.align !== undefined ? Math.min(offsets[i].align, align) : undefined,
            size,
            lane: lanes === 1 ? undefined : i,
            src: lanes === 1 ? undefined : acc.idx,
          });
        }
        return acc;
      },
      store: (value: FnOp) => {
        const res = [];
        for (let i = 0; i < lanes; i++) {
          res.push(
            store(type, offsets[i].pos, value, {
              ...opts,
              size,
              align: opts.align !== undefined ? Math.min(offsets[i].align, align) : undefined,
              lane: lanes === 1 ? undefined : i,
            })
          );
        }
        return res.length === 1 ? res[0] : res;
      },
    };
  }

  const atomicOp = (type: TypeName, op: string, width: 1 | 2 | 4 | undefined, ...args: FnOp[]) => {
    const o = memOpts(name, pos);
    let opName = `atomic.${op}`;
    if (width !== undefined) {
      opName += `${width * 8}`;
      if (op !== 'store') opName += '_u';
    }
    const res = f.op(type, opName, [o.pos, ...args], {
      ...o.opts,
      weak: o.ms.reads.map((i) => f.ops.weak(i)),
      isMut: true,
      align: width !== undefined ? wasmAlign(width) : wasmAlign(sizeof(type)),
    });
    o.ms.write = res.idx;
    o.ms.reads = [];
    return res;
  };
  function getMut(type: TypeName) {
    const T = (f.types as any)[type];
    const mut: Record<string, any> = {
      exchange: (value: FnOp) => {
        const old = res.get();
        res.set(value);
        return old;
      },
      compareExchange: (expected: FnOp, replacement: FnOp) => {
        const old = res.get();
        const equal = T.eq(old, expected); // whatever your eq op is
        const next = T.select(equal, replacement, old);
        res.set(next);
        return old;
      },
    };
    const genOp =
      (op: string) =>
      (...args: FnOp[]) => {
        const val = res.get();
        res.set(T[op](val, ...args));
        return val;
      };
    for (const op of opsForType(type)) mut[op] = genOp(op);
    return mut;
  }

  const { pos, align } = getPos(region);
  const { type, isSimd, typeSize, offsets } = getInfo(region);
  Object.assign(res, { type });
  // type exists is either on scalar or array of scalars
  if (!type) return res;
  const T = (f.types as any)[type];

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
        copyFrom({ region: srcRegion, name: srcName }: any, len?: FnOp | number) {
          if (!srcRegion || !srcName) throw new Error('no src region/name');
          const dstName = name;
          // SRC
          const srcOffsets = getPosLanes(srcRegion);
          const dstOffsets = getPosLanes(region);
          if (srcOffsets.length !== dstOffsets.length && srcOffsets.length !== 1)
            throw new Error('wrong offsets length');

          const fRoot = f.getCurFn().node;
          if (!fRoot.memOps[srcName]) fRoot.memOps[srcName] = { reads: [] };
          const msSrc = fRoot.memOps[srcName];
          // DST
          if (!fRoot.memOps[dstName]) fRoot.memOps[dstName] = { reads: [] };
          const msDst = fRoot.memOps[dstName];
          if (len === undefined) {
            if (typeof region.size !== 'number' || typeof srcRegion.size !== 'number') {
              throw new Error('symbolic not supported');
            }
            len = Math.min(region.size, srcRegion.size);
          }
          // Len
          const res = [];
          for (let i = 0; i < dstOffsets.length; i++) {
            const dstOffset = dstOffsets[i].pos;
            const srcOffset = (srcOffsets.length === 1 ? srcOffsets[0] : srcOffsets[i]).pos;
            const strong = [];
            if (msDst.write !== undefined) strong.push(msDst.write);
            if (msSrc.write !== undefined) strong.push(msSrc.write);
            const resOp = f.op('i32', 'copy', [posSym(dstOffset), posSym(srcOffset), posSym(len)], {
              weak: msDst.reads.map((i) => f.ops.weak(i)),
              name: dstName,
              srcName: srcName,
              strong,
              isMut: true,
            });
            msDst.write = resOp.idx;
            msDst.reads = [];
            res.push(resOp);
            if (srcName !== dstName) msSrc.reads.push(resOp.idx);
          }
          return res.length === 1 ? res[0] : res;
        },
        fill(value: FnOp | number, len?: FnOp | number) {
          const root = f.getCurFn().node;
          if (!root.memOps[name]) root.memOps[name] = { reads: [] };
          if (len === undefined) len = PosExpr.evalSymSize(f, region.paddedSize);
          const offsets = getPosLanes(region);
          const res = [];
          const ms = root.memOps[name];
          for (const { pos } of offsets) {
            const resOp = f.op('i32', 'fill', [posSym(pos), posSym(value), posSym(len)], {
              weak: ms.reads.map((i) => f.ops.weak(i)),
              name,
              strong: ms.write !== undefined ? [ms.write] : [],
              isMut: true,
            });
            ms.write = resOp.idx;
            ms.reads = [];
            res.push(resOp);
          }
          return res.length === 1 ? res[0] : res;
        },
        zero(len?: FnOp | number) {
          return this.fill(0, len);
        },
        read(type: TypeName, size?: 8 | 16 | 32) {
          return tmp(region, { size }, undefined, type).load();
        },
        write(type: TypeName, value: FnOp, size?: 8 | 16 | 32) {
          return tmp(region, { size }, undefined, type).store(value);
        },
      });
    }
    // Should exist on byte level
    if (!IntType.has(type)) throw new Error('wrong type on byteView');
    if (region.spec.kind === 'array') {
      const count = Math.ceil(region.size / byteWidth);
      if (count * byteWidth > region.paddedSize) {
        throw new Error(
          `memOps/byteView: size=${region.size} is not enough for byteWidth=${byteWidth}`
        );
      }
      Object.assign(res, {
        get(): FnOp[] {
          const res = [];
          let curPos = pos;
          if (curPos instanceof FnOp) {
            curPos = PosExpr.term(curPos, 1);
          }
          for (let i = 0; i < count; i++) {
            res.push(
              tmp(
                region,
                { size: width, align: wasmAlign(byteWidth) },
                PosExpr.add(curPos, PosExpr.term(i, byteWidth))
              ).load()
            );
          }
          return res;
        },
        set(values: FnOp[]): void {
          if (values.length !== count)
            throw new Error(`set/array: wrong length=${values.length}, expected: ${count}`);
          const res = [];
          let curPos = pos;
          for (let i = 0; i < count; i++) {
            res.push(
              tmp(
                region,
                { size: width, align: wasmAlign(byteWidth) },
                PosExpr.add(curPos, PosExpr.term(i, byteWidth))
              ).store(values[i])
            );
          }
          return res as any as void;
        },
      });
    } else {
      Object.assign(res, {
        get: (): FnOp => tmp(region, { size: width, align: wasmAlign(byteWidth) }).load(),
        set: (value: FnOp) =>
          tmp(region, { size: width, align: wasmAlign(byteWidth) }).store(value),
      });
      const atomics: Record<string, any> = {
        store: (value: FnOp) => atomicOp(type, 'store', byteWidth, value),
      };
      if (UnsignedType.has(type)) {
        Object.assign(atomics, {
          load: () => atomicOp(type, 'load', byteWidth),
          exchange: (v: FnOp) => atomicOp(type, 'xchg', byteWidth, v),
          compareExchange: (expected: FnOp, value: FnOp) =>
            atomicOp(type, 'cmpxchg', byteWidth, expected, value),
        });
        for (const op of opsAtomics) atomics[op] = (v: FnOp) => atomicOp(type, op, byteWidth, v);
      }
      res.atomics = atomics;
      res.mut = getMut(type);
    }
    return res;
  }
  // We can do u32 get/set on width level here, but need to this about it later
  const isArray = region.spec.kind === 'array';
  const isScalar = region.spec.kind === 'scalar';

  if (isArray) {
    const isBig = BigIntType.has(type);
    const isSimdType = isSimd || isBig;
    const vecTypeName = isSimdType ? type : minSimdType(type);
    const vT = f.types[vecTypeName as SIMDType];
    const vecTypeSize = sizeof(vecTypeName);
    const lanes = lanesOf(vecTypeName);
    if (offsets.length > 1) {
      // Interleave
      Object.assign(res, {
        get(): FnOp[] {
          const curAlign = Math.min(align, wasmAlign(vecTypeSize));
          const vecCount = Math.floor(region.count! / lanes);
          let vecRes: FnOp[] = [];
          for (const offset of offsets) {
            let curPos = offset.pos;
            for (let i = 0; i < vecCount; i++) {
              vecRes.push(load(vecTypeName, curPos, { align: curAlign }));
              curPos = addPos(curPos, vecTypeSize);
            }
          }
          if (vecRes.length) vecRes = vT.interleave(vecRes);
          for (let i = vecRes.length; i < region.count!; i++)
            vecRes.push(
              tmp(region, {}, PosExpr.add(region.pos, PosExpr.term(i, typeSize!))).load()
            );
          if (region.opts.swapEndianness) vecRes = vecRes.map((i: any) => vT.swapEndianness(i));
          return vecRes;
        },
        set(values: FnOp[]): void {
          if (values.length !== region.count!)
            throw new Error(`set/array: wrong length=${values.length}, expected: ${region.count}`);
          if (region.opts.swapEndianness) values = values.map((i: any) => vT.swapEndianness(i));
          const res = [];
          const vecCount = Math.floor(region.count! / lanes);
          let vecRes = values.slice(0, vecCount * lanes);
          if (vecRes.length) vecRes = vT.deinterleave(vecRes);
          const curAlign = Math.min(align, wasmAlign(vecTypeSize));
          for (let i = 0, p = 0; i < lanes; i++) {
            const offset = offsets[i];
            let curPos = offset.pos;
            for (let j = 0; j < vecCount; j++) {
              res.push(store(vecTypeName, curPos, vecRes[p++], { align: curAlign }));
              curPos = addPos(curPos, vecTypeSize);
            }
          }
          for (let i = vecRes.length; i < region.count!; i++) {
            let v = values[i];
            res.push(tmp(region, {}, PosExpr.add(region.pos, PosExpr.term(i, typeSize!))).store(v));
          }
          return res as any as void;
        },
      });
    } else if (region.opts.swapEndianness && !isSimdType) {
      // Vectorized swapEndianess
      Object.assign(res, {
        get(): FnOp[] {
          const res = [];
          const curAlign = Math.min(align, wasmAlign(vecTypeSize));
          const vecCount = Math.ceil(region.count! / lanes);
          const vecRes = [];
          let curPos = pos;
          for (let i = 0; i < vecCount; i++) {
            let elm = load(vecTypeName, curPos, { align: curAlign });
            vecRes.push(vT.swapEndianness(elm));
            curPos = addPos(curPos, vecTypeSize);
          }
          for (const i of vecRes) {
            for (let j = 0; j < lanes; j++) {
              res.push(vT.extractLane(i, j));
              if (res.length === region.count) break;
            }
          }
          return res;
        },
        set(values: FnOp[]): void {
          if (values.length !== region.count!)
            throw new Error(`set/array: wrong length=${values.length}, expected: ${region.count}`);
          const res = [];
          const scalarAlign = Math.min(align, wasmAlign(typeSize!));
          const vecAlign = Math.min(align, wasmAlign(vecTypeSize));
          const vecCount = Math.ceil(region.count! / lanes);
          // Pack vectors
          let vecRes: FnOp[] = [];
          for (let i = 0; i < region.count!; i += lanes) {
            let v = vT.const(0);
            for (let j = 0; j < lanes && i + j < region.count!; j++)
              v = vT.replaceLane(v, j, values[i + j]);
            vecRes.push(v);
          }
          vecRes = vecRes.map((i) => vT.swapEndianness(i)); // 2) Swap all packed vectors once
          // 3) Store full vectors
          let curPos: number | FnOp = pos;
          const fullVecs = Math.floor(region.count! / lanes);
          for (let i = 0; i < fullVecs; i++) {
            res.push(store(vecTypeName as any, curPos, vecRes[i], { align: vecAlign }));
            curPos = addPos(curPos, vecTypeSize);
          }
          // 4) Tail: extract lanes from the last swapped vector and scalar-store (no overrun)
          const tail = region.count! - fullVecs * lanes;
          if (tail > 0) {
            const tv = vecRes[vecCount - 1];
            for (let j = 0; j < tail; j++) {
              const lane = vT.extractLane(tv, j);
              res.push(store(type, curPos, lane, { align: scalarAlign }));
              curPos = addPos(curPos, typeSize!);
            }
          }
          return res as any as void;
        },
      });
    } else {
      // Basic
      Object.assign(res, {
        get(): FnOp[] {
          const res = [];
          let curPos = pos;
          const curAlign = Math.min(align, wasmAlign(typeSize!));
          for (let i = 0; i < region.count!; i++) {
            let elm = load(type, curPos, { align: curAlign });
            if (region.opts.swapEndianness) elm = T.swapEndianness(elm);
            res.push(elm);
            curPos = addPos(curPos, typeSize!);
          }
          return res;
        },
        set(values: FnOp[]): void {
          if (values.length !== region.count!)
            throw new Error(`set/array: wrong length=${values.length}, expected: ${region.count}`);
          const res = [];
          let curPos = pos;
          const curAlign = Math.min(align, wasmAlign(typeSize!));
          for (let i = 0; i < region.count!; i++) {
            let elm = values[i];
            if (region.opts.swapEndianness) elm = T.swapEndianness(elm);
            res.push(store(type, curPos, elm, { align: curAlign }));
            curPos = addPos(curPos, typeSize!);
          }
          return res as any as void;
        },
      });
    }

    // what else can we do here?
  } else if (isScalar) {
    Object.assign(res, {
      get(): FnOp {
        let value = tmp(region, { align }).load();
        if (region.opts.swapEndianness) value = T.swapEndianness(value);
        return value;
      },
      set(value: FnOp) {
        if (region.opts.swapEndianness) value = T.swapEndianness(value);
        return tmp(region, { align }).store(value);
      },
    });
    // Add atomics
    if (IntType.has(type) && ScalarType.has(type)) {
      const atomics: Record<string, any> = {
        // Loads/stores at this scalar address
        store: (value: FnOp) => atomicOp(type, 'store', undefined, value),
        notify: (count: FnOp | number = 1) => atomicOp(type, 'notify', undefined, posSym(count)),
        // Barriers
        fence: () => atomicOp(type, 'fence', undefined),
        wait: (expected: FnOp, timeout: FnOp | number = -1) =>
          atomicOp(
            type,
            'wait',
            undefined,
            expected,
            typeof timeout === 'number' ? i64.const(timeout) : timeout
          ),
        load: () => atomicOp(type, 'load', undefined),
        exchange: (v: FnOp) => atomicOp(type, 'xchg', undefined, v),
        compareExchange: (expected: FnOp, value: FnOp) =>
          atomicOp(type, 'cmpxchg', undefined, expected, value),
      };
      for (const op of opsAtomics) atomics[op] = (v: FnOp) => atomicOp(type, op, undefined, v);
      res.atomics = atomics;
    }
    res.mut = getMut(type);
  }
  return res;
}
