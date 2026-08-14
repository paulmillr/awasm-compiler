import { describe, it } from '@paulmillr/jsbt/test.js';
import { deepStrictEqual } from 'node:assert';
import { toJs, toWasm } from '../src/codegen.ts';
import * as js from '../src/js.ts';
import { Module, array, struct } from '../src/module.ts';
import { genRuntimeTypes } from '../src/types.ts';
import * as utils from '../src/utils.ts';
//import { createRuntime } from '../../src/runtime.ts';
import { bench } from '@paulmillr/jsbt/benchmark.js';
import * as P from 'micro-packed';
import { exec } from '../src/js.ts';
import { WorkerPool, modJs as wpModJS, modWasm as wpModWasm } from './workers.ts';

const runtimeTypes = genRuntimeTypes();

function testBothOpts(...args) {
  const fn = args[args.length - 1];
  const opts = args[args.length - 2];
  const mods = args.slice(0, args.length - 2);
  fn(...mods.map((i) => exec(toWasm(i, opts))));
  fn(...mods.map((i) => exec(toJs(i, opts))));
  //if (!opts.noRuntime) fn(...mods.map((i) => createRuntime(i, opts)));
}

function testBoth(...args) {
  const fn = args[args.length - 1];
  const mods = args.slice(0, args.length - 1);
  return testBothOpts(...mods, {}, fn);
}

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
const BENCH_OPTS = { maxRunTimeSec: 0.1 };

