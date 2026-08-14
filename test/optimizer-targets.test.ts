import { describe, it } from './jsbt.js';
import { hex } from '@scure/base';
import { deepStrictEqual, throws } from 'node:assert';
import { ModuleGraph, toJs, toMod, toWasm } from '../src/codegen.ts';
import { exec } from '../src/js.ts';
import { Module, array, struct } from '../src/module.ts';
import { icse } from '../src/rewrites.ts';

// Target tests for optimizer work that needs exact structural assertions.
describe('Optimizer target tests', () => {
  const teeOpts = { noRuntime: true, optimize: false, wasmBlockType: true, wasmTee: true };
  const compilers = [
    ['js', toJs],
    ['wasm', toWasm],
  ] as const;
  const binaryCases = [
    [5, 0],
    [5, 1],
    [0, 0],
    [0, 1],
  ];
  const nestedCases = [
    [5, 0, 0],
    [5, 1, 0],
    [5, 1, 1],
  ];
  const graph = (name: string) => new ModuleGraph(name, {}, new Module(name), {});
  const instructions = (...rows: string[]) => rows.flatMap((row) => row.split('|'));
  const formatted = (...rows: string[]) => `${instructions(...rows).join('\n')}\n`;
  const runBoth = (mod: Module, cases: number[][], opts = {}) => {
    const res = [];
    for (const [target, compile] of compilers) {
      const out = exec(compile(mod, { ...teeOpts, ...opts }));
      for (const args of cases) res.push({ target, args, value: out.run(...args) });
    }
    return res;
  };
  const both = (cases: number[][], values: number[]) =>
    compilers.flatMap(([target]) => cases.map((args, i) => ({ target, args, value: values[i] })));
  const blockStateChurn = () =>
    new Module('block_state_churn').fn('same', ['u32'], 'u32', (f, x) => {
      const { u32 } = f.types;
      let y = x;
      [y] = f.block([y], (y) => {
        f.brIf(0, u32.eqz(x), y);
        return [y];
      });
      return y;
    });
  const rewriteIcse = (mg: ModuleGraph, opts = {}) => {
    const rewrite = icse(mg, opts);
    mg.ops.rewrite({
      icse(node, idx) {
        if (node.kind === 'module') return;
        const args = node.kind === 'function' ? [] : node.args.map((arg) => mg.byIdx(arg));
        return rewrite(node, args, idx)?.idx;
      },
    });
  };
  const rewritePressureIcse = (mg: ModuleGraph) =>
    mg.rewrite({
      optimize: false,
      cseOps: false,
      motionOps: false,
      wasmTee: false,
      icseOps: true,
    });

  it('block no-op state does not emit JS or Wasm saved-state assignments', () => {
    const mod = blockStateChurn();
    const opts = { optimize: false, noRuntime: true } as any;
    const rawOpts = { ...opts, optBlockState: true };
    const generated = toJs(mod, opts);
    const out = exec(generated);
    deepStrictEqual([out.same(0), out.same(7)], [0, 7]);
    const wasmFn = toMod(mod, rawOpts).wasmMod.functions.find((fn) => fn.name === 'same');
    deepStrictEqual(
      {
        jsAssignments: generated.raw.match(/s\d+ = v\d+;/g) || [],
        wasmLocals: wasmFn?.locals || [],
        wasmLocalSets: (wasmFn?.instructions || []).filter((i) => i.TAG === 'local.set'),
      },
      {
        jsAssignments: [],
        wasmLocals: [],
        wasmLocalSets: [],
      }
    );
  });

  it('block no-op state can keep old saved-state lowering when disabled', () => {
    const mod = blockStateChurn();
    const opts = { optimize: false, noRuntime: true, optBlockState: false } as any;
    const generated = toJs(mod, opts);
    const out = exec(generated);
    deepStrictEqual([out.same(0), out.same(7)], [0, 7]);
    const wasmFn = toMod(mod, opts).wasmMod.functions.find((fn) => fn.name === 'same');
    deepStrictEqual(
      {
        jsAssignments: generated.raw.match(/s\d+ = v\d+;/g) || [],
        wasmLocals: wasmFn?.locals || [],
        wasmLocalSets: (wasmFn?.instructions || []).filter((i) => i.TAG === 'local.set'),
      },
      {
        jsAssignments: ['s0 = v0;'],
        wasmLocals: [{ type: 'i32', count: 1 }],
        wasmLocalSets: [{ TAG: 'local.set', data: 1n }],
      }
    );
  });

  it('public Wasm defaults keep saved block state while JS keeps passthrough', () => {
    const opts = { optimize: false, noRuntime: true } as any;
    const wasm = toWasm(blockStateChurn(), opts).raw;
    const wasmSaved = toWasm(blockStateChurn(), { ...opts, optBlockState: false }).raw;
    const wasmPassthrough = toWasm(blockStateChurn(), { ...opts, optBlockState: true }).raw;
    const js = toJs(blockStateChurn(), opts).raw;
    const jsSaved = toJs(blockStateChurn(), { ...opts, optBlockState: false }).raw;
    const jsPassthrough = toJs(blockStateChurn(), { ...opts, optBlockState: true }).raw;
    // Wasm's saved-state form combines better with scalar64 reducer trees, while JS keeps the
    // smaller passthrough form. Explicit options must continue to override both defaults.
    deepStrictEqual(wasm, wasmSaved);
    throws(() => deepStrictEqual(wasm, wasmPassthrough));
    deepStrictEqual(js, jsPassthrough);
    throws(() => deepStrictEqual(js, jsSaved));
  });

  it('ModuleGraph reuses duplicate pure op nodes on creation by default', () => {
    const mg = graph('reuse_edges');
    const ids: string[] = [];
    mg.subgraph(
      'function',
      'main',
      { inputs: [], outputs: [], memOps: {}, opts: {}, embedFns: {}, embedPos: 0 },
      () => {
        const { u32 } = mg.types;
        const oneA = u32.const(1);
        const oneB = u32.const(1);
        const addA = u32.add(oneA, oneB);
        const addB = u32.add(oneA, oneB);
        const addC = u32.add(oneB, oneA);
        ids.push(oneA.idx, oneB.idx, addA.idx, addB.idx, addC.idx);
      }
    );
    mg.subgraph(
      'function',
      'other',
      { inputs: [], outputs: [], memOps: {}, opts: {}, embedFns: {}, embedPos: 0 },
      () => {
        const { u32 } = mg.types;
        const oneA = u32.const(1);
        const oneB = u32.const(1);
        const addA = u32.add(oneA, oneB);
        const addB = u32.add(oneA, oneB);
        const addC = u32.add(oneB, oneA);
        ids.push(oneA.idx, oneB.idx, addA.idx, addB.idx, addC.idx);
      }
    );
    deepStrictEqual(ids, ['0.0', '0.0', '0.1', '0.1', '0.1', '1.0', '1.0', '1.1', '1.1', '1.1']);
  });

  it('construction CSE keeps reusing nodes after rewrite starts', () => {
    const mg = graph('reuse_phase');
    const ids: string[] = [];
    mg.addFn('before', {
      inputs: [],
      cb() {
        const { u32 } = mg.types;
        const one = u32.const(1);
        ids.push(one.idx, u32.const(1).idx);
        return one;
      },
    });
    mg.rewrite({ optimize: false });
    mg.ops.scope('0', () => {
      const { u32 } = mg.types;
      ids.push(u32.const(1).idx);
    });
    mg.addFn('after', {
      inputs: [],
      cb() {
        const { u32 } = mg.types;
        ids.push(u32.const(1).idx, u32.const(1).idx);
        return u32.const(1);
      },
    });
    deepStrictEqual(ids, ['0.0', '0.0', '0.0', '1.0', '1.0']);
  });

  it('construction CSE keeps scope-local duplicate ops separate', () => {
    const mg = graph('reuse_scope');
    const ids: string[] = [];
    mg.subgraph(
      'function',
      'main',
      { inputs: [], outputs: [], memOps: {}, opts: {}, embedFns: {}, embedPos: 0 },
      () => {
        const { u32 } = mg.types;
        const top = u32.const(1);
        mg.subgraph('block', '', { args: [], outputs: [], opts: {}, shape: undefined }, () => {
          ids.push(top.idx, u32.const(1).idx, u32.const(1).idx);
        });
      }
    );
    deepStrictEqual(ids, ['0.0', '0.1.0', '0.1.0']);
  });

  it('construction CSE applies to direct TreeDAG add sites', () => {
    const mg = graph('reuse_direct_add');
    const ids: string[] = [];
    mg.subgraph(
      'function',
      'main',
      { inputs: [], outputs: [], memOps: {}, opts: {}, embedFns: {}, embedPos: 0 },
      () => {
        const node = {
          kind: 'op' as const,
          type: 'u32' as const,
          op: 'const',
          args: [],
          opts: { value: 1, type: 'u32' },
        };
        ids.push(mg.ops.add(node), mg.ops.add({ ...node, opts: { ...node.opts } }));
      }
    );
    deepStrictEqual(ids, ['0.0', '0.0']);
  });

  it('construction CSE survives generated code lowering', () => {
    const mod = new Module('reuse_lowering').fn('run', ['u32'], 'u32', (f, x) =>
      f.types.u32.add(f.types.u32.rotl(x, 7), f.types.u32.rotl(x, 7))
    );
    const out = exec(toJs(mod, { noRuntime: true }));
    deepStrictEqual(out.run(0x12345678), 878082066);
  });

  it('construction CSE reuses duplicate pure ops before rewrite variadic CSE', () => {
    const mg = graph('cse_edges');
    mg.addFn('run', {
      inputs: ['u32'],
      cb(f: any, x: any) {
        const { u32 } = mg.types;
        const oneA = u32.const(1);
        const oneB = u32.const(1);
        const addA = u32.add(x, oneA);
        const addB = u32.add(oneB, x);
        return u32.xor(addA, addB);
      },
    });
    mg.rewrite({ optimize: false, cseOps: true });
    deepStrictEqual(
      mg.ops.format(),
      formatted(
        ': module.cse_edges|0: function.run(u32, outputs=0.3)|0.0: u32.arg(pos=0)',
        '0.1: u32.const(value=1, type=u32)|0.2: u32.add(0.0, 0.1)|0.3: u32.xor(0.2, 0.2)'
      )
    );
  });

  it('construction CSE merges same memory reads with the same parent write', () => {
    let mg: ModuleGraph | undefined;
    const mod = new Module('mem_read_cse')
      .mem('state', array('u32', {}, 1))
      .fn('run', ['u32'], 'u32', (f, x) => {
        mg = f.rawFn;
        f.memory.state[0].set(x);
        const a = f.memory.state[0].get();
        const b = f.memory.state[0].get();
        return f.types.u32.add(a, b);
      });
    toMod(mod, { optimize: false, cseOps: false, motionOps: false } as any);
    deepStrictEqual(
      mg!.ops.format(),
      formatted(
        ': module.mem_read_cse|0: function.run(u32, outputs=0.4)|' +
          '0.0: u32.arg(pos=0)|0.1: u32.const(value=0, type=u32)',
        '0.2: u32.store(0.1, 0.0, align=32, size=undefined, lane=undefined, ' +
          'name=state, strong=, rawOffset=true, offset=0, weak=, isMut=true)',
        '0.3: u32.load(0.1, align=32, size=undefined, lane=undefined, src=undefined, ' +
          'name=state, strong=0.2, rawOffset=true, offset=0)',
        '0.4: u32.add(0.3, 0.3)'
      )
    );
  });

  it('construction CSE merges consecutive identical memory writes', () => {
    let mg: ModuleGraph | undefined;
    const mod = new Module('mem_write_cse')
      .mem('state', array('u32', {}, 1))
      .fn('run', ['u32'], 'u32', (f, x) => {
        mg = f.rawFn;
        f.memory.state[0].set(x);
        f.memory.state[0].set(x);
        return x;
      });
    toMod(mod, { optimize: false, cseOps: false, motionOps: false } as any);
    deepStrictEqual(
      mg!.ops.format(),
      formatted(
        ': module.mem_write_cse|0: function.run(u32, outputs=0.0)|' +
          '0.0: u32.arg(pos=0)|0.1: u32.const(value=0, type=u32)',
        '0.2: u32.store(0.1, 0.0, align=32, size=undefined, lane=undefined, ' +
          'name=state, strong=, rawOffset=true, offset=0, weak=, isMut=true)'
      )
    );
  });

  it('construction CSE keeps memory writes split across intervening reads', () => {
    let mg: ModuleGraph | undefined;
    const mod = new Module('mem_write_read_barrier')
      .mem('state', array('u32', {}, 1))
      .fn('run', ['u32'], 'u32', (f, x) => {
        mg = f.rawFn;
        f.memory.state[0].set(x);
        const y = f.memory.state[0].get();
        f.memory.state[0].set(x);
        return y;
      });
    toMod(mod, { optimize: false, cseOps: false, motionOps: false } as any);
    deepStrictEqual(
      mg!.ops.format(),
      formatted(
        ': module.mem_write_read_barrier|0: function.run(u32, outputs=0.3)|' +
          '0.0: u32.arg(pos=0)|0.1: u32.const(value=0, type=u32)',
        '0.2: u32.store(0.1, 0.0, align=32, size=undefined, lane=undefined, ' +
          'name=state, strong=, rawOffset=true, offset=0, weak=, isMut=true)',
        '0.3: u32.load(0.1, align=32, size=undefined, lane=undefined, src=undefined, ' +
          'name=state, strong=0.2, rawOffset=true, offset=0)',
        '0.4: u32.store(0.1, 0.0, align=32, size=undefined, lane=undefined, ' +
          'name=state, strong=0.2, rawOffset=true, offset=0, weak=0.3w, isMut=true)'
      )
    );
  });

  const wasmInstrs = (mod: Module, name = 'run', opts = {}) =>
    toMod(mod, {
      optimize: false,
      cseOps: false,
      motionOps: false,
      lowerWasm: true,
      wasmTee: false,
      ...opts,
    } as any)
      .wasmMod.functions.find((i) => i.name === name)!
      .instructions.map((i: any) => {
        if (i.data === undefined) return i.TAG;
        if (typeof i.data === 'bigint') return `${i.TAG} ${i.data}`;
        if (typeof i.data === 'number') return `${i.TAG} ${i.data}`;
        return `${i.TAG} ${i.data.align}:${i.data.offset}`;
      });
  const checkWasm = (mod: Module, ...rows: string[]) =>
    deepStrictEqual(wasmInstrs(mod), instructions(...rows));

  it('wasm uses the same load-fed variadic schedule for integer reducers', () => {
    // Available leaves (the local and consts) anchor a wide block: the load emits first
    // (heaviest producer), cheap leaves land on the early reduce edge, folds at the end.
    const mod = (op: 'add' | 'xor') =>
      new Module(`load_${op}_schedule`)
        .mem('state', array('u32', {}, 1))
        .fn('run', ['u32'], 'u32', (f, x) => {
          const { u32 } = f.types;
          return u32[op](f.memory.state[0].get(), x, u32.const(1), u32.const(2));
        });
    deepStrictEqual(
      (['add', 'xor'] as const).map((op) => ({ op, instrs: wasmInstrs(mod(op)) })),
      (['add', 'xor'] as const).map((op) => ({
        op,
        instrs: instructions(
          'i32.const 0|i32.load 2:0|local.get 0|i32.const 1|i32.const 2',
          `i32.${op}|i32.${op}|i32.${op}|local.tee 1|end`
        ),
      }))
    );
  });

  it('wasm does not inline loads past dependent writes', () => {
    const mod = new Module('load_write_barrier')
      .mem('state', array('u32', {}, 1))
      .fn('run', ['u32'], 'u32', (f, x) => {
        const { u32 } = f.types;
        const y = f.memory.state[0].get();
        f.memory.state[0].set(x);
        return u32.add(y, x, u32.const(1), u32.const(2));
      });
    checkWasm(
      mod,
      'i32.const 0|i32.load 2:0|local.set 1|i32.const 0|local.get 0|i32.store 2:0',
      'local.get 1|local.get 0|i32.const 1|i32.const 2|i32.add|i32.add|i32.add',
      'local.tee 2|end'
    );
  });

  it('wasm streams scalar all-producer variadics in sorted order', () => {
    // No available leaf to anchor a wide block: streaming keeps at most accumulator+leaf
    // live while each producer computes (the shape that fixed AES table-load reductions).
    const mod = new Module('schedule_scalar_stream').fn(
      'run',
      ['u32', 'u32', 'u32', 'u32'],
      'u32',
      (f, a, b, c, d) => {
        const { u32 } = f.types;
        return u32.add(u32.rotl(a, 1), u32.rotl(b, 2), u32.rotl(c, 3), u32.rotl(d, 4));
      }
    );
    checkWasm(
      mod,
      'local.get 0|i32.const 1|i32.rotl|local.get 1|i32.const 2|i32.rotl|i32.add',
      'local.get 2|i32.const 3|i32.rotl|i32.add|local.get 3|i32.const 4|i32.rotl|i32.add',
      'local.tee 4|end'
    );
  });

  it('wasm emits 32-bit SIMD variadics as source-order leaf blocks', () => {
    // Wide emission (leaves first, folds at the end) restores the fast reduction shape for
    // 32-bit rounds; streaming folds between SIMD producers was the measured sha1 regression.
    // Source order is kept: construction order already groups lanes/rounds (keccak/blake3).
    const mod = new Module('schedule_simd_wide').fn(
      'run',
      ['u32', 'u32', 'u32', 'u32'],
      'u32',
      (f, a, b, c, d) => {
        const { u32x4 } = f.types;
        const sum = u32x4.add(u32x4.splat(a), u32x4.splat(b), u32x4.splat(c), u32x4.splat(d));
        return u32x4.extractLane(sum, 0);
      }
    );
    checkWasm(
      mod,
      'local.get 0|i32x4.splat|local.get 1|i32x4.splat',
      'local.get 2|i32x4.splat|local.get 3|i32x4.splat',
      'i32x4.add|i32x4.add|i32x4.add|i32x4.extract_lane 0|local.tee 4|end'
    );
  });

  it('wasm keeps vector loads materialized before vector variadic reducers', () => {
    const mod = new Module('schedule_vector_load')
      .mem('state', array('u32x4', {}, 2))
      .fn('run', ['u32'], 'u32', (f, x) => {
        const { u32x4 } = f.types;
        const sum = u32x4.add(
          f.memory.state[0].get(),
          u32x4.splat(x),
          f.memory.state[1].get(),
          u32x4.const(1)
        );
        return u32x4.extractLane(sum, 0);
      });
    checkWasm(
      mod,
      'i32.const 0|v128.load 4:0|local.set 1|i32.const 0|v128.load 4:16|local.set 2',
      'local.get 1|local.get 0|i32x4.splat|local.get 2',
      'v128.const 79228162532711081671548469249|i32x4.add|i32x4.add|i32x4.add',
      'i32x4.extract_lane 0|local.tee 3|end'
    );
  });

  it('wasm emits scalar variadics with an available leaf as heavy-first blocks', () => {
    // An available leaf (const here) anchors a wide block; producers emit heavy-first so
    // cheap leaves land on the early reduce edge (fold-at-end reduces the last-pushed first).
    const mod = new Module('schedule_scalar_avail')
      .mem('state', array('u32', {}, 2))
      .fn('run', ['u32'], 'u32', (f, x) => {
        const { u32 } = f.types;
        return u32.add(
          f.memory.state[0].get(),
          u32.rotl(x, 7),
          f.memory.state[1].get(),
          u32.const(3)
        );
      });
    checkWasm(
      mod,
      'local.get 0|i32.const 7|i32.rotl|i32.const 0|i32.load 2:0',
      'i32.const 0|i32.load 2:4|i32.const 3|i32.add|i32.add|i32.add|local.tee 1|end'
    );
  });

  it('tee-less JS streams only reducers with lowered-wide provenance', () => {
    const mod = (wide: boolean) =>
      new Module(`schedule_js_wide_${wide}`).fn(
        'run',
        ['u32', 'u32', 'u32'],
        'u32',
        (f, a, b, c) => {
          const { u32 } = f.types;
          const sum = u32.add(u32.rotl(a, 1), u32.const(9), u32.rotl(b, 2), u32.rotl(c, 3));
          if (wide) (f.rawFn.ops.get(sum.idx) as any).wide = 64;
          return sum;
        }
      );
    deepStrictEqual(
      { wide: wasmInstrs(mod(true)), narrow: wasmInstrs(mod(false)) },
      {
        wide: instructions(
          'local.get 0|i32.const 1|i32.rotl|local.get 1|i32.const 2|i32.rotl|i32.add',
          'local.get 2|i32.const 3|i32.rotl|i32.add|i32.const 9|i32.add|local.tee 3|end'
        ),
        narrow: instructions(
          'local.get 0|i32.const 1|i32.rotl|local.get 1|i32.const 2|i32.rotl',
          'local.get 2|i32.const 3|i32.rotl|i32.const 9|i32.add|i32.add|i32.add',
          'local.tee 3|end'
        ),
      }
    );
  });

  it('wide integer lowering records reducer provenance for scheduling', () => {
    let mg: ModuleGraph | undefined;
    const mod = new Module('schedule_wide_origin')
      .mem('state', array('u64', {}, 3))
      .fn('run', ['u32'], 'u32', (f, input) => {
        mg = f.rawFn;
        const { u64 } = f.types;
        const pair = u64.xor(f.memory.state[0].get(), f.memory.state[1].get());
        f.memory.state[0].set(u64.xor(pair, f.memory.state[2].get()));
        return input;
      });
    // Keep the public ABI narrow so all virtual wide parts are consumed before final lowering.
    toMod(mod, { lowerU64: true } as any);
    const widths = new Set<number>();
    const ops: { type: string; args: number; wide: number }[] = [];
    mg!.ops.iter((node) => {
      if (node.kind === 'op' && (node as any).wide) widths.add((node as any).wide);
      if (node.kind === 'op' && node.op === 'xor')
        ops.push({ type: node.type, args: node.args.length, wide: (node as any).wide || 0 });
    });
    deepStrictEqual(
      { widths: [...widths], ops },
      {
        widths: [64],
        ops: [
          { type: 'i32', args: 2, wide: 64 },
          { type: 'i32', args: 2, wide: 64 },
          { type: 'i32', args: 2, wide: 64 },
          { type: 'i32', args: 2, wide: 64 },
        ],
      }
    );
  });

  it('cse preserves lowered-wide provenance when rebuilding reducers', () => {
    const mg = graph('cse_wide_origin');
    mg.addFn('run', {
      inputs: ['u32', 'u32', 'u32'],
      cb(f: any, a: any, b: any, c: any) {
        const { u32 } = f.types;
        const pair = u32.xor(a, b);
        (mg.ops.get(pair.idx) as any).wide = 64;
        const out = u32.xor(pair, c);
        (mg.ops.get(out.idx) as any).wide = 64;
        return out;
      },
    });
    mg.rewrite({ optimize: false, cseOps: true, motionOps: false } as any);
    const reducers: { args: number; wide: number }[] = [];
    mg.ops.iter((node) => {
      if (node.kind === 'op' && node.op === 'xor')
        reducers.push({ args: node.args.length, wide: (node as any).wide || 0 });
    });
    deepStrictEqual(reducers, [{ args: 3, wide: 64 }]);
  });

  it('wide provenance tracks element width rather than aggregate SIMD width', () => {
    let mg: ModuleGraph | undefined;
    const mod = new Module('schedule_narrow_simd_origin')
      .mem('state', array('u32x4', {}, 1))
      .fn('run', ['u32'], 'u32', (f, input) => {
        mg = f.rawFn;
        const { u32x4 } = f.types;
        f.memory.state[0].set(
          u32x4.add(f.memory.state[0].get(), u32x4.splat(input), u32x4.const(1), u32x4.const(2))
        );
        return input;
      });
    toMod(mod, {
      lowerSIMD: true,
      lowerU64: true,
      optimize: false,
      cseOps: false,
      motionOps: false,
    } as any);
    const widths = new Set<number>();
    mg!.ops.iter((node) => {
      if (node.kind === 'op' && (node as any).wide) widths.add((node as any).wide);
    });
    deepStrictEqual({ widths: [...widths] }, { widths: [] });
  });

  it('wasm balances 64-bit SIMD variadics in heavy-first order', () => {
    // A balanced expression tree shortens simultaneous 64-bit live ranges while preserving the
    // scheduler's generic heavy-first leaf order; this is cross-environment flat and materially
    // faster for the affected Apple-Silicon SHA-512 target.
    const mod = new Module('schedule_u64x2_balanced').fn(
      'run',
      ['u64x2', 'u64x2', 'u64x2', 'u64x2', 'u64x2'],
      'u64x2',
      (f, a, b, c, d, e) => {
        const { u64x2 } = f.types;
        return u64x2.add(a, b, c, d, e);
      }
    );
    checkWasm(
      mod,
      'local.get 0|local.get 1|i64x2.add|local.get 2|i64x2.add',
      'local.get 3|local.get 4|i64x2.add|i64x2.add|local.tee 5|end'
    );
  });

  it('wasm groups high-arity scalar64 variadics in source-order threes', () => {
    const mod = (five: boolean) =>
      new Module(`schedule_u64_chunks_${five}`).fn(
        'run',
        ['u64', 'u64', 'u64', 'u64', 'u64', 'u64'],
        'u64',
        (f, a, b, c, d, e, g) => {
          const { u64 } = f.types;
          const args = [a, u64.xor(b, c), d, u64.const(9)];
          if (five) args.push(u64.xor(e, g));
          return u64.add(...args);
        }
      );
    // Five operands cross the measured pressure boundary and keep construction order in
    // groups of three. Four operands retain the balanced heavy-first policy.
    deepStrictEqual(
      { four: wasmInstrs(mod(false)), five: wasmInstrs(mod(true)) },
      {
        four: instructions(
          'local.get 1|local.get 2|i64.xor|local.get 0|i64.add',
          'local.get 3|i64.const 9|i64.add|i64.add|local.tee 6|end'
        ),
        five: instructions(
          'local.get 0|local.get 1|local.get 2|i64.xor|local.get 3|i64.add|i64.add',
          'i64.const 9|local.get 4|local.get 5|i64.xor|i64.add|i64.add|local.tee 6|end'
        ),
      }
    );
  });

  it('cseOps does not reuse equal ops across sibling scopes', () => {
    const mg = graph('cse_scope');
    mg.addFn('run', {
      inputs: ['u32'],
      cb(f: any, x: any) {
        const { u32 } = f.types;
        const left = f.block([x], (x: any) => [u32.add(x, u32.const(1))])[0];
        const right = f.block([x], (x: any) => [u32.add(x, u32.const(1))])[0];
        return u32.xor(left, right);
      },
    });
    mg.rewrite({ optimize: false, cseOps: true });
    deepStrictEqual(
      mg.ops.format(),
      formatted(
        ': module.cse_scope|0: function.run(u32, outputs=0.5)|0.0: u32.arg(pos=0)',
        '0.1: block.(0.0, outputs=0.1.2)|0.1.0: u32.arg(pos=0, scope=0.1)',
        '0.1.1: u32.const(value=1, type=u32)|0.1.2: u32.add(0.1.0, 0.1.1)',
        '0.2: u32.nodeOutput(0.1, pos=0)|0.3: block.(0.0, outputs=0.3.2)',
        '0.3.0: u32.arg(pos=0, scope=0.3)|0.3.1: u32.const(value=1, type=u32)',
        '0.3.2: u32.add(0.3.0, 0.3.1)|0.4: u32.nodeOutput(0.3, pos=0)|0.5: u32.xor(0.2, 0.4)'
      )
    );
  });

  it('cseOps flattens single-use nested variadic ops', () => {
    const mg = graph('cse_variadic_flatten');
    mg.addFn('run', {
      inputs: ['u32', 'u32', 'u32'],
      cb(f: any, a: any, b: any, c: any) {
        const { u32 } = f.types;
        return u32.add(a, u32.add(b, c));
      },
    });
    mg.rewrite({ optimize: false, cseOps: true });
    deepStrictEqual(
      mg.ops.format(),
      formatted(
        ': module.cse_variadic_flatten|0: function.run(u32, u32, u32, outputs=0.5)',
        '0.0: u32.arg(pos=0)|0.1: u32.arg(pos=1)|0.2: u32.arg(pos=2)|0.5: u32.add(0.0, 0.1, 0.2)'
      )
    );
  });

  it('Wasm CSE keeps scalar64 reducer trees while JS flattens them', () => {
    const rewrite = (lowerWasm: boolean) => {
      const mg = graph('cse_u64_backend');
      mg.addFn('run', {
        inputs: ['u64', 'u64', 'u64'],
        cb(f: any, a: any, b: any, c: any) {
          const { u64 } = f.types;
          return u64.add(a, u64.add(b, c));
        },
      });
      mg.rewrite({ optimize: false, cseOps: true, motionOps: false, lowerWasm });
      return mg.ops.format();
    };
    deepStrictEqual(
      { js: rewrite(false), wasm: rewrite(true) },
      {
        js: formatted(
          ': module.cse_u64_backend|0: function.run(u64, u64, u64, outputs=0.5)',
          '0.0: u64.arg(pos=0)|0.1: u64.arg(pos=1)|0.2: u64.arg(pos=2)|0.5: u64.add(0.0, 0.1, 0.2)'
        ),
        wasm: formatted(
          ': module.cse_u64_backend|0: function.run(u64, u64, u64, outputs=0.4)',
          '0.0: u64.arg(pos=0)|0.1: u64.arg(pos=1)|0.2: u64.arg(pos=2)',
          '0.3: u64.add(0.1, 0.2)|0.4: u64.add(0.0, 0.3)'
        ),
      }
    );
  });

  it('cseOps rebuilds variadic ops through existing subsets', () => {
    const mg = graph('cse_variadic_subset');
    mg.addFn('run', {
      inputs: ['u32', 'u32', 'u32'],
      cb(f: any, a: any, b: any, c: any) {
        const { u32 } = f.types;
        const pair = u32.xor(b, a);
        return [pair, u32.xor(a, u32.xor(b, c))];
      },
    });
    mg.rewrite({ optimize: false, cseOps: true });
    deepStrictEqual(
      mg.ops.format(),
      formatted(
        ': module.cse_variadic_subset|0: function.run(u32, u32, u32, outputs=0.3, 0.6)',
        '0.0: u32.arg(pos=0)|0.1: u32.arg(pos=1)|0.2: u32.arg(pos=2)',
        '0.3: u32.xor(0.1, 0.0)|0.6: u32.xor(0.3, 0.2)'
      )
    );
  });

  it('cseOps rebuilds variadic add through existing subsets', () => {
    const mg = graph('cse_variadic_add_subset');
    mg.addFn('run', {
      inputs: ['u32', 'u32', 'u32'],
      cb(f: any, a: any, b: any, c: any) {
        const { u32 } = f.types;
        const pair = u32.add(b, a);
        return [pair, u32.add(a, u32.add(b, c))];
      },
    });
    mg.rewrite({ optimize: false, cseOps: true });
    deepStrictEqual(
      mg.ops.format(),
      formatted(
        ': module.cse_variadic_add_subset|0: function.run(u32, u32, u32, outputs=0.3, 0.6)',
        '0.0: u32.arg(pos=0)|0.1: u32.arg(pos=1)|0.2: u32.arg(pos=2)',
        '0.3: u32.add(0.1, 0.0)|0.6: u32.add(0.3, 0.2)'
      )
    );
  });

  it('cseOps rebuilds variadic add through multiple disjoint subsets', () => {
    const mg = graph('cse_variadic_multi_subset');
    mg.addFn('run', {
      inputs: ['u32', 'u32', 'u32', 'u32'],
      cb(f: any, a: any, b: any, c: any, d: any) {
        const { u32 } = f.types;
        const ab = u32.add(a, b);
        const cd = u32.add(c, d);
        return [ab, cd, u32.add(a, b, c, d)];
      },
    });
    mg.rewrite({ optimize: false, cseOps: true });
    deepStrictEqual(
      mg.ops.format(),
      formatted(
        ': module.cse_variadic_multi_subset|0: function.run(u32, u32, u32, u32, ' +
          'outputs=0.4, 0.5, 0.7)',
        '0.0: u32.arg(pos=0)|0.1: u32.arg(pos=1)|0.2: u32.arg(pos=2)|0.3: u32.arg(pos=3)',
        '0.4: u32.add(0.0, 0.1)|0.5: u32.add(0.2, 0.3)|0.7: u32.add(0.4, 0.5)'
      )
    );
  });

  it('cseOps reuses ancestor variadic subsets in descendant blocks', () => {
    const mg = graph('cse_variadic_ancestor_subset');
    mg.addFn('run', {
      inputs: ['u32', 'u32', 'u32'],
      cb(f: any, a: any, b: any, c: any) {
        const { u32 } = f.types;
        const ab = u32.add(a, b);
        const out = f.block([c], (c: any) => [u32.add(a, b, c)])[0];
        return [ab, out];
      },
    });
    mg.rewrite({ optimize: false, cseOps: true });
    deepStrictEqual(
      mg.ops.format(),
      formatted(
        ': module.cse_variadic_ancestor_subset|0: function.run(u32, u32, u32, outputs=0.3, 0.5)',
        '0.0: u32.arg(pos=0)|0.1: u32.arg(pos=1)|0.2: u32.arg(pos=2)|0.3: u32.add(0.0, 0.1)',
        '0.4: block.(0.2, outputs=0.4.2)|0.4.0: u32.arg(pos=0, scope=0.4)',
        '0.4.2: u32.add(0.3, 0.4.0)|0.5: u32.nodeOutput(0.4, pos=0)'
      )
    );
  });

  it('cseOps does not reuse child variadic subsets in parent blocks', () => {
    const mg = graph('cse_variadic_child_subset');
    mg.addFn('run', {
      inputs: ['u32', 'u32', 'u32'],
      cb(f: any, a: any, b: any, c: any) {
        const { u32 } = f.types;
        const child = f.block([c], () => [u32.add(a, b)])[0];
        return [child, u32.add(a, b, c)];
      },
    });
    mg.rewrite({ optimize: false, cseOps: true });
    deepStrictEqual(
      mg.ops.format(),
      formatted(
        ': module.cse_variadic_child_subset|0: function.run(u32, u32, u32, outputs=0.4, 0.5)',
        '0.0: u32.arg(pos=0)|0.1: u32.arg(pos=1)|0.2: u32.arg(pos=2)',
        '0.3: block.(0.2, outputs=0.3.1)|0.3.1: u32.add(0.0, 0.1)',
        '0.4: u32.nodeOutput(0.3, pos=0)|0.5: u32.add(0.0, 0.1, 0.2)'
      )
    );
  });

  it('cseOps does not reuse sibling variadic subsets', () => {
    const mg = graph('cse_variadic_sibling_subset');
    mg.addFn('run', {
      inputs: ['u32', 'u32', 'u32'],
      cb(f: any, a: any, b: any, c: any) {
        const { u32 } = f.types;
        const left = f.block([a], () => [u32.add(a, b)])[0];
        const right = f.block([c], (c: any) => [u32.add(a, b, c)])[0];
        return [left, right];
      },
    });
    mg.rewrite({ optimize: false, cseOps: true });
    deepStrictEqual(
      mg.ops.format(),
      formatted(
        ': module.cse_variadic_sibling_subset|0: function.run(u32, u32, u32, outputs=0.4, 0.6)',
        '0.0: u32.arg(pos=0)|0.1: u32.arg(pos=1)|0.2: u32.arg(pos=2)',
        '0.3: block.(0.0, outputs=0.3.1)|0.3.1: u32.add(0.0, 0.1)',
        '0.4: u32.nodeOutput(0.3, pos=0)|0.5: block.(0.2, outputs=0.5.1)',
        '0.5.0: u32.arg(pos=0, scope=0.5)|0.5.1: u32.add(0.0, 0.1, 0.5.0)',
        '0.6: u32.nodeOutput(0.5, pos=0)'
      )
    );
  });

  it('icse rematerializes binary reducers without cloning variadic reducers', () => {
    const mg = graph('icse_arity');
    mg.addFn('run', {
      inputs: ['u32', 'u32', 'u32', 'u32'],
      cb(f: any, a: any, b: any, c: any, d: any) {
        const { u32 } = f.types;
        const binary = u32.add(a, b);
        const variadic = u32.add(a, b, c);
        return [u32.xor(binary, c), u32.xor(binary, d), u32.xor(variadic, a), u32.xor(variadic, d)];
      },
    });
    rewriteIcse(mg);
    deepStrictEqual(
      mg.ops.format(),
      formatted(
        ': module.icse_arity|0: function.run(u32, u32, u32, u32, outputs=0.11, 0.7, 0.8, 0.9)',
        '0.0: u32.arg(pos=0)|0.1: u32.arg(pos=1)|0.2: u32.arg(pos=2)|0.3: u32.arg(pos=3)',
        '0.4: u32.add(0.0, 0.1)|0.5: u32.add(0.0, 0.1, 0.2)|0.7: u32.xor(0.4, 0.3)',
        '0.8: u32.xor(0.5, 0.0)|0.9: u32.xor(0.5, 0.3)',
        '0.10: u32.add(0.0, 0.1, icse=1)|0.11: u32.xor(0.10, 0.2)'
      )
    );
  });

  it('icse keeps shared values materialized for duplicated JS rotate operands', () => {
    const mg = graph('icse_linear_consumers');
    mg.addFn('run', {
      inputs: ['u32', 'u32', 'u32', 'u32'],
      cb(f: any, a: any, b: any, c: any, d: any) {
        const { u32 } = f.types;
        const sum = u32.add(a, b);
        const mask = u32.and(a, b);
        return [u32.rotr(sum, 7), u32.xor(sum, c), u32.xor(mask, c), u32.xor(mask, d)];
      },
    });
    rewriteIcse(mg, { lowerWasm: false });
    // Numeric rotate shifts occupy an i32 constant slot before ICSE rewrites the graph.
    deepStrictEqual(
      mg.ops.format(),
      formatted(
        ': module.icse_linear_consumers|0: function.run(u32, u32, u32, u32, ' +
          'outputs=0.7, 0.8, 0.12, 0.10)',
        '0.0: u32.arg(pos=0)|0.1: u32.arg(pos=1)|0.2: u32.arg(pos=2)|0.3: u32.arg(pos=3)',
        '0.4: u32.add(0.0, 0.1)|0.5: u32.and(0.0, 0.1)|0.6: i32.const(value=7, type=i32)',
        '0.7: u32.rotr(0.4, 0.6)|0.8: u32.xor(0.4, 0.2)|0.10: u32.xor(0.5, 0.3)',
        '0.11: u32.and(0.0, 0.1, icse=1)|0.12: u32.xor(0.11, 0.2)'
      )
    );
  });

  it('icse only runs at the high shared ALU pressure boundary', () => {
    const mg = graph('icse_pressure');
    const add = (name: string, count: number) =>
      mg.addFn(name, {
        inputs: ['u32'],
        cb(f: any, input: any) {
          const { u32 } = f.types;
          const values = [];
          let value = input;
          for (let i = 0; i < count; i++) {
            value = u32.add(value, u32.const(i + 1));
            values.push(value);
          }
          return u32.xor(...values);
        },
      });
    add('below', 64);
    add('at', 65);
    rewritePressureIcse(mg);
    const clones = { below: 0, at: 0 };
    mg.ops.iter((node, idx) => {
      if (node.kind !== 'op' || node.opts.icse === undefined) return;
      const owner = mg.ops.getStack(idx).find(({ node }) => node.kind === 'function')?.node;
      if (owner?.kind === 'function') clones[owner.name as keyof typeof clones]++;
    });
    deepStrictEqual(clones, { below: 0, at: 32 });
  });

  it('icse bounds rematerialization for high-fanout values', () => {
    const mg = graph('icse_fanout');
    const add = (name: string, users: number) =>
      mg.addFn(name, {
        inputs: ['u32'],
        cb(f: any, input: any) {
          const { u32 } = f.types;
          const value = u32.add(input, u32.const(1));
          const uses = Array.from({ length: users }, (_, i) =>
            u32.xor(value, u32.const(0x1000 + i))
          );
          return u32.add(...uses);
        },
      });
    add('bounded', 16);
    add('excessive', 17);
    rewriteIcse(mg);
    const clones = { bounded: 0, excessive: 0 };
    mg.ops.iter((node, idx) => {
      if (node.kind !== 'op' || node.opts.icse === undefined) return;
      const owner = mg.ops.getStack(idx).find(({ node }) => node.kind === 'function')?.node;
      if (owner?.kind === 'function') clones[owner.name as keyof typeof clones]++;
    });
    // The final consumer keeps the original value, so a 16-user value needs only 15 clones.
    deepStrictEqual(clones, { bounded: 15, excessive: 0 });
  });

  it('icse pressure excludes values pinned by non-retireable consumers', () => {
    const mg = graph('icse_retireable_pressure');
    mg.addFn('blocked', {
      inputs: ['u32'],
      cb(f: any, input: any) {
        const { u32 } = f.types;
        const values = [];
        const rotations = [];
        for (let i = 0; i < 64; i++) {
          const value = u32.add(input, u32.const(i + 1));
          values.push(value);
          rotations.push(u32.rotr(value, (i % 31) + 1));
        }
        const mask = u32.and(input, u32.const(0xff));
        return u32.xor(...values, ...rotations, u32.xor(mask, input), u32.xor(mask, values[0]));
      },
    });
    rewritePressureIcse(mg);
    let clones = 0;
    mg.ops.iter((node) => {
      if (node.kind === 'op' && node.opts.icse !== undefined) clones++;
    });
    deepStrictEqual(clones, 0);
  });

  it('icse pressure counts only reducers the pass can rematerialize', () => {
    const mg = graph('icse_actionable_pressure');
    mg.addFn('run', {
      inputs: ['u32'],
      cb(f: any, input: any) {
        const { u32 } = f.types;
        // These values overlap and have retireable users, but their ternary reducers are not
        // ICSE candidates. They must not enable cloning for an unrelated binary reducer.
        const values = Array.from({ length: 64 }, (_, i) =>
          u32.add(input, u32.const(i + 1), u32.const(i + 2))
        );
        const uses = values.flatMap((value) => [u32.xor(value, input), u32.and(value, input)]);
        const mask = u32.and(input, u32.const(0xff));
        return u32.xor(...uses, u32.xor(mask, input), u32.xor(mask, values[0]));
      },
    });
    rewritePressureIcse(mg);
    let clones = 0;
    mg.ops.iter((node) => {
      if (node.kind === 'op' && node.opts.icse !== undefined) clones++;
    });
    deepStrictEqual(clones, 0);
  });

  it('motionOps sinks pure outer ops into their only inner block users', () => {
    const mg = graph('motion_sink_block');
    mg.addFn('run', {
      inputs: ['u32'],
      cb(f: any, x: any) {
        const { u32 } = f.types;
        const add = u32.add(x, u32.const(7));
        return f.block([x], () => [u32.xor(add, u32.const(1))])[0];
      },
    });
    mg.rewrite({ optimize: false, cseOps: false, motionOps: true } as any);
    deepStrictEqual(
      mg.ops.format(),
      formatted(
        ': module.motion_sink_block|0: function.run(u32, outputs=0.4)|0.0: u32.arg(pos=0)',
        '0.3: block.(0.0, outputs=0.3.3)|0.3.0: u32.const(value=1, type=u32)',
        '0.3.1: u32.const(value=7, type=u32)|0.3.2: u32.add(0.0, 0.3.1)',
        '0.3.3: u32.xor(0.3.2, 0.3.0)|0.4: u32.nodeOutput(0.3, pos=0)'
      )
    );
  });

  it('motionOps hoists loop-invariant pure ops out of loops', () => {
    const mg = graph('motion_hoist_loop');
    mg.addFn('run', {
      inputs: ['u32'],
      cb(f: any, x: any) {
        const { u32 } = f.types;
        return f.block(
          [x],
          (state: any) => {
            const inv = u32.add(x, u32.const(3));
            return [u32.add(state, inv)];
          },
          true
        )[0];
      },
    });
    mg.rewrite({ optimize: false, cseOps: false, motionOps: true } as any);
    deepStrictEqual(
      mg.ops.format(),
      formatted(
        ': module.motion_hoist_loop|0: function.run(u32, outputs=0.4)|0.0: u32.arg(pos=0)',
        '0.1: u32.const(value=3, type=u32)|0.2: u32.add(0.0, 0.1)',
        '0.3: loop.(0.0, outputs=0.3.1)|0.3.0: u32.arg(pos=0, scope=0.3)',
        '0.3.1: u32.add(0.3.0, 0.2)|0.4: u32.nodeOutput(0.3, pos=0)'
      )
    );
  });

  it('motionOps does not sink load-dependent ops into blocks', () => {
    let mg: ModuleGraph | undefined;
    const mod = new Module('motion_load_barrier')
      .mem('state', array('u32', {}, 1))
      .fn('run', ['u32'], 'u32', (f, x) => {
        mg = f.rawFn;
        const { u32 } = f.types;
        const loaded = f.memory.state[0].get();
        const add = u32.add(loaded, x);
        return f.block([x], () => [u32.xor(add, u32.const(1))])[0];
      });
    toMod(mod, { optimize: false, cseOps: false, motionOps: true } as any);
    deepStrictEqual(
      mg!.ops.format(),
      formatted(
        ': module.motion_load_barrier|0: function.run(u32, outputs=0.5)|' +
          '0.0: u32.arg(pos=0)|0.1: u32.const(value=0, type=u32)',
        '0.2: u32.load(0.1, align=32, size=undefined, lane=undefined, src=undefined, ' +
          'name=state, strong=, rawOffset=true, offset=0)',
        '0.3: u32.add(0.2, 0.0)|0.4: block.(0.0, outputs=0.4.2)',
        '0.4.1: u32.const(value=1, type=u32)|' +
          '0.4.2: u32.xor(0.3, 0.4.1)|0.5: u32.nodeOutput(0.4, pos=0)'
      )
    );
  });

  it('wasmTee still inlines tee-backed single-use expressions in the same control scope', () => {
    const mod = new Module('tee_same_scope').fn('run', ['u32'], 'u32', (f, x) => {
      const { u32 } = f.types;
      const base = u32.add(x, u32.const(1));
      const via = u32.sub(base, u32.const(2));
      return u32.add(via, base);
    });
    const out = exec(toWasm(mod, { noRuntime: true }));
    const wasmFn = toMod(mod, {
      noRuntime: true,
      optimize: false,
      wasmBlockType: true,
      wasmTee: true,
    }).wasmMod.functions.find((fn) => fn.name === 'run');
    deepStrictEqual(out.run(10), 20);
    deepStrictEqual(
      {
        locals: wasmFn?.locals,
        instructions: wasmFn?.instructions,
      },
      {
        locals: [{ type: 'i32', count: 2 }],
        instructions: [
          { TAG: 'local.get', data: 0n },
          { TAG: 'i32.const', data: 1n },
          { TAG: 'i32.add' },
          { TAG: 'local.tee', data: 1n },
          { TAG: 'i32.const', data: 2n },
          { TAG: 'i32.sub' },
          { TAG: 'local.get', data: 1n, info: 'first' },
          { TAG: 'i32.add' },
          { TAG: 'local.tee', data: 2n },
          { TAG: 'end' },
        ],
      }
    );
  });

  it('wasm schedules variadic operands as heavy-first wide blocks', () => {
    // Available leaves (d, the const) anchor a wide block: producers emit heaviest-first as
    // an uninterrupted leaf block, folds happen at the end with cheap leaves on the early
    // reduce edge. Interleaving folds between producers was the measured md5/ripemd shape
    // collapse; the block form matches the fast June-30-era output.
    const mod = new Module('schedule_variadic_args').fn(
      'run',
      ['u32', 'u32', 'u32', 'u32'],
      'u32',
      (f, a, b, c, d) => {
        const { u32 } = f.types;
        const heavy = u32.shl(u32.mul(a, b), u32.const(6));
        const light = u32.shl(c, u32.const(6));
        return u32.add(u32.const(192), light, heavy, d);
      }
    );
    const instrs = toMod(mod, {
      optimize: true,
      lowerWasm: true,
      wasmTee: false,
    })
      .wasmMod.functions.find((i) => i.name === 'run')!
      .instructions.map((i: any) => `${i.TAG}${i.data !== undefined ? ` ${i.data}` : ''}`);
    deepStrictEqual(
      instrs,
      instructions(
        'local.get 0|local.get 1|i32.mul|i32.const 6|i32.shl',
        'local.get 2|i32.const 6|i32.shl|local.get 3|i32.const 192',
        'i32.add|i32.add|i32.add|local.tee 4|end'
      )
    );
  });

  it('wasmTee keeps parent value live when an if-only block is skipped', () => {
    const mod = new Module('tee_if_skip')
      .mem('state', array('u32', {}, 1))
      .fn('run', ['u32', 'u32'], 'u32', (f, x, cond) => {
        const { u32 } = f.types;
        const base = u32.add(x, u32.const(10));
        const via = u32.sub(base, u32.const(3));
        f.ifElse(cond, [], () => {
          f.memory.state[0].set(via);
        });
        return u32.add(base, u32.const(100));
      });
    deepStrictEqual(runBoth(mod, binaryCases), both(binaryCases, [115, 115, 110, 110]));
  });

  it('wasmTee inlines tee-backed single-use expressions in unconditional nested blocks', () => {
    const mod = new Module('tee_nested_block_inline')
      .mem('state', array('u32', {}, 1))
      .fn('run', ['u32'], 'u32', (f, x) => {
        const { u32 } = f.types;
        const base = u32.add(x, u32.const(10));
        const via = u32.sub(base, u32.const(3));
        f.block([], () => {
          f.memory.state[0].set(via);
          return [];
        });
        return u32.add(base, u32.const(100));
      });
    const out = exec(toWasm(mod, teeOpts));
    const wasmFn = toMod(mod, teeOpts).wasmMod.functions.find((fn) => fn.name === 'run');
    deepStrictEqual(out.run(5), 115);
    deepStrictEqual(
      {
        locals: wasmFn?.locals,
        localSets: (wasmFn?.instructions || []).filter((i) => i.TAG === 'local.set'),
        instructions: wasmFn?.instructions,
      },
      {
        locals: [{ type: 'i32', count: 2 }],
        localSets: [],
        instructions: [
          { TAG: 'block', data: { inputs: [], outputs: [] }, hoist: [] },
          { TAG: 'i32.const', data: 0n },
          { TAG: 'local.get', data: 0n },
          { TAG: 'i32.const', data: 10n },
          { TAG: 'i32.add' },
          { TAG: 'local.tee', data: 1n },
          { TAG: 'i32.const', data: 3n },
          { TAG: 'i32.sub' },
          {
            TAG: 'i32.store',
            data: {
              align: 2,
              offset: 0,
              swapEndianness: undefined,
              trustedAlign: true,
            },
          },
          { TAG: 'end' },
          { TAG: 'local.get', data: 1n, info: 'first' },
          { TAG: 'i32.const', data: 100n },
          { TAG: 'i32.add' },
          { TAG: 'local.tee', data: 2n },
          { TAG: 'end' },
        ],
      }
    );
  });

  it('wasmTee keeps parent value live across both ifElse arms', () => {
    const mod = new Module('tee_if_else')
      .mem('state', array('u32', {}, 1))
      .fn('run', ['u32', 'u32'], 'u32', (f, x, cond) => {
        const { u32 } = f.types;
        const base = u32.add(x, u32.const(10));
        const thenVal = u32.sub(base, u32.const(3));
        const elseVal = u32.add(base, u32.const(7));
        f.ifElse(
          cond,
          [],
          () => {
            f.memory.state[0].set(thenVal);
          },
          () => {
            f.memory.state[0].set(elseVal);
          }
        );
        return u32.add(base, f.memory.state[0].get());
      });
    deepStrictEqual(runBoth(mod, binaryCases), both(binaryCases, [37, 27, 27, 17]));
  });

  it('wasmTee keeps parent value live when an inner block breaks before first use', () => {
    const mod = new Module('tee_inner_break')
      .mem('state', array('u32', {}, 1))
      .fn('run', ['u32', 'u32'], 'u32', (f, x, skip) => {
        const { u32 } = f.types;
        const base = u32.add(x, u32.const(10));
        const via = u32.sub(base, u32.const(3));
        f.block([], () => {
          f.brIf(0, skip);
          f.memory.state[0].set(via);
          return [];
        });
        return u32.add(base, u32.const(100));
      });
    deepStrictEqual(runBoth(mod, binaryCases), both(binaryCases, [115, 115, 110, 110]));
  });

  it('wasmTee keeps outer-branch values live when a nested if-only block is skipped', () => {
    const mod = new Module('tee_nested_if_skip')
      .mem('state', array('u32', {}, 2))
      .fn('run', ['u32', 'u32', 'u32'], 'u32', (f, x, outer, inner) => {
        const { u32 } = f.types;
        f.memory.state[0].set(u32.const(0));
        f.memory.state[1].set(u32.const(0));
        f.ifElse(outer, [], () => {
          const base = u32.add(x, u32.const(10));
          const via = u32.sub(base, u32.const(3));
          f.ifElse(inner, [], () => {
            f.memory.state[0].set(via);
          });
          f.memory.state[1].set(base);
        });
        return u32.add(f.memory.state[0].get(), f.memory.state[1].get());
      });
    deepStrictEqual(runBoth(mod, nestedCases), both(nestedCases, [0, 15, 27]));
  });

  it('wasmTee keeps outer-branch values live across nested ifElse arms', () => {
    const mod = new Module('tee_nested_if_else')
      .mem('state', array('u32', {}, 2))
      .fn('run', ['u32', 'u32', 'u32'], 'u32', (f, x, outer, inner) => {
        const { u32 } = f.types;
        f.memory.state[0].set(u32.const(0));
        f.memory.state[1].set(u32.const(0));
        f.ifElse(outer, [], () => {
          const base = u32.add(x, u32.const(10));
          const thenVal = u32.sub(base, u32.const(3));
          const elseVal = u32.add(base, u32.const(7));
          f.ifElse(
            inner,
            [],
            () => {
              f.memory.state[0].set(thenVal);
            },
            () => {
              f.memory.state[0].set(elseVal);
            }
          );
          f.memory.state[1].set(base);
        });
        return u32.add(f.memory.state[0].get(), f.memory.state[1].get());
      });
    deepStrictEqual(runBoth(mod, nestedCases), both(nestedCases, [0, 37, 27]));
  });

  it('wasmTee keeps parent value live when a counted loop has zero iterations', () => {
    const mod = new Module('tee_zero_loop')
      .mem('state', array('u32', {}, 1))
      .fn('run', ['u32', 'u32'], 'u32', (f, x, count) => {
        const { u32 } = f.types;
        const base = u32.add(x, u32.const(10));
        const via = u32.sub(base, u32.const(3));
        f.doN([], count, () => {
          f.memory.state[0].set(via);
          return [];
        });
        return u32.add(base, u32.const(100));
      });
    const cases = [
      [5, 0],
      [5, 1],
      [5, 3],
    ];
    deepStrictEqual(runBoth(mod, cases), both(cases, [115, 115, 115]));
  });

  it('wasmTee handles branch-yield values without hiding later fallthrough reads', () => {
    const mod = new Module('tee_branch_yield').fn('run', ['u32', 'u32'], 'u32', (f, x, cond) => {
      const { u32 } = f.types;
      let out = u32.const(0);
      [out] = f.block([out], (out) => {
        const base = u32.add(x, u32.const(10));
        const via = u32.sub(base, u32.const(3));
        f.block([], () => {
          f.brIf(1, cond, via);
          return [];
        });
        return [base];
      });
      return out;
    });
    deepStrictEqual(runBoth(mod, binaryCases), both(binaryCases, [15, 12, 10, 7]));
  });

  it('TreeDAG rejects values that escape from an inner control scope', () => {
    const mod = new Module('tee_scope_escape').fn('run', ['u32', 'u32'], 'u32', (f, x, cond) => {
      const { u32 } = f.types;
      let escaped: any;
      f.ifElse(cond, [], () => {
        escaped = u32.add(x, u32.const(1));
      });
      return u32.add(escaped, u32.const(2));
    });
    throws(() => toWasm(mod, teeOpts), /TreeDAG\.check edge\(0\.2\.3\) to child from 0\.4/);
    throws(() => toJs(mod, teeOpts), /TreeDAG\.check edge\(0\.2\.3\) to child from 0\.4/);
  });

  it('cseOps keeps wasmTee assignments outside conditional single-use consumers', () => {
    const mod = new Module('cse_tee_conditional')
      .mem('state', struct({ d: array('u32', {}, 4), tmp: array('u32', {}, 4) }))
      .mem('buffer', array('u32', {}, 8))
      .fn('run', ['u32', 'u32', 'u32'], 'void', (f, blocks, isLast, left) => {
        const { u32 } = f.types;
        const b = f.memory.buffer.as8('u8');
        const d8 = f.memory.state.d.as8('u8');
        const tmp = f.memory.state.tmp;
        const tmp8 = tmp.as8('u8');
        const isEmpty = u32.and(isLast, u32.eq(blocks, u32.const(0)));
        const bcount = u32.select(isEmpty, u32.const(1), blocks);
        const l = u32.select(isEmpty, u32.const(16), left);
        const lastIdx = u32.sub(bcount, u32.const(1));
        f.ifElse(u32.and(isLast, u32.ne(l, u32.const(0))), [], () => {
          const start = u32.sub(u32.mul(bcount, u32.const(16)), l);
          const lastStart = u32.sub(start, u32.const(16));
          const isMulti = u32.ne(u32.add(lastIdx, u32.const(1)), u32.const(1));
          f.ifElse(isMulti, [], () => {
            const pos = u32.add(lastStart, u32.const(0));
            const cur = u32.fromN('u8', b[pos].get());
            b[pos].set(u32.castTo('u8', u32.xor(cur, u32.const(1))));
          });
          b[start].set(u32.castTo('u8', u32.const(0x80)));
          b.range(u32.add(start, u32.const(1)), u32.add(start, l)).fill(0);
          f.ifElse(u32.eq(isMulti, u32.const(0)), [], () => {
            tmp8.range(0, 16).set(d8.get());
            let carry = u32.const(0);
            [carry] = f.doN1([carry], u32.const(16), (i: any, carry: any) => {
              const idx = u32.sub(u32.const(15), i);
              const v = u32.and(u32.fromN('u8', tmp8[idx].get()), u32.const(0xff));
              const n = u32.and(u32.or(u32.shl(v, 1), carry), u32.const(0xff));
              tmp8[idx].set(u32.castTo('u8', n));
              return [u32.shr(v, 7)];
            });
            const mask = u32.sub(u32.const(0), carry);
            tmp8[15].set(
              u32.castTo(
                'u8',
                u32.xor(u32.fromN('u8', tmp8[15].get()), u32.and(mask, u32.const(0x87)))
              )
            );
            for (let i = 0; i < 16; i++) {
              const cur = u32.fromN('u8', b[u32.const(i)].get());
              const tv = u32.fromN('u8', tmp8[u32.const(i)].get());
              b[u32.const(i)].set(u32.castTo('u8', u32.xor(cur, tv)));
            }
          });
        });
      });
    const d = hex.decode('edf09de876c642ee4d78bce4ceedfc4f');
    const res = [];
    for (const compile of [toJs, toWasm]) {
      const out = exec(compile(mod, { cseOps: true, noRuntime: true }));
      out.segments['state.d'].set(d);
      out.segments.buffer.fill(0xff);
      for (let i = 0; i < 14; i++) out.segments.buffer[i] = 0x11 + i;
      out.run(1, 1, 2);
      res.push({
        target: compile === toJs ? 'js' : 'wasm',
        buffer: hex.encode(out.segments.buffer.subarray(0, 20)),
        tmp: hex.encode(out.segments['state.tmp'].subarray(0, 16)),
      });
    }
    deepStrictEqual(res, [
      {
        target: 'js',
        buffer: 'caf328c4f89a92c483eb62d580c5781900000000',
        tmp: 'dbe13bd0ed8c85dc9af179c99ddbf819',
      },
      {
        target: 'wasm',
        buffer: 'caf328c4f89a92c483eb62d580c5781900000000',
        tmp: 'dbe13bd0ed8c85dc9af179c99ddbf819',
      },
    ]);
  });

  it('cseOps does not reassociate float variadic ops', () => {
    const mg = graph('cse_variadic_float');
    mg.addFn('run', {
      inputs: ['f64', 'f64', 'f64'],
      cb(f: any, a: any, b: any, c: any) {
        const { f64 } = f.types;
        return f64.add(a, f64.add(b, c));
      },
    });
    mg.rewrite({ optimize: false, cseOps: true });
    deepStrictEqual(
      mg.ops.format(),
      formatted(
        ': module.cse_variadic_float|0: function.run(f64, f64, f64, outputs=0.4)',
        '0.0: f64.arg(pos=0)|0.1: f64.arg(pos=1)|0.2: f64.arg(pos=2)',
        '0.3: f64.add(0.1, 0.2)|0.4: f64.add(0.0, 0.3)'
      )
    );
  });

  it('cseOps survives generated code lowering', () => {
    const mod = new Module('cse_lowering').fn('run', ['u32'], 'u32', (f, x) =>
      f.types.u32.add(f.types.u32.rotl(x, 7), f.types.u32.rotl(x, 7))
    );
    const out = exec(toJs(mod, { cseOps: true, noRuntime: true }));
    deepStrictEqual(out.run(0x12345678), 878082066);
  });

  it('public codegen enables cseOps by default', () => {
    const mod = new Module('default_cse').fn('run', ['u32'], 'u32', (f, x) => {
      const { u32 } = f.types;
      const incA = u32.add(x, u32.const(1));
      const incB = u32.add(x, u32.const(1));
      return u32.add(incA, incB);
    });
    const generated = toJs(mod, { noRuntime: true });
    const out = exec(generated);
    deepStrictEqual(out.run(4), 10);
    deepStrictEqual(
      generated.raw,
      `
const _importsEmbed = {env: {}};
_imports = {..._importsEmbed,..._imports, env: {..._importsEmbed.env, ..._imports.env}};


const __buf = new ArrayBuffer(0);
if (!(__buf instanceof ArrayBuffer)) throw new Error('wrong buffer');




function run(v0) {
    
    const v1 = ((1 + v0) | 0);
return ((v1 + v1) | 0);
}
const instance = { exports: {run, memory: { buffer: __buf }}};

;
const _exports = instance.exports;
const buffer = _exports.memory ? _exports.memory.buffer : new ArrayBuffer(0);
const memoryExport = new Uint8Array(buffer, 0, 0);
const segments = Object.freeze({});

return Object.freeze({ ..._exports, memory: memoryExport, segments  });`
    );
  });

  it('public codegen enables pressure-gated icse only for tee-less JS', () => {
    const mod = new Module('default_icse').fn('run', ['u32'], 'u32', (f, input) => {
      const { u32 } = f.types;
      const values = [];
      let value = input;
      // 65 chained values create the exact 64-value default-enablement boundary.
      for (let i = 0; i < 65; i++) {
        value = u32.add(value, u32.const(i + 1));
        values.push(value);
      }
      return u32.xor(...values);
    });
    const expected = toJs(mod, { noRuntime: true, icseOps: true });
    const generated = toJs(mod, { noRuntime: true });
    const disabled = toJs(mod, { noRuntime: true, icseOps: false });
    const wasm = toWasm(mod, { noRuntime: true });
    const wasmEnabled = toWasm(mod, { noRuntime: true, icseOps: true });
    const wasmDisabled = toWasm(mod, { noRuntime: true, icseOps: false });
    deepStrictEqual(
      {
        generated,
        jsResults: [exec(generated).run(5), exec(disabled).run(5)],
        wasm: [wasmEnabled, wasmDisabled],
        wasmResults: [exec(wasmEnabled).run(5), exec(wasmDisabled).run(5)],
      },
      {
        generated: expected,
        jsResults: [1350, 1350],
        wasm: [wasm, wasm],
        wasmResults: [1350, 1350],
      }
    );
  });

  it('default Wasm variadic lowering executes cheap multi-arg integer reducers', () => {
    const mod = new Module('wasm_variadic_tree').fn(
      'run',
      ['u32', 'u32', 'u32', 'u32'],
      'u32',
      (f, a, b, c, d) => [f.types.u32.add(a, b, c, d)]
    );
    const opts = {
      noRuntime: true,
      optimize: false,
      cseOps: false,
      motionOps: false,
      useSIMD: false,
    } as any;
    deepStrictEqual(exec(toWasm(mod, opts)).run(1, 2, 3, 4), 10);
    const instrs = toMod(mod, { ...opts, lowerWasm: true })
      .wasmMod.functions.find((fn) => fn.name === 'run')!
      .instructions.map((i) => `${i.TAG}${i.data !== undefined ? `:${i.data}` : ''}`);
    deepStrictEqual(
      instrs,
      instructions(
        'local.get:0|local.get:1|local.get:2|local.get:3',
        'i32.add|i32.add|i32.add|local.tee:4|end'
      )
    );
  });
});

it.runWhen(import.meta.url);
