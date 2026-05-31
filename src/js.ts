import { base64, hex, type TArg } from '@scure/base';
import type { CompilerOpts } from './codegen.ts';
import type { MemOpts } from './memory.ts';
import { chunks, type ElementOf } from './utils.ts';
import { wasmMemoryOpts, type WasmModule } from './wasm.ts';
import { initWorkers } from './workers.ts';

class Stack extends Array<string> {
  lastSide = false;
  side: boolean[] = [];
  pushSide(value: string) {
    this.side.push(true);
    return super.push(value);
  }
  override push(...items: string[]) {
    this.side.push(...items.map(() => false));
    return super.push(...items);
  }
  override pop() {
    this.lastSide = this.side.pop() || false;
    return super.pop();
  }
  clear() {
    this.length = 0;
    this.side.length = 0;
    this.lastSide = false;
  }
}

// basic utils
/**
 * Serializes a plain object into a JavaScript object literal.
 *
 * @param obj - Object whose values are already JavaScript expressions.
 * @param deep - Whether nested object values should be serialized recursively.
 * @returns JavaScript object literal source.
 * @example
 * ```js
 * genObject({ answer: 42 });
 * ```
 */
export function genObject(obj: Record<string, any>, deep = true): string {
  const res = Object.entries(obj)
    .map(([k, v]) => {
      // `__proto__:` is a prototype setter in object literals, even when the key is quoted.
      const key =
        k === '__proto__'
          ? `[${JSON.stringify(k)}]`
          : /^[A-Za-z_$][0-9A-Za-z_$]*$/.test(k)
            ? k
            : JSON.stringify(k);
      return `${key}: ${deep && typeof v === 'object' && v !== null ? genObject(v, true) : v}`;
    })
    .join(', ');
  return `{${res}}`;
}

/** Generated memory segment view descriptors keyed by segment name. */
export type Segments = Record<string, MemOpts>;

const HEX_LINE_BYTES = 33;
const hexLiteral = (code: TArg<Uint8Array>) =>
  chunks(hex.encode(code).match(/../g) || [], HEX_LINE_BYTES)
    .map((line) => line.join(' '))
    .join('\n');

function freeze(s: string, opts: CompilerOpts = {}) {
  return opts.freeze ? `Object.freeze(${s})` : s;
}

function memSegment(name: string, s: MemOpts, opts: CompilerOpts = {}) {
  const res: Record<string, string> = {};
  for (const [k, [pos, len, chunksCount, chunkSize]] of Object.entries(s.subRegions!)) {
    const regionName = k ? `${name}.${k}` : name;
    // region consist of chunks (we can provide full)
    if (len >= chunkSize) {
      res[regionName] = `new Uint8Array(memoryExport.buffer, ${pos}, ${len})\n`;
    }
    // If a lot of chunks, we don't want to create 10k elements array per element
    const expr =
      `Array.from({length: ${chunksCount}},` +
      `(_,i)=>new Uint8Array(memoryExport.buffer, ${pos} + i*${chunkSize}, ${Math.min(
        len,
        chunkSize
      )}))`;
    res[`${regionName}_chunks`] = `${freeze(expr, opts)}\n`;
  }
  return res;
}

/**
 * Generates JavaScript expressions for public segment views.
 *
 * @param segments - Allocated memory segment metadata.
 * @param opts - Compiler options. {@link CompilerOpts}
 * @returns Object mapping segment view names to JavaScript source expressions.
 * @example
 * ```js
 * memViews({});
 * ```
 */
export function memViews(segments: Segments, opts: CompilerOpts = {}): Record<string, string> {
  const res: Record<string, string> = {};
  for (const [name, s] of Object.entries(segments)) Object.assign(res, memSegment(name, s, opts));
  return res;
}

const controlEnd = (instructions: Instr[], pos: number): number => {
  let depth = 0;
  for (let i = pos + 1; i < instructions.length; i++) {
    const it = instructions[i];
    if (['block', 'loop', 'if'].includes(it.TAG)) depth++;
    if (it.TAG !== 'end') continue;
    if (depth === 0) return i;
    depth--;
  }
  return pos;
};
const readsBeforeSet = (instructions: Instr[], start: number, end: number, id: number): boolean => {
  for (let i = start; i < end; i++) {
    const it = instructions[i];
    if (it.TAG === 'local.get' && Number(it.data) === id) return true;
    if ((it.TAG === 'local.set' || it.TAG === 'local.tee') && Number(it.data) === id) return false;
    if (!['block', 'loop', 'if'].includes(it.TAG)) continue;
    const next = controlEnd(instructions, i);
    if (readsBeforeSet(instructions, i + 1, next, id)) return true;
    i = next;
  }
  return false;
};
const isLiveAfter = (
  instructions: Instr[],
  pos: number,
  id: number,
  crossed?: () => void
): boolean => {
  let crossedControl = false;
  for (let i = pos; i < instructions.length; i++) {
    const it = instructions[i];
    if (it.TAG === 'local.get' && Number(it.data) === id) {
      if (crossedControl) crossed?.();
      return true;
    }
    if ((it.TAG === 'local.set' || it.TAG === 'local.tee') && Number(it.data) === id) return false;
    if (!['block', 'loop', 'if'].includes(it.TAG)) continue;
    const end = controlEnd(instructions, i);
    if (readsBeforeSet(instructions, i + 1, end, id)) return true;
    crossedControl = true;
    i = end;
  }
  return false;
};

export const __TEST: Readonly<{ isLiveAfter: typeof isLiveAfter }> = /* @__PURE__ */ Object.freeze({
  isLiveAfter,
});

function isNumber(n: string | number) {
  if (typeof n === 'number') return true;
  return `${+n}` === n;
}

// JS based stack machine for wasm compat
type Instr = any;
/**
 * Per instruction codegen (main part)
 */
