import type { TRet } from '@scure/base';
import * as P from 'micro-packed';
import { deepFreeze } from './utils.ts';

const _0n = /* @__PURE__ */ BigInt(0);
type TypeVal = 'void' | 'i32' | 'i64' | 'f32' | 'f64' | 'v128';
type WasmType = TypeVal | 'funcref' | 'externref';
type LocalType = Exclude<TypeVal, 'void'>;
type WasmKind = 'function' | 'table' | 'memory' | 'global';
type WasmImportKind = 'function' | 'memory';
type WasmFunctionType = { inputs: WasmType[]; outputs: WasmType[] };
type WasmTypeEntry = { TAG: 'function'; data: WasmFunctionType };
type WasmExport = { name: string; kind: WasmKind; index: bigint };
type WasmImportType = { TAG: 'function'; data: bigint } | { TAG: 'memory'; data: WasmMemoryLimits };
type WasmImport = { module: string; name: string; importType: WasmImportType };
type WasmInstruction = P.UnwrapCoder<typeof instruction>;
type WasmLocal = { count: bigint; type: P.UnwrapCoder<typeof ValType> };
type WasmCode = { locals: WasmLocal[]; instructions: WasmInstruction[] };
type TagEntry<Tag extends number, Coder extends P.CoderType<any>> = [Tag, Coder];
type MappedTagValue<T> = P.Values<{
  [K in keyof T]: T[K] extends TagEntry<number, infer Coder>
    ? { TAG: K; data: P.UnwrapCoder<Coder> }
    : never;
}>;
type WasmSection = MappedTagValue<WasmSections>;
type WasmBinary = { version: number; sections: WasmSection[] };

// Core encoding for ints inside wasm?
// TODO: temporary, but kinda works (at leasts tests are ok), cleanup!
/** Unsigned LEB128 bigint coder used by Wasm immediates. */
export const LEB128: P.CoderType<bigint> = /* @__PURE__ */ (() =>
  deepFreeze(
    P.wrap({
    encodeStream(w, value: bigint) {
      let n = BigInt(value);
      if (n < 0) throw new Error('negative integer');
      const more = BigInt(0x80); // 0b10000000
      const mask = BigInt(0x7f); // 0b01111111
      while (true) {
        let byte = n & mask;
        n >>= BigInt(7); // Do the shift BEFORE the check
        if (n === BigInt(0)) {
          // Check AFTER shift
          w.byte(Number(byte));
          break;
        }
        byte |= more;
        w.byte(Number(byte));
      }
    },
    decodeStream(r) {
      let result = BigInt(0);
      let shift = 0;
      while (true) {
        const byte = BigInt(r.byte());
        result |= (byte & BigInt(0x7f)) << BigInt(shift);
        // Stop when the continuation bit is not set.
        if ((byte & BigInt(0x80)) === BigInt(0)) break;
        shift += 7;
      }
      return result;
    },
    })
  ))();

/** Signed LEB128 bigint coder used by Wasm immediates. */
export const SLEB128: P.CoderType<bigint> = /* @__PURE__ */ (() =>
  deepFreeze(
    P.wrap({
    encodeStream(w, value: bigint) {
      let n = BigInt(value);
      const more = BigInt(0x80); // 0b10000000
      const mask = BigInt(0x7f); // 0b01111111
      while (true) {
        let byte = n & mask;
        n >>= BigInt(7);
        // Determine if this is the last byte based on sign bit and remaining value
        const isLast =
          (n === BigInt(0) && (byte & BigInt(0x40)) === BigInt(0)) ||
          (n === BigInt(-1) && (byte & BigInt(0x40)) !== BigInt(0));
        if (!isLast) byte |= more; // Set the continuation bit if more bytes follow
        w.byte(Number(byte));
        if (isLast) break;
      }
    },
    decodeStream(r) {
      let result = BigInt(0);
      let shift = 0;
      let byte;
      while (true) {
        byte = BigInt(r.byte());
        result |= (byte & BigInt(0x7f)) << BigInt(shift);
        shift += 7;
        // Stop when the continuation bit is not set.
        if ((byte & BigInt(0x80)) === BigInt(0)) break;
      }
      // Perform sign extension if needed
      const msb = BigInt(0x40); // Most significant bit in the last byte
      if ((byte & msb) !== BigInt(0)) result |= BigInt(-1) << BigInt(shift);
      return result;
    },
    })
  ))();

// Instructions
// This is a low-level binary encoder: it writes requested immediates even when
// instruction-level validation will reject the module.
const memarg: P.CoderType<{ align: bigint; offset: bigint }> = /* @__PURE__ */ P.struct({
  align: LEB128,
  offset: LEB128,
});
const laneIdx = (lanes: number): P.CoderType<number> =>
  P.validate(P.U8, (lane) => {
    if (!Number.isSafeInteger(lane) || lane < 0 || lane >= lanes)
      throw new Error(`invalid SIMD lane: ${lane} not in [0, ${lanes})`);
    return lane;
  });
type LaneArg = { mem: P.UnwrapCoder<typeof memarg>; lane: number };
const laneArg = (lanes: number): P.CoderType<LaneArg> =>
  P.struct({ mem: memarg, lane: laneIdx(lanes) });
const idx = LEB128;
const EMPTY: P.CoderType<undefined> = /* @__PURE__ */ (() =>
  P.magic(P.bytes(0), new Uint8Array(0)))();

// prettier-ignore
const memory = {
  get: { local: 0x20, global: 0x23, table: 0x25, args: idx },
  set: { local: 0x21, global: 0x24, table: 0x26, args: idx },
  tee: { local: 0x22,                            args: idx },
};

