import { utils as baseUtils } from '@scure/base';
import * as P from 'micro-packed';

export type ElementOf<T> = T extends readonly (infer U)[] ? U : never;
export type ND<T> = T | readonly ND<T>[];

/** Generic type encompassing 8/16/32-byte arrays - but not 64-byte. */
// prettier-ignore
export type TypedArray = Int8Array | Uint8ClampedArray | Uint8Array |
  Uint16Array | Int16Array | Uint32Array | Int32Array;

/** Cast u8 / u16 / u32 to u8. */
export function u8(arr: TypedArray): Uint8Array {
  return new Uint8Array(arr.buffer, arr.byteOffset, arr.byteLength);
}

/** Cast u8 / u16 / u32 to u32. */
export function u32(arr: TypedArray): Uint32Array {
  return new Uint32Array(arr.buffer, arr.byteOffset, Math.floor(arr.byteLength / 4));
}

export function createView(arr: TypedArray): DataView {
  return new DataView(arr.buffer, arr.byteOffset, arr.byteLength);
}

export function wasmAlign(addr: number): number {
  const lsb = addr & -addr;
  return Math.clz32(lsb) ^ 31;
}

export function deepClone<T>(value: T): T {
  // if (Array.isArray(value)) return value.map(deepClone) as T;
  // if (typeof value === 'object' && value !== null)
  //   return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, deepClone(v)])) as T;
  // return value;
  if (isBytes(value)) return value.slice() as T;
  if (value === null || typeof value !== 'object') return value;
  if (Array.isArray(value)) {
    const src = value as unknown as any[];
    const n = src.length;
    const out = new Array(n);
    for (let i = 0; i < n; i++) {
      const v = src[i];
      out[i] = v && typeof v === 'object' ? deepClone(v) : v;
    }
    return out as unknown as T;
  }
  if (value instanceof Set) return new Set(value) as T;
  // plain object clone
  const src = value as unknown as Record<string, any>;
  const out: Record<string, any> = {};
  for (const k in src) {
    if (Object.prototype.hasOwnProperty.call(src, k)) {
      const v = src[k];
      out[k] = v && typeof v === 'object' ? deepClone(v) : v;
    }
  }
  return out as T;
}

// Deep readonly type (keeps functions as-is)
type Primitive = string | number | boolean | bigint | symbol | null | undefined;
export type DeepReadonly<T> = T extends Primitive | ((...a: any[]) => any)
  ? T
  : T extends Array<infer U>
    ? ReadonlyArray<DeepReadonly<U>>
    : T extends Map<infer K, infer V>
      ? ReadonlyMap<DeepReadonly<K>, DeepReadonly<V>>
      : T extends Set<infer U>
        ? ReadonlySet<DeepReadonly<U>>
        : { readonly [K in keyof T]: DeepReadonly<T[K]> };

// Deep freeze with cycle protection
export function deepFreeze<T>(obj: T, _seen = new WeakSet<object>()): DeepReadonly<T> {
  if (obj === null || typeof obj !== 'object') return obj as DeepReadonly<T>;
  const o = obj as unknown as object;
  if (_seen.has(o) || Object.isFrozen(o)) return obj as DeepReadonly<T>;
  _seen.add(o);
  // Collections
  if (o instanceof Map) {
    // freeze entries first, then the container
    for (const [k, v] of o) {
      deepFreeze(k as any, _seen);
      deepFreeze(v as any, _seen);
    }
    Object.freeze(o);
    return o as DeepReadonly<T>;
  }
  if (o instanceof Set) {
    for (const v of o) deepFreeze(v as any, _seen);
    Object.freeze(o);
    return o as DeepReadonly<T>;
  }
  // Typed arrays (DataView handled as plain object below)
  // Freezes the view object; underlying buffer remains mutable by spec.
  if (ArrayBuffer.isView(o) && !(o instanceof DataView)) {
    Object.freeze(o);
    return o as DeepReadonly<T>;
  }
  // Plain objects / arrays / class instances
  // Recurse into own data properties (ignores accessors to avoid invoking getters)
  for (const k of Reflect.ownKeys(o)) {
    const d = Object.getOwnPropertyDescriptor(o, k as PropertyKey);
    if (!d) continue;
    if ('value' in d) deepFreeze((d as PropertyDescriptor & { value: any }).value, _seen);
  }
  // Finally freeze the container itself
  Object.freeze(o);
  return o as DeepReadonly<T>;
}

// Reverses key<->values
type RevObj<T extends Record<string, string | number>> = {
  [K in T[keyof T]]: Extract<keyof T, string>;
};
export function reverseObject<T extends Record<string, string | number>>(obj: T): RevObj<T> {
  const res = {} as any;
  for (const k in obj) {
    if (res[obj[k]] !== undefined) throw new Error('duplicate key');
    res[obj[k]] = k;
  }
  return res;
}
export function mapCoder<T extends Record<string, string>>(obj: T) {
  const r = reverseObject(obj);
  return {
    direct: obj,
    reverse: r,
    encode(from) {
      if (obj[from] === undefined)
        throw new Error(
          `mapCoder: unknown element=${from.toString()} expected ${Object.keys(obj)}`
        );
      return obj[from];
    },
    decode(to) {
      if (r[to] === undefined)
        throw new Error(`mapCoder: unknown element=${to} expected ${Object.keys(r)}`);
      return r[to];
    },
    encodeSilent: (from: string) => obj[from] as T[keyof T] | undefined,
    decodeSilent: (to: string) => (r as any)[to] as RevObj<T>[T[keyof T]] | undefined,
  } satisfies P.Coder<keyof T, keyof RevObj<T>> & {
    direct: T;
    reverse: RevObj<T>;
    encodeSilent: (from: string) => T[keyof T] | undefined;
    decodeSilent: (to: string) => RevObj<T>[T[keyof T]] | undefined;
  };
}

export function log2(x: number) {
  if (x <= 0 || (x & (x - 1)) !== 0) throw new Error('Not a power of two');
  return 31 - Math.clz32(x);
}

export const chunks = <T>(a: readonly T[], size: number): T[][] => {
  const n = size | 0;
  if (n <= 0) throw new RangeError('size must be > 0');
  const out: T[][] = [];
  for (let i = 0; i < a.length; i += n) out.push(a.slice(i, i + n));
  return out;
};

export function chunkBytes(a: Uint8Array, size: number): Uint8Array[] {
  if (size <= 0) throw new RangeError('size must be > 0');
  const full = Math.floor(a.length / size); // number of full chunks (floor)
  const paddedChunkSize = Math.floor(a.length / full);
  const res = [];
  for (let i = 0, pos = 0; i < full; i++) {
    res.push(a.subarray(pos, pos + size));
    pos += paddedChunkSize;
  }
  return res;
}

export const seq = (length: number) => Array.from({ length }, (_, i) => i);

export function omit<T extends object, K extends keyof T>(
  obj: T,
  ...keys: readonly K[]
): Omit<T, K> {
  return Object.fromEntries(Object.entries(obj).filter(([k]) => !keys.includes(k as K))) as Omit<
    T,
    K
  >;
}

export function last<T>(xs: T[]): T {
  if (xs.length === 0) throw new Error('last(): empty array');
  return xs[xs.length - 1];
}

// Nd matrix like ops to reduce complexity of simd stuff
export const named = <const N extends string[]>(names: N) => {
  type K = N[number];
  return {
    encode<T>(lst: T[]): Record<K, T> {
      if (lst.length !== names.length) throw new Error('arr size mismatch');
      const r = {} as Record<K, T>;
      for (let i = 0; i < names.length; i++) (r as any)[names[i]] = lst[i];
      return r;
    },
    decode<T>(obj: Record<K, T>): T[] {
      const out = [];
      for (const n of names) out.push((obj as any)[n]);
      return out;
    },
  } as const;
};