function processInstructions(instr: Instr, stack: Stack, isLE: boolean): string | undefined {
  // byteSize -> shift
  const SH = (bs: 1 | 2 | 4 | 8) => (bs === 1 ? 0 : bs === 2 ? 1 : bs === 4 ? 2 : 3);
  // Stack i32 operands used by memory ops are unsigned wasm32 values.
  const U32 = (value: string) => (isNumber(value) ? `${+value >>> 0}` : `((${value}) >>> 0)`);
  // Wasm memory addresses are unsigned i32 values, and memarg offsets are unsigned.
  // Signed JS arithmetic aliases high-bit in-bounds addresses on memories above 2GiB.
  // OOB memory access is UB for this JS target; it does not synthesize Wasm traps.
  const OFF = (addr: string, offset: number) =>
    isNumber(addr) ? `${(+addr >>> 0) + (offset >>> 0)}` : `((${addr}) >>> 0) + ${offset >>> 0}`;
  const ALIGNED = (byte: string, bs: 2 | 4) => isNumber(byte) && (+byte & (bs - 1)) === 0;
  // address -> element index with memarg offset
  const IDX_BYTE = (byte: string, shift: number) =>
    isNumber(byte) ? `${+byte >>> shift}` : `(${byte}) >>> ${shift}`;
  const IDX = (addr: string, offset: number, shift: number) => IDX_BYTE(OFF(addr, offset), shift);
  const ATOMIC_THROW = `(()=>{throw new Error('unaligned atomic access')})()`;
  const ATOMIC = (addr: string, offset: number, bs: 1 | 2 | 4, expr: (idx: string) => string) => {
    const byte = OFF(addr, offset);
    const shift = SH(bs);
    if (bs === 1) return expr(IDX_BYTE(byte, shift));
    const mask = bs - 1;
    if (isNumber(byte)) return +byte & mask ? ATOMIC_THROW : expr(IDX_BYTE(byte, shift));
    // Plain Error is intentional: unaligned atomics mean the fixed JS memory model is corrupt.
    return `((__addr)=>((__addr & ${mask}) ? ${ATOMIC_THROW} : (${expr(
      `__addr >>> ${shift}`
    )})))(${byte})`;
  };
  const ATOMIC_STMT = (
    addr: string,
    offset: number,
    bs: 1 | 2 | 4,
    expr: (idx: string) => string
  ) => `${ATOMIC(addr, offset, bs, expr)};`;
  if (['i32.const', 'f32.const', 'f64.const'].includes(instr.TAG)) stack.push(`${instr.data}`);
  else if (instr.TAG === 'i32.xor') stack.push(`(${stack.pop()} ^ ${stack.pop()})`);
  else if (instr.TAG === 'i32.add') stack.push(`((${stack.pop()} + ${stack.pop()}) | 0)`);
  else if (instr.TAG === 'f32.add') stack.push(`Math.fround(${stack.pop()} + ${stack.pop()})`);
  else if (instr.TAG === 'f64.add') stack.push(`(${stack.pop()} + ${stack.pop()})`);
  else if (instr.TAG === 'i32.mul') stack.push(`Math.imul(${stack.pop()}, ${stack.pop()})`);
  else if (instr.TAG === 'f32.mul') stack.push(`Math.fround(${stack.pop()} * ${stack.pop()})`);
  else if (instr.TAG === 'f64.mul') stack.push(`(${stack.pop()} * ${stack.pop()})`);
  else if (['f32.min', 'f64.min', 'i32.min_s'].includes(instr.TAG))
    stack.push(`Math.min(${stack.pop()}, ${stack.pop()})`);
  else if (instr.TAG === 'i32.min_u')
    stack.push(`(Math.min(${stack.pop()} >>> 0, ${stack.pop()} >>> 0) | 0)`);
  else if (['f32.max', 'f64.max', 'i32.max_s'].includes(instr.TAG))
    stack.push(`Math.max(${stack.pop()}, ${stack.pop()})`);
  else if (instr.TAG === 'i32.max_u')
    stack.push(`(Math.max(${stack.pop()} >>> 0, ${stack.pop()} >>> 0) | 0)`);
  else if (instr.TAG === 'f32.copysign') {
    const y = stack.pop();
    const x = stack.pop();
    stack.push(
      `Math.fround(` +
        `(new Uint32Array(new Float32Array([${y}]).buffer)[0] >>> 31)` +
        ` ? -Math.abs(${x})` +
        ` :  Math.abs(${x})` +
        `)`
    );
  } else if (instr.TAG === 'f64.copysign') {
    const y = stack.pop();
    const x = stack.pop();
    stack.push(
      `(new Uint32Array(new Float64Array([${y}]).buffer)[1] >>> 31)` +
        ` ? -Math.abs(${x})` +
        ` :  Math.abs(${x})`
    );
  } else if (instr.TAG === 'i32.reinterpret_f32')
    stack.push(`(new Int32Array(new Float32Array([${stack.pop()}]).buffer)[0])`);
  else if (instr.TAG === 'f32.reinterpret_i32')
    stack.push(`(new Float32Array(new Int32Array([${stack.pop()}]).buffer)[0])`);
  else if (instr.TAG === 'i32.reinterpret_f64_low')
    stack.push(`(new Uint32Array(new Float64Array([${stack.pop()}]).buffer)[0])`);
  else if (instr.TAG === 'i32.reinterpret_f64_high')
    stack.push(`(new Uint32Array(new Float64Array([${stack.pop()}]).buffer)[1])`);
  else if (instr.TAG === 'f64.reinterpret_i32') {
    const hi = stack.pop();
    const lo = stack.pop();
    stack.push(`(new Float64Array(new Uint32Array([${lo}, ${hi}]).buffer)[0])`);
  } else if (instr.TAG === 'i32.sub') {
    const a = stack.pop();
    const b = stack.pop();
    stack.push(`((${b} - ${a}) | 0)`);
  } else if (instr.TAG === 'f32.sub') {
    const a = stack.pop();
    const b = stack.pop();
    stack.push(`Math.fround(${b} - ${a})`);
  } else if (instr.TAG === 'f64.sub') {
    const a = stack.pop();
    const b = stack.pop();
    stack.push(`(${b} - ${a})`);
  } else if (instr.TAG === 'f32.div') {
    const a = stack.pop();
    const b = stack.pop();
    stack.push(`Math.fround(${b} / ${a})`);
  } else if (instr.TAG === 'f64.div') {
    const a = stack.pop();
    const b = stack.pop();
    stack.push(`(${b} / ${a})`);
  } else if (instr.TAG === 'f32.rem') {
    // Slightly different than Math.fround(b % a), this way it would be precise
    const a = stack.pop();
    const b = stack.pop();
    stack.push(`Math.fround(${b} - (Math.trunc(${b} / ${a}) * ${a}))`);
  } else if (instr.TAG === 'f64.rem') {
    const a = stack.pop();
    const b = stack.pop();
    //    stack.push(`(${b} % ${a})`);
    stack.push(`(${b} - (Math.trunc(${b} / ${a}) * ${a}))`);
  } else if (instr.TAG === 'f32.demote_f64') {
    stack.push(`Math.fround(${stack.pop()})`);
  } else if (instr.TAG === 'f32.convert_i32_s') {
    stack.push(`Math.fround((${stack.pop()}) | 0)`);
  } else if (instr.TAG === 'f32.convert_i32_u') {
    stack.push(`Math.fround((${stack.pop()}) >>> 0)`);
  } else if (instr.TAG === 'f64.convert_i32_s') {
    stack.push(`((${stack.pop()}) | 0)`);
  } else if (instr.TAG === 'f64.convert_i32_u') {
    stack.push(`((${stack.pop()}) >>> 0)`);
  } else if (['i32.trunc_f32_u', 'i32.trunc_f64_u'].includes(instr.TAG)) {
    // UB: callers must keep trunc inputs finite/in range; JS output has no trap model.
    stack.push(`(Math.trunc(${stack.pop()}) >>> 0) | 0`);
  } else if (['i32.trunc_f32_s', 'i32.trunc_f64_s'].includes(instr.TAG)) {
    // UB: callers must keep trunc inputs finite/in range; JS output has no trap model.
    stack.push(`(Math.trunc(${stack.pop()}) | 0)`);
  } else if (instr.TAG === 'f64.promote_f32') {
    stack.push(`${stack.pop()}`);
  } else if (instr.TAG === 'i32.and') {
    stack.push(`(${stack.pop()} & ${stack.pop()})`);
  } else if (instr.TAG === 'i32.or') {
    stack.push(`(${stack.pop()} | ${stack.pop()})`);
  } else if (instr.TAG === 'i32.not') {
    stack.push(`(~${stack.pop()})`);
  } else if (instr.TAG === 'i32.abs') {
    stack.push(`(Math.abs(${stack.pop()}) | 0)`);
  } else if (['f32.abs', 'f64.abs'].includes(instr.TAG)) {
    stack.push(`Math.abs(${stack.pop()})`);
  } else if (['f32.ceil', 'f64.ceil'].includes(instr.TAG)) {
    stack.push(`Math.ceil(${stack.pop()})`);
  } else if (['f32.floor', 'f64.floor'].includes(instr.TAG)) {
    stack.push(`Math.floor(${stack.pop()})`);
  } else if (['f32.trunc', 'f64.trunc'].includes(instr.TAG)) {
    stack.push(`Math.trunc(${stack.pop()})`);
  } else if (instr.TAG === 'f32.sqrt') {
    // f32 operations must round back to binary32; Math.sqrt returns f64.
    stack.push(`Math.fround(Math.sqrt(${stack.pop()}))`);
  } else if (instr.TAG === 'f64.sqrt') {
    stack.push(`Math.sqrt(${stack.pop()})`);
  } else if (instr.TAG === 'f64.nearest') {
    stack.push(
      `((x)=>{` +
        `if (x !== x || x === Infinity || x === -Infinity) return x;` +
        `const f = Math.floor(x);` +
        `const d = x - f;` +
        `let r = d < 0.5 ? f : d > 0.5 ? f + 1 : ((f % 2) === 0 ? f : f + 1);` +
        `return r === 0 ? ((x < 0 || 1/x === -Infinity) ? -0 : 0) : r;` +
        `})(${stack.pop()})`
    );
  } else if (instr.TAG === 'f32.nearest') {
    stack.push(
      `Math.fround(` +
        `((x)=>{` +
        `if (x !== x || x === Infinity || x === -Infinity) return x;` +
        `const f = Math.floor(x);` +
        `const d = x - f;` +
        `let r = d < 0.5 ? f : d > 0.5 ? f + 1 : ((f % 2) === 0 ? f : f + 1);` +
        `return r === 0 ? ((x < 0 || 1/x === -Infinity) ? -0 : 0) : r;` +
        `})(${stack.pop()})` +
        `)`
    );
  } else if (['f32.eqz', 'f64.eqz'].includes(instr.TAG)) {
    stack.push(`+(${stack.pop()} === 0)`);
  } else if (['f32.isNaN', 'f64.isNaN'].includes(instr.TAG)) {
    stack.push(`(Number.isNaN(${stack.pop()}) ? 1 : 0)`);
  } else if (instr.TAG === 'i32.shl') {
    const a = stack.pop();
    const b = stack.pop();
    stack.push(`(${b} << ${a})`);
  } else if (instr.TAG === 'i32.shr_u') {
    const a = stack.pop();
    const b = stack.pop();
    stack.push(`(${b} >>> ${a})`);
  } else if (instr.TAG === 'i32.shr_s') {
    const a = stack.pop();
    const b = stack.pop();
    stack.push(`(${b} >> ${a})`);
  } else if (instr.TAG === 'i32.rotr') {
    const a = stack.pop();
    const b = stack.pop();
    // const rotr = (word: number, shift: number) => (word << (32 - shift)) | (word >>> shift);
    stack.push(`(((${b} >>> ${a}) | ` + `(${b} << (32 - ${a}))))`);
  } else if (instr.TAG === 'i32.rotl') {
    const a = stack.pop();
    const b = stack.pop();
    //          return (word << shift) | ((word >>> (32 - shift)) >>> 0);
    stack.push(`((${b} << ${a}) | ((${b} >>> (32 - ${a})) >>> 0))`);
  } else if (
    (instr.TAG.includes('.load') || instr.TAG.includes('.store')) &&
    !instr.TAG.includes('atomic')
  ) {
    const val = instr.TAG.includes('.store') ? stack.pop() : undefined;
    const addr = stack.pop()!;
    const offset = OFF(addr, instr.data.offset);
    const offset2 = IDX(addr, instr.data.offset, 1);
    const offset4 = IDX(addr, instr.data.offset, 2);
    const useTA = isLE && !instr.data.swapEndianness;
    // Raw Wasm memarg align is only an immediate. Internal IR memory ops are
    // trusted to carry correct align; bad rawFn/rewrite nodes are already invalid IR.
    const align2 = instr.data.trustedAlign ? instr.data['align'] >= 1 : ALIGNED(offset, 2);
    const align4 = instr.data.trustedAlign ? instr.data['align'] >= 2 : ALIGNED(offset, 4);
    const useTA2 = useTA && align2;
    const useTA4 = useTA && align4;
    const LE = instr.data.swapEndianness ? 'false' : 'true';
    // load, swap endianess
    if (instr.TAG === 'i32.load' && useTA4) stack.push(`memory_i32[${offset4}]`);
    else if (instr.TAG === 'i32.load16_u' && useTA2) stack.push(`memory_u16[${offset2}]`);
    else if (instr.TAG === 'i32.load16_s' && useTA2) stack.push(`memory_i16[${offset2}]`);
    else if (instr.TAG === 'i32.load8_u') stack.push(`memory[${offset}]`);
    else if (instr.TAG === 'i32.load8_s') stack.push(`memory_i8[${offset}]`);
    // load fallback
    else if (instr.TAG === 'i32.load') stack.push(`memory_view.getInt32(${offset}, ${LE})`);
    else if (instr.TAG === 'f32.load') stack.push(`memory_view.getFloat32(${offset}, ${LE})`);
    else if (instr.TAG === 'f64.load') stack.push(`memory_view.getFloat64(${offset}, ${LE})`);
    else if (instr.TAG === 'i32.load16_u') stack.push(`memory_view.getUint16(${offset}, ${LE})`);
    else if (instr.TAG === 'i32.load16_s') stack.push(`memory_view.getInt16(${offset}, ${LE})`);
    // store, aligned
    else if (instr.TAG === 'i32.store' && useTA4) return `memory_i32[${offset4}] = ${val};`;
    else if (instr.TAG === 'i32.store16' && useTA2) return `memory_i16[${offset2}] = ${val};`;
    else if (instr.TAG === 'i32.store8') return `memory[${offset}] = ${val};`;
    // store, fallback
    else if (instr.TAG === 'i32.store') return `memory_view.setInt32(${offset}, ${val}, ${LE});`;
    else if (instr.TAG === 'f32.store') return `memory_view.setFloat32(${offset}, ${val}, ${LE});`;
    else if (instr.TAG === 'f64.store') return `memory_view.setFloat64(${offset}, ${val}, ${LE});`;
    else if (instr.TAG === 'i32.store16') return `memory_view.setInt16(${offset}, ${val}, ${LE});`;
    else throw new Error('unknown instruction: ' + instr.TAG);
  } else if (instr.TAG === 'select') {
    const cond = stack.pop();
    const b = stack.pop();
    const a = stack.pop();
    stack.push(`((${cond}) ? (${a}) : (${b}))`);
  } else if (instr.TAG === 'i32.addCarry') {
    const args = [];
    while (stack.length) args.push(stack.pop());
    stack.push(args.map((i) => `(${i} >>> 0)`).join(' + '));
  } else if (instr.TAG === 'i32.carry') {
    const val = stack.pop();
    stack.push(`((${val} / 4294967296) | 0)`);
  } else if (instr.TAG === 'i32.high_big') {
    stack.push(`Number((BigInt(${stack.pop()}) >> BigInt(32)) & BigInt(0xffffffff))`);
  } else if (instr.TAG === 'i32.low_big') {
    stack.push(`Number(BigInt(${stack.pop()}) & BigInt(0xffffffff))`);
  } else if (instr.TAG === 'i64.extend_i32_u') {
    stack.push(`BigInt(${stack.pop()} >>> 0)`);
  } else if (instr.TAG === 'i64.extend_i32_s') {
    stack.push(`BigInt(${stack.pop()} | 0)`);
  } else if (instr.TAG === 'i32.wrap_i64') {
    // Raw i64 BigInt paths are unsupported; compiler JS lowers wide ints before emission.
    stack.push(`(Number(${stack.pop()}) & 0xffffffff)`);
  } else if (instr.TAG === 'i32.eqz') {
    const x = stack.pop();
    stack.push(`((((${x}) | 0) === 0) | 0)`);
  } else if (instr.TAG === 'i32.eq') {
    const a = stack.pop(),
      b = stack.pop();
    stack.push(`((((${b}) | 0) === ((${a}) | 0)) | 0)`);
  } else if (['f32.eq', 'f64.eq'].includes(instr.TAG)) {
    const a = stack.pop(),
      b = stack.pop();
    stack.push(`+(${b} === ${a})`);
  } else if (['f32.ne', 'f64.ne'].includes(instr.TAG)) {
    const a = stack.pop(),
      b = stack.pop();
    stack.push(`+(${b} !== ${a})`);
  } else if (['f32.lt', 'f64.lt'].includes(instr.TAG)) {
    const a = stack.pop(),
      b = stack.pop();
    stack.push(`+(${b} < ${a})`);
  } else if (['f32.gt', 'f64.gt'].includes(instr.TAG)) {
    const a = stack.pop(),
      b = stack.pop();
    stack.push(`+(${b} > ${a})`);
  } else if (['f32.le', 'f64.le'].includes(instr.TAG)) {
    const a = stack.pop(),
      b = stack.pop();
    stack.push(`+(${b} <= ${a})`);
  } else if (['f32.ge', 'f64.ge'].includes(instr.TAG)) {
    const a = stack.pop(),
      b = stack.pop();
    stack.push(`+(${b} >= ${a})`);
  } else if (instr.TAG === 'i32.ne') {
    const a = stack.pop(),
      b = stack.pop();
    stack.push(`((((${b}) | 0) !== ((${a}) | 0)) | 0)`);
  } else if (instr.TAG === 'i32.lt_s') {
    const a = stack.pop(),
      b = stack.pop();
    stack.push(`((((${b}) | 0) < ((${a}) | 0)) | 0)`);
  } else if (instr.TAG === 'i32.lt_u') {
    const a = stack.pop(),
      b = stack.pop();
    stack.push(`((((${b}) >>> 0) < ((${a}) >>> 0)) | 0)`);
  } else if (instr.TAG === 'i32.gt_s') {
    const a = stack.pop(),
      b = stack.pop();
    stack.push(`((((${b}) | 0) > ((${a}) | 0)) | 0)`);
  } else if (instr.TAG === 'i32.gt_u') {
    const a = stack.pop(),
      b = stack.pop();
    stack.push(`((((${b}) >>> 0) > ((${a}) >>> 0)) | 0)`);
  } else if (instr.TAG === 'i32.le_s') {
    const a = stack.pop(),
      b = stack.pop();
    stack.push(`((((${b}) | 0) <= ((${a}) | 0)) | 0)`);
  } else if (instr.TAG === 'i32.le_u') {
    const a = stack.pop(),
      b = stack.pop();
    stack.push(`((((${b}) >>> 0) <= ((${a}) >>> 0)) | 0)`);
  } else if (instr.TAG === 'i32.ge_s') {
    const a = stack.pop(),
      b = stack.pop();
    stack.push(`((((${b}) | 0) >= ((${a}) | 0)) | 0)`);
  } else if (instr.TAG === 'i32.ge_u') {
    const a = stack.pop(),
      b = stack.pop();
    stack.push(`((((${b}) >>> 0) >= ((${a}) >>> 0)) | 0)`);
  } else if (instr.TAG === 'i32.div_s') {
    const a = stack.pop(),
      b = stack.pop();
    // UB: callers must keep integer div/rem operands valid; JS output has no trap/error model.
    stack.push(`(((((${b})|0)/(((${a})|0)))|0))`);
  } else if (instr.TAG === 'i32.div_u') {
    const a = stack.pop(),
      b = stack.pop();
    stack.push(`((((((${b})>>>0)/(((${a})>>>0))))>>>0))`);
  } else if (instr.TAG === 'i32.rem_s') {
    const a = stack.pop(),
      b = stack.pop();
    stack.push(`(((((${b})|0)%(((${a})|0)))|0))`);
  } else if (instr.TAG === 'i32.rem_u') {
    const a = stack.pop(),
      b = stack.pop();
    stack.push(`((((((${b})>>>0)%(((${a})>>>0))))>>>0))`);
  } else if (['i32.neg', 'f32.neg', 'f64.neg'].includes(instr.TAG)) {
    stack.push(`(-${stack.pop()})`);
  } else if (instr.TAG === 'i32.andnot') {
    const a = stack.pop(),
      b = stack.pop();
    stack.push(`(${b} & ~${a})`);
  } else if (instr.TAG === 'i32.clz') {
    const a = stack.pop();
    // clz(0) = 32 per spec; Math.clz32 already does that.
    stack.push(`(Math.clz32((${a})>>>0)|0)`);
  } else if (instr.TAG === 'i32.ctz') {
    const a = stack.pop();
    // ctz(0) = 32; for x!=0: ctz = 31 - clz(x & -x)
    stack.push(`(()=>{const x=((${a})>>>0);return x?((31-Math.clz32(x&-x))|0):32;})()`);
  } else if (instr.TAG === 'i32.popcnt') {
    const a = stack.pop();
    // HAKMEM / Hacker's Delight popcount, kept in 32-bit via >>> and Math.imul
    stack.push(
      `(()=>{let x=((${a})>>>0);x-=((x>>>1)&0x55555555);x=(x&0x33333333)+((x>>>2)&0x33333333);x=(x+(x>>>4))&0x0f0f0f0f;return (Math.imul(x,0x01010101)>>>24)|0;})()`
    );
  } else if (instr.TAG === 'memory.size') {
    // Wasm reports memory size in 64KiB pages; native Wasm rounds byte memory up to pages.
    stack.push(`(Math.ceil(__buf.byteLength / 65536) | 0)`);
  } else if (instr.TAG === 'memory.grow') {
    // JS output keeps const typed-array views for performance; grow replaces or
    // detaches the backing buffer, so silently emitting it would leave stale views.
    throw new Error('memory.grow is not supported by JS output with fixed-size memory views');
  } else if (instr.TAG === 'memory.fill') {
    const len = U32(stack.pop()!);
    const value = stack.pop()!;
    const pos = U32(stack.pop()!);
    return `memory.fill(${value}, ${pos}, ${pos} + ${len})`;
  } else if (instr.TAG === 'memory.copy') {
    // [dstPos, srcPos, len]
    const len = U32(stack.pop()!);
    const srcPos = U32(stack.pop()!);
    const dstPos = U32(stack.pop()!);
    //exp.copyWithin(dst, src, src + len)
    return `memory.copyWithin(${dstPos}, ${srcPos}, ${srcPos}+${len});`;
    // lines.push(`memory.subarray(${dstPos}).set(memory.subarray(${srcPos}, ${srcPos}+${len}));`);
  } else if (instr.TAG === 'drop') {
    const value = stack.pop();
    if (value && stack.lastSide)
      // Dead local/drop must still evaluate side-effectful expressions such as Atomics RMW ops.
      return `${value};`;
  } else if (instr.TAG === 'atomic.notify') {
    const count = stack.pop()!;
    const addr = stack.pop()!;
    const offset = instr.data.offset;
    stack.pushSide(
      ATOMIC(addr, offset, 4, (idx) => `Atomics.notify(memory_i32, ${idx}, ${count}|0)`)
    );
  } else if (instr.TAG === 'atomic.fence') {
    // JS Atomics are seq-cst; fence is a no-op here.
    return `/* atomic.fence (seq-cst) */`;
  } else if (instr.TAG.startsWith('i32.atomic')) {
    // ---- wait (returns 0|1|2 like wasm) ----
    if (instr.TAG === 'i32.atomic.wait') {
      const timeoutHi = stack.pop()!;
      const timeoutLo = stack.pop()!;
      const expected = stack.pop()!;
      const addr = stack.pop()!;
      const offset = instr.data.offset;
      // negative if sign bit of hi is set; omit timeout (infinite) in that case
      const res = (idx: string) =>
        `(((${timeoutHi}|0) < 0) ? ` +
        // infinite wait: no timeout parameter
        `Atomics.wait(memory_i32, ${idx}, (${expected}|0)) : ` +
        // finite wait: ceil( (hi*2^32 + (lo>>>0)) / 1e6 )  -> clamp <=0 to 0
        `(m=>Atomics.wait(memory_i32, ${idx}, (${expected}|0), (m<=0?0:m)))` +
        `(Math.ceil((${timeoutHi} * 4294967296 + (${timeoutLo}>>>0)) / 1_000_000))` +
        `)`;

      // map 'ok'|'not-equal'|'timed-out' to 0/1/2 like Wasm
      stack.pushSide(
        ATOMIC(addr, offset, 4, (idx) => `({ok:0,'not-equal':1,'timed-out':2}[${res(idx)}])`)
      );
    }
    // ---- loads (push) ----
    else if (instr.TAG === 'i32.atomic.load') {
      const addr = stack.pop()!;
      const offset = instr.data.offset;
      stack.pushSide(ATOMIC(addr, offset, 4, (idx) => `Atomics.load(memory_i32, ${idx})|0`));
    } else if (instr.TAG === 'i32.atomic.load8_u') {
      const addr = stack.pop()!;
      const offset = instr.data.offset;
      // 8-bit atomics use the existing Uint8Array view emitted as `memory`.
      stack.pushSide(ATOMIC(addr, offset, 1, (idx) => `Atomics.load(memory, ${idx})|0`));
    } else if (instr.TAG === 'i32.atomic.load16_u') {
      const addr = stack.pop()!;
      const offset = instr.data.offset;
      stack.pushSide(ATOMIC(addr, offset, 2, (idx) => `Atomics.load(memory_u16, ${idx})|0`));
    }
    // ---- stores (return statement) ----
    else if (instr.TAG === 'i32.atomic.store') {
      const val = stack.pop()!;
      const addr = stack.pop()!;
      const offset = instr.data.offset;
      return ATOMIC_STMT(addr, offset, 4, (idx) => `Atomics.store(memory_i32, ${idx}, (${val}|0))`);
    } else if (instr.TAG === 'i32.atomic.store8') {
      const val = stack.pop()!;
      const addr = stack.pop()!;
      const offset = instr.data.offset;
      return ATOMIC_STMT(addr, offset, 1, (idx) => `Atomics.store(memory, ${idx}, ${val})`);
    } else if (instr.TAG === 'i32.atomic.store16') {
      const val = stack.pop()!;
      const addr = stack.pop()!;
      const offset = instr.data.offset;
      return ATOMIC_STMT(addr, offset, 2, (idx) => `Atomics.store(memory_u16, ${idx}, ${val})`);
    }

    // ---- RMW (push previous value, wasm semantics) ----
    else if (instr.TAG === 'i32.atomic.add') {
      const val = stack.pop()!;
      const addr = stack.pop()!;
      const offset = instr.data.offset;
      stack.pushSide(
        ATOMIC(addr, offset, 4, (idx) => `Atomics.add(memory_i32, ${idx}, (${val}|0))|0`)
      );
    } else if (instr.TAG === 'i32.atomic.add8_u') {
      const val = stack.pop()!,
        addr = stack.pop()!;
      const offset = instr.data.offset;
      stack.pushSide(ATOMIC(addr, offset, 1, (idx) => `Atomics.add(memory,  ${idx}, ${val})|0`));
    } else if (instr.TAG === 'i32.atomic.add16_u') {
      const val = stack.pop()!,
        addr = stack.pop()!;
      const offset = instr.data.offset;
      stack.pushSide(ATOMIC(addr, offset, 2, (idx) => `Atomics.add(memory_u16, ${idx}, ${val})|0`));
    } else if (instr.TAG === 'i32.atomic.sub') {
      const val = stack.pop()!;
      const addr = stack.pop()!;
      const offset = instr.data.offset;
      stack.pushSide(
        ATOMIC(addr, offset, 4, (idx) => `Atomics.sub(memory_i32, ${idx}, (${val}|0))|0`)
      );
    } else if (instr.TAG === 'i32.atomic.sub8_u') {
      const val = stack.pop()!,
        addr = stack.pop()!;
      const offset = instr.data.offset;
      stack.pushSide(ATOMIC(addr, offset, 1, (idx) => `Atomics.sub(memory,  ${idx}, ${val})|0`));
    } else if (instr.TAG === 'i32.atomic.sub16_u') {
      const val = stack.pop()!,
        addr = stack.pop()!;
      const offset = instr.data.offset;
      stack.pushSide(ATOMIC(addr, offset, 2, (idx) => `Atomics.sub(memory_u16, ${idx}, ${val})|0`));
    } else if (instr.TAG === 'i32.atomic.and') {
      const val = stack.pop()!;
      const addr = stack.pop()!;
      const offset = instr.data.offset;
      stack.pushSide(
        ATOMIC(addr, offset, 4, (idx) => `Atomics.and(memory_i32, ${idx}, (${val}|0))|0`)
      );
    } else if (instr.TAG === 'i32.atomic.and8_u') {
      const val = stack.pop()!,
        addr = stack.pop()!;
      const offset = instr.data.offset;
      stack.pushSide(ATOMIC(addr, offset, 1, (idx) => `Atomics.and(memory,  ${idx}, ${val})|0`));
    } else if (instr.TAG === 'i32.atomic.and16_u') {
      const val = stack.pop()!,
        addr = stack.pop()!;
      const offset = instr.data.offset;
      stack.pushSide(ATOMIC(addr, offset, 2, (idx) => `Atomics.and(memory_u16, ${idx}, ${val})|0`));
    } else if (instr.TAG === 'i32.atomic.or') {
      const val = stack.pop()!;
      const addr = stack.pop()!;
      const offset = instr.data.offset;
      stack.pushSide(
        ATOMIC(addr, offset, 4, (idx) => `Atomics.or(memory_i32, ${idx}, (${val}|0))|0`)
      );
    } else if (instr.TAG === 'i32.atomic.or8_u') {
      const val = stack.pop()!,
        addr = stack.pop()!;
      const offset = instr.data.offset;
      stack.pushSide(ATOMIC(addr, offset, 1, (idx) => `Atomics.or(memory,  ${idx}, ${val})|0`));
    } else if (instr.TAG === 'i32.atomic.or16_u') {
      const val = stack.pop()!,
        addr = stack.pop()!;
      const offset = instr.data.offset;
      stack.pushSide(ATOMIC(addr, offset, 2, (idx) => `Atomics.or(memory_u16, ${idx}, ${val})|0`));
    } else if (instr.TAG === 'i32.atomic.xor') {
      const val = stack.pop()!;
      const addr = stack.pop()!;
      const offset = instr.data.offset;
      stack.pushSide(
        ATOMIC(addr, offset, 4, (idx) => `Atomics.xor(memory_i32, ${idx}, (${val}|0))|0`)
      );
    } else if (instr.TAG === 'i32.atomic.xor8_u') {
      const val = stack.pop()!,
        addr = stack.pop()!;
      const offset = instr.data.offset;
      stack.pushSide(ATOMIC(addr, offset, 1, (idx) => `Atomics.xor(memory,  ${idx}, ${val})|0`));
    } else if (instr.TAG === 'i32.atomic.xor16_u') {
      const val = stack.pop()!,
        addr = stack.pop()!;
      const offset = instr.data.offset;
      stack.pushSide(ATOMIC(addr, offset, 2, (idx) => `Atomics.xor(memory_u16, ${idx}, ${val})|0`));
    } else if (instr.TAG === 'i32.atomic.xchg') {
      const val = stack.pop()!;
      const addr = stack.pop()!;
      const offset = instr.data.offset;
      stack.pushSide(
        ATOMIC(addr, offset, 4, (idx) => `Atomics.exchange(memory_i32, ${idx}, (${val}|0))|0`)
      );
    } else if (instr.TAG === 'i32.atomic.xchg8_u') {
      const val = stack.pop()!,
        addr = stack.pop()!;
      const offset = instr.data.offset;
      stack.pushSide(
        ATOMIC(addr, offset, 1, (idx) => `Atomics.exchange(memory,  ${idx}, ${val})|0`)
      );
    } else if (instr.TAG === 'i32.atomic.xchg16_u') {
      const val = stack.pop()!,
        addr = stack.pop()!;
      const offset = instr.data.offset;
      stack.pushSide(
        ATOMIC(addr, offset, 2, (idx) => `Atomics.exchange(memory_u16, ${idx}, ${val})|0`)
      );
    } else if (instr.TAG === 'i32.atomic.cmpxchg') {
      const replacement = stack.pop()!;
      const expected = stack.pop()!;
      const addr = stack.pop()!;
      const offset = instr.data.offset;
      stack.pushSide(
        ATOMIC(
          addr,
          offset,
          4,
          (idx) =>
            `Atomics.compareExchange(memory_i32, ${idx}, (${expected}|0), (${replacement}|0))|0`
        )
      );
    } else if (instr.TAG === 'i32.atomic.cmpxchg8_u') {
      const r = stack.pop()!,
        e = stack.pop()!,
        addr = stack.pop()!;
      const offset = instr.data.offset;
      stack.pushSide(
        ATOMIC(addr, offset, 1, (idx) => `Atomics.compareExchange(memory,  ${idx}, ${e}, ${r})|0`)
      );
    } else if (instr.TAG === 'i32.atomic.cmpxchg16_u') {
      const r = stack.pop()!,
        e = stack.pop()!,
        addr = stack.pop()!;
      const offset = instr.data.offset;
      stack.pushSide(
        ATOMIC(
          addr,
          offset,
          2,
          (idx) => `Atomics.compareExchange(memory_u16, ${idx}, ${e}, ${r})|0`
        )
      );
    } else {
      throw new Error('unknown instruction: ' + instr.TAG);
    }
  } else {
    throw new Error('unkown instr: ' + instr.TAG);
  }
  return;
}

