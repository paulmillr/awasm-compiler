# AWASM compiler

> Awesome? WASM? AWASM!

Auditable js-to-wasm compiler, focusing on ultra-high performance & security.

- 🪶 Small: 0 deps, ~10K lines of code
- 🏎 Fast: produces JIT-friendly code
- Multi-backend: compile to wasm, larger JS, threaded wasm, or runtime
- Parallel: manages threads and SIMD without hassle
- Stable code ordering: allows deterministic builds

### This library belongs to _awasm_

> **awasm** — high-security, auditable WASM packages

- **Reproducible builds:** deterministic cross-platform builds
- **Auditable compiler:** reasonably small JS-to-WASM compiler
- **Synchronous execution:** with optional async variant
- Zero or minimal dependencies
- PGP-signed releases and transparent NPM builds
- [Check out the homepage](https://paulmillr.com/awasm/)

## Usage

> `npm install @awasm/compiler`

```typescript
import { Module, array } from '@awasm/module.js';
import { toWasm, toJs } from '@awasm/codegen.js';
import * as js from '@awasm/js.js';

// 1. Define module
const mod = new Module('example')
  .mem('data', array('u32', {}, 16))
  .fn('sum', [], 'u32', (s) => {
    const { u32 } = s.types;
    const [total] = s.doN([u32.const(0)], 16, (i, acc) => {
      const val = s.memory.data[i].get();
      return [u32.add(acc, val)];
    });
    return total;
  });

// 2. Compile
const wasmCode = toWasm(mod);  // WebAssembly version
const jsCode = toJs(mod);      // Pure JS fallback

// 3. Execute
const instance = js.exec(wasmCode);

// 4. Use
instance.segments['data'].set(new Uint8Array([1,0,0,0, 2,0,0,0, ...]));
const result = instance.sum();  // returns sum of data array
```

Below are example how can awasm compiler be used.

<!-- TOC start -->
* [Project Structure](#project-structure)
* [Differences from raw WASM](#differences-from-raw-wasm)
* [Quick Start](#quick-start)
* [Module Definition](#module-definition)
  + [Creating a Module](#creating-a-module)
  + [Composing Modules: `.use()`](#composing-modules-use)
  + [Memory: `.mem()` / `.batchMem()`](#memory-mem--batchmem)
  + [Functions: `.fn()`](#functions-fn)
  + [Batched Functions: `.batchFn()`](#batched-functions-batchfn)
  + [Import Functions: `.importFn()`](#import-functions-importfn)
* [Compilation & Execution](#compilation--execution)
  + [Compiling](#compiling)
  + [Executing](#executing)
  + [Writing to Files](#writing-to-files)
  + [Runtime Interpreter](#runtime-interpreter)
  + [Instance Shape](#instance-shape)
  + [Accessing Memory from JS](#accessing-memory-from-js)
  + [Debugging](#debugging)
* [Scope Reference](#scope-reference)
* [Types](#types)
  + [Type Methods](#type-methods)
  + [Type Conversions](#type-conversions)
* [Operations](#operations)
  + [Basic Arithmetic](#basic-arithmetic)
  + [Comparison](#comparison)
  + [Bitwise (Integer Only)](#bitwise-integer-only)
  + [Shifts (Integer Only)](#shifts-integer-only)
  + [Signed Only](#signed-only)
  + [Float Only](#float-only)
  + [SIMD Only](#simd-only)
  + [Generics](#generics)
* [Memory Access](#memory-access)
  + [Basic Access](#basic-access)
  + [Views](#views)
  + [Byte Operations](#byte-operations)
  + [SIMD Lanes](#simd-lanes)
  + [Atomics](#atomics)
  + [Mut (Non-Atomic RMW)](#mut-non-atomic-rmw)
* [Control Flow](#control-flow)
  + [State-Passing Model](#state-passing-model)
  + [Loops](#loops)
  + [Conditionals](#conditionals)
  + [Low-Level Control](#low-level-control)
* [Quick Reference](#quick-reference)
  + [Operations by Type](#operations-by-type)
  + [Memory Quick Reference](#memory-quick-reference)
  + [Control Flow Quick Reference](#control-flow-quick-reference)

<!-- TOC end -->

## Project structure

The compiler is structured as follows:

- `wasm.ts`: generic binary encoder/decoder for wasm. not full spec (tables/extref missing), but can be used to inspect generated wasm modules
- `js.ts`: wasm ops -> js ops code generation, wasm boilerplate, web workers boilerplate
- `runtime.ts`: small runtime executor/interpreter. **NOTE**: should have minimum amount of dependencies on other stuff
- `module.ts`: small structure that holds functions/memory definitions, user facing types. Used for executor.
- `types.ts`: definitions of operations for various types.
- `memory.ts`:
  - `allocateMemSpec`: calculates sizes/alignment of nested memory structures
  - `memoryProxy`: user facing API for memory operations
  - `memOps`: compiler specific operations for `memoryProxy` (not used in executor!)
- `codegen.ts`
  - `toInstr`: collapses `TreeDAG` into stack-based operations for wasm/js code generation, strips types (u32->i32).
  - `toWasm`/`toJs`: compiles `Module` into wasm/js code.
- `rewrites.ts`: graph transformation
  **NOTE**: it is important that all transformations are stable (we cannot have two transformation that does `a->b` and then `b->a`), since we don't have
  compiler passes budgets to enforce reproducible builds. All transformation continuosly applied until there is no changes to graph.
  - `lowerSIMD`: lowers SIMD operation to scalar ones
  - `lowerU64`: lowers u64/i64 operations into pairs of u32/i32
  - `lowerVirtualSIMDPairs`: lowers SIMD virtual types like `u64x4` -> `2xu64x2`
  - `lowerVirtualSIMDMask`: lowers SIMD masked virtual types like `u32x2` -> `u32x4`
  - `lowerPattern`: merges `pattern` operation (same as SIMD shuffle, but for scalars) into load/store for swapEndianess.
  - `lowerU64Arg`: lowers i64/u64 function arguments into two i32/u32. separate from 'lowerU64' because changes API, also because current graph is per function only.
  - `lowerWasm`: fixes various unsupported operations in wasm, like missing 'not'/'neg', etc.
  - `lowerPatternJS`: lowers 'pattern' that wasn't merged into store/load. Mostly to allow 'swapEndianess' in runtime type modules/tests.
  - `optimize`: constant folding and various small optimizations
- `utils.ts`: various small utils.
  - `TreeDAG` - core of compiler, data structure that represents tree of directed acyclic graphs. Applies rewrites, removes unused nodes, does topological sort.
- `workers.ts`: helper functions for threading/simd, processes `batchFn`.

## Differences from raw WASM

WASM is designed for encoding compactness, not ergonomics. We provide:

| WASM limitation                                                   | AWASM solution                |
| ----------------------------------------------------------------- | ----------------------------- |
| No `u32`/`u64` types (only `i32` + unsigned ops)                  | Proper unsigned types         |
| No bitwise ops on `i32x4`/`i64x2` (only `v128`)                   | Bitwise ops on all SIMD types |
| `not` is SIMD-only                                                | `not` on scalars too          |
| No `rotl`/`rotr` in SIMD                                          | Rotation on all types         |
| No lane swizzles for `i32x4`/`i64x2`                              | `shuffleLanes` for all SIMD   |
| No `eqz` on SIMD                                                  | Added                         |
| No unsigned comparisons on `i64x2`                                | Added                         |
| SIMD compares produce mask vectors that can’t be used with select | Unified via `select` handling |

Plus higher-level conveniences: endianness conversion, unified scalar/SIMD API with automatic interleaving.

## Quick Start

```typescript
import { Module, array } from '@awasm/compiler/module.js';
import { toWasm, toJs } from '@awasm/compiler/codegen.js';
import * as js from '@awasm/compiler/js.js';

// 1. Define module
const mod = new Module('example')
  .mem('data', array('u32', {}, 16))
  .fn('sum', [], 'u32', (s) => {
    const { u32 } = s.types;
    const [total] = s.doN([u32.const(0)], 16, (i, acc) => {
      const val = s.memory.data[i].get();
      return [u32.add(acc, val)];
    });
    return total;
  });

// 2. Compile
const wasmCode = toWasm(mod);  // WebAssembly version
const jsCode = toJs(mod);      // Pure JS fallback

// 3. Execute
const instance = js.exec(wasmCode);

// 4. Use
instance.segments['data'].set(new Uint8Array([1,0,0,0, 2,0,0,0, ...]));
const result = instance.sum();  // returns sum of data array
```

---

## Module Definition

### Creating a Module

```typescript
const mod = new Module('moduleName')  // name used in generated code
  .mem(...)      // define memory region
  .batchMem(...) // define batched memory (auto-sized for SIMD/threads)
  .fn(...)       // define function
  .batchFn(...)  // define batched/parallel function
  .importFn(...) // import external function
  .use(...)      // compose with another module builder
```

Methods are chainable and return the module for further definition.

### Composing Modules: `.use()`

```typescript
.use(transformer)
```

Applies a function that extends the module. Useful for reusable patterns:

```typescript
// Define reusable module extension
function addPadding<M, F>(mod: Module<M, F>) {
  return mod.mem('padBuffer', array('u32', {}, 64)).fn('pad', ['u32'], 'void', (s, len) => {
    /* ... */
  });
}

// Use it
const mod = new Module('hash')
  .mem('state', array('u32', {}, 8))
  .use(addPadding) // adds padBuffer and pad function
  .fn('hash', ['u32'], 'void', (s, len) => {
    s.functions.pad.call(len); // can call the added function
  });
```

### Memory: `.mem()` / `.batchMem()`

```typescript
import { array, struct, scalar } from '@awasm/compiler/module.js';

.mem('name', spec)
.batchMem('name', spec)  // wraps in array, outer dimension auto-sized
```

`batchMem` converts the spec to an array if not already one, then adds an outer dimension sized for parallelism (SIMD lanes × thread count). For arrays, it just prepends the dimension; for non-arrays (struct, scalar), it wraps them in an array first.

**Specs:**

| Spec                          | Example                          |
| ----------------------------- | -------------------------------- |
| `array(type, opts, ...sizes)` | `array('u32', {}, 64, 64)`       |
| `struct({ fields }, opts)`    | `struct({ x: 'f32', y: 'f32' })` |
| `scalar(type, opts)`          | `scalar('u64')`                  |

Specs can be nested arbitrarily:

```typescript
// Array of structs
array(struct({ x: 'f32', y: 'f32', z: 'f32' }), {}, 100);

// Struct with nested array
struct({
  header: 'u64',
  data: array('u32', {}, 256),
  checksum: 'u32',
});

// Deeply nested
struct({
  meta: struct({ version: 'u32', flags: 'u32' }),
  blocks: array(struct({ id: 'u64', payload: array('u32', {}, 16) }), {}, 16),
});
```

**Options:**

| Option           | Description                                          |
| ---------------- | ---------------------------------------------------- |
| `swapEndianness` | Byte-swap on load/store (see note below)             |
| `align`          | Starting position alignment (default: 16 for arrays) |
| `alignEnd`       | End padding alignment                                |

**Endianness:** Memory defaults to little-endian (WASM behavior). With `swapEndianness: true`, data is read/written as big-endian. Note: not tested on native big-endian systems.

**Fixed size:** Memory size is fixed at compile time — no grow, no shrink.

Types can be nested arbitrarily.

### Functions: `.fn()`

```typescript
.fn(name, inputs, outputs, callback)
```

- `inputs`: Array of input types `['u32', 'u64', ...]`
- `outputs`: Return type(s) `'u32'` or `['u32', 'u32']` or `'void'`
- `callback`: `(scope, ...args) => returnValue`

```typescript
.fn('add', ['u32', 'u32'], 'u32', (s, a, b) => {
  return s.types.u32.add(a, b);
})

.fn('swap', ['u32', 'u32'], ['u32', 'u32'], (s, a, b) => {
  return [b, a];  // multiple returns
})
```

### Batched Functions: `.batchFn()`

For SIMD/parallel processing:

```typescript
.batchFn(name, opts, inputs, callback)
```

- `opts`: `{ lanes: number, perThread?: number }`
- `callback`: `(scope, lanes, batchPos, perBatchSize, ...args) => void`

**Important:** The callback signature differs from how the function is called:

```typescript
// Definition: callback receives (scope, lanes, pos, perBatchSize, ...args)
.batchFn('process', { lanes: 4 }, ['u32', 'u32'], (s, lanes, pos, perBatch, arg1, arg2) => {
  // lanes: 1 for scalar, 4 for SIMD
  // pos: current batch position
  // perBatch: passed through from caller, used for thread work allocation
})

// Usage: called as (batchPos, batchLen, perBatchSize, ...args)
instance.process(0, 100, 16, arg1Value, arg2Value);
```

The `perBatchSize` parameter indicates how much work each batch item represents. It's passed through to the callback and used internally for thread allocation when `perThread` is set.

**Note:** `batchFn` has no return type — returns would be too complex with threads. Use memory to communicate results.

**Combined example with batchMem and lanes:**

```typescript
const mod = new Module('parallel')
  // batchMem: outer dimension auto-sized for parallelism
  .batchMem(
    'streams',
    struct({
      state: array('u32', {}, 8),
      counter: 'u64',
    })
  )
  .batchFn('process', { lanes: 4 }, ['u32'], (s, lanes, pos, perBatch, rounds) => {
    const T = s.getType('u32', lanes);
    // .lanes(lanes)[pos] accesses `lanes` parallel streams at once
    const stream = s.memory.streams.lanes(lanes)[pos];

    // Load state from 4 parallel streams as SIMD vectors
    const state = stream.state.get(); // array of u32x4

    // Process...
    const newState = state.map((v) => T.add(v, T.const(1)));

    // Store back to 4 streams
    stream.state.set(newState);
  });

// Called as: instance.process(batchPos, batchLen, perBatchSize, rounds)
```

**How batching works:** The `batchLen` parameter controls the internal loop — your callback doesn't see it directly. Instead, the runtime calls your callback multiple times:

- With `lanes=4` (or your configured max) for full SIMD batches
- With `lanes=1` for leftover elements

Example: 17 items with `{ lanes: 4 }` → callback called with `lanes=4` at positions 0, 4, 8, 12, then `lanes=1` at position 16.

**`perBatchSize`:** Only affects thread scheduling — how work gets divided across threads when `perThread` is set. Has no effect on memory layout or SIMD behavior.

### Import Functions: `.importFn()`

```typescript
.importFn(name, inputs, outputs, callback?, module?)
```

Two modes:

1. **With callback**: Function is serialized via `.toString()` and embedded. **Cannot capture closures** — only reference global variables.

```typescript
.importFn('log', ['u32'], 'void', (value) => {
  console.log('Value:', value);  // uses global console
})
```

2. **Without callback**: Function must be provided at runtime via `_imports`. Looks in `_imports.env` by default, or `_imports[module]` if module specified.

```typescript
// Definition
.importFn('hash', ['u32', 'u32'], 'u32')
.importFn('compress', ['u32'], 'void', undefined, 'crypto')

// Usage
js.exec(code, {
  env: { hash: (a, b) => a ^ b },
  crypto: { compress: (x) => { ... } }
});
```

---

## Compilation & Execution

### Compiling

```typescript
import { toWasm, toJs } from '@awasm/compiler/codegen.js';

const wasmResult = toWasm(mod); // Compiles to WebAssembly
const jsResult = toJs(mod); // Compiles to pure JavaScript
```

Use `toWasm` for best performance. Use `toJs` as a fallback for environments without WASM support, or for easier debugging (readable generated code).

Both return an object:

```typescript
{
  raw: string,       // IIFE code to execute
  typeRaw: string,   // TypeScript type definition
  modFn: string,     // ES module export
  modFnType: string, // ES module type export
}
```

### Executing

```typescript
import * as js from '@awasm/compiler/js.js';

const instance = js.exec(wasmResult);
// or
const instance = js.exec(jsResult);
// or
const instance = js.exec(wasmResult, imports, pool);
```

### Writing to Files

To avoid `js.exec` (which uses `eval`), write the generated code to files and import:

```typescript
import { writeFileSync } from 'fs';

const result = toWasm(mod);

// Write as ES module
writeFileSync('./build/myModule.js', result.modFn);
writeFileSync('./build/myModule.d.ts', result.modFnType);

// Then import normally
import myModule from './build/myModule.js';
const instance = myModule();
```

### Runtime Interpreter

For debugging or executing without a compilation step (also smaller build size):

```typescript
import { toRuntime } from '@awasm/compiler/runtime.js';
import { genRuntimeTypeMod, TYPE_MOD_OPTS } from '@awasm/compiler/types.js';

// Generate type module once
const typeMod = js.exec(toJs(genRuntimeTypeMod(), TYPE_MOD_OPTS));

// Create interpreter instance
const instance = toRuntime(() => typeMod, mod)();
```

### Instance Shape

```typescript
{
  // Exported functions
  sum(): number,
  process(a: number, b: number): void,

  // Raw memory buffer
  memory: Uint8Array,

  // Named memory segment views
  segments: {
    'data': Uint8Array,
    'state.counter': Uint8Array,
    'state.buffer': Uint8Array,
    // ...
  }
}
```

**JS memory views:** All exported segments are `Uint8Array` views (bytes), regardless of element type.
**`_chunks`:** For batched memory, `segments['name']` gives the full region while `segments['name']._chunks` is an array indexing into the outer (batch) dimension. Use `_chunks[i]` to access individual batch slots.
**u64 at JS boundary:** Returns either BigInt or `[lo, hi]` pair depending on compiler options.

### Accessing Memory from JS

```typescript
const instance = js.exec(toWasm(mod));

// Read/write via segments
instance.segments['data'].set(inputBytes);
const output = instance.segments['result'].slice();

// Or via raw memory at specific offsets
instance.memory.set(data, offset);
```

**Segments vs raw memory:** Segments abstract away internal padding/alignment. The `segments['name']` view gives you exactly the data described by your spec, even if the underlying memory has padding between fields.

### Debugging

Use `s.print()` inside functions to log values at runtime (converted to u32 for display).

To inspect generated code, access `result.raw` — it's a JS string containing either pure JS code or JS boilerplate that instantiates the WASM module:

```typescript
const result = toJs(mod);
console.log(result.raw); // readable JS implementation

const wasmResult = toWasm(mod);
console.log(wasmResult.raw); // JS with embedded WASM base64
```

---

## Scope Reference

The first argument to function callbacks is the `Scope`, providing access to everything:

```typescript
.fn('example', ['u32'], 'void', (s, arg) => {
  // Type operations
  const { u32, f64, u32x4 } = s.types;

  // Dynamic type access
  const T = s.getType('u32', lanes);           // concrete type
  // OR
  const T = s.getTypeGeneric<UnsignedType, T>(type, lanes);  // generic

  // Memory access
  s.memory.buffer[i].get();
  s.memory.buffer[i].set(value);

  // Call other functions
  const [result] = s.functions.helper.call(arg);
  s.functions.sideEffect.callIf(cond, arg);  // conditional, no return

  // Control flow
  s.doN(state, count, body);
  s.ifElse(cond, state, ifBody, elseBody);
  // ... see Control Flow section

  // Debug
  s.print('value =', value);
})
```

**Important concept:** Values like `arg`, `val`, etc. are compile-time handles (symbolic representations), not actual runtime values. Operations build a computation graph that gets compiled to WASM/JS. You cannot inspect their values at definition time — they only exist at runtime.

---

## Types

| Base   | Description              | 2 lanes  | 4 lanes  | 8 lanes  | 16 lanes  |
| ------ | ------------------------ | -------- | -------- | -------- | --------- |
| `i8`   | 8-bit signed integer     | `i8x2`   | `i8x4`   | `i8x8`   | `i8x16`   |
| `u8`   | 8-bit unsigned integer   | `u8x2`   | `u8x4`   | `u8x8`   | `u8x16`   |
| `i16`  | 16-bit signed integer    | `i16x2`  | `i16x4`  | `i16x8`  | `i16x16`  |
| `u16`  | 16-bit unsigned integer  | `u16x2`  | `u16x4`  | `u16x8`  | `u16x16`  |
| `i32`  | 32-bit signed integer    | `i32x2`  | `i32x4`  | `i32x8`  | `i32x16`  |
| `u32`  | 32-bit unsigned integer  | `u32x2`  | `u32x4`  | `u32x8`  | `u32x16`  |
| `f32`  | 32-bit float             | `f32x2`  | `f32x4`  | `f32x8`  | `f32x16`  |
| `i64`  | 64-bit signed integer    | `i64x2`  | `i64x4`  | `i64x8`  | `i64x16`  |
| `u64`  | 64-bit unsigned integer  | `u64x2`  | `u64x4`  | `u64x8`  | `u64x16`  |
| `f64`  | 64-bit float             | `f64x2`  | `f64x4`  | `f64x8`  | `f64x16`  |
| `i128` | 128-bit signed integer   | `i128x2` | `i128x4` | `i128x8` | `i128x16` |
| `u128` | 128-bit unsigned integer | `u128x2` | `u128x4` | `u128x8` | `u128x16` |
| `i256` | 256-bit signed integer   | `i256x2` | `i256x4` | `i256x8` | `i256x16` |
| `u256` | 256-bit unsigned integer | `u256x2` | `u256x4` | `u256x8` | `u256x16` |

**Note:** There are no native 8-bit or 16-bit register types. Like WASM, this operates at register level (32/64 bit) — `i8/u8/i16/u16` are virtual and lowered to `i32/u32`. For byte-level _memory_ access, use views: `.as8()`, `.as16()`, `.as32()`. Lane-count variants are real types (e.g. `u8x4`, `u16x2`); `getType('u8', 4)`/`getType('u16', 2)` is the generic way to select them. `i128/u128/i256/u256` have virtual SIMD lane variants (lowered to scalar ops) and are currently supported via conversions to/from `u32/u64` parts.

### Type Methods

| Method                 | Description                                                 |
| ---------------------- | ----------------------------------------------------------- |
| `const(value)`         | Create constant. For SIMD, broadcasts to all lanes.         |
| `laneOffsets(offset?)` | Scalar: `0 + offset`. SIMD: `[0, 1, 2, ...]` + offset       |
| `select(cond, a, b)`   | `cond ? a : b`. For SIMD, accepts vector mask as condition. |
| `swapEndianness(a)`    | Reverse byte order within each lane.                        |

**laneOffsets example:**

```typescript
u32.laneOffsets(10); // → 10
u32x4.laneOffsets(10); // → [10, 11, 12, 13]
```

### Type Conversions

| Method                   | Description                                         |
| ------------------------ | --------------------------------------------------- |
| `to(dstType, value)`     | Convert to different type, returns array            |
| `from(srcType, values)`  | Convert from different type, returns array          |
| `toN(dstType, value)`    | Same as `to(...)[0]` — returns first element only   |
| `fromN(srcType, values)` | Same as `from(...)[0]` — returns first element only |
| `castFrom(srcType, v)`   | Bitcast with size checks; no-op for ints            |
| `castTo(dstType, v)`     | Same as `dstType.castFrom(srcType, v)`              |

Use `from`/`to` when conversion changes element count (split u64 → [lo, hi], u16 → [lo, hi] u8). Use `fromN`/`toN` as shorthand when you only need the first result (e.g., low word of u64, first lane of SIMD).

**Conversion behavior:**

| From → To                        | Behavior                         |
| -------------------------------- | -------------------------------- |
| `u64` → `u32`                    | Split: returns `[lo, hi]`        |
| `[u32, u32]` → `u64`             | Combine lo/hi                    |
| `u32` → `u64`                    | Extend (sign/zero based on type) |
| `u32x4` → `u32`                  | Extract all lanes                |
| `[u32, u32, u32, u32]` → `u32x4` | Pack into vector                 |
| `u32` → `u32x4`                  | Splat to all lanes               |

---

## Operations

### Basic Arithmetic

Available on **all types**. Operations marked "variadic" accept 2+ arguments.

| Op    | Arity    | Equivalent  | Notes                                           |
| ----- | -------- | ----------- | ----------------------------------------------- |
| `add` | variadic | `a + b`     |                                                 |
| `sub` | 2        | `a - b`     |                                                 |
| `mul` | variadic | `a * b`     |                                                 |
| `div` | 2        | `a / b`     | WASM traps on zero; JS returns `Infinity`/`NaN` |
| `rem` | 2        | `a % b`     | Floats: `a - trunc(a/b) * b`                    |
| `min` | variadic | `min(a, b)` |                                                 |
| `max` | variadic | `max(a, b)` |                                                 |

### Comparison

Available on **all types**. Returns `u32` with 0/1 for scalars, `u32xN`/`u64xN` with bitmask (like `0xffff_ffff`) for SIMD.

| Op    | Equivalent |
| ----- | ---------- |
| `eq`  | `a == b`   |
| `ne`  | `a != b`   |
| `lt`  | `a < b`    |
| `gt`  | `a > b`    |
| `le`  | `a <= b`   |
| `ge`  | `a >= b`   |
| `eqz` | `a == 0`   |

### Bitwise (Integer Only)

| Op       | Arity    | Equivalent           |
| -------- | -------- | -------------------- |
| `and`    | variadic | `a & b`              |
| `or`     | variadic | `a \| b`             |
| `xor`    | variadic | `a ^ b`              |
| `andnot` | 2        | `a & ~b`             |
| `not`    | 1        | `~a`                 |
| `clz`    | 1        | Count leading zeros  |
| `ctz`    | 1        | Count trailing zeros |
| `popcnt` | 1        | Population count     |

### Shifts (Integer Only)

Shift amount is `number | Val<'i32'>`. For SIMD, same shift applies to all lanes.

| Op     | Equivalent        | Notes                                     |
| ------ | ----------------- | ----------------------------------------- |
| `shl`  | `a << n`          |                                           |
| `shr`  | `a >> n`          | Arithmetic (signed) or logical (unsigned) |
| `rotl` | Rotate bits left  |                                           |
| `rotr` | Rotate bits right |                                           |

**`shr` behavior:** On signed types (`i32`, `i64`) sign-extends (arithmetic shift). On unsigned types (`u32`, `u64`) zero-extends (logical shift).

Shift/rotate behavior matches WebAssembly exactly (including how large shift counts are handled).

### Signed Only

| Op    | Equivalent |
| ----- | ---------- |
| `abs` | `\|a\|`    |
| `neg` | `-a`       |

### Float Only

| Op         | Description                       |
| ---------- | --------------------------------- |
| `sqrt`     | Square root                       |
| `ceil`     | Round toward +∞                   |
| `floor`    | Round toward -∞                   |
| `trunc`    | Round toward zero                 |
| `nearest`  | Round to nearest, ties to even    |
| `copysign` | Magnitude of `a` with sign of `b` |
| `isNaN`    | Returns true if NaN               |

### SIMD Only

| Op                            | Description                            |
| ----------------------------- | -------------------------------------- |
| `extractLane(vec, lane)`      | Extract scalar from lane               |
| `replaceLane(vec, lane, val)` | Replace value at lane                  |
| `splat(scalar)`               | Broadcast to all lanes                 |
| `shuffle(a, b, pattern)`      | Byte-level shuffle (16 indices, 0..31) |
| `shuffleLanes(a, b, pattern)` | Lane-level shuffle                     |
| `rol(vec, n)`                 | Rotate lanes left                      |
| `ror(vec, n)`                 | Rotate lanes right                     |
| `interleave(vecs)`            | Interleave for SIMD processing         |
| `deinterleave(vecs)`          | Reverse interleave                     |

**`shuffle` vs `shuffleLanes`:**

- `shuffle`: WASM byte-level shuffle. Pattern has 16 elements, indices 0..31 select bytes from concatenated `[a, b]`.
- `shuffleLanes`: Lane-level shuffle. Pattern length = lane count, indices 0..(2×lanes-1).

**shuffleLanes example** (`u32x4`):

```
a = [A0, A1, A2, A3], b = [B0, B1, B2, B3]
concat = [A0, A1, A2, A3, B0, B1, B2, B3]  // indices 0-7
shuffleLanes(a, b, [0, 4, 1, 5]) → [A0, B0, A1, B1]
```

**`rol`/`ror` vs `rotl`/`rotr`:**

- `rol`/`ror` rotate _lanes_ within a vector
- `rotl`/`rotr` rotate _bits_ within each lane value

**interleave/deinterleave example** (`u32x4`)

Requires: the input length must be a multiple of the lane count (here: multiple of 4).

Input (4 independent streams):

- A = `[A0,A1,A2,A3]`
- B = `[B0,B1,B2,B3]`
- C = `[C0,C1,C2,C3]`
- D = `[D0,D1,D2,D3]`

After `interleave([A,B,C,D])`:

- `[A0,B0,C0,D0]`
- `[A1,B1,C1,D1]`
- `[A2,B2,C2,D2]`
- `[A3,B3,C3,D3]`

`deinterleave` reverses this transformation.

### Generics

Sometimes you want the same algorithm for different types — say, a hash that works on both `u32` and `u64`. The challenge: memory and operations must use the _same_ concrete type, but TypeScript doesn't automatically track that connection.

```ts
// WITHOUT generics — broken: memory is u32, but T could be u64!
function broken<T extends UnsignedType>(type: T) {
  return new Module('oops')
    .mem('buf', array('u32', {}, 8)) // hardcoded u32
    .fn('test', [], 'void', (f) => {
      const U = f.types.u32; // hardcoded u32
      // ... what if T was u64?
    });
}
```

Use `toGeneric` for memory specs and `getTypeGeneric` for operations — both preserve the type parameter `T`:

```ts
import { toGeneric } from '@awasm/compiler/module.js';

function gen<T extends UnsignedType>(type: T) {
  const memType = toGeneric<UnsignedType, T>(type);

  return new Module('generic')
    .mem('buf', array(memType, {}, 8)) // u32 or u64, depending on T
    .fn('test', [], 'void', (f) => {
      const U = f.getTypeGeneric<UnsignedType, T>(type); // matching ops
      const x = f.memory.buf[0].get();
      f.memory.buf[0].set(U.add(x, U.const(1)));
    });
}

// Now both versions are generated correctly:
const mod32 = gen('u32'); // everything is u32
const mod64 = gen('u64'); // everything is u64
```

The `<UnsignedType, T>` part tells TypeScript: "T is some unsigned type, give me operations that work on unsigned types." This keeps type-checking tight while generating code for whichever concrete type you pass in.

---

## Memory Access

### Basic Access

```typescript
// Indexing
s.memory.buffer[i].get(); // load
s.memory.buffer[i].set(val); // store

// Multidimensional
s.memory.matrix[i][j].get();

// Struct fields
s.memory.state.counter.get();
s.memory.state.data[0].set(val);
```

For arrays, `get()` returns nested arrays matching shape.
For structs, `get()` returns a JS object where keys are field names and values are symbolic handles:

```typescript
const point = s.memory.point.get(); // { x: , y:  }
const sum = u32.add(point.x, point.y); // use fields in operations
```

Partial struct updates supported.

**Symbolic indexing:** Array indices and sizes can be runtime values (`Val<'u32'>`), not just constants:

```typescript
// Index with runtime value
const val = s.memory.buffer[idx].get(); // idx can be u32 constant or variable

// Range with runtime values
const slice = s.memory.buffer.range(start, len);
```

**No bounds checking:** There are no runtime bounds checks for symbolic/dynamic indices. WASM may trap on significantly out-of-bounds access (page faults), but JS will silently read/write garbage or return undefined. The only guaranteed error is WASM trap on division by zero.

### Views

| Method                 | Description               |
| ---------------------- | ------------------------- |
| `.range(start?, len?)` | Slice to subrange         |
| `.reshape(...sizes)`   | Reinterpret dimensions    |
| `.flat()`              | Flatten to 1D             |
| `.as(type)`            | Reinterpret element type  |
| `.as8(type?)`          | Byte view (1-byte access) |
| `.as16(type?)`         | 16-bit view               |
| `.as32(type?)`         | 32-bit view               |

### Byte Operations

On `.as8()` views:

| Method                     | Description                    |
| -------------------------- | ------------------------------ |
| `.copyFrom(src, len?)`     | Copy bytes from another region |
| `.fill(value, len?)`       | Fill with byte value           |
| `.zero(len?)`              | Fill with zeros                |
| `.read(type, size?)`       | Read as type/width             |
| `.write(type, val, size?)` | Write as type/width            |

### SIMD Lanes

`.lanes(n)` enables strided SIMD access:

```typescript
// array[N, M, K]
const view = s.memory.data[streamIdx]; // shape [M, K]
const strided = view.lanes(4)[pos]; // access pos, pos+1, pos+2, pos+3 in M

const vectors = strided.get(); // auto-interleaved for SIMD
strided.set(vectors); // auto-deinterleaved back
```

### Atomics

On scalar integer locations:

```typescript
loc.atomics.load();
loc.atomics.store(value);
loc.atomics.exchange(value);
loc.atomics.compareExchange(expected, replacement);
loc.atomics.add(value); // also: sub, and, or, xor
// `wait`/`notify` follow standard [WebAssembly atomics semantics](https://developer.mozilla.org/en-US/docs/WebAssembly/Reference/Memory/Wait).
loc.atomics.wait(expected, timeout);
loc.atomics.notify(count);
loc.atomics.fence();
```

### Mut (Non-Atomic RMW)

```typescript
loc.mut.exchange(value);
loc.mut.compareExchange(expected, replacement);
loc.mut.add(x); // val += x, returns old
// ... all type ops available
```

---

## Control Flow

### State-Passing Model

All control flow uses state-passing. State flows through, body transforms it, construct returns final state.

```typescript
const [sum] = s.doN(
  [u32.const(0)], // initial state
  10, // iterations
  (i, acc) => [u32.add(acc, i)] // body returns new state
);
```

**Important:** JS runs at compile time. Don't modify JS variables inside bodies:

```typescript
// WRONG
let x = 0;
s.doN([], 10, (i) => {
  x++;
  return [];
}); // x++ runs once at compile time!

// CORRECT - use state
const [x] = s.doN([u32.const(0)], 10, (i, x) => [u32.add(x, u32.const(1))]);
```

### Loops

| Construct                         | Executes     | Condition   |
| --------------------------------- | ------------ | ----------- |
| `doN(state, count, body)`         | 0 to N times | Before body |
| `doN1(state, count, body)`        | 1 to N times | After body  |
| `doWhile(state, cond, body)`      | 1+ times     | After body  |
| `forLoop(state, cond, inc, body)` | 0+ times     | Before body |

```typescript
// doN: 0..N iterations
const [sum] = s.doN([u32.const(0)], 10, (i, acc) => [u32.add(acc, i)]);

// doWhile: at least once
const [val] = s.doWhile(
  [u32.const(1)],
  (val) => u32.lt(val, u32.const(100)),
  (val) => [u32.mul(val, u32.const(2))]
);

// forLoop: traditional for
const [sum] = s.forLoop(
  [u32.const(0), u32.const(0)], // [sum, i]
  (sum, i) => u32.lt(i, u32.const(10)), // condition
  (sum, i) => [sum, u32.add(i, u32.const(1))], // increment
  (sum, i) => [u32.add(sum, i), i] // body
);
```

### Conditionals

```typescript
// With else
const [result] = s.ifElse(
  condition,
  [initialValue],
  (val) => [computeIfTrue(val)],
  (val) => [computeIfFalse(val)]
);

// Without else (state unchanged if false)
const [result] = s.ifElse(condition, [value], (val) => [transform(val)]);
```

### Low-Level Control

```typescript
// Named blocks for complex control flow
const [x, y] = s.namedBlock('outer', [a, b], (x, y) => {
  s.breakIf(cond, 'outer', x, y);
  return [newX, newY];
});

// Branch behavior depends on block type:
// - block: br exits (like break)
// - loop: br jumps to start (like continue)

// High-level loop control (inside doN/forLoop/doWhile)
s.continue(); // next iteration
s.continueIf(cond);
s.break(); // exit loop
s.breakIf(cond);
```

---

## Quick Reference

### Operations by Type

| Operation                                                        | Int | Float | Signed | Unsigned |
| ---------------------------------------------------------------- | --- | ----- | ------ | -------- |
| `add`, `sub`, `mul`, `div`, `rem`                                | ✓   | ✓     | ✓      | ✓        |
| `min`, `max`                                                     | ✓   | ✓     | ✓      | ✓        |
| `eq`, `ne`, `lt`, `gt`, `le`, `ge`, `eqz`                        | ✓   | ✓     | ✓      | ✓        |
| `and`, `or`, `xor`, `andnot`, `not`                              | ✓   |       | ✓      | ✓        |
| `clz`, `ctz`, `popcnt`                                           | ✓   |       | ✓      | ✓        |
| `shl`, `shr`, `rotl`, `rotr`                                     | ✓   |       | ✓      | ✓        |
| `abs`, `neg`                                                     |     |       | ✓      |          |
| `sqrt`, `ceil`, `floor`, `trunc`, `nearest`, `copysign`, `isNaN` |     | ✓     |        |          |

### Memory Quick Reference

| Operation        | On         | Description          |
| ---------------- | ---------- | -------------------- |
| `[idx]`          | array      | Index into dimension |
| `.field`         | struct     | Access field         |
| `.get()`         | any        | Load value(s)        |
| `.set(v)`        | any        | Store value(s)       |
| `.range(s,l)`    | array      | Slice view           |
| `.reshape(...s)` | array      | Reshape view         |
| `.flat()`        | array      | Flatten to 1D        |
| `.as(type)`      | array      | Reinterpret type     |
| `.as8/16/32()`   | array      | Byte view            |
| `.lanes(n)`      | array      | SIMD strided access  |
| `.copyFrom(r)`   | bytes      | Copy bytes           |
| `.fill(v)`       | bytes      | Fill bytes           |
| `.zero()`        | bytes      | Zero bytes           |
| `.atomics.*`     | scalar int | Atomic operations    |
| `.mut.*`         | scalar     | Non-atomic RMW       |

### Control Flow Quick Reference

| Construct | Executes     | Condition Check |
| --------- | ------------ | --------------- |
| `doN`     | 0 to N times | Before body     |
| `doN1`    | 1 to N times | After body      |
| `doWhile` | 1+ times     | After body      |
| `forLoop` | 0+ times     | Before body     |
| `ifElse`  | 0 or 1 time  | Before body     |


## License

The MIT License (MIT)

Copyright (c) 2026 Paul Miller [(https://paulmillr.com)](https://paulmillr.com)

See LICENSE file.
