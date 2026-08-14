import { should } from './jsbt.js';

import './big-ints.test.ts';
import './cast-to.test.ts';
import './codegen.test.ts';
import './js.test.ts';
import './optimizer-targets.test.ts';
import './small-int.test.ts';
import './types.test.ts';
import './utils.test.ts';
import './values.test.ts';
import './wasm.test.ts';

should.runWhen(import.meta.url);