/**
 * Split generated function into multiple smaller function because after ~60kb limit v8 will refuse to
 * optimize code.
 */
function generateInstructions(fn: any, opts: CompilerOpts = {}, isLE = true, stateArrayIdx = 0) {
  const name = fn.name;
  if (!fn.name) throw new Error('unknown name');
  const { instructions } = fn;
  const inputs = fn.inputs.map((_: any, i: any) => `v${i}`);
  const vName = opts.jsStateArray ? `SV${stateArrayIdx}` : undefined;
  const stateTypes: string[] = [];
  if (opts.jsStateArray) {
    stateTypes.push(...fn.inputs);
    for (const { count, type } of fn.locals) for (let i = 0; i < count; i++) stateTypes.push(type);
  }

  const LIMIT = opts.jsOpsPerFn || 60_000;
  // 1. collect how much times each variable was set (if 1, then it is immutable)
  const varAssigned: Record<number, number> = {};
  const varRead: Record<number, number> = {};
  for (const i of instructions) {
    if (i.TAG === 'local.get') {
      const idx = Number(i.data);
      if (varRead[idx] === undefined) varRead[idx] = 0;
      varRead[idx]++;
    }
    if (!['local.set', 'local.tee'].includes(i.TAG)) continue;
    let idx = Number(i.data); // is bigint inside
    if (varAssigned[idx] === undefined) varAssigned[idx] = 0;
    varAssigned[idx]++;
  }
  const varMutable = new Set();
  for (const k in varAssigned) if (varAssigned[k] > 1) varMutable.add(k);
  const isDeadVar = (id: number) => !varRead[id];
  // 2. now lets merge stack
  const stack = new Stack();
  let maxCallIdx = 0;
  let labelIdx = 0;
  let lStateIdx = 0;
  let stackArgs: Set<number> = new Set();
  let stackLines: string[] = [];
  let stackProvides: number[] = [];
  const forcedMutable = new Set<number>();
  const forcedDeclared = new Set<number>(inputs.map((_: string, i: number) => i));
  const collapseStack: {
    line: string;
    args: typeof stackArgs;
    op?: any;
    provides: number[];
  }[] = []; // new instructions

  const stackPop = (pos: number) => {
    if (!stack.length) {
      console.log('INSTR', instructions[pos], instructions.slice(pos - 5, pos + 5));
      throw new Error('empty stack');
    }
    return stack.pop()!;
  };

  const flushStack = (
    line: string,
    op?: any,
    provides?: number | number[],
    allowNonEmpty = false,
    peek = false
  ) => {
    if (stack.length) {
      if (!allowNonEmpty) {
        console.log('non empty stack after static line', stack, op, line);
        throw new Error('non empty stack after static line');
      }
      if (line) stackLines.push(line);
      if (provides !== undefined) {
        if (Array.isArray(provides)) stackProvides.push(...provides);
        else stackProvides.push(provides);
      }
    } else {
      collapseStack.push({
        line: [...stackLines, line].join('\n'),
        args: stackArgs,
        op,
        provides: stackProvides.concat(provides !== undefined ? provides : []),
      });
      if (!peek) {
        stackArgs = new Set();
        stackLines = [];
        stackProvides = [];
      }
    }
  };
  const getVar = (id: number) => (opts.jsStateArray ? `${vName}[${id}]` : `v${id}`);
  const stateValue = (id: number, value: string) => {
    const type = stateTypes[id];
    if (type === 'i32') return `((${value}) | 0)`;
    if (type === 'f32') return `Math.fround(${value})`;
    return value;
  };
  const retValue = (pos: number, value: string) => {
    const type = fn.outputs[pos];
    if (!opts.jsStateArray || type !== 'i32') return value;
    return `((${value}) | 0)`;
  };
  const getSetVar = (id: number, value: string) => {
    let res = `${getVar(id)} = ${opts.jsStateArray ? stateValue(id, value) : value};`;
    if (!opts.jsStateArray && forcedMutable.has(id)) {
      if (!forcedDeclared.has(id)) {
        forcedDeclared.add(id);
        res = `let ${res}`;
      }
      return res;
    }
    if (!varMutable.has(id) && !opts.jsStateArray) res = `const ${res}`;
    return res;
  };
  const flushPending = () => {
    if (stack.length) return;
    if (stackLines.length || stackProvides.length)
      collapseStack.push({
        line: stackLines.join('\n'),
        args: stackArgs,
        provides: stackProvides,
      });
    stackArgs = new Set();
    stackLines = [];
    stackProvides = [];
  };
  const blockStack: { kind: 'loop' | 'block'; label: string; op: Instr; stateVars: number[] }[] =
    [];
  for (let pos = 0; pos < instructions.length; pos++) {
    const i = instructions[pos];
    const eatTail = (outs: string[], forceMutableOnControl = false) => {
      let line = '';
      const sets = instructions.slice(pos + 1, pos + 1 + outs.length);
      const nextPos = pos + 1 + outs.length;
      const idx = [];
      for (let i of sets) {
        if (i.TAG !== 'local.set') throw new Error('non set after call');
        idx.push(Number(i.data));
      }
      pos += outs.length; // +1 after for should compensate? (not sure!)
      idx.reverse(); // they will eat stack in reverse order? (not sure!)
      const live: number[] = [];
      for (let i = 0; i < outs.length; i++) {
        let crossesControl = false;
        const liveAfter = isLiveAfter(instructions, nextPos, idx[i], () => (crossesControl = true));
        if (isDeadVar(idx[i]) || !liveAfter) continue;
        if (crossesControl && forceMutableOnControl) forcedMutable.add(idx[i]);
        line += `${getSetVar(idx[i], outs[i])}\n`;
        live.push(idx[i]);
      }
      return { line, idx: live };
    };

    if (i.TAG === 'local.get') {
      const id = Number(i.data);
      stack.push(getVar(id));
      stackArgs.add(id);
    } else if (i.TAG === 'local.tee') {
      const id = Number(i.data);
      const value = stackPop(pos);
      if (isDeadVar(id)) {
        if (stack.lastSide) stack.pushSide(value);
        else stack.push(value);
        continue;
      }
      // local.set(); push(local.get)
      flushStack(getSetVar(id, value), undefined, id, true);
      stack.push(getVar(id));
    } else if (i.TAG === 'local.set') {
      const id = Number(i.data);
      const value = stackPop(pos);
      if (isDeadVar(id)) {
        // Keep side-effectful RHS evaluation (for example Atomics RMW ops) even when the local is dead.
        if (stack.lastSide) flushStack(`${value};`, undefined, undefined, true);
        flushPending();
        continue;
      }
      flushStack(getSetVar(id, value), undefined, id, true);
    } else if (['br', 'br_if'].includes(i.TAG)) {
      const cond = i.TAG === 'br_if' ? stackPop(pos) : undefined;
      const target = blockStack[blockStack.length - 1 - Number(i.data)];
      if (!target) throw new Error('wrong br target');
      const jmp = `${target.kind === 'loop' ? 'continue' : 'break'} ${target.label};`;
      let line = '';
      const { op, stateVars } = target;
      if (op.data !== 'void') {
        const args: string[] = stack.slice(-op.data.inputs.length);
        if (args.length !== op.data.inputs.length)
          throw new Error('args.length !== op.data.inputs.length');
        const saveState = stateVars.map((i, j) => `s${i} = ${args[j]};`).join('\n');
        if (cond) {
          line = `if (${cond}) {
${saveState}${jmp}
}`;
        } else {
          line = `${saveState}${jmp}`;
        }
        flushStack(line, i, undefined, true, true);
        // if cond, then fallthrough stack (peek)
      } else {
        line = `${cond ? `if (${cond}) ` : ''}${jmp}`;
        flushStack(line, i);
      }
    } else if (['block', 'loop'].includes(i.TAG)) {
      const label = `L${labelIdx++}`;
      let line = '';
      const stateVars: number[] = [];
      blockStack.push({ kind: i.TAG, label, op: i, stateVars });
      const loopLine = `${label}: ${i.TAG === 'loop' ? 'for (;;)' : ''} {`;
      if (i.data !== 'void') {
        const args: string[] = [];
        for (const _ of i.data.inputs) {
          stateVars.push(lStateIdx++);
          args.push(stackPop(pos));
        }
        args.reverse();
        if (args.length) {
          line += `let ${stateVars.map((i, j) => `s${i} = ${args[j]}`).join(', ')};\n`;
        }
        const outs = [];
        for (const i of stateVars) outs.push(`s${i}`);
        const { line: tailLine, idx } = eatTail(outs);
        line += loopLine;
        line += tailLine;
        flushStack(line, i, idx);
        continue;
      } else if (!opts.jsStateArray && i.hoist.length) {
        const hoist = i.hoist.filter(
          (id: number) => !(forcedMutable.has(id) && forcedDeclared.has(id))
        );
        for (const id of hoist) if (forcedMutable.has(id)) forcedDeclared.add(id);
        // State-array mode writes these through array slots instead.
        if (hoist.length) line += `let ${hoist.map((i: number) => `v${i}`).join(', ')}\n`;
      }
      line += loopLine;
      flushStack(line, i);
    } else if (i.TAG === 'call') {
      const argsArr: string[] = [];
      for (let k = 0; k < i.opts.inputsCnt; k++) argsArr.unshift(stackPop(pos));
      if (i.opts.outTypes.length === 0) {
        flushStack(`${i.data}(${argsArr.join(', ')});`);
      } else {
        const tmp = `r${maxCallIdx++}`;
        let line = `const ${tmp} = ${i.data}(${argsArr.join(', ')});\n`;
        // JS generation expects codegen-normalized call results: call followed by local.set tails.
        // Now, those are weird and we need to mark everything that uses them
        const outs = [];
        if (i.opts.outTypes.length === 1) outs.push(tmp);
        else for (let k = 0; k < i.opts.outTypes.length; k++) outs.push(`${tmp}[${k}]`);
        const { line: tailLine, idx } = eatTail(outs, true);
        line += tailLine;
        flushStack(line, undefined, idx);
      }
    } else if (i.TAG === 'end') {
      const target = blockStack[blockStack.length - 1];
      if (target) {
        const { op, stateVars } = target;
        const end = `${target.kind === 'loop' ? `break ${target.label};` : ''}}\n`;
        if (op.data !== 'void') {
          const args: string[] = [];
          for (const _ of op.data.inputs) args.push(stackPop(pos));
          args.reverse();
          const saveState = stateVars.map((i, j) => `s${i} = ${args[j]};`).join('\n');
          const outs = [];
          for (let i of stateVars) outs.push(`s${i}`);
          const { line: tailLine, idx } = eatTail(outs);
          flushStack(`${saveState}${end}${tailLine}`, i, idx);
          blockStack.pop();
          continue;
        } else {
          if (stack.length) throw new Error('non empty stack');
          flushStack(end, i);
          blockStack.pop();
          continue;
        }
      }
      const line =
        stack.length === 1
          ? retValue(0, stack.pop()!)
          : stack.length === 0
            ? ''
            : opts.jsOutObject
              ? genObject(
                  Object.fromEntries(Array.from(stack, (i, j) => [`r${j}`, retValue(j, i)]))
                )
              : `[${Array.from(stack, (i, j) => retValue(j, i)).join(', ')}]`;
      stack.clear();
      flushStack(`return ${line};`, i);
      blockStack.pop();
    } else {
      const line = processInstructions(i, stack, isLE);
      if (!line) continue; // pushed to stack
      flushStack(line); // don't care about op here, non control!
    }
  }
  if (stack.length) throw new Error('non empty stack at the end');

  // console.log('----------' + name);
  // console.dir(collapseStack, { depth: null, maxArrayLength: null });
  // console.dir(instructions, { depth: null, maxArrayLength: null });

  let totalLength = 0;
  const usedBy: Record<number, number[]> = {}; // var -> pos in collapseStack
  for (let i = 0; i < collapseStack.length; i++) {
    const item = collapseStack[i];
    totalLength += item.line.length;
    for (const a of item.args) {
      if (!usedBy[a]) usedBy[a] = [];
      usedBy[a].push(i);
    }
  }

  type RegionInfo = {
    pos: number; // start index in collapseStack
    len: number; // number of items
    size: number; // cumulative line length (or change to line count if you prefer)
    args: number[]; // sorted unique local ids (inputs to part)
    outputs: number[]; // sorted unique local ids (outs that are used outside region)
  };
  // computes args/outputs like mergeRegion (no codegen), indexing via i=0..len-1 → pos+i
  function computeRegionMeta(pos: number, len: number): RegionInfo {
    let size = 0;
    const inputs = new Set<number>();
    const outputs = new Set<number>();
    for (let i = 0; i < len; i++) {
      const it = collapseStack[pos + i];
      size += it.line.length;
      for (const a of it.args) inputs.add(a);
      for (const p of it.provides) outputs.add(p);
    }
    // remove locals defined inside region from inputs
    for (let i = 0; i < len; i++) {
      for (const p of collapseStack[pos + i].provides) inputs.delete(p);
    }
    // keep only outputs that are used outside the region
    for (const o of outputs) {
      const uses = usedBy[o] || [];
      let usedOutside = false;
      for (const u of uses) {
        if (u < pos || u >= pos + len) {
          usedOutside = true;
          break;
        }
      }
      if (!usedOutside) outputs.delete(o);
    }
    return {
      pos,
      len,
      size,
      args: Array.from(inputs).sort((a, b) => a - b),
      outputs: Array.from(outputs).sort((a, b) => a - b),
    };
  }
  let partIdx = 0;

  // PRECOMPUTE once inside generateInstructions, before emitRegion():
  // maps local id -> first provide index in collapseStack (global)
  const firstProvidePos: Record<number, number> = {};
  for (let p = 0; p < collapseStack.length; p++) {
    for (const v of collapseStack[p].provides) {
      if (firstProvidePos[v] === undefined) firstProvidePos[v] = p;
    }
  }
  function emitRegion(pos: number, len: number): { res: string[]; call: string } {
    type Chunk = { start: number; len: number; size: number; lines: string };

    // 1) chunking (unchanged)
    const chunks: Chunk[] = [];
    let start = pos,
      left = len;
    while (left > 0) {
      let chunkLen = 0,
        chunkSize = 0;
      for (; chunkLen < left; chunkLen++) {
        const it = collapseStack[start + chunkLen];
        if (it.op) throw new Error('cannot collapse: control');
        const nextSize = chunkSize + it.line.length;
        if (nextSize > LIMIT && chunkLen > 0) break;
        chunkSize = nextSize;
        if (chunkLen === 0 && chunkSize > LIMIT) break;
      }
      if (chunkLen === 0) chunkLen = 1;

      let lines = '';
      for (let i = 0; i < chunkLen; i++) lines += collapseStack[start + i].line + '\n';
      chunks.push({ start, len: chunkLen, size: chunkSize, lines });

      start += chunkLen;
      left -= chunkLen;
    }

    // Region meta used only in locals mode
    const regionMeta = computeRegionMeta(pos, len);
    const regionOuts = regionMeta.outputs;

    const parts: string[] = [];
    const names: string[] = chunks.map(() => `${name}_part${partIdx++}`);

    if (opts.jsStateArray) {
      // ---- STATE ARRAY MODE ----
      // No params, no returns; mutate V[] and tail-call next
      for (let k = chunks.length - 1; k >= 0; k--) {
        const cur = chunks[k];
        const next = k < chunks.length - 1 ? names[k + 1] : null;
        const tail = next ? `return ${next}();` : `return;`;
        parts.push(
          `function ${names[k]}(){
${cur.lines}${tail}
}`
        );
      }
      // Main call: no args, no destructuring
      return { res: parts, call: `${names[0]}();` };
    }

    // ---- LOCALS MODE ----
    // We need params/returns. Compute suffix/carry params as before.
    const endPos = pos + len;
    const suffixArgs: number[][] = [];
    const carried: number[][] = [];
    const params: number[][] = [];

    for (let k = 0; k < chunks.length; k++) {
      const s = chunks[k].start;
      const sufMeta = computeRegionMeta(s, endPos - s);
      suffixArgs[k] = sufMeta.args;

      const carry: number[] = [];
      for (const o of regionOuts) {
        const fp = firstProvidePos[o];
        if (fp !== undefined && fp < s && fp >= pos) carry.push(o);
      }
      carried[k] = Array.from(new Set(carry)).sort((a, b) => a - b);
    }
    for (let k = 0; k < chunks.length; k++) {
      const set = new Set<number>();
      for (const a of suffixArgs[k]) set.add(a);
      for (const c of carried[k]) set.add(c);
      params[k] = Array.from(set).sort((a, b) => a - b);
    }

    // Emit param-ful parts; identifiers are v${id} here (locals mode only)
    for (let k = chunks.length - 1; k >= 0; k--) {
      const cur = chunks[k];
      const paramsIdList = params[k].map((id) => `v${id}`).join(', ');
      let ret: string;
      if (k < chunks.length - 1) {
        const nextArgsExpr = params[k + 1].map(getVar).join(', ');
        ret = `return ${names[k + 1]}(${nextArgsExpr});`;
      } else {
        const outsObj = regionOuts.map((id) => `v${id}: ${getVar(id)}`).join(', ');
        ret = regionOuts.length ? `return {${outsObj}};` : `return;`;
      }
      parts.push(
        `function ${names[k]}(${paramsIdList}){
${cur.lines}${ret}
}`
      );
    }

    // Main call: destructure identifiers (v${id}) and pass expression args (getVar)
    const callArgsExpr = params[0].map(getVar).join(', ');
    const finalOutsBind = regionOuts.map((id) => `v${id}`).join(', ');
    const call = regionOuts.length
      ? `const {${finalOutsBind}} = ${names[0]}(${callArgsExpr});`
      : `${names[0]}(${callArgsExpr});`;

    return { res: parts, call };
  }
  function mergeRegion(region: any[], pos: number) {
    if (region[0] !== collapseStack[pos]) throw new Error('wrong pos');
    return emitRegion(pos, region.length);
  }
  const parts: string[] = [];
  function buildBigRegions(): RegionInfo[] {
    const regions: RegionInfo[] = [];
    let curPos = -1; // start index of open region, -1 means none
    let curLen = 0; // length of open region
    const finalize = () => {
      if (curPos < 0 || curLen <= 0) return undefined;
      regions.push(computeRegionMeta(curPos, curLen));
      curPos = -1;
      curLen = 0;
    };
    for (let i = 0; i < collapseStack.length; i++) {
      const it = collapseStack[i];
      // control boundary → close any open region and skip control item
      if (it.op) {
        finalize();
        continue;
      }
      // start new region if needed
      if (curPos < 0) {
        curPos = i;
        curLen = 0;
      }
      // safe to grow
      curLen++;
      continue;
    }
    // tail
    finalize();
    return regions;
  }
  if (totalLength > LIMIT) {
    const regions = buildBigRegions();
    for (let i = regions.length - 1; i >= 0; i--) {
      const r = regions[i];
      if (r.size < LIMIT) continue;
      const region = collapseStack.slice(r.pos, r.pos + r.len);
      const merged = mergeRegion(region, r.pos);
      parts.push(...merged.res); // now an array (sub-parts possible)
      collapseStack.splice(r.pos, r.len, { line: merged.call } as any);
    }
  }

  let stateOuter = '',
    stateInit = '';
  if (opts.jsStateArray) {
    let locals = inputs.length;
    for (const { count } of fn.locals) locals += count;
    // Int32Array preserves signed i32 reads; Float64Array keeps mixed numeric state exact.
    const stateCtor = stateTypes.every((i) => i === 'i32')
      ? 'Int32Array'
      : stateTypes.every((i) => i === 'f32')
        ? 'Float32Array'
        : 'Float64Array';
    // Hoist a unique buffer per generated function.
    stateOuter = `const ${vName} = new ${stateCtor}(${locals});`;
    // Alias to V inside, then seed params each call
    const init = inputs.map((n: string, i: number) => {
      return `${vName}[${i}] = ${stateValue(i, n)};`;
    });
    stateInit = init.join('\n');
  }
  const res = `
${parts.join('\n')}
${stateOuter}
function ${name}(${inputs.join(', ')}) {
    ${stateInit}
    ${collapseStack.map((i) => i.line).join('\n')}
}`;
  // console.log('------ INPUT --------');
  // console.dir(instructions, { depth: null });
  // console.log('----- GENERATED -----');
  // console.log(res);
  // console.log('---------------------');
  return res;
}