export function Dimensions<const D extends number[]>(...dims: D) {
  type Nest<T, D extends unknown[]> = D extends [any, ...infer R] ? Array<Nest<T, R>> : T;
  if (dims.length === 0) throw new Error('no dimensions');
  let cardinality = 1;
  for (const d of dims) {
    if (d < 1) throw new Error('wrong dimension size: ' + d);
    cardinality *= d;
  }
  const L = dims.length;
  // strides[i] = product(dims[i+1..])
  const strides: number[] = new Array(L);
  {
    let s = 1;
    for (let i = L - 1; i >= 0; i--) {
      strides[i] = s;
      s *= dims[i];
    }
  }
  const checkIdx = (idx: number[]): void => {
    if (idx.length !== L) throw new Error('wrong number of dimensions');
    for (let i = 0; i < L; i++) {
      const v = idx[i] as number;
      if (v < 0 || v >= dims[i]) throw new Error('wrong dimension position');
    }
  };
  const flatKey = {
    encode(idx: number[]): number {
      checkIdx(idx);
      let acc = 0;
      for (let i = 0; i < L; i++) acc += (idx[i] as number) * strides[i];
      if (acc < 0 || acc >= cardinality) throw new Error('idx key bounds');
      return acc;
    },
    decode(i: number): number[] {
      if (i < 0 || i >= cardinality) throw new Error('idx key bounds');
      const out = [];
      for (let k = 0; k < L; k++) out.push(Math.trunc(i / strides[k]) % dims[k]) as number;
      checkIdx(out);
      return out;
    },
  } as const; // satisfies P.Coder<Index<D>, number>
  // Iterates all points (flat,index). This version uses decode; see fastIter below.
  const iter = (cb: (flat: number, idx: number[]) => void): void => {
    for (let i = 0; i < cardinality; i++) cb(i, flatKey.decode(i));
  };
  const getAt = <T>(obj: Nest<T, D>, keys: number[]): T => {
    let o: any = obj;
    for (let k = 0; k < L; k++) o = o[keys[k] as number];
    return o as T;
  };
  const setAt = <T>(obj: Nest<T, D>, keys: number[], value: T): void => {
    let o: any = obj;
    for (let k = 0; k < L - 1; k++) {
      const key = keys[k] as number | string;
      const nk = keys[k + 1] as number | string;
      if (o[key] === undefined) o[key] = typeof nk === 'number' ? [] : {};
      o = o[key];
    }
    o[keys[L - 1] as number | string] = value;
  };
  const flat = {
    encode<T>(x: Nest<T, D>): T[] {
      const out: T[] = new Array(cardinality);
      iter((i, k) => {
        out[i] = getAt(x, k);
      });
      return out;
    },
    decode<T>(lst: T[]): Nest<T, D> {
      if (lst.length !== cardinality) throw new Error('lst.length');
      const out: any = [];
      iter((i, k) => {
        setAt(out, k, lst[i]);
      });
      return out as Nest<T, D>;
    },
  } as const;

  return {
    dims,
    cardinality,
    strides: strides as number[],
    get: getAt,
    set: setAt,
    key: flatKey,
    flat,
    iter,
  } as const;
}
export function NamedDimensions<const O extends Record<string, number>>(o: O) {
  type K = keyof O & string;
  type NamedIndex = { [P in K]: number };

  const names = Object.keys(o) as K[];
  const dims = names.map((k) => o[k]) as unknown as readonly number[];

  const nd = named(names as K[]);
  const d = Dimensions(...dims);
  const keyNamed = baseUtils.chain(P.coders.reverse(nd) as any, d.key) as P.Coder<
    NamedIndex,
    number
  >;
  return {
    ...d,
    key: keyNamed,
    iter: (cb: (flat: number, idx: NamedIndex) => void) => {
      d.iter((flat, tIdx) => cb(flat, nd.encode<number>(tIdx as any) as NamedIndex));
    },
    chunks<T>(name: K, lst: T[]) {
      const dim = names.indexOf(name);
      if (dim < 0) throw new Error('unknown dimension:' + name);
      return chunks(lst, dims[dim]);
    },
  };
}

// By default we align everything to v128, since there is no larger SIMD, it should work.
export const align = (pos: number, alignment: number = 16): number =>
  Math.ceil(pos / alignment) * alignment;

function retryIfChanged(fn: () => boolean) {
  let changed = false;
  for (;;) {
    if (fn()) changed = true;
    else break;
  }
  return changed;
}

export const Shape = <T>(isVal: (val: unknown) => val is T) => {
  const isPlain = (o: unknown): o is Record<string, unknown> =>
    !!o && Object.getPrototypeOf(o) === Object.prototype;
  type Flat = T[];
  type Collapsed = { shape: unknown; flat: Flat };
  return {
    decode<S>(input: S): Collapsed {
      const flat: Flat = [];
      const walkShape = (x: unknown): unknown => {
        if (isVal(x)) {
          const i = flat.length;
          flat.push(x);
          return i;
        }
        if (Array.isArray(x)) return x.map(walkShape);
        if (isPlain(x)) {
          const out: Record<string, unknown> = {};
          for (const k of Object.keys(x)) out[k] = walkShape((x as any)[k]);
          return out;
        }
        // Non-plain object that wasn't accepted by isVal -> force explicit decision
        if (x && typeof x === 'object')
          throw new Error(
            `Unsupported container (not plain obj/array) at ${Object.prototype.toString.call(x)}; make isVal accept it to treat as leaf.`
          );
        // Primitives not accepted by isVal
        throw new Error(`Value not accepted by isVal: ${String(x)}`);
      };
      return { shape: walkShape(input), flat };
    },
    encode<S>(shape: unknown, flat: readonly T[]): S {
      const walkShape = (s: unknown): unknown => {
        if (typeof s === 'number' && Number.isInteger(s)) {
          if (s < 0 || s >= flat.length) throw new Error(`Index out of range: ${s}`);
          return flat[s];
        }
        if (Array.isArray(s)) return s.map(walkShape);
        if (isPlain(s)) {
          const out: Record<string, unknown> = {};
          for (const k of Object.keys(s)) out[k] = walkShape((s as any)[k]);
          return out;
        }
        throw new Error('Shape contains unsupported node (expect number/array/plain-object).');
      };
      return walkShape(shape) as S;
    },
    validate(shape: unknown, candidate: unknown): boolean {
      const v = (s: unknown, c: unknown): boolean => {
        if (typeof s === 'number' && Number.isInteger(s)) return isVal(c);
        if (Array.isArray(s)) {
          if (!Array.isArray(c) || s.length !== c.length) return false;
          for (let i = 0; i < s.length; i++) if (!v(s[i], c[i])) return false;
          return true;
        }
        if (isPlain(s)) {
          if (!isPlain(c)) return false;
          const ks = Object.keys(s),
            kc = Object.keys(c);
          if (ks.length !== kc.length) return false;
          for (const k of ks) if (!kc.includes(k) || !v((s as any)[k], (c as any)[k])) return false;
          return true;
        }
        return false;
      };
      return v(shape, candidate);
    },
  };
};

