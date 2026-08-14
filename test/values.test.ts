import { describe, it } from '@paulmillr/jsbt/test.js';
import { deepStrictEqual } from 'node:assert';
import { toMod, type FnOp } from '../src/codegen.ts';
import { Module, array } from '../src/module.ts';
import type { Fact } from '../src/values.ts';
import * as values from '../src/values.ts';

const saveFacts = (f: any, facts: Record<string, Fact | undefined>, ops: Record<string, FnOp>) => {
  for (const [name, op] of Object.entries(ops)) facts[name] = f.rawFn.ops.get(op.idx).fact;
};
const known = (bits: bigint, value: bigint, min = value, max = value): Fact => ({
  bits: { known: bits, value },
  range: { min, max },
});

describe('Values', () => {
  it('accepts lightweight graph inputs', () => {
    const graph = {
      ops: {
        get(idx: string) {
          if (idx === 'scope') return { kind: 'block' as const, args: ['x'] };
          return {
            kind: 'op' as const,
            op: 'const',
            type: 'u32' as const,
            args: [] as string[],
            opts: { value: 1 },
          };
        },
      },
    };
    const node = {
      kind: 'op' as const,
      op: 'arg',
      type: 'u32' as const,
      args: [] as string[],
      opts: { scope: 'scope', pos: 0 },
    };
    deepStrictEqual(values.infer(graph, node), {
      range: { min: 0n, max: 0xffff_ffffn },
    });
    deepStrictEqual(values.weight(graph)('x'), 0);
  });
  it('does not dispatch inherited names as range operations', () => {
    const graph = { ops: { get: () => ({ kind: 'op' }) } };
    const node = { kind: 'op', op: 'constructor', type: 'u32', args: [], opts: {} };
    deepStrictEqual(values.infer(graph as any, node as any), undefined);
  });
  it('omits unknown select facts', () => {
    const nodes = {
      a: { kind: 'op', fact: { range: { min: 1n, max: 2n } } },
      b: { kind: 'op', fact: { range: { min: 3n, max: 4n } } },
    };
    const graph = { ops: { get: (idx: keyof typeof nodes) => nodes[idx] } };
    const node = { kind: 'op', op: 'select', type: 'u32', args: ['a', 'b'], opts: {} };
    deepStrictEqual(values.infer(graph as any, node as any), {
      range: { min: 1n, max: 4n },
    });
  });
  it('infers signed subword ranges from sign extension', () => {
    const facts: Record<string, Fact | undefined> = {};
    const m = new Module('signFacts');
    m.fn('facts', ['i32', 'i64'], 'u32', (f, a32, a64) => {
      const { i32, i64, u32 } = f.types;
      const i8 = i32.shr(i32.shl(a32, 24), 24);
      const i16 = i32.shr(i32.shl(a32, 16), 16);
      const i64i16 = i64.shr(i64.shl(a64, 48), 48);
      saveFacts(f, facts, { i8, i16, i64i16 });
      return [u32.const(0)];
    });
    toMod(m, { optimize: false, wasmTee: false });
    deepStrictEqual(facts, {
      i8: { range: { min: -128n, max: 127n } },
      i16: { range: { min: -32768n, max: 32767n } },
      i64i16: { range: { min: -32768n, max: 32767n } },
    });
  });
  it('infers ranges for count operations', () => {
    const facts: Record<string, Fact | undefined> = {};
    const m = new Module('countFacts');
    m.fn('facts', ['u32', 'u64'], 'u32', (f, a32, a64) => {
      const { u32, u64 } = f.types;
      saveFacts(f, facts, {
        clz32: u32.clz(a32),
        ctz32: u32.ctz(a32),
        pop32: u32.popcnt(a32),
        ctz64: u64.ctz(a64),
      });
      return [u32.const(0)];
    });
    toMod(m, { optimize: false, wasmTee: false });
    deepStrictEqual(facts, {
      clz32: { range: { min: 0n, max: 32n } },
      ctz32: { range: { min: 0n, max: 32n } },
      pop32: { range: { min: 0n, max: 32n } },
      ctz64: { range: { min: 0n, max: 64n } },
    });
  });
  it('infers known bits and ranges on node creation', () => {
    const facts: Record<string, Fact | undefined> = {};
    const m = new Module('valueFacts').mem('buf32', array('u32', {}, 1));
    m.fn('facts', ['u8', 'u32'], 'u32', (f, u8Arg, word) => {
      const { u32 } = f.types;
      const c = u32.const(0xf0);
      const neg = f.rawFn.op('u32', 'const', [], { value: -1 });
      const load8 = f.memory.buf32.as8()[0].get();
      const masked = u32.and(word, u32.const(0xff));
      const mul = u32.mul(masked, u32.const(3));
      const div = u32.div(masked, u32.const(3));
      const rem = u32.rem(word, u32.const(10));
      const or = u32.or(c, u32.const(3));
      const shl = u32.shl(u32.const(0x0f), 4);
      const shr = u32.shr(word, 24);
      const add = u32.add(load8, u32.const(16));
      const wrapAdd = u32.add(word, u32.const(1));
      const sub = u32.sub(u32.const(300), load8);
      const cmp = u32.lt(word, u32.const(9));
      const sel = u32.select(cmp, c, u32.const(0xf1));
      f.block([add], (addr) => {
        saveFacts(f, facts, { blockArg: addr });
        return [addr];
      });
      saveFacts(f, facts, {
        u8Arg,
        const: c,
        u32Neg: neg,
        load8,
        masked,
        mul,
        div,
        rem,
        or,
        shl,
        shr,
        add,
        wrapAdd,
        sub,
        cmp,
        select: sel,
      });
      return [u32.const(0)];
    });
    toMod(m, { optimize: false, wasmTee: false });
    deepStrictEqual(facts, {
      u8Arg: { range: { min: 0n, max: 255n } },
      const: known(0xffffffffn, 0xf0n),
      u32Neg: known(0xffffffffn, 0xffffffffn),
      load8: known(0xffffff00n, 0n, 0n, 255n),
      masked: known(0xffffff00n, 0n, 0n, 255n),
      mul: { range: { min: 0n, max: 765n } },
      div: { range: { min: 0n, max: 85n } },
      rem: { range: { min: 0n, max: 9n } },
      or: known(0xffffffffn, 0xf3n),
      shl: known(0xffffffffn, 0xf0n),
      shr: known(0xffffff00n, 0n, 0n, 255n),
      add: { range: { min: 16n, max: 271n } },
      blockArg: { range: { min: 16n, max: 271n } },
      wrapAdd: undefined,
      sub: { range: { min: 45n, max: 300n } },
      cmp: known(0xfffffffen, 0n, 0n, 1n),
      select: known(0xfffffffen, 0xf0n, 0xf0n, 0xf1n),
    });
  });
  it('calculates graph weights for scheduling', () => {
    let rawFn: any;
    const ids: Record<string, string> = {};
    const m = new Module('weights');
    m.fn('calc', ['u32'], 'u32', (f, a) => {
      rawFn = f.rawFn;
      const { u32, u32x4 } = f.types;
      const c = u32.const(7);
      const add = u32.add(a, c);
      const cast = f.rawFn.op('u32', 'cast', [add], { from: 'u32' });
      const simd = u32x4.splat(add);
      for (const [name, op] of Object.entries({ arg: a, const: c, add, cast, simd }))
        ids[name] = op.idx;
      return [u32.add(cast, u32x4.extractLane(simd, 0))];
    });
    toMod(m, { optimize: false, wasmTee: false });
    const weight = values.weight(rawFn);
    deepStrictEqual(Object.fromEntries(Object.entries(ids).map(([k, v]) => [k, weight(v)])), {
      arg: 1,
      const: 0,
      add: 2,
      cast: 2,
      simd: 6,
    });
  });
});

it.runWhen(import.meta.url);
