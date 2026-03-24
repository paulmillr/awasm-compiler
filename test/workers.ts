import * as js from '../src/js.ts';
import { buildPool } from '../src/workers.ts';

const POOL = buildPool();
export const modWasm = (env) => js.exec(POOL.wasm, env);
export const modJs = (env) => js.exec(POOL.js, env);

/*
Temporarily vendored 'workers pool' from runtime version
*/

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

export class WorkerPool {
  //  limit: number;
  private mod: any;
  private registry: Record<number, { code: any; memory: any }>;
  private pos: number;
  constructor(mod: typeof modWasm) {
    //  this.limit = 31; // 32 bitmask + main
    // <16 reserved for internal commands:
    // 0: wait
    // 1: install
    this.pos = 16;
    this.registry = {};
    this.setModule(mod);
  }
  private setModule(mod: typeof modWasm) {
    this.mod = mod(
      {
        env: {
          // Notify workers that was started after we had install
          onWorkerInstall: (w: any, _id: number) => {
            w.postMessage({ type: 'install', registry: this.registry });
          },
        },
      },
      undefined
    );
  }
  // NOTE: re-uses code from js.ts
  private async initWorkers() {}
  private workerMask() {
    let mask = 0;
    for (let i = 0; i < this.mod.workers.length; i++) mask |= 1 << (i + 1);
    return mask;
  }
  private fmtMask(mask: number) {
    return mask.toString(2).padStart(32, '0');
  }
  // "Public" API
  // Module may call those
  notify(regId: number, mask: number) {
    this.mod._worker_notify(regId, mask);
  }
  online() {
    const res = this.mod._worker_online();
    return res;
  }
  install(code: any, memory: any) {
    const id = this.pos++;
    this.registry[id] = { code, memory };
    let notified = 0;
    for (const w of this.mod.workers) {
      w.postMessage({ type: 'install', registry: { [id]: { code, memory } } });
      notified++;
    }
    this.mod.mainInstalled(id);
    return id;
  }
  //
  // User may call those
  // setLimit(limit: number) {
  //   if (limit < 0 || limit > 31) throw new Error(`wrong limit: ${limit} expected [0...31)`);
  //   this.limit = limit;
  // }
  async waitOnline() {
    for (;;) {
      const online = this.mod._worker_online();
      const mask = this.workerMask();
      // console.log(
      //   'WAIT ONLINE',
      //   this.fmtMask(online),
      //   this.fmtMask(mask),
      //   this.fmtMask(mask ^ online)
      // );
      //const x = P.array(32, P.struct({ pending: P.U32LE, installed: P.U32LE }));
      if (online === mask) break;
      await sleep(100);
    }
  }
  start() {
    this.initWorkers();
  }
  stop() {
    for (const w of this.mod.workers) w.terminate();
    this.mod.mainReset();
  }
}

//export const WP = new WorkerPool(modWasm);