const constarg = { i32: SLEB128, i64: SLEB128, f32: P.F32LE, f64: P.F64LE };
// prettier-ignore
const basic = {
  load:            { i32: 0x28, i64: 0x29, f32: 0x2a, f64: 0x2b, args: memarg   },
  load8_s:         { i32: 0x2c, i64: 0x30,                       args: memarg   },
  load8_u:         { i32: 0x2d, i64: 0x31,                       args: memarg   },
  load16_s:        { i32: 0x2e, i64: 0x32,                       args: memarg   },
  load16_u:        { i32: 0x2f, i64: 0x33,                       args: memarg   },
  load32_s:        { i64: 0x34,                                  args: memarg   },
  load32_u:        { i64: 0x35,                                  args: memarg   },
  store:           { i32: 0x36, i64: 0x37, f32: 0x38, f64: 0x39, args: memarg   },
  store8:          { i32: 0x3a, i64: 0x3c,                       args: memarg   },
  store16:         { i32: 0x3b, i64: 0x3d,                       args: memarg   },
  store32:         {            i64: 0x3e,                       args: memarg   },
  const:           { i32: 0x41, i64: 0x42, f32: 0x43, f64: 0x44, args: constarg },
  eqz:             { i32: 0x45, i64: 0x50                                       },
  eq:              { i32: 0x46, i64: 0x51, f32: 0x5b, f64: 0x61                 },
  ne:              { i32: 0x47, i64: 0x52, f32: 0x5c, f64: 0x62                 },
  lt_s:            { i32: 0x48, i64: 0x53                                       },
  lt_u:            { i32: 0x49, i64: 0x54                                       },
  lt:              {                       f32: 0x5d, f64: 0x63                 },
  gt_s:            { i32: 0x4a, i64: 0x55                                       },
  gt_u:            { i32: 0x4b, i64: 0x56                                       },
  gt:              {                       f32: 0x5e, f64: 0x64                 },
  le_s:            { i32: 0x4c, i64: 0x57                                       },
  le_u:            { i32: 0x4d, i64: 0x58                                       },
  le:              {                       f32: 0x5f, f64: 0x65                 },
  ge_s:            { i32: 0x4e, i64: 0x59                                       },
  ge_u:            { i32: 0x4f, i64: 0x5a                                       },
  ge:              {                       f32: 0x60, f64: 0x66                 },
  clz:             { i32: 0x67, i64: 0x79                                       },
  ctz:             { i32: 0x68, i64: 0x7a                                       },
  popcnt:          { i32: 0x69, i64: 0x7b                                       },
  abs:             {                       f32: 0x8b, f64: 0x99                 },
  neg:             {                       f32: 0x8c, f64: 0x9a                 },
  ceil:            {                       f32: 0x8d, f64: 0x9b                 },
  floor:           {                       f32: 0x8e, f64: 0x9c                 },
  trunc:           {                       f32: 0x8f, f64: 0x9d                 },
  nearest:         {                       f32: 0x90, f64: 0x9e                 },
  sqrt:            {                       f32: 0x91, f64: 0x9f                 },
  add:             { i32: 0x6a, i64: 0x7c, f32: 0x92, f64: 0xa0                 },
  sub:             { i32: 0x6b, i64: 0x7d, f32: 0x93, f64: 0xa1                 },
  mul:             { i32: 0x6c, i64: 0x7e, f32: 0x94, f64: 0xa2                 },
  div_s:           { i32: 0x6d, i64: 0x7f                                       },
  div_u:           { i32: 0x6e, i64: 0x80                                       },
  rem_s:           { i32: 0x6f, i64: 0x81                                       },
  rem_u:           { i32: 0x70, i64: 0x82                                       },
  div:             {                       f32: 0x95, f64: 0xa3                 },
  and:             { i32: 0x71, i64: 0x83                                       },
  or:              { i32: 0x72, i64: 0x84                                       },
  xor:             { i32: 0x73, i64: 0x85                                       },
  shl:             { i32: 0x74, i64: 0x86                                       },
  shr_s:           { i32: 0x75, i64: 0x87                                       },
  shr_u:           { i32: 0x76, i64: 0x88                                       },
  rotl:            { i32: 0x77, i64: 0x89                                       },
  rotr:            { i32: 0x78, i64: 0x8a                                       },
  min:             {                       f32: 0x96, f64: 0xa4                 },
  max:             {                       f32: 0x97, f64: 0xa5                 },
  copysign:        {                       f32: 0x98, f64: 0xa6                 },
  extend_i32_s:    {            i64: 0xac                                       },
  extend_i32_u:    {            i64: 0xad                                       },
  wrap_i64:        { i32: 0xa7                                                  },
  trunc_f32_s:     { i32: 0xa8, i64: 0xae                                       },
  trunc_f32_u:     { i32: 0xa9, i64: 0xaf                                       },
  trunc_f64_s:     { i32: 0xaa, i64: 0xb0                                       },
  trunc_f64_u:     { i32: 0xab, i64: 0xb1                                       },
  convert_i32_s:   {                       f32: 0xb2, f64: 0xb7                 },
  convert_i32_u:   {                       f32: 0xb3, f64: 0xb8                 },
  convert_i64_s:   {                       f32: 0xb4, f64: 0xb9                 },
  convert_i64_u:   {                       f32: 0xb5, f64: 0xba                 },
  demote_f64:      {                       f32: 0xb6                            },
  promote_f32:     {                                  f64: 0xbb                 },
  reinterpret_f32: { i32: 0xbc                                                  },
  reinterpret_i32: {                       f32: 0xbe                            },
  reinterpret_f64: {            i64: 0xbd                                       },
  reinterpret_i64: {                                  f64: 0xbf                 },
  extend8_s:       { i32: 0xc0, i64: 0xc2                                       },
  extend16_s:      { i32: 0xc1, i64: 0xc3                                       },
  extend32_s:      {            i64: 0xc4                                       },
};