/**
 * Generates the pure JavaScript fallback implementation for a lowered module.
 *
 * @param mod - Lowered Wasm-compatible module description.
 * @param importEmbed - Embedded import callbacks by module name.
 * @param opts - Compiler options. {@link CompilerOpts}
 * @returns JavaScript source that builds an instance object without using
 * the WebAssembly namespace.
 * @throws If duplicate generated function names are found. {@link Error}
 * @example
 * ```js
 * import { createJS } from '@awasm/compiler/js.js';
 *
 * createJS({ name: 'demo', memory: { size: 0 }, functions: [] }, { env: {} });
 * ```
 */
export function createJS(
  mod: WasmModule,
  importEmbed: ImportEmbed,
  opts: CompilerOpts = {}
): string {
  const modMemory = mod.memory || { size: 0 };
  const bufType = `${modMemory.shared ? 'Shared' : ''}ArrayBuffer`;
  // JS output consumes compiler-normalized instructions, not arbitrary
  // raw Wasm control opcodes.
  // Keep this path free of the WebAssembly namespace; it is the wasm-less fallback target.
  // Compiler JS should reach here with i64/u64 lowered to i32/u32 parts.
  // BigInt paths are too slow.
  const createBuf = `new ${bufType}(${modMemory.size})`;
  const fixInstructions = (fn: ElementOf<typeof mod.functions>) => ({
    ...fn,
    instructions: fn.instructions!.map((i) => i),
  });
  // State-array names are per generated module; process-global counters
  // make repeated builds drift.
  let stateArrayIdx = 0;
  const fnBody = mod.functions
    .filter((f) => !f.import)
    .map((fn) => generateInstructions(fixInstructions(fn), opts, true, stateArrayIdx++))
    .join('\n');
  const need = (name: string) => new RegExp(`\\b${name}\\b`).test(fnBody);
  const needEnv = !!modMemory.import || mod.functions.some((f) => f.import);
  let out = '\n';
  if (needEnv) out += `const env = _imports.env;\n`;
  // JS fallback/worker-pool paths may not have a WebAssembly.Memory object, so
  // imported JS memory intentionally accepts any memory-like object with a buffer.
  out += `const __buf = ${modMemory.import ? `env && env._memory ? env._memory.buffer : ${createBuf}` : createBuf};\n`;
  out += `if (!(__buf instanceof ${bufType})) throw new Error('wrong buffer');\n`;
  // Internal stuff
  out += '\n';
  if (need('memory')) out += `const memory = new Uint8Array(__buf);\n`;
  if (need('memory_i8')) out += `const memory_i8 = new Int8Array(__buf);\n`;
  if (need('memory_u16')) out += `const memory_u16 = new Uint16Array(__buf);\n`;
  if (need('memory_i16')) out += `const memory_i16 = new Int16Array(__buf);\n`;
  if (need('memory_u32')) out += `const memory_u32 = new Uint32Array(__buf);\n`;
  if (need('memory_i32')) out += `const memory_i32 = new Int32Array(__buf);\n`;
  if (need('memory_view')) out += `const memory_view = new DataView(__buf);\n`;
  const importFns: Record<string, string[]> = {};
  for (const f of mod.functions.filter((f) => f.import)) {
    const modName = f.module || 'env';
    if (!importFns[modName]) importFns[modName] = [];
    importFns[modName].push(f.name);
  }
  // Function imports keep the explicit import module; env is just the default.
  for (const modName in importFns) {
    const src = modName === 'env' ? 'env' : `_imports[${JSON.stringify(modName)}]`;
    out += `const {${importFns[modName].join(', ')}} = ${src};\n`;
  }
  const fnNames: Record<string, ElementOf<typeof mod.functions>> = {};
  for (const fn of mod.functions) {
    if (fnNames[fn.name]) throw new Error(`createJS: re-declared function ${fn.name}`);
    fnNames[fn.name] = fn;
  }
  out += fnBody;
  out += '\n';
  const exportMap: Record<string, string> = {};
  for (const fn of mod.functions) if (fn.export) exportMap[fn.name] = fn.name;
  if (modMemory.export) exportMap.memory = `{ buffer: __buf }`;
  out += `const instance = { exports: ${genObject(exportMap)}};\n`;
  if (opts.useThreads) {
    out = `const codeFn = ()=>{
    ${out}
    return instance;
}
${initWorkers('js', importEmbed, opts)}
const instance = codeFn();
const code = codeFn.toString();
`;
  }
  return out;
}

