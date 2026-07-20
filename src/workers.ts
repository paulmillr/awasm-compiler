import * as P from 'micro-packed';
import { toJs, toWasm, type CompilerOpts } from './codegen.ts';
import { genObject, type ImportEmbed } from './js.ts';
import type { ArraySpec, FnDef, Scope, StructSpec, Val } from './module.ts';
import { array, Module, scalar, struct } from './module.ts';
import { sizeof } from './types.ts';

export type { ArraySpec, FnDef, StructSpec, Val };

const CACHE_LINE_ALIGN = { align: 128, alignEnd: 128 };
//const CACHE_LINE_ALIGN = {};

type WorkerStack = ReturnType<typeof array<'u32', [number]>>;
type U32Spec = ReturnType<typeof scalar<'u32'>>;
type WorkerMemory = {
  _worker: StructSpec<{
    online: U32Spec;
    next: U32Spec;
    total: U32Spec;
    perBatch: U32Spec;
    workers: ArraySpec<
      StructSpec<{
        online: U32Spec;
        done: U32Spec;
        cmd: U32Spec;
        pos: U32Spec;
        len: U32Spec;
        perBatch: U32Spec;
      }>,
      readonly [32]
    >;
    stack: WorkerStack;
  }>;
};
type WorkerFunctions = {
  _worker_notifyBridge: FnDef<['u32', 'u32'], any> & { out: ['u32'] };
  _worker_onlineBridge: FnDef<[], any> & { out: ['u32'] };
  _worker_online: FnDef<[], Val<'u32'>>;
  _worker_notify: FnDef<['u32', 'u32'], Val<'u32'>>;
  stopWorker: FnDef<['u32'], void>;
};
type WorkerPool = { js: ReturnType<typeof toJs>; wasm: ReturnType<typeof toWasm> };

const workerBit = (f: Scope, wid: any) => {
  const { u32 } = f.types;
  return u32.shl(u32.const(1), wid);
};
/**
 * Iterate over workers bitmask
 */
const workerIter = (f: Scope, mask: any, cb: (wid: any, wbit: any) => void) => {
  const { u32 } = f.types;
  /*
for (let wid=0, curMask=mask, processed = 0, processedMask = 0; wid++, curMask>>=1) {
    if (!(curMask & 1)) continue;
    const wbit = 1<<wid;
    cb(wid, wbit);
    processedMask |= wbit;
}
      */
  const [_wid, _curMask, processedMask] = f.forLoop(
    [u32.const(0), mask, u32.const(0)],
    (_wid, curMask, _procMask) => u32.ne(curMask, u32.const(0)),
    (wid, curMask, procMask) => [u32.add(wid, u32.const(1)), u32.shr(curMask, 1), procMask],
    (wid, curMask, procMask) => {
      f.continueIf(u32.eqz(u32.and(curMask, u32.const(1))), 'workerIter', wid, curMask, procMask);
      const wbit = workerBit(f, wid);
      cb(wid, wbit);
      return [wid, curMask, u32.or(procMask, wbit)];
    },
    'workerIter'
  );
  return processedMask;
};

/**
 * Rewrites batch functions into scalar or SIMD loop entrypoints.
 *
 * @param mod - Source module with batch function declarations.
 * @param opts - Compiler options. {@link CompilerOpts}
 * @returns Module clone with batch functions rewritten.
 * @example
 * ```js
 * import { Module } from '@awasm/compiler/module.js';
 * import { addBatch } from '@awasm/compiler/workers.js';
 *
 * addBatch(new Module('demo'), {});
 * ```
 */