describe('threads', () => {
  it('basic', async () => {
    // NOTE: This is tricky to test, we need to look at performance
    // to verify threads still work since it will work even if threads crashed/failed to start
    //  if (!SLOW) return;
    const mod = new Module('workers')
      // this creates {a,b}[maxBatchSize]
      .batchMem('state', struct({ a: 'u32', b: 'u32' }))
      // array[16]
      .mem('data', array('u32', {}, 20))
      // name, type, inputs, cb: (scope, realType, batchPos, ...arguments)
      // we call batch functions from outside like (batchPos, batchLen, ...args)
      .batchFn('tmp_cmd', { lanes: 4 }, ['u32', 'u32'], (f, lanes, batchPos, a, b) => {
        const type = 'u32';

        const T = f.getType(type, lanes); // use type when memory fixed
        const { data, state } = f.memory;

        // batchPos could be bigger than batchSize in batchMem!
        // const { a: stateA, b: stateB } = state.lanes(lanes)[batchPos];

        // stateA.mut.add(T.fromN('u32', a));
        // stateB.mut.add(T.fromN('u32', b));

        const sum = T.add(
          T.fromN('u32', a),
          T.fromN('u32', b),
          T.fromN('u32', batchPos),
          T.laneOffsets() // since batchPos is just start for simd
        );
        data.lanes(lanes)[batchPos].set(sum);
      });

    // 2 threads instead of 10 -> 380k vs 23

    const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
    const mask = (x) => x.toString(2).padStart(32, '0');
    await sleep(1000);
    const CNT = 16;
    const A = 2;
    const B = 3;

    const check = async (i, name) => {
      try {
        i.segments.data.fill(0);
        i.tmp_cmd(0, CNT, A, B);
        deepStrictEqual(
          utils.u32(i.segments.data),
          new Uint32Array([5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20, 0, 0, 0, 0]),
          `${name}: 0`
        );
        i.segments.data.fill(0);
        i.tmp_cmd(0, CNT, B + 5, B + 8);
        deepStrictEqual(
          utils.u32(i.segments.data),
          new Uint32Array([
            19, 20, 21, 22, 23, 24, 25, 26, 27, 28, 29, 30, 31, 32, 33, 34, 0, 0, 0, 0,
          ]),
          `${name}: 1`
        );
        // -1
        i.segments.data.fill(0);
        i.tmp_cmd(0, CNT - 1, A, B);
        deepStrictEqual(
          utils.u32(i.segments.data),
          new Uint32Array([5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 0, 0, 0, 0, 0]),
          `${name}: 0 -1`
        );
        i.segments.data.fill(0);
        i.tmp_cmd(0, CNT - 1, B + 5, B + 8);
        deepStrictEqual(
          utils.u32(i.segments.data),
          new Uint32Array([
            19, 20, 21, 22, 23, 24, 25, 26, 27, 28, 29, 30, 31, 32, 33, 0, 0, 0, 0, 0,
          ]),
          `${name}: 1 -1`
        );
        // +1
        i.segments.data.fill(0);
        i.tmp_cmd(0, CNT + 1, A, B);
        deepStrictEqual(
          utils.u32(i.segments.data),
          new Uint32Array([5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20, 21, 0, 0, 0]),
          `${name}: 0 +1`
        );
        i.segments.data.fill(0);
        i.tmp_cmd(0, CNT + 1, B + 5, B + 8);
        deepStrictEqual(
          utils.u32(i.segments.data),
          new Uint32Array([
            19, 20, 21, 22, 23, 24, 25, 26, 27, 28, 29, 30, 31, 32, 33, 34, 35, 0, 0, 0,
          ]),
          `${name}: 1 +1`
        );
        // >> 1
        i.segments.data.fill(0);
        i.tmp_cmd(1, CNT, A, B);
        deepStrictEqual(
          utils.u32(i.segments.data),
          new Uint32Array([0, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20, 21, 0, 0, 0]),
          `${name}: 0 >> 1`
        );
        i.segments.data.fill(0);
        i.tmp_cmd(1, CNT, B + 5, B + 8);
        deepStrictEqual(
          utils.u32(i.segments.data),
          new Uint32Array([
            0, 20, 21, 22, 23, 24, 25, 26, 27, 28, 29, 30, 31, 32, 33, 34, 35, 0, 0, 0,
          ]),
          `${name}: 1 >> 1`
        );
      } catch (e) {
        const x = P.array(
          32,
          P.struct({
            online: P.U32LE,
            done: P.U32LE,
            cmd: P.U32LE,
            pos: P.U32LE,
            len: P.U32LE,
          })
        );
        // _worker.workers
        if (i.segments['_worker.workers']) {
          console.error('STATE', x.decode(i.segments['_worker.workers']));
        }
        throw e;
      }
    };
    let STATE;
    const WPJS = new WorkerPool(wpModJS);
    const WP = new WorkerPool(wpModWasm);
    const instances = {
      wasm: toWasm(mod, { useSIMD: false, useThreads: false }),
      wasmS: toWasm(mod, { useSIMD: true, useThreads: false }),
      wasmT: toWasm(mod, { useSIMD: false, useThreads: true }),
      wasmT2: toWasm(mod, { useSIMD: false, useThreads: true, threadWorkStealing: true }),
      wasmST: toWasm(mod, { useSIMD: true, useThreads: true }),
      wasmST_WP: toWasm(mod, { useSIMD: true, useThreads: true }),
      wasmST_WPJS: toWasm(mod, { useSIMD: true, useThreads: true }),

      js: toJs(mod, { useSIMD: false, useThreads: false }),
      jsS: toJs(mod, { useSIMD: true, useThreads: false }),
      jsT: toJs(mod, { useSIMD: false, useThreads: true }),
      jsT2: toJs(mod, { useSIMD: false, useThreads: true, threadWorkStealing: true }),
      jsST: toJs(mod, { useSIMD: true, useThreads: true }),
      jsST_WP: toJs(mod, { useSIMD: true, useThreads: true }),
      jsST_WPJS: toJs(mod, { useSIMD: true, useThreads: true }),
    };
    const checkOnline = (i) => {
      if (i._worker_online) {
        console.log('ONLINE', mask(i._worker_online()));
      }
    };
    for (const k in instances) {
      const mod = instances[k];
      let pool = undefined;
      if (k.endsWith('WP')) pool = WP;
      if (k.endsWith('WPJS')) pool = WPJS;
      const inst = js.exec(mod, undefined, pool);
      if (pool) await pool.waitOnline();

      await check(inst, `${k} before`);
      if (pool) await pool.waitOnline();

      for (let i = 0; i < 20; i++) {
        await bench(`${k} add`, () => inst.tmp_cmd(0, CNT, A, B), BENCH_OPTS);
        checkOnline(inst);
        await check(inst, `${k} bench(${i})`);
      }
      await check(inst, `${k} after`);
      if (inst.workers) for (const w of inst.workers) w.terminate();
      if (!STATE) STATE = inst.segments.state.slice();
      //deepStrictEqual(inst.segments.state, STATE, `${k} state`);
    }
    WP.stop();
    WPJS.stop();
  });
});

it.runWhen(import.meta.url);