// prettier-ignore
const simd = /* @__PURE__ */ (() => ({
  // basic
  load:                          { v128: 0x00, args: memarg                                                                 },
  load8x8_s:                     { v128: 0x01, args: memarg                                                                 },
  load8x8_u:                     { v128: 0x02, args: memarg                                                                 },
  load16x4_s:                    { v128: 0x03, args: memarg                                                                 },
  load16x4_u:                    { v128: 0x04, args: memarg                                                                 },
  load32x2_s:                    { v128: 0x05, args: memarg                                                                 },
  load32x2_u:                    { v128: 0x06, args: memarg                                                                 },
  load8_splat:                   { v128: 0x07, args: memarg                                                                 },
  load16_splat:                  { v128: 0x08, args: memarg                                                                 },
  load32_splat:                  { v128: 0x09, args: memarg                                                                 },
  load64_splat:                  { v128: 0x0a, args: memarg                                                                 },
  store:                         { v128: 0x0b, args: memarg                                                                 },
  const:                         { v128: 0x0c, args: P.I128LE                                                               },
  not:                           { v128: 0x4d                                                                               },
  and:                           { v128: 0x4e                                                                               },
  andnot:                        { v128: 0x4f                                                                               },
  or:                            { v128: 0x50                                                                               },
  xor:                           { v128: 0x51                                                                               },
  bitselect:                     { v128: 0x52                                                                               },
  any_true:                      { v128: 0x53                                                                               },
  load8_lane:                    { v128: 0x54, args: laneArg(16)                                                            },
  load16_lane:                   { v128: 0x55, args: laneArg(8)                                                             },
  load32_lane:                   { v128: 0x56, args: laneArg(4)                                                             },
  load64_lane:                   { v128: 0x57, args: laneArg(2)                                                             },
  store8_lane:                   { v128: 0x58, args: laneArg(16)                                                            },
  store16_lane:                  { v128: 0x59, args: laneArg(8)                                                             },
  store32_lane:                  { v128: 0x5a, args: laneArg(4)                                                             },
  store64_lane:                  { v128: 0x5b, args: laneArg(2)                                                             },
  load32_zero:                   { v128: 0x5c, args: memarg                                                                 },
  load64_zero:                   { v128: 0x5d, args: memarg                                                                 },
  shuffle:                       { i8x16: 0x0d, args: P.array(16, laneIdx(32))                                              },
  swizzle:                       { i8x16: 0x0e                                                                              },
  splat:                         { i8x16: 0x0f, i16x8: 0x10, i32x4: 0x11, i64x2: 0x12, f32x4: 0x13, f64x2: 0x14             },
  extract_lane_s:                { i8x16: 0x15, i16x8: 0x18                                                    , args: { i8x16: laneIdx(16), i16x8: laneIdx(8) } },
  extract_lane_u:                { i8x16: 0x16, i16x8: 0x19                                                    , args: { i8x16: laneIdx(16), i16x8: laneIdx(8) } },
  replace_lane:                  { i8x16: 0x17, i16x8: 0x1a, i32x4: 0x1c, i64x2: 0x1e, f32x4: 0x20, f64x2: 0x22, args: { i8x16: laneIdx(16), i16x8: laneIdx(8), i32x4: laneIdx(4), i64x2: laneIdx(2), f32x4: laneIdx(4), f64x2: laneIdx(2) } },
  extract_lane:                  {                           i32x4: 0x1b, i64x2: 0x1d, f32x4: 0x1f, f64x2: 0x21, args: { i32x4: laneIdx(4), i64x2: laneIdx(2), f32x4: laneIdx(4), f64x2: laneIdx(2) } },
  eq:                            { i8x16: 0x23, i16x8: 0x2d, i32x4: 0x37, i64x2: 0xd6, f32x4: 0x41, f64x2: 0x47             },
  ne:                            { i8x16: 0x24, i16x8: 0x2e, i32x4: 0x38, i64x2: 0xd7, f32x4: 0x42, f64x2: 0x48             },
  lt_s:                          { i8x16: 0x25, i16x8: 0x2f, i32x4: 0x39, i64x2: 0xd8                                       },
  lt_u:                          { i8x16: 0x26, i16x8: 0x30, i32x4: 0x3a                                                    },
  gt_s:                          { i8x16: 0x27, i16x8: 0x31, i32x4: 0x3b, i64x2: 0xd9                                       },
  gt_u:                          { i8x16: 0x28, i16x8: 0x32, i32x4: 0x3c                                                    },
  le_s:                          { i8x16: 0x29, i16x8: 0x33, i32x4: 0x3d, i64x2: 0xda                                       },
  le_u:                          { i8x16: 0x2a, i16x8: 0x34, i32x4: 0x3e                                                    },
  ge_s:                          { i8x16: 0x2b, i16x8: 0x35, i32x4: 0x3f, i64x2: 0xdb                                       },
  ge_u:                          { i8x16: 0x2c, i16x8: 0x36, i32x4: 0x40                                                    },
  lt:                            {                                                     f32x4: 0x43, f64x2: 0x49             },
  gt:                            {                                                     f32x4: 0x44, f64x2: 0x4a             },
  le:                            {                                                     f32x4: 0x45, f64x2: 0x4b             },
  ge:                            {                                                     f32x4: 0x46, f64x2: 0x4c             },
  demote_f64x2_zero:             {                                                     f32x4: 0x5e                          },
  promote_low_f32x4:             {                                                                  f64x2: 0x5f             },
  abs:                           { i8x16: 0x60, i16x8: 0x80, i32x4: 0xa0, i64x2: 0xc0, f32x4: 0xe0, f64x2: 0xec             },
  neg:                           { i8x16: 0x61, i16x8: 0x81, i32x4: 0xa1, i64x2: 0xc1, f32x4: 0xe1, f64x2: 0xed             },
  popcnt:                        { i8x16: 0x62                                                                              },
  all_true:                      { i8x16: 0x63, i16x8: 0x83, i32x4: 0xa3, i64x2: 0xc3                                       },
  bitmask:                       { i8x16: 0x64, i16x8: 0x84, i32x4: 0xa4, i64x2: 0xc4                                       },
  narrow_i16x8_s:                { i8x16: 0x65                                                                              },
  narrow_i16x8_u:                { i8x16: 0x66                                                                              },
  shl:                           { i8x16: 0x6b, i16x8: 0x8b, i32x4: 0xab, i64x2: 0xcb                                       },
  shr_s:                         { i8x16: 0x6c, i16x8: 0x8c, i32x4: 0xac, i64x2: 0xcc                                       },
  shr_u:                         { i8x16: 0x6d, i16x8: 0x8d, i32x4: 0xad, i64x2: 0xcd                                       },
  add:                           { i8x16: 0x6e, i16x8: 0x8e, i32x4: 0xae, i64x2: 0xce, f32x4: 0xe4, f64x2: 0xf0             },
  add_sat_s:                     { i8x16: 0x6f, i16x8: 0x8f                                                                 },
  add_sat_u:                     { i8x16: 0x70, i16x8: 0x90                                                                 },
  sub:                           { i8x16: 0x71, i16x8: 0x91, i32x4: 0xb1, i64x2: 0xd1, f32x4: 0xe5, f64x2: 0xf1             },
  sub_sat_s:                     { i8x16: 0x72, i16x8: 0x92                                                                 },
  sub_sat_u:                     { i8x16: 0x73, i16x8: 0x93                                                                 },
  min_s:                         { i8x16: 0x76, i16x8: 0x96, i32x4: 0xb6                                                    },
  min_u:                         { i8x16: 0x77, i16x8: 0x97, i32x4: 0xb7                                                    },
  max_s:                         { i8x16: 0x78, i16x8: 0x98, i32x4: 0xb8                                                    },
  max_u:                         { i8x16: 0x79, i16x8: 0x99, i32x4: 0xb9                                                    },
  avgr_u:                        { i8x16: 0x7b, i16x8: 0x9b                                                                 },
  mul:                           {              i16x8: 0x95, i32x4: 0xb5, i64x2: 0xd5, f32x4: 0xe6, f64x2: 0xf2             },
  ceil:                          {                                                     f32x4: 0x67, f64x2: 0x74             },
  floor:                         {                                                     f32x4: 0x68, f64x2: 0x75             },
  trunc:                         {                                                     f32x4: 0x69, f64x2: 0x7a             },
  nearest:                       {                                                     f32x4: 0x6a, f64x2: 0x94             },
  sqrt:                          {                                                     f32x4: 0xe3, f64x2: 0xef             },
  div:                           {                                                     f32x4: 0xe7, f64x2: 0xf3             },
  min:                           {                                                     f32x4: 0xe8, f64x2: 0xf4             },
  max:                           {                                                     f32x4: 0xe9, f64x2: 0xf5             },
  pmin:                          {                                                     f32x4: 0xea, f64x2: 0xf6             },
  pmax:                          {                                                     f32x4: 0xeb, f64x2: 0xf7             },
  extadd_pairwise_i8x16_s:       {              i16x8: 0x7c                                                                 },
  extadd_pairwise_i8x16_u:       {              i16x8: 0x7d                                                                 },
  extadd_pairwise_i16x8_s:       {                           i32x4: 0x7e                                                    },
  extadd_pairwise_i16x8_u:       {                           i32x4: 0x7f                                                    },
  q15mulr_sat_s:                 {              i16x8: 0x82                                                                 },
  narrow_i32x4_s:                {              i16x8: 0x85                                                                 },
  narrow_i32x4_u:                {              i16x8: 0x86                                                                 },
  extend_low_i8x16_s:            {              i16x8: 0x87                                                                 },
  extend_high_i8x16_s:           {              i16x8: 0x88                                                                 },
  extend_low_i8x16_u:            {              i16x8: 0x89                                                                 },
  extend_high_i8x16_u:           {              i16x8: 0x8a                                                                 },
  extmul_low_i8x16_s:            {              i16x8: 0x9c                                                                 },
  extmul_high_i8x16_s:           {              i16x8: 0x9d                                                                 },
  extmul_low_i8x16_u:            {              i16x8: 0x9e                                                                 },
  extmul_high_i8x16_u:           {              i16x8: 0x9f                                                                 },
  extend_low_i16x8_s:            {                           i32x4: 0xa7                                                    },
  extend_high_i16x8_s:           {                           i32x4: 0xa8                                                    },
  extend_low_i16x8_u:            {                           i32x4: 0xa9                                                    },
  extend_high_i16x8_u:           {                           i32x4: 0xaa                                                    },
  dot_i16x8_s:                   {                           i32x4: 0xba                                                    },
  extmul_low_i16x8_s:            {                           i32x4: 0xbc                                                    },
  extmul_high_i16x8_s:           {                           i32x4: 0xbd                                                    },
  extmul_low_i16x8_u:            {                           i32x4: 0xbe                                                    },
  extmul_high_i16x8_u:           {                           i32x4: 0xbf                                                    },
  extend_low_i32x4_s:            {                                        i64x2: 0xc7                                       },
  extend_high_i32x4_s:           {                                        i64x2: 0xc8                                       },
  extend_low_i32x4_u:            {                                        i64x2: 0xc9                                       },
  extend_high_i32x4_u:           {                                        i64x2: 0xca                                       },
  extmul_low_i32x4_s:            {                                        i64x2: 0xdc                                       },
  extmul_high_i32x4_s:           {                                        i64x2: 0xdd                                       },
  extmul_low_i32x4_u:            {                                        i64x2: 0xde                                       },
  extmul_high_i32x4_u:           {                                        i64x2: 0xdf                                       },
  trunc_sat_f32x4_s:             {                           i32x4: 0xf8                                                    },
  trunc_sat_f32x4_u:             {                           i32x4: 0xf9                                                    },
  convert_i32x4_s:               {                           f32x4: 0xfa                                                    },
  convert_i32x4_u:               {                           f32x4: 0xfb                                                    },
  trunc_sat_f64x2_s_zero:        {                           i32x4: 0xfc                                                    },
  trunc_sat_f64x2_u_zero:        {                           i32x4: 0xfd                                                    },
  convert_low_i32x4_s:           {                                                                  f64x2: 0xfe             },
  convert_low_i32x4_u:           {                                                                  f64x2: 0xff             },
  // relaxed
  relaxed_madd:                  {                                                         f32x4: 0x105, f64x2: 0x107       },
  relaxed_nmadd:                 {                                                         f32x4: 0x106, f64x2: 0x108       },
  relaxed_laneselect:            { i8x16: 0x109, i16x8: 0x10a, i32x4: 0x10b, i64x2: 0x10c                                   },
  relaxed_min:                   {                                                         f32x4: 0x10d, f64x2: 0x10f       },
  relaxed_max:                   {                                                         f32x4: 0x10e, f64x2: 0x110       },
  relaxed_swizzle:               { i8x16: 0x100                                                                             },
  relaxed_trunc_f32x4_s:         {                             i32x4: 0x101                                                 },
  relaxed_trunc_f32x4_u:         {                             i32x4: 0x102                                                 },
  relaxed_trunc_f64x2_s_zero:    {                             i32x4: 0x103                                                 },
  relaxed_trunc_f64x2_u_zero:    {                             i32x4: 0x104                                                 },
  relaxed_q15mulr_s:             {               i16x8: 0x111                                                               },
  relaxed_dot_i8x16_i7x16_s:     {               i16x8: 0x112                                                               },
  relaxed_dot_i8x16_i7x16_add_s: {                             i32x4: 0x113                                                 },
}))();