/**
 * Generates a JavaScript prelude that instantiates embedded Wasm bytes.
 *
 * @param mod - Lowered Wasm-compatible module description.
 * @param code - Wasm binary bytes.
 * @param importEmbed - Embedded import callbacks by module name.
 * @param opts - Compiler options. {@link CompilerOpts}
 * @returns JavaScript source that creates `module` and `instance` bindings.
 * @example
 * ```js
 * import { wrapWASM } from '@awasm/compiler/js.js';
 *
 * wrapWASM({ name: 'demo', memory: { size: 0 }, functions: [] }, new Uint8Array(), { env: {} });
 * ```
 */
export function wrapWASM(
  mod: WasmModule,
  code: TArg<Uint8Array>,
  importEmbed: ImportEmbed,
  opts: CompilerOpts = {}
): string {
  const wasmMem = (mod: WasmModule) => {
    const { opts } = wasmMemoryOpts(mod);
    return `new WebAssembly.Memory(${genObject({ initial: opts.initial, maximum: opts.maximum, shared: opts.flags.shared })})`;
  };
  const codeExpr = opts.wasmAsHex
    ? `Uint8Array.from(
\`
${hexLiteral(code)}
\`
  .match(/[0-9a-f]{2}/g),
  (i) => parseInt(i, 16)
)`
    : `Uint8Array.from(atob('${base64.encode(code)}'), char => char.charCodeAt(0))`;
  return `
${initWorkers('wasm', importEmbed, opts)};
if (!_imports.env._memory) _imports.env._memory = ${wasmMem(mod)};
const code = ${codeExpr};
const module = new WebAssembly.Module(code);
const instance = new WebAssembly.Instance(module, _imports);
`;
}

