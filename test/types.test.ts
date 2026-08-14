import { describe, it } from '@paulmillr/jsbt/test.js';
import * as fc from 'fast-check';
import * as P from 'micro-packed';
import { deepStrictEqual } from 'node:assert';
import { toJs, toWasm } from '../src/codegen.ts';
import * as js from '../src/js.ts';
import { Module, array, struct } from '../src/module.ts';
import { toRuntime } from '../src/runtime.ts';
import * as types from '../src/types.ts';
import { runtimeTypeMod } from './utils.ts';
const SLOW = false; // takes 10 min
const STATIC_SHIFTS = SLOW;
const OPTS = { numRuns: SLOW ? 10_000 : 1_000 };
const SMALL_OPTS = { lowerSmallInt: true };
const ONLY_OP = false; // ['neg'];
const ONLY_TYPE = false; // ['f32', 'f64', 'f32x4', 'f64x4']; //, 'f64', 'f32x4', 'f64x4'];

describe('Types', () => {
  const typeMods = {};
  for (const type of types.TypeName) {
    if (ONLY_TYPE && !ONLY_TYPE.includes(type)) continue;
    const mod = new Module('type_tests_' + type).mem(
      'state',
      struct({
        A: type,
        B: type,
        C: type,
        D: type,
        shift: 'i32',
        RET: type,
        RETMASK: types.maskType(type),
      })
    );
    const genOps = (name, cb) => {
      mod.fn(`${type}_${name}`, [], 'void', (f) => {
        const T = f.types[type];
        const { A, B, C, D, RET, RETMASK, shift } = f.memory.state;
        const R = types.opsCompare.has(name) ? RETMASK : RET;
        R.set(cb(f, ...[A, B, C, D, shift].map((i) => i.get())));
      });
    };
    for (const op of types.opsForType(type)) {
      if (ONLY_OP && !ONLY_OP.includes(op)) continue;
      if (types.opsShifts.has(op)) {
        genOps(op, (f, A, _B, _C, _D, shift) => f.getType(type)[op](A, shift));
        // Static shifts
        if (STATIC_SHIFTS) {
          for (let shift = -128; shift < 128; shift++) {
            genOps(`${op}_${shift < 0 ? 'minus_' : ''}${Math.abs(shift)}`, (f, A) =>
              f.getType(type)[op](A, shift)
            );
          }
        }
      }
      if (types.ops1Arg.has(op)) genOps(op, (f, A) => f.getType(type)[op](A));
      if (types.ops2Arg.has(op)) genOps(op, (f, A, B) => f.getType(type)[op](A, B));
      if (types.opsVariadic.has(op)) {
        genOps(`${op}3`, (f, A, B, C) => f.getType(type)[op](A, B, C));
        genOps(`${op}4`, (f, A, B, C, D) => f.getType(type)[op](A, B, C, D));
      }
    }
    genOps(`select`, (f, A, B, C, D) => {
      const T = f.getType(type);
      return T.select(T.lt(A, B), C, D);
    });
    genOps('laneOffsets0', (f) => f.getType(type).laneOffsets());
    genOps('laneOffsets5', (f) => f.getType(type).laneOffsets(5));
    typeMods[type] = [
      js.exec(toWasm(mod, SMALL_OPTS)),
      js.exec(toJs(mod, SMALL_OPTS)),
      toRuntime(() => runtimeTypeMod, mod, SMALL_OPTS)(),
    ];
  }

  for (const type of types.TypeName) {
    if (ONLY_TYPE && !ONLY_TYPE.includes(type)) continue;
    describe(type, () => {
      const mods = typeMods[type];
      const C = types.TypeCoders[type];
      const Cmask = types.TypeCoders[types.maskType(type)];
      const fcArg = fc.uint8Array({ minLength: C.size, maxLength: C.size });
      const fci32Arg = fc.uint8Array({ minLength: 4, maxLength: 4 });

      function check(name, op, a, b, c, d, shift, checkLanes = true) {
        const res2 = [];
        if (op === 'div' || op === 'rem') {
          const raw = C.decode(b);
          if (raw == 0 || (Array.isArray(raw) && raw.some((i) => i == 0))) return res2; // division by zero
        }
        if (op === 'swapEndianness' && types.FloatType.has(type)) {
          const raw = C.decode(a);
          if (Number.isNaN(raw) || (Array.isArray(raw) && raw.some((i) => Number.isNaN(i))))
            return res2; // NaN cannonicalized
        }
        if (op === 'copysign' && types.FloatType.has(type)) {
          const raw = C.decode(b);
          if (Number.isNaN(raw) || (Array.isArray(raw) && raw.some((i) => Number.isNaN(i))))
            return res2; // NaN cannonicalized (negative nan)
        }
        for (const mod of mods) {
          if (a) mod.segments['state.A'].set(a);
          if (b) mod.segments['state.B'].set(b);
          if (c) mod.segments['state.C'].set(c);
          if (d) mod.segments['state.D'].set(d);
          if (shift) mod.segments['state.shift'].set(shift);
          try {
            mod[`${type}_${name}`]();
          } catch (e) {
            console.error('ERRR', type, op, C.decode(b), C.decode(a), e);
            throw e;
          }
          let res;
          if (types.opsCompare.has(op)) res = Cmask.decode(mod.segments['state.RETMASK']);
          else res = C.decode(mod.segments['state.RET']);
          res2.push(res);
        }
        let exp;
        for (const r of res2) {
          try {
            if (!exp) exp = r;
            else deepStrictEqual(r, exp);
          } catch (e) {
            console.error('-----');
            console.error(
              'ARGS',
              [a, b, c, d].map((i) => (i ? C.decode(i) : i))
            );
            console.error('args raw', [a, b, c, d]);
            console.error('RES2', res2, types.opsCompare.has(op), !types.SIMDType.has(type), op);
            console.error(
              'RES RAW',
              res2.map((i) => (types.opsCompare.has(op) ? Cmask : C).encode(i))
            );

            throw e;
          }
        }
        // Cross-check scalar stuff vs per-lane
        if (types.SIMDType.has(type) && !types.opsCompare.has(op) && checkLanes) {
          const laneType = types.ScalarOf(type);
          const lanes = types.lanesOf(type);
          const Clane = types.TypeCoders[laneType];
          const laneMods = typeMods[laneType];
          const Alanes = a ? C.decode(a) : undefined;
          const Blanes = b ? C.decode(b) : undefined;
          const Clanes = c ? C.decode(c) : undefined;
          const Dlanes = d ? C.decode(d) : undefined;
          for (const mod of laneMods) {
            const res = [];
            for (let i = 0; i < lanes; i++) {
              if (a) mod.segments['state.A'].set(Clane.encode(Alanes[i]));
              if (b) mod.segments['state.B'].set(Clane.encode(Blanes[i]));
              if (c) mod.segments['state.C'].set(Clane.encode(Clanes[i]));
              if (d) mod.segments['state.D'].set(Clane.encode(Dlanes[i]));
              if (shift) mod.segments['state.shift'].set(shift);
              mod[`${laneType}_${name}`]();
              res.push(Clane.decode(mod.segments['state.RET']));
            }
            deepStrictEqual(res, res2[0], 'perLane');
          }
        }
        return res2;
      }
      for (const op of types.opsForType(type)) {
        if (ONLY_OP && !ONLY_OP.includes(op)) continue;
        if (types.opsShifts.has(op)) {
          it(op, () => {
            fc.assert(
              fc.property(fc.tuple(fcArg, fci32Arg), ([a, shift]) => {
                check(op, op, a, undefined, undefined, undefined, shift);
              }),
              OPTS
            );
            if (STATIC_SHIFTS) {
              for (let shift = -128; shift < 128; shift++) {
                const name = `${op}_${shift < 0 ? 'minus_' : ''}${Math.abs(shift)}`;
                fc.assert(
                  fc.property(fc.tuple(fcArg), ([a]) => {
                    // Verify that constant and variable are same
                    const res = check(name, op, a);
                    const exp = check(
                      op,
                      op,
                      a,
                      undefined,
                      undefined,
                      undefined,
                      P.I32LE.encode(shift)
                    );
                    deepStrictEqual(res, exp);
                  }),
                  OPTS
                );
              }
            }
          });
        }
        if (types.ops1Arg.has(op)) {
          it(op, () =>
            fc.assert(
              fc.property(fc.tuple(fcArg), ([a]) => {
                check(op, op, a);
              }),
              OPTS
            )
          );
        }
        if (types.ops2Arg.has(op)) {
          it(op, () =>
            fc.assert(
              fc.property(fc.tuple(fcArg, fcArg), ([a, b]) => {
                check(op, op, a, b);
              }),
              OPTS
            )
          );
        }
        if (types.opsVariadic.has(op)) {
          it(`${op}3`, () =>
            fc.assert(
              fc.property(fc.tuple(fcArg, fcArg, fcArg), ([a, b, c]) => {
                check(`${op}3`, op, a, b, c);
              }),
              OPTS
            ));
          it(`${op}4`, () =>
            fc.assert(
              fc.property(fc.tuple(fcArg, fcArg, fcArg, fcArg), ([a, b, c, d]) => {
                check(`${op}4`, op, a, b, c, d);
              }),
              OPTS
            ));
        }
      }
      it('select', () =>
        fc.assert(
          fc.property(fc.tuple(fcArg, fcArg, fcArg, fcArg), ([a, b, c, d]) => {
            check('select', 'select', a, b, c, d);
          }),
          OPTS
        ));
      it('laneOffsets', () => {
        check(
          'laneOffsets0',
          'laneOffsets',
          undefined,
          undefined,
          undefined,
          undefined,
          undefined,
          false
        );
        check(
          'laneOffsets5',
          'laneOffsets',
          undefined,
          undefined,
          undefined,
          undefined,
          undefined,
          false
        );
      });
      it('shape', () => {
        const shapes = [];
        const mod = new Module('type_tests_' + type)
          .mem('state', array(type, {}, 5))
          .fn('tmp', [], [], (f) => {
            const T = f.getType(type);
            const T2 = f.getTypeGeneric(type);
            const T3 = f.types[type];
            const M1 = f.memory.state;
            const M2 = f.memory.state[0];
            const M3 = f.memory.state.as8();
            shapes.push({
              types: [T, T2, T3].map((i) => Object.keys(i).sort()),
              maskCount: T.maskCount,
              pairCount: T.pairCount,
              memory: [
                M1,
                M2,
                M2.mut,
                Object.keys(M2).includes('atomics') ? M2.atomics : {},
                M3,
              ].map((i) => Object.keys(i).sort()),
              fn: Object.keys(f)
                .filter((i) => i !== 'rawFn')
                .sort(),
            });
          });
        js.exec(toWasm(mod, SMALL_OPTS));
        js.exec(toJs(mod, SMALL_OPTS));
        toRuntime(() => runtimeTypeMod, mod, SMALL_OPTS)().tmp();
        for (let i = 1; i < shapes.length; i++) deepStrictEqual(shapes[i], shapes[0]);
      });
    });
  }
});
it.runWhen(import.meta.url);
