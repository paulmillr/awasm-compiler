import { describe, it } from '@paulmillr/jsbt/test.js';
import { deepStrictEqual, throws } from 'node:assert';
import { Module } from '../src/module.ts';
import { testBoth } from './utils.ts';

describe('CastTo', () => {
  it('scalar casts', () => {
    const m = new Module('castScalar');
    m.fn('i32_to_u32', ['i32'], 'u32', (f, a) => {
      return [f.types.i32.castTo('u32', a)];
    });
    m.fn('u32_to_i32', ['u32'], 'i32', (f, a) => {
      return [f.types.u32.castTo('i32', a)];
    });
    m.fn('u8_to_u32', ['u8'], 'u32', (f, a) => {
      return [f.types.u32.castFrom('u8', a)];
    });
    m.fn('u32_to_u8', ['u32'], 'u8', (f, a) => {
      return [f.types.u8.castFrom('u32', a)];
    });
    m.fn('f32_to_u32', ['f32'], 'u32', (f, a) => {
      return [f.types.f32.castTo('u32', a)];
    });
    m.fn('u32_to_f32', ['u32'], 'f32', (f, a) => {
      return [f.types.u32.castTo('f32', a)];
    });
    m.fn('f64_to_u64', ['f64'], ['u32', 'u32'], (f, a) => {
      const v = f.types.u64.castFrom('f64', a);
      return f.types.u64.to('u32', v);
    });
    m.fn('u64_to_f64', ['u32', 'u32'], 'f64', (f, lo, hi) => {
      const v = f.types.u64.fromN('u32', [lo, hi]);
      return [f.types.f64.castFrom('u64', v)];
    });
    testBoth(m, (mod) => {
      const u32 = (x: number) => x >>> 0;
      const i32 = (x: number) => x | 0;
      deepStrictEqual(u32(mod.i32_to_u32(-1)), 0xffff_ffff);
      deepStrictEqual(i32(mod.u32_to_i32(0xffff_ffff)), -1);
      deepStrictEqual(mod.u8_to_u32(0xff), 0xff);
      deepStrictEqual(mod.u32_to_u8(0x7f), 0x7f);
      deepStrictEqual(mod.f32_to_u32(1), 0x3f80_0000);
      deepStrictEqual(mod.u32_to_f32(0x3f80_0000), 1);
      deepStrictEqual(mod.f64_to_u64(1), [0, 0x3ff0_0000]);
      deepStrictEqual(mod.u64_to_f64(0, 0x3ff0_0000), 1);
    });
  });

  it('simd casts', () => {
    const m = new Module('castSimd');
    m.fn('u8x16_to_i8x16_lane', [], 'i8', (f) => {
      const { u8, u8x16, i8x16 } = f.types;
      const vec = u8x16.splat(u8.const(0xff));
      const out = i8x16.castFrom('u8x16', vec);
      return [i8x16.extractLane(out, 0)];
    });
    m.fn('u16x8_to_i16x8_lane', [], 'i16', (f) => {
      const { u16, u16x8, i16x8 } = f.types;
      const vec = u16x8.splat(u16.const(0xffff));
      const out = i16x8.castFrom('u16x8', vec);
      return [i16x8.extractLane(out, 0)];
    });
    testBoth(m, (mod) => {
      deepStrictEqual(mod.u8x16_to_i8x16_lane(), -1);
      deepStrictEqual(mod.u16x8_to_i16x8_lane(), -1);
    });
  });

  it('more scalar casts', () => {
    const m = new Module('castScalarMore');
    m.fn('i16_to_u32', ['i16'], 'u32', (f, a) => {
      return [f.types.u32.castFrom('i16', a)];
    });
    m.fn('u32_to_i16', ['u32'], 'i16', (f, a) => {
      return [f.types.i16.castFrom('u32', a)];
    });
    m.fn('u16_to_u32', ['u16'], 'u32', (f, a) => {
      return [f.types.u32.castFrom('u16', a)];
    });
    m.fn('u32_to_u16', ['u32'], 'u16', (f, a) => {
      return [f.types.u16.castFrom('u32', a)];
    });
    m.fn('i8_to_u32', ['i8'], 'u32', (f, a) => {
      return [f.types.u32.castFrom('i8', a)];
    });
    m.fn('u32_to_i8', ['u32'], 'i8', (f, a) => {
      return [f.types.i8.castFrom('u32', a)];
    });
    testBoth(m, (mod) => {
      deepStrictEqual(mod.i16_to_u32(0x7fff), 0x7fff);
      deepStrictEqual(mod.u32_to_i16(0x1234), 0x1234);
      deepStrictEqual(mod.u16_to_u32(0xabcd), 0xabcd);
      deepStrictEqual(mod.u32_to_u16(0x2345), 0x2345);
      deepStrictEqual(mod.i8_to_u32(0x7f), 0x7f);
      deepStrictEqual(mod.u32_to_i8(0x22), 0x22);
    });
  });

  it('invalid casts', () => {
    const m0 = new Module('castBadScalar');
    m0.fn('bad_scalar', ['u8'], 'u16', (f, a) => {
      return [f.types.u16.castFrom('u8', a)];
    });
    throws(() => testBoth(m0, () => {}), /cast/);
    const m1 = new Module('castBadSimd');
    m1.fn('bad_simd', [], 'u32', (f) => {
      const vec = f.types.u16x8.laneOffsets(1);
      const out = f.types.u16x8.castTo('u32x8', vec);
      return [f.types.u32x8.extractLane(out, 0)];
    });
    throws(() => testBoth(m1, () => {}), /cast/);
    const m2 = new Module('castBadSimdLanes');
    m2.fn('bad_simd_lanes', [], 'u8', (f) => {
      const T8 = f.getType('u8', 8);
      const vec = T8.laneOffsets(1);
      const out = T8.castTo('u8x16', vec);
      return [f.types.u8x16.extractLane(out, 0)];
    });
    throws(() => testBoth(m2, () => {}), /cast/);
  });
});

it.runWhen(import.meta.url);