// prettier-ignore
const atomics = {
  'atomic.wait':        { i32: 0x01, i64: 0x02 }, // wait32/wait64
  'atomic.load':        { i32: 0x10, i64: 0x11 },
  'atomic.load8_u':     { i32: 0x12, i64: 0x14 },
  'atomic.load16_u':    { i32: 0x13, i64: 0x15 },
  'atomic.load32_u':    {            i64: 0x16 },
  'atomic.store':       { i32: 0x17, i64: 0x18 },
  'atomic.store8':      { i32: 0x19, i64: 0x1b },
  'atomic.store16':     { i32: 0x1a, i64: 0x1c },
  'atomic.store32':     { i64: 0x1d            },
  'atomic.add':         { i32: 0x1e, i64: 0x1f },
  'atomic.add8_u':      { i32: 0x20, i64: 0x22 },
  'atomic.add16_u':     { i32: 0x21, i64: 0x23 },
  'atomic.add32_u':     { i64: 0x24            },
  'atomic.sub':         { i32: 0x25, i64: 0x26 },
  'atomic.sub8_u':      { i32: 0x27, i64: 0x29 },
  'atomic.sub16_u':     { i32: 0x28, i64: 0x2a },
  'atomic.sub32_u':     { i64: 0x2b            },
  'atomic.and':         { i32: 0x2c, i64: 0x2d },
  'atomic.and8_u':      { i32: 0x2e, i64: 0x30 },
  'atomic.and16_u':     { i32: 0x2f, i64: 0x31 },
  'atomic.and32_u':     { i64: 0x32            },
  'atomic.or':          { i32: 0x33, i64: 0x34 },
  'atomic.or8_u':       { i32: 0x35, i64: 0x37 },
  'atomic.or16_u':      { i32: 0x36, i64: 0x38 },
  'atomic.or32_u':      { i64: 0x39            },
  'atomic.xor':         { i32: 0x3a, i64: 0x3b },
  'atomic.xor8_u':      { i32: 0x3c, i64: 0x3e },
  'atomic.xor16_u':     { i32: 0x3d, i64: 0x3f },
  'atomic.xor32_u':     { i64: 0x40            },
  'atomic.xchg':        { i32: 0x41, i64: 0x42 },
  'atomic.xchg8_u':     { i32: 0x43, i64: 0x45 },
  'atomic.xchg16_u':    { i32: 0x44, i64: 0x46 },
  'atomic.xchg32_u':    { i64: 0x47            },
  'atomic.cmpxchg':     { i32: 0x48, i64: 0x49 },
  'atomic.cmpxchg8_u':  { i32: 0x4a, i64: 0x4c },
  'atomic.cmpxchg16_u': { i32: 0x4b, i64: 0x4d },
  'atomic.cmpxchg32_u': { i64: 0x4e            },
};

