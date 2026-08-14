import { describe, it } from './jsbt.js';
import * as P from 'micro-packed';
import { deepStrictEqual } from 'node:assert';
import { Module, array } from '../src/module.ts';
import { testBoth } from './utils.ts';

describe('SmallInt', () => {
  it('scalar wrap', () => {
    const m = new Module('smallIntScalar');
    m.fn('u8_add', ['u8', 'u8'], 'u8', (f, a, b) => {
      const { u8 } = f.types;
      return [u8.add(a, b)];
    });
    m.fn('i8_add', ['i8', 'i8'], 'i8', (f, a, b) => {
      const { i8 } = f.types;
      return [i8.add(a, b)];
    });
    m.fn('u16_mul', ['u16', 'u16'], 'u16', (f, a, b) => {
      const { u16 } = f.types;
      return [u16.mul(a, b)];
    });
    m.fn('i16_shr', ['i16'], 'i16', (f, a) => {
      const { i16 } = f.types;
      return [i16.shr(a, 1)];
    });
    m.fn('u8_clz', ['u8'], 'u8', (f, a) => {
      const { u8 } = f.types;
      return [u8.clz(a)];
    });
    testBoth(m, (mod) => {
      deepStrictEqual(mod.u8_add(250, 20), 14);
      deepStrictEqual(mod.i8_add(120, 10), -126);
      deepStrictEqual(mod.u16_mul(50000, 2), 34464);
      deepStrictEqual(mod.i16_shr(-2), -1);
      deepStrictEqual(mod.u8_clz(0), 8);
    });
  });

  it('swizzle + extractLane', () => {
    const m = new Module('smallIntSimd');
    m.fn('swz0', [], 'u8', (f) => {
      const { u8, u8x16 } = f.types;
      const vec = u8x16.laneOffsets(0);
      const mask = u8x16.sub(u8x16.splat(u8.const(15)), u8x16.laneOffsets(0));
      const swz = u8x16.swizzle(vec, mask);
      return [u8x16.extractLane(swz, 0)];
    });
    m.fn('laneSigned', [], 'i8', (f) => {
      const { i8, i8x16 } = f.types;
      const vec = i8x16.sub(i8x16.splat(i8.const(-1)), i8x16.laneOffsets(0));
      return [i8x16.extractLane(vec, 1)];
    });
    m.fn('u8x2_select', [], 'u8', (f) => {
      const T = f.getType('u8', 2);
      const a = T.laneOffsets(1);
      const b = T.laneOffsets(3);
      const mask = T.eq(a, b);
      const out = T.select(mask, a, b);
      return [T.extractLane(out, 0)];
    });
    m.fn('u16x2_select', [], 'u16', (f) => {
      const T = f.getType('u16', 2);
      const a = T.laneOffsets(5);
      const b = T.laneOffsets(7);
      const mask = T.eq(a, b);
      const out = T.select(mask, a, b);
      return [T.extractLane(out, 0)];
    });
    m.fn('u8x4_lane', [], 'u8', (f) => {
      const T = f.getType('u8', 4);
      const vec = T.laneOffsets(10);
      return [T.extractLane(vec, 2)];
    });
    m.fn('u8x8_lane', [], 'u8', (f) => {
      const T = f.getType('u8', 8);
      const vec = T.laneOffsets(20);
      return [T.extractLane(vec, 7)];
    });
    m.fn('u16x4_lane', [], 'u16', (f) => {
      const T = f.getType('u16', 4);
      const vec = T.laneOffsets(100);
      return [T.extractLane(vec, 3)];
    });
    m.fn('aes_like', [], 'u8', (f) => {
      const { u8, u8x16 } = f.types;
      const vec = u8x16.laneOffsets(0);
      const add = u8x16.add(u8x16.laneOffsets(0), u8x16.splat(u8.const(4)));
      const mask = u8x16.and(add, u8x16.splat(u8.const(15)));
      const swz = u8x16.swizzle(vec, mask);
      const xor = u8x16.xor(swz, u8x16.splat(u8.const(0x63)));
      return [u8x16.extractLane(xor, 0)];
    });
    testBoth(m, (mod) => {
      deepStrictEqual(mod.swz0(), 15);
      deepStrictEqual(mod.laneSigned(), -2);
      deepStrictEqual(mod.u8x2_select(), 3);
      deepStrictEqual(mod.u16x2_select(), 7);
      deepStrictEqual(mod.u8x4_lane(), 12);
      deepStrictEqual(mod.u8x8_lane(), 27);
      deepStrictEqual(mod.u16x4_lane(), 103);
      deepStrictEqual(mod.aes_like(), 0x67);
    });
  });

  it('memory views', () => {
    const m = new Module('smallIntMem')
      .mem('bytes', array('u8', {}, 4))
      .mem('words', array('u16', {}, 2))
      .mem('vec', array('u8x16', {}, 1))
      .mem('buf32', array('u32', {}, 1));
    m.fn('mem_u8', [], 'u8', (f) => {
      const { u8 } = f.types;
      f.memory.bytes[1].set(u8.const(0xab));
      return [f.memory.bytes[1].get()];
    });
    m.fn('mem_u16', [], 'u16', (f) => {
      const { u16 } = f.types;
      f.memory.words[0].set(u16.const(0x1234));
      return [f.memory.words[0].get()];
    });
    m.fn('mem_vec_lane', [], 'u8', (f) => {
      const { u8x16 } = f.types;
      const vec = u8x16.laneOffsets(1);
      f.memory.vec[0].set(vec);
      return [u8x16.extractLane(f.memory.vec[0].get(), 2)];
    });
    m.fn('mem_as8', [], 'u8', (f) => {
      const { u8 } = f.types;
      const view = f.memory.buf32.as8('u8');
      view[0].set(u8.const(0xfe));
      return [view[0].get()];
    });
    m.fn('mem_as8_default', [], 'u32', (f) => {
      const { u32 } = f.types;
      const view = f.memory.buf32.as8();
      view[0].set(u32.const(0xfe));
      return [view[0].get()];
    });
    m.fn('mem_as16', [], 'u16', (f) => {
      const { u16 } = f.types;
      const view = f.memory.buf32.as16('u16');
      view[0].set(u16.const(0x3456));
      return [view[0].get()];
    });
    m.fn('mem_as16_default', [], 'u32', (f) => {
      const { u32 } = f.types;
      const view = f.memory.buf32.as16();
      view[0].set(u32.const(0x3456));
      return [view[0].get()];
    });
    m.fn('mem_as', [], 'u8', (f) => {
      const { u8 } = f.types;
      const view = f.memory.buf32.as('u8');
      view[0].set(u8.const(0x7e));
      return [view[0].get()];
    });
    m.fn('mem_as_u16', [], 'u16', (f) => {
      const { u16 } = f.types;
      const view = f.memory.buf32.as('u16');
      view[0].set(u16.const(0x2468));
      return [view[0].get()];
    });
    m.fn('mem_byte_rw_u16', [], 'u16', (f) => {
      const { u16 } = f.types;
      const view = f.memory.bytes.as8('u8');
      view.write('u16', u16.const(0xbeef), 16);
      return [view.read('u16', 16)];
    });
    testBoth(m, (mod) => {
      deepStrictEqual(mod.mem_u8(), 0xab);
      deepStrictEqual(mod.mem_u16(), 0x1234);
      deepStrictEqual(mod.mem_vec_lane(), 3);
      deepStrictEqual(mod.mem_as8(), 0xfe);
      deepStrictEqual(mod.mem_as8_default(), 0xfe);
      deepStrictEqual(mod.mem_as16(), 0x3456);
      deepStrictEqual(mod.mem_as16_default(), 0x3456);
      deepStrictEqual(mod.mem_as(), 0x7e);
      deepStrictEqual(mod.mem_as_u16(), 0x2468);
      deepStrictEqual(mod.mem_byte_rw_u16(), 0xbeef);
    });
  });

  it('interleave small SIMD', () => {
    const m = new Module('smallIntInterleave')
      .mem('in8', array('u8x16', {}, 16))
      .mem('out8', array('u8x16', {}, 16))
      .mem('in16', array('u16x8', {}, 8))
      .mem('out16', array('u16x8', {}, 8));
    m.fn('inter8', [], 'void', (f) => {
      const { in8, out8 } = f.memory;
      const T = f.types.u8x16;
      out8.set(T.interleave(in8.get()));
    });
    m.fn('inter16', [], 'void', (f) => {
      const { in16, out16 } = f.memory;
      const T = f.types.u16x8;
      out16.set(T.interleave(in16.get()));
    });
    const transpose = <T>(rows: T[][]) => {
      const out: T[][] = [];
      const lanes = rows[0].length;
      for (let j = 0; j < lanes; j++) {
        const row: T[] = [];
        for (let i = 0; i < rows.length; i++) row.push(rows[i][j]);
        out.push(row);
      }
      return out;
    };
    testBoth(m, (mod) => {
      const lanes8 = 16;
      const size8 = 16;
      const input8 = Array.from({ length: size8 }, (_, i) =>
        Array.from({ length: lanes8 }, (_, j) => (i * lanes8 + j) & 0xff)
      );
      const expect8 = transpose(input8);
      const c8 = P.U8;
      const c8v = P.array(lanes8, c8);
      const c8full = P.array(size8, c8v);
      mod.segments.in8.set(c8full.encode(input8));
      mod.inter8();
      deepStrictEqual(c8full.decode(mod.segments.out8), expect8);

      const lanes16 = 8;
      const size16 = 8;
      const input16 = Array.from({ length: size16 }, (_, i) =>
        Array.from({ length: lanes16 }, (_, j) => (i * lanes16 + j + 0x100) & 0xffff)
      );
      const expect16 = transpose(input16);
      const c16 = P.U16LE;
      const c16v = P.array(lanes16, c16);
      const c16full = P.array(size16, c16v);
      mod.segments.in16.set(c16full.encode(input16));
      mod.inter16();
      deepStrictEqual(c16full.decode(mod.segments.out16), expect16);
    });
  });

  it('conversions', () => {
    const m = new Module('smallIntConv');
    m.fn('u8_to_u32', ['u8'], 'u32', (f, a) => {
      return [f.types.u8.toN('u32', a)];
    });
    m.fn('u32_to_u8', ['u32'], 'u8', (f, a) => {
      return [f.types.u8.fromN('u32', a)];
    });
    m.fn('u8_to_u64', ['u8'], ['u32', 'u32'], (f, a) => {
      const v = f.types.u8.toN('u64', a);
      return f.types.u64.to('u32', v);
    });
    m.fn('u64_to_u8', ['u32', 'u32'], 'u8', (f, lo, hi) => {
      const v = f.types.u64.fromN('u32', [lo, hi]);
      return [f.types.u8.fromN('u64', v)];
    });
    m.fn('u16_to_u8', ['u16'], 'u8', (f, a) => {
      return [f.types.u8.fromN('u16', a)];
    });
    m.fn('u16_to_u8_parts', ['u16'], ['u8', 'u8'], (f, a) => {
      return f.types.u16.to('u8', a);
    });
    m.fn('u32_to_u8_parts', ['u32'], ['u8', 'u8', 'u8', 'u8'], (f, a) => {
      return f.types.u32.to('u8', a);
    });
    m.fn('u16_to_i8', ['u16'], 'i8', (f, a) => {
      return [f.types.i8.fromN('u16', a)];
    });
    m.fn('u16_to_u32', ['u16'], 'u32', (f, a) => {
      return [f.types.u16.toN('u32', a)];
    });
    m.fn('u32_to_u16', ['u32'], 'u16', (f, a) => {
      return [f.types.u16.fromN('u32', a)];
    });
    m.fn('u32_to_i16', ['u32'], 'i16', (f, a) => {
      return [f.types.i16.fromN('u32', a)];
    });
    m.fn('u32_to_u64', ['u32'], ['u32', 'u32'], (f, a) => {
      const v = f.types.u32.toN('u64', a);
      return f.types.u64.to('u32', v);
    });
    m.fn('u64_to_u16', ['u32', 'u32'], 'u16', (f, lo, hi) => {
      const v = f.types.u64.fromN('u32', [lo, hi]);
      return [f.types.u16.fromN('u64', v)];
    });
    m.fn('u64_to_i16', ['u32', 'u32'], 'i16', (f, lo, hi) => {
      const v = f.types.u64.fromN('u32', [lo, hi]);
      return [f.types.i16.fromN('u64', v)];
    });
    m.fn('i8_to_i32', ['i8'], 'i32', (f, a) => {
      return [f.types.i8.toN('i32', a)];
    });
    m.fn('i8_to_u32', ['i8'], 'u32', (f, a) => {
      return [f.types.i8.toN('u32', a)];
    });
    m.fn('i8_to_u64', ['i8'], ['u32', 'u32'], (f, a) => {
      const v = f.types.i8.toN('u64', a);
      return f.types.u64.to('u32', v);
    });
    m.fn('u32_to_i8', ['u32'], 'i8', (f, a) => {
      return [f.types.i8.fromN('u32', a)];
    });
    m.fn('u64_to_i8', ['u32', 'u32'], 'i8', (f, lo, hi) => {
      const v = f.types.u64.fromN('u32', [lo, hi]);
      return [f.types.i8.fromN('u64', v)];
    });
    m.fn('u8_to_i8', ['u8'], 'i8', (f, a) => {
      return [f.types.i8.fromN('u8', a)];
    });
    m.fn('i16_to_i32', ['i16'], 'i32', (f, a) => {
      return [f.types.i16.toN('i32', a)];
    });
    m.fn('i16_to_u32', ['i16'], 'u32', (f, a) => {
      return [f.types.i16.toN('u32', a)];
    });
    m.fn('i16_to_u64', ['i16'], ['u32', 'u32'], (f, a) => {
      const v = f.types.i16.toN('u64', a);
      return f.types.u64.to('u32', v);
    });
    m.fn('u8_to_u8x16_lane', ['u8'], 'u8', (f, a) => {
      const vec = f.types.u8.toN('u8x16', a);
      return [f.types.u8x16.extractLane(vec, 5)];
    });
    m.fn('i8_to_i8x16_lane', ['i8'], 'i8', (f, a) => {
      const vec = f.types.i8.toN('i8x16', a);
      return [f.types.i8x16.extractLane(vec, 5)];
    });
    m.fn('i8x16_to_i8', [], 'i8', (f) => {
      const vec = f.types.i8x16.laneOffsets(-3);
      return [f.types.i8x16.toN('i8', vec)];
    });
    m.fn('u8x16_to_u8', [], 'u8', (f) => {
      const vec = f.types.u8x16.laneOffsets(3);
      return [f.types.u8x16.toN('u8', vec)];
    });
    m.fn('u16_to_u16x8_lane', ['u16'], 'u16', (f, a) => {
      const vec = f.types.u16.toN('u16x8', a);
      return [f.types.u16x8.extractLane(vec, 2)];
    });
    m.fn('i16_to_i16x8_lane', ['i16'], 'i16', (f, a) => {
      const vec = f.types.i16.toN('i16x8', a);
      return [f.types.i16x8.extractLane(vec, 1)];
    });
    m.fn('u16x8_to_u16', [], 'u16', (f) => {
      const vec = f.types.u16x8.laneOffsets(7);
      return [f.types.u16x8.toN('u16', vec)];
    });
    m.fn('i16x8_to_i16', [], 'i16', (f) => {
      const vec = f.types.i16x8.laneOffsets(-2);
      return [f.types.i16x8.toN('i16', vec)];
    });
    m.fn('u16x8_to_u32x8_lane', [], 'u32', (f) => {
      const { u16, u16x8, u32x8 } = f.types;
      const vec = u16x8.splat(u16.const(0xffff));
      const out = u16x8.toN('u32x8', vec);
      return [u32x8.extractLane(out, 0)];
    });
    m.fn('u32x8_to_u16x8_lane', [], 'u16', (f) => {
      const { u16, u32, u32x8, u16x8 } = f.types;
      const vec = u32x8.splat(u32.const(0x1ffff));
      const out = u32x8.toN('u16x8', vec);
      return [u16x8.extractLane(out, 0)];
    });
    m.fn('u16x8_to_u32x8_lane_offsets', [], 'u32', (f) => {
      const { u16x8, u32x8 } = f.types;
      const vec = u16x8.laneOffsets(0x100);
      const out = u16x8.toN('u32x8', vec);
      return [u32x8.extractLane(out, 6)];
    });
    m.fn('u32x8_to_u16x8_lane_offsets', [], 'u16', (f) => {
      const { u32x8, u16x8 } = f.types;
      const vec = u32x8.laneOffsets(0x10000);
      const out = u32x8.toN('u16x8', vec);
      return [u16x8.extractLane(out, 6)];
    });
    m.fn('u16x8_to_u8x8_parts_lane', [], ['u8', 'u8'], (f) => {
      const { u16x8, u8x8 } = f.types;
      const vec = u16x8.laneOffsets(0x100);
      const parts = u16x8.to('u8x8', vec);
      return [u8x8.extractLane(parts[0], 3), u8x8.extractLane(parts[1], 3)];
    });
    m.fn('u8x16_to_u16x8_parts_lane', [], ['u16', 'u16'], (f) => {
      const { u8x16, u16x8 } = f.types;
      const vec = u8x16.laneOffsets(0);
      const parts = u8x16.to('u16x8', vec);
      return [u16x8.extractLane(parts[0], 3), u16x8.extractLane(parts[1], 3)];
    });
    m.fn('u16x8_to_u32x4_parts_lane', [], ['u32', 'u32'], (f) => {
      const { u16x8, u32x4 } = f.types;
      const vec = u16x8.laneOffsets(0x100);
      const parts = u16x8.to('u32x4', vec);
      return [u32x4.extractLane(parts[0], 2), u32x4.extractLane(parts[1], 2)];
    });
    m.fn('u8x16_to_u32x16_lane', [], 'u32', (f) => {
      const { u8, u8x16, u32x16 } = f.types;
      const vec = u8x16.splat(u8.const(0xff));
      const out = u8x16.toN('u32x16', vec);
      return [u32x16.extractLane(out, 10)];
    });
    m.fn('u32x16_to_u8x16_lane', [], 'u8', (f) => {
      const { u32, u32x16, u8x16 } = f.types;
      const vec = u32x16.splat(u32.const(0x1ff));
      const out = u32x16.toN('u8x16', vec);
      return [u8x16.extractLane(out, 2)];
    });
    m.fn('u16x16_to_u8x16_parts_lane', [], ['u8', 'u8'], (f) => {
      const { u16x16, u8x16 } = f.types;
      const vec = u16x16.laneOffsets(0x100);
      const parts = u16x16.to('u8x16', vec);
      return [u8x16.extractLane(parts[0], 5), u8x16.extractLane(parts[1], 5)];
    });
    m.fn('u16x16_to_u32x16_lane', [], 'u32', (f) => {
      const { u16, u16x16, u32x16 } = f.types;
      const vec = u16x16.splat(u16.const(0xffff));
      const out = u16x16.toN('u32x16', vec);
      return [u32x16.extractLane(out, 7)];
    });
    m.fn('u32x16_to_u16x16_lane', [], 'u16', (f) => {
      const { u32, u32x16, u16x16 } = f.types;
      const vec = u32x16.splat(u32.const(0x1ffff));
      const out = u32x16.toN('u16x16', vec);
      return [u16x16.extractLane(out, 7)];
    });
    m.fn('i16x8_to_i32x8_lane_offsets', [], 'i32', (f) => {
      const { i16x8, i32x8 } = f.types;
      const vec = i16x8.laneOffsets(-4);
      const out = i16x8.toN('i32x8', vec);
      return [i32x8.extractLane(out, 3)];
    });
    m.fn('i32x8_to_i16x8_lane_offsets', [], 'i16', (f) => {
      const { i32x8, i16x8 } = f.types;
      const vec = i32x8.laneOffsets(0x1ffff);
      const out = i32x8.toN('i16x8', vec);
      return [i16x8.extractLane(out, 0)];
    });
    m.fn('u16x2_to_u32x2_lane_offsets', [], 'u32', (f) => {
      const { u16x2, u32x2 } = f.types;
      const vec = u16x2.laneOffsets(0x1000);
      const out = u16x2.toN('u32x2', vec);
      return [u32x2.extractLane(out, 1)];
    });
    m.fn('u32x2_to_u16x2_lane_offsets', [], 'u16', (f) => {
      const { u32x2, u16x2 } = f.types;
      const vec = u32x2.laneOffsets(0x10000);
      const out = u32x2.toN('u16x2', vec);
      return [u16x2.extractLane(out, 1)];
    });
    m.fn('i16x2_to_i32x2_lane_offsets', [], 'i32', (f) => {
      const { i16x2, i32x2 } = f.types;
      const vec = i16x2.laneOffsets(-5);
      const out = i16x2.toN('i32x2', vec);
      return [i32x2.extractLane(out, 1)];
    });
    m.fn('i32x2_to_i16x2_lane_offsets', [], 'i16', (f) => {
      const { i32x2, i16x2 } = f.types;
      const vec = i32x2.laneOffsets(0x1ffff);
      const out = i32x2.toN('i16x2', vec);
      return [i16x2.extractLane(out, 0)];
    });
    m.fn('u8x16_to_i8x16_lane', [], 'i8', (f) => {
      const { u8, u8x16, i8x16 } = f.types;
      const vec = u8x16.splat(u8.const(0xff));
      const out = u8x16.toN('i8x16', vec);
      return [i8x16.extractLane(out, 0)];
    });
    m.fn('u16x8_to_i16x8_lane', [], 'i16', (f) => {
      const { u16, u16x8, i16x8 } = f.types;
      const vec = u16x8.splat(u16.const(0xffff));
      const out = u16x8.toN('i16x8', vec);
      return [i16x8.extractLane(out, 0)];
    });
    testBoth(m, (mod) => {
      const u32 = (x: number) => x >>> 0;
      const u32s = (xs: number[]) => xs.map(u32);
      deepStrictEqual(u32(mod.u8_to_u32(0xff)), 255);
      deepStrictEqual(mod.u32_to_u8(0x1ff), 0xff);
      deepStrictEqual(mod.u8_to_u64(0xaa), [0xaa, 0]);
      deepStrictEqual(mod.u64_to_u8(0x1234, 0), 0x34);
      deepStrictEqual(mod.u16_to_u8(0x1234), 0x34);
      deepStrictEqual(mod.u16_to_u8_parts(0x1234), [0x34, 0x12]);
      deepStrictEqual(mod.u32_to_u8_parts(0x11223344), [0x44, 0x33, 0x22, 0x11]);
      deepStrictEqual(mod.u16_to_i8(0x12ff), -1);
      deepStrictEqual(u32(mod.u16_to_u32(0xffff)), 0xffff);
      deepStrictEqual(mod.u32_to_u16(0x1ffff), 0xffff);
      deepStrictEqual(mod.u32_to_i16(0x1ffff), -1);
      deepStrictEqual(u32s(mod.u32_to_u64(0xffff_ffff)), [0xffff_ffff, 0]);
      deepStrictEqual(mod.u64_to_u16(0x2345, 0x1), 0x2345);
      deepStrictEqual(mod.u64_to_i16(0x2345, 0x1), 0x2345);
      deepStrictEqual(mod.i8_to_i32(-1), -1);
      deepStrictEqual(u32(mod.i8_to_u32(-1)), 0xffff_ffff);
      deepStrictEqual(u32s(mod.i8_to_u64(-1)), [0xffff_ffff, 0xffff_ffff]);
      deepStrictEqual(mod.u32_to_i8(0xff), -1);
      deepStrictEqual(mod.u64_to_i8(0xff, 0), -1);
      deepStrictEqual(mod.u8_to_i8(0xff), -1);
      deepStrictEqual(mod.i16_to_i32(-2), -2);
      deepStrictEqual(u32(mod.i16_to_u32(-2)), 0xffff_fffe);
      deepStrictEqual(u32s(mod.i16_to_u64(-2)), [0xffff_fffe, 0xffff_ffff]);
      deepStrictEqual(mod.u32_to_i16(0xffff), -1);
      deepStrictEqual(mod.u64_to_i16(0xffff, 0), -1);
      deepStrictEqual(mod.u8_to_u8x16_lane(7), 7);
      deepStrictEqual(mod.i8_to_i8x16_lane(-7), -7);
      deepStrictEqual(mod.i8x16_to_i8(), -3);
      deepStrictEqual(mod.u8x16_to_u8(), 3);
      deepStrictEqual(mod.u16_to_u16x8_lane(9), 9);
      deepStrictEqual(mod.i16_to_i16x8_lane(-9), -9);
      deepStrictEqual(mod.u16x8_to_u16(), 7);
      deepStrictEqual(mod.i16x8_to_i16(), -2);
      deepStrictEqual(mod.u16x8_to_u32x8_lane(), 0xffff);
      deepStrictEqual(mod.u32x8_to_u16x8_lane(), 0xffff);
      deepStrictEqual(mod.u16x8_to_u32x8_lane_offsets(), 0x106);
      deepStrictEqual(mod.u32x8_to_u16x8_lane_offsets(), 6);
      deepStrictEqual(mod.u16x8_to_u8x8_parts_lane(), [3, 1]);
      deepStrictEqual(mod.u8x16_to_u16x8_parts_lane(), [3, 11]);
      deepStrictEqual(mod.u16x8_to_u32x4_parts_lane(), [0x102, 0x106]);
      deepStrictEqual(u32(mod.u8x16_to_u32x16_lane()), 0xff);
      deepStrictEqual(mod.u32x16_to_u8x16_lane(), 0xff);
      deepStrictEqual(mod.u16x16_to_u8x16_parts_lane(), [5, 1]);
      deepStrictEqual(u32(mod.u16x16_to_u32x16_lane()), 0xffff);
      deepStrictEqual(mod.u32x16_to_u16x16_lane(), 0xffff);
      deepStrictEqual(mod.i16x8_to_i32x8_lane_offsets(), -1);
      deepStrictEqual(mod.i32x8_to_i16x8_lane_offsets(), -1);
      deepStrictEqual(mod.u16x2_to_u32x2_lane_offsets(), 0x1001);
      deepStrictEqual(mod.u32x2_to_u16x2_lane_offsets(), 1);
      deepStrictEqual(mod.i16x2_to_i32x2_lane_offsets(), -4);
      deepStrictEqual(mod.i32x2_to_i16x2_lane_offsets(), -1);
      deepStrictEqual(mod.u8x16_to_i8x16_lane(), -1);
      deepStrictEqual(mod.u16x8_to_i16x8_lane(), -1);
    });
    it('extmul', () => {
      const mod = new Module('smallint_extmul')
        .fn('u8x16_extmul_low_u', [], 'u16', (f) => {
          const { u8x16, u16x8 } = f.types;
          const a = u8x16.laneOffsets(1);
          const b = u8x16.laneOffsets(2);
          const out = (f as any).rawFn.op('u16x8', 'extmul_low_i8x16_u', [a, b]);
          return [u16x8.extractLane(out, 3)];
        })
        .fn('u8x16_extmul_high_u', [], 'u16', (f) => {
          const { u8x16, u16x8 } = f.types;
          const a = u8x16.laneOffsets(1);
          const b = u8x16.laneOffsets(2);
          const out = (f as any).rawFn.op('u16x8', 'extmul_high_i8x16_u', [a, b]);
          return [u16x8.extractLane(out, 1)];
        })
        .fn('i8x16_extmul_low_s', [], 'i16', (f) => {
          const { i8x16, i16x8 } = f.types;
          const a = i8x16.laneOffsets(-2);
          const b = i8x16.laneOffsets(1);
          const out = (f as any).rawFn.op('i16x8', 'extmul_low_i8x16_s', [a, b]);
          return [i16x8.extractLane(out, 0)];
        })
        .fn('u16x8_extmul_low_u', [], 'u32', (f) => {
          const { u16x8, u32x4 } = f.types;
          const a = u16x8.laneOffsets(0x100);
          const b = u16x8.laneOffsets(2);
          const out = (f as any).rawFn.op('u32x4', 'extmul_low_i16x8_u', [a, b]);
          return [u32x4.extractLane(out, 2)];
        });
      testBothOpts(mod, { noRuntime: true }, (mm) => {
        deepStrictEqual(mm.u8x16_extmul_low_u(), 20);
        deepStrictEqual(mm.u8x16_extmul_high_u(), 110);
        deepStrictEqual(mm.i8x16_extmul_low_s(), -2);
        deepStrictEqual(mm.u16x8_extmul_low_u(), 0x408);
      });
    });
  });
});

it.runWhen(import.meta.url);
