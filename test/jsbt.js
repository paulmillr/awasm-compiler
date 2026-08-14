/*! Vendored @paulmillr/jsbt test runner after 0.7.0 with live parallel quiet progress. */
var __defProp = Object.defineProperty;
var __getOwnPropNames = Object.getOwnPropertyNames;
var __esm = (fn, res, err) => function __init() {
  if (err) throw err[0];
  try {
    return fn && (res = (0, fn[__getOwnPropNames(fn)[0]])(fn = 0)), res;
  } catch (e) {
    throw err = [e], e;
  }
};
var __export = (target, all) => {
  for (var name in all)
    __defProp(target, name, { get: all[name], enumerable: true });
};

// ../jsbt/src/test.ts
var test_exports = {};
__export(test_exports, {
  afterAll: () => afterAll,
  afterEach: () => afterEach,
  beforeAll: () => beforeAll,
  beforeEach: () => beforeEach,
  default: () => test_default,
  describe: () => describe,
  it: () => it,
  should: () => it
});
function hasImportSearch(importMetaUrl) {
  try {
    return new URL(importMetaUrl).search !== "";
  } catch (_) {
    return importMetaUrl.includes("?");
  }
}
function isNodeTestArg(arg) {
  const str = String(arg);
  return str === "--test" || str.startsWith("--test-") || str.startsWith("--test=");
}
function resolveNativeNodeTest() {
  if (!isNode || hasImportSearch(import.meta.url)) return;
  const env = proc?.env || {};
  const isTestContext = env.NODE_TEST_CONTEXT !== void 0 || env.NODE_TEST_WORKER_ID !== void 0;
  const hasTestArg = Array.isArray(proc?.execArgv) && proc.execArgv.some(isNodeTestArg);
  if (!isTestContext || !hasTestArg || typeof proc?.getBuiltinModule !== "function") return;
  return proc.getBuiltinModule("node:test");
}
function wantColor(env = {}, tty = false) {
  if (env.CLICOLOR_FORCE && env.CLICOLOR_FORCE !== "0") return true;
  if (env.FORCE_COLOR && env.FORCE_COLOR !== "0") return true;
  if (env.NO_COLOR) return false;
  if (env.FORCE_COLOR === "0") return false;
  if (env.CLICOLOR === "0") return false;
  return tty;
}
function parseBoolEnv(str, defaultValue) {
  if (str === void 0) return defaultValue;
  const raw = String(str).trim().toLowerCase();
  if (raw === "1" || raw === "true") return true;
  if (raw === "" || raw === "0" || raw === "false") return false;
  return defaultValue;
}
function parseFast(str) {
  if (!isCli) return 0;
  const raw = String(str || "").trim().toLowerCase();
  if (raw === "true") return 1;
  const val = Number.parseFloat(raw);
  const ratio = val > 0 && val < 1;
  if (!Number.isFinite(val) || val === 0 || Math.abs(val) > 256) return 0;
  if (!ratio && !Number.isSafeInteger(val)) return 0;
  return val;
}
function defaultFast(env = {}) {
  if (!isNode) return 0;
  return env.JSBT_FAST === void 0 ? 1 : parseFast(env.JSBT_FAST);
}
function fastWorkerCount(fast, max) {
  const count = fast === 1 ? max : fast < 0 ? max + fast : fast < 1 ? Math.floor(max * fast) : fast;
  return Math.max(1, Math.min(count, 256));
}
function imp(moduleName) {
  return import(moduleName);
}
function color(colorName, title) {
  return colorOn ? `${c[colorName]}${title}${c.reset}` : title.toString();
}
function parallelPathSep() {
  return color("gray", " \u2192 ");
}
function flatStyle(pathSep = PATH_SEP) {
  return { tree: false, inline: false, pathSep };
}
function log(...args) {
  if (opts.QUIET) return logQuiet(false);
  console.log(...args);
}
function writeStream(streamName, text, fallback = text) {
  const stream = proc?.[streamName];
  if (isCli && typeof stream?.write === "function") stream.write(text);
  else console[streamName === "stdout" ? "log" : "error"](fallback);
}
function writeStdout(text, fallback = text) {
  writeStream("stdout", text, fallback);
}
function writeStderr(text, fallback = text) {
  writeStream("stderr", text, fallback);
}
function logInline(line, done = false) {
  if (opts.QUIET) return;
  writeStdout(done ? `\r${line}
` : line, line);
}
function logQuiet(fail = false) {
  if (fail) {
    if (quietFailCount !== void 0) return void quietFailCount++;
    const msg = color("red", "!");
    writeStderr(msg);
  } else {
    if (quietPassCount !== void 0) return void quietPassCount++;
    const msg = ".";
    writeStdout(msg);
  }
}
function addToErrorLog(title = "", error) {
  errorLog.push(`${title} ${error?.stack ? error.stack : error}`);
  if (!opts.QUIET) console.error(error);
}
function formatPrefix(depth, prefix) {
  if (depth === 0) return { prefix: "", childPrefix: "" };
  return { prefix: `${prefix}${INDENT}`, childPrefix: `${prefix}${INDENT}` };
}
async function runTest(info, style, stopAtError = true) {
  if (!style.tree && style.inline) log();
  const title = info.message;
  if (typeof info.test !== "function") throw new Error("internal test error: invalid info.test");
  const messages = [];
  const onlyStackToLog = [];
  const beforeEachFns = [];
  const afterEachFns = [];
  for (const parent of info.path) {
    if (parent.message) {
      messages.push(parent.message);
      if (style.tree && info.only) onlyStackToLog.push(`${parent.prefix}${parent.message}`);
    }
    if (parent.beforeEach) beforeEachFns.push(parent.beforeEach);
    if (parent.afterEach) afterEachFns.push(parent.afterEach);
  }
  afterEachFns.reverse();
  if (onlyStackToLog.length) onlyStackToLog.forEach((l) => log(l));
  const pathParts = messages.slice().concat(title);
  const path = pathParts.join(PATH_SEP);
  const displayPath = pathParts.join(style.pathSep);
  const inline = style.inline && !info.skip && !opts.QUIET;
  function formatTaskStart(suffix = "") {
    const title_ = suffix ? [title, suffix].join(PATH_SEP) : title;
    const full_ = suffix ? pathParts.concat(suffix).join(style.pathSep) : displayPath;
    return style.tree ? color("gray", `${info.prefix}${title_}`) : full_;
  }
  if (inline) {
    logInline(`${formatTaskStart()} `);
  } else if (info.skip) {
    log(style.tree ? color("gray", `${info.prefix}${title} (skip)`) : `\u2606 ${displayPath} (skip)`);
    return true;
  }
  function formatTaskDone(fail = false, suffix = "") {
    const symbol = fail ? "\u2715" : "\u2713";
    const clr = fail ? "red" : "green";
    const title_ = suffix ? [title, suffix].join(PATH_SEP) : title;
    const full_ = formatTaskStart(suffix);
    const coloredSymbol = color(clr, symbol);
    if (inline) return `${full_} ${coloredSymbol}`;
    return style.tree ? `${color("gray", `${info.childPrefix}${title_}`)}: ${coloredSymbol}` : `${coloredSymbol} ${full_}`;
  }
  function logTaskDone(fail = false, suffix = "") {
    const line = formatTaskDone(fail, suffix);
    if (inline) logInline(line, true);
    else if (fail) console.error(line);
    else log(line);
  }
  function logErrorStack(suffix) {
    if (opts.QUIET) {
      if (stopAtError) {
        console.error();
        console.error(formatTaskDone(true, suffix));
      } else {
        logQuiet(true);
      }
    } else {
      logTaskDone(true, suffix);
    }
  }
  for (const beforeFn of beforeEachFns) {
    try {
      await beforeFn();
    } catch (cause) {
      logErrorStack("beforeEach");
      if (stopAtError) throw cause;
      else addToErrorLog(`${path}/beforeEach`, cause);
      return false;
    }
  }
  try {
    await info.test();
  } catch (cause) {
    logErrorStack("");
    if (stopAtError) throw cause;
    else addToErrorLog(`${path}`, cause);
    return false;
  }
  for (const afterFn of afterEachFns) {
    try {
      await afterFn();
    } catch (cause) {
      logErrorStack("afterEach");
      if (stopAtError) throw cause;
      else addToErrorLog(`${path}/afterEach`, cause);
      return false;
    }
  }
  logTaskDone();
  return true;
}
function stackTop() {
  return stack[stack.length - 1];
}
function stackAdd(info) {
  const c2 = { ...info, children: [] };
  stackTop().children.push(c2);
  stack.push(c2);
}
function stackFlatten(elm) {
  const out = [];
  const root = { ...elm, prefix: "", childPrefix: "", path: [] };
  const rootPath = root.beforeAll || root.afterAll || root.beforeEach || root.afterEach ? [root] : [];
  const walk = (elm2, depth = 0, prevPrefix = "", path = []) => {
    const { prefix, childPrefix } = formatPrefix(depth, prevPrefix);
    const newElm = { ...elm2, prefix, childPrefix, path };
    out.push(newElm);
    path = path.concat([newElm]);
    const chl = elm2.children;
    for (let i = 0; i < chl.length; i++) walk(chl[i], depth + 1, childPrefix, path);
  };
  for (const child of elm.children) walk(child, 0, "", rootPath);
  return out;
}
function describeSkip(message, fn) {
  if (nativeNodeTest) {
    nativeNodeTest.describe.skip(message, fn);
    return;
  }
  stackAdd({ message, skip: true });
  stack.pop();
}
function beforeAll(fn) {
  if (nativeNodeTest) {
    nativeNodeTest.before(fn);
    return;
  }
  stackTop().beforeAll = fn;
}
function afterAll(fn) {
  if (nativeNodeTest) {
    nativeNodeTest.after(fn);
    return;
  }
  stackTop().afterAll = fn;
}
function beforeEach(fn) {
  if (nativeNodeTest) {
    nativeNodeTest.beforeEach(fn);
    return;
  }
  stackTop().beforeEach = fn;
}
function afterEach(fn) {
  if (nativeNodeTest) {
    nativeNodeTest.afterEach(fn);
    return;
  }
  stackTop().afterEach = fn;
}
function register(info) {
  if (nativeNodeTest) {
    const options = {};
    if (info.only) options.only = true;
    if (info.skip) options.skip = true;
    if (info.serial) options.concurrency = false;
    nativeTestCount++;
    if (Object.keys(options).length) nativeNodeTest.test(info.message, options, info.test);
    else nativeNodeTest.test(info.message, info.test);
    return;
  }
  stackAdd(info);
  stack.pop();
}
function taskPath(info, pathSep = PATH_SEP) {
  return (info.path || []).map((item) => item.message).concat(info.message).filter((item) => item).join(pathSep);
}
function filterTasks(items) {
  const filter = opts.FILTER;
  if (!filter) return items;
  const keep = /* @__PURE__ */ new Set();
  for (const item of items) {
    if (!item.test || !taskPath(item).includes(filter)) continue;
    keep.add(item);
    for (const parent of item.path || []) keep.add(parent);
  }
  return items.filter((item) => keep.has(item));
}
function cloneAndReset() {
  let items = stackFlatten(stack[0]).slice();
  if (onlyStack) items = items.filter((i) => i.test === onlyStack.test);
  items = filterTasks(items);
  stack.splice(0, stack.length);
  stack.push({ message: "", children: [] });
  onlyStack = void 0;
  return items;
}
function commonPathLen(a, b) {
  let i = 0;
  while (i < a.length && i < b.length && a[i] === b[i]) i++;
  return i;
}
function hookPath(suite, hook, pathSep = PATH_SEP) {
  return (suite.path || []).map((i) => i.message).concat(suite.message, hook).filter((i) => i).join(pathSep);
}
function formatHookFail(suite, hook, style) {
  const title = hookPath(suite, hook, style.pathSep);
  const symbol = color("red", "\u2715");
  return style.tree && suite.message ? `${suite.childPrefix}${hook}: ${symbol}` : `${symbol} ${title}`;
}
async function runAllHook(suite, hook, style, stopAtError) {
  const fn = suite[hook];
  if (!fn) return true;
  try {
    await fn();
    return true;
  } catch (cause) {
    if (opts.QUIET) {
      if (stopAtError) {
        console.error();
        console.error(formatHookFail(suite, hook, style));
      } else {
        logQuiet(true);
      }
    } else {
      console.error(formatHookFail(suite, hook, style));
    }
    if (stopAtError) throw cause;
    addToErrorLog(hookPath(suite, hook), cause);
    return false;
  }
}
async function runTaskList(tasks, style, stopAtError) {
  const active = [];
  const failedBeforeAll = /* @__PURE__ */ new Set();
  const closeInactive = async (path) => {
    const keep = commonPathLen(active, path);
    for (let i = active.length - 1; i >= keep; i--) {
      const suite = active[i];
      if (!failedBeforeAll.has(suite)) await runAllHook(suite, "afterAll", style, stopAtError);
      active.pop();
    }
  };
  const openSuites = async (path) => {
    const keep = commonPathLen(active, path);
    for (let i = keep; i < path.length; i++) {
      const suite = path[i];
      active.push(suite);
      if (!await runAllHook(suite, "beforeAll", style, stopAtError)) {
        failedBeforeAll.add(suite);
        return false;
      }
    }
    return !path.some((suite) => failedBeforeAll.has(suite));
  };
  for (const task of tasks) {
    const path = task.path || [];
    await closeInactive(path);
    if (!task.test) {
      if (style.tree) log(`${task.prefix}${task.message}`);
      continue;
    }
    if (task.skip || await openSuites(path)) await runTest(task, style, stopAtError);
  }
  await closeInactive([]);
}
function hasAllHooks(info) {
  return !!info.path?.some((suite) => suite.beforeAll || suite.afterAll);
}
function hasDynamicWorkerCount(fast) {
  return fast === 1 || fast < 0 || fast > 0 && fast < 1;
}
async function resolveParallelRuntime() {
  try {
    const cluster = (await imp("node:cluster")).default;
    let workers = opts.FAST;
    if (hasDynamicWorkerCount(workers)) {
      workers = fastWorkerCount(workers, (await imp("node:os")).cpus().length);
    }
    if (opts.FILTER) workers = Math.min(workers, 3);
    return { cluster, workers: parseFast(workers) ? workers : 0 };
  } catch (_) {
    return { workers: 0 };
  }
}
function splitParallelTasks(tasks) {
  const parallelTasks = [];
  const serialTasks = [];
  for (const task of tasks) {
    (task.serial || hasAllHooks(task) ? serialTasks : parallelTasks).push(task);
  }
  return { parallelTasks, serialTasks };
}
async function runSequentialFallback(items, total, startTime) {
  isRunning = true;
  begin(total);
  await runTaskList(items, SEQUENTIAL_STYLE, opts.STOP_ON_ERROR);
  return finalize(total, startTime);
}
function sendParallelMessage(msg) {
  return new Promise((resolve, reject) => {
    proc.send(msg, (error) => error ? reject(error) : resolve());
  });
}
async function flushParallelQuietCounts() {
  if (!opts.QUIET || !quietPassCount && !quietFailCount) return;
  const msg = {
    name: "parallelProgress",
    quietPassCount,
    quietFailCount
  };
  quietPassCount = 0;
  quietFailCount = 0;
  await sendParallelMessage(msg);
}
async function runParallelWorker(cluster, totalW, parallelTasks, style) {
  proc.on("error", (err) => console.log("internal error:", "child crashed?", err));
  let tasksDone = 0;
  const workerIndex = Number.parseInt(proc.env.JSBT_WORKER_INDEX || "", 10);
  const id = Number.isSafeInteger(workerIndex) && workerIndex >= 0 && workerIndex < totalW ? workerIndex : cluster.worker.id - 1;
  if (opts.QUIET) {
    quietPassCount = 0;
    quietFailCount = 0;
  }
  for (let i = id; i < parallelTasks.length; i += totalW) {
    await runTest(parallelTasks[i], style, opts.STOP_ON_ERROR);
    tasksDone++;
    await flushParallelQuietCounts();
  }
  await sendParallelMessage({
    name: "parallelTests",
    tasksDone,
    errorLog
  });
  proc.exit();
}
function logParallelQuietCounts(msg) {
  if (!opts.QUIET) return;
  if (msg.quietPassCount) writeStdout(".".repeat(msg.quietPassCount));
  if (msg.quietFailCount) writeStderr(color("red", "!".repeat(msg.quietFailCount)));
}
async function runPrimaryParallel(cluster, totalW, total, startTime, parallelTasks, serialTasks, style) {
  return new Promise((resolve, reject) => {
    begin(total, totalW);
    if (!opts.QUIET) console.log();
    const workers = [];
    let tasksDone = 0;
    let workersDone = 0;
    cluster.on("exit", (worker, code) => {
      if (!code) return;
      const msg = `Worker W${worker.id} (pid: ${worker.process.pid}) crashed with code: ${code}`;
      workers.forEach((w) => w.kill());
      reject(new Error(msg));
    });
    for (let i = 0; i < totalW; i++) {
      const worker = cluster.fork({ JSBT_WORKER_INDEX: String(i) });
      workers.push(worker);
      worker.on("error", (err) => reject(err));
      worker.on("message", (msg) => {
        if (!msg) return;
        if (msg.name === "parallelProgress") return logParallelQuietCounts(msg);
        if (msg.name !== "parallelTests") return;
        workersDone++;
        tasksDone += msg.tasksDone;
        msg.errorLog.forEach((item) => errorLog.push(item));
        if (workersDone !== totalW) return;
        if (tasksDone !== parallelTasks.length)
          return reject(new Error("internal error: not all tasks have been completed"));
        globalThis.setTimeout(async () => {
          try {
            await runTaskList(serialTasks, style, opts.STOP_ON_ERROR);
            resolve(finalize(total, startTime));
          } catch (error) {
            reject(error);
          }
        }, 0);
      });
    }
  });
}
function begin(total, workers) {
  const quiet = opts.QUIET ? 1 : 0;
  const fast = workers || 0;
  const envVars = [`JSBT_QUIET=${quiet}`, `JSBT_FAST=${fast}`, `JSBT_FILTER='${opts.FILTER}'`];
  if (isCli && proc?.env?.JSBT_BAIL !== void 0) {
    envVars.push(`JSBT_BAIL=${opts.STOP_ON_ERROR ? 1 : 0}`);
  }
  const env = color("gray", `(${envVars.join(", ")})`);
  const sfx = total > 1 ? "s" : "";
  console.log(`${color("green", total.toString())} test${sfx} started ${env}`);
}
function finalize(total, startTime) {
  isRunning = false;
  console.log();
  const totalFailed = errorLog.length;
  const sec = Math.ceil((Date.now() - startTime) / 1e3);
  const tdiff = sec < 60 ? `in ${sec} sec` : `in ${Math.floor(sec / 60)} min ${sec % 60} sec`;
  if (totalFailed) {
    if (opts.QUIET) {
      errorLog.forEach((err) => console.error(err));
    }
    if (errorLog.length > 0)
      throw new Error(`${errorLog.length} of ${total} tests failed ${tdiff}`);
  } else {
    console.log(`${color("green", total)} tests passed ${tdiff}`);
  }
  return total;
}
async function runTests(forceSequential = false) {
  if (nativeNodeTest) return nativeTestCount;
  if (isRunning) throw new Error("it.run() has already been called, wait for end");
  errorLog.splice(0, errorLog.length);
  if (!forceSequential && opts.FAST) return runTestsInParallel();
  isRunning = true;
  const tasks = cloneAndReset();
  const total = tasks.filter((i) => !!i.test).length;
  begin(total);
  const startTime = Date.now();
  await runTaskList(tasks, SEQUENTIAL_STYLE, opts.STOP_ON_ERROR);
  return finalize(total, startTime);
}
async function runTestsWhen(importMetaUrl) {
  if (nativeNodeTest) return;
  if (!isCli) return;
  const { pathToFileURL } = await imp("node:url");
  return importMetaUrl === pathToFileURL(proc.argv[1]).href ? runTests() : void 0;
}
async function runTestsInParallel() {
  if (!isCli) throw new Error("must run in cli");
  errorLog.splice(0, errorLog.length);
  if ("deno" in (proc?.versions || {})) return runTests(true);
  const items = cloneAndReset();
  const tasks = items.filter((i) => !!i.test);
  const total = tasks.length;
  const startTime = Date.now();
  const { cluster, workers: totalW } = await resolveParallelRuntime();
  if (!cluster || !totalW) return runSequentialFallback(items, total, startTime);
  const { parallelTasks, serialTasks } = splitParallelTasks(tasks);
  const pathSep = parallelPathSep();
  if (!parallelTasks.length) {
    begin(total);
    await runTaskList(serialTasks, SEQUENTIAL_STYLE, opts.STOP_ON_ERROR);
    return finalize(total, startTime);
  }
  const style = flatStyle(pathSep);
  if (!cluster.isPrimary) {
    await runParallelWorker(cluster, totalW, parallelTasks, style);
    return total;
  }
  return runPrimaryParallel(
    cluster,
    totalW,
    total,
    startTime,
    parallelTasks,
    serialTasks,
    style
  ).catch((err) => {
    console.error();
    console.error(color("red", "Tests failed: " + err.message));
    err.stack = "";
    throw err;
  });
}
var stack, errorLog, quietPassCount, quietFailCount, onlyStack, isRunning, isCli, pr, proc, isNode, nativeNodeTest, nativeTestCount, colorOn, opts, _c, c, PATH_SEP, INDENT, SEQUENTIAL_STYLE, describe, it, test_default;
var init_test = __esm({
  "../jsbt/src/test.ts"() {
    "use strict";
    stack = [{ message: "", children: [] }];
    errorLog = [];
    isRunning = false;
    isCli = "process" in globalThis;
    pr = globalThis["process"];
    proc = isCli ? pr : void 0;
    isNode = isCli && typeof proc?.versions?.node === "string";
    nativeNodeTest = resolveNativeNodeTest();
    nativeTestCount = 0;
    colorOn = isCli && wantColor(proc?.env, !!proc?.stderr?.isTTY || !!proc?.stdout?.isTTY);
    opts = {
      STOP_ON_ERROR: isCli ? parseBoolEnv(proc?.env?.JSBT_BAIL, true) : true,
      QUIET: isCli && parseBoolEnv(proc?.env?.JSBT_QUIET, false),
      FAST: defaultFast(proc?.env),
      FILTER: isCli ? proc?.env?.JSBT_FILTER || "" : ""
    };
    _c = String.fromCharCode(27);
    c = {
      // colors
      gray: _c + "[90m",
      red: _c + "[31m",
      green: _c + "[32m",
      reset: _c + "[0m"
    };
    PATH_SEP = "/";
    INDENT = "  ";
    SEQUENTIAL_STYLE = { tree: isCli, inline: true, pathSep: PATH_SEP };
    describe = (message, fn) => {
      if (nativeNodeTest) {
        nativeNodeTest.describe(message, fn);
        return;
      }
      stackAdd({ message });
      fn();
      stack.pop();
    };
    describe.skip = describeSkip;
    it = (message, test2) => register({ message, test: test2, children: [] });
    it.only = (message, test2) => register(onlyStack = { message, test: test2, children: [], only: true });
    it.skip = (message, test2) => register({ message, test: test2, children: [], skip: true });
    it.serial = (message, test2) => register({ message, test: test2, children: [], serial: true });
    it.run = runTests;
    it.runWhen = runTestsWhen;
    it.opts = opts;
    test_default = it;
  }
});