const BitSet = <K extends string>(domain: readonly K[]) => {
  const key2bit = {} as Record<K, number>;
  let MASK = 0 >>> 0;
  if (domain.length > 31) throw new Error('only 31 flags supprted');
  for (let i = 0; i < domain.length; i++) {
    const b = 1 << i; // up to 31 flags; for 32+ use two u32s or BigInt
    key2bit[domain[i]] = b;
    MASK |= b;
  }
  return {
    domain,
    key2bit,
    encode: (s: Iterable<K>) => {
      let m = 0;
      for (const k of s) m |= key2bit[k];
      return m >>> 0;
    },
    decode: (m: number) => {
      const out = new Set<K>();
      for (let i = 0; i < domain.length; i++) if (m & (1 << i)) out.add(domain[i]);
      return out;
    },
    ZERO: 0,
    MASK,
    has: (m: number, k: K) => (m & key2bit[k]) !== 0,
    add: (m: number, k: K) => (m | key2bit[k]) >>> 0,
    delete: (m: number, k: K) => (m & ~key2bit[k]) >>> 0,
    toggle: (m: number, k: K) => (m ^ key2bit[k]) >>> 0,
    or: (...ms: number[]) => ms.reduce((a, b) => (a | b) >>> 0, 0) >>> 0,
    and: (...ms: number[]) => ms.reduce((a, b) => (a & b) >>> 0, MASK) & MASK,
    xor: (...ms: number[]) => ms.reduce((a, b) => (a ^ b) >>> 0, 0) >>> 0,
    not: (m: number) => (~m & MASK) >>> 0,
    maskOf: (...ks: K[]) => ks.reduce((m, k) => (m | key2bit[k]) >>> 0, 0) >>> 0,
    combine: (AND: number, OR: number, ...ms: number[]) => {
      let andAcc = MASK,
        orAcc = 0;
      for (let i = 0; i < ms.length; i++) {
        const m = ms[i] >>> 0;
        andAcc &= m;
        orAcc |= m;
      }
      return ((andAcc & AND) | (orAcc & OR)) >>> 0;
    },
  };
};

/**
 * Utils to work with human readable indices for nodes in TreeDAG
 */
export const Path = {
  flags: /* @__PURE__ */ mapCoder({ w: 'weak', s: 'sticky' } as const),
  bs: /* @__PURE__ */ BitSet(['weak', 'sticky']),
  // TODO: Those are unbound, works for now, worth cleaning after
  cache: {
    decode: /* @__PURE__ */ new Map() as Map<string, any>,
    parent: /* @__PURE__ */ new Map() as Map<string, any>,
    noFlags: /* @__PURE__ */ new Map() as Map<string, string>,
  },
  encode(path: number[], mask: number = 0): string {
    if (!Array.isArray(path)) throw new Error('Path.encode: path must be non-empty number[]');
    for (const n of path)
      if (!Number.isSafeInteger(n) || n < 0) throw new Error('Path.encode: bad segment');
    const base = path.join('.');
    if (!mask) return base;
    // canonical order = insertion order of short->long mapping
    let fstr = '';
    for (const k in this.flags.direct)
      if (this.bs.has(mask, (this.flags.direct as any)[k])) fstr += k;
    return base + fstr;
  },
  _scanSuffix(token: string): { split: number; mask: number } {
    let i = token.length;
    let mask = this.bs.ZERO;
    const direct = this.flags.direct as Record<string, string>; // short -> long
    const enc = this.flags.encode;
    // walk backwards while next char is a known short flag
    for (;;) {
      const j = i - 1;
      if (j < 0) break;
      const ch = token[j];
      if (!direct[ch]) break; // NOT a short flag -> stop
      mask = this.bs.add(mask, enc(ch as any)); // accumulate into bitmask
      i = j;
    }
    return { split: i, mask };
  },
  // add inside Path
  _flagsSuffix(mask: number): string {
    if (!mask) return '';
    let f = '';
    for (const k in this.flags.direct) {
      if (this.bs.has(mask, (this.flags.direct as any)[k])) f += k;
    }
    return f;
  },
  _setFlagsOnBase(base: string, mask: number): string {
    const suf = this._flagsSuffix(mask);
    return suf ? base + suf : base;
  },
  _base(token: string): string {
    const { split } = this._scanSuffix(token);
    return token.slice(0, split);
  },
  decode(token: string): { path: number[]; mask: number } {
    if (typeof token !== 'string') throw new Error(`Path.decode: wrong token ${token}`);
    const hit = this.cache.decode.get(token);
    if (hit) return hit;
    const { split, mask } = this._scanSuffix(token);
    const base = token.slice(0, split);
    const path: number[] = [];
    if (base) {
      // same split('.') approach; you can swap to a manual parse later if needed
      const parts = base.split('.');
      for (let i = 0; i < parts.length; i++) {
        const s = parts[i],
          n = Number(s);
        if (!Number.isSafeInteger(n) || n < 0 || String(n) !== s)
          throw new Error(`Path.decode: bad segment '${s}'`);
        path.push(n);
      }
    }
    const res = { path, mask };
    this.cache.decode.set(token, res);
    return res;
  },
  getFlags(flags: string[]): number {
    let res = this.bs.ZERO;
    for (const f of flags) res = this.bs.or(res, this.bs.maskOf(f as any));
    return res;
  },
  addFlags(token: string, toAdd: number = 0): string {
    const { split, mask } = this._scanSuffix(token);
    const base = token.slice(0, split);
    return this._setFlagsOnBase(base, this.bs.or(mask, toAdd));
  },
  stripFlags(token: string, remove?: Iterable<string>): string {
    if (!remove) {
      let res = this.cache.noFlags.get(token);
      if (res) return res;
      const { split } = this._scanSuffix(token);
      res = token.slice(0, split);
      this.cache.noFlags.set(token, res);
      return res;
    }
    const { split, mask } = this._scanSuffix(token);
    let m = mask;
    for (const f of remove) m = this.bs.delete(m, f as any);
    return this._setFlagsOnBase(token.slice(0, split), m);
  },
  parent(token: string): { parent: string; current: number; mask: number } {
    const hit = this.cache.parent.get(token);
    if (hit) return hit;
    const { split, mask } = this._scanSuffix(token);
    if (split === 0) throw new Error('Path.parent: root has no parent'); // only '' case
    // find last '.' inside base
    let dot = -1;
    for (let i = split - 1; i >= 0; i--) {
      if (token[i] === '.') {
        dot = i;
        break;
      }
    }
    let parent: string, current: number;
    if (dot < 0) {
      // top-level like '3[w|s]*'
      parent = '';
      current = Number(token.slice(0, split)); // fast enough; you can swap to a manual parse if needed
    } else {
      parent = token.slice(0, dot); // exact base substring (no flags)
      current = Number(token.slice(dot + 1, split));
    }
    const res = { parent, current, mask };
    this.cache.parent.set(token, res);
    return res;
  },
  // numeric lexicographic order
  // Return < 0: treat a < b (a comes before b).
  // Return 0: treat a == b (order unchanged).
  // Return > 0: treat a > b (a comes after b).
  // tokens.sort((a, b) => Path.cmp(a, b));          // ascending
  // tokens.sort((a, b) => -Path.cmp(a, b));         // descending
  cmp(a: string, b: string): number {
    const pa = this.decode(a).path;
    const pb = this.decode(b).path;
    const n = Math.min(pa.length, pb.length);
    for (let i = 0; i < n; i++) if (pa[i] !== pb[i]) return pa[i] < pb[i] ? -1 : 1;
    // prefix comes first
    if (pa.length !== pb.length) return pa.length < pb.length ? -1 : 1;
    return 0;
  },
  merge(...args: string[]): Set<string> {
    type Acc = { andMask: number; orMask: number };
    const buckets: Record<string, Acc> = Object.create(null);
    const AND = this.bs.maskOf('weak');
    const OR = this.bs.maskOf('sticky');

    for (const tok of args) {
      const { split, mask } = this._scanSuffix(tok);
      const base = tok.slice(0, split);
      const b = (buckets[base] ||= { andMask: this.bs.MASK, orMask: 0 });
      b.andMask &= mask;
      b.orMask |= mask;
    }

    const out = new Set<string>();
    for (const base in buckets) {
      const b = buckets[base];
      const m = ((b.andMask & AND) | (b.orMask & OR)) >>> 0;
      // no decode(base), no encode(path,...)
      out.add(this._setFlagsOnBase(base, m));
    }
    return out;
  },
  // Returns true if 'child' is inside of 'parent' at any level
  // Self is not parent of itself.
  // TODO: pretty much child.startsWith(parent), but '45.1 vs 45.19'
  isParent(parent: string, child: string): boolean {
    const pa = this.decode(parent).path;
    const pb = this.decode(child).path;
    if (pa.length >= pb.length) return false; // strict
    for (let i = 0; i < pa.length; i++) if (pa[i] !== pb[i]) return false;
    return true;
  },
  // Returns true if all paths has same "base":
  // - '1, 2, 3.1.2.3', but not '1.2, 2.3, 3.4'
  // Expects paths to be sorted
  isSiblings(paths: Set<string>) {
    const res = Array.from(paths);
    const firstParent = Path.parent(res[0]).parent;
    for (let i = 1; i < res.length; i++) {
      if (!Path.isParent(firstParent, res[i])) return false;
    }
    return true;
  },
  mapParent(oldParent: string, newParent: string, child: string): string {
    if (!child.startsWith(oldParent))
      throw new Error(`wrong child=${child} (old=${oldParent} new=${newParent})`);
    return `${newParent}${child.slice(oldParent.length)}`;
  },
  normDepth(cur: string, n: string): string {
    const c = Path.decode(cur);
    const o = Path.decode(n);
    const clen = c.path.length,
      olen = o.path.length;
    let i = 0;
    while (i < clen && i < olen && c.path[i] === o.path[i]) i++;
    if (i === olen) return n; // n is ancestor or same
    if (i === clen && clen < olen)
      // cur is ancestor of n
      return Path.encode(o.path.slice(0, clen), o.mask);
    // diverged somewhere before the end of either path:
    // normalize n to its node just under the divergence (e.g., 55.32 from 55.32.163)
    return Path.encode(o.path.slice(0, i + 1), o.mask);
  },
  hasFlag(idx: string, flag: string) {
    const res = Path.decode(idx);
    return this.bs.has(res.mask, flag as any);
  },
  addFlagsFrom(idx: string, from: string) {
    // grab masks without allocating paths/sets
    const a = this._scanSuffix(idx); // { split, mask } for idx
    const b = this._scanSuffix(from); // { split, mask } for from
    // keep idx's base; OR the flags
    const base = idx.slice(0, a.split);
    const m = this.bs.or(a.mask, b.mask);
    return this._setFlagsOnBase(base, m);
  },
  cleanCache() {
    this.cache.decode.clear();
    this.cache.noFlags.clear();
    this.cache.parent.clear();
  },
};