export function addBatch(mod: Module, opts: CompilerOpts): Module<{}, {}> {
  if (!(mod instanceof Module))
    throw new TypeError(`"mod" expected Module, got type=${typeof mod}`);
  if (!P.utils.isPlainObject(opts))
    throw new TypeError(`"opts" expected object, got type=${typeof opts}`);
  let res = mod.clone();
  for (const [name, fn] of Object.entries(mod.functions) as any) {
    if (!fn.batch) continue;
    delete (res as any).functions[name]; // remove old version
    const fnArgs = ['u32', 'u32', 'u32', ...fn.inputs];
    if (opts.useSIMD) {
      res = res.fn(name, fnArgs, 'void', (f, pos, len, perBatch, ...args) => {
        const { u32 } = f.types;
        const lanes = u32.const(fn.opts.lanes);
        const end = u32.add(pos, len);
        const tail = u32.rem(len, lanes);
        const until = u32.sub(end, tail); // last multiple of lanes
        // Vector blocks: [pos .. until) step lanes
        f.forLoop(
          [pos],
          (cur) => u32.lt(cur, until),
          (cur) => [u32.add(cur, lanes)],
          (cur) => {
            fn.cb(f, fn.opts.lanes, cur, perBatch, ...args);
            return [cur];
          }
        );
        // Tail: [until .. end) step 1
        f.forLoop(
          [until],
          (cur) => u32.lt(cur, end),
          (cur) => [u32.add(cur, u32.const(1))],
          (cur) => {
            fn.cb(f, 1, cur, perBatch, ...args);
            return [cur];
          }
        );
      });
    } else {
      res = res.fn(name, fnArgs, 'void', (f, pos, len, perBatch, ...args) => {
        const { u32 } = f.types;
        f.doN([], len, (i) => {
          fn.cb(f, 1, u32.add(pos as any, i), perBatch, ...args);
          return [];
        });
      });
    }
    const curFn = (res as any).functions[name];
    curFn.batch = true; // mark as batched
    curFn.opts = fn.opts;
    curFn.origInputs = fn.inputs;
  }
  return res as Module<{}, {}>;
}

/**
 * Adds worker-thread coordination functions around batch functions.
 *
 * @param mod - Source module with batch function declarations.
 * @param opts - Compiler options. {@link CompilerOpts}
 * @returns Module clone with worker support functions and memory.
 * @example
 * ```js
 * import { Module } from '@awasm/compiler/module.js';
 * import { addThreads } from '@awasm/compiler/workers.js';
 *
 * addThreads(new Module('demo'), {});
 * ```
 */
