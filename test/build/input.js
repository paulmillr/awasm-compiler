import * as codegen from '@awasm/compiler/codegen.js';
import * as js from '@awasm/compiler/js.js';
import * as memory from '@awasm/compiler/memory.js';
import * as module from '@awasm/compiler/module.js';
import * as rewrites from '@awasm/compiler/rewrites.js';
import * as runtime from '@awasm/compiler/runtime.js';
import * as types from '@awasm/compiler/types.js';
import * as utils from '@awasm/compiler/utils.js';
import * as wasm from '@awasm/compiler/wasm.js';
import * as workers from '@awasm/compiler/workers.js';

export const compiler = {
  codegen,
  js,
  memory,
  module,
  types,
  utils,
  wasm,
  workers,
  rewrites,
  runtime,
};