// Directed Acyclic Graph structure for operations/instructions
export type TreeNode<T> = T & {
  nodes?: (TreeNode<T> | undefined)[];
};
type Subgraph<T> = TreeNode<T> & {
  nodes: (TreeNode<T> | undefined)[];
};
export type TreeMapping = Map<string, string>;
const EMPTY_MAP: TreeMapping = /* @__PURE__ */ new Map();
export type Rewrite<T> = (node: TreeNode<T>, idx: string) => string | undefined;
export type TreeDAGOpts<T> = {
  formatNode?: (node: TreeNode<T>) => string; // debug + collapser
  // Change: we now provide subgraph
  mapEdges: (g: TreeDAG<T>, node: TreeNode<T>, mapping: TreeMapping, partial: boolean) => void; // toposort + gc
  isUsed?: (parent: TreeNode<T>, node: TreeNode<T>, idx: string, flags: Set<string>) => boolean;
  getEdges: (node: TreeNode<T>, idx: string) => (string | undefined)[];
  getFlags: (node: TreeNode<T>) => (string | undefined)[]; // like 'memStore' (previously isMut)
};
/**
 * Core data-structure of compiler, represents code as nested DAG's (Directed Acyclic Graphs)
 * Applies rewrites with reverse edge cache, does toposort and removes unreachable nodes
 */