export function addThreads(mod: Module, opts: CompilerOpts): Module<WorkerMemory, WorkerFunctions> {
  if (!(mod instanceof Module))
    throw new TypeError(`"mod" expected Module, got type=${typeof mod}`);
  if (!P.utils.isPlainObject(opts))
    throw new TypeError(`"opts" expected object, got type=${typeof opts}`);
  const prevFunctions = mod.functions as Record<string, any>;
  // Get stack size
  let STACK_SIZE = 1; // empty memory array not allowed
  for (const [_name, fn] of Object.entries(mod.functions) as any) {
    if (!fn.batch) continue;
    let curStackSize = 0;
    for (const i of fn.inputs) curStackSize += sizeof(i);
    STACK_SIZE = Math.max(STACK_SIZE, curStackSize);
  }
  // Batch ids
  let batchFnId = 1;
  const batchFnIds: Record<string, number> = {};
  for (const [name, fn] of Object.entries(mod.functions) as any) {
    if (!fn.batch) continue;
    batchFnIds[name] = batchFnId++;
  }
  // Memory
  // Public return type documents the worker additions; implementation keeps the
  // chain shallow because Deno over-expands exact Scope<M, F> callback types here.
  let res = mod.clone().mem(
    '_worker',
    struct({
      online: scalar('u32', CACHE_LINE_ALIGN),
      next: scalar('u32', CACHE_LINE_ALIGN),
      total: scalar('u32', CACHE_LINE_ALIGN),
      perBatch: scalar('u32', CACHE_LINE_ALIGN),
      workers: array(
        struct(
          {
            online: scalar('u32', CACHE_LINE_ALIGN),
            done: scalar('u32', CACHE_LINE_ALIGN),
            cmd: scalar('u32', CACHE_LINE_ALIGN),
            pos: scalar('u32', CACHE_LINE_ALIGN),
            len: scalar('u32', CACHE_LINE_ALIGN),
            perBatch: scalar('u32', CACHE_LINE_ALIGN),
          },
          CACHE_LINE_ALIGN
        ),
        CACHE_LINE_ALIGN,
        32
      ),
      stack: array('u32', {}, STACK_SIZE),
    })
  ) as Module;
  res = res
    // Generic utils
    .importFn('_worker_notifyBridge', ['u32', 'u32'], ['u32'])
    .importFn('_worker_onlineBridge', [], ['u32'])
    .fn('_worker_online', [], 'u32', (scope: Scope) => {
      // Keep the exported worker type precise while avoiding Deno's deep
      // expansion of the exact memory shape inside this implementation loop.
      const { u32 } = scope.types;
      const { workers } = (scope.memory as any)._worker;
      // workers id starts with 1, 0== main, there is up to 31 worker, but we have
      // 32 in array
      let onlineMask = u32.const(0);
      [onlineMask] = scope.doN([onlineMask], 31, (i, onlineMask) => {
        const wid = u32.add(i, u32.const(1)); // 1..31
        const bit = workerBit(scope, wid); // 1<<
        const online = workers[wid].online.atomics.load();
        return [u32.or(onlineMask, u32.select(online, bit, u32.const(0)))];
      });
      return onlineMask;
    })
    .fn(
      '_worker_notify',
      ['u32', 'u32'],
      'u32',
      (scope: Scope, cmd: Val<'u32'>, mask: Val<'u32'>) => {
        // The public return type keeps the exact worker memory shape, but Deno's
        // publish checker over-expands it inside this callback.
        const { workers } = (scope.memory as any)._worker;
        const { u32 } = scope.types;
        return workerIter(scope, mask, (wid, _wbit) => {
          workers[wid].cmd.atomics.store(cmd); // cmd id
          workers[wid].cmd.atomics.notify(u32.const(1));
        });
      }
    )
    .fn('stopWorker', ['u32'], 'void', (f, id) => {
      const { u32 } = f.types;
      const { workers } = (f.memory as any)._worker;
      const { online } = workers[id];
      online.atomics.store(u32.const(0));
    });
  for (const [name, fn] of Object.entries(prevFunctions)) {
    if (!fn.batch) continue;
    const fns = res.functions as any;
    // Old function goes into thread_int
    const oldName = `_${name}_thread_int`;
    fns[oldName] = fns[name];
    delete fns[name];
    res = res.fn(name, fn.inputs, 'void', (f, pos, len, perBatch, ...args) => {
      const { u32 } = f.types;
      // Fast path
      f.ifElse(
        u32.eq(len, u32.const(1)),
        [],
        () => void f.functions[oldName].call(pos, len, perBatch, ...args),
        () => {
          const ceilDiv = (n: any, d: any) => u32.div(u32.add(n, u32.sub(d, u32.const(1))), d);
          let minPerThread = u32.const(1);
          // If perThread is set, it defines the minimum work per participant (in "perBatch" units).
          // This must override the SIMD lanes heuristic: for big perBatch (e.g. 1MB hashes), we still
          // want threads even when batchLen === lanes.
          if (fn.opts.perThread) {
            minPerThread = u32.max(minPerThread, ceilDiv(u32.const(fn.opts.perThread), perBatch));
          } else if (opts.useSIMD && fn.opts.lanes) {
            // Otherwise keep the lanes heuristic to avoid spawning threads that would mostly run scalar tail.
            minPerThread = u32.select(
              u32.ge(len, u32.const(fn.opts.lanes)),
              u32.const(fn.opts.lanes),
              minPerThread
            );
          }
          const minThreadsNeeded = ceilDiv(len, minPerThread);
          let wantThreads = minThreadsNeeded;
          if (fn.opts.perThread) {
            wantThreads = u32.min(
              minThreadsNeeded,
              ceilDiv(u32.mul(len, perBatch), u32.const(fn.opts.perThread))
            );
          }
          wantThreads = u32.max(u32.const(1), wantThreads); // clamp to 1
          wantThreads = u32.select(u32.eqz(len), u32.const(0), wantThreads); // len=0 -> 0
          f.ifElse(
            u32.le(wantThreads, u32.const(1)), // wantThreads <= 1
            [],
            () => void f.functions[oldName].call(pos, len, perBatch, ...args),
            () => {
              const { workers, stack } = (f.memory as any)._worker;
              // write args (before command)
              // pos, len (default batch), ...actual args
              const inputs = fn.origInputs;
              for (let pos = 0, i = 0; i < inputs.length; i++) {
                stack.as8()[pos].write(inputs[i], args[i]);
                pos += sizeof(inputs[i]);
              }
              // len/pos?
              const [online] = f.functions._worker_onlineBridge.call();
              const W = u32.popcnt(online);
              const need0 = u32.min(
                len,
                W,
                wantThreads,
                opts.threadLimit ? u32.const(opts.threadLimit) : u32.const(32)
              );
              const need = u32.select(
                u32.eq(need0, u32.const(0)),
                u32.const(0),
                u32.sub(need0, u32.const(1))
              ); // -1 with clamp

              let limitNeed = need;

              // participants = main + need workers
              const participants = u32.add(need, u32.const(1));
              const chunkSize = ceilDiv(len, participants);
              const end = u32.add(pos, len);

              // main (wid=0) gets chunk #0
              let mainPos = pos;
              let mainLen = u32.min(len, chunkSize);

              const chunks = ceilDiv(len, chunkSize); // >= 1 if len > 0
              const maxWorkers = u32.sub(chunks, u32.const(1)); // chunks excluding main’s #0
              limitNeed = u32.min(need, maxWorkers); // don’t try to make more shards than exist
              // assign chunks to up to `need` online workers (1..31), no notify
              let [notifyMask, _assigned] = f.doN(
                [u32.const(0), u32.const(0)], // mask; count of assigned workers so far
                31,
                (i, notifyMask, cnt) => {
                  f.brIf('assign', u32.ge(cnt, limitNeed), i, notifyMask, cnt);

                  const wid = u32.add(i, u32.const(1)); // 1..31
                  const bit = u32.shl(u32.const(1), u32.toN('i32', wid));
                  const on = u32.ne(u32.and(online, bit), u32.const(0));

                  const idx = u32.add(cnt, u32.const(1)); // chunk #(1+cnt)
                  const start = u32.add(pos, u32.mul(idx, chunkSize));
                  const valid = u32.lt(start, end); // avoid end-start underflow
                  const remain = u32.sub(end, start);
                  const take = u32.min(chunkSize, remain); // clamp last shard

                  [notifyMask, cnt] = f.ifElse(
                    u32.and(on, valid),
                    [notifyMask, cnt],
                    (notifyMask, cnt) => {
                      workers[wid].pos.atomics.store(start);
                      workers[wid].len.atomics.store(take); // take > 0 guaranteed when valid
                      workers[wid].perBatch.atomics.store(perBatch);
                      return [u32.or(notifyMask, workerBit(f, wid)), u32.add(cnt, u32.const(1))];
                    }
                  );
                  return [notifyMask, cnt];
                },
                'assign'
              );
              f.functions['_worker_notifyBridge'].call(u32.const(batchFnIds[name]), notifyMask);
              f.functions[oldName].call(mainPos, mainLen, perBatch, ...args);
              // spinlock
              f.forLoop(
                [notifyMask],
                (curMask) => u32.ne(curMask, u32.const(0)),
                (curMask) => [curMask],
                (curMask) => {
                  workerIter(f, curMask, (wid, wbit) => {
                    const prev = workers[wid].done.atomics.exchange(u32.const(0));
                    // if prev != 0, mark this worker as complete: clear bit
                    f.continueIf(u32.ne(prev, u32.const(0)), 'spin', u32.xor(curMask, wbit));
                  });
                  return [curMask];
                },
                'spin'
              );
              stack.as8().zero();
            }
          );
        }
      );
    });
  }
  if (!prevFunctions.initWorker) {
    res = res.fn(
      'initWorker',
      ['u32', 'u32', 'u32'],
      'void',
      (f: any, id: any, notifyOnly: any, doOnce: any) => {
        const { u32, i64 } = f.types;
        const { workers, stack } = f.memory._worker;
        const { online, done, cmd } = workers[id];
        online.atomics.store(u32.const(1));
        f.ifElse(
          notifyOnly,
          [],
          () => {},
          () => {
            f.doWhile(
              [],
              () => u32.const(1),
              () => {
                // - then it waits on worker specific u32 (based workerId position) until there is something here
                // - 'something' would be function id
                const curCmd = cmd.atomics.exchange(u32.const(0));
                f.ifElse(u32.and(u32.eqz(curCmd), u32.ne(doOnce, u32.const(1))), [], () => {
                  // no timeout: but what if somebody writes before wait started?
                  cmd.atomics.wait(u32.const(0), i64.const(-1));
                  f.br('main.loop'); //f.continue('main');
                  return [];
                });
                for (const [name, fnId] of Object.entries(batchFnIds)) {
                  const inputs = (mod.functions as any)[name].origInputs;
                  f.ifElse(u32.eq(curCmd, u32.const(fnId)), [], () => {
                    const args = [];
                    for (let pos = 0, i = 0; i < inputs.length; i++) {
                      args.push(stack.as8()[pos].read(inputs[i]));
                      pos += sizeof(inputs[i]);
                    }
                    const worker = f.memory._worker.workers[id];
                    const pos = worker.pos.atomics.load();
                    const len = worker.len.atomics.load();
                    const perBatch = worker.perBatch.atomics.load();
                    f.functions[`_${name}_thread_int`].call(pos, len, perBatch, ...args);
                  });
                }
                done.atomics.store(u32.const(1));
                f.brIf('main', doOnce); // stop
              },
              'main'
            );
          }
        );
      }
    );
  }
  return res as Module<WorkerMemory, WorkerFunctions>;
}