function getInstructions<
  I extends string,
  T extends string,
  B extends Record<I, { [K in T]?: number } & { args?: any }>,
  D,
>(
  basic: B,
  defaultArgs: P.CoderType<D>,
  ...types: T[]
): {
  [K in keyof B as `${Extract<T, keyof B[K]>}.${K & string}`]: [
    B[K][Extract<T, keyof B[K]>],
    P.CoderType<
      'args' extends keyof B[K]
        ? P.UnwrapCoder<B[K]['args'] extends P.CoderType<any> ? B[K]['args'] : B[K][T]>
        : D
    >,
  ];
} {
  const res: Record<string, any> = {};
  for (const instruction in basic) {
    const group = basic[instruction];
    for (const type of types) {
      if (group[type] === undefined) continue;
      res[`${type}.${instruction}`] = [
        group[type],
        group.args === undefined ? defaultArgs : group.args[type] ? group.args[type] : group.args,
      ];
    }
  }
  return res as any;
}

/** Wasm value and reference type byte coder. */
export const Type: P.CoderType<WasmType> = /* @__PURE__ */ (() =>
  deepFreeze(
    P.map(P.U8, {
      void: 0x40,
      i32: 0x7f,
      i64: 0x7e,
      f32: 0x7d,
      f64: 0x7c,
      v128: 0x7b,
      // reftype
      funcref: 0x70,
      externref: 0x6f,
    })
  ) as P.CoderType<WasmType>)();
const RefNullType: P.CoderType<'funcref' | 'externref'> = /* @__PURE__ */ P.validate(
  Type,
  (type) => {
    if (type !== 'funcref' && type !== 'externref')
      throw new Error('ref.null immediate must be a reference type');
    return type;
  }
) as P.CoderType<'funcref' | 'externref'>;
const ValType: P.CoderType<Exclude<WasmType, 'void'>> = /* @__PURE__ */ P.validate(Type, (type) => {
  if (type === 'void') throw new Error('void is not a valid local valtype');
  return type;
}) as P.CoderType<Exclude<WasmType, 'void'>>;

const stubSection: P.CoderType<Uint8Array> = /* @__PURE__ */ (() => P.bytes(LEB128))();
/**
 * Creates a standard Wasm section vector coder.
 *
 * @param inner - Coder for one section item.
 * @returns Length-prefixed vector coder for the section.
 * @example
 * ```js
 * import * as P from 'micro-packed';
 * import { section } from '@awasm/compiler/wasm.js';
 *
 * section(P.U8);
 * ```
 */
export const section = <T>(inner: P.CoderType<T>): P.CoderType<T[]> =>
  P.prefix(LEB128, P.array(LEB128, inner));
const tagEntry = <const Tag extends number, Coder extends P.CoderType<any>>(
  tag: Tag,
  coder: Coder
): TagEntry<Tag, Coder> => [tag, coder];

const varstring: P.CoderType<string> = /* @__PURE__ */ (() => P.string(LEB128))();