export class TreeDAG<T> {
  opts: TreeDAGOpts<T>;
  root: TreeNode<T>;
  stack: string[]; // we are cursor at same time to simplify '.add'
  stableId = 0;
  usedBy: Map<string, Set<string>>;
  usedWeak: Map<string, Set<string>>;
  cache: {
    edges: Map<string, Set<string>>;
    edgesRec: Map<string, Set<string>>;
    flags: Map<string, Set<string>>;
  };
  debug: boolean;
  private dirtyScopes: Set<string>;
  constructor(root: TreeNode<T>, opts: TreeDAGOpts<T>) {
    this.root = root;
    this.opts = opts;
    this.stack = [''];
    this.usedBy = new Map();
    this.usedWeak = new Map();
    this.debug = false;
    this.dirtyScopes = new Set();
    this.cache = {
      edges: new Map(),
      edgesRec: new Map(),
      flags: new Map(),
    };
  }
  private isSubgraph(node: TreeNode<T>): node is Subgraph<T> {
    return node.nodes && Array.isArray(node.nodes) ? true : false;
  }
  private assertPath(path: number[], allowRoot = true) {
    if (!Array.isArray(path)) throw 'isPath: not an array';
    if (!allowRoot && path.length === 0) throw new Error('get: empty path');
    for (const i of path) if (!Number.isSafeInteger(i)) throw new Error('isPath: not a number');
  }
  private getPathStack(
    path: number[],
    allowRoot = true,
    allowEmpty = false
  ): { idx: string; node: TreeNode<T> }[] {
    this.assertPath(path, allowRoot);
    const stack = [{ node: this.root, idx: '' }];
    if (path.length === 0) return stack;
    for (let depth = 0; depth < path.length; depth++) {
      let cur = last(stack).node;
      if (!this.isSubgraph(cur))
        throw new Error('non subgraph at ' + path.slice(0, depth).join('/'));
      const i = path[depth];
      cur = cur.nodes![i]!;
      if (cur === undefined && !allowEmpty)
        throw new Error(`get: removed node at ${path.slice(0, depth + 1).join('/')}`);
      stack.push({ idx: Path.encode(path.slice(0, depth + 1)), node: cur });
    }
    return stack;
  }
  private getPath(path: number[], allowRoot = true, allowEmpty = false) {
    // This is slower, but more general:
    // return last(this.getPathStack(path, allowRoot, allowEmpty)).node;
    this.assertPath(path, allowRoot);
    // path = this.resolvePath(idx);
    // synthetic root container as a Node2-like object
    let cur = this.root;
    if (path.length === 0) return cur;
    for (let depth = 0; depth < path.length; depth++) {
      if (!this.isSubgraph(cur))
        throw new Error('non subgraph at ' + path.slice(0, depth).join('/'));
      const i = path[depth];
      cur = cur.nodes![i]!;
      if (cur === undefined && !allowEmpty)
        throw new Error(`get: removed node at ${path.slice(0, depth + 1).join('/')}`);
    }
    return cur!;
  }
  weak(idx: string): string {
    return Path.addFlags(idx, Path.bs.maskOf('weak'));
  }
  exists(idx: string): boolean {
    const { path } = Path.decode(idx);
    const res = this.getPath(path, false, true);
    return res !== undefined;
  }
  get(idx: string): TreeNode<T> {
    const { path } = Path.decode(idx);
    return this.getPath(path);
  }
  getStack(idx: string) {
    const { path } = Path.decode(idx);
    return this.getPathStack(path);
  }
  enter(idx: string) {
    if (!this.isSubgraph(this.get(idx))) throw new Error('enter: target is not a subgraph: ' + idx);
    this.stack.push(idx);
  }
  exit() {
    this.stack.pop();
    if (!this.stack.length) throw new Error('empty stack (already at root)');
  }
  scope(idx: string, cb: () => void) {
    this.enter(idx);
    cb();
    this.exit();
  }
  // Cache hooks
  private invalidateEdgeCaches(idx: string) {
    // per-node cache
    this.cache.edges.delete(idx);
    //this.cache.edgesRec.delete(idx);
  }
  private onAdd(idx: string, node?: TreeNode<T>, edges?: (string | undefined)[], markDirty = true) {
    if (!node && !edges) throw new Error('onRemove: need node or edges');
    const raw = edges ? edges : this.opts.getEdges(node!, idx);
    //console.log('onAdd', idx, node);
    for (const e of raw) {
      if (typeof e !== 'string') continue;
      const isWeak = Path.hasFlag(e, 'weak');
      const edge = Path.stripFlags(e);
      const cache = isWeak ? this.usedWeak : this.usedBy;
      let s = cache.get(edge);
      if (s === undefined) {
        s = new Set();
        cache.set(edge, s);
      }
      s.add(idx);
    }
    this.invalidateEdgeCaches(idx);
    if (!markDirty) return;
    const src = Path.decode(idx).path as number[];
    for (const e of raw) {
      if (typeof e !== 'string') continue;
      const base = Path.stripFlags(e);
      if (Path.cmp(idx, base) > -1) continue;
      const dst = Path.decode(base).path as number[];
      let i = 0;
      const n = Math.min(src.length, dst.length);
      while (i < n && src[i] === dst[i]) i++;
      this.dirtyScopes.add(Path.encode(src.slice(0, i)));
    }
  }
  private onRemove(idx: string, node?: TreeNode<T>, edges?: (string | undefined)[]) {
    if (!node && !edges) throw new Error('onRemove: need node or edges');
    const raw = edges ? edges : this.opts.getEdges(node!, idx);
    for (const e of raw) {
      if (typeof e !== 'string') continue;
      const isWeak = Path.hasFlag(e, 'weak');
      const edge = Path.stripFlags(e);
      const cache = isWeak ? this.usedWeak : this.usedBy;
      const s = cache.get(edge);
      if (s !== undefined) s.delete(idx);
    }
    this.invalidateEdgeCaches(idx);
  }
  // /Cache hooks
  add(node: TreeNode<T>, parent?: string): string {
    const path = Path.decode(parent ? parent : this.stack[this.stack.length - 1]).path;
    const sg = this.getPath(path, true);
    if (!this.isSubgraph(sg)) throw new Error('add: current path is not a subgraph');
    //if (node.opts) node.opts.stableId = this.stableId++;
    //    const idx = Path.encode([...path, sg.nodes.push(Object.freeze(node)) - 1]);
    const idx = Path.encode([...path, sg.nodes.push(node) - 1]);
    this.onAdd(idx, node);
    return idx;
  }
  set(idx: string, node: TreeNode<T>): void {
    const oldNode = this.get(idx);
    this.onRemove(idx, oldNode);
    this.onAdd(idx, node);
    if (!idx) {
      Object.assign(this.root, node);
      return;
    }
    const { parent: parentIdx, current } = Path.parent(idx);
    const parent = this.get(parentIdx);
    if (!this.isSubgraph(parent)) throw new Error('set: parent is not a subgraph');
    parent.nodes[current] = node;
  }
  remove(idx: string): void {
    const { parent: parentIdx, current } = Path.parent(idx);
    const parent = this.get(parentIdx);
    if (!this.isSubgraph(parent)) throw new Error('set: parent is not a subgraph');
    const node = this.get(idx);
    this.onRemove(idx, node);
    this.usedBy.delete(idx);
    this.usedWeak.delete(idx);
    parent.nodes[current] = undefined;
    // remove usedBy?
    // remove from edges?
  }
  clone() {
    const res = new TreeDAG<T>(deepClone(this.root), this.opts);
    res.usedBy = deepClone(this.usedBy);
    res.usedWeak = deepClone(this.usedWeak);
    return res;
  }
  // Iterate from optional start token (absolute). Default = root.
  // Calls cb once per visited node. While in cb:
  //  - if node is subgraph: stack == node's path (add -> inside it)
  //  - else (leaf):         stack == parent path (add -> siblings)
  iter(cb: (node: TreeNode<T>, idx: string) => true | void, idx?: string, recursive = true): void {
    const walk = (node: TreeNode<T>, path: number[]) => {
      const curPath = Path.encode(path);
      const ret = cb(node, curPath);
      if (!ret && recursive && this.isSubgraph(node)) {
        const arr = node.nodes;
        const L = arr.length; // snapshot
        this.scope(curPath, () => {
          for (let i = 0; i < L; i++) {
            const child = arr[i];
            if (!child) continue;
            path.push(i); // mutate
            walk(child, path); // reuse
            path.pop(); // undo
          }
        });
      }
    };
    this.scope(idx ? Path.parent(idx).parent : '', () => {
      const startPath = idx ? Path.decode(idx).path : [];
      const start = this.getPath(startPath, /*allowRoot=*/ true);
      // NOTE: walk mutates 'path', so pass the same instance
      const pathBuf = startPath.slice(0);
      walk(start, pathBuf);
    });
  }
  format(cb?: (node: TreeNode<T>, idx: string) => boolean) {
    if (!this.opts.formatNode) throw new Error('no formatNode');
    let res = '';
    this.iter((node, token) => {
      if (cb && !cb(node, token)) return;
      res += `${token}: ${this.opts.formatNode!(node)}\n`;
    });
    return res;
  }
  getEdges(idx: string, recursive = true, includeWeak = true): Set<string> {
    if (!recursive) {
      const cache = this.cache.edges;
      let merged = cache.get(idx);
      if (!merged) {
        const node = this.get(idx);
        const raw = this.opts.getEdges(node, idx);
        // collapse weak/strong on the same base id (prefer strong)
        const byBase: Map<string, number> = new Map(); // 0: none, 1: weak only, 2: strong
        for (let i = 0; i < raw.length; i++) {
          const e = raw[i];
          if (typeof e !== 'string') continue;
          const base = Path.stripFlags(e);
          const isWeak = Path.hasFlag(e, 'weak') ? 1 : 2;
          const prev = byBase.get(base) || 0;
          if (isWeak > prev) byBase.set(base, isWeak); // keep strongest
        }
        // reconstruct tokens deterministically
        const toks: string[] = [];
        for (const [base, strength] of byBase)
          toks.push(strength === 1 ? Path.addFlags(base, Path.bs.maskOf('weak')) : base);
        toks.sort((a, b) => Path.cmp(a, b));
        merged = new Set<string>(toks);
        cache.set(idx, merged);
      }
      if (!includeWeak) {
        const strongOnly = new Set<string>();
        for (const tok of merged) if (!Path.hasFlag(tok, 'weak')) strongOnly.add(tok);
        return strongOnly;
      }
      return merged;
    } else {
      // const cache = this.cache.edgesRec;
      let merged = undefined; //cache.get(idx);
      if (merged === undefined) {
        const res: Set<string> = new Set();
        this.iter(
          (node: TreeNode<T>, idx2) => {
            const raw = this.opts.getEdges(node, idx2);
            for (let k = 0; k < raw.length; k++) {
              const t = raw[k];
              if (typeof t === 'string') res.add(t);
            }
          },
          idx,
          /*recursive=*/ true
        );
        const mergedTmp = Path.merge(...res);
        merged = new Set(Array.from(mergedTmp).sort((a, b) => Path.cmp(a, b)));
        // cache.set(idx, merged); // keep caching single-level; recursive stays computed on demand
      }
      if (!includeWeak) {
        const strongOnly = new Set<string>();
        for (const tok of merged) if (!Path.hasFlag(tok, 'weak')) strongOnly.add(tok);
        return strongOnly;
      }
      return merged;
    }
  }
  getFlags(idx: string, recursive = true) {
    const res: Set<string> = new Set();
    this.iter(
      (node: TreeNode<T>) => {
        const raw = this.opts.getFlags(node);
        for (const t of raw) if (typeof t === 'string') res.add(t);
      },
      idx,
      recursive
    );
    this.cache.flags.set(idx, res);
    return res;
  }
  getChildrens(idx: string, recursive = true) {
    const res: Set<string> = new Set();
    this.iter(
      (_, nodeIdx) => {
        if (nodeIdx !== idx) res.add(nodeIdx);
      },
      idx,
      recursive
    );
    return res;
  }
  checkUsed() {
    // we always check whole graph, same way as 'remoUnused' and 'toposort' work on whole thing.
    const usedBy: Map<string, Set<string>> = new Map();
    const usedWeak: Map<string, Set<string>> = new Map();
    this.iter((node, idx) => {
      const edges = this.opts.getEdges(node, idx);
      for (const e of edges) {
        if (e === undefined) continue;
        const used = Path.hasFlag(e, 'weak') ? usedWeak : usedBy;
        const edge = Path.stripFlags(e);
        let cur = used.get(edge);
        if (cur === undefined) {
          cur = new Set();
          used.set(edge, cur);
        }
        cur.add(idx);
      }
    });
    for (const [k, s] of this.usedBy) if (s.size === 0) this.usedBy.delete(k);
    for (const [k, s] of this.usedWeak) if (s.size === 0) this.usedWeak.delete(k);
  }
  check() {
    //return
    // we always check whole graph, same way as 'remoUnused' and 'toposort' work on whole thing.
    const map = new Map();
    this.iter((node, idx) => {
      if (map.get(node)) {
        // weird thing will happen if we re-use object
        throw new Error(`TreeDAG.check: re-used node object at ${idx} and ${map.get(node)}`);
      }
      map.set(node, idx);
      if (this.isSubgraph(node)) {
        for (let i = 0; i < node.nodes.length; i++) {
          if (node.nodes[i] === undefined) continue;
        }
      }
      const { path: nodePath } = idx ? Path.decode(idx) : { path: [] };
      // look at edges non-recursively, since we already do check everything recursively
      for (const e of this.getEdges(idx, false, true)) {
        // same node edges also disallowed. ensures acyclicity
        if (Path.cmp(idx, e) < 1) {
          //          console.log('S', this.format());
          throw new Error(`TreeDAG.check: wrong edge=${e} at ${idx}`);
        }
        this.get(e); // will throw on non-existent path
        const { path: edgePath } = Path.decode(e);
        if (edgePath.length > nodePath.length)
          throw new Error(`TreeDAG.check edge(${e}) to child from ${idx}`);
      }
    });
    if (this.debug) this.checkUsed();
  }
  getUsedBy(idx?: string, recursive = false): Map<string, Set<string>> {
    if (idx === undefined && !recursive) {
      for (let i = this.stack.length - 1; i >= 0; i--) {
        const cur = this.stack[i];
        if (!cur) continue;
        const node = this.get(cur);
        if (this.isSubgraph(node) && (node as any).kind === 'function') {
          idx = cur;
          break;
        }
      }
      if (idx === undefined) return this.usedBy;
    }
    // Fallback (non-empty only)
    const res = new Map<string, Set<string>>();
    this.iter((_node, id) => {
      if (id === '') return;
      for (const e of this.getEdges(id, recursive, false)) {
        let s = res.get(e);
        if (s === undefined) {
          s = new Set<string>();
          res.set(e, s);
        }
        s.add(id);
      }
    }, idx);
    return res;
  }
  removeUnused() {
    const removed: Set<string> = new Set();
    const toFix: Set<string> = new Set();
    // TODO: queue: currently does multiple ops instead one!
    return retryIfChanged(() => {
      const nodes: string[] = [];
      this.iter((_node, id) => {
        if (id) nodes.push(id);
      });
      let changed = false;
      for (const idx of nodes) {
        const owners = this.usedBy.get(idx);
        if (!idx) continue; // cannot remove root!
        if (removed.has(idx)) continue; // already removed
        if (owners && owners.size) {
          //console.log(`cannot remove ${idx} because owners=${Array.from(owners)}`);
          continue;
        }
        const { parent: parentIdx } = Path.parent(idx);
        if (removed.has(parentIdx)) continue;
        const flags = this.getFlags(idx);
        const parent = !parentIdx ? this.root : this.get(parentIdx);
        const node = this.get(idx);
        if (this.opts.isUsed && this.opts.isUsed(parent, node, idx, flags)) {
          //console.log(`cannot remove ${idx} because isUsed`);
          continue;
        }
        const a = this.usedBy.get(idx);
        if (a) for (const k of a) toFix.add(k);
        const b = this.usedWeak.get(idx);
        if (b) for (const k of b) toFix.add(k);
        this.remove(idx);
        removed.add(idx);
        changed = true;
        //console.log('REMOVED', idx, owners);
      }
      if (!changed && removed.size && toFix.size) {
        for (let idx of toFix) this.opts.mapEdges(this, this.get(idx), EMPTY_MAP, true);
      }
      return changed;
    });
  }
  applyMappingSingle(elm: string, mapping: TreeMapping, partial = false) {
    const m = mapping.get(Path.stripFlags(elm as any));
    if (Array.isArray(m)) throw new Error('Cannot apply multiple mappings to same element');
    if (m === undefined) {
      if (partial) return elm; // not changed
      throw new Error(`applyMapping: single element doesn't exists elm=${elm} m=${m}`);
    }
    return Path.addFlagsFrom(m, elm);
  }
  applyMapping(elm: string[], mapping: TreeMapping, partial = false): string[] {
    if (!Array.isArray(elm)) throw new Error('applyMapping: require array');
    const res: string[] = [];
    for (let ix = 0; ix < elm.length; ix++) {
      const i = elm[ix];
      const d = Path.decode(i);
      const base = Path.stripFlags(i);
      const mask = d.mask;
      const isWeak = Path.hasFlag(i, 'weak');

      let m = mapping.get(base);
      if (m === undefined) {
        if (partial) {
          if (isWeak) {
            const n = this.getPath(d.path, false, true);
            if (n === undefined) continue;
          }
          res.push(i);
          continue;
        }
        if (isWeak) continue;
        throw new Error(`applyMapping (array): element doesn't exists in mapping: ${i}`);
      }
      if (!Array.isArray(m)) {
        res.push(Path.addFlags(m as string, mask));
        continue;
      }
      const mm = m as string[];
      for (let t = 0; t < mm.length; t++) res.push(Path.addFlags(mm[t], mask));
    }
    return res;
  }
  mapEdges(mapping: TreeMapping, partial = true, markDirty = true) {
    const affected = new Set<string>();
    const realKeys: string[] = [];
    for (const from of mapping.keys()) {
      const to = mapping.get(from) as string;
      if (typeof to !== 'string') throw new Error('wrong mapping');
      if (to !== from) realKeys.push(from);
    }
    const inv: Map<string, string> = new Map();
    for (const from of realKeys) inv.set(mapping.get(from) as string, from);
    const addUsers = (bag?: Set<string>) => {
      if (!bag) return;
      for (const u of bag) {
        const mu = mapping.get(u);
        affected.add(mu === undefined ? u : mu);
      }
    };
    for (const k of realKeys) {
      addUsers(this.usedBy.get(k));
      addUsers(this.usedWeak.get(k));
      const cur = mapping.get(k) as string;
      affected.add(cur);
      affected.add(Path.parent(cur).parent);
    }
    type Op = {
      oldUser: string;
      curIdx: string;
      prev: (string | undefined)[];
      next: (string | undefined)[];
    };
    const ops: Op[] = [];
    for (const idx of affected) {
      const node = this.get(idx);
      // detect renumber – we must move memberships even if edges are same
      const oldUser = inv.get(idx) || idx;
      // snapshot before mutation
      const prevEdges = this.opts.getEdges(node, idx);
      // ALWAYS mutate (parents/side-effects/outputs)
      this.opts.mapEdges(this, node, mapping, partial);
      // snapshot after mutation
      const nextEdges = this.opts.getEdges(node, idx);
      // cheap equality check (early exit)
      let changed = prevEdges.length !== nextEdges.length;
      for (let i = 0; !changed && i < prevEdges.length; i++) {
        if (prevEdges[i] !== nextEdges[i]) changed = true;
      }
      // enqueue membership move only if edges changed OR id renumbered
      if (changed || oldUser !== idx) {
        ops.push({ oldUser, curIdx: idx, prev: prevEdges, next: nextEdges });
      }
      if (this.debug) {
        const edgesNow = this.getEdges(idx, /*recursive=*/ false, /*includeWeak=*/ true);
        if (edgesNow.has(idx)) throw new Error('mapEdges: node maps to itself');
      }
    }
    // two-phase apply (only for changed nodes)
    for (let i = 0; i < ops.length; i++) {
      const o = ops[i];
      this.onRemove(o.oldUser, undefined, o.prev);
    }
    for (let i = 0; i < ops.length; i++) {
      const o = ops[i];
      this.onAdd(o.curIdx, undefined, o.next, markDirty);
    }
    return mapping;
  }