function genPool(_opts: CompilerOpts) {
  const registry: any = {}; // stub. Runtime variable.
  const mod = new Module('workerPool')
    .mem(
      'registry',
      array(
        struct(
          {
            pending: scalar('u32', CACHE_LINE_ALIGN),
            installed: scalar('u32', CACHE_LINE_ALIGN),
          },
          CACHE_LINE_ALIGN
        ),
        CACHE_LINE_ALIGN,
        32
      )
    )
    .importFn('workerProcess', ['u32', 'u32'], [], (id, modId) => {
      if (!registry[modId]) throw new Error('unknown modId');
      registry[modId].exports.initWorker(id, 0, 1);
    })
    .fn('registryInfo', ['u32'], ['u32', 'u32'], (f, id) => {
      const pending = f.memory.registry[id].pending.atomics.load();
      const installed = f.memory.registry[id].installed.atomics.load();
      return [pending, installed];
    })
    .importFn('workerNotify', ['u32', 'u32'], 'void', (id, modId) => {
      if (!registry[modId]) throw new Error('unknown cmd');
      registry[modId].exports.initWorker(id, 1, 0);
    })
    .fn('workerInstalled', ['u32', 'u32'], 'u32', (f, id, modId) => {
      const { u32 } = f.types;
      f.functions.workerNotify.call(id, modId);
      f.memory.registry[id].pending.atomics.sub(u32.const(1));
      f.memory.registry[id].installed.atomics.add(u32.const(1));
      return f.memory.registry[id].pending.atomics.load();
    })
    .fn('mainInstalled', ['u32'], 'void', (f, _modId) => {
      const { u32 } = f.types;
      for (let i = 0; i < 32; i++) {
        f.memory.registry[u32.const(i)].pending.atomics.add(u32.const(1));
      }
      // Notify all workers about pending installs. Note, even if worker online we want to notify it!
      (f.functions as any)._worker_notify.call(u32.const(1), u32.const(0xffff_ffff));
    })
    .fn('mainReset', [], 'void', (f) => {
      const { u32 } = f.types;
      // cleanup pending/installed
      for (let i = 0; i < 32; i++) {
        f.memory.registry[u32.const(i)].pending.atomics.store(u32.const(0));
        f.memory.registry[u32.const(i)].installed.atomics.store(u32.const(0));
      }
    })
    .fn('initWorker', ['u32'], 'void', (f, id) => {
      const { u32, i64 } = f.types;
      const { workers } = (f.memory as any)._worker; // no need for stack here!
      const { online, done, cmd } = workers[id];
      const pendingInstall = f.memory.registry[id].pending.atomics.load();
      f.ifElse(
        u32.ne(pendingInstall, u32.const(0)),
        [],
        () => {
          // f.functions.dbgPending.call(id, pendingInstall);
          // if there is pending install, we don't come report online at all, but stop and wait
          // for onmessage callback to restart us
        },
        () => {
          // We come online only if there is no pending!
          online.atomics.store(u32.const(1));
          f.doWhile(
            [],
            () => u32.const(1),
            () => {
              // - then it waits on worker specific u32 (based workerId position) until there is something here
              // - 'something' would be function id
              const curCmd = cmd.atomics.exchange(u32.const(0));
              f.ifElse(u32.eqz(curCmd), [], () => {
                // no timeout: but what if somebody writes before wait started?
                cmd.atomics.wait(u32.const(0), i64.const(-1));
                f.br('main.loop'); //f.continue('main');
              });
              f.ifElse(u32.eq(curCmd, u32.const(1)), [], () => {
                const pendingInstall = f.memory.registry[id].pending.atomics.load();
                f.brIf('main.loop', u32.eqz(pendingInstall)); //f.continue('main');
                // exit loop, will be re-started after install. Only if pending!
                f.br('main');
              });
              f.functions.workerProcess.call(id, curCmd);
              done.atomics.store(u32.const(1));
            },
            'main'
          );
          online.atomics.store(u32.const(0)); // should be unreachable!
        }
      );
    });
  return mod;
}

