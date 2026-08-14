import mark from '@paulmillr/jsbt/benchmark.js';
import { toJs, toWasm } from '../src/codegen.ts';
import { Module, array } from '../src/module.ts';
// exec lives in js.ts; codegen.ts doesn't export it.
import { exec } from '../src/js.ts';
import { genRuntimeTypes } from '../src/types.ts';
import * as utils from '../src/utils.ts';

const RUNTIME_TYPES = genRuntimeTypes();

const CNT = 1024;
const ITERS = 50_000;
const ITERS_JS = 2_000_000;

const genMod = () => {
  const m = new Module('swizzleBench');
  m.mem('vec', array('u8x16', {}, 3));
  m.mem('buf', array('u8', {}, 48));
  // Use memory IO to avoid v128 in signatures (js wrap doesn't map v128).
  m.fn('swizzle', [], 'void', (f) => {
    const { u8x16 } = f.types;
    const a = f.memory.vec[0].get();
    const b = f.memory.vec[1].get();
    const [out] = f.doN([a], CNT, (i, acc) => [u8x16.swizzle(acc, b)]);
    f.memory.vec[2].set(out);
    return [];
  });
  m.fn('swizzleMemIdx', [], 'void', (f) => {
    const { u8, u32 } = f.types;
    const zero = u32.const(0);
    const maskHi = u32.const(0xf0);
    const maskLo = u32.const(0x03);
    const maskByte = u32.const(0xff);
    const shl3 = u32.const(3);
    const offMask = 16;
    const offOut = 32;
    f.doN([zero], CNT, (i, x) => {
      for (let j = 0; j < 16; j++) {
        const idx = f.memory.buf[offMask + j].get();
        const idx32 = u8.toN('u32', idx);
        const hi = u32.and(idx32, maskHi);
        const ok = u32.eqz(hi);
        const w = f.memory.buf.as32()[u32.shr(idx32, 2)].get();
        const shift = u32.shl(u32.and(idx32, maskLo), shl3);
        const byte = u32.and(u32.shr(w, shift), maskByte);
        const out = u32.select(ok, byte, zero);
        f.memory.buf[offOut + j].set(u32.toN('u8', out));
      }
      return [x];
    });
    return [];
  });
  m.fn('swizzleTmpBuf', [], 'void', (f) => {
    const { u8, u32, u8x16 } = f.types;
    const zero = u32.const(0);
    const maskHi = u32.const(0xf0);
    const maskByte = u32.const(0xff);
    const tmp = f.memory.buf.as8('u8');
    const a = f.memory.vec[0].get();
    const mask = f.memory.vec[1].get();
    f.doN([zero], CNT, (i, x) => {
      for (let j = 0; j < 16; j++) {
        tmp[j].set(u8x16.extractLane(a, j));
      }
      let out = u8x16.const(0);
      for (let j = 0; j < 16; j++) {
        const idx = u8x16.extractLane(mask, j);
        const idx32 = u8.toN('u32', idx);
        const ok = u32.eqz(u32.and(idx32, maskHi));
        const val = tmp[idx32].get();
        const val32 = u8.toN('u32', val);
        const outByte = u32.and(u32.select(ok, val32, zero), maskByte);
        out = u8x16.replaceLane(out, j, u32.toN('u8', outByte));
      }
      f.memory.vec[2].set(out);
      return [x];
    });
    return [];
  });
  m.fn('swizzleTmpConv', [], 'void', (f) => {
    const { u8, u32, u8x16 } = f.types;
    const zero = u32.const(0);
    const limit = u32.const(16);
    const tmp = f.memory.buf.as8('u8').range(0, 16);
    const a = f.memory.vec[0].get();
    const mask = f.memory.vec[1].get();
    f.doN([zero], CNT, (i, x) => {
      tmp.set(u8x16.to('u8', a));
      const maskVals = u8x16.to('u8', mask);
      const outVals = maskVals.map((idx) => {
        const idx32 = u32.fromN('u8', idx);
        const ok = u32.lt(idx32, limit);
        const val = tmp[idx32].get();
        return u32.toN('u8', u32.select(ok, u8.toN('u32', val), zero));
      });
      f.memory.vec[2].set(u8.toN('u8x16', outVals));
      return [x];
    });
    return [];
  });
  m.fn('swizzlePacked', [], 'void', (f) => {
    const { u8, u32, u8x16 } = f.types;
    const zero = u32.const(0);
    const maskHi = u32.const(0xf0);
    const maskLo = u32.const(0x03);
    const maskByte = u32.const(0xff);
    const shl3 = u32.const(3);
    const shl8 = u32.const(8);
    const shl16 = u32.const(16);
    const shl24 = u32.const(24);
    const idx1 = u32.const(1);
    const idx2 = u32.const(2);
    const idx3 = u32.const(3);
    const a = f.memory.vec[0].get();
    const mask = f.memory.vec[1].get();
    const pack4 = (b0: number, b1: number, b2: number, b3: number) => {
      const x0 = u8.toN('u32', u8x16.extractLane(a, b0));
      const x1 = u32.shl(u8.toN('u32', u8x16.extractLane(a, b1)), shl8);
      const x2 = u32.shl(u8.toN('u32', u8x16.extractLane(a, b2)), shl16);
      const x3 = u32.shl(u8.toN('u32', u8x16.extractLane(a, b3)), shl24);
      return u32.or(x0, x1, x2, x3);
    };
    const w0 = pack4(0, 1, 2, 3);
    const w1 = pack4(4, 5, 6, 7);
    const w2 = pack4(8, 9, 10, 11);
    const w3 = pack4(12, 13, 14, 15);
    const [out] = f.doN([u8x16.const(0)], CNT, (i, acc) => {
      let next = acc;
      for (let j = 0; j < 16; j++) {
        const idx = u8x16.extractLane(mask, j);
        const idx32 = u8.toN('u32', idx);
        const hi = u32.and(idx32, maskHi);
        const ok = u32.eqz(hi);
        const widx = u32.shr(idx32, 2);
        let w = w0;
        w = u32.select(u32.eq(widx, idx1), w1, w);
        w = u32.select(u32.eq(widx, idx2), w2, w);
        w = u32.select(u32.eq(widx, idx3), w3, w);
        const shift = u32.shl(u32.and(idx32, maskLo), shl3);
        const byte = u32.and(u32.shr(w, shift), maskByte);
        const outByte = u32.select(ok, byte, zero);
        next = u8x16.replaceLane(next, j, u32.toN('u8', outByte));
      }
      return [next];
    });
    f.memory.vec[2].set(out);
    return [];
  });
  return m;
};