  // toposort edge cache (single-pass over subtree, then merge+sort per child)
  private edgeCache(node: TreeNode<T>, idx: string) {
    if (!this.isSubgraph(node)) return;
    const parentPath = idx ? Path.decode(idx).path : [];
    // collect raw edges per top child (no merge/sort yet)
    const rawByTop: Map<number, Set<string>> = new Map();
    const walk = (n: TreeNode<T>, path: number[], top: number) => {
      const curPath = Path.encode(path);
      // collect this node's own edges (non-recursive)
      const raw = this.opts.getEdges(n, curPath);
      for (let k = 0; k < raw.length; k++) {
        const e = raw[k];
        if (typeof e !== 'string') continue;
        const p = Path.parent(e);
        if (p.parent !== idx) continue;
        const edgeIdx = p.current;
        if (node.nodes[edgeIdx] === undefined) {
          if (Path.hasFlag(e, 'weak')) continue;
          throw new Error('removed child idx=' + idx + ' child=' + e + ' flags=' + p.mask);
        }
        let cur = rawByTop.get(top);
        if (cur === undefined) {
          cur = new Set<string>();
          rawByTop.set(top, cur);
        }
        cur.add(e);
      }
      // recurse
      if (!this.isSubgraph(n)) return;
      const arr = n.nodes;
      for (let i = 0; i < arr.length; i++) {
        const child = arr[i];
        if (!child) continue;
        const newTop = path.length === parentPath.length ? i : top;
        path.push(i);
        walk(child, path, newTop);
        path.pop();
      }
    };
    // seed from each present top-level child
    for (let i = 0; i < node.nodes.length; i++) {
      const child = node.nodes[i];
      if (!child) continue;
      const path = parentPath.slice(0);
      path.push(i);
      walk(child, path, i);
    }
    // finalize: merge flags and sort per child to match getEdges(..., true)
    const res: Map<number, Set<string>> = new Map();
    for (let i = 0; i < node.nodes.length; i++) {
      if (node.nodes[i] === undefined) continue;
      const bucket = rawByTop.get(i);
      if (!bucket) {
        res.set(i, new Set<string>()); // stable: keep key with empty set
        continue;
      }
      const merged = Path.merge(...bucket); // collapse weak/strong variants
      const sorted = Array.from(merged).sort((a, b) => Path.cmp(a, b));
      res.set(i, new Set<string>(sorted)); // preserve deterministic iteration
    }
    return res;
  }

