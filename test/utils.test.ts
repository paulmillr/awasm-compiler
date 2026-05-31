import { describe, should } from '@paulmillr/jsbt/test.js';
import { deepStrictEqual, throws } from 'node:assert';
import * as types from '../src/types.ts';
import * as utils from '../src/utils.ts';

describe('Utils', () => {
  describe('Dimensions', () => {
    should('basic', () => {
      deepStrictEqual(utils.Dimensions(2, 4, 8).cardinality, 64);
      deepStrictEqual(utils.Dimensions(3, 5, 7).cardinality, 105);
    });
    should('integer domain', () => {
      throws(() => utils.Dimensions(1.5), /wrong dimension size/);
      throws(() => utils.Dimensions(Number.MAX_SAFE_INTEGER, 2), /wrong dimension cardinality/);
      const d = utils.Dimensions(3);
      throws(() => d.key.encode([1.5]), /wrong dimension position/);
      throws(() => d.key.decode(1.5), /idx key bounds/);
      throws(() => d.get([0, 1, 2], [1.5]), /wrong dimension position/);
      const target = [0, 1, 2];
      throws(() => d.set(target, [1.5], 9), /wrong dimension position/);
      deepStrictEqual(target, [0, 1, 2]);
    });
    should('flatKey', () => {
      const x = utils.Dimensions(5, 3, 2);
      const VECTORS = [
        [0, 0, 0],
        [0, 0, 1],
        [0, 1, 0],
        [0, 1, 1],
        [0, 2, 0],
        [0, 2, 1],
        [1, 0, 0],
        [1, 0, 1],
        [1, 1, 0],
        [1, 1, 1],
        [1, 2, 0],
        [1, 2, 1],
        [2, 0, 0],
        [2, 0, 1],
        [2, 1, 0],
        [2, 1, 1],
        [2, 2, 0],
        [2, 2, 1],
        [3, 0, 0],
        [3, 0, 1],
        [3, 1, 0],
        [3, 1, 1],
        [3, 2, 0],
        [3, 2, 1],
        [4, 0, 0],
        [4, 0, 1],
        [4, 1, 0],
        [4, 1, 1],
        [4, 2, 0],
        [4, 2, 1],
      ];
      for (let i = 0; i < x.cardinality; i++) {
        deepStrictEqual(VECTORS[i], x.key.decode(i));
        deepStrictEqual(x.key.encode(x.key.decode(i)), i);
      }
    });
    should('named', () => {
      const d = utils.Dimensions(5, 3, 2);
      const x1 = [3, 2, 1];
      const x2 = { chunk: 3, lane: 2, pos: 1 };
      const names = ['chunk', 'lane', 'pos'];
      const n = utils.named(names);
      deepStrictEqual(n.encode(x1), x2);
      deepStrictEqual(n.decode(x2), x1);
      const idx = d.key.encode(x1);
      deepStrictEqual(utils.named(names).encode(d.key.decode(idx)), x2);
      const nD = utils.NamedDimensions({ chunk: 5, lane: 3, pos: 2 });
      deepStrictEqual(nD.key.decode(idx), x2);
      deepStrictEqual(nD.key.encode(x2), idx);
    });
    should('flat', () => {
      const d = utils.Dimensions(5, 3, 2);
      const s = utils.seq(d.cardinality);
      // prettier-ignore
      const exp = [
        [[0, 1], [2, 3], [4, 5]],
        [[6, 7], [8, 9], [10, 11]],
        [[12, 13], [14, 15], [16, 17]],
        [[18, 19], [20, 21], [22, 23]],
        [[24, 25], [26, 27], [28, 29]]
      ];
      deepStrictEqual(d.flat.decode(s), exp);
      deepStrictEqual(d.flat.encode(exp), s);
    });
  });
  describe('Shape', () => {
    should('Basic', () => {
      const S = utils.Shape<number>((x): x is number => typeof x === 'number');
      const input = { a: [1, 2], b: { c: 3 } };
      const { shape, flat } = S.decode(input);
      deepStrictEqual(shape, { a: [0, 1], b: { c: 2 } });
      deepStrictEqual(flat, [1, 2, 3]);
      // shape: { a: [0, 1], b: { c: 2 } }
      // flat:  [1, 2, 3]
      const roundtrip = S.encode<typeof input>(shape, flat);
      deepStrictEqual(roundtrip, input);
      // => { a: [1, 2], b: { c: 3] }
      deepStrictEqual(S.validate(shape, roundtrip), true);
      deepStrictEqual(S.validate(shape, { a: [1, 2, 3], b: { c: 3 } }), false);
      deepStrictEqual(S.validate(shape, { a: [1, 2], b: { c: [3] } }), false);
      deepStrictEqual(S.validate(shape, { a: [1, 2] }), false);
      deepStrictEqual(S.validate(shape, [1, 2, 3]), false);
    });
    should('Basic2', () => {
      const S2 = utils.Shape<number>((x): x is number => typeof x === 'string');
      const input = ['A', 'B', ['C', 'D'], { D: 'E' }, ['F', ['G', 'H', ['J']]]];
      const { shape, flat } = S2.decode(input);
      deepStrictEqual(shape, [0, 1, [2, 3], { D: 4 }, [5, [6, 7, [8]]]]);
      deepStrictEqual(flat, ['A', 'B', 'C', 'D', 'E', 'F', 'G', 'H', 'J']);
      // shape: { a: [0, 1], b: { c: 2 } }
      // flat:  [1, 2, 3]
      const roundtrip = S2.encode<typeof input>(shape, flat);
      deepStrictEqual(roundtrip, input);
      deepStrictEqual(S2.validate(shape, roundtrip), true);
    });
  });
  describe('splitU64', () => {
    should('validates precise number domain', () => {
      deepStrictEqual(utils.splitU64(0), { l: 0, h: 0 });
      deepStrictEqual(utils.splitU64(0x1_0000_0000), { l: 0, h: 1 });
      deepStrictEqual(utils.splitU64(Number.MAX_SAFE_INTEGER), { l: -1, h: 0x1fffff });
      throws(() => utils.splitU64(-1), /safe integer|u64/i);
      throws(() => utils.splitU64(1.5), /safe integer|u64/i);
      throws(() => utils.splitU64(2 ** 64 - 1), /safe integer|u64/i);
    });
  });
  describe('Graph', () => {
    describe('Path', () => {
      should('basic', () => {
        deepStrictEqual(utils.Path.encode([1, 2, 3], utils.Path.getFlags(['weak'])), '1.2.3w');
        deepStrictEqual(utils.Path.encode([1, 2, 3], utils.Path.getFlags([])), '1.2.3');
        deepStrictEqual(utils.Path.decode('1.2.3w'), {
          path: [1, 2, 3],
          mask: utils.Path.getFlags(['weak']),
        });
        deepStrictEqual(utils.Path.decode('1.2.3'), {
          path: [1, 2, 3],
          mask: utils.Path.getFlags([]),
        });
        deepStrictEqual(utils.Path.stripFlags('1.2.3'), '1.2.3');
        deepStrictEqual(utils.Path.stripFlags('1.2.3w'), '1.2.3');
        deepStrictEqual(utils.Path.addFlags('1.2.3', utils.Path.getFlags(['weak'])), '1.2.3w');
        deepStrictEqual(utils.Path.encode([1], []), '1');
        deepStrictEqual(utils.Path.encode([1, 2, 3, 4, 5, 6, 7], []), '1.2.3.4.5.6.7');
        deepStrictEqual(
          utils.Path.encode([1, 2, 3], utils.Path.getFlags(['sticky', 'weak'])),
          '1.2.3ws'
        );
        deepStrictEqual(
          utils.Path.encode([1, 2, 3], utils.Path.getFlags(['weak', 'sticky'])),
          '1.2.3ws'
        );
        // merge
        deepStrictEqual(utils.Path.merge('1.2.3w', '1.2.3'), new Set(['1.2.3']));
        deepStrictEqual(utils.Path.merge('1.2.3s', '1.2.3'), new Set(['1.2.3s']));
        deepStrictEqual(utils.Path.merge('1.2.3w', '1.2.3s'), new Set(['1.2.3s']));
        deepStrictEqual(utils.Path.merge('1.2.3w', '1.2.3w'), new Set(['1.2.3w']));
        deepStrictEqual(
          utils.Path.merge('1.2.3.4', '1.2.3', '1.2.3w'),
          new Set(['1.2.3', '1.2.3.4'])
        );
        deepStrictEqual(
          utils.Path.merge('1.2.3.4', '1.2.3', '1.2.3w', '1.2.3.4', '1.2', '1.2.5'),
          new Set(['1.2', '1.2.3', '1.2.3.4', '1.2.5'])
        );

        // cmp
        deepStrictEqual(utils.Path.cmp('1.2.2', '1.2.3'), -1);
        deepStrictEqual(utils.Path.cmp('1.2.3', '1.2.3.4'), -1);
        deepStrictEqual(utils.Path.cmp('1.2.4', '1.2.3.4'), 1);
        deepStrictEqual(utils.Path.cmp('1.2.3', '1.2.3w'), 0);
        // is Parent
        deepStrictEqual(utils.Path.isParent('1.2.3', '1.2.3.4'), true);
        deepStrictEqual(utils.Path.isParent('1.2.4', '1.2.3.4'), false);
        deepStrictEqual(utils.Path.isParent('1.2.3.4', '1.2.3.4'), false);
        // mapParent
        deepStrictEqual(utils.Path.mapParent('1.2', '9', '1.2'), '9');
        deepStrictEqual(utils.Path.mapParent('1.2', '9', '1.2.3'), '9.3');
        deepStrictEqual(utils.Path.mapParent('1.2', '9', '1.2.3w'), '9.3w');
        throws(() => utils.Path.mapParent('1.2', '9', '1.20.3'), /wrong child/);
      });
    });
    type NodeIdx = string;
    type Node =
      | { kind: 'module'; name: string; nodes: Node[] }
      | {
          kind: 'function';
          name: string;
          inputs: types.TypeName[];
          outputs: NodeIdx[];
          nodes: Node[];
        }
      | { kind: 'block'; nodes: Node[]; outputs: NodeIdx[] }
      | { kind: 'loop'; nodes: Node[]; outputs: NodeIdx[] }
      // NOTE: we won't iterate since there is no nodes. we need nodes to be subgraph.
      // | {
      //     kind: 'if';
      //     cond: NodeIdx;
      //     if: { kind: 'ifBlock'; nodes: Node[] };
      //     else?: { kind: 'elseBlock'; nodes: Node[] };
      //   }
      | { type: types.TypeName; op: string; args: string[]; opts: Record<string, any> }; // default op node
    const dagOpts = {
      formatNode: (node) => {
        if (node.kind === 'module') return `module.${node.name}`;
        if (node.kind === 'function') return `function.${node.name}(${node.inputs.join(', ')})`;
        if (node.kind === 'block') return `block`;
        if (node.kind === 'loop') return `loop`;
        const opts = Object.entries(node.opts || {}).map(([k, v]) => `${k}=${v}`);
        const args = [...(node.args || []), ...opts];
        return `${node.type}.${node.op}(${args.join(', ')})`;
      },
      getEdges: (node) => {
        return [
          node.args,
          node.opts?.strong,
          node.opts?.weak,
          node.opts?.cond,
          node.opts?.src,
        ].flat();
      },
      mapEdges: (g, node, mapping, partial) => {
        if (node.args) node.args = g.applyMapping(node.args, mapping, partial);
        if (node.opts) {
          if (node.opts.cond) {
            node.opts.cond = g.applyMappingSingle(node.opts.cond, mapping, partial);
          }
          if (node.opts.weak) {
            node.opts.weak = g.applyMapping(node.opts.weak, mapping, partial, true);
          }
          if (node.opts.strong)
            node.opts.strong = g.applyMapping(node.opts.strong, mapping, partial);
          if (node.opts.src) node.opts.src = g.applyMappingSingle(node.opts.src, mapping, partial);
        }
        if (node.outputs) node.outputs = g.applyMapping(node.outputs, mapping, partial);
        if (node.memOps) {
          for (const k in node.memOps) {
            node.memOps[k].reads = g.applyMapping(node.memOps[k].reads, mapping, partial, true);
            if (node.memOps[k].write !== undefined)
              node.memOps[k].write = g.applyMappingSingle(node.memOps[k].write, mapping, partial);
          }
        }
      },
      isUsed: (parent, node, idx, flags) => {
        return (parent.outputs || []).includes(idx) || flags.has('isMut');
      },
      getFlags: (node) => {
        return [node.opts?.isMut ? 'isMut' : undefined];
      },
    };
    should('basic', () => {
      const g = new utils.TreeDAG({ kind: 'module', name: 'test', nodes: [] }, dagOpts);
      const fn = g.add({ kind: 'function', name: 'test', inputs: [], outputs: [], nodes: [] });
      g.enter(fn);
      const x = g.add({ type: 'u32', op: 'const', opts: { real: true, id: 1 } });
      const x2 = g.add({ type: 'u32', op: 'const', opts: { fake: true } });
      const y = g.add({ type: 'u32', op: 'const', opts: { real: true, id: 2 } });
      const block = g.add({ kind: 'block', nodes: [] });
      g.enter(block);
      const t = g.add({ type: 'u32', op: 'add', args: [x, y], opts: { real: true, id: 3 } });
      const t2 = g.add({ type: 'u32', op: 'add', args: [x2, y], opts: { fake: true, id: 4 } });
      const loop = g.add({ kind: 'loop', nodes: [] });
      g.enter(loop);
      const w = g.add({ type: 'u32', op: 'add', args: [t, y, x], opts: { real: true, id: 5 } });
      const w2 = g.add({ type: 'u32', op: 'add', args: [t, t2], opts: { fake: true, id: 6 } });
      const s = g.add({
        type: 'u32',
        op: 'store',
        args: [w, g.weak(w2)],
        opts: { isMut: true, real: true, id: 7 },
      });
      const w3 = g.add({
        type: 'u32',
        op: 'add',
        args: [w, t, x],
        opts: { real: true, id: 8, weak: [g.weak(w)] },
      });
      const w5 = g.add({
        type: 'u32',
        op: 'add',
        args: [w, t, x],
        opts: { real: true, id: 9, src: g.weak(w), isMut: true },
      });
      g.get(loop).outputs = [w3];
      g.exit(); // loop

      const w4 = g.add({ type: 'u32', op: 'add', args: [loop], opts: { real: true, id: 10 } });
      g.get(block).outputs = [w4];
      g.exit(); // block
      g.exit(); // fn
      g.get(fn).outputs = [block];
      // console.log(g.format());
      g.check();
      // getUsedBy returns a Map; compare against Map to avoid object vs Map mismatch.
      deepStrictEqual(
        g.getUsedBy(),
        new Map([
          ['0.0', new Set(['0.3.0', '0.3.2.0', '0.3.2.3', '0.3.2.4'])],
          ['0.1', new Set(['0.3.1'])],
          ['0.2', new Set(['0.3.0', '0.3.1', '0.3.2.0'])],
          ['0.3.0', new Set(['0.3.2.0', '0.3.2.1', '0.3.2.3', '0.3.2.4'])],
          ['0.3.1', new Set(['0.3.2.1'])],
          ['0.3.2', new Set(['0.3.3'])],
          ['0.3.2.0', new Set(['0.3.2.2', '0.3.2.3', '0.3.2.4'])],
        ])
      );
      g.removeUnused();
      // console.log('---- AFTER REMOVE');
      // console.log(g.format());
      g.toposort();
      // console.log('---- AFTER TOPOSORT');
      // console.log(g.format());
      deepStrictEqual(
        g.format(),
        `: module.test
0: function.test()
0.0: u32.const(real=true, id=1)
0.1: u32.const(real=true, id=2)
0.2: block
0.2.0: u32.add(0.0, 0.1, real=true, id=3)
0.2.1: loop
0.2.1.0: u32.add(0.2.0, 0.1, 0.0, real=true, id=5)
0.2.1.1: u32.store(0.2.1.0, isMut=true, real=true, id=7)
0.2.1.2: u32.add(0.2.1.0, 0.2.0, 0.0, real=true, id=8, weak=0.2.1.0w)
0.2.1.3: u32.add(0.2.1.0, 0.2.0, 0.0, real=true, id=9, src=0.2.1.0w, isMut=true)
0.2.2: u32.add(0.2.1, real=true, id=10)
`
      );

      g.rewrite({
        test: (node, idx) => {
          if (node.op === 'add') {
            const t = [];
            for (let i = 0; i < node.args.length; i += 2) {
              t.push(
                g.add({
                  type: node.type,
                  op: 'xor',
                  args:
                    node.args[i + 1] !== undefined
                      ? [node.args[i], node.args[i + 1]]
                      : [node.args[i]],
                  opts: { id: node.opts.id },
                })
              );
            }
            return g.add({ type: node.type, op: 'and', args: t, opts: { id: node.opts.id } });
          }
        },
      });
      // console.log('---- AFTER REWRITE');
      // console.log(g.format());
      deepStrictEqual(
        g.format(),
        `: module.test
0: function.test()
0.0: u32.const(real=true, id=1)
0.1: u32.const(real=true, id=2)
0.2: block
0.2.0: u32.xor(0.0, 0.1, id=3)
0.2.1: u32.and(0.2.0, id=3)
0.2.2: loop
0.2.2.0: u32.xor(0.2.1, 0.1, id=5)
0.2.2.1: u32.xor(0.0, id=5)
0.2.2.2: u32.and(0.2.2.0, 0.2.2.1, id=5)
0.2.2.3: u32.store(0.2.2.2, isMut=true, real=true, id=7)
0.2.2.4: u32.xor(0.2.2.2, 0.2.1, id=8)
0.2.2.5: u32.xor(0.0, id=8)
0.2.2.6: u32.and(0.2.2.4, 0.2.2.5, id=8)
0.2.3: u32.xor(0.2.2, id=10)
0.2.4: u32.and(0.2.3, id=10)
`
      );
    });
    should('order', () => {
      const g = new utils.TreeDAG({ kind: 'module', name: 'test', nodes: [] }, dagOpts);
      const a = g.add({ type: 'u32', op: 'const', opts: { real: true, id: 'a' } });
      const b = g.add({ type: 'u32', op: 'const', opts: { real: true, id: 'b' } });
      const c = g.add({ type: 'u32', op: 'const', opts: { real: true, id: 'c', src: a } });
      const d = g.add({ type: 'u32', op: 'const', opts: { real: true, id: 'd', src: b } });

      const x = g.clone();
      deepStrictEqual(x.usedBy instanceof Map, true);
      deepStrictEqual(x.usedBy.get(a), new Set([c]));
      x.toposort();
      // console.log('TOPO ORIG:');
      // console.log('X', x.format());

      const y = g.clone();
      y.toposort(undefined, true);
      // console.log('TOPO FIFO:');
      // console.log('Y', y.format());

      deepStrictEqual(
        x.format(),
        `: module.test
0: u32.const(real=true, id=a)
1: u32.const(real=true, id=b)
2: u32.const(real=true, id=c, src=0)
3: u32.const(real=true, id=d, src=1)
`
      );
      deepStrictEqual(
        y.format(),
        `: module.test
0: u32.const(real=true, id=a)
1: u32.const(real=true, id=b)
2: u32.const(real=true, id=c, src=0)
3: u32.const(real=true, id=d, src=1)
`
      );
    });
  });
  describe('SIMD', () => {
    should('shuffleLanes', () => {
      const lanes = utils.chunks(utils.seq(32), 4);
      deepStrictEqual(types.SIMDUtils.shuffleLanes(4, [0, 4, 1, 5]), [
        ...lanes[0],
        ...lanes[4],
        ...lanes[1],
        ...lanes[5],
      ]);
      deepStrictEqual(types.SIMDUtils.shuffleLanes(4, [2, 6, 3, 7]), [
        ...lanes[2],
        ...lanes[6],
        ...lanes[3],
        ...lanes[7],
      ]);
    });
    should('tmp', () => {
      return;
      //       From this:    [[ 0, 1, 2, 3  ], [ 4, 5, 6, 7  ], [ 8, 9, 10, 11 ], [ 12, 13, 14, 15 ]]
      // We want this: [[ 0, 8, 4, 12 ], [ 1, 9, 5, 13 ], [ 2, 10, 6, 14 ], [ 3, 11, 7, 15 ]]
      //we got:   [ 0, 1, 2, 3  ], [ 4, 5, 6, 7  ], [ 8, 9, 10, 11 ], [ 12, 13, 14, 15 ]
      //we want:  [0, 5, 10, 15] [4, 9, 14, 3] [8, 13, 2, 7] [12, 1, 6, 11]
      // console.log(
      //   types.SIMDUtils.tmp(4, [0, 8, 4, 12, 1, 9, 5, 13, 2, 10, 6, 14, 3, 11, 7, 15])
      // );
      // console.log('----');
      // console.log(
      //   types.SIMDUtils.tmp(4, [0, 5, 10, 15, 4, 9, 14, 3, 8, 13, 2, 7, 12, 1, 6, 11])
      // );
    });
  });
});

should.runWhen(import.meta.url);