const Kind: P.CoderType<WasmKind> = /* @__PURE__ */ (() =>
  P.map(P.U8, {
    function: 0,
    table: 1,
    memory: 2,
    global: 3,
  }) as P.CoderType<WasmKind>)();
const ImportKind: P.CoderType<WasmImportKind> = /* @__PURE__ */ (() =>
  P.map(P.U8, {
    function: 0,
    memory: 2,
  }) as P.CoderType<WasmImportKind>)();
const functionType: P.CoderType<WasmFunctionType> = /* @__PURE__ */ (() =>
  P.validate(
    P.struct({ inputs: P.array(LEB128, Type), outputs: P.array(LEB128, Type) }),
    (type) => {
      // 0x40 is the empty blocktype marker; function signatures use empty vectors.
      if (type.inputs.includes('void') || type.outputs.includes('void'))
        throw new Error('void is not a valid function signature valtype');
      return type;
    }
  ))();
const typesSection: P.CoderType<WasmTypeEntry[]> = /* @__PURE__ */ (() =>
  section(P.mappedTag(P.U8, { function: [0x60, functionType] })))();

const exportSection: P.CoderType<WasmExport[]> = /* @__PURE__ */ (() =>
  P.prefix(LEB128, P.array(LEB128, P.struct({ name: varstring, kind: Kind, index: LEB128 }))))();

const MemLimits: P.CoderType<WasmMemoryLimits> = /* @__PURE__ */ (() =>
  P.struct({
    flags: P.bitset(['r0', 'r1', 'r2', 'r3', 'r4', 'r5', 'shared', 'maximum'], true),
    initial: LEB128,
    maximum: P.flagged('flags/maximum', LEB128),
  }))();

const importSection: P.CoderType<WasmImport[]> = /* @__PURE__ */ (() =>
  section(
    P.struct({
      module: varstring,
      name: varstring,
      importType: P.tag(ImportKind, { function: idx, memory: MemLimits }),
    })
  ))();
const memorySection: P.CoderType<WasmMemoryLimits[]> = /* @__PURE__ */ (() =>
  section(MemLimits))();

const LEB128_32: P.CoderType<number> = /* @__PURE__ */ (() =>
  P.apply(LEB128, P.coders.numberBigint))();
const SLEB128_32: P.CoderType<number> = /* @__PURE__ */ (() =>
  P.apply(SLEB128, P.coders.numberBigint))();
const MAX_U32 = 0xffffffff;
const BlockTypeIdx: P.CoderType<number> = /* @__PURE__ */ P.validate(SLEB128_32, (value) => {
  if (!Number.isSafeInteger(value) || value < 0 || value > MAX_U32)
    throw new Error(`invalid block type index: ${value}`);
  return value;
});

const BlockType: P.CoderType<number | P.UnwrapCoder<typeof Type>> = /* @__PURE__ */ P.wrap({
  encodeStream(w, value) {
    if (typeof value !== 'number') return Type.encodeStream(w, value);
    // Block typeidx uses signed LEB33, so 64 must not alias empty blocktype byte 0x40.
    BlockTypeIdx.encodeStream(w, value);
  },
  decodeStream(r) {
    const b = r.bytes(1, true);
    try {
      const res = Type.decode(b);
      r.bytes(1);
      return res;
    } catch (e) {
      return BlockTypeIdx.decodeStream(r);
    }
  },
});
const BrTableArg: P.CoderType<{ targets: bigint[]; default: bigint }> = /* @__PURE__ */ (() =>
  P.struct({
    targets: P.array(LEB128, idx),
    default: idx,
  }))();
const instruction = /* @__PURE__ */ (() => P.mappedTag(P.U8, {
  /*
  TODO: fix:

block/loop/if take a blocktype (not a generic Type): 0x40 | valtype (0x7F..0x7C) | typeidx (s33).
br_table is vec<labelidx> + default:labelidx (both varuint32), not EMPTY.
call_indirect order is typeidx then tableidx (old toolchains used a reserved 0x00 for table 0).


  */
  unreachable: [0x00, EMPTY],
  nop: [0x01, EMPTY],
  block: [0x02, BlockType],
  loop: [0x03, BlockType], // return type of block
  if: [0x04, BlockType],
  else: [0x05, EMPTY],
  end: [0x0b, EMPTY],
  br: [0x0c, idx],
  br_if: [0x0d, idx],
  br_table: [0x0e, BrTableArg],
  return: [0x0f, EMPTY], // early return (before end?)
  call: [0x10, idx],
  call_indirect: [0x11, P.struct({ type: idx, table: idx })],
  // paramentric?
  drop: [0x1a, EMPTY], // pops value from stack
  // [value1] [value2] [condition] from stack, select value based on condition?
  select: [0x1b, EMPTY],
  // memory
  ...getInstructions(memory, EMPTY, 'local', 'global', 'table'),
  'memory.size': [0x3f, P.magic(P.U8, 0x00)],
  'memory.grow': [0x40, P.magic(P.U8, 0x00)],
  // basic
  ...getInstructions(basic, EMPTY, 'i32', 'i64', 'f32', 'f64'),
  // references
  null: [0xd0, RefNullType],
  is_null: [0xd1, EMPTY],
  func: [0xd2, idx],
  // fb: gc + Reference-Typed Strings Proposal
  // fc: FC extensions ()
  FC: [
    0xfc,
    P.mappedTag(LEB128_32, {
      // saturade truncation
      'i32.trunc_sat_f32_s': [0, EMPTY],
      'i32.trunc_sat_f32_u': [1, EMPTY],
      'i32.trunc_sat_f64_s': [2, EMPTY],
      'i32.trunc_sat_f64_u': [3, EMPTY],
      'i64.trunc_sat_f32_s': [4, EMPTY],
      'i64.trunc_sat_f32_u': [5, EMPTY],
      'i64.trunc_sat_f64_s': [6, EMPTY],
      'i64.trunc_sat_f64_u': [7, EMPTY],
      // mem
      'memory.init': [8, P.struct({ segment: idx, mem: idx })], // x 0x00
      'memory.drop': [9, idx], // segment, x 0x00
      'memory.copy': [10, P.struct({ dst: idx, src: idx })], // 0x00 0x00
      'memory.fill': [11, idx], // 0x00
      // tables
      'table.init': [12, P.struct({ table: idx, elem: idx })],
      'table.drop': [13, idx],
      'table.copy': [14, P.struct({ dst: idx, src: idx })],
      'table.grow': [15, idx],
      'table.size': [16, idx],
      'table.fill': [17, idx],
    }),
  ],
  SIMD: [
    0xfd,
    P.mappedTag(LEB128_32, {
      ...getInstructions(simd, EMPTY, 'v128', 'i8x16', 'i16x8', 'i32x4', 'i64x2', 'f32x4', 'f64x2'),
    }),
  ],
  THREADS: [
    0xfe,
    P.mappedTag(LEB128_32, {
      'atomic.notify': [0x00, memarg],
      'atomic.fence': [0x03, P.magic(P.U8, 0x00)],
      ...getInstructions(atomics, memarg, 'i32', 'i64'),
    }),
  ],
}))();
const locals: P.CoderType<WasmLocal[]> = /* @__PURE__ */ (() =>
  P.array(LEB128, P.struct({ count: LEB128, type: ValType })))();
