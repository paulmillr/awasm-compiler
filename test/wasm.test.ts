import { describe, should } from '@paulmillr/jsbt/test.js';
import { base64, hex } from '@scure/base';
import { deepStrictEqual, throws } from 'node:assert';
import * as js from '../src/js.ts';
import * as wasm from '../src/wasm.ts';
import { LEB128_VECTORS, SLEB128_VECTORS } from './vectors/leb128.ts';

function log(value) {
  // console.log(util.inspect(value, { depth: null, colors: true, maxArrayLength: Infinity }));
}

function getWasm(code) {
  const mod = { functions: [] };
  const jsCode = js.wrapWASM(mod, code);
  return js.exec(js.wrapModule(mod, jsCode, []).raw);
}
function oneFn(...instructions) {
  return {
    functions: [
      {
        name: 'test',
        inputs: [],
        outputs: [],
        export: true,
        locals: [],
        instructions: [...instructions, { TAG: 'end', data: undefined }],
      },
    ],
  };
}

describe('WASM', () => {
  should('LEB128', () => {
    const VECTORS = [
      [0x1fffffn, new Uint8Array([255, 255, 127])],
      [624485n, new Uint8Array([0xe5, 0x8e, 0x26])],
      [10n, new Uint8Array([10])],
      [45n, new Uint8Array([45])],
      [0x10n, new Uint8Array([0x10])],
      [0x45n, new Uint8Array([0x45])],
      [0x190en, new Uint8Array([0x8e, 0x32])],
      [0x2bc1n, new Uint8Array([0xc1, 0x57])],
      [0x7e00000n, new Uint8Array([0x80, 0x80, 0x80, 0x3f])],
      [0x9e00000n, new Uint8Array([0x80, 0x80, 0x80, 0x4f])],
    ];
    for (const [n, bytes] of VECTORS) {
      deepStrictEqual(wasm.LEB128.encode(n), bytes);
      deepStrictEqual(wasm.LEB128.decode(bytes), n);
    }
    throws(() => wasm.LEB128.encode(-1n));
    for (const [_n, bytes] of Object.entries(LEB128_VECTORS)) {
      const n = BigInt(_n);
      deepStrictEqual(wasm.LEB128.encode(n), bytes);
      deepStrictEqual(wasm.LEB128.decode(bytes), n);
    }
    const SVECTORS = [
      [0x1fffffn, new Uint8Array([255, 255, 255, 0])],
      [-123456n, new Uint8Array([0xc0, 0xbb, 0x78])],
      [-12345n, new Uint8Array([0xc7, 0x9f, 0x7f])],
      [0x10n, new Uint8Array([0x10])],
      [-0x3bn, new Uint8Array([0x45])],
      [0x190en, new Uint8Array([0x8e, 0x32])],
      [-0x143fn, new Uint8Array([0xc1, 0x57])],
      [0x7e00000n, new Uint8Array([0x80, 0x80, 0x80, 0x3f])],
      [-0x6200000n, new Uint8Array([0x80, 0x80, 0x80, 0x4f])],
    ];
    for (const [n, bytes] of SVECTORS) {
      deepStrictEqual(wasm.SLEB128.encode(n), bytes);
      deepStrictEqual(wasm.SLEB128.decode(bytes), n);
    }
    for (const [_n, bytes] of Object.entries(SLEB128_VECTORS)) {
      const n = BigInt(_n);
      deepStrictEqual(wasm.SLEB128.encode(n), bytes);
      deepStrictEqual(wasm.SLEB128.decode(bytes), n);
    }
  });
  should('leb failed', () => {
    deepStrictEqual(Buffer.from(wasm.LEB128.encode(1116352408n)).toString('hex'), '98dfa89404');
  });
  should('sleb const', () => {
    const w = base64.decode(
      'AGFzbQEAAAABBQFgAAF/AwIBAAcIAQR0ZXN0AAAKCQEHAEF/QSpqCwAKBG5hbWUCAwEAAA=='
    );
    deepStrictEqual(wasm.wasmBinary.decode(w).sections[3].data, [
      {
        locals: [],
        instructions: [
          { TAG: 'i32.const', data: -1n },
          { TAG: 'i32.const', data: 42n },
          { TAG: 'i32.add', data: undefined },
          { TAG: 'end', data: undefined },
        ],
      },
    ]);
  });

  should('add', () => {
    const w = `00 61 73 6d  01 00 00 00      ; Magic number and version
01 07                         ; Type Section
  01                          ; One type entry
  60                          ; Function type
  02                          ; Two parameters
    7f                        ; i32
    7f                        ; i32
  01                          ; One result
    7f                        ; i32
03 02                         ; Function Section
  01                          ; One function
  00                          ; Type index 0
07 07                         ; Export Section
  01                          ; One export
  03 61 64 64                 ; Export name "add"
  00                          ; Export a function
  00                          ; Function index 0
0a 09                         ; Code Section
  01                          ; One function body
  07                          ; Body size
    00                        ; No locals
    20 00                     ; Get first parameter (local index 0)
    20 01                     ; Get second parameter (local index 1)
    6a                        ; i32.add
    0b                        ; End`;
    const fixAsm = (s) =>
      hex.decode(
        s
          .split('\n')
          .map((i) => i.split(';')[0].trim().replace(/\s+/gm, ''))
          .join('')
      );

    const t = getWasm(fixAsm(w));
    deepStrictEqual(t.add(1, 1), 2);
    deepStrictEqual(t.add(1, 2), 3);
    deepStrictEqual(t.add(2, 1), 3);
    deepStrictEqual(t.add(9, 9), 18);

    log(wasm.wasmBinary.decode(fixAsm(w)));
    const add2 = wasm.createWasm({
      memory: { size: 0 },
      functions: [
        {
          name: 'add',
          inputs: ['i32', 'i32'],
          outputs: ['i32'],
          export: true,
          locals: [],
          instructions: [
            { TAG: 'local.get', data: 0n },
            { TAG: 'local.get', data: 1n },
            { TAG: 'i32.add', data: undefined },
            { TAG: 'end', data: undefined },
          ],
        },
      ],
    });
    deepStrictEqual(add2, fixAsm(w));
  });
  should('multi-function', () => {
    const w = base64.decode(
      'AGFzbQEAAAABEwNgAn9/AX9gAn5+AX5gAn19AX0DBAMAAQIHEwMDYWRkAAADbXVsAAEDZGl2AAIKGQMHACAAIAFqCwcAIAAgAX4LBwAgACABlQsAUARuYW1lARADAANhZGQBA211bAIDZGl2AhkDAAIAAXgBAXkBAgABeAEBeQICAAF4AQF5BBwDAAdpMzJfYWRkAQdpNjRfbXVsAgdmMzJfZGl2'
    );
    const tmp = wasm.createWasm({
      functions: [
        {
          name: 'add',
          inputs: ['i32', 'i32'],
          outputs: ['i32'],
          export: true,
          locals: [],
          instructions: [
            { TAG: 'local.get', data: 0n },
            { TAG: 'local.get', data: 1n },
            { TAG: 'i32.add', data: undefined },
            { TAG: 'end', data: undefined },
          ],
        },
        {
          name: 'mul',
          inputs: ['i64', 'i64'],
          outputs: ['i64'],
          export: true,
          locals: [],
          instructions: [
            { TAG: 'local.get', data: 0n },
            { TAG: 'local.get', data: 1n },
            { TAG: 'i64.mul', data: undefined },
            { TAG: 'end', data: undefined },
          ],
        },
        {
          name: 'div',
          inputs: ['f32', 'f32'],
          outputs: ['f32'],
          export: true,
          locals: [],
          instructions: [
            { TAG: 'local.get', data: 0n },
            { TAG: 'local.get', data: 1n },
            { TAG: 'f32.div', data: undefined },
            { TAG: 'end', data: undefined },
          ],
        },
      ],
    });
    log(wasm.wasmBinary.decode(tmp));
    const decoded = wasm.wasmBinary.decode(w);
    decoded.sections = decoded.sections.slice(0, 4);
    deepStrictEqual(wasm.wasmBinary.decode(tmp), decoded);
  });
  should('multi-return', () => {
    const w = base64.decode(
      'AGFzbQEAAAABCQFgAn9/A39/fwMCAQAHCwEHY29tcHV0ZQAAChMBEQAgACABaiAAIAFsIAAgAWsLADIEbmFtZQEKAQAHY29tcHV0ZQIJAQACAAFhAQFiBBQBABFtdWx0aV9yZXR1cm5fdHlwZQ=='
    );
    const t = getWasm(w);
    deepStrictEqual(t.compute(3, 5), [8, 15, -2]);
    log(wasm.wasmBinary.decode(w));
  });
  should('factorial', () => {
    const w = base64.decode(
      'AGFzbQEAAAABBgFgAXwBfAMCAQAHBwEDZmFjAAAKLgEsACAARAAAAAAAAPA/YwR8RAAAAAAAAPA/BSAAIABEAAAAAAAA8D+hEACiCwsAEgRuYW1lAQYBAANmYWMCAwEAAA=='
    );
    const t = getWasm(w);

    deepStrictEqual(t.fac(15), 1307674368000);

    log(wasm.wasmBinary.decode(w));
  });

  should('complex', () => {
    const w = base64.decode(
      'AGFzbQEAAAABCAFgA399fgF8Ag8BA2VudgZtZW1vcnkCAAEDAgEABwsBB2NvbXBsZXgAAAo9ATsDAX8BfQF8IABBCmohAyABQwAAIECUIQQgArlEAAAAAAAA8D+gIQVBACgCACADaiEDIANBBDYCACAFCwBUBG5hbWUBCgEAB2NvbXBsZXgCKwEABgABeAEBeQIBegMHc3VtX2kzMgQIdGVtcF9mMzIFCnJlc3VsdF9mNjQEFAEAEWNvbXBsZXhfZnVuY190eXBl'
    );
    log(wasm.wasmBinary.decode(w));
    deepStrictEqual(wasm.wasmBinary.decode(w).sections.slice(0, 5), [
      {
        TAG: 'types',
        data: [{ TAG: 'function', data: { inputs: ['i32', 'f32', 'i64'], outputs: ['f64'] } }],
      },
      {
        TAG: 'imports',
        data: [
          {
            module: 'env',
            name: 'memory',
            importType: {
              TAG: 'memory',
              data: {
                flags: {
                  maximum: false,
                  r0: false,
                  r1: false,
                  r2: false,
                  r3: false,
                  r4: false,
                  r5: false,
                  shared: false,
                },
                initial: 1n,
                maximum: undefined,
              },
            },
          },
        ],
      },
      { TAG: 'functions', data: [0n] },
      { TAG: 'exports', data: [{ name: 'complex', kind: 'function', index: 0n }] },
      {
        TAG: 'code',
        data: [
          {
            locals: [
              { count: 1n, type: 'i32' },
              { count: 1n, type: 'f32' },
              { count: 1n, type: 'f64' },
            ],
            instructions: [
              { TAG: 'local.get', data: 0n },
              { TAG: 'i32.const', data: 10n },
              { TAG: 'i32.add', data: undefined },
              { TAG: 'local.set', data: 3n },
              { TAG: 'local.get', data: 1n },
              { TAG: 'f32.const', data: 2.5 },
              { TAG: 'f32.mul', data: undefined },
              { TAG: 'local.set', data: 4n },
              { TAG: 'local.get', data: 2n },
              { TAG: 'f64.convert_i64_s', data: undefined },
              { TAG: 'f64.const', data: 1 },
              { TAG: 'f64.add', data: undefined },
              { TAG: 'local.set', data: 5n },
              { TAG: 'i32.const', data: 0n },
              { TAG: 'i32.load', data: { align: 2n, offset: 0n } },
              { TAG: 'local.get', data: 3n },
              { TAG: 'i32.add', data: undefined },
              { TAG: 'local.set', data: 3n },
              { TAG: 'local.get', data: 3n },
              { TAG: 'i32.const', data: 4n },
              { TAG: 'i32.store', data: { align: 2n, offset: 0n } },
              { TAG: 'local.get', data: 5n },
              { TAG: 'end', data: undefined },
            ],
          },
        ],
      },
    ]);
  });
  should('function signature rejects void valtype', () => {
    const def = (field) => ({
      functions: [
        {
          name: 'bad',
          export: true,
          inputs: field === 'inputs' ? ['void'] : [],
          outputs: field === 'outputs' ? ['void'] : [],
          locals: [],
          instructions: [{ TAG: 'end', data: undefined }],
        },
      ],
    });
    throws(() => wasm.createWasm(def('inputs')), /void.*function.*signature/i);
    throws(() => wasm.createWasm(def('outputs')), /void.*function.*signature/i);
  });
  should('locals reject void valtype', () => {
    const def = (type) => ({
      functions: [
        {
          name: 'bad',
          export: true,
          inputs: [],
          outputs: [],
          locals: [{ count: 1n, type }],
          instructions: [{ TAG: 'end', data: undefined }],
        },
      ],
    });
    deepStrictEqual(WebAssembly.validate(wasm.createWasm(def('i32'))), true);
    throws(() => wasm.createWasm(def('void')), /void.*local.*valtype/i);
  });
  should('instruction immediates are encoded in their valid domain', () => {
    const fence = wasm.createWasm(oneFn({ TAG: 'atomic.fence', data: undefined }));
    deepStrictEqual(WebAssembly.validate(fence), true);
    const validNull = wasm.createWasm(
      oneFn({ TAG: 'null', data: 'funcref' }, { TAG: 'drop', data: undefined })
    );
    deepStrictEqual(WebAssembly.validate(validNull), true);
    throws(
      () => wasm.createWasm(oneFn({ TAG: 'null', data: 'i32' }, { TAG: 'drop', data: undefined })),
      /ref|null|type/i
    );
  });
  should('memory basic', () => {
    const w = base64.decode(
      'AGFzbQEAAAABBgFgAX8BfwMCAQAFBAEBAgIHGwIDbWVtAgARbWFuaXB1bGF0ZV9tZW1vcnkAAAoQAQ4AIABBKjYCACAAKAIACwAmBG5hbWUBFAEAEW1hbmlwdWxhdGVfbWVtb3J5AgkBAAEABGFkZHI='
    );
    const w2 = base64.decode(
      'AGFzbQEAAAABBgFgAX8BfwMCAQAFAwEAAgcbAgNtZW0CABFtYW5pcHVsYXRlX21lbW9yeQAAChABDgAgAEEqNgIAIAAoAgALACYEbmFtZQEUAQARbWFuaXB1bGF0ZV9tZW1vcnkCCQEAAQAEYWRkcg=='
    );
    const w3 = base64.decode(
      'AGFzbQEAAAABBgFgAX8BfwMCAQAFBAEDAQoHHgIGbWVtb3J5AgARbWFuaXB1bGF0ZV9tZW1vcnkAAAoQAQ4AIABBKjYCACAAKAIACwAmBG5hbWUBFAEAEW1hbmlwdWxhdGVfbWVtb3J5AgkBAAEABGFkZHI='
    );
    // (memory (export "mem") 2 2) ->     { TAG: 'memory', data: [ Uint8Array(3) [ 1, 2, 2 ] ] },
    //   (memory (export "mem") 2) ->     { TAG: 'memory', data: [ Uint8Array(2) [ 0, 2 ] ] },
    //   (memory (export "memory") 1 10 shared) ->     { TAG: 'memory', data: [ Uint8Array(3) [ 3, 1, 10 ] ] },
    deepStrictEqual(wasm.wasmBinary.decode(w3).sections[2], {
      TAG: 'memory',
      data: [
        {
          flags: {
            r0: false,
            r1: false,
            r2: false,
            r3: false,
            r4: false,
            r5: false,
            shared: true,
            maximum: true,
          },
          initial: 1n,
          maximum: 10n,
        },
      ],
    });
    deepStrictEqual(wasm.wasmBinary.decode(w2).sections[2], {
      TAG: 'memory',
      data: [
        {
          flags: {
            r0: false,
            r1: false,
            r2: false,
            r3: false,
            r4: false,
            r5: false,
            shared: false,
            maximum: false,
          },
          initial: 2n,
          maximum: undefined,
        },
      ],
    });
    deepStrictEqual(wasm.wasmBinary.decode(w).sections[2], {
      TAG: 'memory',
      data: [
        {
          flags: {
            r0: false,
            r1: false,
            r2: false,
            r3: false,
            r4: false,
            r5: false,
            shared: false,
            maximum: true,
          },
          initial: 2n,
          maximum: 2n,
        },
      ],
    });
    deepStrictEqual(
      wasm.wasmBinary.decode(
        wasm.createWasm({
          functions: [],
          memory: { size: 65536 + 1, export: true, maximum: 65536 + 1 },
        })
      ).sections[0],
      wasm.wasmBinary.decode(w).sections[2]
    );
    throws(
      () =>
        wasm.createWasm({
          functions: [],
          memory: { size: 10 * 65536, export: true, maximum: 9 * 65536 },
        }),
      /initial.*maximum|maximum.*initial|memory/i
    );
  });
  should('simd endianess', () => {
    const w = base64.decode(
      'AGFzbQEAAAABBgFgAn9/AAIPAQNlbnYGbWVtb3J5AgABAwIBAAceARpzd2FwX2VuZGlhbl91MzJfdXNpbmdfc2ltZAAACkUBQwEBfyAAIAFqIQIDQCAAIAJJBEAgACAA/QAEACAA/QAEAP0NAwIBAAcGBQQLCgkIDw4NDP0LBAAgAEEQaiEADAELCwsAOARuYW1lAR0BABpzd2FwX2VuZGlhbl91MzJfdXNpbmdfc2ltZAISAQADAANwdHIBA2xlbgIDZW5k'
    );
    deepStrictEqual(wasm.wasmBinary.decode(w).sections[4].data[0].instructions, [
      { TAG: 'local.get', data: 0n },
      { TAG: 'local.get', data: 1n },
      { TAG: 'i32.add', data: undefined },
      { TAG: 'local.set', data: 2n },
      { TAG: 'loop', data: 'void' },
      { TAG: 'local.get', data: 0n },
      { TAG: 'local.get', data: 2n },
      { TAG: 'i32.lt_u', data: undefined },
      { TAG: 'if', data: 'void' },
      { TAG: 'local.get', data: 0n },
      { TAG: 'local.get', data: 0n },
      {
        TAG: 'SIMD',
        data: { TAG: 'v128.load', data: { align: 4n, offset: 0n } },
      },
      { TAG: 'local.get', data: 0n },
      {
        TAG: 'SIMD',
        data: { TAG: 'v128.load', data: { align: 4n, offset: 0n } },
      },
      {
        TAG: 'SIMD',
        data: {
          TAG: 'i8x16.shuffle',
          data: [3, 2, 1, 0, 7, 6, 5, 4, 11, 10, 9, 8, 15, 14, 13, 12],
        },
      },
      {
        TAG: 'SIMD',
        data: { TAG: 'v128.store', data: { align: 4n, offset: 0n } },
      },
      { TAG: 'local.get', data: 0n },
      { TAG: 'i32.const', data: 16n },
      { TAG: 'i32.add', data: undefined },
      { TAG: 'local.set', data: 0n },
      { TAG: 'br', data: 1n },
      { TAG: 'end', data: undefined },
      { TAG: 'end', data: undefined },
      { TAG: 'end', data: undefined },
    ]);
  });

  should('memory grow on import', () => {
    return;
    const w = base64.decode(
      'AGFzbQEAAAABBgFgAX8BfwIQAQNlbnYGbWVtb3J5AgEBCgMCAQAHDwELZ3Jvd19tZW1vcnkAAAoIAQYAIABAAAsAIQRuYW1lAQ4BAAtncm93X21lbW9yeQIKAQABAAVwYWdlcw=='
    );
    //const memory = new Uint8Array(10);
    const memory = new WebAssembly.Memory({ initial: 1, maximum: 10 });
    const t = getWasm(w, { env: { memory } });
    new Uint8Array(memory.buffer).fill(2);
    // console.log('before', memory.buffer);
    t.grow_memory(4);
    // console.log('after', memory.buffer);
    log(wasm.wasmBinary.decode(w));
  });

  should('control flow', () => {
    const w = base64.decode(
      'AGFzbQEAAAABCAFgA39/fQF/Ag8BA2VudgZtZW1vcnkCAAEDAgEABwsBB2NvbXBsZXgAAAo7ATkCAn8BfSAAIQNBBSEEIAEgA2ohAwJAA0AgBEUNASADQQFqIQMgBEEBayEEDAALCyADQQA2AgAgAwsASQRuYW1lAQoBAAdjb21wbGV4AiABAAYAAXgBAXkCAXoDA3N1bQQHY291bnRlcgUEdGVtcAQUAQARY29tcGxleF9mdW5jX3R5cGU='
    );
    log(wasm.wasmBinary.decode(w));
  });

  should('blockTypes', async () => {
    const w = wasm.createWasm({
      memory: { size: 0 },
      functions: [
        {
          name: 'test',
          inputs: ['i32'],
          outputs: ['i64'],
          export: true,
          locals: [
            { type: 'i32', count: 1 },
            { type: 'i32', count: 1 },
          ], // { type: string; count: number }
          instructions: [
            { TAG: 'i64.const', data: 1n }, // res
            { TAG: 'i32.const', data: 0n }, // i
            // loop (params [i32,i32], results [i32])
            { TAG: 'loop', data: { inputs: ['i64', 'i32'], outputs: ['i64'] } },
            // stack: [res, i]
            { TAG: 'i32.const', data: 1n },
            { TAG: 'i32.add' },
            // stack: [res, i+1]
            { TAG: 'local.set', data: 1n }, // v1 = i+1
            { TAG: 'i64.const', data: 2n },
            { TAG: 'i64.mul' },
            // stack: [2*res]
            { TAG: 'local.get', data: 1n },
            { TAG: 'local.get', data: 1n },
            { TAG: 'local.get', data: 0n },
            // stack: [2*res, i+1, i+1, N]
            { TAG: 'i32.lt_u' },
            // stack: [2*res, i+1, i+1<N]
            { TAG: 'br_if', data: 0n }, // continue if i+1<N
            // stack: [2*res, i+1, i+1<N]
            { TAG: 'drop' },
            { TAG: 'end' }, // here we need [2*res] here
            { TAG: 'end' },
          ],
        },
      ],
    });
    // console.log('W', w);
    log(wasm.wasmBinary.decode(w));
    const t = getWasm(w);
    deepStrictEqual(t.test(0), 2n);
    deepStrictEqual(t.test(5), 32n);
    deepStrictEqual(t.test(10), 1024n);

    const w2 = wasm.createWasm({
      memory: { size: 0 },
      functions: [
        {
          name: 'test',
          inputs: ['i32'],
          outputs: ['i64'],
          export: true,
          locals: [
            { type: 'i32', count: 1 },
            { type: 'i64', count: 1 },
          ], // local[1]=i, local[2]=j  (params come first)
          instructions: [
            // i = 0
            { TAG: 'i32.const', data: 0n },
            { TAG: 'local.set', data: 1n },
            // j = 1
            { TAG: 'i64.const', data: 1n },
            { TAG: 'local.set', data: 2n },

            { TAG: 'loop', data: 'void' },
            // j *= 2
            { TAG: 'local.get', data: 2n },
            { TAG: 'i64.const', data: 2n },
            { TAG: 'i64.mul' }, // j*2
            { TAG: 'local.set', data: 2n },
            // i += 1
            { TAG: 'local.get', data: 1n },
            { TAG: 'i32.const', data: 1n },
            { TAG: 'i32.add' }, // i+1
            { TAG: 'local.set', data: 1n },

            // continue if i+1<N
            { TAG: 'local.get', data: 1n }, // i
            { TAG: 'local.get', data: 0n }, // n
            { TAG: 'i32.lt_u' },
            { TAG: 'br_if', data: 0n },

            { TAG: 'end' }, // end loop
            // Now push the result j for the function return
            { TAG: 'local.get', data: 2n },
            { TAG: 'end' }, // end function
          ],
        },
      ],
    });
    const t2 = getWasm(w2);
    deepStrictEqual(t2.test(0), 2n);
    deepStrictEqual(t2.test(5), 32n);
    deepStrictEqual(t2.test(10), 1024n);
  });
  should('block type index 64', () => {
    const functions = [];
    // The block signature below becomes the 65th distinct type, i.e. typeidx 64.
    for (let i = 0; i < 64; i++) {
      functions.push({
        name: `type${i}`,
        inputs: Array(i).fill('i32'),
        outputs: [],
        locals: [],
        instructions: [{ TAG: 'end', data: undefined }],
      });
    }
    functions.push({
      name: 'test',
      inputs: [],
      outputs: ['i32'],
      export: true,
      locals: [],
      instructions: [
        { TAG: 'block', data: { inputs: [], outputs: ['i32'] } },
        { TAG: 'i32.const', data: 7n },
        { TAG: 'end', data: undefined },
        { TAG: 'end', data: undefined },
      ],
    });
    const instance = new WebAssembly.Instance(
      new WebAssembly.Module(wasm.createWasm({ functions }))
    );
    deepStrictEqual((instance.exports.test as () => number)(), 7);
  });
  should('atomics', async () => {
    const buf = hex.decode(
      `00 61 73 6d 01 00 00 00
01 13
04 60 00 01 7f 60 01 7f 01 7f 60 02 7f 7f 01 7f 60 00 00
03 05
04 00 01 02 03
05 04
01 03 01 01
07 1e
05 03 6d 65 6d 02 00 02 66 30 00 00 02 66 31 00 01 02 66 32 00 02 05 66 65 6e 63 65 00 03
0a 30
04 0a 00 41 00 41 01 fe 00 02 00 0b 10 00 20 00 41 2a fe 17 02 00 20 00 fe 10 02 00 0b 0c 00 20 00 20 01 42 00 fe 01 02 00 0b 05 00 fe 03 00 0b`
        .replaceAll(' ', '')
        .replaceAll('\n', '')
    );
    const t = getWasm(buf);
    // console.log('X', t);
    const { instance } = await WebAssembly.instantiate(buf, {});
    const { mem, f0, f1, f2, fence } = instance.exports;
    deepStrictEqual(mem.buffer instanceof SharedArrayBuffer, true); // true in Node
    deepStrictEqual(f0(), 0); // woken count (likely 0)
    deepStrictEqual(f1(0), 42); // 42
    deepStrictEqual(f2(0, 42), 2); // wait status (2 if no waiter)
    fence(); // just executes
    log(wasm.wasmBinary.decode(buf));
  });
  should('memory', () => {
    const t = {
      sharedImport: base64.decode('AGFzbQEAAAACEQEDZW52Bm1lbW9yeQIDAYACAAgEbmFtZQIBAA=='),
      sharedExport: base64.decode('AGFzbQEAAAAFBQEDAYACBwoBBm1lbW9yeQIAAAgEbmFtZQIBAA=='),
      import: base64.decode('AGFzbQEAAAACEAEDZW52Bm1lbW9yeQIBARAACARuYW1lAgEA'),
      export: base64.decode('AGFzbQEAAAAFAwEAAgcKAQZtZW1vcnkCAAAIBG5hbWUCAQA='),
    };
    for (const k in t) {
      // console.log(`--------- ${k}`);
      log(wasm.wasmBinary.decode(t[k]));
    }
  });
  should('createWasm', () => {
    const def = {
      memory: {
        size: 64 * 1023,
        import: true,
        shared: true,
        export: true,
        maximum: 64 * 1023,
      },
      functions: [
        { name: 'add', import: true, inputs: ['i32', 'i32'], outputs: ['i32'] },
        {
          name: 'call_add',
          export: true,
          inputs: [],
          outputs: ['i32'],
          locals: [{ type: 'i32', count: 1 }],
          instructions: [
            { TAG: 'i32.const', data: 123 },
            { TAG: 'i32.const', data: 456 },
            { TAG: 'call', data: 'add', opts: { inputsCnt: 2, outTypes: ['i32'] } },
            { TAG: 'local.set', data: 0n },
            { TAG: 'local.get', data: 0n },
            { TAG: 'end' },
          ],
        },
        {
          name: 'call_mul',
          export: true,
          inputs: [],
          outputs: ['i32'],
          locals: [{ type: 'i32', count: 1 }],
          instructions: [
            { TAG: 'call', data: 'call_add', opts: { inputsCnt: 0, outTypes: ['i32'] } },
            { TAG: 'local.set', data: 0n },
            { TAG: 'i32.const', data: 2 },
            { TAG: 'local.get', data: 0n },
            { TAG: 'i32.mul' },
            { TAG: 'end' },
          ],
        },
      ],
    };
    const bytes = wasm.createWasm(def);
    const sabMem = new WebAssembly.Memory({ initial: 1, maximum: 1, shared: true });
    const add = (a: number, b: number) => {
      // console.log('call from wasm!', a, b);
      return a + b;
    };
    const env = { _memory: sabMem, add };
    const wasmMod = js.exec(js.wrapModule(def, js.wrapWASM(def, bytes), {}), { env });
    deepStrictEqual(wasmMod.call_add(), 579);
    deepStrictEqual(wasmMod.call_mul(), 2 * 579);
    deepStrictEqual(wasmMod.memory.buffer instanceof SharedArrayBuffer, true);
    deepStrictEqual(wasmMod.memory.buffer === sabMem.buffer, true);
    // Exact same API on js
    const jsMod = js.exec(js.wrapModule(def, js.createJS(def), {}), { env });
    deepStrictEqual(jsMod.call_add(), 579);
    deepStrictEqual(jsMod.call_mul(), 2 * 579);
    deepStrictEqual(jsMod.memory.buffer instanceof SharedArrayBuffer, true);
    deepStrictEqual(jsMod.memory.buffer === sabMem.buffer, true);
  });
});

should.runWhen(import.meta.url);