const POOL_OPTS: CompilerOpts = {
  useThreads: true,
  customWorkerCodeInit: `const registry = {};`,
  customWorkerCode: `
if (msg.data.type==='install') {
  if (!instance) throw new Error('instance not started yet');
  for (const k in msg.data.registry) {
    if (registry[k]) throw new Error('worker('+workerId+') module '+k+' already installed');
    const {code, memory} = msg.data.registry[k];
    const getInstanceJS = (code, _imports)=>(new Function('_imports', "return ("+code+")(_imports)"))(_imports);
    const getInstanceWASM = (code, _imports)=>new WebAssembly.Instance(new WebAssembly.Module(code), _imports);
    registry[k] = (typeof code==='string' ? getInstanceJS : getInstanceWASM)(code, {env: {..._imports.env, _memory: memory}});
    const r1 = instance.exports.workerInstalled(workerId, +k);
  }
  instance.exports.initWorker(workerId, 0, 0);
  instance.exports.stopWorker(workerId);
  return false;
}
  `,
};

/**
 * Builds the worker-pool helper modules for JS and Wasm backends.
 *
 * @returns Generated JS and Wasm worker-pool sources.
 * @example
 * ```js
 * buildPool();
 * ```
 */
export function buildPool(): WorkerPool {
  return {
    js: toJs(genPool(POOL_OPTS), POOL_OPTS),
    wasm: toWasm(genPool(POOL_OPTS), POOL_OPTS),
  };
}