const codeSection: P.CoderType<WasmCode[]> = /* @__PURE__ */ (() =>
  section(P.prefix(LEB128, P.struct({ locals, instructions: P.array(null, instruction) }))))();
const functionsSection: P.CoderType<bigint[]> = /* @__PURE__ */ (() => section(idx))();
type WasmSections = {
  custom: TagEntry<0, P.CoderType<{ name: string; data: Uint8Array }>>;
  types: TagEntry<1, typeof typesSection>;
  imports: TagEntry<2, typeof importSection>;
  functions: TagEntry<3, typeof functionsSection>;
  tables: TagEntry<4, typeof stubSection>;
  memory: TagEntry<5, typeof memorySection>;
  global: TagEntry<6, typeof stubSection>;
  exports: TagEntry<7, typeof exportSection>;
  start: TagEntry<8, typeof idx>;
  element: TagEntry<9, typeof stubSection>;
  code: TagEntry<10, typeof codeSection>;
  data: TagEntry<11, typeof stubSection>;
};
const wasmSections: WasmSections = /* @__PURE__ */ (() => ({
  custom: tagEntry(0, P.prefix(LEB128, P.struct({ name: P.string(LEB128), data: P.bytes(null) }))),
  types: tagEntry(1, typesSection),
  imports: tagEntry(2, importSection),
  functions: tagEntry(3, functionsSection), // ??
  tables: tagEntry(4, stubSection),
  memory: tagEntry(5, memorySection),
  global: tagEntry(6, stubSection),
  exports: tagEntry(7, exportSection),
  start: tagEntry(8, idx), // [Function Index (varuint32)]
  element: tagEntry(9, stubSection), // [Count (varuint32)] [Element Entries (sequence)]
  code: tagEntry(10, codeSection),
  data: tagEntry(11, stubSection),
}))();

/** Coder for top-level Wasm sections. */
export const wasmSection: TRet<P.CoderType<WasmSection>> = /* @__PURE__ */ (() =>
  deepFreeze(P.mappedTag(P.U8, wasmSections)) as TRet<P.CoderType<WasmSection>>)();

/** Generic Wasm binary coder and decoder. */
export const wasmBinary: TRet<P.CoderType<WasmBinary>> = /* @__PURE__ */ (() =>
  deepFreeze(
    P.struct({
      magic: P.magic(P.string(4), '\0asm'),
      version: P.U32LE,
      sections: P.array(null, wasmSection),
    })
  ) as TRet<P.CoderType<WasmBinary>>)();

/** Lowered module shape consumed by the raw Wasm and JavaScript backends. */
export type WasmModule = {
  /** Module and generated wrapper function name. */
  name: string;
  /** Optional linear-memory configuration. */
  memory?: {
    /** Memory size in bytes before page rounding. */
    size: number;
    /** Whether memory is imported from `env._memory`. */
    import?: boolean;
    /** Whether memory is shared for threads. */
    shared?: boolean;
    /** Whether memory is exported by the module wrapper. */
    export?: boolean;
    /** Optional maximum size in bytes before page rounding. */
    maximum?: number;
  };
  /** Lowered function declarations and bodies. */
  functions: {
    name: string;
    inputs: TypeVal[];
    outputs: TypeVal[];
    export?: boolean;
    import?: boolean;
    module?: string;
    locals?: { count: bigint; type: LocalType }[]; ////P.UnwrapCoder<typeof locals>[];
    instructions?: WasmInstruction[];
  }[];
};
/** Encoded memory limits for Wasm memory sections. */
export type WasmMemoryLimits = {
  /** Encoded limit flags used by the Wasm memory type. */
  flags: {
    /** Reserved flag bit 0. */
    r0?: boolean;
    /** Reserved flag bit 1. */
    r1?: boolean;
    /** Reserved flag bit 2. */
    r2?: boolean;
    /** Reserved flag bit 3. */
    r3?: boolean;
    /** Reserved flag bit 4. */
    r4?: boolean;
    /** Reserved flag bit 5. */
    r5?: boolean;
    /** Marks memory as shared. */
    shared?: boolean;
    /** Marks the limit as carrying a maximum page count. */
    maximum?: boolean;
  };
  /** Initial memory size in Wasm pages. */
  initial: bigint;
  /** Optional maximum memory size in Wasm pages. */
  maximum?: bigint;
};
/** Memory settings returned by `wasmMemoryOpts`. */
export type WasmMemoryOpts = {
  /** Source module memory settings in bytes. */
  modMemory: NonNullable<WasmModule['memory']>;
  /** Encoded Wasm page limits. */
  opts: WasmMemoryLimits;
};

/**
 * Converts byte-sized memory settings into Wasm page limits.
 *
 * @param mod - Lowered module containing optional memory settings.
 * @returns Original memory settings and encoded Wasm memory limits.
 * @throws If shared memory lacks a maximum or initial exceeds maximum. {@link Error}
 * @example
 * ```js
 * wasmMemoryOpts({ name: 'demo', memory: { size: 65536 }, functions: [] });
 * ```
 */
