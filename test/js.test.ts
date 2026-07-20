import { describe, should } from '@paulmillr/jsbt/test.js';
import { deepStrictEqual } from 'node:assert';
import * as js from '../src/js.ts';
import * as wasm from '../src/wasm.ts';

describe('JS', () => {
  should('genObject', () => {
    deepStrictEqual(js.genObject({ a: { b: '3+2' } }), `{a: {b: 3+2}}`);
    deepStrictEqual(
      js.genObject({ a: 'a', nested: { b: 'b', c: '3+2' } }),
      `{a, nested: {b, c: 3+2}}`
    );
    const obj = { '': '1', 'a-b': '2', 'a.b': '3', normal: '4' };
    deepStrictEqual(Function(`return ${js.genObject(obj)}`)(), {
      '': 1,
      'a-b': 2,
      'a.b': 3,
      normal: 4,
    });
    const protoObj: Record<string, string> = Object.create(null);
    protoObj.__proto__ = '7';
    const protoParsed = Function(`return ${js.genObject(protoObj)}`)();
    deepStrictEqual(Object.prototype.hasOwnProperty.call(protoParsed, '__proto__'), true);
    deepStrictEqual(protoParsed.__proto__, 7);
  });
  should('isLiveAfter', () => {
    const dead = [
      { TAG: 'local.get', data: 0n },
      { TAG: 'drop' },
      { TAG: 'local.set', data: 0n },
      { TAG: 'i32.const', data: 1n },
      { TAG: 'local.set', data: 0n },
      { TAG: 'end' },
    ];
    deepStrictEqual(js.__TEST.isLiveAfter(dead as any, 3, 0), false);
    const live = [
      { TAG: 'local.get', data: 0n },
      { TAG: 'drop' },
      { TAG: 'local.set', data: 0n },
      { TAG: 'i32.const', data: 1n },
      { TAG: 'local.get', data: 0n },
      { TAG: 'end' },
    ];
    deepStrictEqual(js.__TEST.isLiveAfter(live as any, 3, 0), true);
  });
  should('split helper returns use object shorthand for locals', () => {
    const n = 12;
    const instructions = [];
    for (let i = 0; i < n; i++)
      instructions.push(
        { TAG: 'i32.const', data: BigInt(i) },
        { TAG: 'local.set', data: BigInt(i) }
      );
    instructions.push({ TAG: 'block', data: 'void', hoist: [] }, { TAG: 'end' });
    for (let i = 0; i < n; i++) instructions.push({ TAG: 'local.get', data: BigInt(i) });
    instructions.push({ TAG: 'end' });
    const raw = js.createJS(
      {
        memory: { size: 0 },
        functions: [
          {
            name: 'main',
            export: true,
            inputs: [],
            outputs: Array(n).fill('i32'),
            locals: [],
            instructions,
          },
        ],
      } as any,
      {},
      { jsOpsPerFn: 10 }
    );
    deepStrictEqual(
      raw.split('\n').filter((line) => line.startsWith('return {v0')),
      ['return {v0, v1, v2, v3, v4, v5, v6, v7, v8, v9, v10, v11};']
    );
  });
  should('call tail remains live across skippable block assignment', () => {
    const mod = {
      functions: [
        { name: 'seed', import: true, inputs: [], outputs: ['i32'] },
        {
          name: 'skip_set',
          export: true,
          inputs: ['i32'],
          outputs: ['i32'],
          locals: [{ type: 'i32', count: 1 }],
          instructions: [
            { TAG: 'call', data: 'seed', opts: { inputsCnt: 0, outTypes: ['i32'] } },
            { TAG: 'local.set', data: 1n },
            { TAG: 'block', data: 'void', hoist: [1] },
            { TAG: 'local.get', data: 0n },
            { TAG: 'br_if', data: 0n },
            { TAG: 'i32.const', data: 7n },
            { TAG: 'local.set', data: 1n },
            { TAG: 'end' },
            { TAG: 'local.get', data: 1n },
            { TAG: 'end' },
          ],
        },
      ],
    };
    const env = { seed: () => 42 };
    const wasmMod = js.exec(js.wrapModule(mod, js.wrapWASM(mod, wasm.createWasm(mod as any)), {}), {
      env,
    });
    const jsMod = js.exec(js.wrapModule(mod, js.createJS(mod as any), {}), { env });
    deepStrictEqual(wasmMod.skip_set(1), 42);
    deepStrictEqual(wasmMod.skip_set(0), 7);
    deepStrictEqual(jsMod.skip_set(1), 42);
    deepStrictEqual(jsMod.skip_set(0), 7);
  });
  should('genWASM', () => {
    return;
    const code = wasm.createWasm({
      memory: { size: 1024, export: true },
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
    const gen = js.genWASM('name', code, [], {
      data: { size: 100, u8: true, view: true, u32: true, pos: 0 },
    }).raw;
    deepStrictEqual(
      gen,
      `
const code = Uint8Array.from(atob('AGFzbQEAAAABBwFgAn9/AX8DAgEABQQBAQEBBxACBm1lbW9yeQIAA2FkZAAACgkBBwAgACABags='), char => char.charCodeAt(0));
const module = new WebAssembly.Module(code);
const instance = new WebAssembly.Instance(module, {env: {}});
const _exports = instance.exports;
const buffer = _exports.memory ? _exports.memory.buffer : new ArrayBuffer(0);
const memory = new Uint8Array(buffer, 0, buffer.byteLength);
const segments = {data: new Uint8Array(memoryExport.buffer, 0, 100), data_chunks: [new Uint8Array(memoryExport.buffer, 0, 100)]
};

return { ..._exports, memory, segments };`
    );
    const t = js.exec(gen);
    deepStrictEqual(t.segments, {
      data: new Uint8Array(100),
      data_chunks: [new Uint8Array(100)],
    });
  });
  should('wrapWASM wasmAsHex', () => {
    const def = {
      memory: { size: 1024, export: true },
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
    };
    const code = wasm.createWasm(def);
    const raw = js.wrapWASM(def, code, {}, { wasmAsHex: true });
    deepStrictEqual(raw.includes('atob('), false);
    deepStrictEqual(raw.includes('00 61 73 6d'), true);
    deepStrictEqual(raw.includes('Uint8Array.from(\n`\n'), true);
    deepStrictEqual(raw.includes('\n`\n  .match(/[0-9a-f]{2}/g),\n'), true);
    const start = raw.indexOf('`\n');
    const end = raw.indexOf('\n`\n  .match(/[0-9a-f]{2}/g),\n');
    deepStrictEqual(start >= 0, true);
    deepStrictEqual(end > start, true);
    const lines = raw.slice(start + 2, end).split('\n');
    for (const line of lines) deepStrictEqual(line.length > 0 && line.length <= 100, true);
    const mod = js.exec(js.wrapModule(def, raw, {}));
    deepStrictEqual(mod.add(1, 2), 3);
  });
  should('freeze option freezes segment chunk arrays', () => {
    const def = { memory: { size: 32, export: true }, functions: [] };
    const segments = {
      data: {
        pos: 0,
        size: 16,
        paddedSize: 16,
        subRegions: { '': [0, 16, 4, 4], single: [8, 4, 1, 4] },
      },
    };
    const code = 'const instance = { exports: { memory: { buffer: new ArrayBuffer(32) } } };';
    const wrapped = js.wrapModule(def as any, code, segments as any, {}, { freeze: true });
    deepStrictEqual(
      wrapped.raw.split('\n').filter((line) => line.includes('data_chunks')),
      [
        ', data_chunks: Object.freeze(Array.from({length: 4},(_,i)=>new Uint8Array(memoryExport.buffer, i*4, 4)))',
      ]
    );
    deepStrictEqual(
      wrapped.raw.split('\n').filter((line) => line.includes('data.single_chunks')),
      [', "data.single_chunks": Object.freeze([new Uint8Array(memoryExport.buffer, 8, 4)])']
    );
    const out = js.exec(wrapped);
    deepStrictEqual(Object.isFrozen(out), true);
    deepStrictEqual(Object.isFrozen(out.segments), true);
    deepStrictEqual(Object.isFrozen(out.segments.data_chunks), true);
    out.segments.data_chunks[0][0] = 7;
    deepStrictEqual(out.segments.data_chunks[0][0], 7);
  });
  should('dead local.set keeps atomic side effects', () => {
    const raw = js.createJS(
      {
        memory: { size: 1024, shared: true, export: true },
        functions: [
          {
            name: 'main',
            export: true,
            inputs: [],
            outputs: [],
            locals: [{ type: 'i32', count: 1 }],
            instructions: [
              { TAG: 'i32.const', data: 0n },
              { TAG: 'i32.const', data: 1n },
              { TAG: 'i32.atomic.add', data: { align: 2, offset: 0 } },
              { TAG: 'local.set', data: 0n },
              { TAG: 'end' },
            ],
          },
        ],
      } as any,
      {}
    );
    deepStrictEqual(
      raw,
      `
const __buf = new SharedArrayBuffer(1024);
if (!(__buf instanceof SharedArrayBuffer)) throw new Error('wrong buffer');

const memory_i32 = new Int32Array(__buf);



function main() {
    
    Atomics.add(memory_i32, 0, (1|0))|0;
return ;
}
const instance = { exports: {main, memory: { buffer: __buf }}};
`
    );
  });
  should('materializes direct memory-load operands before composing expressions', () => {
    const mod = {
      memory: { size: 1024, export: true },
      functions: [
        {
          name: 'main',
          export: true,
          inputs: [],
          outputs: ['i32'],
          locals: [],
          instructions: [
            { TAG: 'i32.const', data: 0n },
            { TAG: 'i32.load', data: { align: 2, offset: 0, trustedAlign: true } },
            { TAG: 'i32.const', data: 4n },
            { TAG: 'i32.load', data: { align: 2, offset: 0, trustedAlign: true } },
            { TAG: 'i32.xor' },
            { TAG: 'end' },
          ],
        },
      ],
    };
    const raw = js.createJS(mod as any, {});
    deepStrictEqual(
      raw,
      `
const __buf = new ArrayBuffer(1024);
if (!(__buf instanceof ArrayBuffer)) throw new Error('wrong buffer');

const memory_i32 = new Int32Array(__buf);



function main() {
${'    '}
    const __awasm_mem0 = memory_i32[0];
const __awasm_mem1 = memory_i32[1];
return (__awasm_mem0 ^ __awasm_mem1);
}
const instance = { exports: {main, memory: { buffer: __buf }}};
`
    );
    const generated = js.exec(js.wrapModule(mod as any, raw, {}));
    new Int32Array(generated.memory.buffer)[0] = 0xa5a5a5a5 | 0;
    new Int32Array(generated.memory.buffer)[1] = 0x5a5a5a5a | 0;
    deepStrictEqual(generated.main(), -1);
  });
});

should.runWhen(import.meta.url);