/** Embedded import callback source strings by import module and function name. */
export type ImportEmbed = Record<string, Record<string, string>>;
/** Generated wrapper source and declaration strings. */
export type WrappedModule = {
  /** Raw IIFE body used by `exec`. */
  raw: string;
  /** Generated TypeScript return type body. */
  typeRaw: string;
  /** Generated ES module default export source. */
  modFn: string;
  /** Generated ES module declaration source. */
  modFnType: string;
};

/**
 * Wraps generated backend source with public exports, memory views, and types.
 *
 * @param mod - Lowered Wasm-compatible module description.
 * @param code - Backend implementation source.
 * @param segments - Allocated memory segment metadata.
 * @param importEmbed - Embedded import callbacks by module name.
 * @param opts - Compiler options. {@link CompilerOpts}
 * @returns Raw wrapper source plus generated type declarations.
 * @throws If an exported function or memory type cannot be represented. {@link Error}
 * @example
 * ```js
 * import { wrapModule } from '@awasm/compiler/js.js';
 *
 * wrapModule({ name: 'demo', memory: { size: 0 }, functions: [] }, '', {}, { env: {} });
 * ```
 */
export function wrapModule(
  mod: WasmModule,
  code: string,
  segments: any,
  importEmbed: ImportEmbed,
  opts: CompilerOpts = {}
): WrappedModule {
  const embed = importEmbed || {};
  const hasCustomEmbeddedImport = Object.keys(embed).some((k) => k !== 'env');
  // Custom embedded import modules must merge like env; otherwise caller-provided
  // functions for the same module replace embedded callbacks instead of extending them.
  const mergeImports = hasCustomEmbeddedImport
    ? [
        `_imports = {..._importsEmbed, ..._imports};`,
        `for (const k in _importsEmbed) _imports[k] = ` +
          `{..._importsEmbed[k], ...(_imports[k] || {})};`,
      ].join('\n')
    : `_imports = {..._importsEmbed,..._imports, env: {..._importsEmbed.env, ..._imports.env}};`;
  // Wrapped modules expose memory through exported wasm memory; raw
  // imported-only memory is unsupported.
  let moduleStr = `
const _importsEmbed = ${genObject({ env: {}, ...embed })};
${mergeImports}

${code}
${opts.useThreads ? '_imports.env.initWorkers()' : ''};
const _exports = instance.exports;
const buffer = _exports.memory ? _exports.memory.buffer : new ArrayBuffer(0);
const memoryExport = new Uint8Array(buffer, 0, ${mod.memory ? mod.memory.size : 'buffer.length'});
`;
  if (opts.useThreads) moduleStr = `\nconst workers = [];\n${moduleStr}`;
  //  const types = genTypes(fns, segments, opts);
  // Freeze applies to generated wrapper containers, including segment chunk arrays.
  const views = memViews(segments, opts);
  moduleStr += `const segments = ${freeze(genObject(views), opts)};\n`;
  // Build types
  let segmentsType = `{\n`;
  for (const v in views)
    segmentsType += `    readonly ${v.includes('.') ? `'${v}'` : v}: ${v.endsWith('chunks') ? 'ReadonlyArray<Uint8Array>' : 'Uint8Array'};\n`;
  segmentsType += '  };';
  const mapType = (t: string) => {
    if (t === 'i32' || t === 'f32' || t === 'f64') return 'number';
    if (t === 'i64') return 'bigint';
    throw new Error('unknown type: ' + t);
  };
  const mapFn = (f: any) => {
    const outType = f.outputs.length
      ? f.outputs.length === 1
        ? mapType(f.outputs[0])
        : `[${f.outputs.map((i: string) => mapType(i)).join(', ')}]`
      : 'void';
    return `${f.name}(${f.inputs.map((i: string, j: number) => `v${j}: ${mapType(i)}`).join(', ')}): ${outType};`;
  };

  let fnsType = '';
  for (const f of mod.functions) {
    if (!f.export) continue;
    fnsType += `  ${mapFn(f)}\n`;
  }
  const fullType = `{
  readonly memory: Uint8Array;
  readonly segments: ${segmentsType}
${fnsType}}`;
  const iifeRaw = `${moduleStr}\nreturn ${freeze(`{ ..._exports, memory: memoryExport, segments ${opts.useThreads ? ', workers, initWorkers' : ''} }`, opts)};`;
  // IIFE vs top level:
  // - IIFE can be instantiated on call site: opt specialization, each instance has own memory
  // - top level: code re-use, same memory, maybe less 'deopt huge function' since huge function
  //   is now module? (not sure)
  let modFn = `export default function ${mod.name}(_imports = {}, pool){${iifeRaw}}`;
  if (opts.reuseModule) {
    modFn = `
function init_module(_imports = {}, pool){${iifeRaw}}
let _cache;
export default function ${mod.name}(_imports = {}, pool){
  if (_cache) return _cache;
  return (_cache = init_module(_imports, pool));
}`;
  }
  const res = {
    raw: iifeRaw,
    typeRaw: fullType,
    modFn,
    modFnType: `export default function ${mod.name}(_imports?: any, pool?: any): ${fullType};`,
  };
  return res;
}

/**
 * Executes generated wrapper source immediately.
 *
 * @param code - Raw wrapper source or object returned by `wrapModule`.
 * @param _imports - Imports passed to the wrapper.
 * @param pool - Optional worker pool object for threaded modules.
 * @returns The generated module exports.
 * @example
 * ```js
 * exec('return { value: 1 };');
 * ```
 */
export function exec(code: string | WrappedModule, _imports: {} = {}, pool?: any): any {
  if (typeof code !== 'string') code = code.raw;
  return new Function('_imports', 'pool', code)(_imports, pool);
}