export function wasmMemoryOpts(mod: WasmModule): WasmMemoryOpts {
  const toPages = (bytes: number) => BigInt(Math.ceil(bytes / 2 ** 16)); // wasm can only consume 64kb pages
  const modMemory = mod.memory || { size: 0 };
  const opts: WasmMemoryLimits = {
    flags: { shared: !!modMemory.shared },
    initial: toPages(modMemory.size),
  };
  if (modMemory.maximum !== undefined) {
    opts.flags.maximum = true;
    opts.maximum = toPages(modMemory.maximum);
  }
  if (opts.flags.shared && !opts.maximum) throw new Error('shared memory without maximum limit');
  if (opts.maximum !== undefined && opts.initial > opts.maximum)
    throw new Error(
      `memory initial pages ${opts.initial} greater than maximum pages ${opts.maximum}`
    );
  return { modMemory, opts };
}
/**
 * Converts compiler-lowered stack instructions into a Wasm binary.
 *
 * @param mod - Lowered module description.
 * @returns Encoded Wasm binary bytes.
 * @throws If memory limits, signatures, or immediates are invalid. {@link Error}
 * @example
 * ```js
 * createWasm({ name: 'demo', memory: { size: 0 }, functions: [] });
 * ```
 */
export function createWasm(mod: WasmModule): TRet<Uint8Array> {
  const { modMemory, opts: mem } = wasmMemoryOpts(mod);
  const envModule = 'env'; // always env for simplicity
  // Re-use same types (useful for blocks/loops with fallthrough)
  const types: P.UnwrapCoder<typeof typesSection> = [];
  const typeCache: Record<string, number> = {};
  const addType = (t: P.UnwrapCoder<typeof functionType>) => {
    const omit = { inputs: t.inputs, outputs: t.outputs };
    const serializedType = JSON.stringify(omit);
    if (typeCache[serializedType] !== undefined) return BigInt(typeCache[serializedType]);
    const typeIdx = types.push({ TAG: 'function', data: omit }) - 1;
    return BigInt((typeCache[serializedType] = typeIdx));
  };
  // Imports
  const memory: P.UnwrapCoder<typeof memorySection> = [];
  const imports: P.UnwrapCoder<typeof importSection> = [];
  const exports: P.UnwrapCoder<typeof exportSection> = [];
  if (modMemory.import) {
    imports.push({ module: envModule, name: '_memory', importType: { TAG: 'memory', data: mem } });
  } else {
    if (modMemory.size !== 0 || modMemory.export) memory.push(mem);
  }
  if (modMemory.export) {
    // Always single memory.
    exports.push({ name: 'memory', kind: 'memory', index: _0n });
  }
  // Functions
  const functionIdx: Record<string, number> = {};
  let functionPos = 0;
  // first pass collects imports only
  for (const fn of mod.functions) {
    if (!fn.import) continue;
    if (fn.locals || fn.instructions)
      throw new Error('imported function with locals or instructions');
    imports.push({
      // `env` is only the default module; importFn(..., module) must survive to linking.
      module: fn.module || envModule,
      name: fn.name,
      importType: { TAG: 'function', data: addType(fn) },
    });
    if (functionIdx[fn.name] !== undefined)
      throw new Error(`function ${fn.name} (import) re-declared`);
    const unified = functionPos++;
    functionIdx[fn.name] = unified;
    if (fn.export) exports.push({ name: fn.name, kind: 'function', index: BigInt(unified) });
  }
  // second pass collects non-imports only
  const functions: P.UnwrapCoder<typeof functionsSection> = [];
  for (const fn of mod.functions) {
    if (fn.import) continue;
    functions.push(addType(fn)); // function just type idx
    if (functionIdx[fn.name] !== undefined) throw new Error(`function ${fn.name} re-declared`);
    const unified = functionPos++;
    functionIdx[fn.name] = unified;
    if (fn.export) exports.push({ name: fn.name, kind: 'function', index: BigInt(unified) });
  }
  // at this point we have information about function indices for all names, so we can handle calls
  const code: P.UnwrapCoder<typeof codeSection> = [];
  for (const fn of mod.functions) {
    if (fn.import) continue;
    if (!fn.locals || !fn.instructions)
      throw new Error(`function ${fn.name} without locals or instructions`);
    // should be aligned with functions since same iterations (skip imports)
    code.push({
      locals: fn.locals,
      instructions: fn.instructions.map((i: any) => {
        // simplify nested stuff
        for (const t of ['v128', 'i8x16', 'i16x8', 'i32x4', 'i64x2', 'f32x4', 'f64x2']) {
          if (i.TAG.startsWith(t)) return { TAG: 'SIMD', data: i };
        }
        if (i.TAG.includes('atomic.')) return { TAG: 'THREADS', data: i };
        if (i.TAG.startsWith('memory') && !['memory.size', 'memory.grow'].includes(i.TAG))
          return { TAG: 'FC', data: i };
        if (['loop', 'block', 'if'].includes(i.TAG)) {
          // NOTE: there is no inputs on block/loop!
          return {
            TAG: i.TAG,
            data:
              typeof i.data === 'string'
                ? i.data
                : Number(addType({ inputs: i.data.inputs, outputs: i.data.outputs })),
          };
        }
        if (i.TAG === 'call') {
          let idx = i.data;
          if (typeof i.data === 'string') {
            if (functionIdx[i.data] === undefined)
              throw new Error(`call: unknown function ${i.data}`);
            idx = BigInt(functionIdx[i.data]);
          }
          return { TAG: i.TAG, data: idx };
        }
        return i;
      }),
    });
  }
  if (functions.length !== code.length) throw new Error('functions.length!==code.length');
  const sections: P.UnwrapCoder<typeof wasmSection>[] = [];
  if (types.length) sections.push({ TAG: 'types', data: types });
  if (imports.length) sections.push({ TAG: 'imports', data: imports });
  if (functions.length) sections.push({ TAG: 'functions', data: functions });
  if (memory.length) sections.push({ TAG: 'memory', data: memory });
  if (exports.length) sections.push({ TAG: 'exports', data: exports });
  if (code.length) sections.push({ TAG: 'code', data: code });
  return wasmBinary.encode({ version: 1, sections }) as TRet<Uint8Array>;
}
