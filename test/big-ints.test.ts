import { describe, should } from '@paulmillr/jsbt/test.js';
import * as P from 'micro-packed';
import { deepStrictEqual } from 'node:assert';
import { Module, array } from '../src/module.ts';
import { toRuntime } from '../src/runtime.ts';
import { runtimeTypeMod, testBothOpts } from './utils.ts';

describe('BigInt', () => {
  const BIG_OPTS = { noRuntime: true, lowerU64: true };
  const BIG_SIMD_OPTS = { noRuntime: true, lowerU64: true, optimize: false };
  should('u128 conversions', () => {
    const m = new Module('bigInt128');
    m.fn(
      'u128_from_u32_parts',
      ['u32', 'u32', 'u32', 'u32'],
      ['u32', 'u32', 'u32', 'u32'],
      (f, a, b, c, d) => {
        const v = f.types.u128.fromN('u32', [a, b, c, d]);
        return f.types.u128.to('u32', v);
      }
    );
    m.fn('u128_from_u32', ['u32'], ['u32', 'u32', 'u32', 'u32'], (f, a) => {
      const v = f.types.u128.fromN('u32', a);
      return f.types.u128.to('u32', v);
    });
    m.fn(
      'u128_from_u64_parts',
      ['u32', 'u32', 'u32', 'u32'],
      ['u32', 'u32', 'u32', 'u32'],
      (f, lo0, lo1, hi0, hi1) => {
        const lo = f.types.u64.fromN('u32', [lo0, lo1]);
        const hi = f.types.u64.fromN('u32', [hi0, hi1]);
        const v = f.types.u128.fromN('u64', [lo, hi]);
        return f.types.u128.to('u32', v);
      }
    );
    testBothOpts(m, BIG_SIMD_OPTS, (mod) => {
      const u32s = (v: number[]) => v.map((x) => x >>> 0);
      deepStrictEqual(u32s(mod.u128_from_u32_parts(1, 2, 3, 4)), [1, 2, 3, 4]);
      deepStrictEqual(u32s(mod.u128_from_u32(0x1122_3344)), [0x1122_3344, 0, 0, 0]);
      deepStrictEqual(
        u32s(mod.u128_from_u64_parts(0xaaaabbbb, 0xccccdddd, 0x11112222, 0x33334444)),
        [0xaaaabbbb, 0xccccdddd, 0x11112222, 0x33334444]
      );
    });
  });

  should('i128 sign extension', () => {
    const m = new Module('bigInt128Signed');
    m.fn('i128_from_i32', ['i32'], ['i32', 'i32', 'i32', 'i32'], (f, a) => {
      const v = f.types.i128.fromN('i32', a);
      return f.types.i128.to('i32', v);
    });
    m.fn('i128_from_i64', ['i32', 'i32'], ['i32', 'i32', 'i32', 'i32'], (f, lo, hi) => {
      const v64 = f.types.i64.fromN('i32', [lo, hi]);
      const v = f.types.i128.fromN('i64', v64);
      return f.types.i128.to('i32', v);
    });
    testBothOpts(m, BIG_OPTS, (mod) => {
      const u32 = (v: number) => v >>> 0;
      deepStrictEqual(
        mod.i128_from_i32(-2).map(u32),
        [0xffff_fffe, 0xffff_ffff, 0xffff_ffff, 0xffff_ffff]
      );
      deepStrictEqual(
        mod.i128_from_i64(0xffff_fffe, 0xffff_ffff).map(u32),
        [0xffff_fffe, 0xffff_ffff, 0xffff_ffff, 0xffff_ffff]
      );
    });
  });

  should('u256 conversions', () => {
    const m = new Module('bigInt256');
    m.fn(
      'u256_from_u32_parts',
      ['u32', 'u32', 'u32', 'u32', 'u32', 'u32', 'u32', 'u32'],
      ['u32', 'u32', 'u32', 'u32', 'u32', 'u32', 'u32', 'u32'],
      (f, a0, a1, a2, a3, a4, a5, a6, a7) => {
        const v = f.types.u256.fromN('u32', [a0, a1, a2, a3, a4, a5, a6, a7]);
        return f.types.u256.to('u32', v);
      }
    );
    m.fn(
      'u256_from_u64',
      ['u32', 'u32'],
      ['u32', 'u32', 'u32', 'u32', 'u32', 'u32', 'u32', 'u32'],
      (f, lo, hi) => {
        const v64 = f.types.u64.fromN('u32', [lo, hi]);
        const v = f.types.u256.fromN('u64', v64);
        return f.types.u256.to('u32', v);
      }
    );
    testBothOpts(m, BIG_OPTS, (mod) => {
      const u32s = (v: number[]) => v.map((x) => x >>> 0);
      deepStrictEqual(
        u32s(mod.u256_from_u32_parts(1, 2, 3, 4, 5, 6, 7, 8)),
        [1, 2, 3, 4, 5, 6, 7, 8]
      );
      deepStrictEqual(
        u32s(mod.u256_from_u64(0x1234_5678, 0x9abc_def0)),
        [0x1234_5678, 0x9abc_def0, 0, 0, 0, 0, 0, 0]
      );
    });
  });

  should('u128 ops', () => {
    const m = new Module('bigInt128Ops');
    m.mem('out128', array('u128', {}, 1));
    m.mem('out128r', array('u128', {}, 1));
    m.fn('u128_add', [], 'void', (f) => {
      const a = f.types.u128.const(0x0000_0001_0000_0002_0000_0003_0000_0004n);
      const b = f.types.u128.const(0x0000_0001_0000_0000_ffff_ffff_ffff_ffffn);
      const c = f.types.u128.add(a, b);
      f.memory.out128[0].set(c);
      return [];
    });
    m.fn('u128_sub', [], 'void', (f) => {
      const a = f.types.u128.const(0x0000_0002_0000_0000_0000_0000_0000_0000n);
      const b = f.types.u128.const(0x0000_0001_0000_0000_0000_0000_0000_0001n);
      const c = f.types.u128.sub(a, b);
      f.memory.out128[0].set(c);
      return [];
    });
    m.fn('u128_mul', [], 'void', (f) => {
      const a = f.types.u128.const(0x0000_0000_0000_0000_0000_0000_0000_0003n);
      const b = f.types.u128.const(0x0000_0000_0000_0000_0000_0000_0000_0007n);
      const c = f.types.u128.mul(a, b);
      f.memory.out128[0].set(c);
      return [];
    });
    m.fn('u128_divrem', [], 'void', (f) => {
      const a = f.types.u128.const(100n);
      const b = f.types.u128.const(9n);
      const q = f.types.u128.div(a, b);
      const r = f.types.u128.rem(a, b);
      f.memory.out128[0].set(q);
      f.memory.out128r[0].set(r);
      return [];
    });
    m.fn('u128_bitwise', [], 'void', (f) => {
      const a = f.types.u128.const(0xaaaa_5555n);
      const b = f.types.u128.const(0xffff_0000n);
      const c = f.types.u128.xor(f.types.u128.and(a, b), f.types.u128.or(a, b));
      f.memory.out128[0].set(c);
      return [];
    });
    const shiftMask = (1n << 128n) - 1n;
    const shiftVal = 0x1122_3344_5566_7788_99aa_bbcc_ddee_ff00n;
    const shiftAmt = 65n;
    const shiftExpected = ((shiftVal << shiftAmt) & shiftMask) >> shiftAmt;
    m.fn('u128_shift', [], 'void', (f) => {
      const a = f.types.u128.const(shiftVal);
      const s = f.types.u128.const(shiftAmt);
      const c = f.types.u128.shl(a, s);
      const d = f.types.u128.shr(c, s);
      f.memory.out128[0].set(d);
      return [];
    });
    m.fn('u128_rot', [], 'void', (f) => {
      const a = f.types.u128.const(0x1122_3344_5566_7788_99aa_bbcc_ddee_ff00n);
      const s = f.types.u128.const(17n);
      const c = f.types.u128.rotl(a, s);
      const d = f.types.u128.rotr(c, s);
      f.memory.out128[0].set(d);
      return [];
    });
    m.fn('u128_cmp', [], 'void', (f) => {
      const a = f.types.u128.const(0x0102_0304_0506_0708_090a_0b0c_0d0e_0f10n);
      const b = f.types.u128.const(0x0102_0304_0506_0708_090a_0b0c_0d0e_0f10n);
      const eq = f.types.u128.eq(a, b);
      f.memory.out128[0].set(f.types.u128.fromN('u32', eq));
      return [];
    });
    testBothOpts(m, BIG_OPTS, (mod) => {
      const read128 = () => P.U128LE.decode(mod.segments.out128);
      const read128r = () => P.U128LE.decode(mod.segments.out128r);
      mod.u128_add();
      deepStrictEqual(read128(), 0x0000_0002_0000_0003_0000_0003_0000_0003n);

      mod.u128_sub();
      deepStrictEqual(read128(), 0x0000_0000_ffff_ffff_ffff_ffff_ffff_ffffn);

      mod.u128_mul();
      deepStrictEqual(read128(), 3n * 7n);

      mod.u128_divrem();
      deepStrictEqual(read128(), 11n);
      deepStrictEqual(read128r(), 1n);

      mod.u128_bitwise();
      deepStrictEqual(read128(), (0xaaaa_5555n & 0xffff_0000n) ^ (0xaaaa_5555n | 0xffff_0000n));

      mod.u128_shift();
      deepStrictEqual(read128(), shiftExpected);

      mod.u128_rot();
      deepStrictEqual(read128(), 0x1122_3344_5566_7788_99aa_bbcc_ddee_ff00n);

      mod.u128_cmp();
      deepStrictEqual(read128(), 1n);
    });
  });

  should('u128 batchFn lanes', () => {
    const m = new Module('bigIntBatch');
    m.mem('data', array('u128', {}, 8));
    m.batchFn('sum', { lanes: 4 }, ['u32', 'u32'], (f, lanes, pos, _perBatch, a, b) => {
      const T = f.getType('u128', lanes);
      const a128 = f.types.u128.fromN('u32', a);
      const b128 = f.types.u128.fromN('u32', b);
      if (lanes === 1) {
        const sum = f.types.u128.add(a128, b128);
        f.memory.data[pos].set(sum);
        return;
      }
      const sum = T.add(T.splat(a128), T.splat(b128));
      f.memory.data.lanes(lanes)[pos].set(sum);
    });
    testBothOpts(m, BIG_OPTS, (mod) => {
      mod.sum(0, 4, 0, 5, 7);
      const vals = P.array(8, P.U128LE).decode(mod.segments.data);
      deepStrictEqual(vals.slice(0, 4), [12n, 12n, 12n, 12n]);
      deepStrictEqual(vals.slice(4), [0n, 0n, 0n, 0n]);
    });
  });
  should('runtime batchFn scalar lanes still resolve scalar getType', () => {
    const m = new Module('bigIntBatchRuntimeLanes');
    m.mem('data', array('u64', {}, 8));
    m.batchFn('sum', { lanes: 4 }, ['u32', 'u32'], (f, lanes, pos, _perBatch, a, b) => {
      const T = f.getType('u64', lanes);
      f.memory.data[pos].set(T.add(T.fromN('u32', a), T.fromN('u32', b)));
    });
    const mod = toRuntime(() => runtimeTypeMod, m)();
    mod.sum(0, 4, 0, 5, 7);
    const vals = P.array(8, P.U64LE).decode(mod.segments.data);
    deepStrictEqual(vals.slice(0, 4), [12n, 12n, 12n, 12n]);
    deepStrictEqual(vals.slice(4), [0n, 0n, 0n, 0n]);
  });

  should('u256 ops', () => {
    const m = new Module('bigInt256Ops');
    m.mem('out256', array('u256', {}, 1));
    const u256Mask = (1n << 256n) - 1n;
    const addA = 0x0000_0001_0000_0000_0000_0000_0000_0000_0000_0000_0000_0000_0000_0000_0000_0000n;
    const addB = 0xffff_ffff_ffff_ffff_ffff_ffff_ffff_ffff_0000_0000_0000_0000_0000_0000_0000_0001n;
    const addExpected = (addA + addB) & u256Mask;
    const shiftVal =
      0x1111_1111_2222_2222_3333_3333_4444_4444_5555_5555_6666_6666_7777_7777_8888_8888n;
    const shiftAmt = 129n;
    const shiftExpected = ((shiftVal << shiftAmt) & u256Mask) >> shiftAmt;
    m.fn('u256_add', [], 'void', (f) => {
      const a = f.types.u256.const(addA);
      const b = f.types.u256.const(addB);
      const c = f.types.u256.add(a, b);
      f.memory.out256[0].set(c);
      return [];
    });
    m.fn('u256_shift', [], 'void', (f) => {
      const a = f.types.u256.const(shiftVal);
      const s = f.types.u256.const(shiftAmt);
      const c = f.types.u256.shl(a, s);
      const d = f.types.u256.shr(c, s);
      f.memory.out256[0].set(d);
      return [];
    });
    testBothOpts(m, BIG_OPTS, (mod) => {
      const read256 = () => P.U256LE.decode(mod.segments.out256);
      mod.u256_add();
      deepStrictEqual(read256(), addExpected);

      mod.u256_shift();
      deepStrictEqual(read256(), shiftExpected);
    });
  });
  should('literal scalar ops preserve every BigInt type', () => {
    const defs = [
      { type: 'i128', bits: 128, coder: P.I128LE, signed: true },
      { type: 'u128', bits: 128, coder: P.U128LE, signed: false },
      { type: 'i256', bits: 256, coder: P.I256LE, signed: true },
      { type: 'u256', bits: 256, coder: P.U256LE, signed: false },
    ] as const;
    const expected = (bits: number, signed: boolean, a: bigint, b: bigint) => {
      const cast = signed ? BigInt.asIntN : BigInt.asUintN;
      const val = (n: bigint) => cast(bits, n);
      const u = (n: bigint) => BigInt.asUintN(bits, n);
      const width = BigInt(bits);
      const shift = BigInt(bits + 5) & (width - 1n);
      const mask = (1n << width) - 1n;
      const av = val(a);
      const bv = val(b);
      return {
        values: [
          val(av + bv),
          val(av * bv),
          val(av - bv),
          val(av / bv),
          val(av % bv),
          val(u(av) & u(bv)),
          val(u(av) | u(bv)),
          val(u(av) ^ u(bv)),
          val(~u(av)),
          val(u(av) << shift),
          val(signed ? av >> shift : u(av) >> shift),
          val(((u(av) << shift) | (u(av) >> (width - shift))) & mask),
          val(((u(av) >> shift) | (u(av) << (width - shift))) & mask),
        ],
        flags: [
          +(av === av),
          +(av !== bv),
          +(av < bv),
          +(av > bv),
          +(av <= bv),
          +(av >= bv),
          +(av === 0n),
          1,
        ],
      };
    };
    const m = new Module('bigIntLiteralOps');
    const cases = defs.map(({ type, bits, coder, signed }) => {
      const width = BigInt(bits);
      const a = signed ? -(1n << (width - 2n)) + 0x12345n : (1n << width) - 0x12345n;
      const b = 97n;
      const { values, flags } = expected(bits, signed, a, b);
      const name = `out_${type}`;
      const cmp = `cmp_${type}`;
      m.mem(name, array(type, {}, values.length));
      m.mem(cmp, array('u32', {}, flags.length));
      m.fn(type, [], 'void', (f) => {
        const T = f.types[type] as any;
        const A = T.const(a);
        const B = T.const(b);
        const Z = T.const(0);
        const S = T.const(BigInt(bits + 5));
        const out = [
          T.add(A, B),
          T.mul(A, B),
          T.sub(A, B),
          T.div(A, B),
          T.rem(A, B),
          T.and(A, B),
          T.or(A, B),
          T.xor(A, B),
          T.not(A),
          T.shl(A, S),
          T.shr(A, S),
          T.rotl(A, S),
          T.rotr(A, S),
        ];
        for (let i = 0; i < out.length; i++) (f.memory as any)[name][i].set(out[i]);
        const masks = [
          T.eq(A, A),
          T.ne(A, B),
          T.lt(A, B),
          T.gt(A, B),
          T.le(A, B),
          T.ge(A, B),
          T.eqz(A),
          T.eqz(Z),
        ];
        for (let i = 0; i < masks.length; i++) (f.memory as any)[cmp][i].set(masks[i]);
        return [];
      });
      return { type, coder, name, cmp, values, flags };
    });
    testBothOpts(m, BIG_OPTS, (mod) => {
      for (const { type, coder, name, cmp, values, flags } of cases) {
        mod[type]();
        deepStrictEqual(P.array(values.length, coder).decode(mod.segments[name]), values);
        deepStrictEqual(P.array(flags.length, P.U32LE).decode(mod.segments[cmp]), flags);
      }
    });
  });
  should('dynamic scalar eqz preserves every BigInt type', () => {
    const defs = [
      { type: 'i128', bits: 128, coder: P.I128LE, signed: true },
      { type: 'u128', bits: 128, coder: P.U128LE, signed: false },
      { type: 'i256', bits: 256, coder: P.I256LE, signed: true },
      { type: 'u256', bits: 256, coder: P.U256LE, signed: false },
    ] as const;
    const m = new Module('bigIntDynamicEqz');
    for (const { type } of defs) {
      const input = `in_${type}`;
      const output = `eqz_${type}`;
      m.mem(input, array(type, {}, 2));
      m.mem(output, array('u32', {}, 2));
      m.fn(type, [], 'void', (f) => {
        const T = f.types[type] as any;
        const mem = f.memory as any;
        mem[output][0].set(T.eqz(mem[input][0].get()));
        mem[output][1].set(T.eqz(mem[input][1].get()));
        return [];
      });
    }
    testBothOpts(m, BIG_OPTS, (mod) => {
      for (const { type, bits, coder, signed } of defs) {
        const values = [0n, signed ? -1n : (1n << BigInt(bits)) - 1n];
        mod.segments[`in_${type}`].set(P.array(2, coder).encode(values));
        mod[type]();
        deepStrictEqual(P.array(2, P.U32LE).decode(mod.segments[`eqz_${type}`]), [1, 0]);
      }
    });
  });
});

should.runWhen(import.meta.url);
