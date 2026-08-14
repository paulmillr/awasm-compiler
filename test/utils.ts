import { toJs, toWasm } from '../src/codegen.ts';
import * as js from '../src/js.ts';
import { exec } from '../src/js.ts';
import { toRuntime } from '../src/runtime.ts';
import { genRuntimeTypeMod, TYPE_MOD_OPTS } from '../src/types.ts';

let runtimeTypeMod;

export function getRuntimeTypeMod() {
  return (runtimeTypeMod ??= js.exec(toJs(genRuntimeTypeMod(), TYPE_MOD_OPTS)));
}

export function testBothOpts(...args) {
  const fn = args[args.length - 1];
  const opts = args[args.length - 2];
  const mods = args.slice(0, args.length - 2);
  fn(...mods.map((i) => exec(toWasm(i, opts))));
  fn(...mods.map((i) => exec(toJs(i, opts))));
  if (!opts.noRuntime) fn(...mods.map((i) => toRuntime(getRuntimeTypeMod, i, opts)()));
}

export function testBoth(...args) {
  const fn = args[args.length - 1];
  const mods = args.slice(0, args.length - 1);
  return testBothOpts(...mods, {}, fn);
}