/**
 * Generates worker initialization boilerplate for threaded wrappers.
 *
 * @param platform - Backend platform whose worker instances will be created.
 * @param importEmbed - Embedded import callbacks by module name.
 * @param opts - Compiler options. {@link CompilerOpts}
 * @returns JavaScript source for worker setup, or an empty string when threads are disabled.
 * @example
 * ```js
 * initWorkers('js', { env: {} }, {});
 * ```
 */
export function initWorkers(
  platform: 'wasm' | 'js',
  importEmbed: ImportEmbed,
  opts: CompilerOpts
): string {
  if (typeof platform !== 'string')
    throw new TypeError(`"platform" expected string, got type=${typeof platform}`);
  if (platform !== 'js' && platform !== 'wasm')
    throw new RangeError(`"platform" expected js or wasm, got ${platform}`);
  if (importEmbed !== undefined && !P.utils.isPlainObject(importEmbed))
    throw new TypeError(`"importEmbed" expected object, got type=${typeof importEmbed}`);
  if (!P.utils.isPlainObject(opts))
    throw new TypeError(`"opts" expected object, got type=${typeof opts}`);
  if (!opts.useThreads) return '';
  let modInit = `const getInstance = (code, _imports)=>`;
  if (platform === 'wasm')
    modInit += `new WebAssembly.Instance(new WebAssembly.Module(code), _imports);`;
  else modInit += `(new Function('_imports', "return ("+code+")(_imports)"))(_imports);`;

  const workerSrc = `(self)=>{
  ${opts.customWorkerCodeInit || ''};
  ${modInit};
  const _imports = ${genObject({ env: {}, ...importEmbed })};
  _imports.env.initWorkers = ()=>{
    throw new Error('initWorkers inside worker');
  };
  _imports.env._worker_notifyBridge = (cmd, mask)=>{
    throw new Error('_worker_callBridge inside worker');
  };
  _imports.env._worker_onlineBridge = ()=>{
    throw new Error('_worker_onlineBridge inside worker');
  };
  let instance;
  let workerId;
  self.onmessage = (msg)=>{
      if (msg.data.type==='init') {
        if (instance) throw new Error('worker already initialized');
        let {id, memory, code} = msg.data;
        instance = getInstance(code, {..._imports, env: {..._imports.env, _memory: memory}});
        workerId = id;
        instance.exports.initWorker(id, 0, 0);
        instance.exports.stopWorker(id);
        return false;
      }
      ${opts.customWorkerCode || ''};
      return false;
  }
}`;
  // NOTE: we cannot crash here, even if there are no workers!
  // - Deno supports only {type: 'module'}
  // - no require in esm node js
  // - unref disables termination prevention in node/bun, but not in deno
  // - JSON.stringify to escape code
  // - W-1 because main thread does work too!
  // - limit is 31 workers, probably should do less? (+main thread)
  //   this is max what we can push in u32 bitmasks. Not sure we need support more
  //   cores for now at least.
  // - external pools install code+memory only; non-env custom imports are unsupported
  //   there unless the pool contract starts carrying imports too.
  return `
let _poolId;
_imports.env._worker_notifyBridge = (cmd, mask)=>{
  instance.exports._worker_notify(cmd, mask);
  if (pool) {
    if (typeof _poolId!=='number') throw new Error('not installed');
    return pool.notify(_poolId, mask);
  }
};
_imports.env._worker_onlineBridge = ()=>{
    let res = instance.exports._worker_online();
    if (pool) res &= pool.online();
    return res;
};

function initWorkers(limit = 32) {
  if (pool) {
    _poolId = pool.install(code, instance.exports.memory);
    return _poolId;
  }
  (async ()=>{
    try {
      let W = (typeof navigator !== 'undefined' && navigator.hardwareConcurrency)
        ? navigator.hardwareConcurrency
        : 4;
      // AWASM_WORKERS caps the pool (shared CI/bench machines where a per-core pool starves
      // everything else); browsers have no process object and keep the default.
      const envW = typeof globalThis.process !== 'undefined' && +globalThis.process.env.AWASM_WORKERS;
      if (envW) W = Math.min(W, envW);
      W = Math.min(W, 32, limit);
      let workerSrc = ${JSON.stringify(workerSrc)};
      let initWorker;
      if (typeof Worker !== 'undefined') {
        const urlSrc = "("+workerSrc+")(self);"
        let url;
        try { url = URL.createObjectURL(new Blob([urlSrc], { type: 'text/javascript' })); } 
        catch { url = 'data:text/javascript;base64,' + btoa(urlSrc); }
        initWorker = () => {
          if (!url) return;
          try { return new Worker(url); }
          catch {}
          try { return new Worker(url, { type: 'module' }); }
          catch {}
        };
      } else {
        let NodeWorker;
        try {
          // Avoid bundlers stuff
          NodeWorker = new Function('return req'+'uire("node:worker_threads").Worker')()
        } catch {}
        if (!NodeWorker) {
          try { NodeWorker = (await import('node:worker_threads')).Worker; }
          catch {}
        }
        if (NodeWorker) {
          // Node ESM eval workers lack require(); parentPort comes from import fallback.
          initWorker = ()=>new NodeWorker("(typeof require==='function' ? Promise.resolve(require('node:worker_threads')) : import('node:worker_threads')).then(({ parentPort }) => ("+workerSrc+")(parentPort));", { eval: true });
        }
      }
      while (workers.length < W-1) {
        const w = initWorker && initWorker();
        if (!w) break;
        const id = workers.push(w);
        w.postMessage({ type: 'init', id, memory: instance.exports.memory, code });
        if (_imports.env && _imports.env.onWorkerInstall) _imports.env.onWorkerInstall(w, id);
        if (typeof w.unref === 'function') w.unref();
      }
    } catch(e) {
     console.log('initWorkers', e);
    }
  })();
}
_imports.env.initWorkers = initWorkers;
`;
}