const mod = genMod();
const wasm = exec(toWasm(mod, { useSIMD: true }));
const jsRaw = toJs(mod, { useSIMD: true }).raw;
const js = exec(jsRaw);

let sink = 0;

const fill = (seg: Uint8Array, off: number, values: number[]) => {
  for (let i = 0; i < values.length; i++) seg[off + i] = values[i];
};
const init = (mod: any) => {
  const seg = mod.segments.vec;
  const a = utils.seq(16).map((i) => (i + 1) & 0xff);
  const mask = utils.seq(16).map((i) => (i % 8 < 4 ? i : i + 16));
  fill(seg, 0, a);
  fill(seg, 16, mask);
  fill(mod.segments.buf, 0, a);
  fill(mod.segments.buf, 16, mask);
};

async function main() {
  init(wasm);
  init(js);
  await mark(
    `wasm swizzle x${CNT}`,
    () => {
      wasm.swizzle();
      sink ^= wasm.segments.vec[32];
    },
    ITERS
  );
  await mark(
    `js swizzle x${CNT}`,
    () => {
      js.swizzle();
      sink ^= js.segments.vec[32];
    },
    ITERS
  );
  await mark(
    `js mem swizzle x${CNT}`,
    () => {
      js.swizzleMemIdx();
      sink ^= js.segments.buf[32];
    },
    ITERS
  );
  await mark(
    `js tmp-conv swizzle x${CNT}`,
    () => {
      js.swizzleTmpConv();
      sink ^= js.segments.vec[32];
    },
    ITERS
  );
  await mark(
    `js tmp-buf swizzle x${CNT}`,
    () => {
      js.swizzleTmpBuf();
      sink ^= js.segments.vec[32];
    },
    ITERS
  );
  await mark(
    `js packed swizzle x${CNT}`,
    () => {
      js.swizzlePacked();
      sink ^= js.segments.vec[32];
    },
    ITERS
  );

  let idx = 0;
  const next = () => (idx = (idx + 1) & 15);
  const arr = utils.seq(16).map((i) => i + 1);
  const LOOP = 1024;
  await mark(
    'js idx array literal',
    () => {
      for (let i = 0; i < LOOP; i++) {
        const k = next();
        sink ^= [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16][k];
      }
    },
    ITERS_JS
  );
  await mark(
    'js idx array reuse',
    () => {
      for (let i = 0; i < LOOP; i++) {
        const k = next();
        sink ^= arr[k];
      }
    },
    ITERS_JS
  );
  await mark(
    'js idx switch',
    () => {
      for (let i = 0; i < LOOP; i++) {
        const k = next();
        sink ^=
          k === 0
            ? 1
            : k === 1
              ? 2
              : k === 2
                ? 3
                : k === 3
                  ? 4
                  : k === 4
                    ? 5
                    : k === 5
                      ? 6
                      : k === 6
                        ? 7
                        : k === 7
                          ? 8
                          : k === 8
                            ? 9
                            : k === 9
                              ? 10
                              : k === 10
                                ? 11
                                : k === 11
                                  ? 12
                                  : k === 12
                                    ? 13
                                    : k === 13
                                      ? 14
                                      : k === 14
                                        ? 15
                                        : 16;
      }
    },
    ITERS_JS
  );

  const a16 = new Uint8Array(16);
  const m16 = new Uint8Array(16);
  const o16 = new Uint8Array(16);
  for (let i = 0; i < 16; i++) {
    a16[i] = (i + 1) & 0xff;
    m16[i] = i % 8 < 4 ? i : i + 16;
  }
  await mark(
    'js swizzle u8a loop',
    () => {
      for (let k = 0; k < LOOP; k++) {
        for (let i = 0; i < 16; i++) {
          const idx = m16[i];
          o16[i] = idx < 16 ? a16[idx] : 0;
        }
        sink ^= o16[0];
      }
    },
    ITERS_JS
  );
}

main();