// test/jsbt.ts
import { availableParallelism } from "node:os";
function normalizeFast(raw) {
  if (raw === void 0) return String(Math.min(availableParallelism(), 256));
  const value = String(raw || "").trim().toLowerCase();
  const fast = value === "true" ? 1 : Number.parseFloat(value);
  const ratio = fast > 0 && fast < 1;
  if (!Number.isFinite(fast) || fast === 0 || Math.abs(fast) > 256) return raw;
  if (!ratio && !Number.isSafeInteger(fast)) return raw;
  if (fast !== 1 && fast >= 0 && !ratio) return raw;
  const max = availableParallelism();
  const count = fast === 1 ? max : fast < 0 ? max + fast : Math.floor(max * fast);
  return String(Math.max(1, Math.min(count, 256)));
}
process.env.JSBT_FAST = normalizeFast(process.env.JSBT_FAST);
var test = await Promise.resolve().then(() => (init_test(), test_exports));
var { afterAll: afterAll2, afterEach: afterEach2, beforeAll: beforeAll2, beforeEach: beforeEach2, describe: describe2, it: it2, should } = test;
var jsbt_default = test.default;
export {
  afterAll2 as afterAll,
  afterEach2 as afterEach,
  beforeAll2 as beforeAll,
  beforeEach2 as beforeEach,
  jsbt_default as default,
  describe2 as describe,
  it2 as it,
  should
};
/*! jsbt - MIT License (c) 2019 Paul Miller (paulmillr.com) */