  tiers(node: TreeNode<T>, idx: string) {
    if (!this.isSubgraph(node)) return;
    const left: Set<number> = new Set();
    const processed: Set<number> = new Set();
    const tiers = [];
    let curTier = [];
    const adj = this.edgeCache(node, idx)!;
    for (let i = 0; i < node.nodes.length; i++) if (adj.has(i)) left.add(i);

    for (;;) {
      main: for (const cur of left) {
        for (const edge of adj.get(cur)!) {
          const { current: edgeIdx } = Path.parent(edge);
          // tricky part here: we don't check for current tier and assume it is unprocessed
          // otherwise (if we add cur to processed list right away, then tiers would be incorrect)
          if (processed.has(edgeIdx)) continue;
          continue main;
        }
        curTier.push(cur); // all edges are fine
      }
      if (!curTier.length) {
        if (left.size) throw new Error('tiers: loop detected');
        break;
      }
      tiers.push(curTier);
      for (const i of curTier) {
        processed.add(i);
        left.delete(i);
      }
      curTier = [];
    }
    return tiers;
  }
  private revEdgeCache(node: TreeNode<T>, idx: string) {
    if (!this.isSubgraph(node)) return;
    const adj = this.edgeCache(node, idx)!; // reuse your cache (once)
    const rev: Map<number, number[]> = new Map();
    for (let i = 0; i < node.nodes.length; i++) rev.set(i, []); // keep indices stable
    for (const [cur, es] of adj) {
      for (const e of es) rev.get(Path.parent(e).current)!.push(cur);
    }
    // optional determinism
    for (const [_k, v] of rev) v.sort((a, b) => a - b);
    return { adj, rev };
  }
  toposort(idx?: string, type: 'tiers' | 'alap' | 'default' = 'default', verify = true) {
    if (this.debug) this.checkUsed();
    // console.log('USED BY (BEFORE)', this.usedBy);
    this.iter((node, idx) => {
      if (!this.isSubgraph(node)) return;
      const { path: parentPath } = idx ? Path.decode(idx) : { path: [] };
      // rev true: ripemd160 wasm: 193 -> 290
      const mapping: TreeMapping = new Map();
      const newNodes = [];
      const q: number[] = [];
      for (let i = 0; i < node.nodes.length; i++) q.push(i);
      q.reverse(); // improves stability of ordering
      const requeued = new Set();
      if (type === 'tiers') {
        const tiers = this.tiers(node, idx)!;
        // console.log(
        //   'tiers',
        //   tiers.map((i) => i.length)
        // );
        for (const cur of tiers.flat()) {
          const curPath = Path.encode([...parentPath, cur]);
          const curNode = node.nodes[cur];
          mapping.set(curPath, Path.encode([...parentPath, newNodes.push(curNode) - 1]));
        }
      } else if (type === 'alap') {
        const { adj, rev } = this.revEdgeCache(node, idx)!;
        const N = node.nodes.length;
        const placed = new Uint8Array(N);
        // sinks: nodes with no users inside this subgraph
        const st: number[] = [];
        for (let i = 0; i < N; i++) {
          if (node.nodes[i] === undefined) continue;
          if (rev.get(i)!.length === 0) st.push(i);
        }
        // if no explicit sinks, fall back to all present (still correct)
        if (!st.length) for (let i = 0; i < N; i++) if (node.nodes[i] !== undefined) st.push(i);
        const seenPair = new Set<string>(); // LIFO-only livelock guard
        while (st.length) {
          const cur = st.pop()!;
          if (placed[cur]) continue;
          const curNode = node.nodes[cur];
          if (curNode === undefined) continue;

          // check unmet dependency (first one wins for DFS-ish shape)
          let unmet = -1;
          for (const e of adj.get(cur)!) {
            const dep = Path.parent(e).current;
            if (!placed[dep]) {
              unmet = dep;
              break;
            }
          }
          if (unmet >= 0) {
            const key = `${cur}-${unmet}`;
            if (seenPair.has(key)) throw new Error('toposort: loop detected (LIFO)');
            seenPair.add(key);
            // process dependency next, then come back to cur
            st.push(cur, unmet);
            continue;
          }
          placed[cur] = 1;
          const oldPath = Path.encode([...parentPath, cur]);
          const newPath = Path.encode([...parentPath, newNodes.push(curNode) - 1]);
          mapping.set(oldPath, newPath);
        }
      } else {
        const adj = this.edgeCache(node, idx)!;
        main: while (q.length) {
          const cur = q.pop()!;
          const curNode = node.nodes[cur];
          if (curNode === undefined) continue; // skip deleted nodes
          const curPath = Path.encode([...parentPath, cur]);
          if (mapping.has(curPath)) continue;
          for (const edge of adj.get(cur)!) {
            if (mapping.has(Path.stripFlags(edge))) continue; // already processed
            const { current: edgeIdx } = Path.parent(edge);
            const pair = `${cur}-${edgeIdx}`;
            if (requeued.has(pair)) {
              // If same edge causes reprocessing same node more than once, we have a loop
              // works for lifo, what about fifo?
              console.log('toposort/PAIR', pair);
              throw new Error('toposort: loop detected');
            }
            requeued.add(pair);
            // process edge and then current again
            // NOTE: in revOrder we don't need to push edge, it will be processed before we get to it
            q.push(cur, edgeIdx);
            continue main;
          }
          mapping.set(curPath, Path.encode([...parentPath, newNodes.push(curNode) - 1]));
        }
        if (newNodes.length > node.nodes.length) {
          throw new Error(
            `toposort: something broken. new nodes=${newNodes.length} old nodes=${node.nodes.length}`
          );
        }
      }
      const childMapping: TreeMapping = new Map();
      // Before we set nodes, we need to collect/construct child mappings from old nodes
      for (const [k, v] of mapping) {
        const childrens = this.getChildrens(k);
        for (const c of childrens) {
          childMapping.set(c, Path.mapParent(k, v, c));
        }
      }
      for (const [k, v] of childMapping) mapping.set(k, v);
      node.nodes = newNodes;
      this.mapEdges(mapping, true, verify); // we need to apply mappings here, since next iteration may try to access re-mapped nodes
      //console.log('X', mapping);
    }, idx);
    //    console.log('USED BY (AFTER)', this.usedBy);
    if (this.debug) this.checkUsed();
    // We do this at the end only, since otherwise there would be not-changed parts
    if (verify) this.check();
  }
  cleanup() {
    this.removeUnused();
    while (this.dirtyScopes.size) {
      let cur = '';
      for (const s of this.dirtyScopes)
        if (!cur || Path.decode(s).path.length < Path.decode(cur).path.length) cur = s;
      this.dirtyScopes.delete(cur);
      const path = Path.decode(cur).path as number[];
      let n: TreeNode<T> | undefined = this.root;
      let ok = true;
      for (let i = 0; i < path.length; i++) {
        if (!n || !this.isSubgraph(n)) {
          ok = false;
          break;
        }
        n = n.nodes[path[i]];
        if (!n) {
          ok = false;
          break;
        }
      }
      if (!ok || !n) continue;
      if (!this.isSubgraph(n)) continue;
      this.toposort(cur, 'default', false);
    }
    this.check();
  }
  // we take multiple rewrites, then apply one by one, if anything changed we re-do all steps.
  // also we cleanup graph after each rewrite.
  rewrite(cbs: Record<string, Rewrite<T>>, root?: string, _debug = false, check?: () => void) {
    return retryIfChanged(() => {
      let changed = true;
      while (changed) {
        for (const k in cbs) {
          const res = retryIfChanged(() => {
            let changed = false;
            if (this.debug) {
              console.error('rewrite/RETRY', k);
              console.error('rewrite/BEFORE REWRITE', k, this.format());
            }
            this.iter((node, idx) => {
              const prevEdges = this.opts.getEdges(node, idx);
              const res = cbs[k](node, idx);
              if (res === undefined) {
                return;
              }
              if (typeof res !== 'string') throw new Error(`rewrite: wrong replace idx=${res}`);
              changed = true;
              //console.log('rewrite/ewritten', idx, '->', res);
              if (res === idx) {
                this.onRemove(idx, undefined, prevEdges);
                this.onAdd(idx, this.get(idx));
                return; // same node, but changed
              }
              const newNode = this.get(res);
              if (this.isSubgraph(newNode) || this.isSubgraph(node))
                throw new Error('rewrite: replace by subgraph not supported');
              this.mapEdges(new Map([[idx, res]])); // in case somebody used that node before (if we returning existing node)
              this.remove(idx);
            }, root);
            if (changed) {
              if (this.debug) {
                console.log('rewrite/AFTER REWRITE (before clean)', k, this.format());
              }
              this.cleanup();
              if (this.debug) {
                console.log('rewrite/AFTER REWRITE', k, this.format());
              }
              if (check) {
                this.checkUsed();
                check();
              }
            }

            return changed;
          });
          changed = res;
          if (this.debug) {
            console.log('rewrite/op', k, changed);
          }
        }
      }
      this.cleanup();
      return false;
    });
  }
}

