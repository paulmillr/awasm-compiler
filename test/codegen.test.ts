import { describe, should } from '@paulmillr/jsbt/test.js';
import * as P from 'micro-packed';
import { deepStrictEqual, throws } from 'node:assert';
import { FnOp, ModuleGraph, toJs, toMod, toWasm } from '../src/codegen.ts';
import * as js from '../src/js.ts';
import { createJS, exec, wrapModule, wrapWASM } from '../src/js.ts';
import * as memory from '../src/memory.ts';
import { PosExpr } from '../src/memory.ts';
import { Module, array, scalar, struct } from '../src/module.ts';
import { toRuntime } from '../src/runtime.ts';
import {
  genRuntimeTypeMod,
  genRuntimeTypes,
  lanesOf,
  minSimdType,
  TYPE_MOD_OPTS,
  TypeCoders,
} from '../src/types.ts';
import * as utils from '../src/utils.ts';
import { concatBytes } from '../src/utils.ts';
import * as wasm from '../src/wasm.ts';
import { testBoth, testBothOpts } from './utils.ts';
export const runtimeTypes = genRuntimeTypes();

const CODERS = {
  i32: P.I32LE,
  u32: P.U32LE,
  u64: P.U64LE,
  i64: P.I64LE,
  u32x4: P.tuple([P.U32LE, P.U32LE, P.U32LE, P.U32LE]),
  i32x4: P.tuple([P.I32LE, P.I32LE, P.I32LE, P.I32LE]),
  u64x2: P.tuple([P.U64LE, P.U64LE]),
  i64x2: P.tuple([P.I64LE, P.I64LE]),
};

const CODERS_BE = {
  i32: P.I32BE,
  u32: P.U32BE,
  u64: P.U64BE,
  i64: P.I64BE,
};

const SLOW = false;

describe('Codegen', () => {
  describe('Basic', () => {
    should('Basic', () => {
      const m = new Module('basicTest');
      m.fn('test', ['i32', 'i32'], 'i32', (f, A, B) => {
        const { i32 } = f.types;
        return [i32.add(A, B)];
      });
      testBoth(m, (mod) => {
        deepStrictEqual(mod.test(3, 2), 5);
        deepStrictEqual(mod.test(3, 2 ** 31), -2147483645);
      });
    });
    should('select', () => {
      const genSelect = (t) => {
        const m = new Module('basicTest');
        // cond is always i32!
        m.fn('test', ['i32', t, t], 'u32', (f, A, B, C) => {
          const T = f.types[t];
          return [T.select(A, B, C)];
        });
        return m;
      };
      const test = (mod, type) => {
        const x = (n) => (type.includes('64') ? BigInt(n) : n);
        deepStrictEqual(mod.test(0, x(4), x(5)), x(0 ? 4 : 5));
        deepStrictEqual(mod.test(1, x(4), x(5)), x(1 ? 4 : 5));
        deepStrictEqual(mod.test(2, x(4), x(5)), x(2 ? 4 : 5));
        deepStrictEqual(mod.test(0, x(4), x(5)), x(5));
        deepStrictEqual(mod.test(1, x(4), x(5)), x(4));
        deepStrictEqual(mod.test(2, x(4), x(5)), x(4));
      };
      testBoth(genSelect('i32'), (mod) => test(mod, 'i32'));
      testBoth(genSelect('u32'), (mod) => test(mod, 'u32'));

      test(exec(toWasm(genSelect('i64'))), 'i64');
      test(exec(toWasm(genSelect('u64'))), 'u64');
    });
    should('u64 arg lowering', () => {
      const m = new Module('basicTest');
      m.mem('test', array('u64', {}, 1));
      m.fn('test', ['u64'], 'void', (f, A) => {
        const T = f.types.u64;
        f.memory.test[0].set(T.shl(A, 1));
      });
      testBothOpts(m, { lowerU64Arg: true, noRuntime: true }, (mod) => {
        mod.test(123_123, 456_456);
        deepStrictEqual(
          mod.segments.test.subarray(0, 8),
          new Uint8Array([230, 193, 3, 0, 16, 238, 13, 0])
        );
      });
    });
  });
  describe('Memory', () => {
    should('Basic', () => {
      const m = new Module('memTest')
        .mem('memSegment1', array('u32', {}, 3))
        .mem('memSegment2', array('u32', {}, 4))
        .fn('test', [], ['u32', 'u32'], (f) => {
          const { u32 } = f.types;
          const { memSegment1, memSegment2 } = f.memory;
          const A = memSegment1[0].get();
          const B = memSegment1[1].get();
          const C = memSegment2[0].get();
          const D = memSegment2[1].get();

          return [u32.add(A, B), u32.add(C, D)];
        });
      testBoth(m, (mod) => {
        const view1 = utils.createView(mod.segments.memSegment1);
        view1.setInt32(0, 2, true);
        view1.setInt32(4, 3, true);
        const view2 = utils.createView(mod.segments.memSegment2);
        view2.setInt32(0, 5, true);
        view2.setInt32(4, 6, true);
        deepStrictEqual(mod.test(3, 2), [5, 11]);
      });
    });
    should('Store', () => {
      // Test that store actually works
      const m = new Module('memTest')
        .mem('memSegment1', array('u32', {}, 3))
        .mem('memSegment2', array('u32', {}, 4))
        .fn('test', [], ['u32', 'u32'], (f) => {
          const { u32 } = f.types;
          const { memSegment1, memSegment2 } = f.memory;
          const A = memSegment1[0].get();
          const B = memSegment1[1].get();
          const C = memSegment2[0].get();
          const D = memSegment2[1].get();
          memSegment2[0].set(u32.add(A, B));
          memSegment2[1].set(u32.add(C, D));
          return [u32.add(A, B), u32.add(C, D)];
        });
      testBoth(m, (mod) => {
        const view1 = utils.createView(mod.segments.memSegment1);
        const view2 = utils.createView(mod.segments.memSegment2);

        view1.setInt32(0, 2, true);
        view1.setInt32(4, 3, true);

        view2.setInt32(0, 5, true);
        view2.setInt32(4, 6, true);

        deepStrictEqual(mod.test(), [5, 11], 'wasm');
        deepStrictEqual(view2.getInt32(0, true), 5);
        deepStrictEqual(view2.getInt32(4, true), 11);
      });
    });
    should('load8/store8', () => {
      for (const type of ['i32', 'u32', 'i64', 'u64']) {
        const m = new Module('basicTest');
        m.mem('mem', array(type, {}, 7));
        m.mem('mem2', array(type, {}, 4, 7));

        for (const sz of [8, 16, 32]) {
          m.fn(`add${sz}`, ['i32', type], 'void', (f, pos, value) => {
            const T = f.types[type];
            f.memory.mem
              .as8()
              .range(pos, sz / 8)
              [`as${sz}`](type)[0]
              .mut.add(value);

            const memSimd = f.memory.mem2
              .lanes(4)[0]
              .as8()
              .range(pos, sz / 8)
              [`as${sz}`](type)[0];
            if (type.includes('32')) {
              memSimd.mut.add(T.toN(memSimd.type, value));
            }
          });
        }
        const fixInt = (n) => (type.includes(64) ? BigInt(n) : n);
        const MAX = {
          i32: -1,
          u32: 0xffff_ffff,
          i64: -1n,
          u64: 0xffff_ffff_ffff_ffffn,
        }[type];
        testBothOpts(m, { noRuntime: true }, (mod) => {
          const exp123 = new Uint8Array([
            123, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0,
          ]);
          mod.add8(0, fixInt(123));
          deepStrictEqual(mod.segments.mem.subarray(0, 28), exp123);
          mod.segments.mem.fill(0);
          mod.add8(0, fixInt(MAX));
          deepStrictEqual(
            mod.segments.mem.subarray(0, 28),
            new Uint8Array([
              0xff, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0,
            ])
          );
          mod.segments.mem.fill(0);
          mod.add8(1, fixInt(MAX));
          deepStrictEqual(
            mod.segments.mem.subarray(0, 28),
            new Uint8Array([
              0, 0xff, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0,
            ])
          );
          mod.segments.mem.fill(0);
          mod.add8(2, fixInt(MAX));
          deepStrictEqual(
            mod.segments.mem.subarray(0, 28),
            new Uint8Array([
              0, 0, 0xff, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0,
            ])
          );
          mod.segments.mem.fill(0);
          mod.add8(3, fixInt(MAX));
          deepStrictEqual(
            mod.segments.mem.subarray(0, 28),
            new Uint8Array([
              0, 0, 0, 0xff, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0,
            ])
          );
          mod.segments.mem.fill(0);
          mod.add8(4, fixInt(MAX));
          deepStrictEqual(
            mod.segments.mem.subarray(0, 28),
            new Uint8Array([
              0, 0, 0, 0, 0xff, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0,
            ])
          );
          mod.segments.mem.fill(0);
          mod.add16(0, fixInt(123));
          deepStrictEqual(mod.segments.mem.subarray(0, 28), exp123);
          mod.segments.mem.fill(0);
          mod.add16(0, MAX);
          deepStrictEqual(
            mod.segments.mem.subarray(0, 28),
            new Uint8Array([
              0xff, 0xff, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0,
              0,
            ])
          );
          mod.segments.mem.fill(0);
          mod.add16(1, MAX);
          deepStrictEqual(
            mod.segments.mem.subarray(0, 28),
            new Uint8Array([
              0, 0xff, 0xff, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0,
              0,
            ])
          );
          mod.segments.mem.fill(0);
          mod.add16(2, MAX);
          deepStrictEqual(
            mod.segments.mem.subarray(0, 28),
            new Uint8Array([
              0, 0, 0xff, 0xff, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0,
              0,
            ])
          );
          mod.segments.mem.fill(0);
          mod.add16(3, MAX);
          deepStrictEqual(
            mod.segments.mem.subarray(0, 28),
            new Uint8Array([
              0, 0, 0, 0xff, 0xff, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0,
              0,
            ])
          );
          mod.segments.mem.fill(0);
          mod.add16(4, MAX);
          deepStrictEqual(
            mod.segments.mem.subarray(0, 28),
            new Uint8Array([
              0, 0, 0, 0, 0xff, 0xff, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0,
              0,
            ])
          );
          mod.segments.mem.fill(0);
          mod.add32(0, MAX);
          deepStrictEqual(
            mod.segments.mem.subarray(0, 28),
            new Uint8Array([
              0xff, 0xff, 0xff, 0xff, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0,
              0, 0, 0,
            ])
          );
          mod.segments.mem.fill(0);
          mod.add32(1, MAX);
          deepStrictEqual(
            mod.segments.mem.subarray(0, 28),
            new Uint8Array([
              0, 0xff, 0xff, 0xff, 0xff, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0,
              0, 0, 0,
            ])
          );
          mod.segments.mem.fill(0);
          mod.add32(2, MAX);
          deepStrictEqual(
            mod.segments.mem.subarray(0, 28),
            new Uint8Array([
              0, 0, 0xff, 0xff, 0xff, 0xff, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0,
              0, 0, 0,
            ])
          );
          mod.segments.mem.fill(0);
          mod.add32(3, MAX);
          deepStrictEqual(
            mod.segments.mem.subarray(0, 28),
            new Uint8Array([
              0, 0, 0, 0xff, 0xff, 0xff, 0xff, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0,
              0, 0, 0,
            ])
          );
          mod.segments.mem.fill(0);
          mod.add32(4, MAX);
          deepStrictEqual(
            mod.segments.mem.subarray(0, 28),
            new Uint8Array([
              0, 0, 0, 0, 0xff, 0xff, 0xff, 0xff, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0,
              0, 0, 0,
            ])
          );
        });
      }
    });
    should('fill', () => {
      const mod = new Module('fill')
        .mem('state', array('u32', {}, 16))
        .mem('stateSimd', array('u32', {}, 4, 16))
        .fn('fill', ['i32', 'i32', 'i32'], 'void', (f, pos, byte, len) => {
          const { u32 } = f.types;
          f.memory.state.as8().range(pos, 16).fill(byte, len);
          f.memory.stateSimd
            .lanes(4)[0]
            .as8()
            .range(pos, u32.sub(u32.const(16 * 4), pos))
            .fill(byte, len);
        })
        .fn('zero', [], 'void', (f) => {
          f.memory.state.as8().zero();
          f.memory.stateSimd.lanes(4)[0].as8().zero();
        });
      testBoth(mod, (mod) => {
        const check = (buf) => {
          deepStrictEqual(mod.segments.state.subarray(0), buf);
          const simdExp = concatBytes(buf, buf, buf, buf);
          deepStrictEqual(mod.segments.stateSimd.subarray(0, simdExp.length), simdExp);
        };
        mod.fill(1, 5, 5);
        check(
          new Uint8Array([
            0, 5, 5, 5, 5, 5, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0,
            0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0,
            0, 0, 0, 0, 0, 0,
          ])
        );
        mod.fill(6, 0xff, 10);
        check(
          new Uint8Array([
            0, 5, 5, 5, 5, 5, 255, 255, 255, 255, 255, 255, 255, 255, 255, 255, 0, 0, 0, 0, 0, 0, 0,
            0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0,
            0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0,
          ])
        );
        mod.fill(0, 0xff, 64);
        check(new Uint8Array(64).fill(0xff));
        mod.fill(0, 3, 64);
        check(new Uint8Array(64).fill(3));
        mod.zero();
        check(new Uint8Array(64));
        mod.fill(0, 0xff, 64);
        check(new Uint8Array(64).fill(0xff));
        mod.zero();
        check(new Uint8Array(64));
      });
    });
    should('copy', () => {
      const mod = new Module('fill')
        .mem('src', array('u32', {}, 16))
        .mem('dst', array('u32', {}, 16))
        .mem('srcSimd', array('u32', {}, 4, 16))
        .mem('dstSimd', array('u32', {}, 4, 16))
        .mem('dstSimd2', array('u32', {}, 4, 16))
        .fn('zero', [], 'void', (f) => {
          f.memory.dst.as8().zero();
          f.memory.dstSimd.lanes(4)[0].as8().zero();
          f.memory.dstSimd2.lanes(4)[0].as8().zero();
        })
        .fn('copy', ['i32', 'i32', 'i32'], 'void', (f, srcPos, dstPos, len) => {
          const { u32 } = f.types;
          f.memory.dst
            .as8()
            .range(dstPos, u32.sub(u32.const(64), dstPos))
            .copyFrom(f.memory.src.as8().range(srcPos, u32.sub(u32.const(64), srcPos)), len);

          f.memory.dstSimd
            .lanes(4)[0]
            .as8()
            .range(dstPos, u32.sub(u32.const(64), dstPos))
            .copyFrom(f.memory.src.as8().range(srcPos, u32.sub(u32.const(64), srcPos)), len);
          f.memory.dstSimd2
            .lanes(4)[0]
            .as8()
            .range(dstPos, u32.sub(u32.const(64), dstPos))
            .copyFrom(
              f.memory.srcSimd
                .lanes(4)[0]
                .as8()
                .range(srcPos, u32.sub(u32.const(64), srcPos)),
              len
            );
        })
        .fn('copySelf', ['i32', 'i32', 'i32'], 'void', (f, srcPos, dstPos, len) => {
          const { u32 } = f.types;
          f.memory.dstSimd2
            .lanes(4)[0]
            .as8()
            .range(dstPos, u32.sub(u32.const(64), dstPos))
            .copyFrom(f.memory.dst.as8().range(srcPos, u32.sub(u32.const(64), srcPos)), len);
          f.memory.dstSimd
            .lanes(4)[0]
            .as8()
            .range(dstPos, u32.sub(u32.const(64), dstPos))
            .copyFrom(
              f.memory.dstSimd
                .lanes(4)[0]
                .as8()
                .range(srcPos, u32.sub(u32.const(64), srcPos)),
              len
            );
          f.memory.dst
            .as8()
            .range(dstPos, u32.sub(u32.const(64), dstPos))
            .copyFrom(f.memory.dst.as8().range(srcPos, u32.sub(u32.const(64), srcPos)), len);
        });

      testBoth(mod, (mod) => {
        const setSrc = (buf) => {
          mod.segments.src.set(buf);
          mod.segments.srcSimd.set(concatBytes(buf, buf, buf, buf));
        };
        const setDst = (buf) => {
          mod.segments.dst.set(buf);
          mod.segments.dstSimd.set(concatBytes(buf, buf, buf, buf));
          mod.segments.dstSimd2.set(concatBytes(buf, buf, buf, buf));
        };
        const check = (exp) => {
          deepStrictEqual(mod.segments.dst, exp);

          const simdExp = concatBytes(exp, exp, exp, exp);
          deepStrictEqual(mod.segments.dstSimd.subarray(0, simdExp.length), simdExp);
          deepStrictEqual(mod.segments.dstSimd2.subarray(0, simdExp.length), simdExp);
        };
        setSrc(Uint8Array.from(utils.seq(64)));
        mod.copy(1, 2, 5);
        check(
          new Uint8Array([
            0, 0, 1, 2, 3, 4, 5, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0,
            0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0,
            0, 0, 0, 0, 0, 0,
          ])
        );
        mod.copy(1, 0, 3);
        check(
          new Uint8Array([
            1, 2, 3, 2, 3, 4, 5, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0,
            0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0,
            0, 0,

            0, 0, 0, 0,
          ])
        );
        {
          // helper: clone dst and compute expected via copyWithin
          function expectCopyWithin(dstU8: Uint8Array, src: number, dst: number, len: number) {
            const exp = new Uint8Array(dstU8); // copy
            exp.copyWithin(dst, src, src + len); // JS spec == memmove
            return exp;
          }
          // 1) forward overlap: src<dst
          mod.zero();
          setDst(Uint8Array.from(utils.seq(64)));
          //for (const c of mod.segments.dstSimd_chunks) c.set(base);
          //for (const c of mod.segments.dstSimd2_chunks) c.set(base);
          mod.copySelf(0, 2, 8); // [0..8) -> [2..10)
          check(expectCopyWithin(mod.segments.dst, 2, 999, 0));
        }
        // ^ trick: we need expected before mutation, so capture base first:
        {
          mod.zero();
          const base = utils.seq(64);
          const exp = new Uint8Array(utils.seq(64));
          exp.copyWithin(2, 0, 8);
          setDst(Uint8Array.from(utils.seq(64)));
          mod.copySelf(0, 2, 8);
          check(exp);
        }
        // 2) backward overlap: src>dst
        {
          mod.zero();
          const base = utils.seq(64);
          const exp = new Uint8Array(base);
          exp.copyWithin(0, 2, 10); // [2..10) -> [0..8)
          setDst(Uint8Array.from(base));
          mod.copySelf(2, 0, 8);
          check(exp);
        }
        // 3) src == dst
        {
          mod.zero();
          const base = Uint8Array.from(utils.seq(64));
          setDst(base);
          mod.copySelf(5, 5, 20);
          check(base);
        }
        // 4) len == 0 (and high offsets)
        {
          mod.zero();
          const before = new Uint8Array(mod.segments.dst);
          mod.copy(59, 59, 0); // exactly end, no-op
          check(before);
        }
        // 5) exact-end boundary
        {
          mod.zero();
          mod.segments.src.set(utils.seq(64));
          mod.copy(64 - 8, 64 - 8, 8); // fits exactly
          deepStrictEqual(
            mod.segments.dst.subarray(64 - 8, 64),
            mod.segments.src.subarray(64 - 8, 64)
          );
          // for (let i = 0; i < 4; i++) {
          //   deepStrictEqual(
          //     mod.segments.dstSimd_chunks[i].subarray(60 - 8, 60),
          //     mod.segments.srcSimd_chunks[i].subarray(60 - 8, 60)
          //   );
          //   deepStrictEqual(
          //     mod.segments.dstSimd_chunks[i].subarray(60 - 8, 60),
          //     mod.segments.src.subarray(60 - 8, 60)
          //   );
          //   deepStrictEqual(
          //     mod.segments.dstSimd2_chunks[i].subarray(60 - 8, 60),
          //     mod.segments.src.subarray(60 - 8, 60)
          //   );
          // }
        }
      });
    });
    should('swap', () => {
      const mswap = new Module('swap')
        .mem('input32', array('u32', {}, 1))
        .mem('input64', array('u64', {}, 1))
        .mem('input32x4', array('u32x4', {}, 1))
        .mem('input64x2', array('u64x2', {}, 1))
        .fn('swap32', [], 'void', (f) => {
          const T = f.types.u32;
          const { input32 } = f.memory;
          let A = input32[0].get();

          {
            const FF00 = T.const(0x00ff00ff);
            const t1 = T.shl(T.and(A, FF00), 8);
            const t2 = T.and(T.shr(A, 8), FF00);
            const y = T.or(t1, t2);
            A = T.or(T.shl(y, 16), T.shr(y, 16));
          }

          input32[0].set(A);
        })
        .fn('swap32_2', [], 'void', (f) => {
          const T = f.types.u32;
          const { input32 } = f.memory;
          input32[0].mut.swapEndianness();
        })
        .fn('swap64', [], 'void', (f) => {
          const T = f.types.u64;
          const { input64 } = f.memory;

          let A = input64[0].get();
          {
            const FF00 = T.const(0x00ff00ff00ff00ffn);
            const t1 = T.shl(T.and(A, FF00), 8);
            const t2 = T.and(T.shr(A, 8), FF00);
            const y = T.or(t1, t2);

            const FFFF = T.const(0x0000ffff0000ffffn);
            const u1 = T.shl(T.and(y, FFFF), 16);
            const u2 = T.and(T.shr(y, 16), FFFF);
            const z = T.or(u1, u2);

            A = T.or(T.shl(z, 32), T.shr(z, 32));
          }
          input64[0].set(A);
        })
        .fn('swap64_2', [], 'void', (f) => {
          const T = f.types.u64;
          const { input64 } = f.memory;
          input64[0].mut.swapEndianness();
        })
        .fn('swap32x4', [], 'void', (f) => {
          const { input32x4 } = f.memory;
          input32x4[0].mut.swapEndianness();
        })
        .fn('swap64x2', [], 'void', (f) => {
          const { input64x2 } = f.memory;
          input64x2[0].mut.swapEndianness();
        });
      // 32
      testBoth(mswap, (mod) => {
        mod.segments.input32.fill(0);
        mod.segments.input32.set(utils.seq(4));
        mod.swap32();
        deepStrictEqual(mod.segments.input32, new Uint8Array([3, 2, 1, 0]));
      });
      testBoth(mswap, (mod) => {
        mod.segments.input32.fill(0);
        mod.segments.input32.set(utils.seq(4));
        mod.swap32_2();
        deepStrictEqual(mod.segments.input32, new Uint8Array([3, 2, 1, 0]));
      });
      // 32 simd
      testBoth(mswap, (mod) => {
        mod.segments.input32x4.fill(0);
        mod.segments.input32x4.set(utils.seq(4));
        mod.swap32x4();
        deepStrictEqual(mod.segments.input32x4.subarray(0, 4), new Uint8Array([3, 2, 1, 0]));
      });
      // 64
      testBoth(mswap, (mod) => {
        mod.segments.input64.fill(0);
        mod.segments.input64.set(utils.seq(8));
        mod.swap64();
        deepStrictEqual(mod.segments.input64, new Uint8Array([7, 6, 5, 4, 3, 2, 1, 0]));
      });
      testBoth(mswap, (mod) => {
        mod.segments.input64.fill(0);
        mod.segments.input64.set(utils.seq(8));
        mod.swap64_2();
        deepStrictEqual(mod.segments.input64, new Uint8Array([7, 6, 5, 4, 3, 2, 1, 0]));
      });
      // 64 simd
      testBoth(mswap, (mod) => {
        mod.segments.input64x2.fill(0);
        mod.segments.input64x2.set(utils.seq(8));
        mod.swap64x2();
        deepStrictEqual(
          mod.segments.input64x2.subarray(0, 8),
          new Uint8Array([7, 6, 5, 4, 3, 2, 1, 0])
        );
      });
    });
    should('slices', () => {
      for (const swapEndianness of [false, true]) {
        for (const type of ['u32', 'u64', 'i32', 'i64']) {
          const c = swapEndianness ? CODERS_BE[type] : CODERS[type];
          const cI = P.array(15, c);
          const vType = minSimdType(type);
          const mod = new Module('slices')
            .mem('input', array(type, { swapEndianness }, 15))
            .mem('inputBatch', array(vType, { swapEndianness }, 15))
            .fn('add', ['i32', 'i32'], 'void', (f, pos) => {
              const T = f.types[type];
              const { input } = f.memory;
              const s = input.range(pos, 3).get();
              for (let i = 0; i < s.length; i++) s[i] = T.add(s[i], T.const(1));
              input.range(pos, 3).set(s);
            })
            .fn('addBatch', ['i32', 'i32'], 'void', (f, pos) => {
              const T = f.types[vType];
              const { inputBatch } = f.memory;
              const s = inputBatch.range(pos, 3).get();
              for (let i = 0; i < s.length; i++) s[i] = T.add(s[i], T.const(1));
              inputBatch.range(pos, 3).set(s);
            });
          const fixInt = (n) => (type === 'u64' || type === 'i64' ? BigInt(n) : n);
          testBoth(mod, (mod) => {
            mod.segments.input.set(cI.encode(utils.seq(15).map(fixInt)));
            for (const c of mod.segments.inputBatch_chunks)
              c.set(cI.encode(utils.seq(15).map(fixInt)));
            mod.add(3);
            mod.addBatch(3);
            deepStrictEqual(
              cI.decode(mod.segments.input),
              [0, 1, 2, 4, 5, 6, 6, 7, 8, 9, 10, 11, 12, 13, 14].map(fixInt)
            );
            // for (const c of mod.segments.inputBatch_chunks) {
            //   deepStrictEqual(
            //     cI.decode(c),
            //     [0, 1, 2, 4, 5, 6, 6, 7, 8, 9, 10, 11, 12, 13, 14].map(fixInt)
            //   );
            // }
            mod.add(4);
            mod.addBatch(4);
            deepStrictEqual(
              cI.decode(mod.segments.input),
              [0, 1, 2, 4, 6, 7, 7, 7, 8, 9, 10, 11, 12, 13, 14].map(fixInt)
            );
            // for (const c of mod.segments.inputBatch_chunks) {
            //   deepStrictEqual(
            //     cI.decode(c),
            //     [0, 1, 2, 4, 6, 7, 7, 7, 8, 9, 10, 11, 12, 13, 14].map(fixInt)
            //   );
            // }
            mod.add(5);
            mod.addBatch(5);
            deepStrictEqual(
              cI.decode(mod.segments.input),
              [0, 1, 2, 4, 6, 8, 8, 8, 8, 9, 10, 11, 12, 13, 14].map(fixInt)
            );
            // for (const c of mod.segments.inputBatch_chunks) {
            //   deepStrictEqual(
            //     cI.decode(c),
            //     [0, 1, 2, 4, 6, 8, 8, 8, 8, 9, 10, 11, 12, 13, 14].map(fixInt)
            //   );
            // }
            mod.add(6);
            mod.addBatch(6);
            deepStrictEqual(
              cI.decode(mod.segments.input),
              [0, 1, 2, 4, 6, 8, 9, 9, 9, 9, 10, 11, 12, 13, 14].map(fixInt)
            );
            // for (const c of mod.segments.inputBatch_chunks) {
            //   deepStrictEqual(
            //     cI.decode(c),
            //     [0, 1, 2, 4, 6, 8, 9, 9, 9, 9, 10, 11, 12, 13, 14].map(fixInt)
            //   );
            // }
            mod.add(7);
            mod.add(8);
            mod.add(9);
            mod.add(10);
            mod.add(11);
            mod.addBatch(7);
            mod.addBatch(8);
            mod.addBatch(9);
            mod.addBatch(10);
            mod.addBatch(11);
            deepStrictEqual(
              cI.decode(mod.segments.input),
              [0, 1, 2, 4, 6, 8, 9, 10, 11, 12, 13, 14, 14, 14, 14].map(fixInt)
            );
            // for (const c of mod.segments.inputBatch_chunks) {
            //   deepStrictEqual(
            //     cI.decode(c),
            //     [0, 1, 2, 4, 6, 8, 9, 10, 11, 12, 13, 14, 14, 14, 14].map(fixInt)
            //   );
            // }
          });
        }
      }
    });
    describe('memory2', () => {
      const fields = {
        chunksDone: 'u64',
        flags: 'u32',
        lastBlockRem: 'u32',
        stackPos: scalar('u32', { align: 10 }),
        test: scalar('u32', { align: 10 }),
        state: array('u32', {}, 8),
        state2: array('u64', { padSize: true }, 25),
        stack: array('u32', {}, 64, 8),
        stack2: array('u32', {}, 64, 8),
        nestedArr: array(struct({ a: 'u32', b: 'u64' }), {}, 5, 7),
        nestedArr2: array(array('u32', {}, 8), {}, 64), // array('u32', 64, 8)
        str: struct({
          tmp: 'u32',
          a: 'u64',
        }),
        stackPosSimd: 'u32x4',
        stackSimd: array('u32x4', {}, 64, 8),
      };
      const fmt = (f: any, op: FnOp) => {
        if (Array.isArray(op) && op.length === 1) return fmt(f, op[0]);
        const node = f.rawFn.ops.get(op.idx);
        if (node.kind !== 'op') throw new Error('fmt: non-op');
        const opts = Object.entries(node.opts || {})
          .filter(([k, v]) => v !== undefined)
          .filter(([k, v]) => !['weak', 'strong', 'rawOffset', 'type', 'scope'].includes(k))
          .map(([k, v]) => (['src'].includes(k) ? [k, fmt(f, f.rawFn.byIdx(v))] : [k, v]))
          .map(([k, v]) => [k, utils.isBytes(v) ? P.I128LE.decode(v) : v])
          .map(([k, v]) => `${k}=${v}`);
        const args = [...(node.args || []).map((i) => fmt(f, f.rawFn.byIdx(i))), ...opts];
        return `${node.type}.${node.op}(${args.join(', ')})`;
      };
      should('collapse', () => {
        // Array collapse
        deepStrictEqual(array(array('u32', {}, 8), {}, 64), array('u32', {}, 64, 8));
        deepStrictEqual(array(array('u32', {}, 16, 8), {}, 64), array('u32', {}, 64, 16, 8));
      });
      should('allocateMemSpec', () => {
        const x = struct(fields);
        const allocated = memory.allocateMemSpec(1, x);
        deepStrictEqual(memory.getRegionInfoPath(allocated.pre, 'chunksDone'), {
          pos: 80,
          size: 8,
          paddedSize: 8,
          spec: { kind: 'scalar', type: 'u64', opts: {} },
          opts: {},
          align: 8,
          alignEnd: 1,
        });
        deepStrictEqual(memory.getRegionInfoPath(allocated.pre, 'flags'), {
          pos: 88,
          size: 4,
          paddedSize: 4,
          spec: { kind: 'scalar', type: 'u32', opts: {} },
          opts: {},
          align: 4,
          alignEnd: 1,
        });
        deepStrictEqual(memory.getRegionInfoPath(allocated.pre, 'lastBlockRem'), {
          pos: 92,
          size: 4,
          paddedSize: 8,
          spec: { kind: 'scalar', type: 'u32', opts: {} },
          opts: {},
          align: 4,
          alignEnd: 1,
        });
        deepStrictEqual(memory.getRegionInfoPath(allocated.pre, 'stackPos'), {
          pos: 100,
          size: 4,
          paddedSize: 10,
          spec: { kind: 'scalar', type: 'u32', opts: { align: 10 } },
          opts: {},
          align: 10,
          alignEnd: 1,
        });
        deepStrictEqual(memory.getRegionInfoPath(allocated.pre, 'state'), {
          spec: {
            kind: 'array',
            type: { kind: 'scalar', type: 'u32', opts: {} },
            sizes: [8],
            opts: {},
          },
          inner: {
            spec: { kind: 'scalar', type: 'u32', opts: {} },
            size: 4,
            align: 4,
            alignEnd: 1,
            opts: {},
            paddedSize: 4,
          },
          size: 32,
          count: 8,
          align: 16,
          alignEnd: 16,
          opts: {},
          paddedSize: 32,
          pos: 128,
        });
        deepStrictEqual(memory.getRegionInfoPath(allocated.pre, 'state2'), {
          spec: {
            kind: 'array',
            type: { kind: 'scalar', type: 'u64', opts: {} },
            sizes: [25],
            opts: { padSize: true },
          },
          inner: {
            spec: { kind: 'scalar', type: 'u64', opts: {} },
            size: 8,
            align: 8,
            alignEnd: 1,
            opts: {},
            paddedSize: 8,
          },
          size: 200,
          count: 25,
          align: 16,
          alignEnd: 16,
          opts: { padSize: true },
          paddedSize: 208,
          pos: 160,
        });
        deepStrictEqual(memory.getRegionInfoPath(allocated.pre, 'stack'), {
          spec: {
            kind: 'array',
            type: { kind: 'scalar', type: 'u32', opts: {} },
            sizes: [64, 8],
            opts: {},
          },
          inner: {
            spec: { kind: 'scalar', type: 'u32', opts: {} },
            size: 4,
            align: 4,
            alignEnd: 1,
            opts: {},
            paddedSize: 4,
          },
          size: 2048,
          count: 512,
          align: 16,
          alignEnd: 16,
          opts: {},
          paddedSize: 2048,
          pos: 368,
        });
        deepStrictEqual(memory.getRegionInfoPath(allocated.pre, 'stack', 0), {
          spec: {
            kind: 'array',
            type: { kind: 'scalar', type: 'u32', opts: {} },
            sizes: [8],
            opts: {},
          },
          inner: {
            spec: { kind: 'scalar', type: 'u32', opts: {} },
            size: 4,
            align: 4,
            alignEnd: 1,
            opts: {},
            paddedSize: 4,
          },
          size: 32,
          count: 8,
          align: 16,
          alignEnd: 16,
          opts: {},
          paddedSize: 32,
          pos: 368,
        });
        deepStrictEqual(memory.getRegionInfoPath(allocated.pre, 'stack', 1), {
          spec: {
            kind: 'array',
            type: { kind: 'scalar', type: 'u32', opts: {} },
            sizes: [8],
            opts: {},
          },
          inner: {
            spec: { kind: 'scalar', type: 'u32', opts: {} },
            size: 4,
            align: 4,
            alignEnd: 1,
            opts: {},
            paddedSize: 4,
          },
          size: 32,
          count: 8,
          align: 16,
          alignEnd: 16,
          opts: {},
          paddedSize: 32,
          pos: 400,
        });
        deepStrictEqual(memory.getRegionInfoPath(allocated.pre, 'stack', 1, 1), {
          spec: { kind: 'scalar', type: 'u32', opts: {} },
          size: 4,
          align: 4,
          alignEnd: 1,
          opts: {},
          paddedSize: 4,
          pos: 404,
        });
        // Symbolic
        deepStrictEqual(memory.getRegionInfoPath(allocated.pre, 'stack', { id: 1 }), {
          spec: {
            kind: 'array',
            type: { kind: 'scalar', type: 'u32', opts: {} },
            sizes: [8],
            opts: {},
          },
          inner: {
            spec: { kind: 'scalar', type: 'u32', opts: {} },
            size: 4,
            align: 4,
            alignEnd: 1,
            opts: {},
            paddedSize: 4,
          },
          size: 32,
          count: 8,
          align: 16,
          alignEnd: 16,
          opts: {},
          paddedSize: 32,
          pos: {
            base: 368,
            baseMul: [],
            syms: [{ id: 1 }],
            coeffs: [32],
          },
        });

        deepStrictEqual(
          memory.PosExpr.eval(memory.getRegionInfoPath(allocated.pre, 'stack', {}).pos, [0]),
          memory.getRegionInfoPath(allocated.pre, 'stack', 0).pos
        );
        deepStrictEqual(
          memory.PosExpr.eval(memory.getRegionInfoPath(allocated.pre, 'stack', {}).pos, [1]),
          memory.getRegionInfoPath(allocated.pre, 'stack', 1).pos
        );
        deepStrictEqual(
          memory.PosExpr.eval(memory.getRegionInfoPath(allocated.pre, 'stack', {}).pos, [5]),
          memory.getRegionInfoPath(allocated.pre, 'stack', 5).pos
        );
        deepStrictEqual(
          memory.PosExpr.eval(memory.getRegionInfoPath(allocated.pre, 'stack', {}, {}).pos, [1, 1]),
          memory.getRegionInfoPath(allocated.pre, 'stack', 1, 1).pos
        );
        deepStrictEqual(memory.getRegionInfoPath(allocated.pre, 'nestedArr'), {
          spec: {
            kind: 'array',
            type: {
              kind: 'struct',
              fields: {
                a: { kind: 'scalar', type: 'u32', opts: {} },
                b: { kind: 'scalar', type: 'u64', opts: {} },
              },
              opts: {},
            },
            sizes: [5, 7],
            opts: {},
          },
          inner: {
            spec: {
              kind: 'struct',
              fields: {
                a: { kind: 'scalar', type: 'u32', opts: {} },
                b: { kind: 'scalar', type: 'u64', opts: {} },
              },
              opts: {},
            },
            fields: {
              a: {
                spec: { kind: 'scalar', type: 'u32', opts: {} },
                size: 4,
                align: 4,
                alignEnd: 1,
                opts: {},
                paddedSize: 8,
              },
              b: {
                spec: { kind: 'scalar', type: 'u64', opts: {} },
                size: 8,
                align: 8,
                alignEnd: 1,
                opts: {},
                paddedSize: 8,
              },
            },
            size: 16,
            align: 8,
            alignEnd: 1,
            opts: {},
            paddedSize: 16,
          },
          size: 560,
          count: 35,
          align: 16,
          alignEnd: 16,
          opts: {},
          paddedSize: 560,
          pos: 4464,
        });
        deepStrictEqual(memory.getRegionInfoPath(allocated.pre, 'nestedArr', 0), {
          spec: {
            kind: 'array',
            type: {
              kind: 'struct',
              fields: {
                a: { kind: 'scalar', type: 'u32', opts: {} },
                b: { kind: 'scalar', type: 'u64', opts: {} },
              },
              opts: {},
            },
            sizes: [7],
            opts: {},
          },
          inner: {
            spec: {
              kind: 'struct',
              fields: {
                a: { kind: 'scalar', type: 'u32', opts: {} },
                b: { kind: 'scalar', type: 'u64', opts: {} },
              },
              opts: {},
            },
            fields: {
              a: {
                spec: { kind: 'scalar', type: 'u32', opts: {} },
                size: 4,
                align: 4,
                alignEnd: 1,
                opts: {},
                paddedSize: 8,
              },
              b: {
                spec: { kind: 'scalar', type: 'u64', opts: {} },
                size: 8,
                align: 8,
                alignEnd: 1,
                opts: {},
                paddedSize: 8,
              },
            },
            size: 16,
            align: 8,
            alignEnd: 1,
            opts: {},
            paddedSize: 16,
          },
          size: 112,
          count: 7,
          align: 16,
          alignEnd: 16,
          opts: {},
          paddedSize: 112,
          pos: 4464,
        });
        deepStrictEqual(memory.getRegionInfoPath(allocated.pre, 'nestedArr', 1), {
          spec: {
            kind: 'array',
            type: {
              kind: 'struct',
              fields: {
                a: { kind: 'scalar', type: 'u32', opts: {} },
                b: { kind: 'scalar', type: 'u64', opts: {} },
              },
              opts: {},
            },
            sizes: [7],
            opts: {},
          },
          inner: {
            spec: {
              kind: 'struct',
              fields: {
                a: { kind: 'scalar', type: 'u32', opts: {} },
                b: { kind: 'scalar', type: 'u64', opts: {} },
              },
              opts: {},
            },
            fields: {
              a: {
                spec: { kind: 'scalar', type: 'u32', opts: {} },
                size: 4,
                align: 4,
                alignEnd: 1,
                opts: {},
                paddedSize: 8,
              },
              b: {
                spec: { kind: 'scalar', type: 'u64', opts: {} },
                size: 8,
                align: 8,
                alignEnd: 1,
                opts: {},
                paddedSize: 8,
              },
            },
            size: 16,
            align: 8,
            alignEnd: 1,
            opts: {},
            paddedSize: 16,
          },
          size: 112,
          count: 7,
          align: 16,
          alignEnd: 16,
          opts: {},
          paddedSize: 112,
          pos: 4576,
        });
        deepStrictEqual(memory.getRegionInfoPath(allocated.pre, 'nestedArr', 4), {
          spec: {
            kind: 'array',
            type: {
              kind: 'struct',
              fields: {
                a: { kind: 'scalar', type: 'u32', opts: {} },
                b: { kind: 'scalar', type: 'u64', opts: {} },
              },
              opts: {},
            },
            sizes: [7],
            opts: {},
          },
          inner: {
            spec: {
              kind: 'struct',
              fields: {
                a: { kind: 'scalar', type: 'u32', opts: {} },
                b: { kind: 'scalar', type: 'u64', opts: {} },
              },
              opts: {},
            },
            fields: {
              a: {
                spec: { kind: 'scalar', type: 'u32', opts: {} },
                size: 4,
                align: 4,
                alignEnd: 1,
                opts: {},
                paddedSize: 8,
              },
              b: {
                spec: { kind: 'scalar', type: 'u64', opts: {} },
                size: 8,
                align: 8,
                alignEnd: 1,
                opts: {},
                paddedSize: 8,
              },
            },
            size: 16,
            align: 8,
            alignEnd: 1,
            opts: {},
            paddedSize: 16,
          },
          size: 112,
          count: 7,
          align: 16,
          alignEnd: 16,
          opts: {},
          paddedSize: 112,
          pos: 4912,
        });
        deepStrictEqual(memory.getRegionInfoPath(allocated.pre, 'nestedArr', 0, 0), {
          spec: {
            kind: 'struct',
            fields: {
              a: { kind: 'scalar', type: 'u32', opts: {} },
              b: { kind: 'scalar', type: 'u64', opts: {} },
            },
            opts: {},
          },
          fields: {
            a: {
              spec: { kind: 'scalar', type: 'u32', opts: {} },
              size: 4,
              align: 4,
              alignEnd: 1,
              opts: {},
              paddedSize: 8,
            },
            b: {
              spec: { kind: 'scalar', type: 'u64', opts: {} },
              size: 8,
              align: 8,
              alignEnd: 1,
              opts: {},
              paddedSize: 8,
            },
          },
          size: 16,
          align: 8,
          alignEnd: 1,
          opts: {},
          paddedSize: 16,
          pos: 4464,
        });
        deepStrictEqual(memory.getRegionInfoPath(allocated.pre, 'nestedArr', 0, 0, 'a'), {
          spec: { kind: 'scalar', type: 'u32', opts: {} },
          size: 4,
          align: 4,
          alignEnd: 1,
          opts: {},
          paddedSize: 8,
          pos: 4464,
        });
        deepStrictEqual(memory.getRegionInfoPath(allocated.pre, 'nestedArr', 0, 0, 'b'), {
          spec: { kind: 'scalar', type: 'u64', opts: {} },
          size: 8,
          align: 8,
          alignEnd: 1,
          opts: {},
          paddedSize: 8,
          pos: 4472,
        });
        deepStrictEqual(memory.getRegionInfoPath(allocated.pre, 'nestedArr2'), {
          spec: {
            kind: 'array',
            type: { kind: 'scalar', type: 'u32', opts: {} },
            sizes: [64, 8],
            opts: {},
          },
          inner: {
            spec: { kind: 'scalar', type: 'u32', opts: {} },
            size: 4,
            align: 4,
            alignEnd: 1,
            opts: {},
            paddedSize: 4,
          },
          size: 2048,
          count: 512,
          align: 16,
          alignEnd: 16,
          opts: {},
          paddedSize: 2048,
          pos: 5024,
        });
        deepStrictEqual(memory.getRegionInfoPath(allocated.pre, 'str'), {
          spec: {
            kind: 'struct',
            fields: {
              tmp: { kind: 'scalar', type: 'u32', opts: {} },
              a: { kind: 'scalar', type: 'u64', opts: {} },
            },
            opts: {},
          },
          fields: {
            tmp: {
              spec: { kind: 'scalar', type: 'u32', opts: {} },
              size: 4,
              align: 4,
              alignEnd: 1,
              opts: {},
              paddedSize: 8,
              pos: 7072,
            },
            a: {
              spec: { kind: 'scalar', type: 'u64', opts: {} },
              size: 8,
              align: 8,
              alignEnd: 1,
              opts: {},
              paddedSize: 8,
              pos: 7080,
            },
          },
          size: 16,
          align: 8,
          alignEnd: 1,
          opts: {},
          paddedSize: 16,
          pos: 7072,
        });
        deepStrictEqual(memory.getRegionInfoPath(allocated.pre, 'str', 'tmp'), {
          spec: { kind: 'scalar', type: 'u32', opts: {} },
          size: 4,
          align: 4,
          alignEnd: 1,
          opts: {},
          paddedSize: 8,
          pos: 7072,
        });
        deepStrictEqual(memory.getRegionInfoPath(allocated.pre), {
          spec: {
            kind: 'struct',
            fields: {
              chunksDone: { kind: 'scalar', type: 'u64', opts: {} },
              flags: { kind: 'scalar', type: 'u32', opts: {} },
              lastBlockRem: { kind: 'scalar', type: 'u32', opts: {} },
              stackPos: { kind: 'scalar', type: 'u32', opts: { align: 10 } },
              test: { kind: 'scalar', type: 'u32', opts: { align: 10 } },
              state: {
                kind: 'array',
                type: { kind: 'scalar', type: 'u32', opts: {} },
                sizes: [8],
                opts: {},
              },
              state2: {
                kind: 'array',
                type: { kind: 'scalar', type: 'u64', opts: {} },
                sizes: [25],
                opts: { padSize: true },
              },
              stack: {
                kind: 'array',
                type: { kind: 'scalar', type: 'u32', opts: {} },
                sizes: [64, 8],
                opts: {},
              },
              stack2: {
                kind: 'array',
                type: { kind: 'scalar', type: 'u32', opts: {} },
                sizes: [64, 8],
                opts: {},
              },
              nestedArr: {
                kind: 'array',
                type: {
                  kind: 'struct',
                  fields: {
                    a: { kind: 'scalar', type: 'u32', opts: {} },
                    b: { kind: 'scalar', type: 'u64', opts: {} },
                  },
                  opts: {},
                },
                sizes: [5, 7],
                opts: {},
              },
              nestedArr2: {
                kind: 'array',
                type: { kind: 'scalar', type: 'u32', opts: {} },
                sizes: [64, 8],
                opts: {},
              },
              str: {
                kind: 'struct',
                fields: {
                  tmp: { kind: 'scalar', type: 'u32', opts: {} },
                  a: { kind: 'scalar', type: 'u64', opts: {} },
                },
                opts: {},
              },
              stackPosSimd: { kind: 'scalar', type: 'u32x4', opts: {} },
              stackSimd: {
                kind: 'array',
                type: { kind: 'scalar', type: 'u32x4', opts: {} },
                sizes: [64, 8],
                opts: {},
              },
            },
            opts: {},
          },
          fields: {
            chunksDone: {
              spec: { kind: 'scalar', type: 'u64', opts: {} },
              size: 8,
              align: 8,
              alignEnd: 1,
              opts: {},
              paddedSize: 8,
              pos: 80,
            },
            flags: {
              spec: { kind: 'scalar', type: 'u32', opts: {} },
              size: 4,
              align: 4,
              alignEnd: 1,
              opts: {},
              paddedSize: 4,
              pos: 88,
            },
            lastBlockRem: {
              spec: { kind: 'scalar', type: 'u32', opts: {} },
              size: 4,
              align: 4,
              alignEnd: 1,
              opts: {},
              paddedSize: 8,
              pos: 92,
            },
            stackPos: {
              spec: { kind: 'scalar', type: 'u32', opts: { align: 10 } },
              size: 4,
              align: 10,
              alignEnd: 1,
              opts: {},
              paddedSize: 10,
              pos: 100,
            },
            test: {
              spec: { kind: 'scalar', type: 'u32', opts: { align: 10 } },
              size: 4,
              align: 10,
              alignEnd: 1,
              opts: {},
              paddedSize: 18,
              pos: 110,
            },
            state: {
              spec: {
                kind: 'array',
                type: { kind: 'scalar', type: 'u32', opts: {} },
                sizes: [8],
                opts: {},
              },
              inner: {
                spec: { kind: 'scalar', type: 'u32', opts: {} },
                size: 4,
                align: 4,
                alignEnd: 1,
                opts: {},
                paddedSize: 4,
              },
              size: 32,
              count: 8,
              align: 16,
              alignEnd: 16,
              opts: {},
              paddedSize: 32,
              pos: 128,
            },
            state2: {
              spec: {
                kind: 'array',
                type: { kind: 'scalar', type: 'u64', opts: {} },
                sizes: [25],
                opts: { padSize: true },
              },
              inner: {
                spec: { kind: 'scalar', type: 'u64', opts: {} },
                size: 8,
                align: 8,
                alignEnd: 1,
                opts: {},
                paddedSize: 8,
              },
              size: 200,
              count: 25,
              align: 16,
              alignEnd: 16,
              opts: { padSize: true },
              paddedSize: 208,
              pos: 160,
            },
            stack: {
              spec: {
                kind: 'array',
                type: { kind: 'scalar', type: 'u32', opts: {} },
                sizes: [64, 8],
                opts: {},
              },
              inner: {
                spec: { kind: 'scalar', type: 'u32', opts: {} },
                size: 4,
                align: 4,
                alignEnd: 1,
                opts: {},
                paddedSize: 4,
              },
              size: 2048,
              count: 512,
              align: 16,
              alignEnd: 16,
              opts: {},
              paddedSize: 2048,
              pos: 368,
            },
            stack2: {
              spec: {
                kind: 'array',
                type: { kind: 'scalar', type: 'u32', opts: {} },
                sizes: [64, 8],
                opts: {},
              },
              inner: {
                spec: { kind: 'scalar', type: 'u32', opts: {} },
                size: 4,
                align: 4,
                alignEnd: 1,
                opts: {},
                paddedSize: 4,
              },
              size: 2048,
              count: 512,
              align: 16,
              alignEnd: 16,
              opts: {},
              paddedSize: 2048,
              pos: 2416,
            },
            nestedArr: {
              spec: {
                kind: 'array',
                type: {
                  kind: 'struct',
                  fields: {
                    a: { kind: 'scalar', type: 'u32', opts: {} },
                    b: { kind: 'scalar', type: 'u64', opts: {} },
                  },
                  opts: {},
                },
                sizes: [5, 7],
                opts: {},
              },
              inner: {
                spec: {
                  kind: 'struct',
                  fields: {
                    a: { kind: 'scalar', type: 'u32', opts: {} },
                    b: { kind: 'scalar', type: 'u64', opts: {} },
                  },
                  opts: {},
                },
                fields: {
                  a: {
                    spec: { kind: 'scalar', type: 'u32', opts: {} },
                    size: 4,
                    align: 4,
                    alignEnd: 1,
                    opts: {},
                    paddedSize: 8,
                  },
                  b: {
                    spec: { kind: 'scalar', type: 'u64', opts: {} },
                    size: 8,
                    align: 8,
                    alignEnd: 1,
                    opts: {},
                    paddedSize: 8,
                  },
                },
                size: 16,
                align: 8,
                alignEnd: 1,
                opts: {},
                paddedSize: 16,
              },
              size: 560,
              count: 35,
              align: 16,
              alignEnd: 16,
              opts: {},
              paddedSize: 560,
              pos: 4464,
            },
            nestedArr2: {
              spec: {
                kind: 'array',
                type: { kind: 'scalar', type: 'u32', opts: {} },
                sizes: [64, 8],
                opts: {},
              },
              inner: {
                spec: { kind: 'scalar', type: 'u32', opts: {} },
                size: 4,
                align: 4,
                alignEnd: 1,
                opts: {},
                paddedSize: 4,
              },
              size: 2048,
              count: 512,
              align: 16,
              alignEnd: 16,
              opts: {},
              paddedSize: 2048,
              pos: 5024,
            },
            str: {
              spec: {
                kind: 'struct',
                fields: {
                  tmp: { kind: 'scalar', type: 'u32', opts: {} },
                  a: { kind: 'scalar', type: 'u64', opts: {} },
                },
                opts: {},
              },
              fields: {
                tmp: {
                  spec: { kind: 'scalar', type: 'u32', opts: {} },
                  size: 4,
                  align: 4,
                  alignEnd: 1,
                  opts: {},
                  paddedSize: 8,
                  pos: 7072,
                },
                a: {
                  spec: { kind: 'scalar', type: 'u64', opts: {} },
                  size: 8,
                  align: 8,
                  alignEnd: 1,
                  opts: {},
                  paddedSize: 8,
                  pos: 7080,
                },
              },
              size: 16,
              align: 8,
              alignEnd: 1,
              opts: {},
              paddedSize: 16,
              pos: 7072,
            },
            stackPosSimd: {
              spec: { kind: 'scalar', type: 'u32x4', opts: {} },
              size: 16,
              align: 16,
              alignEnd: 1,
              opts: {},
              paddedSize: 16,
              pos: 7088,
            },
            stackSimd: {
              spec: {
                kind: 'array',
                type: { kind: 'scalar', type: 'u32x4', opts: {} },
                sizes: [64, 8],
                opts: {},
              },
              inner: {
                spec: { kind: 'scalar', type: 'u32x4', opts: {} },
                size: 16,
                align: 16,
                alignEnd: 1,
                opts: {},
                paddedSize: 16,
              },
              size: 8192,
              count: 512,
              align: 16,
              alignEnd: 16,
              opts: {},
              paddedSize: 8192,
              pos: 7104,
            },
          },
          size: 15216,
          align: 80,
          alignEnd: 1,
          opts: {},
          paddedSize: 15216,
          pos: 80,
          subRegions: {
            '': [80, 15216, 1, 15216],
            chunksDone: [80, 8, 1, 8],
            flags: [88, 4, 1, 4],
            lastBlockRem: [92, 4, 1, 4],
            stackPos: [100, 4, 1, 4],
            test: [110, 4, 1, 4],
            state: [128, 32, 1, 32],
            state2: [160, 200, 1, 200],
            stack: [368, 2048, 1, 2048],
            stack2: [2416, 2048, 1, 2048],
            nestedArr: [4464, 560, 1, 560],
            nestedArr2: [5024, 2048, 1, 2048],
            str: [7072, 16, 1, 16],
            'str.tmp': [7072, 4, 1, 4],
            'str.a': [7080, 8, 1, 8],
            stackPosSimd: [7088, 16, 1, 16],
            stackSimd: [7104, 8192, 1, 8192],
          },
        });
        deepStrictEqual(allocated.pos, 15296);
      });
      should('memoryProxy', () => {
        const memOpsMock: MemOps = (f: any, name: string, region: RegionExpr): MemHandle => {
          let suf = '';
          if (region.view && (region.view as any).addr === 'byte') {
            const v: any = region.view;
            suf += ':b' + String(v.width);
            if (v.mode) suf += '-' + v.mode; // b1-array | b1-scalar
            if (v.vecPref) suf += '+' + v.vecPref; // b1-scalar+simd
          } else if (region.view && (region.view as any).vecPref) {
            suf += ':' + String((region.view as any).vecPref);
          }

          const tag = (t: string) => ({ op: t + suf, region });

          return {
            get: () => tag('get'),
            set: (_: any) => void 0,
            range: (pos?: any, len?: any) => [tag('range'), pos, len],
            copyFrom: (_: any) => void 0,
            fill: (_: any) => void 0,
            zero: () => void 0,
            atomics: {
              load: () => tag('atomics.load' + suf),
              store: (_: any) => void 0,
              add: (_: any) => tag('atomics.add' + suf),
              sub: (_: any) => tag('atomics.sub' + suf),
              and: (_: any) => tag('atomics.and' + suf),
              or: (_: any) => tag('atomics.or' + suf),
              xor: (_: any) => tag('atomics.xor' + suf),
              exchange: (_: any) => tag('atomics.exchange' + suf),
              compareExchange: (_: any, __: any) => tag('atomics.cmpxchg' + suf),
            },
          };
        };

        const x = struct(fields);
        const allocated = memory.allocateMemSpec(8, x);
        // getRegionInfo as argument was removed, it is in same file. We don't need pass function as argument here.
        const proxy = memory.memoryProxy(
          {
            byIdx: (idx) => ({ idx }),
          },
          'test',
          allocated.pre,
          memOpsMock
        );
        deepStrictEqual(proxy.chunksDone.get(), {
          op: 'get',
          region: {
            pos: 80,
            size: 8,
            paddedSize: 8,
            spec: { kind: 'scalar', type: 'u64', opts: {} },
            opts: {},
          },
        });
        deepStrictEqual(proxy.stack[1][1].get(), {
          op: 'get',
          region: {
            pos: 404,
            size: 4,
            paddedSize: 4,
            spec: { kind: 'scalar', type: 'u32', opts: {} },
            opts: {},
          },
        });
        const sym = new FnOp('test');

        deepStrictEqual(proxy.stack[sym][1].get(), {
          op: 'get',
          region: {
            size: 4,
            paddedSize: 4,
            spec: { kind: 'scalar', type: 'u32', opts: {} },
            pos: { base: 372, baseMul: [], syms: [{ idx: 'test' }], coeffs: [32] },
            opts: {},
          },
        });
        deepStrictEqual(proxy.stack[0].get(), {
          op: 'get',
          region: {
            pos: 368,
            count: 8,
            size: 32,
            paddedSize: 32,
            spec: {
              kind: 'array',
              type: { kind: 'scalar', type: 'u32', opts: {} },
              sizes: [8],
              opts: {},
            },
            opts: {},
          },
        });
        deepStrictEqual(proxy.stack[0].atomics.load(), {
          op: 'atomics.load',
          region: {
            pos: 368,
            count: 8,
            size: 32,
            paddedSize: 32,
            spec: {
              kind: 'array',
              type: { kind: 'scalar', type: 'u32', opts: {} },
              sizes: [8],
              opts: {},
            },
            opts: {},
          },
        });
        deepStrictEqual(proxy.stack[0].as8().get(), {
          op: 'get',
          region: {
            pos: 368,
            count: 32,
            size: 32,
            paddedSize: 32,
            spec: {
              kind: 'array',
              type: { kind: 'scalar', type: 'u32', opts: {}, size: 1 },
              sizes: [32],
              opts: {},
            },
            opts: {},
          },
        });
        deepStrictEqual(proxy.stack[0].as8()[1].get(), {
          op: 'get',
          region: {
            size: 1,
            paddedSize: 1,
            spec: { kind: 'scalar', type: 'u32', opts: {}, size: 1 },
            opts: {},
            pos: 369,
          },
        });
        deepStrictEqual(proxy.stack[0].as8()[sym].get(), {
          op: 'get',
          region: {
            size: 1,
            paddedSize: 1,
            spec: { kind: 'scalar', type: 'u32', opts: {}, size: 1 },
            opts: {},
            pos: {
              base: 368,
              baseMul: [],
              syms: [{ idx: 'test' }],
              coeffs: [1],
            },
          },
        });
        deepStrictEqual(proxy.stack[0].as32()[0].as8()[1].get(), {
          op: 'get',
          region: {
            size: 1,
            paddedSize: 1,
            spec: { kind: 'scalar', type: 'u32', opts: {}, size: 1 },
            opts: {},
            pos: 369,
          },
        });
        deepStrictEqual(proxy.stack[0].as32()[1].as8()[1].get(), {
          op: 'get',
          region: {
            size: 1,
            paddedSize: 1,
            spec: { kind: 'scalar', type: 'u32', opts: {}, size: 1 },
            opts: {},
            pos: 373,
          },
        });
        deepStrictEqual(proxy.stack[0].get(), {
          op: 'get',
          region: {
            size: 32,
            paddedSize: 32,
            spec: {
              kind: 'array',
              type: { kind: 'scalar', type: 'u32', opts: {} },
              sizes: [8],
              opts: {},
            },
            pos: 368,
            count: 8,
            opts: {},
          },
        });
        deepStrictEqual(proxy.stack[0].get(), {
          op: 'get',
          region: {
            size: 32,
            paddedSize: 32,
            spec: {
              kind: 'array',
              type: { kind: 'scalar', type: 'u32', opts: {} },
              sizes: [8],
              opts: {},
            },
            pos: 368,
            count: 8,
            opts: {},
          },
        });
        deepStrictEqual(proxy.stack[0].as8()[1].get(), {
          op: 'get',
          region: {
            size: 1,
            paddedSize: 1,
            spec: { kind: 'scalar', type: 'u32', opts: {}, size: 1 },
            opts: {},
            pos: 369,
          },
        });
        const sym1 = new FnOp('1');
        const sym2 = new FnOp('2');
        const tmp = proxy.stack[sym1].as8()[sym2].get();
        for (const [a, b] of [
          [1, 1],
          [2, 2],
          [1, 2],
          [0, 1],
          [0, 2],
          [2, 1],
          [2, 0],
          [5, 5],
          [0, 7],
          [7, 0],
          [5, 0],
          [1, 5],
          [7, 7],
        ]) {
          deepStrictEqual(
            memory.PosExpr.eval(tmp.region.pos, [a, b]),
            proxy.stack[a].as8()[b].get().region.pos
          );
        }
        throws(() => proxy.wat);
        throws(() => proxy.state[100]);
        throws(() => proxy.state[8]);
        proxy.state[7];
      });
      should('basic', () => {
        let called = false;

        const mod = new Module('wat')
          .mem('tmp', array('u32', {}, 4, 6))
          .mem('test', struct(fields))
          .mem('testBE', struct(fields, { swapEndianness: true }))
          .mem('smallBE', array('u32', { swapEndianness: true }, 5))
          .batchMem('smallBE_batch', array('u32', { swapEndianness: true }, 5))
          .batchMem('state', struct({ counter: 'u64', state: array('u32', {}, 5) }))
          .batchMem('buffer', array('u32', { swapEndianness: true }, 16 + 1, 16))
          .batchFn(
            'processOutBlocks',
            { lanes: 1 },
            ['u32', 'u32', 'u32', 'u32'],
            (f, type, batchPos, _blocks, _outBlockLen, _isLast) => {
              const { state } = f.memory.state[batchPos];
              const buffer = f.memory.buffer[batchPos];
              const S = state.get();
              deepStrictEqual(
                buffer[0]
                  .range(0, S.length)
                  .set(S)
                  .map((i) => fmt(f, i)),
                [
                  'u32x4.store(u32.add(u32.mul(u32.add(u32.arg(pos=0), u32.arg(pos=0)), u32.const(value=1088)), u32.const(value=30768)), u32x4.shuffle(u32x4.replace_lane(u32x4.replace_lane(u32x4.replace_lane(u32x4.replace_lane(u32x4.const(value=0), u32.load(u32.add(u32.mul(u32.add(u32.arg(pos=0), u32.arg(pos=0)), u32.const(value=48)), u32.const(value=30736)), align=2, name=state), lane=0), u32.load(u32.add(u32.add(u32.mul(u32.add(u32.arg(pos=0), u32.arg(pos=0)), u32.const(value=48)), u32.const(value=30736)), u32.const(value=4)), align=2, name=state), lane=1), u32.load(u32.add(u32.add(u32.add(u32.mul(u32.add(u32.arg(pos=0), u32.arg(pos=0)), u32.const(value=48)), u32.const(value=30736)), u32.const(value=4)), u32.const(value=4)), align=2, name=state), lane=2), u32.load(u32.add(u32.add(u32.add(u32.add(u32.mul(u32.add(u32.arg(pos=0), u32.arg(pos=0)), u32.const(value=48)), u32.const(value=30736)), u32.const(value=4)), u32.const(value=4)), u32.const(value=4)), align=2, name=state), lane=3), u32x4.replace_lane(u32x4.replace_lane(u32x4.replace_lane(u32x4.replace_lane(u32x4.const(value=0), u32.load(u32.add(u32.mul(u32.add(u32.arg(pos=0), u32.arg(pos=0)), u32.const(value=48)), u32.const(value=30736)), align=2, name=state), lane=0), u32.load(u32.add(u32.add(u32.mul(u32.add(u32.arg(pos=0), u32.arg(pos=0)), u32.const(value=48)), u32.const(value=30736)), u32.const(value=4)), align=2, name=state), lane=1), u32.load(u32.add(u32.add(u32.add(u32.mul(u32.add(u32.arg(pos=0), u32.arg(pos=0)), u32.const(value=48)), u32.const(value=30736)), u32.const(value=4)), u32.const(value=4)), align=2, name=state), lane=2), u32.load(u32.add(u32.add(u32.add(u32.add(u32.mul(u32.add(u32.arg(pos=0), u32.arg(pos=0)), u32.const(value=48)), u32.const(value=30736)), u32.const(value=4)), u32.const(value=4)), u32.const(value=4)), align=2, name=state), lane=3), pattern=3,2,1,0,7,6,5,4,11,10,9,8,15,14,13,12), align=4, name=buffer, isMut=true)',
                  'u32.store(u32.add(u32.add(u32.mul(u32.add(u32.arg(pos=0), u32.arg(pos=0)), u32.const(value=1088)), u32.const(value=30768)), u32.const(value=16)), u32x4.extract_lane(u32x4.shuffle(u32x4.replace_lane(u32x4.const(value=0), u32.load(u32.add(u32.add(u32.add(u32.add(u32.add(u32.mul(u32.add(u32.arg(pos=0), u32.arg(pos=0)), u32.const(value=48)), u32.const(value=30736)), u32.const(value=4)), u32.const(value=4)), u32.const(value=4)), u32.const(value=4)), align=2, name=state), lane=0), u32x4.replace_lane(u32x4.const(value=0), u32.load(u32.add(u32.add(u32.add(u32.add(u32.add(u32.mul(u32.add(u32.arg(pos=0), u32.arg(pos=0)), u32.const(value=48)), u32.const(value=30736)), u32.const(value=4)), u32.const(value=4)), u32.const(value=4)), u32.const(value=4)), align=2, name=state), lane=0), pattern=3,2,1,0,7,6,5,4,11,10,9,8,15,14,13,12), lane=0), align=2, name=buffer, isMut=true)',
                ]
              );
            }
          )
          .fn('test', [], 'void', (f) => {
            const { u32, u64 } = f.types;
            deepStrictEqual(f.memory.test.chunksDone.region, {
              opts: {},
              size: 8,
              paddedSize: 8,
              spec: { kind: 'scalar', type: 'u64', opts: {} },
              pos: 160,
            });
            deepStrictEqual(f.memory.testBE.chunksDone.region, {
              opts: {}, // should be swapEndianess: true
              size: 8,
              paddedSize: 8,
              spec: { kind: 'scalar', type: 'u64', opts: {} },
              pos: 15440,
              opts: { swapEndianness: true },
            });
            deepStrictEqual(
              fmt(f, f.memory.test.chunksDone.get()),
              'u64.load(u32.const(value=0), align=5, name=test, offset=160)'
            );
            deepStrictEqual(
              fmt(f, f.memory.testBE.chunksDone.get()),
              'u64x2.extract_lane(u64x2.shuffle(u64x2.splat(u64.load(u32.const(value=0), align=4, name=testBE, offset=15440)), u64x2.splat(u64.load(u32.const(value=0), align=4, name=testBE, offset=15440)), pattern=7,6,5,4,3,2,1,0,15,14,13,12,11,10,9,8), lane=0)'
            );
            // byte level
            deepStrictEqual(
              fmt(f, f.memory.test.chunksDone.as8('u64')[0].get()),
              'u64.load(u32.const(value=0), size=8, align=0, name=test, offset=160)'
            );
            deepStrictEqual(
              fmt(f, f.memory.test.chunksDone.set(u64.const(123))),
              'u64.store(u32.const(value=0), u64.const(value=123), align=5, name=test, offset=160, isMut=true)'
            );
            deepStrictEqual(
              fmt(f, f.memory.test.chunksDone.as8()[0].fill(0xff)),
              'i32.fill(u32.const(value=160), u32.const(value=255), u32.const(value=1), name=test, isMut=true)'
            );
            deepStrictEqual(f.memory.test.chunksDone.region, {
              size: 8,
              paddedSize: 8,
              spec: { kind: 'scalar', type: 'u64', opts: {} },
              opts: {},
              pos: 160,
            });
            deepStrictEqual(
              fmt(f, f.memory.test.chunksDone.as8().fill(0xff)),
              'i32.fill(u32.const(value=160), u32.const(value=255), u32.const(value=8), name=test, isMut=true)'
            );
            deepStrictEqual(
              fmt(f, f.memory.test.chunksDone.as8().range(undefined, 2).fill(0xff)),
              'i32.fill(u32.const(value=160), u32.const(value=255), u32.const(value=2), name=test, isMut=true)'
            );
            deepStrictEqual(
              fmt(f, f.memory.test.chunksDone.as8().range(1).fill(0xff)),
              'i32.fill(u32.const(value=161), u32.const(value=255), u32.const(value=7), name=test, isMut=true)'
            );
            deepStrictEqual(
              fmt(f, f.memory.test.chunksDone.as8().range(1, 3).fill(0xff)),
              'i32.fill(u32.const(value=161), u32.const(value=255), u32.const(value=3), name=test, isMut=true)'
            );
            deepStrictEqual(
              fmt(f, f.memory.test.chunksDone.as8().range(u32.const(1), 3).fill(0xff)),
              'i32.fill(u32.add(u32.const(value=1), u32.const(value=160)), u32.const(value=255), u32.const(value=3), name=test, isMut=true)'
            );
            throws(() => f.memory.test.chunksDone.as8().range(u32.const(1)));
            deepStrictEqual(f.memory.test.chunksDone.as8().range(8).region, {
              size: 0,
              paddedSize: 0,
              spec: {
                kind: 'array',
                type: { kind: 'scalar', type: 'u32', opts: {}, size: 1 },
                sizes: [0],
                opts: {},
              },
              opts: {},
              pos: 168,
              count: 0,
            });
            deepStrictEqual(
              fmt(f, f.memory.test.chunksDone.as16().range(1, 3).as8().fill(0xff)),
              'i32.fill(u32.const(value=162), u32.const(value=255), u32.const(value=6), name=test, isMut=true)'
            );
            deepStrictEqual(
              fmt(f, f.memory.test.chunksDone.as16().range(u32.const(3), 2).as8().fill(0x7e)),
              'i32.fill(u32.add(u32.mul(u32.const(value=3), u32.const(value=2)), u32.const(value=160)), u32.const(value=126), u32.const(value=4), name=test, isMut=true)'
            );
            deepStrictEqual(
              fmt(f, f.memory.test.chunksDone.as32().range(1).as8().fill(0x7e)),
              'i32.fill(u32.const(value=164), u32.const(value=126), u32.const(value=4), name=test, isMut=true)'
            );
            // Overrun
            throws(() => f.memory.test.chunksDone.as16().range(100).as8().fill(0));
            deepStrictEqual(
              fmt(f, f.memory.test.chunksDone.as16().range(1, 3).range(1, 1).as8().fill(0xff)),
              'i32.fill(u32.const(value=164), u32.const(value=255), u32.const(value=2), name=test, isMut=true)'
            );
            deepStrictEqual(
              fmt(f, f.memory.test.chunksDone.as32().range(u32.const(2), 1).as8().fill(0x7e)),
              // start = base + 2*4, len = 4
              'i32.fill(u32.add(u32.mul(u32.const(value=2), u32.const(value=4)), u32.const(value=160)), u32.const(value=126), u32.const(value=4), name=test, isMut=true)'
            );
            throws(() => fmt(f, f.memory.test.chunksDone.as32().as8()[0].range(1, 1).fill(0x7e)));
            throws(() => fmt(f, f.memory.test.chunksDone.as32().as8()[1]));
            deepStrictEqual(
              fmt(
                f,
                f.memory.test.chunksDone.as8()[0].copyFrom(f.memory.test.chunksDone.as8()[1], 5)
              ),
              'i32.copy(u32.const(value=160), u32.const(value=161), u32.const(value=5), name=test, srcName=test, isMut=true)'
            );
            deepStrictEqual(
              fmt(f, f.memory.test.chunksDone.as8()[0].copyFrom(f.memory.test.chunksDone.as8()[1])),
              'i32.copy(u32.const(value=160), u32.const(value=161), u32.const(value=1), name=test, srcName=test, isMut=true)'
            );

            // Symbolic
            deepStrictEqual(
              fmt(f, f.memory.test.stack[3].as8()[5].get()),
              'u32.load(u32.const(value=0), size=8, align=0, name=test, offset=549)'
            );
            const a = u32.const(3);
            const b = u32.const(5);
            deepStrictEqual(
              fmt(f, f.memory.test.stack[a].as8()[b].get()),
              'u32.load(u32.add(u32.mul(u32.const(value=3), u32.const(value=32)), u32.const(value=5), u32.const(value=448)), size=8, align=0, name=test)'
            );
            // Arrays
            deepStrictEqual(
              f.memory.test.stack[0].get().map((i) => fmt(f, i)),
              [
                'u32.load(u32.const(value=0), align=2, name=test, offset=448)',
                'u32.load(u32.const(value=0), align=2, name=test, offset=452)',
                'u32.load(u32.const(value=0), align=2, name=test, offset=456)',
                'u32.load(u32.const(value=0), align=2, name=test, offset=460)',
                'u32.load(u32.const(value=0), align=2, name=test, offset=464)',
                'u32.load(u32.const(value=0), align=2, name=test, offset=468)',
                'u32.load(u32.const(value=0), align=2, name=test, offset=472)',
                'u32.load(u32.const(value=0), align=2, name=test, offset=476)',
              ]
            );
            deepStrictEqual(
              f.memory.test.stack[0]
                .range(undefined, 4)
                .get()
                .map((i) => fmt(f, i)),
              [
                'u32.load(u32.const(value=0), align=2, name=test, offset=448)',
                'u32.load(u32.const(value=0), align=2, name=test, offset=452)',
                'u32.load(u32.const(value=0), align=2, name=test, offset=456)',
                'u32.load(u32.const(value=0), align=2, name=test, offset=460)',
              ]
            );
            deepStrictEqual(
              f.memory.test.stack[0]
                .range(4, 4)
                .get()
                .map((i) => fmt(f, i)),
              [
                'u32.load(u32.const(value=0), align=2, name=test, offset=464)',
                'u32.load(u32.const(value=0), align=2, name=test, offset=468)',
                'u32.load(u32.const(value=0), align=2, name=test, offset=472)',
                'u32.load(u32.const(value=0), align=2, name=test, offset=476)',
              ]
            );
            deepStrictEqual(
              f.memory.test.stack[0]
                .range(4)
                .get()
                .map((i) => fmt(f, i)),
              [
                'u32.load(u32.const(value=0), align=2, name=test, offset=464)',
                'u32.load(u32.const(value=0), align=2, name=test, offset=468)',
                'u32.load(u32.const(value=0), align=2, name=test, offset=472)',
                'u32.load(u32.const(value=0), align=2, name=test, offset=476)',
              ]
            );

            deepStrictEqual(
              f.memory.test.stack[0].set(f.memory.test.stack[0].get()).map((i) => fmt(f, i)),
              [
                'u32.store(u32.const(value=0), u32.load(u32.const(value=0), align=2, name=test, offset=448), align=2, name=test, offset=448, isMut=true)',
                'u32.store(u32.const(value=0), u32.load(u32.const(value=0), align=2, name=test, offset=452), align=2, name=test, offset=452, isMut=true)',
                'u32.store(u32.const(value=0), u32.load(u32.const(value=0), align=2, name=test, offset=456), align=2, name=test, offset=456, isMut=true)',
                'u32.store(u32.const(value=0), u32.load(u32.const(value=0), align=2, name=test, offset=460), align=2, name=test, offset=460, isMut=true)',
                'u32.store(u32.const(value=0), u32.load(u32.const(value=0), align=2, name=test, offset=464), align=2, name=test, offset=464, isMut=true)',
                'u32.store(u32.const(value=0), u32.load(u32.const(value=0), align=2, name=test, offset=468), align=2, name=test, offset=468, isMut=true)',
                'u32.store(u32.const(value=0), u32.load(u32.const(value=0), align=2, name=test, offset=472), align=2, name=test, offset=472, isMut=true)',
                'u32.store(u32.const(value=0), u32.load(u32.const(value=0), align=2, name=test, offset=476), align=2, name=test, offset=476, isMut=true)',
              ]
            );
            deepStrictEqual(
              f.memory.testBE.stack[0].get().map((i) => fmt(f, i)),
              [
                'u32x4.extract_lane(u32x4.shuffle(u32x4.load(u32.const(value=0), align=4, name=testBE, offset=15728), u32x4.load(u32.const(value=0), align=4, name=testBE, offset=15728), pattern=3,2,1,0,7,6,5,4,11,10,9,8,15,14,13,12), lane=0)',
                'u32x4.extract_lane(u32x4.shuffle(u32x4.load(u32.const(value=0), align=4, name=testBE, offset=15728), u32x4.load(u32.const(value=0), align=4, name=testBE, offset=15728), pattern=3,2,1,0,7,6,5,4,11,10,9,8,15,14,13,12), lane=1)',
                'u32x4.extract_lane(u32x4.shuffle(u32x4.load(u32.const(value=0), align=4, name=testBE, offset=15728), u32x4.load(u32.const(value=0), align=4, name=testBE, offset=15728), pattern=3,2,1,0,7,6,5,4,11,10,9,8,15,14,13,12), lane=2)',
                'u32x4.extract_lane(u32x4.shuffle(u32x4.load(u32.const(value=0), align=4, name=testBE, offset=15728), u32x4.load(u32.const(value=0), align=4, name=testBE, offset=15728), pattern=3,2,1,0,7,6,5,4,11,10,9,8,15,14,13,12), lane=3)',
                'u32x4.extract_lane(u32x4.shuffle(u32x4.load(u32.const(value=0), align=4, name=testBE, offset=15744), u32x4.load(u32.const(value=0), align=4, name=testBE, offset=15744), pattern=3,2,1,0,7,6,5,4,11,10,9,8,15,14,13,12), lane=0)',
                'u32x4.extract_lane(u32x4.shuffle(u32x4.load(u32.const(value=0), align=4, name=testBE, offset=15744), u32x4.load(u32.const(value=0), align=4, name=testBE, offset=15744), pattern=3,2,1,0,7,6,5,4,11,10,9,8,15,14,13,12), lane=1)',
                'u32x4.extract_lane(u32x4.shuffle(u32x4.load(u32.const(value=0), align=4, name=testBE, offset=15744), u32x4.load(u32.const(value=0), align=4, name=testBE, offset=15744), pattern=3,2,1,0,7,6,5,4,11,10,9,8,15,14,13,12), lane=2)',
                'u32x4.extract_lane(u32x4.shuffle(u32x4.load(u32.const(value=0), align=4, name=testBE, offset=15744), u32x4.load(u32.const(value=0), align=4, name=testBE, offset=15744), pattern=3,2,1,0,7,6,5,4,11,10,9,8,15,14,13,12), lane=3)',
              ]
            );
            deepStrictEqual(
              f.memory.smallBE.get().map((i) => fmt(f, i)),
              [
                'u32x4.extract_lane(u32x4.shuffle(u32x4.load(u32.const(value=0), align=4, name=smallBE, offset=30656), u32x4.load(u32.const(value=0), align=4, name=smallBE, offset=30656), pattern=3,2,1,0,7,6,5,4,11,10,9,8,15,14,13,12), lane=0)',
                'u32x4.extract_lane(u32x4.shuffle(u32x4.load(u32.const(value=0), align=4, name=smallBE, offset=30656), u32x4.load(u32.const(value=0), align=4, name=smallBE, offset=30656), pattern=3,2,1,0,7,6,5,4,11,10,9,8,15,14,13,12), lane=1)',
                'u32x4.extract_lane(u32x4.shuffle(u32x4.load(u32.const(value=0), align=4, name=smallBE, offset=30656), u32x4.load(u32.const(value=0), align=4, name=smallBE, offset=30656), pattern=3,2,1,0,7,6,5,4,11,10,9,8,15,14,13,12), lane=2)',
                'u32x4.extract_lane(u32x4.shuffle(u32x4.load(u32.const(value=0), align=4, name=smallBE, offset=30656), u32x4.load(u32.const(value=0), align=4, name=smallBE, offset=30656), pattern=3,2,1,0,7,6,5,4,11,10,9,8,15,14,13,12), lane=3)',
                'u32x4.extract_lane(u32x4.shuffle(u32x4.load(u32.const(value=0), align=4, name=smallBE, offset=30672), u32x4.load(u32.const(value=0), align=4, name=smallBE, offset=30672), pattern=3,2,1,0,7,6,5,4,11,10,9,8,15,14,13,12), lane=0)',
              ]
            );
            deepStrictEqual(
              f.memory.smallBE.set(f.memory.smallBE.get()).map((i) => fmt(f, i)),
              [
                'u32x4.store(u32.const(value=0), u32x4.shuffle(u32x4.replace_lane(u32x4.replace_lane(u32x4.replace_lane(u32x4.replace_lane(u32x4.const(value=0), u32x4.extract_lane(u32x4.shuffle(u32x4.load(u32.const(value=0), align=4, name=smallBE, offset=30656), u32x4.load(u32.const(value=0), align=4, name=smallBE, offset=30656), pattern=3,2,1,0,7,6,5,4,11,10,9,8,15,14,13,12), lane=0), lane=0), u32x4.extract_lane(u32x4.shuffle(u32x4.load(u32.const(value=0), align=4, name=smallBE, offset=30656), u32x4.load(u32.const(value=0), align=4, name=smallBE, offset=30656), pattern=3,2,1,0,7,6,5,4,11,10,9,8,15,14,13,12), lane=1), lane=1), u32x4.extract_lane(u32x4.shuffle(u32x4.load(u32.const(value=0), align=4, name=smallBE, offset=30656), u32x4.load(u32.const(value=0), align=4, name=smallBE, offset=30656), pattern=3,2,1,0,7,6,5,4,11,10,9,8,15,14,13,12), lane=2), lane=2), u32x4.extract_lane(u32x4.shuffle(u32x4.load(u32.const(value=0), align=4, name=smallBE, offset=30656), u32x4.load(u32.const(value=0), align=4, name=smallBE, offset=30656), pattern=3,2,1,0,7,6,5,4,11,10,9,8,15,14,13,12), lane=3), lane=3), u32x4.replace_lane(u32x4.replace_lane(u32x4.replace_lane(u32x4.replace_lane(u32x4.const(value=0), u32x4.extract_lane(u32x4.shuffle(u32x4.load(u32.const(value=0), align=4, name=smallBE, offset=30656), u32x4.load(u32.const(value=0), align=4, name=smallBE, offset=30656), pattern=3,2,1,0,7,6,5,4,11,10,9,8,15,14,13,12), lane=0), lane=0), u32x4.extract_lane(u32x4.shuffle(u32x4.load(u32.const(value=0), align=4, name=smallBE, offset=30656), u32x4.load(u32.const(value=0), align=4, name=smallBE, offset=30656), pattern=3,2,1,0,7,6,5,4,11,10,9,8,15,14,13,12), lane=1), lane=1), u32x4.extract_lane(u32x4.shuffle(u32x4.load(u32.const(value=0), align=4, name=smallBE, offset=30656), u32x4.load(u32.const(value=0), align=4, name=smallBE, offset=30656), pattern=3,2,1,0,7,6,5,4,11,10,9,8,15,14,13,12), lane=2), lane=2), u32x4.extract_lane(u32x4.shuffle(u32x4.load(u32.const(value=0), align=4, name=smallBE, offset=30656), u32x4.load(u32.const(value=0), align=4, name=smallBE, offset=30656), pattern=3,2,1,0,7,6,5,4,11,10,9,8,15,14,13,12), lane=3), lane=3), pattern=3,2,1,0,7,6,5,4,11,10,9,8,15,14,13,12), align=4, name=smallBE, offset=30656, isMut=true)',
                'u32.store(u32.const(value=0), u32x4.extract_lane(u32x4.shuffle(u32x4.replace_lane(u32x4.const(value=0), u32x4.extract_lane(u32x4.shuffle(u32x4.load(u32.const(value=0), align=4, name=smallBE, offset=30672), u32x4.load(u32.const(value=0), align=4, name=smallBE, offset=30672), pattern=3,2,1,0,7,6,5,4,11,10,9,8,15,14,13,12), lane=0), lane=0), u32x4.replace_lane(u32x4.const(value=0), u32x4.extract_lane(u32x4.shuffle(u32x4.load(u32.const(value=0), align=4, name=smallBE, offset=30672), u32x4.load(u32.const(value=0), align=4, name=smallBE, offset=30672), pattern=3,2,1,0,7,6,5,4,11,10,9,8,15,14,13,12), lane=0), lane=0), pattern=3,2,1,0,7,6,5,4,11,10,9,8,15,14,13,12), lane=0), align=2, name=smallBE, offset=30672, isMut=true)',
              ]
            );
            // atomics
            deepStrictEqual(f.memory.test.stack[0][0].region, {
              size: 4,
              paddedSize: 4,
              spec: { kind: 'scalar', type: 'u32', opts: {} },
              opts: {},
              pos: 448,
            });
            deepStrictEqual(
              fmt(f, f.memory.test.stack[0][0].atomics.wait(u32.const(0))),
              'u32.atomic.wait(u32.const(value=0), u32.const(value=0), i64.const(value=-1), name=test, offset=448, isMut=true, align=2)'
            );
            deepStrictEqual(
              fmt(f, f.memory.test.stack[0][0].atomics.add(u32.const(1))),
              'u32.atomic.add(u32.const(value=0), u32.const(value=1), name=test, offset=448, isMut=true, align=2)'
            );
            deepStrictEqual(
              fmt(f, f.memory.test.stack[0][0].as8()[0].atomics.add(u32.const(1))),
              'u32.atomic.add8_u(u32.const(value=0), u32.const(value=1), name=test, offset=448, isMut=true, align=0)'
            );
            deepStrictEqual(
              fmt(f, f.memory.test.stack[0][0].as8()[0].atomics.store(u32.const(1))),
              'u32.atomic.store8(u32.const(value=0), u32.const(value=1), name=test, offset=448, isMut=true, align=0)'
            );
            deepStrictEqual(
              fmt(f, f.memory.test.stack[0][0].atomics.store(u32.const(1))),
              'u32.atomic.store(u32.const(value=0), u32.const(value=1), name=test, offset=448, isMut=true, align=2)'
            );
            deepStrictEqual(
              fmt(f, f.memory.test.stack[0][0].atomics.notify(u32.const(1))),
              'u32.atomic.notify(u32.const(value=0), u32.const(value=1), name=test, offset=448, isMut=true, align=2)'
            );
            deepStrictEqual(
              fmt(f, f.memory.test.stack[0][0].atomics.compareExchange(u32.const(2), u32.const(1))),
              'u32.atomic.cmpxchg(u32.const(value=0), u32.const(value=2), u32.const(value=1), name=test, offset=448, isMut=true, align=2)'
            );
            // mut
            deepStrictEqual(
              fmt(f, f.memory.test.stack[0][0].mut.xor(u32.const(2), u32.const(1))),
              'u32.load(u32.const(value=0), align=6, name=test, offset=448)'
            );
            called = true;
          });
        toWasm(mod, { useSIMD: false });
        toJs(mod);
        deepStrictEqual(called, true);
      });
      should('nested', () => {
        const x = array(struct({ rc: array('u64', {}, 24) }), {}, 128);
        const allocated = memory.allocateMemSpec(0, x);
        deepStrictEqual(memory.getRegionInfoPath(allocated.pre, 0, 'rc'), {
          spec: {
            kind: 'array',
            type: { kind: 'scalar', type: 'u64', opts: {} },
            sizes: [24],
            opts: {},
          },
          inner: {
            spec: { kind: 'scalar', type: 'u64', opts: {} },
            size: 8,
            align: 8,
            alignEnd: 1,
            opts: {},
            paddedSize: 8,
          },
          size: 192,
          count: 24,
          align: 16,
          alignEnd: 16,
          opts: {},
          paddedSize: 192,
          pos: 0,
        });
        deepStrictEqual(memory.getRegionInfoPath(allocated.pre, 0, 'rc', 0), {
          pos: 0,
          size: 8,
          paddedSize: 8,
          spec: { kind: 'scalar', type: 'u64', opts: {} },
          opts: {},
          align: 8,
          alignEnd: 1,
        });
        deepStrictEqual(memory.getRegionInfoPath(allocated.pre, 0, 'rc', 1), {
          pos: 8,
          size: 8,
          paddedSize: 8,
          spec: { kind: 'scalar', type: 'u64', opts: {} },
          opts: {},
          align: 8,
          alignEnd: 1,
        });
        const x2 = array(
          struct({
            counter: 'u64',
            state: array('u64', {}, 25),
          }),
          {},
          128
        );
        const allocated2 = memory.allocateMemSpec(0, x2);
        deepStrictEqual(memory.getRegionInfoPath(allocated2.pre, 0), {
          spec: {
            kind: 'struct',
            fields: {
              counter: { kind: 'scalar', type: 'u64', opts: {} },
              state: {
                kind: 'array',
                type: { kind: 'scalar', type: 'u64', opts: {} },
                sizes: [25],
                opts: {},
              },
            },
            opts: {},
          },
          fields: {
            counter: {
              spec: { kind: 'scalar', type: 'u64', opts: {} },
              size: 8,
              align: 8,
              alignEnd: 1,
              opts: {},
              paddedSize: 16,
            },
            state: {
              spec: {
                kind: 'array',
                type: { kind: 'scalar', type: 'u64', opts: {} },
                sizes: [25],
                opts: {},
              },
              inner: {
                spec: { kind: 'scalar', type: 'u64', opts: {} },
                size: 8,
                align: 8,
                alignEnd: 1,
                opts: {},
                paddedSize: 8,
              },
              size: 200,
              count: 25,
              align: 16,
              alignEnd: 16,
              opts: {},
              paddedSize: 208,
            },
          },
          size: 224,
          align: 16,
          alignEnd: 1,
          opts: {},
          paddedSize: 224,
          pos: 0,
        });
        deepStrictEqual(memory.getRegionInfoPath(allocated2.pre, 0, 'state'), {
          spec: {
            kind: 'array',
            type: { kind: 'scalar', type: 'u64', opts: {} },
            sizes: [25],
            opts: {},
          },
          inner: {
            spec: { kind: 'scalar', type: 'u64', opts: {} },
            size: 8,
            align: 8,
            alignEnd: 1,
            opts: {},
            paddedSize: 8,
          },
          size: 200,
          count: 25,
          align: 16,
          alignEnd: 16,
          opts: {},
          paddedSize: 208,
          pos: 16,
        });
        deepStrictEqual(memory.getRegionInfoPath(allocated2.pre, {}, 'state'), {
          spec: {
            kind: 'array',
            type: { kind: 'scalar', type: 'u64', opts: {} },
            sizes: [25],
            opts: {},
          },
          inner: {
            spec: { kind: 'scalar', type: 'u64', opts: {} },
            size: 8,
            align: 8,
            alignEnd: 1,
            opts: {},
            paddedSize: 8,
          },
          size: 200,
          count: 25,
          align: 16,
          alignEnd: 16,
          opts: {},
          paddedSize: 208,
          pos: { base: 16, baseMul: [], syms: [{}], coeffs: [224] },
        });
      });
      should('batch info', () => {
        const x2 = array(
          struct({ counter: 'u64', state: array('u64', {}, 25) }),
          { batch: true },
          128
        );
        const allocated2 = memory.allocateMemSpec(0, x2);
        deepStrictEqual(allocated2.opts, {
          spec: {
            kind: 'array',
            type: {
              kind: 'struct',
              fields: {
                counter: { kind: 'scalar', type: 'u64', opts: {} },
                state: {
                  kind: 'array',
                  type: { kind: 'scalar', type: 'u64', opts: {} },
                  sizes: [25],
                  opts: {},
                },
              },
              opts: {},
            },
            sizes: [128],
            opts: { batch: true },
          },
          inner: {
            spec: {
              kind: 'struct',
              fields: {
                counter: { kind: 'scalar', type: 'u64', opts: {} },
                state: {
                  kind: 'array',
                  type: { kind: 'scalar', type: 'u64', opts: {} },
                  sizes: [25],
                  opts: {},
                },
              },
              opts: {},
            },
            fields: {
              counter: {
                spec: { kind: 'scalar', type: 'u64', opts: {} },
                size: 8,
                align: 8,
                alignEnd: 1,
                opts: {},
                paddedSize: 16,
                pos: 0,
              },
              state: {
                spec: {
                  kind: 'array',
                  type: { kind: 'scalar', type: 'u64', opts: {} },
                  sizes: [25],
                  opts: {},
                },
                inner: {
                  spec: { kind: 'scalar', type: 'u64', opts: {} },
                  size: 8,
                  align: 8,
                  alignEnd: 1,
                  opts: {},
                  paddedSize: 8,
                },
                size: 200,
                count: 25,
                align: 16,
                alignEnd: 16,
                opts: {},
                paddedSize: 208,
                pos: 16,
              },
            },
            size: 224,
            align: 16,
            alignEnd: 1,
            opts: {},
            paddedSize: 224,
            pos: 0,
          },
          size: 28672,
          count: 128,
          align: 16,
          alignEnd: 16,
          opts: { batch: true },
          paddedSize: 28672,
          pos: 0,
          subRegions: {
            '': [0, 28672, 128, 224],
            counter: [0, 8, 128, 224],
            state: [16, 200, 128, 224],
          },
        });
        const x3 = array(
          struct({ counter: 'u64', state: array('u32', {}, 8) }),
          { batch: true },
          128
        );
        const allocated3 = memory.allocateMemSpec(0, x3);
        deepStrictEqual(allocated3.opts, {
          spec: {
            kind: 'array',
            type: {
              kind: 'struct',
              fields: {
                counter: { kind: 'scalar', type: 'u64', opts: {} },
                state: {
                  kind: 'array',
                  type: { kind: 'scalar', type: 'u32', opts: {} },
                  sizes: [8],
                  opts: {},
                },
              },
              opts: {},
            },
            sizes: [128],
            opts: { batch: true },
          },
          inner: {
            spec: {
              kind: 'struct',
              fields: {
                counter: { kind: 'scalar', type: 'u64', opts: {} },
                state: {
                  kind: 'array',
                  type: { kind: 'scalar', type: 'u32', opts: {} },
                  sizes: [8],
                  opts: {},
                },
              },
              opts: {},
            },
            fields: {
              counter: {
                spec: { kind: 'scalar', type: 'u64', opts: {} },
                size: 8,
                align: 8,
                alignEnd: 1,
                opts: {},
                paddedSize: 16,
                pos: 0,
              },
              state: {
                spec: {
                  kind: 'array',
                  type: { kind: 'scalar', type: 'u32', opts: {} },
                  sizes: [8],
                  opts: {},
                },
                inner: {
                  spec: { kind: 'scalar', type: 'u32', opts: {} },
                  size: 4,
                  align: 4,
                  alignEnd: 1,
                  opts: {},
                  paddedSize: 4,
                },
                size: 32,
                count: 8,
                align: 16,
                alignEnd: 16,
                opts: {},
                paddedSize: 32,
                pos: 16,
              },
            },
            size: 48,
            align: 16,
            alignEnd: 1,
            opts: {},
            paddedSize: 48,
            pos: 0,
          },
          size: 6144,
          count: 128,
          align: 16,
          alignEnd: 16,
          opts: { batch: true },
          paddedSize: 6144,
          pos: 0,
          subRegions: {
            '': [0, 6144, 128, 48],
            counter: [0, 8, 128, 48],
            state: [16, 32, 128, 48],
          },
        });
        const x4 = array(array('u32', {}, 16, 16), { batch: true }, 128);
        const allocated4 = memory.allocateMemSpec(0, x4);
        deepStrictEqual(allocated4.opts, {
          spec: {
            kind: 'array',
            type: { kind: 'scalar', type: 'u32', opts: {} },
            sizes: [128, 16, 16],
            opts: { batch: true },
          },
          inner: {
            spec: { kind: 'scalar', type: 'u32', opts: {} },
            size: 4,
            align: 4,
            alignEnd: 1,
            opts: {},
            paddedSize: 4,
          },
          size: 131072,
          count: 32768,
          align: 16,
          alignEnd: 16,
          opts: { batch: true },
          paddedSize: 131072,
          pos: 0,
          subRegions: { '': [0, 131072, 128, 1024] },
        });
        const x5 = {
          kind: 'struct',
          fields: {
            salt: {
              kind: 'array',
              type: { kind: 'scalar', type: 'u32', opts: {} },
              sizes: [2],
              opts: {},
            },
            personalization: {
              kind: 'array',
              type: { kind: 'scalar', type: 'u32', opts: {} },
              sizes: [2],
              opts: {},
            },
          },
          opts: { batch: true },
        };
        const allocated5 = memory.allocateMemSpec(0, x5);
        deepStrictEqual(allocated5.opts, {
          spec: {
            kind: 'struct',
            fields: {
              salt: {
                kind: 'array',
                type: { kind: 'scalar', type: 'u32', opts: {} },
                sizes: [2],
                opts: {},
              },
              personalization: {
                kind: 'array',
                type: { kind: 'scalar', type: 'u32', opts: {} },
                sizes: [2],
                opts: {},
              },
            },
            opts: { batch: true },
          },
          fields: {
            salt: {
              spec: {
                kind: 'array',
                type: { kind: 'scalar', type: 'u32', opts: {} },
                sizes: [2],
                opts: {},
              },
              inner: {
                spec: { kind: 'scalar', type: 'u32', opts: {} },
                size: 4,
                align: 4,
                alignEnd: 1,
                opts: {},
                paddedSize: 4,
              },
              size: 8,
              count: 2,
              align: 16,
              alignEnd: 16,
              opts: {},
              paddedSize: 16,
              pos: 0,
            },
            personalization: {
              spec: {
                kind: 'array',
                type: { kind: 'scalar', type: 'u32', opts: {} },
                sizes: [2],
                opts: {},
              },
              inner: {
                spec: { kind: 'scalar', type: 'u32', opts: {} },
                size: 4,
                align: 4,
                alignEnd: 1,
                opts: {},
                paddedSize: 4,
              },
              size: 8,
              count: 2,
              align: 16,
              alignEnd: 16,
              opts: {},
              paddedSize: 16,
              pos: 16,
            },
          },
          size: 32,
          align: 16,
          alignEnd: 1,
          opts: { batch: true },
          paddedSize: 32,
          pos: 0,
          subRegions: { '': [0, 32, 1, 32], salt: [0, 8, 1, 8], personalization: [16, 8, 1, 8] },
        });
      });
      should('struct', () => {
        let called = 0;
        const mod = new Module('wat')
          .mem(
            'basic',
            struct({
              chunksDone: 'u64',
              flags: 'u32',
              stack: array('u32', {}, 64, 8),
              str: struct({
                tmp: 'u32',
                a: 'u64',
                arr: array('u32', {}, 3, 2),
              }),
              stackPosSimd: 'u32x4',
              stackSimd: array('u32x4', {}, 64, 8),
              arr16: array('u32', {}, 16),
            })
          )
          .mem(
            'basicBE',
            struct(
              {
                chunksDone: 'u64',
                flags: 'u32',
                stack: array('u32', {}, 64, 8),
                str: struct({
                  tmp: 'u32',
                  a: 'u64',
                  arr: array('u32', {}, 3, 2),
                }),
                stackPosSimd: 'u32x4',
                stackSimd: array('u32x4', {}, 64, 8),
                arr16: array('u32', {}, 16),
              },
              { swapEndianness: true }
            )
          )
          .mem(
            'arr',
            array(
              struct({
                chunksDone: 'u64',
                flags: 'u32',
                stack: array('u32', {}, 64, 8),
              }),
              {},
              16
            )
          )
          .batchFn(
            'test',
            { lanes: 1 },
            ['u32', 'u32', 'u32', 'u32'],
            (f, type, batchPos, _blocks, _outBlockLen, _isLast) => {
              const { u32, u64 } = f.types;
              const fmtRec = (x) => {
                if (Array.isArray(x)) return x.map(fmtRec);
                if (x instanceof FnOp) return fmt(f, x);
                const res = {};
                for (const k in x) res[k] = fmtRec(x[k]);
                return res;
              };
              deepStrictEqual(fmtRec(f.memory.basic.str.get()), {
                tmp: 'u32.load(u32.const(value=0), align=4, name=basic, offset=2064)',
                a: 'u64.load(u32.const(value=0), align=3, name=basic, offset=2072)',
                arr: [
                  [
                    'u32.load(u32.const(value=0), align=2, name=basic, offset=2080)',
                    'u32.load(u32.const(value=0), align=2, name=basic, offset=2084)',
                  ],
                  [
                    'u32.load(u32.const(value=0), align=2, name=basic, offset=2088)',
                    'u32.load(u32.const(value=0), align=2, name=basic, offset=2092)',
                  ],
                  [
                    'u32.load(u32.const(value=0), align=2, name=basic, offset=2096)',
                    'u32.load(u32.const(value=0), align=2, name=basic, offset=2100)',
                  ],
                ],
              });
              deepStrictEqual(
                fmtRec(f.memory.basic.str.set({ tmp: u32.const(1), a: u64.const(2) })),
                {
                  tmp: 'u32.store(u32.const(value=0), u32.const(value=1), align=4, name=basic, offset=2064, isMut=true)',
                  a: 'u64.store(u32.const(value=0), u64.const(value=2), align=3, name=basic, offset=2072, isMut=true)',
                }
              );
              deepStrictEqual(fmtRec(f.memory.basic.str.set(f.memory.basic.str.get())), {
                tmp: 'u32.store(u32.const(value=0), u32.load(u32.const(value=0), align=4, name=basic, offset=2064), align=4, name=basic, offset=2064, isMut=true)',
                a: 'u64.store(u32.const(value=0), u64.load(u32.const(value=0), align=3, name=basic, offset=2072), align=3, name=basic, offset=2072, isMut=true)',
                arr: [
                  'u32.store(u32.const(value=0), u32.load(u32.const(value=0), align=2, name=basic, offset=2080), align=2, name=basic, offset=2080, isMut=true)',
                  'u32.store(u32.const(value=0), u32.load(u32.const(value=0), align=2, name=basic, offset=2084), align=2, name=basic, offset=2084, isMut=true)',
                  'u32.store(u32.const(value=0), u32.load(u32.const(value=0), align=2, name=basic, offset=2088), align=2, name=basic, offset=2088, isMut=true)',
                  'u32.store(u32.const(value=0), u32.load(u32.const(value=0), align=2, name=basic, offset=2092), align=2, name=basic, offset=2092, isMut=true)',
                  'u32.store(u32.const(value=0), u32.load(u32.const(value=0), align=2, name=basic, offset=2096), align=2, name=basic, offset=2096, isMut=true)',
                  'u32.store(u32.const(value=0), u32.load(u32.const(value=0), align=2, name=basic, offset=2100), align=2, name=basic, offset=2100, isMut=true)',
                ],
              });
              // Verify that we hit simd be path on arrays
              deepStrictEqual(fmtRec(f.memory.basicBE.str.arr.set(f.memory.basic.str.arr.get())), [
                'u32x4.store(u32.const(value=0), u32x4.shuffle(u32x4.replace_lane(u32x4.replace_lane(u32x4.replace_lane(u32x4.replace_lane(u32x4.const(value=0), u32.load(u32.const(value=0), align=2, name=basic, offset=2080), lane=0), u32.load(u32.const(value=0), align=2, name=basic, offset=2084), lane=1), u32.load(u32.const(value=0), align=2, name=basic, offset=2088), lane=2), u32.load(u32.const(value=0), align=2, name=basic, offset=2092), lane=3), u32x4.replace_lane(u32x4.replace_lane(u32x4.replace_lane(u32x4.replace_lane(u32x4.const(value=0), u32.load(u32.const(value=0), align=2, name=basic, offset=2080), lane=0), u32.load(u32.const(value=0), align=2, name=basic, offset=2084), lane=1), u32.load(u32.const(value=0), align=2, name=basic, offset=2088), lane=2), u32.load(u32.const(value=0), align=2, name=basic, offset=2092), lane=3), pattern=3,2,1,0,7,6,5,4,11,10,9,8,15,14,13,12), align=4, name=basicBE, offset=12464, isMut=true)',
                'u32.store(u32.const(value=0), u32x4.extract_lane(u32x4.shuffle(u32x4.replace_lane(u32x4.replace_lane(u32x4.const(value=0), u32.load(u32.const(value=0), align=2, name=basic, offset=2096), lane=0), u32.load(u32.const(value=0), align=2, name=basic, offset=2100), lane=1), u32x4.replace_lane(u32x4.replace_lane(u32x4.const(value=0), u32.load(u32.const(value=0), align=2, name=basic, offset=2096), lane=0), u32.load(u32.const(value=0), align=2, name=basic, offset=2100), lane=1), pattern=3,2,1,0,7,6,5,4,11,10,9,8,15,14,13,12), lane=0), align=2, name=basicBE, offset=12480, isMut=true)',
                'u32.store(u32.const(value=0), u32x4.extract_lane(u32x4.shuffle(u32x4.replace_lane(u32x4.replace_lane(u32x4.const(value=0), u32.load(u32.const(value=0), align=2, name=basic, offset=2096), lane=0), u32.load(u32.const(value=0), align=2, name=basic, offset=2100), lane=1), u32x4.replace_lane(u32x4.replace_lane(u32x4.const(value=0), u32.load(u32.const(value=0), align=2, name=basic, offset=2096), lane=0), u32.load(u32.const(value=0), align=2, name=basic, offset=2100), lane=1), pattern=3,2,1,0,7,6,5,4,11,10,9,8,15,14,13,12), lane=1), align=2, name=basicBE, offset=12484, isMut=true)',
              ]);
              // re-typing
              deepStrictEqual(fmtRec(f.memory.basic.str.arr.as('u32').get()), [
                [
                  'u32.load(u32.const(value=0), align=2, name=basic, offset=2080)',
                  'u32.load(u32.const(value=0), align=2, name=basic, offset=2084)',
                ],
                [
                  'u32.load(u32.const(value=0), align=2, name=basic, offset=2088)',
                  'u32.load(u32.const(value=0), align=2, name=basic, offset=2092)',
                ],
                [
                  'u32.load(u32.const(value=0), align=2, name=basic, offset=2096)',
                  'u32.load(u32.const(value=0), align=2, name=basic, offset=2100)',
                ],
              ]);
              deepStrictEqual(fmtRec(f.memory.basic.str.arr.as('u64').get()), [
                ['u64.load(u32.const(value=0), align=3, name=basic, offset=2080)'],
                ['u64.load(u32.const(value=0), align=3, name=basic, offset=2088)'],
                ['u64.load(u32.const(value=0), align=3, name=basic, offset=2096)'],
              ]);
              deepStrictEqual(
                fmtRec(f.memory.basic.stackPosSimd.get()),
                'u32x4.load(u32.const(value=0), align=6, name=basic, offset=2112)'
              );
              deepStrictEqual(fmtRec(f.memory.basic.stackPosSimd.as('u64').get()), [
                'u64.load(u32.const(value=0), align=3, name=basic, offset=2112)',
                'u64.load(u32.const(value=0), align=3, name=basic, offset=2120)',
              ]);
              deepStrictEqual(fmtRec(f.memory.basic.stackPosSimd.as('u32').get()), [
                'u32.load(u32.const(value=0), align=2, name=basic, offset=2112)',
                'u32.load(u32.const(value=0), align=2, name=basic, offset=2116)',
                'u32.load(u32.const(value=0), align=2, name=basic, offset=2120)',
                'u32.load(u32.const(value=0), align=2, name=basic, offset=2124)',
              ]);
              deepStrictEqual(fmtRec(f.memory.basic.arr16.get()), [
                'u32.load(u32.const(value=0), align=2, name=basic, offset=10320)',
                'u32.load(u32.const(value=0), align=2, name=basic, offset=10324)',
                'u32.load(u32.const(value=0), align=2, name=basic, offset=10328)',
                'u32.load(u32.const(value=0), align=2, name=basic, offset=10332)',
                'u32.load(u32.const(value=0), align=2, name=basic, offset=10336)',
                'u32.load(u32.const(value=0), align=2, name=basic, offset=10340)',
                'u32.load(u32.const(value=0), align=2, name=basic, offset=10344)',
                'u32.load(u32.const(value=0), align=2, name=basic, offset=10348)',
                'u32.load(u32.const(value=0), align=2, name=basic, offset=10352)',
                'u32.load(u32.const(value=0), align=2, name=basic, offset=10356)',
                'u32.load(u32.const(value=0), align=2, name=basic, offset=10360)',
                'u32.load(u32.const(value=0), align=2, name=basic, offset=10364)',
                'u32.load(u32.const(value=0), align=2, name=basic, offset=10368)',
                'u32.load(u32.const(value=0), align=2, name=basic, offset=10372)',
                'u32.load(u32.const(value=0), align=2, name=basic, offset=10376)',
                'u32.load(u32.const(value=0), align=2, name=basic, offset=10380)',
              ]);
              deepStrictEqual(fmtRec(f.memory.basic.arr16.as('u64').get()), [
                'u64.load(u32.const(value=0), align=3, name=basic, offset=10320)',
                'u64.load(u32.const(value=0), align=3, name=basic, offset=10328)',
                'u64.load(u32.const(value=0), align=3, name=basic, offset=10336)',
                'u64.load(u32.const(value=0), align=3, name=basic, offset=10344)',
                'u64.load(u32.const(value=0), align=3, name=basic, offset=10352)',
                'u64.load(u32.const(value=0), align=3, name=basic, offset=10360)',
                'u64.load(u32.const(value=0), align=3, name=basic, offset=10368)',
                'u64.load(u32.const(value=0), align=3, name=basic, offset=10376)',
              ]);
              deepStrictEqual(fmtRec(f.memory.basic.arr16.as('u32x4').get()), [
                'u32x4.load(u32.const(value=0), align=4, name=basic, offset=10320)',
                'u32x4.load(u32.const(value=0), align=4, name=basic, offset=10336)',
                'u32x4.load(u32.const(value=0), align=4, name=basic, offset=10352)',
                'u32x4.load(u32.const(value=0), align=4, name=basic, offset=10368)',
              ]);
              // as 8
              deepStrictEqual(f.memory.basic.str.as8().region.size, 48);
              deepStrictEqual(f.memory.basic.str.as8().region.count, 48);
              deepStrictEqual(fmtRec(f.memory.basic.str.as8().get()), [
                'u32.load(u32.const(value=0), size=8, align=0, name=basic, offset=2064)',
                'u32.load(u32.const(value=0), size=8, align=0, name=basic, offset=2065)',
                'u32.load(u32.const(value=0), size=8, align=0, name=basic, offset=2066)',
                'u32.load(u32.const(value=0), size=8, align=0, name=basic, offset=2067)',
                'u32.load(u32.const(value=0), size=8, align=0, name=basic, offset=2068)',
                'u32.load(u32.const(value=0), size=8, align=0, name=basic, offset=2069)',
                'u32.load(u32.const(value=0), size=8, align=0, name=basic, offset=2070)',
                'u32.load(u32.const(value=0), size=8, align=0, name=basic, offset=2071)',
                'u32.load(u32.const(value=0), size=8, align=0, name=basic, offset=2072)',
                'u32.load(u32.const(value=0), size=8, align=0, name=basic, offset=2073)',
                'u32.load(u32.const(value=0), size=8, align=0, name=basic, offset=2074)',
                'u32.load(u32.const(value=0), size=8, align=0, name=basic, offset=2075)',
                'u32.load(u32.const(value=0), size=8, align=0, name=basic, offset=2076)',
                'u32.load(u32.const(value=0), size=8, align=0, name=basic, offset=2077)',
                'u32.load(u32.const(value=0), size=8, align=0, name=basic, offset=2078)',
                'u32.load(u32.const(value=0), size=8, align=0, name=basic, offset=2079)',
                'u32.load(u32.const(value=0), size=8, align=0, name=basic, offset=2080)',
                'u32.load(u32.const(value=0), size=8, align=0, name=basic, offset=2081)',
                'u32.load(u32.const(value=0), size=8, align=0, name=basic, offset=2082)',
                'u32.load(u32.const(value=0), size=8, align=0, name=basic, offset=2083)',
                'u32.load(u32.const(value=0), size=8, align=0, name=basic, offset=2084)',
                'u32.load(u32.const(value=0), size=8, align=0, name=basic, offset=2085)',
                'u32.load(u32.const(value=0), size=8, align=0, name=basic, offset=2086)',
                'u32.load(u32.const(value=0), size=8, align=0, name=basic, offset=2087)',
                'u32.load(u32.const(value=0), size=8, align=0, name=basic, offset=2088)',
                'u32.load(u32.const(value=0), size=8, align=0, name=basic, offset=2089)',
                'u32.load(u32.const(value=0), size=8, align=0, name=basic, offset=2090)',
                'u32.load(u32.const(value=0), size=8, align=0, name=basic, offset=2091)',
                'u32.load(u32.const(value=0), size=8, align=0, name=basic, offset=2092)',
                'u32.load(u32.const(value=0), size=8, align=0, name=basic, offset=2093)',
                'u32.load(u32.const(value=0), size=8, align=0, name=basic, offset=2094)',
                'u32.load(u32.const(value=0), size=8, align=0, name=basic, offset=2095)',
                'u32.load(u32.const(value=0), size=8, align=0, name=basic, offset=2096)',
                'u32.load(u32.const(value=0), size=8, align=0, name=basic, offset=2097)',
                'u32.load(u32.const(value=0), size=8, align=0, name=basic, offset=2098)',
                'u32.load(u32.const(value=0), size=8, align=0, name=basic, offset=2099)',
                'u32.load(u32.const(value=0), size=8, align=0, name=basic, offset=2100)',
                'u32.load(u32.const(value=0), size=8, align=0, name=basic, offset=2101)',
                'u32.load(u32.const(value=0), size=8, align=0, name=basic, offset=2102)',
                'u32.load(u32.const(value=0), size=8, align=0, name=basic, offset=2103)',
                'u32.load(u32.const(value=0), size=8, align=0, name=basic, offset=2104)',
                'u32.load(u32.const(value=0), size=8, align=0, name=basic, offset=2105)',
                'u32.load(u32.const(value=0), size=8, align=0, name=basic, offset=2106)',
                'u32.load(u32.const(value=0), size=8, align=0, name=basic, offset=2107)',
                'u32.load(u32.const(value=0), size=8, align=0, name=basic, offset=2108)',
                'u32.load(u32.const(value=0), size=8, align=0, name=basic, offset=2109)',
                'u32.load(u32.const(value=0), size=8, align=0, name=basic, offset=2110)',
                'u32.load(u32.const(value=0), size=8, align=0, name=basic, offset=2111)',
              ]);

              deepStrictEqual(f.memory.basic.str.as16().region.size, 48);
              deepStrictEqual(f.memory.basic.str.as16().region.count, 24);
              deepStrictEqual(fmtRec(f.memory.basic.str.as16().get()), [
                'u32.load(u32.const(value=0), size=16, align=1, name=basic, offset=2064)',
                'u32.load(u32.const(value=0), size=16, align=1, name=basic, offset=2066)',
                'u32.load(u32.const(value=0), size=16, align=1, name=basic, offset=2068)',
                'u32.load(u32.const(value=0), size=16, align=1, name=basic, offset=2070)',
                'u32.load(u32.const(value=0), size=16, align=1, name=basic, offset=2072)',
                'u32.load(u32.const(value=0), size=16, align=1, name=basic, offset=2074)',
                'u32.load(u32.const(value=0), size=16, align=1, name=basic, offset=2076)',
                'u32.load(u32.const(value=0), size=16, align=1, name=basic, offset=2078)',
                'u32.load(u32.const(value=0), size=16, align=1, name=basic, offset=2080)',
                'u32.load(u32.const(value=0), size=16, align=1, name=basic, offset=2082)',
                'u32.load(u32.const(value=0), size=16, align=1, name=basic, offset=2084)',
                'u32.load(u32.const(value=0), size=16, align=1, name=basic, offset=2086)',
                'u32.load(u32.const(value=0), size=16, align=1, name=basic, offset=2088)',
                'u32.load(u32.const(value=0), size=16, align=1, name=basic, offset=2090)',
                'u32.load(u32.const(value=0), size=16, align=1, name=basic, offset=2092)',
                'u32.load(u32.const(value=0), size=16, align=1, name=basic, offset=2094)',
                'u32.load(u32.const(value=0), size=16, align=1, name=basic, offset=2096)',
                'u32.load(u32.const(value=0), size=16, align=1, name=basic, offset=2098)',
                'u32.load(u32.const(value=0), size=16, align=1, name=basic, offset=2100)',
                'u32.load(u32.const(value=0), size=16, align=1, name=basic, offset=2102)',
                'u32.load(u32.const(value=0), size=16, align=1, name=basic, offset=2104)',
                'u32.load(u32.const(value=0), size=16, align=1, name=basic, offset=2106)',
                'u32.load(u32.const(value=0), size=16, align=1, name=basic, offset=2108)',
                'u32.load(u32.const(value=0), size=16, align=1, name=basic, offset=2110)',
              ]);
              deepStrictEqual(f.memory.basic.str.as32().region.size, 48);
              deepStrictEqual(f.memory.basic.str.as32().region.count, 12);
              deepStrictEqual(fmtRec(f.memory.basic.str.as32().get()), [
                'u32.load(u32.const(value=0), size=32, align=2, name=basic, offset=2064)',
                'u32.load(u32.const(value=0), size=32, align=2, name=basic, offset=2068)',
                'u32.load(u32.const(value=0), size=32, align=2, name=basic, offset=2072)',
                'u32.load(u32.const(value=0), size=32, align=2, name=basic, offset=2076)',
                'u32.load(u32.const(value=0), size=32, align=2, name=basic, offset=2080)',
                'u32.load(u32.const(value=0), size=32, align=2, name=basic, offset=2084)',
                'u32.load(u32.const(value=0), size=32, align=2, name=basic, offset=2088)',
                'u32.load(u32.const(value=0), size=32, align=2, name=basic, offset=2092)',
                'u32.load(u32.const(value=0), size=32, align=2, name=basic, offset=2096)',
                'u32.load(u32.const(value=0), size=32, align=2, name=basic, offset=2100)',
                'u32.load(u32.const(value=0), size=32, align=2, name=basic, offset=2104)',
                'u32.load(u32.const(value=0), size=32, align=2, name=basic, offset=2108)',
              ]);
              deepStrictEqual(
                fmtRec(f.memory.basic.str.as8().set(f.memory.basic.str.as8().get())),
                [
                  'u32.store(u32.const(value=0), u32.load(u32.const(value=0), size=8, align=0, name=basic, offset=2064), size=8, align=0, name=basic, offset=2064, isMut=true)',
                  'u32.store(u32.const(value=0), u32.load(u32.const(value=0), size=8, align=0, name=basic, offset=2065), size=8, align=0, name=basic, offset=2065, isMut=true)',
                  'u32.store(u32.const(value=0), u32.load(u32.const(value=0), size=8, align=0, name=basic, offset=2066), size=8, align=0, name=basic, offset=2066, isMut=true)',
                  'u32.store(u32.const(value=0), u32.load(u32.const(value=0), size=8, align=0, name=basic, offset=2067), size=8, align=0, name=basic, offset=2067, isMut=true)',
                  'u32.store(u32.const(value=0), u32.load(u32.const(value=0), size=8, align=0, name=basic, offset=2068), size=8, align=0, name=basic, offset=2068, isMut=true)',
                  'u32.store(u32.const(value=0), u32.load(u32.const(value=0), size=8, align=0, name=basic, offset=2069), size=8, align=0, name=basic, offset=2069, isMut=true)',
                  'u32.store(u32.const(value=0), u32.load(u32.const(value=0), size=8, align=0, name=basic, offset=2070), size=8, align=0, name=basic, offset=2070, isMut=true)',
                  'u32.store(u32.const(value=0), u32.load(u32.const(value=0), size=8, align=0, name=basic, offset=2071), size=8, align=0, name=basic, offset=2071, isMut=true)',
                  'u32.store(u32.const(value=0), u32.load(u32.const(value=0), size=8, align=0, name=basic, offset=2072), size=8, align=0, name=basic, offset=2072, isMut=true)',
                  'u32.store(u32.const(value=0), u32.load(u32.const(value=0), size=8, align=0, name=basic, offset=2073), size=8, align=0, name=basic, offset=2073, isMut=true)',
                  'u32.store(u32.const(value=0), u32.load(u32.const(value=0), size=8, align=0, name=basic, offset=2074), size=8, align=0, name=basic, offset=2074, isMut=true)',
                  'u32.store(u32.const(value=0), u32.load(u32.const(value=0), size=8, align=0, name=basic, offset=2075), size=8, align=0, name=basic, offset=2075, isMut=true)',
                  'u32.store(u32.const(value=0), u32.load(u32.const(value=0), size=8, align=0, name=basic, offset=2076), size=8, align=0, name=basic, offset=2076, isMut=true)',
                  'u32.store(u32.const(value=0), u32.load(u32.const(value=0), size=8, align=0, name=basic, offset=2077), size=8, align=0, name=basic, offset=2077, isMut=true)',
                  'u32.store(u32.const(value=0), u32.load(u32.const(value=0), size=8, align=0, name=basic, offset=2078), size=8, align=0, name=basic, offset=2078, isMut=true)',
                  'u32.store(u32.const(value=0), u32.load(u32.const(value=0), size=8, align=0, name=basic, offset=2079), size=8, align=0, name=basic, offset=2079, isMut=true)',
                  'u32.store(u32.const(value=0), u32.load(u32.const(value=0), size=8, align=0, name=basic, offset=2080), size=8, align=0, name=basic, offset=2080, isMut=true)',
                  'u32.store(u32.const(value=0), u32.load(u32.const(value=0), size=8, align=0, name=basic, offset=2081), size=8, align=0, name=basic, offset=2081, isMut=true)',
                  'u32.store(u32.const(value=0), u32.load(u32.const(value=0), size=8, align=0, name=basic, offset=2082), size=8, align=0, name=basic, offset=2082, isMut=true)',
                  'u32.store(u32.const(value=0), u32.load(u32.const(value=0), size=8, align=0, name=basic, offset=2083), size=8, align=0, name=basic, offset=2083, isMut=true)',
                  'u32.store(u32.const(value=0), u32.load(u32.const(value=0), size=8, align=0, name=basic, offset=2084), size=8, align=0, name=basic, offset=2084, isMut=true)',
                  'u32.store(u32.const(value=0), u32.load(u32.const(value=0), size=8, align=0, name=basic, offset=2085), size=8, align=0, name=basic, offset=2085, isMut=true)',
                  'u32.store(u32.const(value=0), u32.load(u32.const(value=0), size=8, align=0, name=basic, offset=2086), size=8, align=0, name=basic, offset=2086, isMut=true)',
                  'u32.store(u32.const(value=0), u32.load(u32.const(value=0), size=8, align=0, name=basic, offset=2087), size=8, align=0, name=basic, offset=2087, isMut=true)',
                  'u32.store(u32.const(value=0), u32.load(u32.const(value=0), size=8, align=0, name=basic, offset=2088), size=8, align=0, name=basic, offset=2088, isMut=true)',
                  'u32.store(u32.const(value=0), u32.load(u32.const(value=0), size=8, align=0, name=basic, offset=2089), size=8, align=0, name=basic, offset=2089, isMut=true)',
                  'u32.store(u32.const(value=0), u32.load(u32.const(value=0), size=8, align=0, name=basic, offset=2090), size=8, align=0, name=basic, offset=2090, isMut=true)',
                  'u32.store(u32.const(value=0), u32.load(u32.const(value=0), size=8, align=0, name=basic, offset=2091), size=8, align=0, name=basic, offset=2091, isMut=true)',
                  'u32.store(u32.const(value=0), u32.load(u32.const(value=0), size=8, align=0, name=basic, offset=2092), size=8, align=0, name=basic, offset=2092, isMut=true)',
                  'u32.store(u32.const(value=0), u32.load(u32.const(value=0), size=8, align=0, name=basic, offset=2093), size=8, align=0, name=basic, offset=2093, isMut=true)',
                  'u32.store(u32.const(value=0), u32.load(u32.const(value=0), size=8, align=0, name=basic, offset=2094), size=8, align=0, name=basic, offset=2094, isMut=true)',
                  'u32.store(u32.const(value=0), u32.load(u32.const(value=0), size=8, align=0, name=basic, offset=2095), size=8, align=0, name=basic, offset=2095, isMut=true)',
                  'u32.store(u32.const(value=0), u32.load(u32.const(value=0), size=8, align=0, name=basic, offset=2096), size=8, align=0, name=basic, offset=2096, isMut=true)',
                  'u32.store(u32.const(value=0), u32.load(u32.const(value=0), size=8, align=0, name=basic, offset=2097), size=8, align=0, name=basic, offset=2097, isMut=true)',
                  'u32.store(u32.const(value=0), u32.load(u32.const(value=0), size=8, align=0, name=basic, offset=2098), size=8, align=0, name=basic, offset=2098, isMut=true)',
                  'u32.store(u32.const(value=0), u32.load(u32.const(value=0), size=8, align=0, name=basic, offset=2099), size=8, align=0, name=basic, offset=2099, isMut=true)',
                  'u32.store(u32.const(value=0), u32.load(u32.const(value=0), size=8, align=0, name=basic, offset=2100), size=8, align=0, name=basic, offset=2100, isMut=true)',
                  'u32.store(u32.const(value=0), u32.load(u32.const(value=0), size=8, align=0, name=basic, offset=2101), size=8, align=0, name=basic, offset=2101, isMut=true)',
                  'u32.store(u32.const(value=0), u32.load(u32.const(value=0), size=8, align=0, name=basic, offset=2102), size=8, align=0, name=basic, offset=2102, isMut=true)',
                  'u32.store(u32.const(value=0), u32.load(u32.const(value=0), size=8, align=0, name=basic, offset=2103), size=8, align=0, name=basic, offset=2103, isMut=true)',
                  'u32.store(u32.const(value=0), u32.load(u32.const(value=0), size=8, align=0, name=basic, offset=2104), size=8, align=0, name=basic, offset=2104, isMut=true)',
                  'u32.store(u32.const(value=0), u32.load(u32.const(value=0), size=8, align=0, name=basic, offset=2105), size=8, align=0, name=basic, offset=2105, isMut=true)',
                  'u32.store(u32.const(value=0), u32.load(u32.const(value=0), size=8, align=0, name=basic, offset=2106), size=8, align=0, name=basic, offset=2106, isMut=true)',
                  'u32.store(u32.const(value=0), u32.load(u32.const(value=0), size=8, align=0, name=basic, offset=2107), size=8, align=0, name=basic, offset=2107, isMut=true)',
                  'u32.store(u32.const(value=0), u32.load(u32.const(value=0), size=8, align=0, name=basic, offset=2108), size=8, align=0, name=basic, offset=2108, isMut=true)',
                  'u32.store(u32.const(value=0), u32.load(u32.const(value=0), size=8, align=0, name=basic, offset=2109), size=8, align=0, name=basic, offset=2109, isMut=true)',
                  'u32.store(u32.const(value=0), u32.load(u32.const(value=0), size=8, align=0, name=basic, offset=2110), size=8, align=0, name=basic, offset=2110, isMut=true)',
                  'u32.store(u32.const(value=0), u32.load(u32.const(value=0), size=8, align=0, name=basic, offset=2111), size=8, align=0, name=basic, offset=2111, isMut=true)',
                ]
              );
              deepStrictEqual(fmtRec(f.memory.basic.str.as8().as16().get()), [
                'u32.load(u32.const(value=0), size=16, align=1, name=basic, offset=2064)',
                'u32.load(u32.const(value=0), size=16, align=1, name=basic, offset=2066)',
                'u32.load(u32.const(value=0), size=16, align=1, name=basic, offset=2068)',
                'u32.load(u32.const(value=0), size=16, align=1, name=basic, offset=2070)',
                'u32.load(u32.const(value=0), size=16, align=1, name=basic, offset=2072)',
                'u32.load(u32.const(value=0), size=16, align=1, name=basic, offset=2074)',
                'u32.load(u32.const(value=0), size=16, align=1, name=basic, offset=2076)',
                'u32.load(u32.const(value=0), size=16, align=1, name=basic, offset=2078)',
                'u32.load(u32.const(value=0), size=16, align=1, name=basic, offset=2080)',
                'u32.load(u32.const(value=0), size=16, align=1, name=basic, offset=2082)',
                'u32.load(u32.const(value=0), size=16, align=1, name=basic, offset=2084)',
                'u32.load(u32.const(value=0), size=16, align=1, name=basic, offset=2086)',
                'u32.load(u32.const(value=0), size=16, align=1, name=basic, offset=2088)',
                'u32.load(u32.const(value=0), size=16, align=1, name=basic, offset=2090)',
                'u32.load(u32.const(value=0), size=16, align=1, name=basic, offset=2092)',
                'u32.load(u32.const(value=0), size=16, align=1, name=basic, offset=2094)',
                'u32.load(u32.const(value=0), size=16, align=1, name=basic, offset=2096)',
                'u32.load(u32.const(value=0), size=16, align=1, name=basic, offset=2098)',
                'u32.load(u32.const(value=0), size=16, align=1, name=basic, offset=2100)',
                'u32.load(u32.const(value=0), size=16, align=1, name=basic, offset=2102)',
                'u32.load(u32.const(value=0), size=16, align=1, name=basic, offset=2104)',
                'u32.load(u32.const(value=0), size=16, align=1, name=basic, offset=2106)',
                'u32.load(u32.const(value=0), size=16, align=1, name=basic, offset=2108)',
                'u32.load(u32.const(value=0), size=16, align=1, name=basic, offset=2110)',
              ]);
              deepStrictEqual(fmtRec(f.memory.basic.str.as8().range(0, 4).as16().get()), [
                'u32.load(u32.const(value=0), size=16, align=1, name=basic, offset=2064)',
                'u32.load(u32.const(value=0), size=16, align=1, name=basic, offset=2066)',
              ]);
              deepStrictEqual(f.memory.basic.str.arr.range(0, 2).region, {
                pos: 2080,
                spec: {
                  kind: 'array',
                  type: { kind: 'scalar', type: 'u32', opts: {} },
                  sizes: [2, 2],
                  opts: {},
                },
                size: 16,
                count: 4,
                opts: {},
                paddedSize: 16,
              });
              deepStrictEqual(fmtRec(f.memory.basic.str.arr.range(0, 2).get()), [
                [
                  'u32.load(u32.const(value=0), align=2, name=basic, offset=2080)',
                  'u32.load(u32.const(value=0), align=2, name=basic, offset=2084)',
                ],
                [
                  'u32.load(u32.const(value=0), align=2, name=basic, offset=2088)',
                  'u32.load(u32.const(value=0), align=2, name=basic, offset=2092)',
                ],
              ]);
              called++;
            }
          );
        toWasm(mod, { useSIMD: false });
        toJs(mod);
        deepStrictEqual(called, 2);
      });
      should('cast', () => {
        let called = 0;
        const mod = new Module('wat')
          .mem(
            'basic',
            struct({
              chunksDone: 'u64',
              flags: 'u32',
              stack: array('u32', {}, 4, 2),
              stack2: array('u64', {}, 4, 2),
              stack3: array('u32x4', {}, 4, 2),
            })
          )
          .batchFn(
            'test',
            { lanes: 1 },
            ['u32', 'u32', 'u32', 'u32'],
            (f, type, batchPos, _blocks, _outBlockLen, _isLast) => {
              const { u32, u64 } = f.types;
              const fmtRec = (x) => {
                if (Array.isArray(x)) return x.map(fmtRec);
                if (x instanceof FnOp) return fmt(f, x);
                const res = {};
                for (const k in x) res[k] = fmtRec(x[k]);
                return res;
              };
              deepStrictEqual(f.memory.basic.stack.region, {
                spec: {
                  kind: 'array',
                  type: { kind: 'scalar', type: 'u32', opts: {} },
                  sizes: [4, 2],
                  opts: {},
                },
                size: 32,
                count: 8,
                opts: {},
                paddedSize: 32,
                pos: 16,
              });
              deepStrictEqual(fmtRec(f.memory.basic.stack.get()), [
                [
                  'u32.load(u32.const(value=0), align=2, name=basic, offset=16)',
                  'u32.load(u32.const(value=0), align=2, name=basic, offset=20)',
                ],
                [
                  'u32.load(u32.const(value=0), align=2, name=basic, offset=24)',
                  'u32.load(u32.const(value=0), align=2, name=basic, offset=28)',
                ],
                [
                  'u32.load(u32.const(value=0), align=2, name=basic, offset=32)',
                  'u32.load(u32.const(value=0), align=2, name=basic, offset=36)',
                ],
                [
                  'u32.load(u32.const(value=0), align=2, name=basic, offset=40)',
                  'u32.load(u32.const(value=0), align=2, name=basic, offset=44)',
                ],
              ]);
              deepStrictEqual(fmtRec(f.memory.basic.stack.as('u64').get()), [
                ['u64.load(u32.const(value=0), align=3, name=basic, offset=16)'],
                ['u64.load(u32.const(value=0), align=3, name=basic, offset=24)'],
                ['u64.load(u32.const(value=0), align=3, name=basic, offset=32)'],
                ['u64.load(u32.const(value=0), align=3, name=basic, offset=40)'],
              ]);
              deepStrictEqual(fmtRec(f.memory.basic.stack2.get()), [
                [
                  'u64.load(u32.const(value=0), align=3, name=basic, offset=48)',
                  'u64.load(u32.const(value=0), align=3, name=basic, offset=56)',
                ],
                [
                  'u64.load(u32.const(value=0), align=3, name=basic, offset=64)',
                  'u64.load(u32.const(value=0), align=3, name=basic, offset=72)',
                ],
                [
                  'u64.load(u32.const(value=0), align=3, name=basic, offset=80)',
                  'u64.load(u32.const(value=0), align=3, name=basic, offset=88)',
                ],
                [
                  'u64.load(u32.const(value=0), align=3, name=basic, offset=96)',
                  'u64.load(u32.const(value=0), align=3, name=basic, offset=104)',
                ],
              ]);
              deepStrictEqual(fmtRec(f.memory.basic.stack2.as('u64x2').get()), [
                ['u64x2.load(u32.const(value=0), align=4, name=basic, offset=48)'],
                ['u64x2.load(u32.const(value=0), align=4, name=basic, offset=64)'],
                ['u64x2.load(u32.const(value=0), align=4, name=basic, offset=80)'],
                ['u64x2.load(u32.const(value=0), align=4, name=basic, offset=96)'],
              ]);
              deepStrictEqual(fmtRec(f.memory.basic.stack2.as('u32x4').get()), [
                ['u32x4.load(u32.const(value=0), align=4, name=basic, offset=48)'],
                ['u32x4.load(u32.const(value=0), align=4, name=basic, offset=64)'],
                ['u32x4.load(u32.const(value=0), align=4, name=basic, offset=80)'],
                ['u32x4.load(u32.const(value=0), align=4, name=basic, offset=96)'],
              ]);
              deepStrictEqual(fmtRec(f.memory.basic.stack2.as('u32').get()), [
                [
                  'u32.load(u32.const(value=0), align=2, name=basic, offset=48)',
                  'u32.load(u32.const(value=0), align=2, name=basic, offset=52)',
                  'u32.load(u32.const(value=0), align=2, name=basic, offset=56)',
                  'u32.load(u32.const(value=0), align=2, name=basic, offset=60)',
                ],
                [
                  'u32.load(u32.const(value=0), align=2, name=basic, offset=64)',
                  'u32.load(u32.const(value=0), align=2, name=basic, offset=68)',
                  'u32.load(u32.const(value=0), align=2, name=basic, offset=72)',
                  'u32.load(u32.const(value=0), align=2, name=basic, offset=76)',
                ],
                [
                  'u32.load(u32.const(value=0), align=2, name=basic, offset=80)',
                  'u32.load(u32.const(value=0), align=2, name=basic, offset=84)',
                  'u32.load(u32.const(value=0), align=2, name=basic, offset=88)',
                  'u32.load(u32.const(value=0), align=2, name=basic, offset=92)',
                ],
                [
                  'u32.load(u32.const(value=0), align=2, name=basic, offset=96)',
                  'u32.load(u32.const(value=0), align=2, name=basic, offset=100)',
                  'u32.load(u32.const(value=0), align=2, name=basic, offset=104)',
                  'u32.load(u32.const(value=0), align=2, name=basic, offset=108)',
                ],
              ]);
              // scalar
              //                            chunksDone: 'u64',
              //              flags: 'u32',
              deepStrictEqual(
                fmtRec(f.memory.basic.chunksDone.get()),
                'u64.load(u32.const(value=0), align=32, name=basic, offset=0)'
              );
              deepStrictEqual(fmtRec(f.memory.basic.chunksDone.as('u32').get()), [
                'u32.load(u32.const(value=0), align=2, name=basic, offset=0)',
                'u32.load(u32.const(value=0), align=2, name=basic, offset=4)',
              ]);
              deepStrictEqual(
                fmtRec(f.memory.basic.flags.get()),
                'u32.load(u32.const(value=0), align=3, name=basic, offset=8)'
              );
              throws(() => f.memory.basic.flags.as('u64').get());
              deepStrictEqual(fmtRec(f.memory.basic.flags.as8().get()), [
                'u32.load(u32.const(value=0), size=8, align=0, name=basic, offset=8)',
                'u32.load(u32.const(value=0), size=8, align=0, name=basic, offset=9)',
                'u32.load(u32.const(value=0), size=8, align=0, name=basic, offset=10)',
                'u32.load(u32.const(value=0), size=8, align=0, name=basic, offset=11)',
              ]);
              deepStrictEqual(fmtRec(f.memory.basic.flags.as8().as('u64').get()), [
                'u64.load(u32.const(value=0), size=8, align=0, name=basic, offset=8)',
                'u64.load(u32.const(value=0), size=8, align=0, name=basic, offset=9)',
                'u64.load(u32.const(value=0), size=8, align=0, name=basic, offset=10)',
                'u64.load(u32.const(value=0), size=8, align=0, name=basic, offset=11)',
              ]);
              deepStrictEqual(
                fmtRec(f.memory.basic.flags.as8()[0].get()),
                'u32.load(u32.const(value=0), size=8, align=0, name=basic, offset=8)'
              );
              deepStrictEqual(
                fmtRec(f.memory.basic.flags.as8()[0].as('u64').get()),
                'u64.load(u32.const(value=0), size=8, align=0, name=basic, offset=8)'
              );
              called++;
            }
          );
        toWasm(mod, { useSIMD: false });
        toJs(mod);
        deepStrictEqual(called, 2);
      });
      should('reshape', () => {
        let called = 0;
        const mod = new Module('wat')
          .mem(
            'basic',
            struct({
              chunksDone: 'u64',
              flags: 'u32',
              stack: array('u32', {}, 3, 2, 4),
            })
          )
          .batchFn(
            'test',
            { lanes: 1 },
            ['u32', 'u32', 'u32', 'u32'],
            (f, type, batchPos, _blocks, _outBlockLen, _isLast) => {
              const { u32, u64 } = f.types;
              const fmtRec = (x) => {
                if (Array.isArray(x)) return x.map(fmtRec);
                if (x instanceof FnOp) return fmt(f, x);
                const res = {};
                for (const k in x) res[k] = fmtRec(x[k]);
                return res;
              };
              deepStrictEqual(f.memory.basic.stack.region, {
                spec: {
                  kind: 'array',
                  type: { kind: 'scalar', type: 'u32', opts: {} },
                  sizes: [3, 2, 4],
                  opts: {},
                },
                size: 96,
                count: 24,
                opts: {},
                paddedSize: 96,
                pos: 16,
              });
              deepStrictEqual(f.memory.basic.stack.reshape(2, 4, 3).region, {
                spec: {
                  kind: 'array',
                  type: { kind: 'scalar', type: 'u32', opts: {} },
                  sizes: [2, 4, 3],
                  opts: {},
                },
                size: 96,
                count: 24,
                opts: {},
                paddedSize: 96,
                pos: 16,
              });
              deepStrictEqual(f.memory.basic.stack.reshape(4, 2, 3).region, {
                spec: {
                  kind: 'array',
                  type: { kind: 'scalar', type: 'u32', opts: {} },
                  sizes: [4, 2, 3],
                  opts: {},
                },
                size: 96,
                count: 24,
                opts: {},
                paddedSize: 96,
                pos: 16,
              });
              deepStrictEqual(f.memory.basic.stack.flat().region, {
                spec: {
                  kind: 'array',
                  type: { kind: 'scalar', type: 'u32', opts: {} },
                  sizes: [24],
                  opts: {},
                },
                size: 96,
                count: 24,
                opts: {},
                paddedSize: 96,
                pos: 16,
              });

              deepStrictEqual(fmtRec(f.memory.basic.stack.get()), [
                [
                  [
                    'u32.load(u32.const(value=0), align=2, name=basic, offset=16)',
                    'u32.load(u32.const(value=0), align=2, name=basic, offset=20)',
                    'u32.load(u32.const(value=0), align=2, name=basic, offset=24)',
                    'u32.load(u32.const(value=0), align=2, name=basic, offset=28)',
                  ],
                  [
                    'u32.load(u32.const(value=0), align=2, name=basic, offset=32)',
                    'u32.load(u32.const(value=0), align=2, name=basic, offset=36)',
                    'u32.load(u32.const(value=0), align=2, name=basic, offset=40)',
                    'u32.load(u32.const(value=0), align=2, name=basic, offset=44)',
                  ],
                ],
                [
                  [
                    'u32.load(u32.const(value=0), align=2, name=basic, offset=48)',
                    'u32.load(u32.const(value=0), align=2, name=basic, offset=52)',
                    'u32.load(u32.const(value=0), align=2, name=basic, offset=56)',
                    'u32.load(u32.const(value=0), align=2, name=basic, offset=60)',
                  ],
                  [
                    'u32.load(u32.const(value=0), align=2, name=basic, offset=64)',
                    'u32.load(u32.const(value=0), align=2, name=basic, offset=68)',
                    'u32.load(u32.const(value=0), align=2, name=basic, offset=72)',
                    'u32.load(u32.const(value=0), align=2, name=basic, offset=76)',
                  ],
                ],
                [
                  [
                    'u32.load(u32.const(value=0), align=2, name=basic, offset=80)',
                    'u32.load(u32.const(value=0), align=2, name=basic, offset=84)',
                    'u32.load(u32.const(value=0), align=2, name=basic, offset=88)',
                    'u32.load(u32.const(value=0), align=2, name=basic, offset=92)',
                  ],
                  [
                    'u32.load(u32.const(value=0), align=2, name=basic, offset=96)',
                    'u32.load(u32.const(value=0), align=2, name=basic, offset=100)',
                    'u32.load(u32.const(value=0), align=2, name=basic, offset=104)',
                    'u32.load(u32.const(value=0), align=2, name=basic, offset=108)',
                  ],
                ],
              ]);
              deepStrictEqual(fmtRec(f.memory.basic.stack.reshape(4, 2, 3).get()), [
                [
                  [
                    'u32.load(u32.const(value=0), align=2, name=basic, offset=16)',
                    'u32.load(u32.const(value=0), align=2, name=basic, offset=20)',
                    'u32.load(u32.const(value=0), align=2, name=basic, offset=24)',
                  ],
                  [
                    'u32.load(u32.const(value=0), align=2, name=basic, offset=28)',
                    'u32.load(u32.const(value=0), align=2, name=basic, offset=32)',
                    'u32.load(u32.const(value=0), align=2, name=basic, offset=36)',
                  ],
                ],
                [
                  [
                    'u32.load(u32.const(value=0), align=2, name=basic, offset=40)',
                    'u32.load(u32.const(value=0), align=2, name=basic, offset=44)',
                    'u32.load(u32.const(value=0), align=2, name=basic, offset=48)',
                  ],
                  [
                    'u32.load(u32.const(value=0), align=2, name=basic, offset=52)',
                    'u32.load(u32.const(value=0), align=2, name=basic, offset=56)',
                    'u32.load(u32.const(value=0), align=2, name=basic, offset=60)',
                  ],
                ],
                [
                  [
                    'u32.load(u32.const(value=0), align=2, name=basic, offset=64)',
                    'u32.load(u32.const(value=0), align=2, name=basic, offset=68)',
                    'u32.load(u32.const(value=0), align=2, name=basic, offset=72)',
                  ],
                  [
                    'u32.load(u32.const(value=0), align=2, name=basic, offset=76)',
                    'u32.load(u32.const(value=0), align=2, name=basic, offset=80)',
                    'u32.load(u32.const(value=0), align=2, name=basic, offset=84)',
                  ],
                ],
                [
                  [
                    'u32.load(u32.const(value=0), align=2, name=basic, offset=88)',
                    'u32.load(u32.const(value=0), align=2, name=basic, offset=92)',
                    'u32.load(u32.const(value=0), align=2, name=basic, offset=96)',
                  ],
                  [
                    'u32.load(u32.const(value=0), align=2, name=basic, offset=100)',
                    'u32.load(u32.const(value=0), align=2, name=basic, offset=104)',
                    'u32.load(u32.const(value=0), align=2, name=basic, offset=108)',
                  ],
                ],
              ]);
              deepStrictEqual(fmtRec(f.memory.basic.stack.reshape(4, 6).get()), [
                [
                  'u32.load(u32.const(value=0), align=2, name=basic, offset=16)',
                  'u32.load(u32.const(value=0), align=2, name=basic, offset=20)',
                  'u32.load(u32.const(value=0), align=2, name=basic, offset=24)',
                  'u32.load(u32.const(value=0), align=2, name=basic, offset=28)',
                  'u32.load(u32.const(value=0), align=2, name=basic, offset=32)',
                  'u32.load(u32.const(value=0), align=2, name=basic, offset=36)',
                ],
                [
                  'u32.load(u32.const(value=0), align=2, name=basic, offset=40)',
                  'u32.load(u32.const(value=0), align=2, name=basic, offset=44)',
                  'u32.load(u32.const(value=0), align=2, name=basic, offset=48)',
                  'u32.load(u32.const(value=0), align=2, name=basic, offset=52)',
                  'u32.load(u32.const(value=0), align=2, name=basic, offset=56)',
                  'u32.load(u32.const(value=0), align=2, name=basic, offset=60)',
                ],
                [
                  'u32.load(u32.const(value=0), align=2, name=basic, offset=64)',
                  'u32.load(u32.const(value=0), align=2, name=basic, offset=68)',
                  'u32.load(u32.const(value=0), align=2, name=basic, offset=72)',
                  'u32.load(u32.const(value=0), align=2, name=basic, offset=76)',
                  'u32.load(u32.const(value=0), align=2, name=basic, offset=80)',
                  'u32.load(u32.const(value=0), align=2, name=basic, offset=84)',
                ],
                [
                  'u32.load(u32.const(value=0), align=2, name=basic, offset=88)',
                  'u32.load(u32.const(value=0), align=2, name=basic, offset=92)',
                  'u32.load(u32.const(value=0), align=2, name=basic, offset=96)',
                  'u32.load(u32.const(value=0), align=2, name=basic, offset=100)',
                  'u32.load(u32.const(value=0), align=2, name=basic, offset=104)',
                  'u32.load(u32.const(value=0), align=2, name=basic, offset=108)',
                ],
              ]);
              deepStrictEqual(fmtRec(f.memory.basic.stack.flat().get()), [
                'u32.load(u32.const(value=0), align=2, name=basic, offset=16)',
                'u32.load(u32.const(value=0), align=2, name=basic, offset=20)',
                'u32.load(u32.const(value=0), align=2, name=basic, offset=24)',
                'u32.load(u32.const(value=0), align=2, name=basic, offset=28)',
                'u32.load(u32.const(value=0), align=2, name=basic, offset=32)',
                'u32.load(u32.const(value=0), align=2, name=basic, offset=36)',
                'u32.load(u32.const(value=0), align=2, name=basic, offset=40)',
                'u32.load(u32.const(value=0), align=2, name=basic, offset=44)',
                'u32.load(u32.const(value=0), align=2, name=basic, offset=48)',
                'u32.load(u32.const(value=0), align=2, name=basic, offset=52)',
                'u32.load(u32.const(value=0), align=2, name=basic, offset=56)',
                'u32.load(u32.const(value=0), align=2, name=basic, offset=60)',
                'u32.load(u32.const(value=0), align=2, name=basic, offset=64)',
                'u32.load(u32.const(value=0), align=2, name=basic, offset=68)',
                'u32.load(u32.const(value=0), align=2, name=basic, offset=72)',
                'u32.load(u32.const(value=0), align=2, name=basic, offset=76)',
                'u32.load(u32.const(value=0), align=2, name=basic, offset=80)',
                'u32.load(u32.const(value=0), align=2, name=basic, offset=84)',
                'u32.load(u32.const(value=0), align=2, name=basic, offset=88)',
                'u32.load(u32.const(value=0), align=2, name=basic, offset=92)',
                'u32.load(u32.const(value=0), align=2, name=basic, offset=96)',
                'u32.load(u32.const(value=0), align=2, name=basic, offset=100)',
                'u32.load(u32.const(value=0), align=2, name=basic, offset=104)',
                'u32.load(u32.const(value=0), align=2, name=basic, offset=108)',
              ]);
              const flatOp = f.memory.basic.stack.flat();
              const flat = fmtRec(flatOp.get());
              for (const c of [
                [4, 2, 3],
                [4, 6],
                [24],
                [2, 3, 4],
                [4, 3, 2],
                [2, 4, 3],
                [8, 3],
                [12, 2],
                [2, 12],
                [3, 2, 4],
                [3, 4, 2],
                [1, 3, 4, 2],
                [1, 1, 1, 1, 1, 3, 4, 2],
                [1, 3, 1, 4, 1, 2, 1],
              ]) {
                deepStrictEqual(
                  fmtRec(f.memory.basic.stack.reshape(...c).get()).flat(Infinity),
                  flat
                );
                deepStrictEqual(
                  fmtRec(
                    f.memory.basic.stack
                      .reshape(...c)
                      .as8()
                      .get()
                  ),
                  fmtRec(flatOp.as8().get())
                );
                deepStrictEqual(
                  fmtRec(
                    f.memory.basic.stack
                      .reshape(...c)
                      .as16()
                      .get()
                  ),
                  fmtRec(flatOp.as16().get())
                );
              }
              const s1 = u32.const(4);
              const s2 = u32.const(2);
              const s3 = u32.const(3);
              const rSym = f.memory.basic.stack.reshape(s1, s2, s3);
              const rRaw = f.memory.basic.stack.reshape(4, 2, 3);

              const r1 = [];
              const r2 = [];
              const r3 = [];
              const r4 = [];

              for (let i0 = 0; i0 < 4; i0++) {
                for (let i1 = 0; i1 < 2; i1++) {
                  for (let i2 = 0; i2 < 3; i2++) {
                    r1.push(fmtRec(rSym[i0][i1][i2].get())); // symbolic size + static index
                    r2.push(fmtRec(rRaw[i0][i1][i2].get())); // static size + static index
                    r3.push(fmtRec(rSym[u32.const(i0)][u32.const(i1)][u32.const(i2)].get())); // symbolic size + symbolic index
                    r4.push(fmtRec(rRaw[u32.const(i0)][u32.const(i1)][u32.const(i2)].get())); // static size + symbolic index
                  }
                }
              }
              const rAll = r1.map((i, j) => [i, r2[j], r3[j], r4[j]]);
              deepStrictEqual(rAll, [
                [
                  'u32.load(u32.const(value=0), align=4, name=basic, offset=16)',
                  'u32.load(u32.const(value=0), align=4, name=basic, offset=16)',
                  'u32.load(u32.add(u32.mul(u32.const(value=0), u32.const(value=4), u32.const(value=2), u32.const(value=3)), u32.mul(u32.const(value=0), u32.const(value=4), u32.const(value=3)), u32.mul(u32.const(value=0), u32.const(value=4)), u32.const(value=16)), align=2, name=basic)',
                  'u32.load(u32.add(u32.mul(u32.const(value=0), u32.const(value=24)), u32.mul(u32.const(value=0), u32.const(value=12)), u32.mul(u32.const(value=0), u32.const(value=4)), u32.const(value=16)), align=2, name=basic)',
                ],
                [
                  'u32.load(u32.const(value=0), align=2, name=basic, offset=20)',
                  'u32.load(u32.const(value=0), align=2, name=basic, offset=20)',
                  'u32.load(u32.add(u32.mul(u32.const(value=0), u32.const(value=4), u32.const(value=2), u32.const(value=3)), u32.mul(u32.const(value=0), u32.const(value=4), u32.const(value=3)), u32.mul(u32.const(value=1), u32.const(value=4)), u32.const(value=16)), align=2, name=basic)',
                  'u32.load(u32.add(u32.mul(u32.const(value=0), u32.const(value=24)), u32.mul(u32.const(value=0), u32.const(value=12)), u32.mul(u32.const(value=1), u32.const(value=4)), u32.const(value=16)), align=2, name=basic)',
                ],
                [
                  'u32.load(u32.const(value=0), align=3, name=basic, offset=24)',
                  'u32.load(u32.const(value=0), align=3, name=basic, offset=24)',
                  'u32.load(u32.add(u32.mul(u32.const(value=0), u32.const(value=4), u32.const(value=2), u32.const(value=3)), u32.mul(u32.const(value=0), u32.const(value=4), u32.const(value=3)), u32.mul(u32.const(value=2), u32.const(value=4)), u32.const(value=16)), align=2, name=basic)',
                  'u32.load(u32.add(u32.mul(u32.const(value=0), u32.const(value=24)), u32.mul(u32.const(value=0), u32.const(value=12)), u32.mul(u32.const(value=2), u32.const(value=4)), u32.const(value=16)), align=2, name=basic)',
                ],
                [
                  'u32.load(u32.add(u32.mul(u32.const(value=4), u32.const(value=3)), u32.const(value=16)), align=2, name=basic)',
                  'u32.load(u32.const(value=0), align=2, name=basic, offset=28)',
                  'u32.load(u32.add(u32.mul(u32.const(value=0), u32.const(value=4), u32.const(value=2), u32.const(value=3)), u32.mul(u32.const(value=1), u32.const(value=4), u32.const(value=3)), u32.mul(u32.const(value=0), u32.const(value=4)), u32.const(value=16)), align=2, name=basic)',
                  'u32.load(u32.add(u32.mul(u32.const(value=0), u32.const(value=24)), u32.mul(u32.const(value=1), u32.const(value=12)), u32.mul(u32.const(value=0), u32.const(value=4)), u32.const(value=16)), align=2, name=basic)',
                ],
                [
                  'u32.load(u32.add(u32.mul(u32.const(value=4), u32.const(value=3)), u32.const(value=20)), align=2, name=basic)',
                  'u32.load(u32.const(value=0), align=5, name=basic, offset=32)',
                  'u32.load(u32.add(u32.mul(u32.const(value=0), u32.const(value=4), u32.const(value=2), u32.const(value=3)), u32.mul(u32.const(value=1), u32.const(value=4), u32.const(value=3)), u32.mul(u32.const(value=1), u32.const(value=4)), u32.const(value=16)), align=2, name=basic)',
                  'u32.load(u32.add(u32.mul(u32.const(value=0), u32.const(value=24)), u32.mul(u32.const(value=1), u32.const(value=12)), u32.mul(u32.const(value=1), u32.const(value=4)), u32.const(value=16)), align=2, name=basic)',
                ],
                [
                  'u32.load(u32.add(u32.mul(u32.const(value=4), u32.const(value=3)), u32.const(value=24)), align=2, name=basic)',
                  'u32.load(u32.const(value=0), align=2, name=basic, offset=36)',
                  'u32.load(u32.add(u32.mul(u32.const(value=0), u32.const(value=4), u32.const(value=2), u32.const(value=3)), u32.mul(u32.const(value=1), u32.const(value=4), u32.const(value=3)), u32.mul(u32.const(value=2), u32.const(value=4)), u32.const(value=16)), align=2, name=basic)',
                  'u32.load(u32.add(u32.mul(u32.const(value=0), u32.const(value=24)), u32.mul(u32.const(value=1), u32.const(value=12)), u32.mul(u32.const(value=2), u32.const(value=4)), u32.const(value=16)), align=2, name=basic)',
                ],
                [
                  'u32.load(u32.add(u32.mul(u32.const(value=4), u32.const(value=2), u32.const(value=3)), u32.const(value=16)), align=2, name=basic)',
                  'u32.load(u32.const(value=0), align=3, name=basic, offset=40)',
                  'u32.load(u32.add(u32.mul(u32.const(value=1), u32.const(value=4), u32.const(value=2), u32.const(value=3)), u32.mul(u32.const(value=0), u32.const(value=4), u32.const(value=3)), u32.mul(u32.const(value=0), u32.const(value=4)), u32.const(value=16)), align=2, name=basic)',
                  'u32.load(u32.add(u32.mul(u32.const(value=1), u32.const(value=24)), u32.mul(u32.const(value=0), u32.const(value=12)), u32.mul(u32.const(value=0), u32.const(value=4)), u32.const(value=16)), align=2, name=basic)',
                ],
                [
                  'u32.load(u32.add(u32.mul(u32.const(value=4), u32.const(value=2), u32.const(value=3)), u32.const(value=20)), align=2, name=basic)',
                  'u32.load(u32.const(value=0), align=2, name=basic, offset=44)',
                  'u32.load(u32.add(u32.mul(u32.const(value=1), u32.const(value=4), u32.const(value=2), u32.const(value=3)), u32.mul(u32.const(value=0), u32.const(value=4), u32.const(value=3)), u32.mul(u32.const(value=1), u32.const(value=4)), u32.const(value=16)), align=2, name=basic)',
                  'u32.load(u32.add(u32.mul(u32.const(value=1), u32.const(value=24)), u32.mul(u32.const(value=0), u32.const(value=12)), u32.mul(u32.const(value=1), u32.const(value=4)), u32.const(value=16)), align=2, name=basic)',
                ],
                [
                  'u32.load(u32.add(u32.mul(u32.const(value=4), u32.const(value=2), u32.const(value=3)), u32.const(value=24)), align=2, name=basic)',
                  'u32.load(u32.const(value=0), align=4, name=basic, offset=48)',
                  'u32.load(u32.add(u32.mul(u32.const(value=1), u32.const(value=4), u32.const(value=2), u32.const(value=3)), u32.mul(u32.const(value=0), u32.const(value=4), u32.const(value=3)), u32.mul(u32.const(value=2), u32.const(value=4)), u32.const(value=16)), align=2, name=basic)',
                  'u32.load(u32.add(u32.mul(u32.const(value=1), u32.const(value=24)), u32.mul(u32.const(value=0), u32.const(value=12)), u32.mul(u32.const(value=2), u32.const(value=4)), u32.const(value=16)), align=2, name=basic)',
                ],
                [
                  'u32.load(u32.add(u32.mul(u32.const(value=4), u32.const(value=2), u32.const(value=3)), u32.mul(u32.const(value=4), u32.const(value=3)), u32.const(value=16)), align=2, name=basic)',
                  'u32.load(u32.const(value=0), align=2, name=basic, offset=52)',
                  'u32.load(u32.add(u32.mul(u32.const(value=1), u32.const(value=4), u32.const(value=2), u32.const(value=3)), u32.mul(u32.const(value=1), u32.const(value=4), u32.const(value=3)), u32.mul(u32.const(value=0), u32.const(value=4)), u32.const(value=16)), align=2, name=basic)',
                  'u32.load(u32.add(u32.mul(u32.const(value=1), u32.const(value=24)), u32.mul(u32.const(value=1), u32.const(value=12)), u32.mul(u32.const(value=0), u32.const(value=4)), u32.const(value=16)), align=2, name=basic)',
                ],
                [
                  'u32.load(u32.add(u32.mul(u32.const(value=4), u32.const(value=2), u32.const(value=3)), u32.mul(u32.const(value=4), u32.const(value=3)), u32.const(value=20)), align=2, name=basic)',
                  'u32.load(u32.const(value=0), align=3, name=basic, offset=56)',
                  'u32.load(u32.add(u32.mul(u32.const(value=1), u32.const(value=4), u32.const(value=2), u32.const(value=3)), u32.mul(u32.const(value=1), u32.const(value=4), u32.const(value=3)), u32.mul(u32.const(value=1), u32.const(value=4)), u32.const(value=16)), align=2, name=basic)',
                  'u32.load(u32.add(u32.mul(u32.const(value=1), u32.const(value=24)), u32.mul(u32.const(value=1), u32.const(value=12)), u32.mul(u32.const(value=1), u32.const(value=4)), u32.const(value=16)), align=2, name=basic)',
                ],
                [
                  'u32.load(u32.add(u32.mul(u32.const(value=4), u32.const(value=2), u32.const(value=3)), u32.mul(u32.const(value=4), u32.const(value=3)), u32.const(value=24)), align=2, name=basic)',
                  'u32.load(u32.const(value=0), align=2, name=basic, offset=60)',
                  'u32.load(u32.add(u32.mul(u32.const(value=1), u32.const(value=4), u32.const(value=2), u32.const(value=3)), u32.mul(u32.const(value=1), u32.const(value=4), u32.const(value=3)), u32.mul(u32.const(value=2), u32.const(value=4)), u32.const(value=16)), align=2, name=basic)',
                  'u32.load(u32.add(u32.mul(u32.const(value=1), u32.const(value=24)), u32.mul(u32.const(value=1), u32.const(value=12)), u32.mul(u32.const(value=2), u32.const(value=4)), u32.const(value=16)), align=2, name=basic)',
                ],
                [
                  'u32.load(u32.add(u32.mul(u32.const(value=8), u32.const(value=2), u32.const(value=3)), u32.const(value=16)), align=3, name=basic)',
                  'u32.load(u32.const(value=0), align=6, name=basic, offset=64)',
                  'u32.load(u32.add(u32.mul(u32.const(value=2), u32.const(value=4), u32.const(value=2), u32.const(value=3)), u32.mul(u32.const(value=0), u32.const(value=4), u32.const(value=3)), u32.mul(u32.const(value=0), u32.const(value=4)), u32.const(value=16)), align=2, name=basic)',
                  'u32.load(u32.add(u32.mul(u32.const(value=2), u32.const(value=24)), u32.mul(u32.const(value=0), u32.const(value=12)), u32.mul(u32.const(value=0), u32.const(value=4)), u32.const(value=16)), align=2, name=basic)',
                ],
                [
                  'u32.load(u32.add(u32.mul(u32.const(value=8), u32.const(value=2), u32.const(value=3)), u32.const(value=20)), align=2, name=basic)',
                  'u32.load(u32.const(value=0), align=2, name=basic, offset=68)',
                  'u32.load(u32.add(u32.mul(u32.const(value=2), u32.const(value=4), u32.const(value=2), u32.const(value=3)), u32.mul(u32.const(value=0), u32.const(value=4), u32.const(value=3)), u32.mul(u32.const(value=1), u32.const(value=4)), u32.const(value=16)), align=2, name=basic)',
                  'u32.load(u32.add(u32.mul(u32.const(value=2), u32.const(value=24)), u32.mul(u32.const(value=0), u32.const(value=12)), u32.mul(u32.const(value=1), u32.const(value=4)), u32.const(value=16)), align=2, name=basic)',
                ],
                [
                  'u32.load(u32.add(u32.mul(u32.const(value=8), u32.const(value=2), u32.const(value=3)), u32.const(value=24)), align=3, name=basic)',
                  'u32.load(u32.const(value=0), align=3, name=basic, offset=72)',
                  'u32.load(u32.add(u32.mul(u32.const(value=2), u32.const(value=4), u32.const(value=2), u32.const(value=3)), u32.mul(u32.const(value=0), u32.const(value=4), u32.const(value=3)), u32.mul(u32.const(value=2), u32.const(value=4)), u32.const(value=16)), align=2, name=basic)',
                  'u32.load(u32.add(u32.mul(u32.const(value=2), u32.const(value=24)), u32.mul(u32.const(value=0), u32.const(value=12)), u32.mul(u32.const(value=2), u32.const(value=4)), u32.const(value=16)), align=2, name=basic)',
                ],
                [
                  'u32.load(u32.add(u32.mul(u32.const(value=8), u32.const(value=2), u32.const(value=3)), u32.mul(u32.const(value=4), u32.const(value=3)), u32.const(value=16)), align=2, name=basic)',
                  'u32.load(u32.const(value=0), align=2, name=basic, offset=76)',
                  'u32.load(u32.add(u32.mul(u32.const(value=2), u32.const(value=4), u32.const(value=2), u32.const(value=3)), u32.mul(u32.const(value=1), u32.const(value=4), u32.const(value=3)), u32.mul(u32.const(value=0), u32.const(value=4)), u32.const(value=16)), align=2, name=basic)',
                  'u32.load(u32.add(u32.mul(u32.const(value=2), u32.const(value=24)), u32.mul(u32.const(value=1), u32.const(value=12)), u32.mul(u32.const(value=0), u32.const(value=4)), u32.const(value=16)), align=2, name=basic)',
                ],
                [
                  'u32.load(u32.add(u32.mul(u32.const(value=8), u32.const(value=2), u32.const(value=3)), u32.mul(u32.const(value=4), u32.const(value=3)), u32.const(value=20)), align=2, name=basic)',
                  'u32.load(u32.const(value=0), align=4, name=basic, offset=80)',
                  'u32.load(u32.add(u32.mul(u32.const(value=2), u32.const(value=4), u32.const(value=2), u32.const(value=3)), u32.mul(u32.const(value=1), u32.const(value=4), u32.const(value=3)), u32.mul(u32.const(value=1), u32.const(value=4)), u32.const(value=16)), align=2, name=basic)',
                  'u32.load(u32.add(u32.mul(u32.const(value=2), u32.const(value=24)), u32.mul(u32.const(value=1), u32.const(value=12)), u32.mul(u32.const(value=1), u32.const(value=4)), u32.const(value=16)), align=2, name=basic)',
                ],
                [
                  'u32.load(u32.add(u32.mul(u32.const(value=8), u32.const(value=2), u32.const(value=3)), u32.mul(u32.const(value=4), u32.const(value=3)), u32.const(value=24)), align=2, name=basic)',
                  'u32.load(u32.const(value=0), align=2, name=basic, offset=84)',
                  'u32.load(u32.add(u32.mul(u32.const(value=2), u32.const(value=4), u32.const(value=2), u32.const(value=3)), u32.mul(u32.const(value=1), u32.const(value=4), u32.const(value=3)), u32.mul(u32.const(value=2), u32.const(value=4)), u32.const(value=16)), align=2, name=basic)',
                  'u32.load(u32.add(u32.mul(u32.const(value=2), u32.const(value=24)), u32.mul(u32.const(value=1), u32.const(value=12)), u32.mul(u32.const(value=2), u32.const(value=4)), u32.const(value=16)), align=2, name=basic)',
                ],
                [
                  'u32.load(u32.add(u32.mul(u32.const(value=12), u32.const(value=2), u32.const(value=3)), u32.const(value=16)), align=2, name=basic)',
                  'u32.load(u32.const(value=0), align=3, name=basic, offset=88)',
                  'u32.load(u32.add(u32.mul(u32.const(value=3), u32.const(value=4), u32.const(value=2), u32.const(value=3)), u32.mul(u32.const(value=0), u32.const(value=4), u32.const(value=3)), u32.mul(u32.const(value=0), u32.const(value=4)), u32.const(value=16)), align=2, name=basic)',
                  'u32.load(u32.add(u32.mul(u32.const(value=3), u32.const(value=24)), u32.mul(u32.const(value=0), u32.const(value=12)), u32.mul(u32.const(value=0), u32.const(value=4)), u32.const(value=16)), align=2, name=basic)',
                ],
                [
                  'u32.load(u32.add(u32.mul(u32.const(value=12), u32.const(value=2), u32.const(value=3)), u32.const(value=20)), align=2, name=basic)',
                  'u32.load(u32.const(value=0), align=2, name=basic, offset=92)',
                  'u32.load(u32.add(u32.mul(u32.const(value=3), u32.const(value=4), u32.const(value=2), u32.const(value=3)), u32.mul(u32.const(value=0), u32.const(value=4), u32.const(value=3)), u32.mul(u32.const(value=1), u32.const(value=4)), u32.const(value=16)), align=2, name=basic)',
                  'u32.load(u32.add(u32.mul(u32.const(value=3), u32.const(value=24)), u32.mul(u32.const(value=0), u32.const(value=12)), u32.mul(u32.const(value=1), u32.const(value=4)), u32.const(value=16)), align=2, name=basic)',
                ],
                [
                  'u32.load(u32.add(u32.mul(u32.const(value=12), u32.const(value=2), u32.const(value=3)), u32.const(value=24)), align=2, name=basic)',
                  'u32.load(u32.const(value=0), align=5, name=basic, offset=96)',
                  'u32.load(u32.add(u32.mul(u32.const(value=3), u32.const(value=4), u32.const(value=2), u32.const(value=3)), u32.mul(u32.const(value=0), u32.const(value=4), u32.const(value=3)), u32.mul(u32.const(value=2), u32.const(value=4)), u32.const(value=16)), align=2, name=basic)',
                  'u32.load(u32.add(u32.mul(u32.const(value=3), u32.const(value=24)), u32.mul(u32.const(value=0), u32.const(value=12)), u32.mul(u32.const(value=2), u32.const(value=4)), u32.const(value=16)), align=2, name=basic)',
                ],
                [
                  'u32.load(u32.add(u32.mul(u32.const(value=12), u32.const(value=2), u32.const(value=3)), u32.mul(u32.const(value=4), u32.const(value=3)), u32.const(value=16)), align=2, name=basic)',
                  'u32.load(u32.const(value=0), align=2, name=basic, offset=100)',
                  'u32.load(u32.add(u32.mul(u32.const(value=3), u32.const(value=4), u32.const(value=2), u32.const(value=3)), u32.mul(u32.const(value=1), u32.const(value=4), u32.const(value=3)), u32.mul(u32.const(value=0), u32.const(value=4)), u32.const(value=16)), align=2, name=basic)',
                  'u32.load(u32.add(u32.mul(u32.const(value=3), u32.const(value=24)), u32.mul(u32.const(value=1), u32.const(value=12)), u32.mul(u32.const(value=0), u32.const(value=4)), u32.const(value=16)), align=2, name=basic)',
                ],
                [
                  'u32.load(u32.add(u32.mul(u32.const(value=12), u32.const(value=2), u32.const(value=3)), u32.mul(u32.const(value=4), u32.const(value=3)), u32.const(value=20)), align=2, name=basic)',
                  'u32.load(u32.const(value=0), align=3, name=basic, offset=104)',
                  'u32.load(u32.add(u32.mul(u32.const(value=3), u32.const(value=4), u32.const(value=2), u32.const(value=3)), u32.mul(u32.const(value=1), u32.const(value=4), u32.const(value=3)), u32.mul(u32.const(value=1), u32.const(value=4)), u32.const(value=16)), align=2, name=basic)',
                  'u32.load(u32.add(u32.mul(u32.const(value=3), u32.const(value=24)), u32.mul(u32.const(value=1), u32.const(value=12)), u32.mul(u32.const(value=1), u32.const(value=4)), u32.const(value=16)), align=2, name=basic)',
                ],
                [
                  'u32.load(u32.add(u32.mul(u32.const(value=12), u32.const(value=2), u32.const(value=3)), u32.mul(u32.const(value=4), u32.const(value=3)), u32.const(value=24)), align=2, name=basic)',
                  'u32.load(u32.const(value=0), align=2, name=basic, offset=108)',
                  'u32.load(u32.add(u32.mul(u32.const(value=3), u32.const(value=4), u32.const(value=2), u32.const(value=3)), u32.mul(u32.const(value=1), u32.const(value=4), u32.const(value=3)), u32.mul(u32.const(value=2), u32.const(value=4)), u32.const(value=16)), align=2, name=basic)',
                  'u32.load(u32.add(u32.mul(u32.const(value=3), u32.const(value=24)), u32.mul(u32.const(value=1), u32.const(value=12)), u32.mul(u32.const(value=2), u32.const(value=4)), u32.const(value=16)), align=2, name=basic)',
                ],
              ]);

              // ranges
              deepStrictEqual(f.memory.basic.stack.region, {
                spec: {
                  kind: 'array',
                  type: { kind: 'scalar', type: 'u32', opts: {} },
                  sizes: [3, 2, 4],
                  opts: {},
                },
                size: 96,
                count: 24,
                opts: {},
                paddedSize: 96,
                pos: 16,
              });
              deepStrictEqual(f.memory.basic.stack[0].region, {
                spec: {
                  kind: 'array',
                  type: { kind: 'scalar', type: 'u32', opts: {} },
                  sizes: [2, 4],
                  opts: {},
                },
                size: 32,
                count: 8,
                opts: {},
                paddedSize: 32,
                pos: 16,
              });

              const res = [];
              for (const [pos, len] of [
                [0, 1],
                [1, 1],
              ]) {
                const real = f.memory.basic.stack.range(pos, len);
                const sym1 = f.memory.basic.stack.range(u32.const(pos), len);
                const sym2 = f.memory.basic.stack.range(pos, u32.const(len));
                const sym3 = f.memory.basic.stack.range(u32.const(pos), u32.const(len));

                res.push([real, sym1, sym2, sym3].map((i) => fmtRec(i.as8().zero())));
              }
              deepStrictEqual(res, [
                [
                  'i32.fill(u32.const(value=16), u32.const(value=0), u32.const(value=32), name=basic, isMut=true)',
                  'i32.fill(u32.add(u32.mul(u32.const(value=0), u32.const(value=32)), u32.const(value=16)), u32.const(value=0), u32.const(value=32), name=basic, isMut=true)',
                  'i32.fill(u32.const(value=16), u32.const(value=0), u32.mul(u32.const(value=32), u32.const(value=1)), name=basic, isMut=true)',
                  'i32.fill(u32.add(u32.mul(u32.const(value=0), u32.const(value=32)), u32.const(value=16)), u32.const(value=0), u32.mul(u32.const(value=32), u32.const(value=1)), name=basic, isMut=true)',
                ],
                [
                  'i32.fill(u32.const(value=48), u32.const(value=0), u32.const(value=32), name=basic, isMut=true)',
                  'i32.fill(u32.add(u32.mul(u32.const(value=1), u32.const(value=32)), u32.const(value=16)), u32.const(value=0), u32.const(value=32), name=basic, isMut=true)',
                  'i32.fill(u32.const(value=48), u32.const(value=0), u32.mul(u32.const(value=32), u32.const(value=1)), name=basic, isMut=true)',
                  'i32.fill(u32.add(u32.mul(u32.const(value=1), u32.const(value=32)), u32.const(value=16)), u32.const(value=0), u32.mul(u32.const(value=32), u32.const(value=1)), name=basic, isMut=true)',
                ],
              ]);

              called++;
            }
          );
        toWasm(mod, { useSIMD: false });
        toJs(mod);
        deepStrictEqual(called, 2);
      });
      should('simd', () => {
        let called = 0;
        const mod = new Module('wat')
          .batchMem(
            'basic',
            struct({
              chunksDone: 'u64',
              flags: 'u32',
              stack: array('u32', {}, 3, 2, 4),
              stack2: array('u64', {}, 3, 2, 4),
            })
          )
          .batchFn(
            'test',
            { lanes: 4 },
            ['u32', 'u32', 'u32', 'u32'],
            (f, lanes, batchPos, stackPos, _outBlockLen, _isLast) => {
              if (lanes !== 4) return;
              const { u32, u64 } = f.types;
              const fmtRec = (x) => {
                if (Array.isArray(x)) return x.map(fmtRec);
                if (x instanceof FnOp) return fmt(f, x);
                const res = {};
                for (const k in x) res[k] = fmtRec(x[k]);
                return res;
              };
              const BATCH_SIZE = f.memory.basic.region.count; // depends on compile options
              const r32 = f.memory.basic[batchPos]; // specific batchPos
              const m32 = f.memory.basic.lanes(4)[batchPos];
              deepStrictEqual(m32.region.lanes, {
                lanes: 4,
                offset: 304,
              });
              const m32s = f.memory.basic.reshape(1, u32.const(BATCH_SIZE)).lanes(4)[batchPos];
              deepStrictEqual(m32.region.lanes, {
                lanes: 4,
                offset: 304,
              });
              deepStrictEqual(
                fmtRec(r32.flags.get()),
                'u32.load(u32.add(u32.mul(u32.arg(pos=0), u32.const(value=304)), u32.const(value=8)), align=3, name=basic)'
              );
              deepStrictEqual(
                fmtRec(m32.flags.get()),
                'u32x4.load(u32.add(u32.mul(u32.arg(pos=0), u32.const(value=304)), u32.const(value=920)), align=2, size=32, lane=3, src=u32x4.load(u32.add(u32.mul(u32.arg(pos=0), u32.const(value=304)), u32.const(value=616)), align=2, size=32, lane=2, src=u32x4.load(u32.add(u32.mul(u32.arg(pos=0), u32.const(value=304)), u32.const(value=312)), align=2, size=32, lane=1, src=u32x4.load(u32.add(u32.mul(u32.arg(pos=0), u32.const(value=304)), u32.const(value=8)), align=2, size=32, lane=0, src=u32x4.const(value=0), name=basic), name=basic), name=basic), name=basic)'
              );

              deepStrictEqual(fmtRec(m32.stack.get()), [
                [
                  [
                    'u32x4.shuffle(u32x4.shuffle(u32x4.load(u32.add(u32.mul(u32.arg(pos=0), u32.const(value=304)), u32.const(value=16)), align=4, name=basic), u32x4.load(u32.add(u32.mul(u32.arg(pos=0), u32.const(value=304)), u32.const(value=624)), align=4, name=basic), pattern=0,1,2,3,16,17,18,19,4,5,6,7,20,21,22,23), u32x4.shuffle(u32x4.load(u32.add(u32.mul(u32.arg(pos=0), u32.const(value=304)), u32.const(value=320)), align=4, name=basic), u32x4.load(u32.add(u32.mul(u32.arg(pos=0), u32.const(value=304)), u32.const(value=928)), align=4, name=basic), pattern=0,1,2,3,16,17,18,19,4,5,6,7,20,21,22,23), pattern=0,1,2,3,16,17,18,19,4,5,6,7,20,21,22,23)',
                    'u32x4.shuffle(u32x4.shuffle(u32x4.load(u32.add(u32.mul(u32.arg(pos=0), u32.const(value=304)), u32.const(value=16)), align=4, name=basic), u32x4.load(u32.add(u32.mul(u32.arg(pos=0), u32.const(value=304)), u32.const(value=624)), align=4, name=basic), pattern=0,1,2,3,16,17,18,19,4,5,6,7,20,21,22,23), u32x4.shuffle(u32x4.load(u32.add(u32.mul(u32.arg(pos=0), u32.const(value=304)), u32.const(value=320)), align=4, name=basic), u32x4.load(u32.add(u32.mul(u32.arg(pos=0), u32.const(value=304)), u32.const(value=928)), align=4, name=basic), pattern=0,1,2,3,16,17,18,19,4,5,6,7,20,21,22,23), pattern=8,9,10,11,24,25,26,27,12,13,14,15,28,29,30,31)',
                    'u32x4.shuffle(u32x4.shuffle(u32x4.load(u32.add(u32.mul(u32.arg(pos=0), u32.const(value=304)), u32.const(value=16)), align=4, name=basic), u32x4.load(u32.add(u32.mul(u32.arg(pos=0), u32.const(value=304)), u32.const(value=624)), align=4, name=basic), pattern=8,9,10,11,24,25,26,27,12,13,14,15,28,29,30,31), u32x4.shuffle(u32x4.load(u32.add(u32.mul(u32.arg(pos=0), u32.const(value=304)), u32.const(value=320)), align=4, name=basic), u32x4.load(u32.add(u32.mul(u32.arg(pos=0), u32.const(value=304)), u32.const(value=928)), align=4, name=basic), pattern=8,9,10,11,24,25,26,27,12,13,14,15,28,29,30,31), pattern=0,1,2,3,16,17,18,19,4,5,6,7,20,21,22,23)',
                    'u32x4.shuffle(u32x4.shuffle(u32x4.load(u32.add(u32.mul(u32.arg(pos=0), u32.const(value=304)), u32.const(value=16)), align=4, name=basic), u32x4.load(u32.add(u32.mul(u32.arg(pos=0), u32.const(value=304)), u32.const(value=624)), align=4, name=basic), pattern=8,9,10,11,24,25,26,27,12,13,14,15,28,29,30,31), u32x4.shuffle(u32x4.load(u32.add(u32.mul(u32.arg(pos=0), u32.const(value=304)), u32.const(value=320)), align=4, name=basic), u32x4.load(u32.add(u32.mul(u32.arg(pos=0), u32.const(value=304)), u32.const(value=928)), align=4, name=basic), pattern=8,9,10,11,24,25,26,27,12,13,14,15,28,29,30,31), pattern=8,9,10,11,24,25,26,27,12,13,14,15,28,29,30,31)',
                  ],
                  [
                    'u32x4.shuffle(u32x4.shuffle(u32x4.load(u32.add(u32.add(u32.mul(u32.arg(pos=0), u32.const(value=304)), u32.const(value=16)), u32.const(value=16)), align=4, name=basic), u32x4.load(u32.add(u32.add(u32.mul(u32.arg(pos=0), u32.const(value=304)), u32.const(value=624)), u32.const(value=16)), align=4, name=basic), pattern=0,1,2,3,16,17,18,19,4,5,6,7,20,21,22,23), u32x4.shuffle(u32x4.load(u32.add(u32.add(u32.mul(u32.arg(pos=0), u32.const(value=304)), u32.const(value=320)), u32.const(value=16)), align=4, name=basic), u32x4.load(u32.add(u32.add(u32.mul(u32.arg(pos=0), u32.const(value=304)), u32.const(value=928)), u32.const(value=16)), align=4, name=basic), pattern=0,1,2,3,16,17,18,19,4,5,6,7,20,21,22,23), pattern=0,1,2,3,16,17,18,19,4,5,6,7,20,21,22,23)',
                    'u32x4.shuffle(u32x4.shuffle(u32x4.load(u32.add(u32.add(u32.mul(u32.arg(pos=0), u32.const(value=304)), u32.const(value=16)), u32.const(value=16)), align=4, name=basic), u32x4.load(u32.add(u32.add(u32.mul(u32.arg(pos=0), u32.const(value=304)), u32.const(value=624)), u32.const(value=16)), align=4, name=basic), pattern=0,1,2,3,16,17,18,19,4,5,6,7,20,21,22,23), u32x4.shuffle(u32x4.load(u32.add(u32.add(u32.mul(u32.arg(pos=0), u32.const(value=304)), u32.const(value=320)), u32.const(value=16)), align=4, name=basic), u32x4.load(u32.add(u32.add(u32.mul(u32.arg(pos=0), u32.const(value=304)), u32.const(value=928)), u32.const(value=16)), align=4, name=basic), pattern=0,1,2,3,16,17,18,19,4,5,6,7,20,21,22,23), pattern=8,9,10,11,24,25,26,27,12,13,14,15,28,29,30,31)',
                    'u32x4.shuffle(u32x4.shuffle(u32x4.load(u32.add(u32.add(u32.mul(u32.arg(pos=0), u32.const(value=304)), u32.const(value=16)), u32.const(value=16)), align=4, name=basic), u32x4.load(u32.add(u32.add(u32.mul(u32.arg(pos=0), u32.const(value=304)), u32.const(value=624)), u32.const(value=16)), align=4, name=basic), pattern=8,9,10,11,24,25,26,27,12,13,14,15,28,29,30,31), u32x4.shuffle(u32x4.load(u32.add(u32.add(u32.mul(u32.arg(pos=0), u32.const(value=304)), u32.const(value=320)), u32.const(value=16)), align=4, name=basic), u32x4.load(u32.add(u32.add(u32.mul(u32.arg(pos=0), u32.const(value=304)), u32.const(value=928)), u32.const(value=16)), align=4, name=basic), pattern=8,9,10,11,24,25,26,27,12,13,14,15,28,29,30,31), pattern=0,1,2,3,16,17,18,19,4,5,6,7,20,21,22,23)',
                    'u32x4.shuffle(u32x4.shuffle(u32x4.load(u32.add(u32.add(u32.mul(u32.arg(pos=0), u32.const(value=304)), u32.const(value=16)), u32.const(value=16)), align=4, name=basic), u32x4.load(u32.add(u32.add(u32.mul(u32.arg(pos=0), u32.const(value=304)), u32.const(value=624)), u32.const(value=16)), align=4, name=basic), pattern=8,9,10,11,24,25,26,27,12,13,14,15,28,29,30,31), u32x4.shuffle(u32x4.load(u32.add(u32.add(u32.mul(u32.arg(pos=0), u32.const(value=304)), u32.const(value=320)), u32.const(value=16)), align=4, name=basic), u32x4.load(u32.add(u32.add(u32.mul(u32.arg(pos=0), u32.const(value=304)), u32.const(value=928)), u32.const(value=16)), align=4, name=basic), pattern=8,9,10,11,24,25,26,27,12,13,14,15,28,29,30,31), pattern=8,9,10,11,24,25,26,27,12,13,14,15,28,29,30,31)',
                  ],
                ],
                [
                  [
                    'u32x4.shuffle(u32x4.shuffle(u32x4.load(u32.add(u32.add(u32.add(u32.mul(u32.arg(pos=0), u32.const(value=304)), u32.const(value=16)), u32.const(value=16)), u32.const(value=16)), align=4, name=basic), u32x4.load(u32.add(u32.add(u32.add(u32.mul(u32.arg(pos=0), u32.const(value=304)), u32.const(value=624)), u32.const(value=16)), u32.const(value=16)), align=4, name=basic), pattern=0,1,2,3,16,17,18,19,4,5,6,7,20,21,22,23), u32x4.shuffle(u32x4.load(u32.add(u32.add(u32.add(u32.mul(u32.arg(pos=0), u32.const(value=304)), u32.const(value=320)), u32.const(value=16)), u32.const(value=16)), align=4, name=basic), u32x4.load(u32.add(u32.add(u32.add(u32.mul(u32.arg(pos=0), u32.const(value=304)), u32.const(value=928)), u32.const(value=16)), u32.const(value=16)), align=4, name=basic), pattern=0,1,2,3,16,17,18,19,4,5,6,7,20,21,22,23), pattern=0,1,2,3,16,17,18,19,4,5,6,7,20,21,22,23)',
                    'u32x4.shuffle(u32x4.shuffle(u32x4.load(u32.add(u32.add(u32.add(u32.mul(u32.arg(pos=0), u32.const(value=304)), u32.const(value=16)), u32.const(value=16)), u32.const(value=16)), align=4, name=basic), u32x4.load(u32.add(u32.add(u32.add(u32.mul(u32.arg(pos=0), u32.const(value=304)), u32.const(value=624)), u32.const(value=16)), u32.const(value=16)), align=4, name=basic), pattern=0,1,2,3,16,17,18,19,4,5,6,7,20,21,22,23), u32x4.shuffle(u32x4.load(u32.add(u32.add(u32.add(u32.mul(u32.arg(pos=0), u32.const(value=304)), u32.const(value=320)), u32.const(value=16)), u32.const(value=16)), align=4, name=basic), u32x4.load(u32.add(u32.add(u32.add(u32.mul(u32.arg(pos=0), u32.const(value=304)), u32.const(value=928)), u32.const(value=16)), u32.const(value=16)), align=4, name=basic), pattern=0,1,2,3,16,17,18,19,4,5,6,7,20,21,22,23), pattern=8,9,10,11,24,25,26,27,12,13,14,15,28,29,30,31)',
                    'u32x4.shuffle(u32x4.shuffle(u32x4.load(u32.add(u32.add(u32.add(u32.mul(u32.arg(pos=0), u32.const(value=304)), u32.const(value=16)), u32.const(value=16)), u32.const(value=16)), align=4, name=basic), u32x4.load(u32.add(u32.add(u32.add(u32.mul(u32.arg(pos=0), u32.const(value=304)), u32.const(value=624)), u32.const(value=16)), u32.const(value=16)), align=4, name=basic), pattern=8,9,10,11,24,25,26,27,12,13,14,15,28,29,30,31), u32x4.shuffle(u32x4.load(u32.add(u32.add(u32.add(u32.mul(u32.arg(pos=0), u32.const(value=304)), u32.const(value=320)), u32.const(value=16)), u32.const(value=16)), align=4, name=basic), u32x4.load(u32.add(u32.add(u32.add(u32.mul(u32.arg(pos=0), u32.const(value=304)), u32.const(value=928)), u32.const(value=16)), u32.const(value=16)), align=4, name=basic), pattern=8,9,10,11,24,25,26,27,12,13,14,15,28,29,30,31), pattern=0,1,2,3,16,17,18,19,4,5,6,7,20,21,22,23)',
                    'u32x4.shuffle(u32x4.shuffle(u32x4.load(u32.add(u32.add(u32.add(u32.mul(u32.arg(pos=0), u32.const(value=304)), u32.const(value=16)), u32.const(value=16)), u32.const(value=16)), align=4, name=basic), u32x4.load(u32.add(u32.add(u32.add(u32.mul(u32.arg(pos=0), u32.const(value=304)), u32.const(value=624)), u32.const(value=16)), u32.const(value=16)), align=4, name=basic), pattern=8,9,10,11,24,25,26,27,12,13,14,15,28,29,30,31), u32x4.shuffle(u32x4.load(u32.add(u32.add(u32.add(u32.mul(u32.arg(pos=0), u32.const(value=304)), u32.const(value=320)), u32.const(value=16)), u32.const(value=16)), align=4, name=basic), u32x4.load(u32.add(u32.add(u32.add(u32.mul(u32.arg(pos=0), u32.const(value=304)), u32.const(value=928)), u32.const(value=16)), u32.const(value=16)), align=4, name=basic), pattern=8,9,10,11,24,25,26,27,12,13,14,15,28,29,30,31), pattern=8,9,10,11,24,25,26,27,12,13,14,15,28,29,30,31)',
                  ],
                  [
                    'u32x4.shuffle(u32x4.shuffle(u32x4.load(u32.add(u32.add(u32.add(u32.add(u32.mul(u32.arg(pos=0), u32.const(value=304)), u32.const(value=16)), u32.const(value=16)), u32.const(value=16)), u32.const(value=16)), align=4, name=basic), u32x4.load(u32.add(u32.add(u32.add(u32.add(u32.mul(u32.arg(pos=0), u32.const(value=304)), u32.const(value=624)), u32.const(value=16)), u32.const(value=16)), u32.const(value=16)), align=4, name=basic), pattern=0,1,2,3,16,17,18,19,4,5,6,7,20,21,22,23), u32x4.shuffle(u32x4.load(u32.add(u32.add(u32.add(u32.add(u32.mul(u32.arg(pos=0), u32.const(value=304)), u32.const(value=320)), u32.const(value=16)), u32.const(value=16)), u32.const(value=16)), align=4, name=basic), u32x4.load(u32.add(u32.add(u32.add(u32.add(u32.mul(u32.arg(pos=0), u32.const(value=304)), u32.const(value=928)), u32.const(value=16)), u32.const(value=16)), u32.const(value=16)), align=4, name=basic), pattern=0,1,2,3,16,17,18,19,4,5,6,7,20,21,22,23), pattern=0,1,2,3,16,17,18,19,4,5,6,7,20,21,22,23)',
                    'u32x4.shuffle(u32x4.shuffle(u32x4.load(u32.add(u32.add(u32.add(u32.add(u32.mul(u32.arg(pos=0), u32.const(value=304)), u32.const(value=16)), u32.const(value=16)), u32.const(value=16)), u32.const(value=16)), align=4, name=basic), u32x4.load(u32.add(u32.add(u32.add(u32.add(u32.mul(u32.arg(pos=0), u32.const(value=304)), u32.const(value=624)), u32.const(value=16)), u32.const(value=16)), u32.const(value=16)), align=4, name=basic), pattern=0,1,2,3,16,17,18,19,4,5,6,7,20,21,22,23), u32x4.shuffle(u32x4.load(u32.add(u32.add(u32.add(u32.add(u32.mul(u32.arg(pos=0), u32.const(value=304)), u32.const(value=320)), u32.const(value=16)), u32.const(value=16)), u32.const(value=16)), align=4, name=basic), u32x4.load(u32.add(u32.add(u32.add(u32.add(u32.mul(u32.arg(pos=0), u32.const(value=304)), u32.const(value=928)), u32.const(value=16)), u32.const(value=16)), u32.const(value=16)), align=4, name=basic), pattern=0,1,2,3,16,17,18,19,4,5,6,7,20,21,22,23), pattern=8,9,10,11,24,25,26,27,12,13,14,15,28,29,30,31)',
                    'u32x4.shuffle(u32x4.shuffle(u32x4.load(u32.add(u32.add(u32.add(u32.add(u32.mul(u32.arg(pos=0), u32.const(value=304)), u32.const(value=16)), u32.const(value=16)), u32.const(value=16)), u32.const(value=16)), align=4, name=basic), u32x4.load(u32.add(u32.add(u32.add(u32.add(u32.mul(u32.arg(pos=0), u32.const(value=304)), u32.const(value=624)), u32.const(value=16)), u32.const(value=16)), u32.const(value=16)), align=4, name=basic), pattern=8,9,10,11,24,25,26,27,12,13,14,15,28,29,30,31), u32x4.shuffle(u32x4.load(u32.add(u32.add(u32.add(u32.add(u32.mul(u32.arg(pos=0), u32.const(value=304)), u32.const(value=320)), u32.const(value=16)), u32.const(value=16)), u32.const(value=16)), align=4, name=basic), u32x4.load(u32.add(u32.add(u32.add(u32.add(u32.mul(u32.arg(pos=0), u32.const(value=304)), u32.const(value=928)), u32.const(value=16)), u32.const(value=16)), u32.const(value=16)), align=4, name=basic), pattern=8,9,10,11,24,25,26,27,12,13,14,15,28,29,30,31), pattern=0,1,2,3,16,17,18,19,4,5,6,7,20,21,22,23)',
                    'u32x4.shuffle(u32x4.shuffle(u32x4.load(u32.add(u32.add(u32.add(u32.add(u32.mul(u32.arg(pos=0), u32.const(value=304)), u32.const(value=16)), u32.const(value=16)), u32.const(value=16)), u32.const(value=16)), align=4, name=basic), u32x4.load(u32.add(u32.add(u32.add(u32.add(u32.mul(u32.arg(pos=0), u32.const(value=304)), u32.const(value=624)), u32.const(value=16)), u32.const(value=16)), u32.const(value=16)), align=4, name=basic), pattern=8,9,10,11,24,25,26,27,12,13,14,15,28,29,30,31), u32x4.shuffle(u32x4.load(u32.add(u32.add(u32.add(u32.add(u32.mul(u32.arg(pos=0), u32.const(value=304)), u32.const(value=320)), u32.const(value=16)), u32.const(value=16)), u32.const(value=16)), align=4, name=basic), u32x4.load(u32.add(u32.add(u32.add(u32.add(u32.mul(u32.arg(pos=0), u32.const(value=304)), u32.const(value=928)), u32.const(value=16)), u32.const(value=16)), u32.const(value=16)), align=4, name=basic), pattern=8,9,10,11,24,25,26,27,12,13,14,15,28,29,30,31), pattern=8,9,10,11,24,25,26,27,12,13,14,15,28,29,30,31)',
                  ],
                ],
                [
                  [
                    'u32x4.shuffle(u32x4.shuffle(u32x4.load(u32.add(u32.add(u32.add(u32.add(u32.add(u32.mul(u32.arg(pos=0), u32.const(value=304)), u32.const(value=16)), u32.const(value=16)), u32.const(value=16)), u32.const(value=16)), u32.const(value=16)), align=4, name=basic), u32x4.load(u32.add(u32.add(u32.add(u32.add(u32.add(u32.mul(u32.arg(pos=0), u32.const(value=304)), u32.const(value=624)), u32.const(value=16)), u32.const(value=16)), u32.const(value=16)), u32.const(value=16)), align=4, name=basic), pattern=0,1,2,3,16,17,18,19,4,5,6,7,20,21,22,23), u32x4.shuffle(u32x4.load(u32.add(u32.add(u32.add(u32.add(u32.add(u32.mul(u32.arg(pos=0), u32.const(value=304)), u32.const(value=320)), u32.const(value=16)), u32.const(value=16)), u32.const(value=16)), u32.const(value=16)), align=4, name=basic), u32x4.load(u32.add(u32.add(u32.add(u32.add(u32.add(u32.mul(u32.arg(pos=0), u32.const(value=304)), u32.const(value=928)), u32.const(value=16)), u32.const(value=16)), u32.const(value=16)), u32.const(value=16)), align=4, name=basic), pattern=0,1,2,3,16,17,18,19,4,5,6,7,20,21,22,23), pattern=0,1,2,3,16,17,18,19,4,5,6,7,20,21,22,23)',
                    'u32x4.shuffle(u32x4.shuffle(u32x4.load(u32.add(u32.add(u32.add(u32.add(u32.add(u32.mul(u32.arg(pos=0), u32.const(value=304)), u32.const(value=16)), u32.const(value=16)), u32.const(value=16)), u32.const(value=16)), u32.const(value=16)), align=4, name=basic), u32x4.load(u32.add(u32.add(u32.add(u32.add(u32.add(u32.mul(u32.arg(pos=0), u32.const(value=304)), u32.const(value=624)), u32.const(value=16)), u32.const(value=16)), u32.const(value=16)), u32.const(value=16)), align=4, name=basic), pattern=0,1,2,3,16,17,18,19,4,5,6,7,20,21,22,23), u32x4.shuffle(u32x4.load(u32.add(u32.add(u32.add(u32.add(u32.add(u32.mul(u32.arg(pos=0), u32.const(value=304)), u32.const(value=320)), u32.const(value=16)), u32.const(value=16)), u32.const(value=16)), u32.const(value=16)), align=4, name=basic), u32x4.load(u32.add(u32.add(u32.add(u32.add(u32.add(u32.mul(u32.arg(pos=0), u32.const(value=304)), u32.const(value=928)), u32.const(value=16)), u32.const(value=16)), u32.const(value=16)), u32.const(value=16)), align=4, name=basic), pattern=0,1,2,3,16,17,18,19,4,5,6,7,20,21,22,23), pattern=8,9,10,11,24,25,26,27,12,13,14,15,28,29,30,31)',
                    'u32x4.shuffle(u32x4.shuffle(u32x4.load(u32.add(u32.add(u32.add(u32.add(u32.add(u32.mul(u32.arg(pos=0), u32.const(value=304)), u32.const(value=16)), u32.const(value=16)), u32.const(value=16)), u32.const(value=16)), u32.const(value=16)), align=4, name=basic), u32x4.load(u32.add(u32.add(u32.add(u32.add(u32.add(u32.mul(u32.arg(pos=0), u32.const(value=304)), u32.const(value=624)), u32.const(value=16)), u32.const(value=16)), u32.const(value=16)), u32.const(value=16)), align=4, name=basic), pattern=8,9,10,11,24,25,26,27,12,13,14,15,28,29,30,31), u32x4.shuffle(u32x4.load(u32.add(u32.add(u32.add(u32.add(u32.add(u32.mul(u32.arg(pos=0), u32.const(value=304)), u32.const(value=320)), u32.const(value=16)), u32.const(value=16)), u32.const(value=16)), u32.const(value=16)), align=4, name=basic), u32x4.load(u32.add(u32.add(u32.add(u32.add(u32.add(u32.mul(u32.arg(pos=0), u32.const(value=304)), u32.const(value=928)), u32.const(value=16)), u32.const(value=16)), u32.const(value=16)), u32.const(value=16)), align=4, name=basic), pattern=8,9,10,11,24,25,26,27,12,13,14,15,28,29,30,31), pattern=0,1,2,3,16,17,18,19,4,5,6,7,20,21,22,23)',
                    'u32x4.shuffle(u32x4.shuffle(u32x4.load(u32.add(u32.add(u32.add(u32.add(u32.add(u32.mul(u32.arg(pos=0), u32.const(value=304)), u32.const(value=16)), u32.const(value=16)), u32.const(value=16)), u32.const(value=16)), u32.const(value=16)), align=4, name=basic), u32x4.load(u32.add(u32.add(u32.add(u32.add(u32.add(u32.mul(u32.arg(pos=0), u32.const(value=304)), u32.const(value=624)), u32.const(value=16)), u32.const(value=16)), u32.const(value=16)), u32.const(value=16)), align=4, name=basic), pattern=8,9,10,11,24,25,26,27,12,13,14,15,28,29,30,31), u32x4.shuffle(u32x4.load(u32.add(u32.add(u32.add(u32.add(u32.add(u32.mul(u32.arg(pos=0), u32.const(value=304)), u32.const(value=320)), u32.const(value=16)), u32.const(value=16)), u32.const(value=16)), u32.const(value=16)), align=4, name=basic), u32x4.load(u32.add(u32.add(u32.add(u32.add(u32.add(u32.mul(u32.arg(pos=0), u32.const(value=304)), u32.const(value=928)), u32.const(value=16)), u32.const(value=16)), u32.const(value=16)), u32.const(value=16)), align=4, name=basic), pattern=8,9,10,11,24,25,26,27,12,13,14,15,28,29,30,31), pattern=8,9,10,11,24,25,26,27,12,13,14,15,28,29,30,31)',
                  ],
                  [
                    'u32x4.shuffle(u32x4.shuffle(u32x4.load(u32.add(u32.add(u32.add(u32.add(u32.add(u32.add(u32.mul(u32.arg(pos=0), u32.const(value=304)), u32.const(value=16)), u32.const(value=16)), u32.const(value=16)), u32.const(value=16)), u32.const(value=16)), u32.const(value=16)), align=4, name=basic), u32x4.load(u32.add(u32.add(u32.add(u32.add(u32.add(u32.add(u32.mul(u32.arg(pos=0), u32.const(value=304)), u32.const(value=624)), u32.const(value=16)), u32.const(value=16)), u32.const(value=16)), u32.const(value=16)), u32.const(value=16)), align=4, name=basic), pattern=0,1,2,3,16,17,18,19,4,5,6,7,20,21,22,23), u32x4.shuffle(u32x4.load(u32.add(u32.add(u32.add(u32.add(u32.add(u32.add(u32.mul(u32.arg(pos=0), u32.const(value=304)), u32.const(value=320)), u32.const(value=16)), u32.const(value=16)), u32.const(value=16)), u32.const(value=16)), u32.const(value=16)), align=4, name=basic), u32x4.load(u32.add(u32.add(u32.add(u32.add(u32.add(u32.add(u32.mul(u32.arg(pos=0), u32.const(value=304)), u32.const(value=928)), u32.const(value=16)), u32.const(value=16)), u32.const(value=16)), u32.const(value=16)), u32.const(value=16)), align=4, name=basic), pattern=0,1,2,3,16,17,18,19,4,5,6,7,20,21,22,23), pattern=0,1,2,3,16,17,18,19,4,5,6,7,20,21,22,23)',
                    'u32x4.shuffle(u32x4.shuffle(u32x4.load(u32.add(u32.add(u32.add(u32.add(u32.add(u32.add(u32.mul(u32.arg(pos=0), u32.const(value=304)), u32.const(value=16)), u32.const(value=16)), u32.const(value=16)), u32.const(value=16)), u32.const(value=16)), u32.const(value=16)), align=4, name=basic), u32x4.load(u32.add(u32.add(u32.add(u32.add(u32.add(u32.add(u32.mul(u32.arg(pos=0), u32.const(value=304)), u32.const(value=624)), u32.const(value=16)), u32.const(value=16)), u32.const(value=16)), u32.const(value=16)), u32.const(value=16)), align=4, name=basic), pattern=0,1,2,3,16,17,18,19,4,5,6,7,20,21,22,23), u32x4.shuffle(u32x4.load(u32.add(u32.add(u32.add(u32.add(u32.add(u32.add(u32.mul(u32.arg(pos=0), u32.const(value=304)), u32.const(value=320)), u32.const(value=16)), u32.const(value=16)), u32.const(value=16)), u32.const(value=16)), u32.const(value=16)), align=4, name=basic), u32x4.load(u32.add(u32.add(u32.add(u32.add(u32.add(u32.add(u32.mul(u32.arg(pos=0), u32.const(value=304)), u32.const(value=928)), u32.const(value=16)), u32.const(value=16)), u32.const(value=16)), u32.const(value=16)), u32.const(value=16)), align=4, name=basic), pattern=0,1,2,3,16,17,18,19,4,5,6,7,20,21,22,23), pattern=8,9,10,11,24,25,26,27,12,13,14,15,28,29,30,31)',
                    'u32x4.shuffle(u32x4.shuffle(u32x4.load(u32.add(u32.add(u32.add(u32.add(u32.add(u32.add(u32.mul(u32.arg(pos=0), u32.const(value=304)), u32.const(value=16)), u32.const(value=16)), u32.const(value=16)), u32.const(value=16)), u32.const(value=16)), u32.const(value=16)), align=4, name=basic), u32x4.load(u32.add(u32.add(u32.add(u32.add(u32.add(u32.add(u32.mul(u32.arg(pos=0), u32.const(value=304)), u32.const(value=624)), u32.const(value=16)), u32.const(value=16)), u32.const(value=16)), u32.const(value=16)), u32.const(value=16)), align=4, name=basic), pattern=8,9,10,11,24,25,26,27,12,13,14,15,28,29,30,31), u32x4.shuffle(u32x4.load(u32.add(u32.add(u32.add(u32.add(u32.add(u32.add(u32.mul(u32.arg(pos=0), u32.const(value=304)), u32.const(value=320)), u32.const(value=16)), u32.const(value=16)), u32.const(value=16)), u32.const(value=16)), u32.const(value=16)), align=4, name=basic), u32x4.load(u32.add(u32.add(u32.add(u32.add(u32.add(u32.add(u32.mul(u32.arg(pos=0), u32.const(value=304)), u32.const(value=928)), u32.const(value=16)), u32.const(value=16)), u32.const(value=16)), u32.const(value=16)), u32.const(value=16)), align=4, name=basic), pattern=8,9,10,11,24,25,26,27,12,13,14,15,28,29,30,31), pattern=0,1,2,3,16,17,18,19,4,5,6,7,20,21,22,23)',
                    'u32x4.shuffle(u32x4.shuffle(u32x4.load(u32.add(u32.add(u32.add(u32.add(u32.add(u32.add(u32.mul(u32.arg(pos=0), u32.const(value=304)), u32.const(value=16)), u32.const(value=16)), u32.const(value=16)), u32.const(value=16)), u32.const(value=16)), u32.const(value=16)), align=4, name=basic), u32x4.load(u32.add(u32.add(u32.add(u32.add(u32.add(u32.add(u32.mul(u32.arg(pos=0), u32.const(value=304)), u32.const(value=624)), u32.const(value=16)), u32.const(value=16)), u32.const(value=16)), u32.const(value=16)), u32.const(value=16)), align=4, name=basic), pattern=8,9,10,11,24,25,26,27,12,13,14,15,28,29,30,31), u32x4.shuffle(u32x4.load(u32.add(u32.add(u32.add(u32.add(u32.add(u32.add(u32.mul(u32.arg(pos=0), u32.const(value=304)), u32.const(value=320)), u32.const(value=16)), u32.const(value=16)), u32.const(value=16)), u32.const(value=16)), u32.const(value=16)), align=4, name=basic), u32x4.load(u32.add(u32.add(u32.add(u32.add(u32.add(u32.add(u32.mul(u32.arg(pos=0), u32.const(value=304)), u32.const(value=928)), u32.const(value=16)), u32.const(value=16)), u32.const(value=16)), u32.const(value=16)), u32.const(value=16)), align=4, name=basic), pattern=8,9,10,11,24,25,26,27,12,13,14,15,28,29,30,31), pattern=8,9,10,11,24,25,26,27,12,13,14,15,28,29,30,31)',
                  ],
                ],
              ]);
              deepStrictEqual(fmtRec(m32.stack.get()[2]), [
                [
                  'u32x4.shuffle(u32x4.shuffle(u32x4.load(u32.add(u32.add(u32.add(u32.add(u32.add(u32.mul(u32.arg(pos=0), u32.const(value=304)), u32.const(value=16)), u32.const(value=16)), u32.const(value=16)), u32.const(value=16)), u32.const(value=16)), align=4, name=basic), u32x4.load(u32.add(u32.add(u32.add(u32.add(u32.add(u32.mul(u32.arg(pos=0), u32.const(value=304)), u32.const(value=624)), u32.const(value=16)), u32.const(value=16)), u32.const(value=16)), u32.const(value=16)), align=4, name=basic), pattern=0,1,2,3,16,17,18,19,4,5,6,7,20,21,22,23), u32x4.shuffle(u32x4.load(u32.add(u32.add(u32.add(u32.add(u32.add(u32.mul(u32.arg(pos=0), u32.const(value=304)), u32.const(value=320)), u32.const(value=16)), u32.const(value=16)), u32.const(value=16)), u32.const(value=16)), align=4, name=basic), u32x4.load(u32.add(u32.add(u32.add(u32.add(u32.add(u32.mul(u32.arg(pos=0), u32.const(value=304)), u32.const(value=928)), u32.const(value=16)), u32.const(value=16)), u32.const(value=16)), u32.const(value=16)), align=4, name=basic), pattern=0,1,2,3,16,17,18,19,4,5,6,7,20,21,22,23), pattern=0,1,2,3,16,17,18,19,4,5,6,7,20,21,22,23)',
                  'u32x4.shuffle(u32x4.shuffle(u32x4.load(u32.add(u32.add(u32.add(u32.add(u32.add(u32.mul(u32.arg(pos=0), u32.const(value=304)), u32.const(value=16)), u32.const(value=16)), u32.const(value=16)), u32.const(value=16)), u32.const(value=16)), align=4, name=basic), u32x4.load(u32.add(u32.add(u32.add(u32.add(u32.add(u32.mul(u32.arg(pos=0), u32.const(value=304)), u32.const(value=624)), u32.const(value=16)), u32.const(value=16)), u32.const(value=16)), u32.const(value=16)), align=4, name=basic), pattern=0,1,2,3,16,17,18,19,4,5,6,7,20,21,22,23), u32x4.shuffle(u32x4.load(u32.add(u32.add(u32.add(u32.add(u32.add(u32.mul(u32.arg(pos=0), u32.const(value=304)), u32.const(value=320)), u32.const(value=16)), u32.const(value=16)), u32.const(value=16)), u32.const(value=16)), align=4, name=basic), u32x4.load(u32.add(u32.add(u32.add(u32.add(u32.add(u32.mul(u32.arg(pos=0), u32.const(value=304)), u32.const(value=928)), u32.const(value=16)), u32.const(value=16)), u32.const(value=16)), u32.const(value=16)), align=4, name=basic), pattern=0,1,2,3,16,17,18,19,4,5,6,7,20,21,22,23), pattern=8,9,10,11,24,25,26,27,12,13,14,15,28,29,30,31)',
                  'u32x4.shuffle(u32x4.shuffle(u32x4.load(u32.add(u32.add(u32.add(u32.add(u32.add(u32.mul(u32.arg(pos=0), u32.const(value=304)), u32.const(value=16)), u32.const(value=16)), u32.const(value=16)), u32.const(value=16)), u32.const(value=16)), align=4, name=basic), u32x4.load(u32.add(u32.add(u32.add(u32.add(u32.add(u32.mul(u32.arg(pos=0), u32.const(value=304)), u32.const(value=624)), u32.const(value=16)), u32.const(value=16)), u32.const(value=16)), u32.const(value=16)), align=4, name=basic), pattern=8,9,10,11,24,25,26,27,12,13,14,15,28,29,30,31), u32x4.shuffle(u32x4.load(u32.add(u32.add(u32.add(u32.add(u32.add(u32.mul(u32.arg(pos=0), u32.const(value=304)), u32.const(value=320)), u32.const(value=16)), u32.const(value=16)), u32.const(value=16)), u32.const(value=16)), align=4, name=basic), u32x4.load(u32.add(u32.add(u32.add(u32.add(u32.add(u32.mul(u32.arg(pos=0), u32.const(value=304)), u32.const(value=928)), u32.const(value=16)), u32.const(value=16)), u32.const(value=16)), u32.const(value=16)), align=4, name=basic), pattern=8,9,10,11,24,25,26,27,12,13,14,15,28,29,30,31), pattern=0,1,2,3,16,17,18,19,4,5,6,7,20,21,22,23)',
                  'u32x4.shuffle(u32x4.shuffle(u32x4.load(u32.add(u32.add(u32.add(u32.add(u32.add(u32.mul(u32.arg(pos=0), u32.const(value=304)), u32.const(value=16)), u32.const(value=16)), u32.const(value=16)), u32.const(value=16)), u32.const(value=16)), align=4, name=basic), u32x4.load(u32.add(u32.add(u32.add(u32.add(u32.add(u32.mul(u32.arg(pos=0), u32.const(value=304)), u32.const(value=624)), u32.const(value=16)), u32.const(value=16)), u32.const(value=16)), u32.const(value=16)), align=4, name=basic), pattern=8,9,10,11,24,25,26,27,12,13,14,15,28,29,30,31), u32x4.shuffle(u32x4.load(u32.add(u32.add(u32.add(u32.add(u32.add(u32.mul(u32.arg(pos=0), u32.const(value=304)), u32.const(value=320)), u32.const(value=16)), u32.const(value=16)), u32.const(value=16)), u32.const(value=16)), align=4, name=basic), u32x4.load(u32.add(u32.add(u32.add(u32.add(u32.add(u32.mul(u32.arg(pos=0), u32.const(value=304)), u32.const(value=928)), u32.const(value=16)), u32.const(value=16)), u32.const(value=16)), u32.const(value=16)), align=4, name=basic), pattern=8,9,10,11,24,25,26,27,12,13,14,15,28,29,30,31), pattern=8,9,10,11,24,25,26,27,12,13,14,15,28,29,30,31)',
                ],
                [
                  'u32x4.shuffle(u32x4.shuffle(u32x4.load(u32.add(u32.add(u32.add(u32.add(u32.add(u32.add(u32.mul(u32.arg(pos=0), u32.const(value=304)), u32.const(value=16)), u32.const(value=16)), u32.const(value=16)), u32.const(value=16)), u32.const(value=16)), u32.const(value=16)), align=4, name=basic), u32x4.load(u32.add(u32.add(u32.add(u32.add(u32.add(u32.add(u32.mul(u32.arg(pos=0), u32.const(value=304)), u32.const(value=624)), u32.const(value=16)), u32.const(value=16)), u32.const(value=16)), u32.const(value=16)), u32.const(value=16)), align=4, name=basic), pattern=0,1,2,3,16,17,18,19,4,5,6,7,20,21,22,23), u32x4.shuffle(u32x4.load(u32.add(u32.add(u32.add(u32.add(u32.add(u32.add(u32.mul(u32.arg(pos=0), u32.const(value=304)), u32.const(value=320)), u32.const(value=16)), u32.const(value=16)), u32.const(value=16)), u32.const(value=16)), u32.const(value=16)), align=4, name=basic), u32x4.load(u32.add(u32.add(u32.add(u32.add(u32.add(u32.add(u32.mul(u32.arg(pos=0), u32.const(value=304)), u32.const(value=928)), u32.const(value=16)), u32.const(value=16)), u32.const(value=16)), u32.const(value=16)), u32.const(value=16)), align=4, name=basic), pattern=0,1,2,3,16,17,18,19,4,5,6,7,20,21,22,23), pattern=0,1,2,3,16,17,18,19,4,5,6,7,20,21,22,23)',
                  'u32x4.shuffle(u32x4.shuffle(u32x4.load(u32.add(u32.add(u32.add(u32.add(u32.add(u32.add(u32.mul(u32.arg(pos=0), u32.const(value=304)), u32.const(value=16)), u32.const(value=16)), u32.const(value=16)), u32.const(value=16)), u32.const(value=16)), u32.const(value=16)), align=4, name=basic), u32x4.load(u32.add(u32.add(u32.add(u32.add(u32.add(u32.add(u32.mul(u32.arg(pos=0), u32.const(value=304)), u32.const(value=624)), u32.const(value=16)), u32.const(value=16)), u32.const(value=16)), u32.const(value=16)), u32.const(value=16)), align=4, name=basic), pattern=0,1,2,3,16,17,18,19,4,5,6,7,20,21,22,23), u32x4.shuffle(u32x4.load(u32.add(u32.add(u32.add(u32.add(u32.add(u32.add(u32.mul(u32.arg(pos=0), u32.const(value=304)), u32.const(value=320)), u32.const(value=16)), u32.const(value=16)), u32.const(value=16)), u32.const(value=16)), u32.const(value=16)), align=4, name=basic), u32x4.load(u32.add(u32.add(u32.add(u32.add(u32.add(u32.add(u32.mul(u32.arg(pos=0), u32.const(value=304)), u32.const(value=928)), u32.const(value=16)), u32.const(value=16)), u32.const(value=16)), u32.const(value=16)), u32.const(value=16)), align=4, name=basic), pattern=0,1,2,3,16,17,18,19,4,5,6,7,20,21,22,23), pattern=8,9,10,11,24,25,26,27,12,13,14,15,28,29,30,31)',
                  'u32x4.shuffle(u32x4.shuffle(u32x4.load(u32.add(u32.add(u32.add(u32.add(u32.add(u32.add(u32.mul(u32.arg(pos=0), u32.const(value=304)), u32.const(value=16)), u32.const(value=16)), u32.const(value=16)), u32.const(value=16)), u32.const(value=16)), u32.const(value=16)), align=4, name=basic), u32x4.load(u32.add(u32.add(u32.add(u32.add(u32.add(u32.add(u32.mul(u32.arg(pos=0), u32.const(value=304)), u32.const(value=624)), u32.const(value=16)), u32.const(value=16)), u32.const(value=16)), u32.const(value=16)), u32.const(value=16)), align=4, name=basic), pattern=8,9,10,11,24,25,26,27,12,13,14,15,28,29,30,31), u32x4.shuffle(u32x4.load(u32.add(u32.add(u32.add(u32.add(u32.add(u32.add(u32.mul(u32.arg(pos=0), u32.const(value=304)), u32.const(value=320)), u32.const(value=16)), u32.const(value=16)), u32.const(value=16)), u32.const(value=16)), u32.const(value=16)), align=4, name=basic), u32x4.load(u32.add(u32.add(u32.add(u32.add(u32.add(u32.add(u32.mul(u32.arg(pos=0), u32.const(value=304)), u32.const(value=928)), u32.const(value=16)), u32.const(value=16)), u32.const(value=16)), u32.const(value=16)), u32.const(value=16)), align=4, name=basic), pattern=8,9,10,11,24,25,26,27,12,13,14,15,28,29,30,31), pattern=0,1,2,3,16,17,18,19,4,5,6,7,20,21,22,23)',
                  'u32x4.shuffle(u32x4.shuffle(u32x4.load(u32.add(u32.add(u32.add(u32.add(u32.add(u32.add(u32.mul(u32.arg(pos=0), u32.const(value=304)), u32.const(value=16)), u32.const(value=16)), u32.const(value=16)), u32.const(value=16)), u32.const(value=16)), u32.const(value=16)), align=4, name=basic), u32x4.load(u32.add(u32.add(u32.add(u32.add(u32.add(u32.add(u32.mul(u32.arg(pos=0), u32.const(value=304)), u32.const(value=624)), u32.const(value=16)), u32.const(value=16)), u32.const(value=16)), u32.const(value=16)), u32.const(value=16)), align=4, name=basic), pattern=8,9,10,11,24,25,26,27,12,13,14,15,28,29,30,31), u32x4.shuffle(u32x4.load(u32.add(u32.add(u32.add(u32.add(u32.add(u32.add(u32.mul(u32.arg(pos=0), u32.const(value=304)), u32.const(value=320)), u32.const(value=16)), u32.const(value=16)), u32.const(value=16)), u32.const(value=16)), u32.const(value=16)), align=4, name=basic), u32x4.load(u32.add(u32.add(u32.add(u32.add(u32.add(u32.add(u32.mul(u32.arg(pos=0), u32.const(value=304)), u32.const(value=928)), u32.const(value=16)), u32.const(value=16)), u32.const(value=16)), u32.const(value=16)), u32.const(value=16)), align=4, name=basic), pattern=8,9,10,11,24,25,26,27,12,13,14,15,28,29,30,31), pattern=8,9,10,11,24,25,26,27,12,13,14,15,28,29,30,31)',
                ],
              ]);
              deepStrictEqual(fmtRec(m32.stack.get()[2][1]), [
                'u32x4.shuffle(u32x4.shuffle(u32x4.load(u32.add(u32.add(u32.add(u32.add(u32.add(u32.add(u32.mul(u32.arg(pos=0), u32.const(value=304)), u32.const(value=16)), u32.const(value=16)), u32.const(value=16)), u32.const(value=16)), u32.const(value=16)), u32.const(value=16)), align=4, name=basic), u32x4.load(u32.add(u32.add(u32.add(u32.add(u32.add(u32.add(u32.mul(u32.arg(pos=0), u32.const(value=304)), u32.const(value=624)), u32.const(value=16)), u32.const(value=16)), u32.const(value=16)), u32.const(value=16)), u32.const(value=16)), align=4, name=basic), pattern=0,1,2,3,16,17,18,19,4,5,6,7,20,21,22,23), u32x4.shuffle(u32x4.load(u32.add(u32.add(u32.add(u32.add(u32.add(u32.add(u32.mul(u32.arg(pos=0), u32.const(value=304)), u32.const(value=320)), u32.const(value=16)), u32.const(value=16)), u32.const(value=16)), u32.const(value=16)), u32.const(value=16)), align=4, name=basic), u32x4.load(u32.add(u32.add(u32.add(u32.add(u32.add(u32.add(u32.mul(u32.arg(pos=0), u32.const(value=304)), u32.const(value=928)), u32.const(value=16)), u32.const(value=16)), u32.const(value=16)), u32.const(value=16)), u32.const(value=16)), align=4, name=basic), pattern=0,1,2,3,16,17,18,19,4,5,6,7,20,21,22,23), pattern=0,1,2,3,16,17,18,19,4,5,6,7,20,21,22,23)',
                'u32x4.shuffle(u32x4.shuffle(u32x4.load(u32.add(u32.add(u32.add(u32.add(u32.add(u32.add(u32.mul(u32.arg(pos=0), u32.const(value=304)), u32.const(value=16)), u32.const(value=16)), u32.const(value=16)), u32.const(value=16)), u32.const(value=16)), u32.const(value=16)), align=4, name=basic), u32x4.load(u32.add(u32.add(u32.add(u32.add(u32.add(u32.add(u32.mul(u32.arg(pos=0), u32.const(value=304)), u32.const(value=624)), u32.const(value=16)), u32.const(value=16)), u32.const(value=16)), u32.const(value=16)), u32.const(value=16)), align=4, name=basic), pattern=0,1,2,3,16,17,18,19,4,5,6,7,20,21,22,23), u32x4.shuffle(u32x4.load(u32.add(u32.add(u32.add(u32.add(u32.add(u32.add(u32.mul(u32.arg(pos=0), u32.const(value=304)), u32.const(value=320)), u32.const(value=16)), u32.const(value=16)), u32.const(value=16)), u32.const(value=16)), u32.const(value=16)), align=4, name=basic), u32x4.load(u32.add(u32.add(u32.add(u32.add(u32.add(u32.add(u32.mul(u32.arg(pos=0), u32.const(value=304)), u32.const(value=928)), u32.const(value=16)), u32.const(value=16)), u32.const(value=16)), u32.const(value=16)), u32.const(value=16)), align=4, name=basic), pattern=0,1,2,3,16,17,18,19,4,5,6,7,20,21,22,23), pattern=8,9,10,11,24,25,26,27,12,13,14,15,28,29,30,31)',
                'u32x4.shuffle(u32x4.shuffle(u32x4.load(u32.add(u32.add(u32.add(u32.add(u32.add(u32.add(u32.mul(u32.arg(pos=0), u32.const(value=304)), u32.const(value=16)), u32.const(value=16)), u32.const(value=16)), u32.const(value=16)), u32.const(value=16)), u32.const(value=16)), align=4, name=basic), u32x4.load(u32.add(u32.add(u32.add(u32.add(u32.add(u32.add(u32.mul(u32.arg(pos=0), u32.const(value=304)), u32.const(value=624)), u32.const(value=16)), u32.const(value=16)), u32.const(value=16)), u32.const(value=16)), u32.const(value=16)), align=4, name=basic), pattern=8,9,10,11,24,25,26,27,12,13,14,15,28,29,30,31), u32x4.shuffle(u32x4.load(u32.add(u32.add(u32.add(u32.add(u32.add(u32.add(u32.mul(u32.arg(pos=0), u32.const(value=304)), u32.const(value=320)), u32.const(value=16)), u32.const(value=16)), u32.const(value=16)), u32.const(value=16)), u32.const(value=16)), align=4, name=basic), u32x4.load(u32.add(u32.add(u32.add(u32.add(u32.add(u32.add(u32.mul(u32.arg(pos=0), u32.const(value=304)), u32.const(value=928)), u32.const(value=16)), u32.const(value=16)), u32.const(value=16)), u32.const(value=16)), u32.const(value=16)), align=4, name=basic), pattern=8,9,10,11,24,25,26,27,12,13,14,15,28,29,30,31), pattern=0,1,2,3,16,17,18,19,4,5,6,7,20,21,22,23)',
                'u32x4.shuffle(u32x4.shuffle(u32x4.load(u32.add(u32.add(u32.add(u32.add(u32.add(u32.add(u32.mul(u32.arg(pos=0), u32.const(value=304)), u32.const(value=16)), u32.const(value=16)), u32.const(value=16)), u32.const(value=16)), u32.const(value=16)), u32.const(value=16)), align=4, name=basic), u32x4.load(u32.add(u32.add(u32.add(u32.add(u32.add(u32.add(u32.mul(u32.arg(pos=0), u32.const(value=304)), u32.const(value=624)), u32.const(value=16)), u32.const(value=16)), u32.const(value=16)), u32.const(value=16)), u32.const(value=16)), align=4, name=basic), pattern=8,9,10,11,24,25,26,27,12,13,14,15,28,29,30,31), u32x4.shuffle(u32x4.load(u32.add(u32.add(u32.add(u32.add(u32.add(u32.add(u32.mul(u32.arg(pos=0), u32.const(value=304)), u32.const(value=320)), u32.const(value=16)), u32.const(value=16)), u32.const(value=16)), u32.const(value=16)), u32.const(value=16)), align=4, name=basic), u32x4.load(u32.add(u32.add(u32.add(u32.add(u32.add(u32.add(u32.mul(u32.arg(pos=0), u32.const(value=304)), u32.const(value=928)), u32.const(value=16)), u32.const(value=16)), u32.const(value=16)), u32.const(value=16)), u32.const(value=16)), align=4, name=basic), pattern=8,9,10,11,24,25,26,27,12,13,14,15,28,29,30,31), pattern=8,9,10,11,24,25,26,27,12,13,14,15,28,29,30,31)',
              ]);

              called++;
            }
          );
        toWasm(mod, { useSIMD: true });
        toJs(mod, {});
        deepStrictEqual(called, 1);
      });
      should('simd2', () => {
        for (const type of ['i32', 'u32', 'u64']) {
          for (const lanes of [2, 4]) {
            for (const endianess of [false, true]) {
              for (const size of [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 25]) {
                if (!SLOW && size > 9) continue;
                const memOpts = { swapEndianness: endianess, noPadSize: true };
                const mod = new Module('wasm')
                  .mem('input', array(type, memOpts, lanes, size))
                  .mem('output_simd', array(type, memOpts, lanes, size))
                  .mem('output_simd_single', array(type, memOpts, lanes, size))
                  .mem('output_scalar', array(type, memOpts, lanes, size))
                  // 8
                  .mem('output8_simd', array(type, memOpts, lanes, size))
                  .mem('output8_simd_single', array(type, memOpts, lanes, size))
                  .mem('output8_scalar', array(type, memOpts, lanes, size))
                  // 16
                  .mem('output16_simd', array(type, memOpts, lanes, size))
                  .mem('output16_simd_single', array(type, memOpts, lanes, size))
                  .mem('output16_scalar', array(type, memOpts, lanes, size))
                  .fn('interleave', [], 'void', (f) => {
                    const { input, output_simd, output_simd_single, output_scalar } = f.memory;
                    const i = input.lanes(lanes)[0];
                    const o1 = output_simd.lanes(lanes)[0];
                    const o2 = output_simd_single.lanes(lanes)[0];
                    const T = f.types[i.type];
                    o1.set(i.get().map((i) => T.add(i, T.mul(T.laneOffsets(), T.const(1000)))));

                    for (let j = 0; j < size; j++) {
                      o2[j].set(T.add(i[j].get(), T.mul(T.laneOffsets(), T.const(1000))));
                    }
                    const sT = f.types[type];
                    for (let l = 0; l < lanes; l++) {
                      for (let i = 0; i < size; i++) {
                        output_scalar[l][i].set(
                          sT.add(input[l][i].get(), sT.mul(sT.const(l), sT.const(1000)))
                        );
                      }
                    }
                    // 8
                    const byteSize = input[0].as8(type).region.size;
                    const MUL8 = 10;
                    const { output8_simd, output8_simd_single, output8_scalar } = f.memory;
                    for (let l = 0; l < lanes; l++) {
                      const lane = output8_scalar[l].as8(type);
                      for (let i = 0; i < byteSize; i++) {
                        lane[i].set(
                          sT.add(input[l].as8(type)[i].get(), sT.mul(sT.const(l), sT.const(MUL8)))
                        );
                      }
                    }
                    // single
                    {
                      const lane = output8_simd_single.lanes(lanes)[0].as8(type);
                      for (let i = 0; i < byteSize; i++) {
                        lane[i].set(
                          T.add(
                            input.lanes(lanes)[0].as8(type)[i].get(),
                            T.mul(T.laneOffsets(), T.const(MUL8))
                          )
                        );
                      }
                    }
                    {
                      const lane = output8_simd.lanes(lanes)[0].as8(type);
                      const inp = input.lanes(lanes)[0].as8(type).get();
                      lane.set(inp.map((i) => T.add(i, T.mul(T.laneOffsets(), T.const(MUL8)))));
                    }
                    // 16
                    const byteSize16 = input[0].as16(type).region.size / 2;
                    const MUL16 = 10;
                    const { output16_simd, output16_simd_single, output16_scalar } = f.memory;
                    for (let l = 0; l < lanes; l++) {
                      const lane = output16_scalar[l].as16(type);
                      for (let i = 0; i < byteSize16; i++) {
                        lane[i].set(
                          sT.add(input[l].as16(type)[i].get(), sT.mul(sT.const(l), sT.const(MUL16)))
                        );
                      }
                    }
                    {
                      // single
                      const lane = output16_simd_single.lanes(lanes)[0].as16(type);
                      for (let i = 0; i < byteSize16; i++) {
                        lane[i].set(
                          T.add(
                            input.lanes(lanes)[0].as16(type)[i].get(),
                            T.mul(T.laneOffsets(), T.const(MUL16))
                          )
                        );
                      }
                    }
                    {
                      // simd
                      const lane = output16_simd.lanes(lanes)[0].as16(type);
                      const inp = input.lanes(lanes)[0].as16(type).get();
                      lane.set(inp.map((i) => T.add(i, T.mul(T.laneOffsets(), T.const(MUL16)))));
                    }
                  });

                testBoth(mod, (mod) => {
                  const types = {
                    i32: [P.I32LE, P.I32BE],
                    u32: [P.U32LE, P.U32BE],
                    i64: [P.I64LE, P.I64BE],
                    u64: [P.U64LE, P.U64BE],
                  };
                  const tC = types[type][endianess ? 1 : 0];
                  const chunk = P.array(size, tC);
                  const cPar = P.tuple(new Array(lanes).fill(chunk));
                  const fixInt = (n) => (type === 'u64' ? BigInt(n) : n);
                  mod.segments.input.fill(0);
                  function check() {
                    mod.segments.output_scalar.fill(0);
                    mod.segments.output_simd_single.fill(0);
                    mod.segments.output_simd.fill(0);
                    mod.segments.output8_scalar.fill(0);
                    mod.segments.output8_simd_single.fill(0);
                    mod.segments.output8_simd.fill(0);
                    mod.segments.output16_scalar.fill(0);
                    mod.segments.output16_simd_single.fill(0);
                    mod.segments.output16_simd.fill(0);
                    mod.interleave();
                    deepStrictEqual(
                      cPar.decode(mod.segments.output_simd_single),
                      cPar.decode(mod.segments.output_scalar)
                    );
                    deepStrictEqual(
                      cPar.decode(mod.segments.output_simd),
                      cPar.decode(mod.segments.output_simd_single)
                    );
                    // 8
                    deepStrictEqual(
                      cPar.decode(mod.segments.output8_simd_single),
                      cPar.decode(mod.segments.output8_scalar)
                    );
                    deepStrictEqual(
                      cPar.decode(mod.segments.output8_simd),
                      cPar.decode(mod.segments.output8_simd_single)
                    );
                    //16
                    deepStrictEqual(
                      cPar.decode(mod.segments.output16_simd_single),
                      cPar.decode(mod.segments.output16_scalar)
                    );
                    deepStrictEqual(
                      cPar.decode(mod.segments.output16_simd),
                      cPar.decode(mod.segments.output16_simd_single)
                    );
                  }
                  check();
                  mod.segments.input.set(utils.seq(mod.segments.input.length));
                  check();
                  mod.segments.input.fill(0xff);
                  check();
                  mod.segments.input.fill(0xee);
                  check();
                });
              }
            }
          }
        }
      });
      should('convert', () => {
        const mod = new Module('wasm');
        for (const sign of ['i', 'u']) {
          mod
            .fn(`${sign}32_${sign}64_1_1`, [`${sign}32`], [`${sign}64`], (f, arg) => {
              const i32 = f.getType(`${sign}32`);
              const i64 = f.getType(`${sign}64`);
              return [
                ...f.types[`${sign}64`].from(
                  i64.name,
                  i64.fromN(i32.name, i32.fromN(`${sign}32`, arg))
                ),
              ];
            })
            .fn(`${sign}32_${sign}64_1_2`, [`${sign}32`], [`${sign}64`], (f, arg) => {
              const i32 = f.getType(`${sign}32`, 1);
              const i64 = f.getType(`${sign}64`, 2);
              return [
                ...f.types[`${sign}64`].from(
                  i64.name,
                  i64.fromN(i32.name, i32.fromN(`${sign}32`, arg))
                ),
              ];
            })
            .fn(`${sign}32_${sign}64_1_4`, [`${sign}32`], [`${sign}64`], (f, arg) => {
              const i32 = f.getType(`${sign}32`, 1);
              const i64 = f.getType(`${sign}64`, 4);
              return [
                ...f.types[`${sign}64`].from(
                  i64.name,
                  i64.fromN(i32.name, i32.fromN(`${sign}32`, arg))
                ),
              ];
            })
            .fn(`${sign}32_${sign}64_2_2`, [`${sign}32`], [`${sign}64`], (f, arg) => {
              const i32 = f.getType(`${sign}32`, 2);
              const i64 = f.getType(`${sign}64`, 2);
              return [
                ...f.types[`${sign}64`].from(
                  i64.name,
                  i64.fromN(i32.name, i32.fromN(`${sign}32`, arg))
                ),
              ];
            })
            .fn(`${sign}32_${sign}64_4_2`, [`${sign}32`], [`${sign}64`], (f, arg) => {
              const i32 = f.getType(`${sign}32`, 4);
              const i64 = f.getType(`${sign}64`, 2);
              return [
                ...f.types[`${sign}64`].from(
                  i64.name,
                  i64.fromN(i32.name, i32.fromN(`${sign}32`, arg))
                ),
              ];
            })
            // 64 -> 32
            .fn(`${sign}64_${sign}32_1_1`, [`${sign}64`], [`${sign}64`], (f, arg) => {
              const i32 = f.getType(`${sign}32`, 1);
              const i64 = f.getType(`${sign}64`, 1);
              return [
                ...f.types[`${sign}32`].from(
                  i32.name,
                  i32.from(i64.name, i64.fromN(`${sign}64`, arg))
                ),
              ];
            })
            .fn(`${sign}64_${sign}32_2_2`, [`${sign}64`], [`${sign}64`], (f, arg) => {
              const i32 = f.getType(`${sign}32`, 2);
              const i64 = f.getType(`${sign}64`, 2);
              return [
                ...f.types[`${sign}32`].from(
                  i32.name,
                  i32.from(i64.name, i64.fromN(`${sign}64`, arg))
                ),
              ];
            })
            .fn(`${sign}64_${sign}32_4_4`, [`${sign}64`], [`${sign}64`], (f, arg) => {
              const i32 = f.getType(`${sign}32`, 4);
              const i64 = f.getType(`${sign}64`, 4);
              return [
                ...f.types[`${sign}32`].from(
                  i32.name,
                  i32.from(i64.name, i64.fromN(`${sign}64`, arg))
                ),
              ];
            });
        }

        const wasm = js.exec(toWasm(mod));
        const i32_i64_vec = [
          [123, 123],
          [0xffff_ffff, -1n],
          [0x7fffffff, 2147483647n],
          [0x80000000 >>> 0, -2147483648n],
          [-0x80000000, -2147483648n],
        ];
        for (const [val, exp] of i32_i64_vec) {
          deepStrictEqual(wasm.i32_i64_1_1(val), BigInt(exp));
          deepStrictEqual(wasm.i32_i64_1_2(val), [BigInt(exp), BigInt(exp)]);
          deepStrictEqual(wasm.i32_i64_1_4(val), [
            BigInt(exp),
            BigInt(exp),
            BigInt(exp),
            BigInt(exp),
          ]);
          deepStrictEqual(wasm.i32_i64_2_2(val), [BigInt(exp), BigInt(exp)]);
          deepStrictEqual(wasm.i32_i64_4_2(val), [BigInt(exp), BigInt(exp)]);
        }
        const u32_u64_vec = [
          [123, 123],
          [0xffff_ffff, 4294967295n],
          [0x7fffffff, 2147483647n],
          [0x80000000 >>> 0, 2147483648n],
          [-0x80000000, 2147483648n],
        ];
        for (const [val, exp] of u32_u64_vec) {
          deepStrictEqual(wasm.u32_u64_1_1(val), BigInt(exp));
          deepStrictEqual(wasm.u32_u64_1_2(val), [BigInt(exp), BigInt(exp)]);
          deepStrictEqual(wasm.u32_u64_1_4(val), [
            BigInt(exp),
            BigInt(exp),
            BigInt(exp),
            BigInt(exp),
          ]);
          deepStrictEqual(wasm.u32_u64_2_2(val), [BigInt(exp), BigInt(exp)]);
          deepStrictEqual(wasm.u32_u64_4_2(val), [BigInt(exp), BigInt(exp)]);
        }
        // wasm always returns i32
        const u64_u32_vec = [
          [123n, [123, 0]],
          [0xffff_ffffn, [-1, 0]],
          [0xffff_ffff_ffn, [-1, 255]],
          [0xffff_ffff_ffff_ffffn, [-1, -1]],
          [0x1111_2222_3333_4444n, [0x3333_4444, 0x1111_2222]],
          [0x8000_0000n, [-2147483648, 0]],
          [0x7fff_ffff_8000_0000n, [-2147483648, 2147483647]], // mixed edges
          [0x0000_0001_ffff_ffffn, [-1, 1]], // hi32 small, low32 max
        ];
        for (const [val, exp] of u64_u32_vec) {
          deepStrictEqual(wasm.u64_u32_1_1(val), exp);
          deepStrictEqual(wasm.u64_u32_2_2(val), [exp[0], exp[0], exp[1], exp[1]]);
          deepStrictEqual(wasm.u64_u32_4_4(val), [
            exp[0],
            exp[0],
            exp[0],
            exp[0],
            exp[1],
            exp[1],
            exp[1],
            exp[1],
          ]);
        }
      });
    });
  });
  describe('Optimizer', () => {
    should('runtime types', () => {
      const m = runtimeTypes;
      deepStrictEqual(m.i32.add(1, 2), 3);
      deepStrictEqual(m.u32.add(1, 2), 3);
      deepStrictEqual(m.u32.add(1, 2, 3), 6);

      deepStrictEqual(m.i64.add(1n, 2n), 3n);
      deepStrictEqual(m.u64.add(1n, 2n), 3n);
      deepStrictEqual(m.u64.add(1n, 2n, 3n), 6n);

      deepStrictEqual(m.i32.not(1), ~1);
      deepStrictEqual(m.i64.not(1n), -2n);
      deepStrictEqual(m.i32.shr(-10, 2), -10 >> 2); // -3
      deepStrictEqual(m.u32.shr(-10, 2), -10 >>> 2); // 1073741821
    });
  });
  describe('SIMD', () => {
    should('extmul', () => {
      const mod = new Module('wasm').fn('process', ['u64', 'u64'], 'void', (f, a, b) => {
        const { u64, u64x2 } = f.types;
        const vA = u64x2.fromN('u64', a);
        const vB = u64x2.fromN('u64', b);
        const mask = u64x2.const(0xffff_ffffn);
        const res = u64x2.mul(u64x2.and(vA, mask), u64x2.and(vB, mask));
        return u64.from('u64x2', res);
      });
      const wmod = js.exec(toWasm(mod, { optExtMul: false }));
      const wmod2 = js.exec(toWasm(mod));
      for (const [a, b] of [
        [3n, 4n],
        [1n, 1n],
        [10n, 20n],
        [0xffff_ffffn, 0xffff_ffffn],
        [0xffff_ffff_ffffn, 0xffff_ffff_ffffn],
      ]) {
        const exp = wmod.process(a, b);
        for (let i = 0; i < 100000; i++) wmod.process(a, b);
        const res = wmod2.process(a, b);
        for (let i = 0; i < 100000; i++) wmod2.process(a, b);
      }
    });
    describe('rotations', () => {
      should('rotations(32)', () => {
        for (let shift = 0; shift < 64; shift++) {
          const mod = new Module('wasm')
            .mem('state', array('u32x4', {}, 2))
            .fn('process', [], 'void', (f) => {
              const { state } = f.memory;
              state[0].mut.rotr(shift);
              state[1].mut.rotl(shift);
            });
          testBoth(mod, (mm) => {
            const state_u32 = utils.u32(mm.segments.state);
            function test(pattern) {
              state_u32.fill(pattern);
              mm.process();
              const rotl = runtimeTypes.u32.rotl(pattern, shift);
              const rotr = runtimeTypes.u32.rotr(pattern, shift);
              deepStrictEqual(
                state_u32,
                new Uint32Array([...new Array(4).fill(rotr), ...new Array(4).fill(rotl)])
              );
            }
            for (let i = 0; i < 32; i++) {
              const pattern = (1 << i) - 1;
              test((1 << i) - 1);
            }
            const extras = [
              0x00000000, 0xffffffff, 0x80000000, 0x7fffffff, 0xaaaaaaaa, 0x55555555, 0x0f0f0f0f,
              0xf0f0f0f0, 0x02030401, 0x03040102, 0x04010203,
            ];
            for (const p of extras) test(p);
            for (let b = 0; b < 32; b++) {
              const one = (1 << b) >>> 0; // coerce to u32 (handles b==31)
              const inv = ~one >>> 0;
              test(one);
              test(inv);
            }
          });
        }
      });
      should('rotations(64)', () => {
        for (let shift = 0; shift < 128; shift++) {
          const mod = new Module('wasm')
            .mem('state', array('u64x2', {}, 2))
            .fn('process', [], 'void', (f) => {
              const { state } = f.memory;
              state[0].mut.rotr(shift);
              state[1].mut.rotl(shift);
            });
          testBoth(mod, (mm) => {
            const view = utils.createView(mm.segments.state);
            function test(pattern) {
              for (let i = 0; i < 4; i++) view.setBigInt64(8 * i, pattern, true);
              mm.process();
              const rotl = runtimeTypes.u64.rotl(pattern, shift);
              const rotr = runtimeTypes.u64.rotr(pattern, shift);
              const res = [];

              for (let i = 0; i < 4; i++) res.push(view.getBigInt64(8 * i, true));
              deepStrictEqual(res, [...new Array(2).fill(rotr), ...new Array(2).fill(rotl)]);
            }
            for (let i = 0; i < 64; i++) {
              test((1n << BigInt(i)) - 1n);
            }
            for (let b = 0; b < 64; b++) {
              const one = 1n << BigInt(b);
              const inv = one ^ ((1n << 64n) - 1n);
              test(one);
              test(inv);
            }
          });
        }
      });
    });
    describe('lowering', () => {
      should('lowering', () => {
        const vType = 'u32x4';
        const mod = new Module('wasm')
          .mem('state', array('u32x4', {}, 2)) // 16*2 = 32 bytes
          .fn('compress', [], 'void', (f) => {
            const { state } = f.memory;
            const T = f.types[vType];
            for (let i = 0; i < 2; i++) state[i].mut.swapEndianness();
            // BE ADD
            for (let i = 0; i < 2; i++) state[i].mut.add(T.const(1));
            for (let i = 0; i < 2; i++) state[i].mut.swapEndianness();

            //
            const x = [];
            for (let i = 0; i < 2; i++) x.push(T.swapEndianness(state[i].get()));
            for (let i = 0; i < 2; i++) x[i] = T.add(x[i], T.const(1));
            for (let i = 0; i < 2; i++) state[i].set(x[i]);
          });
        testBoth(mod, (mod) => {
          mod.segments.state.set(new Uint8Array(4 * 4).fill(1));
          mod.compress();
          deepStrictEqual(
            mod.segments.state,
            new Uint8Array([
              3, 1, 1, 1, 3, 1, 1, 1, 3, 1, 1, 1, 3, 1, 1, 1, 2, 0, 0, 0, 2, 0, 0, 0, 2, 0, 0, 0, 2,
              0, 0, 0,
            ])
          );
        });
      });
      should('lowering (2)', () => {
        const vType = 'u32x4';
        const mod = new Module('wasm')
          .mem('state', array('u32x4', {}, 4))
          .fn('compress', [], 'void', (f) => {
            const T = f.types[vType];
            const { state } = f.memory;
            for (let i = 0; i < 4; i++) state[i].mut.swapEndianness();
            // BE ADD
            for (let i = 0; i < 4; i++) state[i].mut.add(T.const(1));
            for (let i = 0; i < 4; i++) state[i].mut.swapEndianness();
          });
        testBoth(mod, (mod) => {
          const c = P.array(4 * 4, P.U32BE);
          for (const v of [1, 0xff, 0b0101_0101, 71, 31, 33]) {
            const x = new Array(16).fill(v);
            mod.segments.state.set(c.encode(x));
            mod.compress();
            deepStrictEqual(
              c.decode(mod.segments.state),
              x.map((i) => i + 1)
            );
          }
        });
      });
      should('lowering (3, u64)', () => {
        const vType = 'u64x2';
        const mod = new Module('wasm')
          .mem('state', array('u64x2', {}, 4))
          .fn('compress', [], 'void', (f) => {
            const T = f.types[vType];
            const { state } = f.memory;

            for (let i = 0; i < 4; i++) state[i].mut.swapEndianness();
            // BE ADD
            for (let i = 0; i < 4; i++) state[i].mut.add(T.const(1));
            for (let i = 0; i < 4; i++) state[i].mut.swapEndianness();
          });
        testBoth(mod, (mod) => {
          const c = P.array(4 * 2, P.U64BE);
          for (const v of [1, 0xff, 0b0101_0101, 71, 31, 33]) {
            const x = new Array(4 * 2).fill(BigInt(v));
            mod.segments.state.set(c.encode(x));
            mod.compress();
            deepStrictEqual(
              c.decode(mod.segments.state),
              x.map((i) => i + 1n)
            );
          }
        });
      });
      should('lowering (4, u64, read)', () => {
        const vType = 'u64x2';
        const mod = new Module('wasm')
          .mem('state', array('u64x2', {}, 4))
          .fn('compress', [], 'void', (f) => {
            const T = f.types[vType];
            const { state } = f.memory;
            const X = [];
            for (let i = 0; i < 4; i++) X.push(T.swapEndianness(state[i].get()));
            // BE ADD
            for (let i = 0; i < 4; i++) X[i] = T.add(X[i], T.const(1));
            for (let i = 0; i < 4; i++) state[i].set(T.swapEndianness(X[i]));
            //
          });
        testBoth(mod, (mod) => {
          const c = P.array(4 * 2, P.U64BE);
          for (const v of [1, 0xff, 0b0101_0101, 71, 31, 33]) {
            const x = new Array(4 * 2).fill(BigInt(v));
            mod.segments.state.set(c.encode(x));
            mod.compress();
            deepStrictEqual(
              c.decode(mod.segments.state),
              x.map((i) => i + 1n)
            );
          }
        });
      });
      should('lowering (4, u64, extract_lane, replace_lane)', () => {
        const vType = 'u64x2';
        const type = 'u64';
        const mod = new Module('wasm')
          .mem('state', array('u64x2', {}, 4))
          .fn('compress', [], 'void', (f) => {
            const { state } = f.memory;
            const X = [];
            const lanes = lanesOf(vType);
            {
              const T = f.types[vType];
              for (let i = 0; i < 4; i++) {
                const vec = T.swapEndianness(state[i].get());
                for (let j = 0; j < lanes; j++) X.push(T.extractLane(vec, j));
              }
            }
            // BE ADD
            const T = f.types[type];
            for (let i = 0; i < X.length; i++) X[i] = T.add(X[i], T.const(1));
            {
              const T = f.types[vType];
              for (let i = 0, k = 0; i < X.length; i += 2) {
                let v = T.const(0);
                const cv = [X[i], X[i + 1]];
                for (let j = 0; j < lanes; j++) v = T.replaceLane(v, j, cv[j]);
                state[k++].set(T.swapEndianness(v));
              }
            }
          });
        testBoth(mod, (mod) => {
          const c = P.array(4 * 2, P.U64BE);
          const x = utils.seq(4 * 2).map(BigInt);
          mod.segments.state.set(c.encode(x));
          mod.compress();
          deepStrictEqual(
            c.decode(mod.segments.state),
            x.map((i) => i + 1n)
          );
          x[0] = 0n;
          x[1] = 2n ** 64n - 1n;
          x[2] = 2n ** 64n - 1n;
          x[3] = 0n;
          mod.segments.state.set(c.encode(x));
          mod.compress();

          deepStrictEqual(c.decode(mod.segments.state).slice(0, 4), [1n, 0n, 0n, 1n]);
        });
      });
      should('interleave basic', () => {
        for (const lanes of [2, 4, 8, 16]) {
          for (const type of ['i32', 'u32', 'i64', 'u64']) {
            for (const sz of [4, 8, 16, 32]) {
              // Interleave is pretty weird in that case
              if (lanes > sz) continue;
              const vType = `${type}x${lanes}`;
              const c = type === 'u64' || type === 'i64' ? P.U64LE : P.U32LE;
              const cVchunk = P.array(sz, c);
              const cvFull = P.array(lanes, cVchunk);
              const fixInt = (n) => (type === 'u64' || type === 'i64' ? BigInt(n) : n);
              const mod = new Module('wasm')
                .mem('input', array(vType, {}, sz))
                .mem('output', array(vType, {}, sz))
                .fn('interleave', [], 'void', (f) => {
                  const { input, output } = f.memory;
                  const vT = f.types[vType];
                  output.set(vT.interleave(input.get()));
                })
                .fn('deinterleave', [], 'void', (f) => {
                  const { input, output } = f.memory;
                  const vT = f.types[vType];
                  output.set(vT.deinterleave(input.get()));
                })
                .fn('roundtrip', [], 'void', (f) => {
                  const { input, output } = f.memory;
                  const vT = f.types[vType];
                  output.set(vT.deinterleave(vT.interleave(input.get())));
                });
              testBoth(mod, (mod) => {
                const shifts = utils.seq(lanes).map((i) => (i + 1) * 100);
                const input = shifts.map((i) => utils.seq(sz).map((j) => j + i));
                //for (let i = 0; i < input.length; i++)
                //  mod.segments.input_chunks[i].set(cVchunk.encode(input[i].map(fixInt)));
                mod.segments.input.set(cvFull.encode(input.map((i) => i.map(fixInt))));
                // Interleave here is basically transposes matrix [chunk][lane] into [lane][chunk]
                mod.interleave();
                // console.log(
                //   'Interleave full',
                //   utils.chunks(P.array(null, c).decode(mod.segments.output), lanes).slice(0, sz)
                // );

                deepStrictEqual(
                  utils
                    .chunks(P.array(null, c).decode(mod.segments.output), lanes)
                    .slice(0, sz)
                    .flat(),
                  Array.from({ length: (sz * lanes) / shifts.length }, (i, j) =>
                    shifts.map((k) => k + j)
                  )
                    .flat()
                    .map(fixInt)
                );
                // Deinterleave transposes back
                mod.segments.input.set(mod.segments.output);
                mod.deinterleave();
                // console.log(
                //   'Deinter',
                //   mod.segments.output_chunks.map((i) => cVchunk.decode(i))
                // );
                deepStrictEqual(
                  cvFull.decode(mod.segments.output),
                  input.map((i) => i.map(fixInt))
                );
                // check that we can read and write back same stuff.
                mod.segments.input.fill(0);
                mod.segments.output.fill(0);
                // for (let i = 0; i < input.length; i++)
                //   mod.segments.input_chunks[i].set(cVchunk.encode(input[i].map(fixInt)));
                mod.segments.input.set(cvFull.encode(input.map((i) => i.map(fixInt))));
                mod.roundtrip();
                deepStrictEqual(mod.segments.output, mod.segments.input);
              });
            }
          }
        }
      });
      should('rol/ror', () => {
        const OUT = {};
        for (const type of ['u32', 'u64']) {
          for (let shift = 0; shift < 64; shift++) {
            const vt = type === 'u32' ? 'u32x4' : 'u64x2';
            const len = 1;
            const mod = new Module('wasm')
              .mem('stateL', array(vt, {}, len))
              .mem('stateR', array(vt, {}, len))
              .mem('stateI', array(vt, {}, len))
              .fn('test', [], 'void', (f) => {
                const T = f.types[vt];
                const { stateL, stateR, stateI } = f.memory;
                stateL.set(stateL.get().map((i) => T.rol(i, shift)));
                stateR.set(stateR.get().map((i) => T.ror(i, shift)));
                stateI.set(stateI.get().map((i) => T.ror(T.rol(i, shift), shift)));
              });
            const fixInt = (n) => (type === 'u64' ? BigInt(n) : n);
            testBoth(mod, (m) => {
              const u64 = P.U64LE;
              const u32 = P.U32LE;
              const chunks = type === 'u64' ? 2 : 4;
              const c2 = P.array(chunks * len, type === 'u64' ? u64 : u32);
              const val2 = utils.seq(chunks * len).map(fixInt);
              m.segments.stateL.set(c2.encode(val2));
              m.segments.stateR.set(c2.encode(val2));
              m.segments.stateI.set(c2.encode(val2));
              m.test();
              const res = {
                l: c2.decode(m.segments.stateL),
                r: c2.decode(m.segments.stateR),
              };
              deepStrictEqual(c2.decode(m.segments.stateI), val2); // identity
              if (!OUT[type]) OUT[type] = [];
              if (!OUT[type][shift]) OUT[type][shift] = res;
              else deepStrictEqual(OUT[type][shift], res);
            });
          }
        }
        for (const type of ['u32', 'u64']) {
          const fixInt = (n) => (type === 'u64' ? BigInt(n) : n);
          const OT = OUT[type];
          const id = utils.seq(type === 'u64' ? 2 : 4).map(fixInt);
          deepStrictEqual(OT[0], { l: id, r: id });
          for (let i = 1; i < OT.length; i++) {
            const prev = OT[i - 1];
            const { l, r } = OT[i];
            // ROL(1): first element goes to end
            deepStrictEqual(l, prev.l.slice(1).concat(prev.l[0]));
            // ROR(1): last element goes to start
            deepStrictEqual(
              r,
              [prev.r[prev.r.length - 1]].concat(prev.r.slice(0, prev.r.length - 1))
            );
            const chunks = type === 'u64' ? 2 : 4;
            deepStrictEqual(OT[i], OT[i % chunks]);
          }
        }
      });
    });
    should('get/set/store/load', () => {
      for (const endianess of [false]) {
        for (const type of ['u32', 'u64', 'i32', 'i64']) {
          const vType = minSimdType(type);
          const mod = new Module('wasm');
          const gen = (type, mod) => {
            mod.mem(`state_${type}`, array(type, {}, 1, 10));
            mod.mem(`state_${type}x2`, array(type, {}, 2, 10));
            mod.mem(`state_${type}x4`, array(type, {}, 4, 10));
            for (const lanes of [undefined, 2, 4]) {
              const realType = lanes ? `${type}x${lanes}` : type;
              mod.fn(`get_${realType}`, ['i32'], 'void', (fn, pos) => {
                const T = fn.types[realType];
                const mem = fn.memory[`state_${realType}`].lanes(lanes || 1)[0][pos];
                let value = mem.get();
                if (endianess) value = T.swapEndianess(value);
                mem.set(T.add(value, T.const(0xff)));
              });
              for (const sz of [8, 16, 32]) {
                mod.fn(`get_${realType}_${sz}`, ['i32'], 'void', (fn, pos) => {
                  const T = fn.types[realType];
                  const mem = fn.memory[`state_${realType}`].lanes(lanes || 1)[0][`as${sz}`](type)[
                    pos
                  ];
                  mem.mut.add(T.const(0xff));
                });
                mod.fn(`get_${realType}_${sz}2`, ['i32'], 'void', (fn, pos) => {
                  const T = fn.types[realType];
                  const mem = fn.memory[`state_${realType}`].lanes(lanes || 1)[0][`as${sz}`](type)[
                    pos
                  ];
                  mem.mut.add(T.const(0xff80));
                });
                mod.fn(`get_${realType}_${sz}3`, ['i32'], 'void', (fn, pos) => {
                  const T = fn.types[realType];
                  const mem = fn.memory[`state_${realType}`].lanes(lanes || 1)[0][pos];
                  mem.mut.add(T.const(0xff80));
                });
              }
            }
          };
          gen(type, mod);
          const r = [];
          testBoth(mod, (mod) => {
            mod[`get_${type}`](0);
            const exp1 = mod.segments[`state_${type}`].slice();
            mod[`get_${type}`](0);
            const exp2 = mod.segments[`state_${type}`].slice();
            mod[`get_${type}`](1);
            const exp3 = mod.segments[`state_${type}`].slice();
            mod[`get_${type}`](2);
            const exp4 = mod.segments[`state_${type}`].slice();
            for (const lanes of [2, 4]) {
              const vType = `${type}x${lanes}`;
              mod[`get_${vType}`](0);
              deepStrictEqual(
                mod.segments[`state_${vType}`],
                concatBytes(...new Array(lanes).fill(exp1))
              );
              mod[`get_${vType}`](0);
              deepStrictEqual(
                mod.segments[`state_${vType}`],
                concatBytes(...new Array(lanes).fill(exp2))
              );
              mod[`get_${vType}`](1);
              deepStrictEqual(
                mod.segments[`state_${vType}`],
                concatBytes(...new Array(lanes).fill(exp3))
              );
              mod[`get_${vType}`](2);
              deepStrictEqual(
                mod.segments[`state_${vType}`],
                concatBytes(...new Array(lanes).fill(exp4))
              );
            }
            const vec = [exp1, exp2, exp3, exp4];
            for (const sz of [8, 16, 32]) {
              mod.segments[`state_${type}`].fill(0);
              mod[`get_${type}_${sz}`](0);
              const exp1 = mod.segments[`state_${type}`].slice();
              mod[`get_${type}_${sz}`](0);
              const exp2 = mod.segments[`state_${type}`].slice();
              mod[`get_${type}_${sz}`](1);
              const exp3 = mod.segments[`state_${type}`].slice();
              mod[`get_${type}_${sz}`](2);
              const exp4 = mod.segments[`state_${type}`].slice();
              vec.push(exp1, exp2, exp3, exp4);
              for (const lanes of [2, 4]) {
                const vType = `${type}x${lanes}`;
                mod.segments[`state_${vType}`].fill(0);
                mod[`get_${vType}_${sz}`](0);
                deepStrictEqual(
                  mod.segments[`state_${vType}`],
                  concatBytes(...new Array(lanes).fill(exp1))
                );
                mod[`get_${vType}_${sz}`](0);
                deepStrictEqual(
                  mod.segments[`state_${vType}`],
                  concatBytes(...new Array(lanes).fill(exp2))
                );
                mod[`get_${vType}_${sz}`](1);
                deepStrictEqual(
                  mod.segments[`state_${vType}`],
                  concatBytes(...new Array(lanes).fill(exp3))
                );
                mod[`get_${vType}_${sz}`](2);
                deepStrictEqual(
                  mod.segments[`state_${vType}`],
                  concatBytes(...new Array(lanes).fill(exp4))
                );
              }
            }
            for (const sz of [8, 16, 32]) {
              mod.segments[`state_${type}`].fill(0);
              mod[`get_${type}_${sz}2`](0);
              const exp1 = mod.segments[`state_${type}`].slice();
              mod[`get_${type}_${sz}2`](0);
              const exp2 = mod.segments[`state_${type}`].slice();
              mod[`get_${type}_${sz}2`](1);
              const exp3 = mod.segments[`state_${type}`].slice();
              mod[`get_${type}_${sz}2`](2);
              const exp4 = mod.segments[`state_${type}`].slice();
              vec.push(exp1, exp2, exp3, exp4);
              for (const lanes of [2, 4]) {
                const vType = `${type}x${lanes}`;
                mod.segments[`state_${vType}`].fill(0);
                mod[`get_${vType}_${sz}2`](0);
                deepStrictEqual(
                  mod.segments[`state_${vType}`],
                  concatBytes(...new Array(lanes).fill(exp1))
                );
                mod[`get_${vType}_${sz}2`](0);
                deepStrictEqual(
                  mod.segments[`state_${vType}`],
                  concatBytes(...new Array(lanes).fill(exp2))
                );
                mod[`get_${vType}_${sz}2`](1);
                deepStrictEqual(
                  mod.segments[`state_${vType}`],
                  concatBytes(...new Array(lanes).fill(exp3))
                );
                mod[`get_${vType}_${sz}2`](2);
                deepStrictEqual(
                  mod.segments[`state_${vType}`],
                  concatBytes(...new Array(lanes).fill(exp4))
                );
              }
            }
            for (const sz of [8, 16, 32]) {
              //            if (type.startsWith('i')) continue; // simd lane signedness?
              mod.segments[`state_${type}`].fill(0);
              mod[`get_${type}_${sz}3`](0);
              const exp1 = mod.segments[`state_${type}`].slice();
              mod[`get_${type}_${sz}3`](0);
              const exp2 = mod.segments[`state_${type}`].slice();
              mod[`get_${type}_${sz}3`](1);
              const exp3 = mod.segments[`state_${type}`].slice();
              mod[`get_${type}_${sz}3`](2);
              const exp4 = mod.segments[`state_${type}`].slice();
              vec.push(exp1, exp2, exp3, exp4);
              for (const lanes of [2, 4]) {
                const vType = `${type}x${lanes}`;
                mod.segments[`state_${vType}`].fill(0);
                mod[`get_${vType}_${sz}3`](0);
                deepStrictEqual(
                  mod.segments[`state_${vType}`],
                  concatBytes(...new Array(lanes).fill(exp1))
                );
                mod[`get_${vType}_${sz}3`](0);
                deepStrictEqual(
                  mod.segments[`state_${vType}`],
                  concatBytes(...new Array(lanes).fill(exp2))
                );
                mod[`get_${vType}_${sz}3`](1);
                deepStrictEqual(
                  mod.segments[`state_${vType}`],
                  concatBytes(...new Array(lanes).fill(exp3))
                );
                mod[`get_${vType}_${sz}3`](2);
                deepStrictEqual(
                  mod.segments[`state_${vType}`],
                  concatBytes(...new Array(lanes).fill(exp4))
                );
              }
            }
            r.push(vec);
          });
          deepStrictEqual(r[0], r[1]);
        }
      }
    });
    should('addr', () => {
      for (const type of ['u32', 'u64', 'i32', 'i64']) {
        const vType = minSimdType(type);
        const mod = new Module('wasm');
        const size = 18;
        mod.mem('state_scalar', array('u32', {}, size));
        mod.mem('state_simd2', array('u32', {}, 2, size));
        mod.mem('state_simd4', array('u32', {}, 4, size));
        const widthName = (n) => (n ? `_${n}` : '');
        for (const width of [undefined, 8, 16, 32]) {
          // TODO: add u64 output lowering in js?
          if (['i32', 'u32'].includes(type)) {
            mod.fn(`get_${type}${widthName(width)}`, ['i32'], type, (fn, pos) => {
              const T = fn.types[type];

              const mem = fn.memory.state_scalar.as8();
              const x = mem[pos].read(type, width);

              const mem2 = fn.memory.state_simd2.lanes(2)[0].as8();
              const x2 = mem2[pos].read(type, width);

              const mem4 = fn.memory.state_simd4.lanes(4)[0].as8();
              const x4 = mem4[pos].read(type, width);
              return [x, ...T.from(mem2.type, x2), ...T.from(mem4.type, x4)];
            });
          }
          mod.fn(`set_${type}${widthName(width)}`, ['i32'], 'void', (fn, pos) => {
            const T = fn.types[type];
            const T2 = fn.getType(type, 2);
            const T4 = fn.getType(type, 4);
            const mem = fn.memory.state_scalar.as8();
            mem[pos].write(type, T.const(0xff), width);
            const mem2 = fn.memory.state_simd2.lanes(2)[0].as8();
            mem2[pos].write(type, T2.const(0xff), width);
            const mem4 = fn.memory.state_simd4.lanes(4)[0].as8();
            mem4[pos].write(type, T4.const(0xff), width);
          });
        }
        const r = [];
        testBoth(mod, (mod) => {
          for (const width of [undefined, 8, 16, 32]) {
            const totalSize = size * 4 - (width ? width / 8 : CODERS[type].size) + 1; // make sure last element stay in bounds.
            for (let j = 0; j < totalSize; j++) {
              mod.segments.state_scalar.fill(0);
              mod.segments.state_simd2.fill(0);
              mod.segments.state_simd4.fill(0);
              mod[`set_${type}${widthName(width)}`](j);
              deepStrictEqual(
                mod.segments.state_simd2,
                concatBytes(mod.segments.state_scalar, mod.segments.state_scalar)
              );
              deepStrictEqual(
                mod.segments.state_simd4,
                concatBytes(
                  mod.segments.state_scalar,
                  mod.segments.state_scalar,
                  mod.segments.state_scalar,
                  mod.segments.state_scalar
                )
              );
            }
            for (let j = 0; j < totalSize; j++) {
              mod.segments.state_scalar.fill(0xaa);
              mod.segments.state_simd2.fill(0xaa);
              mod.segments.state_simd4.fill(0xaa);
              mod[`set_${type}${widthName(width)}`](j);
              deepStrictEqual(
                mod.segments.state_simd2,
                concatBytes(mod.segments.state_scalar, mod.segments.state_scalar)
              );
              deepStrictEqual(
                mod.segments.state_simd4,
                concatBytes(
                  mod.segments.state_scalar,
                  mod.segments.state_scalar,
                  mod.segments.state_scalar,
                  mod.segments.state_scalar
                )
              );
            }
            if (mod[`get_${type}${widthName(width)}`]) {
              mod.segments.state_scalar.set(utils.seq(size * 4));
              mod.segments.state_simd2.set(
                concatBytes(mod.segments.state_scalar, mod.segments.state_scalar)
              );
              mod.segments.state_simd4.set(
                concatBytes(
                  mod.segments.state_scalar,
                  mod.segments.state_scalar,
                  mod.segments.state_scalar,
                  mod.segments.state_scalar
                )
              );
              for (let j = 0; j < totalSize; j++) {
                const res = mod[`get_${type}${widthName(width)}`](j);
                deepStrictEqual(res, new Array(1 + 2 + 4).fill(res[0]));
              }
            }
          }
        });
      }
    });
  });
  describe('call', () => {
    should('basic', () => {
      for (const type of ['u32', 'u64']) {
        const mod = new Module('call')
          .mem('state', array(type, {}, 8))
          .fn('x1', [type, type], type, (f, a, b) => {
            const T = f.types[type];
            const { state } = f.memory;
            let x = T.add(a, b);
            state[0].set(x);
            return T.mul(x, T.const(2));
          })
          .fn('x2', [type, type], [type, type, type], (f, a, b) => {
            const T = f.types[type];
            const { state } = f.memory;

            let x = state[0].get(); // 8
            let y = T.sub(b, a); // 2
            let z = T.xor(x, y); // 2^8 = 10
            state[1].set(z); // 10
            return [T.mul(x, y), T.add(x, y), T.and(x, y)]; // 16, 10, 0
          })
          .fn('process', [type, type], 'void', (f, a, b) => {
            const T = f.types[type];
            const { state } = f.memory;
            state[0].set(T.const(123)); // attempt to cause race-condition
            const [x0] = f.functions.x1.call(a, b);
            const [y0, y1, y2] = f.functions.x2.call(a, b);
            state[2].set(x0);
            state[3].set(y0);
            state[4].set(y1);
          });
        // TODO: optimizer broken here
        const C = P.array(null, type === 'u64' ? P.U64LE : P.U32LE);
        testBothOpts(mod, { lowerU64Arg: true, noRuntime: type === 'u64' }, (mod) => {
          const fixInt = (n) => (type === 'u64' ? BigInt(n) : n);
          const vectors = [
            { a: 3, b: 5, res: [8, 10, 16, 16, 10, 0, 0, 0] },
            { a: 12, b: 21, res: [33, 40, 66, 297, 42, 0, 0, 0] },
            { a: 8, b: 15, res: [23, 16, 46, 161, 30, 0, 0, 0] },
            { a: 6, b: 13, res: [19, 20, 38, 133, 26, 0, 0, 0] },
            { a: 4, b: 7, res: [11, 8, 22, 33, 14, 0, 0, 0] },
          ];
          for (const { a, b, res } of vectors) {
            if (type === 'u64') {
              const a1 = utils.splitU64(a);
              const b1 = utils.splitU64(b);
              mod.process(a1.l, a1.h, b1.l, b1.h);
            } else {
              mod.process(a, b);
            }
            deepStrictEqual(C.decode(mod.segments.state), res.map(fixInt));
          }
        });
      }
    });
    should('callIf', () => {
      const C = P.array(null, P.U32LE);
      const mod = new Module('call')
        .mem('state', array('u32', {}, 1))
        .fn('x1', ['u32', 'u32'], 'void', (f, a, b) => {
          const T = f.types['u32'];
          const { state } = f.memory;
          const prev = state[0].get();
          let x = T.sub(T.add(prev, a), b);
          state[0].set(x);
        })
        .fn('process', ['i32', 'u32', 'u32'], 'void', (f, cond, a, b) => {
          const T = f.types['u32'];
          f.functions.x1.callIf(T.le(cond, T.const(10)), a, b);
        });

      testBoth(mod, (mod) => {
        mod.segments.state.fill(0);
        mod.process(1, 7, 3);
        deepStrictEqual(C.decode(mod.segments.state), [4]);
        mod.segments.state.fill(0);
        mod.process(9, 7, 3);
        deepStrictEqual(C.decode(mod.segments.state), [4]);
        mod.segments.state.fill(0);
        mod.process(10, 7, 3);
        deepStrictEqual(C.decode(mod.segments.state), [4]);
        mod.segments.state.fill(0);
        mod.process(11, 7, 3);
        deepStrictEqual(C.decode(mod.segments.state), [0]);
      });
    });
  });
  describe('loop', () => {
    should('basic block', () => {
      const type = 'u32';
      const mod = new Module('basicBlock')
        .mem('state', array(type, {}, 2))
        .fn('tmp', ['u32', 'u32'], 'void', (f, val, cond) => {
          const T = f.types[type];
          const { state } = f.memory;
          let B = [T.add(val, T.const(1)), T.add(val, T.const(2))]; // passed as mutable
          [B] = f.block([B], (B) => {
            B[1] = T.add(B[1], T.const(9));
            f.brIf(0, T.le(cond, T.const(4)), B); //
            B[0] = T.add(B[0], T.const(11));
            return [B];
          });
          state[0].set(B[0]);
          state[1].set(B[1]);
        });
      testBoth(mod, (mod) => {
        const c = P.array(null, P.U32LE);
        mod.tmp(1, 0);
        deepStrictEqual(c.decode(mod.segments.state), [2, 12]);
        mod.tmp(1, 4);
        deepStrictEqual(c.decode(mod.segments.state), [2, 12]);
        mod.tmp(1, 5);
        deepStrictEqual(c.decode(mod.segments.state), [13, 12]);
      });
    });
    should('basic loop', () => {
      const type = 'u32';
      const mod = new Module('basicLoop')
        .mem('state', array(type, {}, 2))
        .fn('tmp', ['u32'], 'void', (f, val) => {
          const T = f.types[type];
          const { state } = f.memory;

          let B = T.const(1);
          // while (counter < val) { B *= 2; counter++ }
          [B] = f.block(
            [B, T.const(0)],
            (B, counter) => {
              B = T.mul(B, T.const(2));
              counter = T.add(counter, T.const(1));
              f.brIf(0, T.le(counter, val), B, counter); // continue while counter <= val
              return [B, counter]; // fallthrough: assign, end loop
            },
            true
          );
          state[0].set(B);
        });
      testBoth(mod, (mod) => {
        const c = P.array(null, P.U32LE);
        mod.tmp(1);
        deepStrictEqual(c.decode(mod.segments.state), [4, 0]);
        mod.tmp(2);
        deepStrictEqual(c.decode(mod.segments.state), [8, 0]);
        mod.tmp(3);
        deepStrictEqual(c.decode(mod.segments.state), [16, 0]);
        mod.tmp(4);
        deepStrictEqual(c.decode(mod.segments.state), [32, 0]);
      });
    });
    should('nested block: br_if depth=1 swaps outer', () => {
      const TYP = 'u32';
      const mod = new Module('nestedBlockDepth1')
        .mem('state', array(TYP, {}, 2))
        .fn('tmp', ['u32'], 'void', (f, flip) => {
          const T = f.types[TYP];
          const { state } = f.memory;
          let A = T.const(10),
            B = T.const(20);
          // outer block returns [A,B]
          [A, B] = f.block([A, B], (A, B) => {
            // inner block tries to conditionally swap OUTER (depth=1)
            [A, B] = f.block([A, B], (Ai, Bi) => {
              f.brIf(1, T.eqz(flip), Bi, Ai); // if flip==0 => swap outer and break outer
              return [Ai, Bi]; // otherwise fallthrough no-op
            });
            // if we reached here, inner didn't break; bump both
            return [T.add(A, T.const(1)), T.add(B, T.const(1))];
          });
          state[0].set(A);
          state[1].set(B);
        });
      testBoth(mod, (m) => {
        const c = P.array(null, P.U32LE);
        m.tmp(0); // flip==0 -> inner swaps and breaks outer immediately
        deepStrictEqual(c.decode(m.segments.state), [20, 10]);
        m.tmp(1); // flip==1 -> no swap; outer fallthrough increments
        deepStrictEqual(c.decode(m.segments.state), [11, 21]);
      });
    });
    should('nested loop: continue self (depth=0) vs break outer (depth=1)', () => {
      const TYP = 'u32';
      const mod = new Module('nestedLoopDepths')
        .mem('state', array(TYP, {}, 2))
        // Compute: start x=1; for i in [0..N) double x; if i==stop -> break outer loop with yields
        // else if i is even -> continue (skip assigning bump)
        .fn('tmp', ['u32', 'u32'], 'void', (f, N, stop) => {
          const T = f.types[TYP];
          const { state } = f.memory;

          let x = T.const(1),
            i = T.const(0);

          [x, i] = f.block([x, i], (x, i) => {
            // while loop using your low-level loop
            return f.block(
              [x, i],
              (x, i) => {
                // body:
                const x2 = T.mul(x, T.const(2));
                const i2 = T.add(i, T.const(1));

                // inner decision block:
                // - if i2 == stop => break outer (depth=1) yielding [x2, i2]
                // - else if even(i2) => continue this loop (depth=0) with [x2, i2]
                // - else fallthrough and assign [x2, i2] to state (one more iteration pass)
                [x, i] = f.block([x, i], (x, i) => {
                  const isStop = T.eq(i2, stop);
                  f.brIf(2, isStop, x2, i2); // break outer loop now

                  const isEven = T.eq(T.and(i2, T.const(1)), T.const(0));
                  f.brIf(0, isEven, x2, i2); // continue this loop now

                  return [x2, i2]; // regular advance, no branch
                });

                // loop continues unless broken by depth=1 above
                f.br(0, x, i);
                return [x, i];
              },
              /*isLoop*/ true
            );
          });

          state[0].set(x);
          state[1].set(i);
        });
      testBoth(mod, (m) => {
        const c = P.array(null, P.U32LE);
        m.tmp(5, 3);
        deepStrictEqual(c.decode(m.segments.state), [8, 3]);
      });
    });
    should('block diamond with guarded br_if assigning two results', () => {
      const TYP = 'u32';
      const mod = new Module('diamondBlock')
        .mem('state', array(TYP, {}, 2))
        .fn('tmp', ['u32'], 'void', (f, cond) => {
          const T = f.types[TYP];
          let a = T.const(5),
            b = T.const(9);
          const { state } = f.memory;

          [a, b] = f.block([a, b], (a, b) => {
            const t1 = T.add(a, T.const(100));
            const t2 = T.add(b, T.const(200));
            // if cond != 0 => take fast path and exit block early with [t1,t2]
            f.brIf(0, cond, t1, t2);
            // else fallthrough “slow” path
            return [T.add(a, T.const(1)), T.add(b, T.const(2))];
          });
          state[0].set(a);
          state[1].set(b);
        });

      testBoth(mod, (m) => {
        const c = P.array(null, P.U32LE);
        m.tmp(1);
        deepStrictEqual(c.decode(m.segments.state), [105, 209]); // took fast path
        m.tmp(0);
        deepStrictEqual(c.decode(m.segments.state), [6, 11]); // slow path fallthrough
      });
    });
    should('callIf via guard block: single call', () => {
      const TYP = 'u32';
      const mod = new Module('callIf')
        .mem('state', array(TYP, {}, 1))
        // a tiny callee: add( base, k )
        .fn('add', ['u32', 'u32'], 'u32', (f, base, k) => {
          const T = f.types[TYP];
          return [T.add(base, k)];
        })
        .fn('tmp', ['u32', 'u32'], 'void', (f, base, cond) => {
          const T = f.types[TYP];
          const { state } = f.memory;
          let out = base;
          // emulate: if (cond) out = add(base, 7);
          [out] = f.block([out], (x) => {
            // Guard: if !cond => skip call and fallthrough returning x
            f.brIf(0, T.eqz(cond), x);
            const [y] = f.functions.add.call(base, T.const(7));
            return [y];
          });
          state[0].set(out);
        });
      testBoth(mod, (m) => {
        const c = P.array(null, P.U32LE);
        m.tmp(10, 0); // cond=false -> no call
        deepStrictEqual(c.decode(m.segments.state), [10]);
        m.tmp(10, 1); // cond=true  -> called once
        deepStrictEqual(c.decode(m.segments.state), [17]);
      });
    });
    should('branch yield shape check', () => {
      const TYP = 'u32';
      const mod = new Module('shapeCheck').fn('tmp', [], 'void', (f) => {
        const T = f.types[TYP];
        let a = T.const(1),
          b = T.const(2);
        // block expects 2 results
        try {
          [a, b] = f.block([a, b], (a, b) => {
            // Wrong: yield 1 value only
            f.brIf(0, T.const(1), a);
            return [a, b];
          });
        } catch (e) {
          f.rawFn.ops.stack.pop();
          if (e.message === 'expected throw not thrown') throw e;
        }
      });
      toWasm(mod);
    });
    should('basic2', () => {
      const type = 'u32';
      const mod = new Module('loopTest')
        .mem('state', array(type, {}, 4))
        .fn('tmp', ['u32', 'u32'], 'void', (f, val, cond) => {
          const { state } = f.memory;
          const T = f.types[type];
          let A = T.add(val, T.const(10)); // passed as mutable
          let B = [T.add(val, T.const(1)), T.add(val, T.const(2))]; // passed as mutable
          let C = T.add(val, T.const(3)); // used directly
          [A, B] = f.block([A, B], (A, B) => {
            A = T.add(A, T.const(7));
            B[1] = T.add(B[1], T.const(9));
            // C = T.add(C, T.const(3)); // this is intentional bug to see how it works
            f.brIf(0, T.le(cond, T.const(4)), A, B); //
            B[0] = T.add(B[0], T.const(11));
            return [A, B];
          });
          state[0].set(A);
          state[1].set(B[0]);
          state[2].set(B[1]);
          state[3].set(C);
        });
      testBoth(mod, (mod) => {
        const c = P.array(null, P.U32LE);
        mod.tmp(1, 0);
        deepStrictEqual(c.decode(mod.segments.state), [18, 2, 12, 4]);
        mod.tmp(1, 4);
        deepStrictEqual(c.decode(mod.segments.state), [18, 2, 12, 4]);
        mod.tmp(1, 5);
        deepStrictEqual(c.decode(mod.segments.state), [18, 13, 12, 4]);
        mod.tmp(2, 0);
        deepStrictEqual(c.decode(mod.segments.state), [19, 3, 13, 5]);
        mod.tmp(3, 4);
        deepStrictEqual(c.decode(mod.segments.state), [20, 4, 14, 6]);
        mod.tmp(4, 5);
        deepStrictEqual(c.decode(mod.segments.state), [21, 16, 15, 7]);
      });
    });
    should('inner block breaks grandparent loop (depth=2)', () => {
      const TYP = 'u32';
      const mod = new Module('breakGrandparent')
        .mem('state', array(TYP, {}, 2))
        .fn('tmp', ['u32', 'u32'], 'void', (f, N, stop) => {
          const { state } = f.memory;
          const T = f.types[TYP];
          let x = T.const(1),
            i = T.const(0);

          // outer block -> loop -> inner block; inner may break outer block (depth=2)
          [x, i] = f.block([x, i], (x, i) => {
            return f.block([x, i], (x, i) => {
              return f.block(
                [x, i],
                (x, i) => {
                  // loop body
                  const x2 = T.mul(x, T.const(2));
                  const i2 = T.add(i, T.const(1));
                  // if i2 == stop -> break outer block (depth=2) with [x2,i2]
                  const isStop = T.eq(i2, stop);
                  f.brIf(2, isStop, x2, i2);
                  // else continue loop
                  f.br(0, x2, i2);
                  return [x, i];
                },
                /*isLoop*/ true
              );
            });
          });

          state[0].set(x);
          state[1].set(i);
        });
      testBoth(mod, (m) => {
        const c = P.array(null, P.U32LE);
        m.tmp(10, 3); // double until i hits 3, then break outer block with that state
        deepStrictEqual(c.decode(m.segments.state), [8, 3]);
        m.tmp(5, 1); // i2 becomes 1 on the first step -> break -> [2,1]
        deepStrictEqual(c.decode(m.segments.state), [2, 1]);
      });
    });
    should('inner block continues outer loop (depth=1)', () => {
      const TYP = 'u32';
      const mod = new Module('continueOuterLoop')
        .mem('state', array(TYP, {}, 2))
        .fn('tmp', ['u32'], 'void', (f, N) => {
          const T = f.types[TYP];
          const { state } = f.memory;
          let x = T.const(1),
            i = T.const(0);
          [x, i] = f.block([x, i], (x, i) => {
            return f.block(
              [x, i],
              (x, i) => {
                // while (i < N) { x*=2; i++; if (i is even) continue outer loop; else fallthrough assigns }
                const x2 = T.mul(x, T.const(2));
                const i2 = T.add(i, T.const(1));
                // if i2 >= N -> break to outer block (depth=1) with [x2,i2] to finish quickly
                const done = T.le(N, i2); // i2 >= N
                f.brIf(1, done, x2, i2); // break outer loop (ends the loop block)
                // if even(i2) -> continue this loop (depth=0)
                const isEven = T.eq(T.and(i2, T.const(1)), T.const(0));
                f.brIf(0, isEven, x2, i2); // continue current loop
                // odd: just assign and then loop continues below
                f.br(0, x2, i2);
                return [x2, i2];
              },
              true
            );
          });
          state[0].set(x);
          state[1].set(i);
        });
      testBoth(mod, (m) => {
        const c = P.array(null, P.U32LE);
        m.tmp(1);
        deepStrictEqual(c.decode(m.segments.state), [2, 1]);
        m.tmp(2);
        deepStrictEqual(c.decode(m.segments.state), [4, 2]); // even path hit continue
        m.tmp(5);
        deepStrictEqual(c.decode(m.segments.state), [32, 5]);
      });
    });
    should('loop types', () => {
      for (const type of ['u32', 'i32', 'u64', 'i64']) {
        const mod = new Module('continueOuterLoop')
          .mem('state', array(type, {}, 2))
          .fn('tmp', ['u32'], 'void', (f, N) => {
            const T = f.types[type];
            const { state } = f.memory;
            N = T.fromN('u32', N);
            const [x, i] = f.block(
              [T.const(1), T.const(0)],
              (x, i) => {
                x = T.mul(x, T.const(2));
                i = T.add(i, T.const(1));
                f.brIf(0, T.lt(i, N), x, i); // continue current loop
                return [x, i];
              },
              true
            );
            state[0].set(x);
            state[1].set(i);
          });

        testBoth(mod, (m) => {
          const fixBigint = (n) => (type.includes('64') ? BigInt(n) : n);
          const c = P.array(null, CODERS[type]);
          m.tmp(1);
          deepStrictEqual(c.decode(m.segments.state), [2, 1].map(fixBigint));
          m.tmp(2);
          deepStrictEqual(c.decode(m.segments.state), [4, 2].map(fixBigint));
          m.tmp(3);
          deepStrictEqual(c.decode(m.segments.state), [8, 3].map(fixBigint));
          m.tmp(4);
          deepStrictEqual(c.decode(m.segments.state), [16, 4].map(fixBigint));
          m.tmp(5);
          deepStrictEqual(c.decode(m.segments.state), [32, 5].map(fixBigint));
          if (type === 'i32') {
            m.tmp(31);
            deepStrictEqual(c.decode(m.segments.state), [-2147483648, 31].map(fixBigint));
            m.tmp(32);
            deepStrictEqual(c.decode(m.segments.state), [0, 32].map(fixBigint));
          }
          if (type === 'u32') {
            m.tmp(31);
            deepStrictEqual(c.decode(m.segments.state), [2147483648, 31].map(fixBigint));
            m.tmp(32);
            deepStrictEqual(c.decode(m.segments.state), [0, 32].map(fixBigint));
          }
          if (type === 'i64') {
            m.tmp(31);
            deepStrictEqual(c.decode(m.segments.state), [2147483648n, 31].map(fixBigint));
            m.tmp(32);
            deepStrictEqual(c.decode(m.segments.state), [4294967296n, 32].map(fixBigint));
            m.tmp(33);
            deepStrictEqual(c.decode(m.segments.state), [8589934592n, 33].map(fixBigint));
            m.tmp(63);
            deepStrictEqual(c.decode(m.segments.state), [-9223372036854775808n, 63].map(fixBigint));
            m.tmp(64);
            deepStrictEqual(c.decode(m.segments.state), [0n, 64n].map(fixBigint));
          }
          if (type === 'u64') {
            m.tmp(31);
            deepStrictEqual(c.decode(m.segments.state), [2147483648n, 31].map(fixBigint));
            m.tmp(32);
            deepStrictEqual(c.decode(m.segments.state), [4294967296n, 32].map(fixBigint));
            m.tmp(33);
            deepStrictEqual(c.decode(m.segments.state), [8589934592n, 33].map(fixBigint));
            m.tmp(63);
            deepStrictEqual(c.decode(m.segments.state), [9223372036854775808n, 63].map(fixBigint));
            m.tmp(64);
            deepStrictEqual(c.decode(m.segments.state), [0n, 64n].map(fixBigint));
          }
        });
        const vType = minSimdType(type);
        const modV = new Module('continueOuterLoop');
        modV.mem(
          'state',
          struct({
            cnt: 'u32',
            value: vType,
          })
        );
        modV.fn('tmp', ['u32'], 'void', (f, N) => {
          const T = f.types[vType];
          const { u32 } = f.types;
          const [x, i] = f.block(
            [T.const(1), u32.const(0)],
            (x, i) => {
              x = T.mul(x, T.const(2));
              i = u32.add(i, u32.const(1));
              f.brIf(0, u32.lt(i, N), x, i); // continue current loop
              return [x, i];
            },
            true
          );
          f.memory.state.cnt.set(i);
          f.memory.state.value.set(x);
        });
        testBoth(modV, (m) => {
          const fixBigint = (n) => (type.includes(64) ? BigInt(n) : n);
          const lanes = type.includes(64) ? 2 : 4;
          const c = P.array(lanes, CODERS[type]);
          const cnt = CODERS.u32;
          m.tmp(1);
          deepStrictEqual(cnt.decode(m.segments['state.cnt']), 1);
          deepStrictEqual(
            c.decode(m.segments['state.value']),
            new Array(lanes).fill(2).map(fixBigint)
          );
          m.tmp(2);
          deepStrictEqual(cnt.decode(m.segments['state.cnt']), 2);
          deepStrictEqual(
            c.decode(m.segments['state.value']),
            new Array(lanes).fill(4).map(fixBigint)
          );
          m.tmp(3);
          deepStrictEqual(cnt.decode(m.segments['state.cnt']), 3);
          deepStrictEqual(
            c.decode(m.segments['state.value']),
            new Array(lanes).fill(8).map(fixBigint)
          );
          m.tmp(4);
          deepStrictEqual(cnt.decode(m.segments['state.cnt']), 4);
          deepStrictEqual(
            c.decode(m.segments['state.value']),
            new Array(lanes).fill(16).map(fixBigint)
          );
          m.tmp(5);
          deepStrictEqual(cnt.decode(m.segments['state.cnt']), 5);
          deepStrictEqual(
            c.decode(m.segments['state.value']),
            new Array(lanes).fill(32).map(fixBigint)
          );
          m.tmp(30);
          deepStrictEqual(cnt.decode(m.segments['state.cnt']), 30);
          deepStrictEqual(
            c.decode(m.segments['state.value']),
            new Array(lanes).fill(1073741824).map(fixBigint)
          );
        });

        const mod2 = new Module('continueOuterLoop')
          .mem(
            'state',
            struct({
              cnt: 'u32',
              x1: type,
              x2: vType,
              x3: 'u32',
              x4: 'u64',
              x5: 'i32',
              x6: 'i64',
            })
          )
          .fn('tmp', ['u32'], 'void', (f, N) => {
            const T = f.types[type];
            const vT = f.types[vType];
            const { u32, u64, i32, i64 } = f.types;
            const [i, x1, x2, x3, x4, x5, x6] = f.block(
              [
                u32.const(0), // i
                T.const(1), // x
                vT.const(1), // x2
                u32.const(1), // x3
                u64.const(1), // x4
                i32.const(1), // x5
                i64.const(1), // x6?
              ],
              (i, x1, x2, x3, x4, x5, x6) => {
                i = u32.add(i, u32.const(1)); // counter
                x1 = T.mul(x1, T.const(2));
                x2 = vT.mul(x2, vT.const(2));
                x3 = u32.mul(x3, u32.const(2));
                x4 = u64.mul(x4, u64.const(2));
                x5 = i32.mul(x5, i32.const(2));
                x6 = i64.mul(x6, i64.const(2));
                f.brIf(0, u32.lt(i, N), i, x1, x2, x3, x4, x5, x6); // continue current loop
                return [i, x1, x2, x3, x4, x5, x6];
              },
              true
            );
            // idea here is force lowering to move non-splitted variables on splitting
            f.memory.state.set({
              cnt: i,
              x1,
              x2,
              x3,
              x4,
              x5,
              x6,
            });
          });
        testBoth(mod2, (m) => {
          const fixBigint = (n) => (type.includes(64) ? BigInt(n) : n);
          const lanes = type.includes(64) ? 2 : 4;
          const c = CODERS[type];
          const t = (n: number) => {
            m.tmp(n);
            return {
              cnt: P.U32LE.decode(m.segments['state.cnt']),
              x1: c.decode(m.segments['state.x1']),
              x2: P.array(lanes, c).decode(m.segments['state.x2']),
              x3: P.U32LE.decode(m.segments['state.x3']),
              x4: P.U64LE.decode(m.segments['state.x4']),
              x5: P.I32LE.decode(m.segments['state.x5']),
              x6: P.I64LE.decode(m.segments['state.x6']),
            };
          };
          deepStrictEqual(t(0), {
            cnt: 1,
            x1: fixBigint(2),
            x2: new Array(lanes).fill(2).map(fixBigint),
            x3: 2,
            x4: 2n,
            x5: 2,
            x6: 2n,
          });
          deepStrictEqual(t(1), {
            cnt: 1,
            x1: fixBigint(2),
            x2: new Array(lanes).fill(2).map(fixBigint),
            x3: 2,
            x4: 2n,
            x5: 2,
            x6: 2n,
          });
          deepStrictEqual(t(2), {
            cnt: 2,
            x1: fixBigint(4),
            x2: new Array(lanes).fill(4).map(fixBigint),
            x3: 4,
            x4: 4n,
            x5: 4,
            x6: 4n,
          });
          deepStrictEqual(t(16), {
            cnt: 16,
            x1: fixBigint(65536),
            x2: new Array(lanes).fill(65536).map(fixBigint),
            x3: 65536,
            x4: 65536n,
            x5: 65536,
            x6: 65536n,
          });
          deepStrictEqual(t(30), {
            cnt: 30,
            x1: fixBigint(1073741824),
            x2: new Array(lanes).fill(1073741824).map(fixBigint),
            x3: 1073741824,
            x4: 1073741824n,
            x5: 1073741824,
            x6: 1073741824n,
          });
          const signed = type.startsWith('i');
          const is64 = type.includes('64');

          const val = !is64 && signed ? -2147483648 : 2147483648;
          deepStrictEqual(t(31), {
            cnt: 31,
            x1: fixBigint(val),
            x2: new Array(lanes).fill(val).map(fixBigint),
            x3: 2147483648,
            x4: 2147483648n,
            x5: -2147483648,
            x6: 2147483648n,
          });
          const val2 = is64 ? 4294967296n : signed ? 0 : 0;
          deepStrictEqual(t(32), {
            cnt: 32,
            x1: fixBigint(val2),
            x2: new Array(lanes).fill(val2).map(fixBigint),
            x3: 0,
            x4: 4294967296n,
            x5: 0,
            x6: 4294967296n,
          });
          const val3 = is64 ? (signed ? -9223372036854775808n : 9223372036854775808n) : 0;
          deepStrictEqual(t(63), {
            cnt: 63,
            x1: fixBigint(val3),
            x2: new Array(lanes).fill(val3).map(fixBigint),
            x3: 0,
            x4: 9223372036854775808n,
            x5: 0,
            x6: -9223372036854775808n,
          });
          deepStrictEqual(t(64), {
            cnt: 64,
            x1: fixBigint(0),
            x2: new Array(lanes).fill(0).map(fixBigint),
            x3: 0,
            x4: 0n,
            x5: 0,
            x6: 0n,
          });
          for (let i = 65; i < 120; i++) {
            deepStrictEqual(t(i), {
              cnt: i,
              x1: fixBigint(0),
              x2: new Array(lanes).fill(0).map(fixBigint),
              x3: 0,
              x4: 0n,
              x5: 0,
              x6: 0n,
            });
          }
        });
      }
    });
    describe('loops high-level', () => {
      should('for basic', () => {
        const mod = new Module('nestedFor')
          .fn('tmp', ['i32', 'i32'], 'void', (f, N, M) => {
            const T = f.types.i32;
            let [cnt, res] = f.forLoop(
              [T.const(0), T.const(1)], // i = 0
              (i, ...state) => T.lt(i, N), // i<N
              (i, ...state) => [T.add(i, T.const(1)), ...state], // i++
              (i, res) => {
                return [i, T.mul(res, M)];
              }
            );
            return [cnt, res];
          })
          .fn('tmp2', ['i32', 'i32'], 'void', (f, N, M) => {
            const T = f.types.i32;
            return f.doN([T.const(1)], N, (i, x) => [T.mul(x, M)]);
            return [res];
          });
        function jsFor(N, M) {
          let cnt, res;
          for (cnt = 0, res = 1; cnt < N; cnt++) {
            res *= M;
          }
          return [cnt, res];
        }
        testBoth(mod, (mod) => {
          for (const [N, M, EXP] of [
            [0, 0, [0, 1]],
            [0, 2, [0, 1]],
            [1, 1, [1, 1]],
            [1, 2, [1, 2]],
            [5, 2, [5, 32]],
          ]) {
            deepStrictEqual(mod.tmp(N, M), jsFor(N, M));
            deepStrictEqual(mod.tmp(N, M), EXP);
            deepStrictEqual(mod.tmp2(N, M), EXP[1]);
          }
        });
      });
      should('for nested', () => {
        const mod = new Module('nestedFor').fn(
          'tmp',
          ['i32', 'i32', 'i32'],
          'void',
          (f, N, M, E) => {
            const T = f.types.i32;
            let [cnt, res] = f.forLoop(
              [T.const(0), T.const(1)], // i = 0
              (i, ...state) => T.lt(i, N), // i<N
              (i, ...state) => [T.add(i, T.const(1)), ...state], // i++
              (i, res) => {
                let j;
                [j, res] = f.forLoop(
                  [T.const(0), res], // j = 0
                  (j) => T.lt(j, E), // j<N
                  (j, ...state) => [T.add(j, T.const(1)), ...state], // i++
                  (j, res) => [j, T.mul(res, M)]
                );
                return [i, res];
              }
            );
            return [cnt, res];
          }
        );
        function jsFor(N, M, E) {
          let cnt, res;
          for (cnt = 0, res = 1; cnt < N; cnt++) {
            for (let j = 0; j < E; j++) {
              res *= M;
            }
          }
          return [cnt, res];
        }

        testBoth(mod, (mod) => {
          for (const [N, M, E, EXP] of [
            [0, 0, 0, [0, 1]],
            [0, 2, 0, [0, 1]],
            [0, 2, 1, [0, 1]],
            [1, 2, 0, [1, 1]],
            [1, 1, 1, [1, 1]],
            [1, 2, 1, [1, 2]],
            [2, 2, 3, [2, 64]],
            [3, 2, 2, [3, 64]],
          ]) {
            deepStrictEqual(mod.tmp(N, M, E), jsFor(N, M, E));
            deepStrictEqual(mod.tmp(N, M, E), EXP);
          }
        });
      });
      should('for', () => {
        function jsNestedForMirror(
          N,
          M,
          {
            contInnerEven = false,
            breakInnerAtJ = null,
            contOuterAtJ = null,
            breakOuterAt = null,
          } = {}
        ) {
          const visits = [];
          let lastI = -1,
            lastJ = -1;
          Outer: for (let i = 0; i < N; i++) {
            Inner: for (let j = 0; j < M; j++) {
              // labeled break Outer before "work"
              if (breakOuterAt && i === breakOuterAt[0] && j === breakOuterAt[1]) {
                lastI = i;
                lastJ = j;
                break Outer;
              }
              // unlabeled continue inner
              if (contInnerEven && j % 2 === 0) {
                continue; // Inner
              }
              // labeled continue Outer (skip rest of inner, proceed with next i++)
              if (contOuterAtJ !== null && j === contOuterAtJ) {
                lastI = i;
                lastJ = j;
                continue Outer;
              }
              // unlabeled break inner
              if (breakInnerAtJ !== null && j === breakInnerAtJ) {
                lastI = i;
                lastJ = j;
                break Inner;
              }
              // --- work ---
              visits.push([i, j]);
              lastI = i;
              lastJ = j;
            }
          }
          return { visits, lastI, lastJ };
        }
        const VIS_CAP = 128; // adjust for tests
        const mod = new Module('nestedFor')
          .mem('vis', array('i32', {}, VIS_CAP * 2))
          .mem('visCnt', array('i32', {}, 1))
          .fn('pushVisit', ['i32', 'i32'], 'void', (f, i, j) => {
            const T = f.types.i32;
            const { visCnt, vis } = f.memory;
            let pos = visCnt[0].get();
            for (const t of [i, j]) {
              vis[pos].set(t);
              pos = T.add(pos, T.const(1));
            }
            visCnt[0].set(pos);
          })
          .fn(
            'tmp',
            ['i32', 'i32', 'i32', 'i32', 'i32', 'i32', 'i32'],
            'void',
            (f, N, M, contInnerEven, breakInnerAtJ, contOuterAtJ, breakOuterI, breakOuterJ) => {
              const T = f.types.i32;
              let lastI = T.const(-1);
              let lastJ = T.const(-1);
              let tmpI;
              [tmpI, lastI, lastJ] = f.forLoop(
                [T.const(0), lastI, lastJ], // i = 0
                (i, ...state) => T.lt(i, N), // i<N
                (i, ...state) => [T.add(i, T.const(1)), ...state], // i++
                (i, ...state) => {
                  let tmpJ;
                  [tmpJ, lastI, lastJ] = f.forLoop(
                    [T.const(0), lastI, lastJ], // j=0
                    (j, ...state) => T.lt(j, M), // j<M
                    (j, ...state) => [T.add(j, T.const(1)), ...state], // j++
                    (j, ...state) => {
                      // // labeled break Outer before "work"
                      // if (breakOuterAt && i === breakOuterAt[0] && j === breakOuterAt[1]) {
                      //   lastI = i;
                      //   lastJ = j;
                      //   break Outer;
                      // }

                      // // unlabeled continue inner
                      // if (contInnerEven && j % 2 === 0) {
                      //   continue; // Inner
                      // }
                      // // labeled continue Outer (skip rest of inner, proceed with next i++)
                      // if (contOuterAtJ !== null && j === contOuterAtJ) {
                      //   lastI = i;
                      //   lastJ = j;
                      //   continue Outer;
                      // }
                      // // unlabeled break inner
                      // if (breakInnerAtJ !== null && j === breakInnerAtJ) {
                      //   lastI = i;
                      //   lastJ = j;
                      //   break Inner;
                      // }

                      const NEG1 = T.const(-1);

                      // helpers
                      const isSet = (x: FnOp) => T.ne(x, NEG1);
                      const eq = (a: FnOp, b: FnOp) => T.eq(a, b);

                      // labeled break Outer before work
                      {
                        const bothSet = T.and(isSet(breakOuterI), isSet(breakOuterJ));
                        const match = T.and(eq(i, breakOuterI), eq(j, breakOuterJ));
                        const cond = T.and(bothSet, match);
                        // outer state shape: [i, lastI, lastJ]
                        f.breakIf(cond, 'Outer', i, i, j);
                      }

                      // unlabeled continue inner on even j (do NOT touch lastI/lastJ)
                      {
                        const isEvenJ = T.eq(T.and(j, T.const(1)), T.const(0));
                        const take = T.and(contInnerEven, isEvenJ);
                        // inner state shape: [j, lastI, lastJ]
                        f.continueIf(take, undefined, j, lastI, lastJ);
                      }

                      // labeled continue Outer at j == contOuterAtJ
                      {
                        const set = isSet(contOuterAtJ);
                        const hit = eq(j, contOuterAtJ);
                        const cond = T.and(set, hit);
                        // update lastI/lastJ, then continue Outer with [i, lastI, lastJ]
                        f.continueIf(cond, 'Outer', i, i, j);
                      }

                      // unlabeled break Inner at j == breakInnerAtJ
                      {
                        const set = isSet(breakInnerAtJ);
                        const hit = eq(j, breakInnerAtJ);
                        const cond = T.and(set, hit);
                        // update lastI/lastJ, then break inner with [j, lastI, lastJ]
                        f.breakIf(cond, undefined, j, i, j);
                      }

                      f.functions.pushVisit.call(i, j);
                      lastI = i;
                      lastJ = j;
                      return [j, lastI, lastJ];
                    }
                  );
                  return [i, lastI, lastJ];
                },
                'Outer'
              );
              return [lastI, lastJ];
            }
          );

        function test(N, M, opts, exp) {
          const jsRes = jsNestedForMirror(N, M, opts);
          deepStrictEqual(jsRes.visits, exp);
          testBoth(mod, (mod) => {
            mod.segments.visCnt.fill(0);
            const [lastI, lastJ] = mod.tmp(
              N,
              M,
              +opts.contInnerEven,
              opts.breakInnerAtJ !== undefined ? opts.breakInnerAtJ : -1,
              opts.contOuterAtJ !== undefined ? opts.contOuterAtJ : -1,
              ...(opts.breakOuterAt ? opts.breakOuterAt : [-1, -1])
            );
            const cnt = P.I32LE.decode(mod.segments.visCnt);
            const vis = utils.chunks(
              P.array(null, P.I32LE).decode(mod.segments.vis).slice(0, cnt),
              2
            );
            deepStrictEqual(vis, exp);
            deepStrictEqual({ lastI, lastJ }, { lastI: jsRes.lastI, lastJ: jsRes.lastJ });
          });
        }
        // Base: no flow control => all cells visited in row-major
        test(3, 4, {}, [
          [0, 0],
          [0, 1],
          [0, 2],
          [0, 3],
          [1, 0],
          [1, 1],
          [1, 2],
          [1, 3],
          [2, 0],
          [2, 1],
          [2, 2],
          [2, 3],
        ]);
        // Unlabeled break inner at j==2 => per row we only see j=0,1
        test(3, 4, { breakInnerAtJ: 2 }, [
          [0, 0],
          [0, 1],
          [1, 0],
          [1, 1],
          [2, 0],
          [2, 1],
        ]);

        // Unlabeled continue inner on even j => visit only odd columns
        test(3, 4, { contInnerEven: true }, [
          [0, 1],
          [0, 3],
          [1, 1],
          [1, 3],
          [2, 1],
          [2, 3],
        ]);
        // Combo: continue Outer at j==1, so each row visits only j=0 then jumps row
        test(3, 4, { contOuterAtJ: 1 }, [
          [0, 0],
          [1, 0],
          [2, 0],
        ]);
        // Labeled continue Outer at j==2 => skip rest of the row after hitting j=2
        // (work happens only before j==2)
        test(3, 4, { contOuterAtJ: 2 }, [
          [0, 0],
          [0, 1],
          [1, 0],
          [1, 1],
          [2, 0],
          [2, 1],
        ]);
        // Labeled break Outer at (1,1) => stop everything before doing work at (1,1)
        test(3, 4, { breakOuterAt: [1, 1] }, [
          [0, 0],
          [0, 1],
          [0, 2],
          [0, 3],
          [1, 0],
        ]);
        // Combo: continue inner evens, but break outer at (2,1) (before work)
        test(3, 4, { contInnerEven: true, breakOuterAt: [2, 1] }, [
          [0, 1],
          [0, 3],
          [1, 1],
          [1, 3],
          // at i=2: j=0 (continue), j=1 -> break Outer before work -> stop
        ]);
      });
      should('doWhile', () => {
        const mod = new Module('nestedFor').fn('tmp2', ['i32', 'i32'], 'void', (f, N, M) => {
          const T = f.types.i32;
          return f.doN1([T.const(1)], N, (i, x) => [T.mul(x, M)]);
          return [res];
        });
        function jsDo(N, M) {
          let cnt = 0;
          let res = 1;
          do {
            res *= M;
            cnt++;
          } while (cnt < N);
          return [cnt, res];
        }
        testBoth(mod, (mod) => {
          for (const [N, M, EXP] of [
            [0, 0, [1, 0]],
            [0, 2, [1, 2]],
            [1, 1, [1, 1]],
            [1, 2, [1, 2]],
            [5, 2, [5, 32]],
          ]) {
            deepStrictEqual(jsDo(N, M), EXP);
            deepStrictEqual(mod.tmp2(N, M), jsDo(N, M)[1]);
            deepStrictEqual(mod.tmp2(N, M), EXP[1]);
          }
        });
      });
    });
    describe('if/else', () => {
      should('basic', () => {
        function jsIfOnly(x, y) {
          // if (x > 0) y = y * 2;
          return x > 0 ? y * 2 : y;
        }
        function jsMax(a, b) {
          return a > b ? a : b;
        }
        function jsSumProd(a, b, sum0, prod0) {
          if (a > b) {
            // if-branch: add a, multiply by a
            return [sum0 + a, Math.imul(prod0, a)];
          } else {
            // else-branch: add b, multiply by b
            return [sum0 + b, Math.imul(prod0, b)];
          }
        }
        // --- Module under test ---
        const mod = new Module('ifElse-tests');
        // 1) IF-only: (x, y) -> y' (double y if x>0)
        mod.fn('ifOnly', ['i32', 'i32'], 'void', (f, x, y) => {
          const T = f.types.i32;
          const gt0 = T.gt(x, T.const(0));
          const [y2] = f.ifElse(
            gt0,
            [y],
            (y) => [T.mul(y, T.const(2))] // IF
            // no else => pass-through
          );
          return [y2];
        });
        // 2) IF+ELSE: max(a,b)
        mod.fn('max2', ['i32', 'i32'], 'void', (f, a, b) => {
          const T = f.types.i32;
          const agtb = T.gt(a, b);
          const [m] = f.ifElse(
            agtb,
            [a], // state shape (one slot)
            () => [a], // IF -> a
            () => [b] // ELSE -> b
          );
          return [m];
        });
        // 3) IF+ELSE with multi-slot state: (a,b,sum,prod) -> [sum', prod']
        mod.fn('sumProd', ['i32', 'i32', 'i32', 'i32'], 'void', (f, a, b, sum, prod) => {
          const T = f.types.i32;
          const agtb = T.gt(a, b);
          const [sum1, prod1] = f.ifElse(
            agtb,
            [sum, prod], // two-slot state
            (s, p) => [T.add(s, a), T.mul(p, a)], // IF: use a
            (s, p) => [T.add(s, b), T.mul(p, b)] // ELSE: use b
          );
          return [sum1, prod1];
        });
        testBoth(mod, (mod) => {
          // IF-only
          for (const [x, y] of [
            [-3, 7], // x<=0 -> unchanged
            [0, 5], // x<=0 -> unchanged
            [1, 9], // x>0 -> doubled
          ]) {
            deepStrictEqual(mod.ifOnly(x, y), jsIfOnly(x, y), `ifOnly(${x},${y})`);
          }
          // max2
          for (const [a, b] of [
            [1, 2],
            [5, 5],
            [10, -3],
            [-7, -2],
          ]) {
            deepStrictEqual(mod.max2(a, b), jsMax(a, b), `max2(${a},${b})`);
          }
          // sumProd
          for (const [a, b, s, p] of [
            [3, 4, 10, 2], // else branch (b chosen)
            [6, 1, 7, 3], // if branch (a chosen)
            [5, 5, 1, 9], // equal -> else branch by (a>b) strictness
          ]) {
            deepStrictEqual(
              mod.sumProd(a, b, s, p),
              jsSumProd(a, b, s, p),
              `sumProd(${a},${b},${s},${p})`
            );
          }
        });
      });
    });
  });
});

describe('Review regressions', () => {
  should('batchFn lanes are positive', () => {
    const mod = new Module('batch_lanes');
    throws(() => mod.batchFn('zero', { lanes: 0 }, [], () => {}), /wrong lanes/);
    throws(() => mod.batchFn('negative', { lanes: -1 }, [], () => {}), /wrong lanes/);
  });

  should('ModuleGraph output edges distinguish sibling path prefixes', () => {
    const mg = new ModuleGraph('prefix_edge', {}, new Module('prefix_edge'), {});
    mg.subgraph(
      'function',
      'main',
      { inputs: [], outputs: [], memOps: {}, opts: {}, embedFns: {}, embedPos: 0 },
      () => {
        const first = mg.op('u32', 'const', [], { value: 0 });
        const blockIdx = mg.subgraph(
          'block',
          'prefix',
          { args: [], outputs: [], opts: {}, shape: undefined },
          () => {}
        );
        for (let i = 0; i < 8; i++) mg.op('u32', 'const', [], { value: i });
        const sibling = mg.op('u32', 'add', [first, first]);
        const block = mg.ops.get(blockIdx) as any;
        block.outputs = [sibling.idx];
        deepStrictEqual(
          { blockIdx, sibling: sibling.idx, edges: Array.from(mg.ops.getEdges(blockIdx, false)) },
          { blockIdx: '0.1', sibling: '0.10', edges: ['0.10'] }
        );
      }
    );
  });

  should('PosExpr eval includes numeric base products', () => {
    deepStrictEqual(PosExpr.eval({ base: 5, baseMul: [6], syms: [], coeffs: [] }, []), 11);
    throws(
      () => PosExpr.eval({ base: 0, baseMul: [[new FnOp('0')]], syms: [], coeffs: [] }, []),
      /cannot evaluate symbolic product/
    );
  });

  should('array dimensions are positive safe integers', () => {
    throws(() => array('u32', {}, 2, 0), /wrong array size/);
    throws(() => array('u32', {}, 2, 1.5), /wrong array size/);
  });

  should('array dimensions reject negative sizes', () => {
    throws(() => array('u32', {}, 2, -1), /wrong array size/);
  });

  should('array dimensions reject unsafe total size', () => {
    throws(() => array('u8', {}, Number.MAX_SAFE_INTEGER, 2), /wrong array size/);
  });

  should('symbolic reshape casts keep dynamic dimensions', () => {
    const mod = new Module('symbolic_reshape_cast');
    mod.mem('buffer', array('u32', {}, 64, 4));
    mod.fn('run', ['u32', 'u32'], 'void', (f, p, max) => {
      const view = f.memory.buffer.reshape(p, max, 4)[p].as('u64x2').reshape(max);
      view[0].get();
    });
    toMod(mod);
  });

  should('runtime reshape keeps dynamic zero-valued dimensions symbolic', () => {
    const mod = new Module('runtime_dynamic_reshape')
      .mem('buffer', array('u32', {}, 64, 4))
      .fn('run', ['u32', 'u32'], 'u32', (f, p, max) => {
        const { u32 } = f.types;
        f.memory.buffer.reshape(p, max, 4)[p];
        return u32.const(7);
      });
    const typeMod = exec(toJs(genRuntimeTypeMod(), TYPE_MOD_OPTS));
    deepStrictEqual(toRuntime(() => typeMod, mod)().run(0, 16), 7);
  });

  should('reshape dimensions are positive safe integers', () => {
    const mod = new Module('negative_reshape');
    mod.mem('buf', array('u8', {}, 4));
    mod.fn('bad', [], 'void', (f) => {
      f.memory.buf.reshape(-1, -4);
    });
    throws(() => toMod(mod, { optimize: false }), /wrong reshape dimension/);
  });

  should('reshape symbolic dimensions are integer expressions', () => {
    const mod = new Module('float_reshape');
    mod.mem('buf', array('u8', {}, 4));
    mod.fn('bad', ['f32'], 'void', (f, x) => {
      f.memory.buf.reshape(x as any);
    });
    throws(() => toMod(mod, { optimize: false }), /wrong reshape dimension/);
  });

  should('reshape dimensions reject non-expression values', () => {
    const mod = new Module('string_reshape');
    mod.mem('buf', array('u8', {}, 4));
    mod.fn('bad', [], 'void', (f) => {
      f.memory.buf.reshape('4' as any);
    });
    throws(() => toMod(mod, { optimize: false }), /wrong reshape dimension/);
  });

  should('statically unaligned scalar atomics are rejected', () => {
    const mod = new Module('atomic_align');
    mod.mem('mem', struct({ pad: scalar('u8'), x: scalar('u32', { align: 1 }) }));
    mod.fn('test', [], 'void', (f) => {
      const { u32 } = f.types;
      f.memory.mem.x.atomics.add(u32.const(1));
    });
    throws(() => toMod(mod, { useThreads: true }), /unaligned atomic/);
  });

  should('JS atomics reject unaligned effective addresses', () => {
    const run = (instructions: any[], outputs: string[] = ['i32']) => {
      const mod = {
        memory: { size: 1024, maximum: 1024, shared: true, export: true },
        functions: [{ name: 'run', export: true, inputs: [], outputs, locals: [], instructions }],
      };
      return exec(wrapModule(mod as any, createJS(mod as any), {})).run;
    };
    throws(
      () =>
        run([
          { TAG: 'i32.const', data: 1n },
          { TAG: 'i32.atomic.load', data: { align: 2, offset: 0 } },
          { TAG: 'end' },
        ])(),
      /unaligned atomic access/
    );
    throws(
      () =>
        run([
          { TAG: 'i32.const', data: 1n },
          { TAG: 'i32.atomic.load16_u', data: { align: 1, offset: 0 } },
          { TAG: 'end' },
        ])(),
      /unaligned atomic access/
    );
    throws(
      () =>
        run(
          [
            { TAG: 'i32.const', data: 1n },
            { TAG: 'i32.const', data: 7n },
            { TAG: 'i32.atomic.store', data: { align: 2, offset: 0 } },
            { TAG: 'end' },
          ],
          []
        )(),
      /unaligned atomic access/
    );
    deepStrictEqual(
      run([
        { TAG: 'i32.const', data: 1n },
        { TAG: 'i32.atomic.load8_u', data: { align: 0, offset: 0 } },
        { TAG: 'end' },
      ])(),
      0
    );
  });

  should('JS integer memory fast paths handle unaligned effective addresses', () => {
    const fn = (name: string, instructions: any[]) => ({
      name,
      export: true,
      inputs: ['i32'],
      outputs: ['i32'],
      locals: [],
      instructions,
    });
    const mod = {
      memory: { size: 65536, export: true },
      functions: [
        fn('dynamicLoad32', [
          { TAG: 'i32.const', data: 0n },
          { TAG: 'i32.const', data: 0x11223344n },
          { TAG: 'i32.store', data: { align: 2, offset: 0 } },
          { TAG: 'local.get', data: 0n },
          { TAG: 'i32.load', data: { align: 2, offset: 0 } },
          { TAG: 'end' },
        ]),
        fn('load32', [
          { TAG: 'i32.const', data: 0n },
          { TAG: 'i32.const', data: 0x11223344n },
          { TAG: 'i32.store', data: { align: 2, offset: 0 } },
          { TAG: 'i32.const', data: 1n },
          { TAG: 'i32.load', data: { align: 2, offset: 0 } },
          { TAG: 'end' },
        ]),
        fn('load16', [
          { TAG: 'i32.const', data: 0n },
          { TAG: 'i32.const', data: 0x11223344n },
          { TAG: 'i32.store', data: { align: 2, offset: 0 } },
          { TAG: 'i32.const', data: 1n },
          { TAG: 'i32.load16_u', data: { align: 1, offset: 0 } },
          { TAG: 'end' },
        ]),
        fn('store32', [
          { TAG: 'i32.const', data: 0n },
          { TAG: 'i32.const', data: 0n },
          { TAG: 'i32.store', data: { align: 2, offset: 0 } },
          { TAG: 'i32.const', data: 1n },
          { TAG: 'i32.const', data: 0x11223344n },
          { TAG: 'i32.store', data: { align: 2, offset: 0 } },
          { TAG: 'i32.const', data: 1n },
          { TAG: 'i32.load', data: { align: 0, offset: 0 } },
          { TAG: 'end' },
        ]),
        fn('dynamicStore32', [
          { TAG: 'i32.const', data: 0n },
          { TAG: 'i32.const', data: 0n },
          { TAG: 'i32.store', data: { align: 2, offset: 0 } },
          { TAG: 'local.get', data: 0n },
          { TAG: 'i32.const', data: 0x11223344n },
          { TAG: 'i32.store', data: { align: 2, offset: 0 } },
          { TAG: 'i32.const', data: 1n },
          { TAG: 'i32.load', data: { align: 0, offset: 0 } },
          { TAG: 'end' },
        ]),
        fn('store16', [
          { TAG: 'i32.const', data: 0n },
          { TAG: 'i32.const', data: 0n },
          { TAG: 'i32.store', data: { align: 2, offset: 0 } },
          { TAG: 'i32.const', data: 1n },
          { TAG: 'i32.const', data: 0x3344n },
          { TAG: 'i32.store16', data: { align: 1, offset: 0 } },
          { TAG: 'i32.const', data: 1n },
          { TAG: 'i32.load16_u', data: { align: 0, offset: 0 } },
          { TAG: 'end' },
        ]),
      ],
    };
    const native = exec(
      wrapModule(mod as any, wrapWASM(mod as any, wasm.createWasm(mod as any)), {})
    );
    const generated = exec(wrapModule(mod as any, createJS(mod as any), {}));
    deepStrictEqual(
      {
        native: [
          native.dynamicLoad32(1),
          native.load32(0),
          native.load16(0),
          native.store32(0),
          native.dynamicStore32(1),
          native.store16(0),
        ],
        generated: [
          generated.dynamicLoad32(1),
          generated.load32(0),
          generated.load16(0),
          generated.store32(0),
          generated.dynamicStore32(1),
          generated.store16(0),
        ],
      },
      {
        native: [0x00112233, 0x00112233, 0x2233, 0x11223344, 0x11223344, 0x3344],
        generated: [0x00112233, 0x00112233, 0x2233, 0x11223344, 0x11223344, 0x3344],
      }
    );
  });

  should('JS f32.sqrt rounds results to binary32', () => {
    const mod = {
      functions: [
        {
          name: 'run',
          export: true,
          inputs: [],
          outputs: ['f32'],
          locals: [],
          instructions: [{ TAG: 'f32.const', data: 2 }, { TAG: 'f32.sqrt' }, { TAG: 'end' }],
        },
      ],
    };
    const native = exec(
      wrapModule(mod as any, wrapWASM(mod as any, wasm.createWasm(mod as any)), {})
    );
    const generated = exec(wrapModule(mod as any, createJS(mod as any), {}));
    deepStrictEqual(
      { native: native.run(), generated: generated.run() },
      { native: Math.fround(Math.sqrt(2)), generated: Math.fround(Math.sqrt(2)) }
    );
  });

  should('JS fallback i32.load keeps signed i32 shape', () => {
    const mod = {
      memory: { size: 65536, export: true },
      functions: [
        {
          name: 'run',
          export: true,
          inputs: ['i32'],
          outputs: ['i32'],
          locals: [],
          instructions: [
            { TAG: 'i32.const', data: 0n },
            { TAG: 'i32.const', data: -1n },
            { TAG: 'i32.store', data: { align: 2, offset: 0 } },
            { TAG: 'local.get', data: 0n },
            { TAG: 'i32.load', data: { align: 0, offset: 0 } },
            { TAG: 'end' },
          ],
        },
      ],
    };
    const native = exec(
      wrapModule(mod as any, wrapWASM(mod as any, wasm.createWasm(mod as any)), {})
    );
    const generated = exec(wrapModule(mod as any, createJS(mod as any), {}));
    deepStrictEqual(
      { native: native.run(0), generated: generated.run(0) },
      { native: -1, generated: -1 }
    );
  });

  should('JS memory addresses and offsets use unsigned wasm32 arithmetic', () => {
    const fn = (name: string, instructions: any[]) => ({
      name,
      export: true,
      inputs: [],
      outputs: ['i32'],
      locals: [],
      instructions,
    });
    const mod = {
      memory: { size: 0, import: true },
      functions: [
        fn('dynamicAddress', [
          { TAG: 'i32.const', data: -2147483648n },
          { TAG: 'i32.load8_u', data: { align: 0, offset: 0 } },
          { TAG: 'end' },
        ]),
        fn('staticOffset', [
          { TAG: 'i32.const', data: 0n },
          { TAG: 'i32.load8_u', data: { align: 0, offset: 0x80000000 } },
          { TAG: 'end' },
        ]),
        fn('computedAddress', [
          { TAG: 'i32.const', data: 1n },
          { TAG: 'i32.const', data: 2147483647n },
          { TAG: 'i32.add' },
          { TAG: 'i32.load8_u', data: { align: 0, offset: 0 } },
          { TAG: 'end' },
        ]),
      ],
    };
    const memory = new WebAssembly.Memory({ initial: 32769 });
    new Uint8Array(memory.buffer)[0x80000000] = 77;
    const imports = { env: { _memory: memory } };
    const native = exec(
      wrapModule(mod as any, wrapWASM(mod as any, wasm.createWasm(mod as any)), {}),
      imports
    );
    const generated = exec(wrapModule(mod as any, createJS(mod as any), {}), imports);
    deepStrictEqual(
      {
        native: [native.dynamicAddress(), native.staticOffset(), native.computedAddress()],
        generated: [
          generated.dynamicAddress(),
          generated.staticOffset(),
          generated.computedAddress(),
        ],
      },
      { native: [77, 77, 77], generated: [77, 77, 77] }
    );
  });

  should('JS bulk memory ops use unsigned wasm32 addresses', () => {
    const fn = (name: string, instructions: any[]) => ({
      name,
      export: true,
      inputs: [],
      outputs: ['i32'],
      locals: [],
      instructions,
    });
    const mod = {
      memory: { size: 0, import: true },
      functions: [
        fn('fillHigh', [
          { TAG: 'i32.const', data: -2147483648n },
          { TAG: 'i32.const', data: 91n },
          { TAG: 'i32.const', data: 1n },
          { TAG: 'memory.fill', data: 0 },
          { TAG: 'i32.const', data: -2147483648n },
          { TAG: 'i32.load8_u', data: { align: 0, offset: 0 } },
          { TAG: 'end' },
        ]),
        fn('copyHigh', [
          { TAG: 'i32.const', data: -2147483647n },
          { TAG: 'i32.const', data: -2147483648n },
          { TAG: 'i32.const', data: 1n },
          { TAG: 'memory.copy', data: { dst: 0, src: 0 } },
          { TAG: 'i32.const', data: -2147483647n },
          { TAG: 'i32.load8_u', data: { align: 0, offset: 0 } },
          { TAG: 'end' },
        ]),
      ],
    };
    const run = (code: string, name: 'fillHigh' | 'copyHigh') => {
      const memory = new WebAssembly.Memory({ initial: 32769 });
      new Uint8Array(memory.buffer)[0x80000000] = 77;
      return exec(wrapModule(mod as any, code, {}), { env: { _memory: memory } })[name]();
    };
    const native = wrapWASM(mod as any, wasm.createWasm(mod as any), {});
    const generated = createJS(mod as any);
    deepStrictEqual(
      {
        native: [run(native, 'fillHigh'), run(native, 'copyHigh')],
        generated: [run(generated, 'fillHigh'), run(generated, 'copyHigh')],
      },
      { native: [91, 77], generated: [91, 77] }
    );
  });

  should('checkFn sees leading call memory barriers', () => {
    const mod = new Module('checkfn_call_barrier')
      .mem('mem', array('u32', {}, 1))
      .importFn('touch', [], 'void')
      .fn('read_after_call', [], 'u32', (f) => {
        f.functions.touch.call();
        const load = f.memory.mem[0].get();
        f.rawFn.ops.get(load.idx).opts.strong = [];
        return load;
      });
    throws(() => toMod(mod, { optimize: false }), /strong link|missing link/);
  });

  should('custom import modules are honored by JS and Wasm outputs', () => {
    const mod = new Module('custom_import')
      .importFn('inc', ['u32'], 'u32', undefined, 'custom')
      .fn('run', ['u32'], 'u32', (f, x) => f.functions.inc.call(x));
    const imports = { custom: { inc: (x: number) => x + 1 } };
    deepStrictEqual(exec(toJs(mod), imports).run(41), 42);
    deepStrictEqual(exec(toWasm(mod), imports).run(41), 42);
  });

  should('embedded custom imports merge with provided custom imports', () => {
    const mod = new Module('custom_import_mixed')
      .importFn('inc', ['u32'], 'u32', (x) => x + 1, 'custom')
      .importFn('dbl', ['u32'], 'u32', undefined, 'custom')
      .fn('run', ['u32'], 'u32', (f, x) => {
        const { u32 } = f.types;
        return u32.add(f.functions.inc.call(x)[0], f.functions.dbl.call(x)[0]);
      });
    const imports = { custom: { dbl: (x: number) => x * 2 } };
    deepStrictEqual(exec(toJs(mod), imports).run(10), 31);
    deepStrictEqual(exec(toWasm(mod), imports).run(10), 31);
  });

  should('f64 constants preserve double precision', () => {
    const value = Math.PI;
    const mod = new Module('f64_precision').fn('run', [], 'f64', (f) => f.types.f64.const(value));
    deepStrictEqual(exec(toWasm(mod)).run(), value);
  });

  should('jsStateArray preserves signed i32 returns', () => {
    const mod = new Module('state_array_i32').fn('id', ['i32'], 'i32', (_f, x) => x);
    deepStrictEqual(exec(toJs(mod, { jsStateArray: true })).id(-1), -1);
  });

  should('jsStateArray preserves f32 and f64 state', () => {
    const f32 = new Module('state_array_f32').fn('id', ['f32'], 'f32', (_f, x) => x);
    const f64 = new Module('state_array_f64').fn('id', ['f64'], 'f64', (_f, x) => x);
    deepStrictEqual(exec(toJs(f32, { jsStateArray: true })).id(1.1), exec(toWasm(f32)).id(1.1));
    deepStrictEqual(exec(toJs(f64, { jsStateArray: true })).id(1.5), exec(toWasm(f64)).id(1.5));
  });

  should('jsStateArray output is deterministic across createJS calls', () => {
    const mod = new Module('state_array_deterministic').fn('id', ['i32'], 'i32', (_f, x) => x);
    deepStrictEqual(toJs(mod, { jsStateArray: true }), toJs(mod, { jsStateArray: true }));
  });

  should('runtime SIMD shuffle matches generated JS', () => {
    const mod = new Module('runtime_shuffle').fn('lanes', [], ['u32', 'u32', 'u32', 'u32'], (f) => {
      const { u32x4 } = f.types;
      const src = u32x4.laneOffsets();
      const out = u32x4.shuffle(src, src, [12, 13, 14, 15, 8, 9, 10, 11, 4, 5, 6, 7, 0, 1, 2, 3]);
      return Array.from({ length: 4 }, (_, lane) => u32x4.extractLane(out, lane));
    });
    const expected = exec(toJs(mod, { noRuntime: true } as any)).lanes();
    const typeMod = exec(toJs(genRuntimeTypeMod(), TYPE_MOD_OPTS));
    deepStrictEqual(toRuntime(() => typeMod, mod)().lanes(), expected);
  });

  should('runtime doN labeled break strips internal counter like generated JS', () => {
    const mod = new Module('runtime_doN_label_break').fn('run', [], ['u32', 'u32'], (f) => {
      const { u32 } = f.types;
      const [sum, count] = f.doN(
        [u32.const(0), u32.const(0)],
        5,
        (i, sum, count) => {
          const nextSum = u32.add(sum, i);
          const nextCount = u32.add(count, u32.const(1));
          f.brIf('scan', u32.eq(i, u32.const(3)), i, nextSum, nextCount);
          return [nextSum, nextCount];
        },
        'scan'
      );
      return [sum, count];
    });
    const expected = exec(toJs(mod, { noRuntime: true } as any)).run();
    const typeMod = exec(toJs(genRuntimeTypeMod(), TYPE_MOD_OPTS));
    deepStrictEqual(toRuntime(() => typeMod, mod)().run(), expected);
  });

  should('runtime ifElse treats void branch as empty state', () => {
    const mod = new Module('runtime_ifElse_void_state').fn('run', [], 'u32', (f) => {
      const { u32 } = f.types;
      const out = f.ifElse(u32.const(1), [], () => {});
      return u32.const(out.length);
    });
    const expected = exec(toJs(mod, { noRuntime: true } as any)).run();
    const typeMod = exec(toJs(genRuntimeTypeMod(), TYPE_MOD_OPTS));
    deepStrictEqual(toRuntime(() => typeMod, mod)().run(), expected);
  });

  should('runtime memOps executes scalar atomic store/load', () => {
    const mod = new Module('runtime_memops_atomics')
      .mem('state', struct({ value: 'u32' }))
      .fn('run', [], 'u32', (f) => {
        const { u32 } = f.types;
        f.memory.state.value.atomics.store(u32.const(7));
        return f.memory.state.value.atomics.load();
      });
    const expected = exec(toJs(mod, { useThreads: true } as any)).run();
    const typeMod = exec(toJs(genRuntimeTypeMod(), TYPE_MOD_OPTS));
    deepStrictEqual(toRuntime(() => typeMod, mod, { useThreads: true } as any)().run(), expected);
  });

  should('runtime does not export imported helper functions', () => {
    const mod = new Module('runtime_import_export_shape')
      .importFn('inc', ['u32'], 'u32', (x: number) => x + 1)
      .fn('run', ['u32'], 'u32', (f, x) => {
        const [y] = f.functions.inc.call(x);
        return y;
      });
    const typeMod = exec(toJs(genRuntimeTypeMod(), TYPE_MOD_OPTS));
    const runtime = toRuntime(() => typeMod, mod)();
    deepStrictEqual(runtime.run(41), 42);
    deepStrictEqual(Object.keys(runtime).sort(), ['memory', 'run', 'segments']);
  });

  should('runtime SIMD shifts pass scalar shift arguments', () => {
    const coder = TypeCoders.u32x4;
    const input = coder.encode([1, 2, 0x8000_0000, 0xffff_ffff]);
    const mod = new Module('runtime_simd_shifts').mem('state', struct({ A: 'u32x4', D: 'u32x4' }));
    for (const op of ['shl', 'shr', 'rotl', 'rotr'] as const) {
      mod.fn(op, ['i32'], 'void', (f, shift) => {
        const { u32x4 } = f.types;
        const { A, D } = f.memory.state;
        D.set((u32x4 as any)[op](A.get(), shift));
      });
    }
    const native = exec(toWasm(mod, { optimize: false }));
    const runtime = genRuntimeTypes().u32x4;
    for (const [op, shift] of [
      ['shl', 1],
      ['shr', 1],
      ['rotl', 7],
      ['rotr', 7],
    ] as const) {
      native.segments['state.A'].set(input);
      native[op](shift);
      deepStrictEqual(
        { op, shift, lanes: coder.decode(runtime[op](input, shift)) },
        { op, shift, lanes: coder.decode(native.segments['state.D']) }
      );
    }
  });

  should('SIMD lane immediates reject out-of-range lanes', () => {
    const rawShuffle = (lane: number) => ({
      functions: [
        {
          name: 's',
          export: true,
          inputs: [],
          outputs: ['i32'],
          locals: [],
          instructions: [
            { TAG: 'v128.const', data: 0n },
            { TAG: 'v128.const', data: 0n },
            {
              TAG: 'i8x16.shuffle',
              data: [lane, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15],
            },
            { TAG: 'i8x16.extract_lane_u', data: 0 },
            { TAG: 'end', data: undefined },
          ],
        },
      ],
    });
    const rawExtract = (lane: number) => ({
      functions: [
        {
          name: 'e',
          export: true,
          inputs: [],
          outputs: ['i32'],
          locals: [],
          instructions: [
            { TAG: 'v128.const', data: 0n },
            { TAG: 'i32x4.extract_lane', data: lane },
            { TAG: 'end', data: undefined },
          ],
        },
      ],
    });
    const rawLaneMem = (tag: string, lane: number) => ({
      memory: { export: true, size: 65_536 },
      functions: [
        {
          name: 'lane',
          export: true,
          inputs: ['i32'],
          outputs: tag.includes('load') ? ['i32'] : [],
          locals: [],
          instructions: tag.includes('load')
            ? [
                { TAG: 'local.get', data: 0n },
                { TAG: 'v128.const', data: 0n },
                { TAG: tag, data: { mem: { align: 2n, offset: 0n }, lane } },
                { TAG: 'i32x4.extract_lane', data: 0 },
                { TAG: 'end', data: undefined },
              ]
            : [
                { TAG: 'local.get', data: 0n },
                { TAG: 'v128.const', data: 0n },
                { TAG: tag, data: { mem: { align: 2n, offset: 0n }, lane } },
                { TAG: 'end', data: undefined },
              ],
        },
      ],
    });
    deepStrictEqual(WebAssembly.validate(wasm.createWasm(rawShuffle(31) as any)), true);
    deepStrictEqual(WebAssembly.validate(wasm.createWasm(rawExtract(3) as any)), true);
    deepStrictEqual(
      WebAssembly.validate(wasm.createWasm(rawLaneMem('v128.load32_lane', 3) as any)),
      true
    );
    deepStrictEqual(
      WebAssembly.validate(wasm.createWasm(rawLaneMem('v128.store32_lane', 3) as any)),
      true
    );
    throws(() => wasm.createWasm(rawShuffle(32) as any), /lane|range|invalid/i);
    throws(() => wasm.createWasm(rawExtract(4) as any), /lane|range|invalid/i);
    throws(() => wasm.createWasm(rawLaneMem('v128.load32_lane', 4) as any), /lane|range|invalid/i);
    throws(() => wasm.createWasm(rawLaneMem('v128.store32_lane', 4) as any), /lane|range|invalid/i);
    const badExtract = new Module('bad_extract_lane').fn('run', [], 'u32', (f) => {
      const { u32x4 } = f.types;
      return [u32x4.extractLane(u32x4.const(0), 4)];
    });
    const badReplace = new Module('bad_replace_lane').fn('run', [], 'u32x4', (f) => {
      const { u32, u32x4 } = f.types;
      return [u32x4.replaceLane(u32x4.const(0), 4, u32.const(1))];
    });
    throws(() => toMod(badExtract, { optimize: false }), /lane|range|invalid/i);
    throws(() => toMod(badReplace, { optimize: false }), /lane|range|invalid/i);
    const runtime = genRuntimeTypes().u32x4;
    throws(() => runtime.extractLane([0, 1, 2, 3], 4), /lane|range|invalid/i);
    throws(() => runtime.replaceLane([0, 1, 2, 3], 4, 9), /lane|range|invalid/i);
  });

  should('optimizer preserves NaN for floating multiply by zero', () => {
    const mod = new Module('float_mul_zero')
      .fn('f32', ['f32'], 'f32', (f, x) => f.types.f32.mul(x, f.types.f32.const(0)))
      .fn('f64', ['f64'], 'f64', (f, x) => f.types.f64.mul(x, f.types.f64.const(0)))
      .fn('f32x4', ['f32'], 'f32', (f, x) => {
        const { f32x4 } = f.types;
        return [f32x4.extractLane(f32x4.mul(f32x4.splat(x), f32x4.const(0)), 0)];
      })
      .fn('f64x2', ['f64'], 'f64', (f, x) => {
        const { f64x2 } = f.types;
        return [f64x2.extractLane(f64x2.mul(f64x2.splat(x), f64x2.const(0)), 0)];
      });
    const native = exec(toWasm(mod, { optimize: false }));
    const optimized = exec(toJs(mod, { optimize: true, noRuntime: true } as any));
    deepStrictEqual(
      {
        native: [
          native.f32(Number.NaN),
          native.f64(Number.NaN),
          native.f32x4(Number.NaN),
          native.f64x2(Number.NaN),
        ],
        optimized: [
          optimized.f32(Number.NaN),
          optimized.f64(Number.NaN),
          optimized.f32x4(Number.NaN),
          optimized.f64x2(Number.NaN),
        ],
      },
      {
        native: [Number.NaN, Number.NaN, Number.NaN, Number.NaN],
        optimized: [Number.NaN, Number.NaN, Number.NaN, Number.NaN],
      }
    );
  });

  should('lowerPatternJS validates and reads scalar pattern bytes across args', () => {
    const invalid = new Module('lower_pattern_js_oob').fn('run', ['u32'], 'u32', (f, x) => {
      const out = (f as any).rawFn.op('u32', 'pattern', [x], { pattern: [0, 1, 2, 4] });
      return [out];
    });
    throws(
      () => toJs(invalid, { lowerPattern: false, lowerPatternJS: true, noRuntime: true } as any),
      /pattern/i
    );
    const valid = new Module('lower_pattern_js_multi_arg').fn('run', [], 'u32', (f) => {
      const { u32 } = f.types;
      const a = u32.const(0x03020100);
      const b = u32.const(0x07060504);
      const out = (f as any).rawFn.op('u32', 'pattern', [a, b], { pattern: [0, 1, 4, 5] });
      return [out];
    });
    deepStrictEqual(
      exec(
        toJs(valid, { lowerPattern: false, lowerPatternJS: true, noRuntime: true } as any)
      ).run(),
      0x05040100
    );
  });

  should('lowerSIMD preserves partial bitselect masks', () => {
    const mod = new Module('simd_bitselect_mask').fn('lane0', [], 'i32', (f) => {
      const { i32x4 } = f.types;
      const a = i32x4.const(-1_431_655_766);
      const b = i32x4.const(1_431_655_765);
      const mask = i32x4.const(0x0f0f0f0f);
      const out = (f as any).rawFn.op('i32x4', 'bitselect', [a, b, mask]);
      return [i32x4.extractLane(out, 0)];
    });
    deepStrictEqual(
      exec(toJs(mod, { optimize: false, noRuntime: true } as any)).lane0(),
      exec(toWasm(mod, { optimize: false })).lane0()
    );
  });

  should('lowerSIMD supports i32x4 to i64x2 extension', () => {
    const mod = new Module('simd_i32x4_extend')
      .fn('signed', [], ['u32', 'u32', 'u32', 'u32'], (f) => {
        const { i32, i32x4, i64, i64x2 } = f.types;
        const vec = i32x4.replaceLane(
          i32x4.replaceLane(i32x4.const(1), 0, i32.const(-1)),
          2,
          i32.const(-2)
        );
        const [low, high] = i32x4.to('i64x2', vec);
        const lowParts = i64.to('u32', i64x2.extractLane(low, 0));
        const highParts = i64.to('u32', i64x2.extractLane(high, 0));
        return [lowParts[0], lowParts[1], highParts[0], highParts[1]];
      })
      .fn('unsigned', [], ['u32', 'u32', 'u32', 'u32'], (f) => {
        const { u32, u32x4, u64, u64x2 } = f.types;
        const vec = u32x4.replaceLane(
          u32x4.replaceLane(u32x4.const(1), 0, u32.const(0xffff_ffff)),
          2,
          u32.const(0x8000_0000)
        );
        const [low, high] = u32x4.to('u64x2', vec);
        const lowParts = u64.to('u32', u64x2.extractLane(low, 0));
        const highParts = u64.to('u32', u64x2.extractLane(high, 0));
        return [lowParts[0], lowParts[1], highParts[0], highParts[1]];
      });
    // Multi-value i32/u32 returns are JS i32-shaped here; signed words still verify the high halves.
    const expected = {
      signed: [-1, -1, -2, -1],
      unsigned: [-1, 0, -0x8000_0000, 0],
    };
    const native = exec(toWasm(mod, { optimize: false }));
    const lowered = exec(toJs(mod, { optimize: false, noRuntime: true } as any));
    deepStrictEqual({ signed: native.signed(), unsigned: native.unsigned() }, expected);
    deepStrictEqual({ signed: lowered.signed(), unsigned: lowered.unsigned() }, expected);
  });

  should('lowerSIMD supports i32x4 to i64x2 extmul', () => {
    const mod = new Module('simd_i32x4_extmul')
      .fn('lowUnsigned', [], ['u32', 'u32'], (f) => {
        const { u32, u32x4, u64, u64x2 } = f.types;
        const a = u32x4.replaceLane(u32x4.const(2), 1, u32.const(0xffff_ffff));
        const b = u32x4.replaceLane(u32x4.const(3), 1, u32.const(2));
        const out = (f as any).rawFn.op('u64x2', 'extmul_low_i32x4_u', [a, b]);
        return u64.to('u32', u64x2.extractLane(out, 1));
      })
      .fn('highSigned', [], ['u32', 'u32'], (f) => {
        const { i32, i32x4, i64, i64x2 } = f.types;
        const a = i32x4.replaceLane(i32x4.const(1), 2, i32.const(-2));
        const b = i32x4.replaceLane(i32x4.const(1), 2, i32.const(3));
        const out = (f as any).rawFn.op('i64x2', 'extmul_high_i32x4_s', [a, b]);
        return i64.to('u32', i64x2.extractLane(out, 0));
      });
    const expected = { lowUnsigned: [-2, 1], highSigned: [-6, -1] };
    const native = exec(toWasm(mod, { optimize: false }));
    const lowered = exec(toJs(mod, { optimize: false, noRuntime: true } as any));
    deepStrictEqual(
      { lowUnsigned: native.lowUnsigned(), highSigned: native.highSigned() },
      expected
    );
    deepStrictEqual(
      { lowUnsigned: lowered.lowUnsigned(), highSigned: lowered.highSigned() },
      expected
    );
  });

  should('lowerSmallInt normalizes imported small-int call results', () => {
    const mod = new Module('small_import_result')
      .importFn('byte', [], 'u8', () => 0x1ff)
      .fn('local', [], 'u8', (f) => [f.types.u8.fromN('u32', f.types.u32.const(0x1ff))])
      .fn('run', [], 'u8', (f) => f.functions.byte.call()[0]);
    const out = exec(toJs(mod, { optimize: false, noRuntime: true }));
    deepStrictEqual(out.local(), 0xff);
    deepStrictEqual(out.run(), 0xff);
  });

  should('lowerU64Arg handles imported u64 call arguments', () => {
    const mod = new Module('lower_u64_arg_import')
      .importFn('sink', ['u64'], 'void')
      .fn('run', ['u64'], 'void', (f, x) => {
        f.functions.sink.call(x);
      });
    for (const compile of [toJs, toWasm]) {
      const calls: number[][] = [];
      const out = exec(compile(mod, { lowerU64Arg: true, noRuntime: true } as any), {
        env: { sink: (lo: number, hi: number) => calls.push([lo, hi]) },
      });
      out.run(2, 1);
      deepStrictEqual(calls, [[2, 1]]);
    }
  });

  should('lowerU64Arg preserves mixed outputs after wide outputs', () => {
    const mod = new Module('lower_u64_arg_mixed_outputs')
      .importFn('impPair', [], ['u64', 'u32'])
      .fn('pair', [], ['u64', 'u32'], (f) => {
        const { u32, u64 } = f.types;
        return [u64.fromN('u32', [u32.const(5), u32.const(6)]), u32.const(7)];
      })
      .fn('run', [], ['u32', 'u32', 'u32'], (f) => {
        const { u64 } = f.types;
        const [wide, tail] = f.functions.pair.call();
        const parts = u64.to('u32', wide);
        return [parts[0], parts[1], tail];
      })
      .fn('runImport', [], ['u32', 'u32', 'u32'], (f) => {
        const { u64 } = f.types;
        const [wide, tail] = f.functions.impPair.call();
        const parts = u64.to('u32', wide);
        return [parts[0], parts[1], tail];
      });
    for (const compile of [toJs, toWasm]) {
      const out = exec(compile(mod, { lowerU64Arg: true, noRuntime: true } as any), {
        env: { impPair: () => [9, 10, 11] },
      });
      deepStrictEqual(out.run(), [5, 6, 7]);
      deepStrictEqual(out.runImport(), [9, 10, 11]);
    }
  });

  should('lowerVirtualSIMDMask loads only active lanes', () => {
    const mod = new Module('virtual_mask_load_width')
      .mem('buf', array('u32', {}, 16_384))
      .fn('scalar', [], ['u32', 'u32'], (f) => {
        const src = f.memory.buf.range(16_382, 2).get();
        return [src[0], src[1]];
      })
      .fn('masked', [], ['u32', 'u32'], (f) => {
        const { u32x2 } = f.types;
        const [src] = f.memory.buf.range(16_382, 2).as('u32x2').get();
        return [u32x2.extractLane(src, 0), u32x2.extractLane(src, 1)];
      });
    for (const compile of [toJs, toWasm]) {
      const out = exec(compile(mod, { optimize: false, noRuntime: true } as any));
      const buf = new Uint32Array(
        out.segments.buf.buffer,
        out.segments.buf.byteOffset,
        out.segments.buf.byteLength / 4
      );
      buf.set([1, 2], 16_382);
      deepStrictEqual(out.scalar(), [1, 2]);
      deepStrictEqual(out.masked(), [1, 2]);
    }
  });

  should('lowerVirtualSIMDPairs lowers lane shuffles across native parts', () => {
    const expect = (lanes: number, rhsOffset: number, pattern: number[]) =>
      pattern.map((lane) => (lane < lanes ? lane : rhsOffset + lane - lanes));
    const u32x8Pat = [7, 0, 8, 15, 3, 12, 4, 11];
    const u32x16Pat = [31, 0, 22, 9, 16, 15, 24, 7, 8, 23, 14, 17, 30, 1, 20, 11];
    const f64x4Pat = [5, 0, 3, 4];
    const mod = new Module('virtual_pair_shuffle')
      .fn('u32x8', [], new Array(8).fill('u32') as any, (f) => {
        const { u32x8 } = f.types;
        const out = u32x8.shuffleLanes(u32x8.laneOffsets(), u32x8.laneOffsets(100), u32x8Pat);
        return Array.from({ length: 8 }, (_, lane) => u32x8.extractLane(out, lane));
      })
      .fn('u32x16', [], new Array(16).fill('u32') as any, (f) => {
        const { u32x16 } = f.types;
        const out = u32x16.shuffleLanes(u32x16.laneOffsets(), u32x16.laneOffsets(100), u32x16Pat);
        return Array.from({ length: 16 }, (_, lane) => u32x16.extractLane(out, lane));
      })
      .fn('f64x4', [], new Array(4).fill('f64') as any, (f) => {
        const { f64x4 } = f.types;
        const out = f64x4.shuffleLanes(f64x4.laneOffsets(), f64x4.laneOffsets(100), f64x4Pat);
        return Array.from({ length: 4 }, (_, lane) => f64x4.extractLane(out, lane));
      });
    const expected = {
      u32x8: expect(8, 100, u32x8Pat),
      u32x16: expect(16, 100, u32x16Pat),
      f64x4: expect(4, 100, f64x4Pat),
    };
    for (const compile of [toJs, toWasm]) {
      const out = exec(compile(mod, { optimize: false, noRuntime: true } as any));
      deepStrictEqual({ u32x8: out.u32x8(), u32x16: out.u32x16(), f64x4: out.f64x4() }, expected);
    }
  });

  should('JS output rejects memory.grow because memory views are fixed-size', () => {
    throws(
      () =>
        createJS(
          {
            memory: { size: 65536, maximum: 131072, export: true },
            functions: [
              {
                name: 'grow',
                export: true,
                inputs: [],
                outputs: [],
                locals: [],
                instructions: [
                  { TAG: 'i32.const', data: 1n },
                  { TAG: 'memory.grow' },
                  { TAG: 'drop' },
                  { TAG: 'end' },
                ],
              },
            ],
          } as any,
          {}
        ),
      /memory\.grow.*fixed-size memory views/
    );
  });

  should('JS memory.size returns wasm page count', () => {
    const mod = {
      memory: { size: 65537, maximum: 131072, export: true },
      functions: [
        {
          name: 'size',
          export: true,
          inputs: [],
          outputs: ['i32'],
          locals: [],
          instructions: [{ TAG: 'memory.size' }, { TAG: 'end' }],
        },
      ],
    };
    const native = exec(
      wrapModule(mod as any, wrapWASM(mod as any, wasm.createWasm(mod as any)), {})
    );
    const generated = exec(wrapModule(mod as any, createJS(mod as any), {}));
    deepStrictEqual(
      { native: native.size(), generated: generated.size() },
      { native: 2, generated: 2 }
    );
  });

  should('function name memory is reserved for exported module memory', () => {
    throws(() => new Module('reserved').fn('memory', [], 'void', () => {}), /reserved.*memory/);
    throws(() => new Module('reserved').importFn('memory', [], 'void'), /reserved.*memory/);
    throws(
      () => new Module('reserved').batchFn('memory', { lanes: 1 }, [], () => {}),
      /reserved.*memory/
    );
  });

  should('function name segments is reserved for wrapper segment views', () => {
    throws(() => new Module('reserved').fn('segments', [], 'void', () => {}), /reserved.*segments/);
    throws(() => new Module('reserved').importFn('segments', [], 'void'), /reserved.*segments/);
    throws(
      () => new Module('reserved').batchFn('segments', { lanes: 1 }, [], () => {}),
      /reserved.*segments/
    );
  });
});

should.runWhen(import.meta.url);