// Misc
export function splitU64(n: number) {
  let l = n | 0;
  let h = (n / 0x100000000) | 0;
  return { l, h };
}

export function swapEndianness(v: DataView, is64: boolean) {
  if (is64) {
    for (let i = 0; i < v.byteLength; i += 8) {
      const h = v.getUint32(i, false);
      const l = v.getUint32(i + 4, false);
      v.setUint32(i, l, true);
      v.setUint32(i + 4, h, true);
    }
  } else {
    for (let i = 0; i < v.byteLength; i += 4) {
      v.setUint32(i, v.getUint32(i, false), true);
    }
  }
}

export const gcd = (a: number, b: number): number => {
  a = Math.abs(a);
  b = Math.abs(b);
  while (b !== 0) {
    const t = b;
    b = a % b;
    a = t;
  }
  return a;
};

export const lcm = (a: number, b: number): number =>
  a === 0 || b === 0 ? 0 : Math.abs((a / gcd(a, b)) * b);

// n-ary (empty: gcd=0, lcm=1 by convention)
export const gcdAll = (xs: readonly number[]): number => xs.reduce((a, b) => gcd(a, b), 0);

export const lcmAll = (xs: readonly number[]): number => xs.reduce((a, b) => lcm(a, b), 1);

// Generic arrays interleave/deinterleave
export function interleave<T>(...xs: readonly (readonly T[])[]): T[] {
  const k = xs.length;
  if (!k) return [];
  const n = xs[0].length;
  for (let i = 1; i < k; i++) if (xs[i].length !== n) throw new Error('length mismatch');
  const out = new Array<T>(n * k);
  for (let i = 0, p = 0; i < n; i++) for (let j = 0; j < k; j++) out[p++] = xs[j][i];
  return out;
}
// [a0,b0,c0,a1,b1,c1,...] -> [[a0,a1,...],[b0,b1,...],[c0,c1,...]]
export function deinterleave<T>(arr: readonly T[], k: number): T[][] {
  if (k <= 0 || arr.length % k !== 0) throw new Error('bad stride');
  const n = (arr.length / k) | 0;
  const out = Array.from({ length: k }, () => new Array<T>(n));
  for (let i = 0, p = 0; i < n; i++) for (let j = 0; j < k; j++) out[j][i] = arr[p++];
  return out;
}

export function concatBytes(...arrays: Uint8Array[]): Uint8Array {
  let sum = 0;
  for (let i = 0; i < arrays.length; i++) {
    const a = arrays[i];
    sum += a.length;
  }
  const res = new Uint8Array(sum);
  for (let i = 0, pad = 0; i < arrays.length; i++) {
    const a = arrays[i];
    res.set(a, pad);
    pad += a.length;
  }
  return res;
}

/** Checks if something is Uint8Array. Be careful: nodejs Buffer will return true. */
export function isBytes(a: unknown): a is Uint8Array {
  return a instanceof Uint8Array || (ArrayBuffer.isView(a) && a.constructor.name === 'Uint8Array');
}

export const poisonProp = (obj: any, key: string) => {
  Object.defineProperty(obj, key, {
    configurable: true,
    enumerable: false,
    get() {
      let name = obj && obj.name ? obj.name : '<type>';
      let e = new Error('Accessed deprecated .' + key + ' on ' + name);
      throw new Error(e.message + '\n' + e.stack);
    },
    set(v) {
      let name = obj && obj.name ? obj.name : '<type>';
      let e = new Error('Wrote deprecated .' + key + '=' + v + ' on ' + name);
      throw new Error(e.message + '\n' + e.stack);
    },
  });
};
