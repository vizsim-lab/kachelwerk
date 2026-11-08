// Runs a WASI command module in Node, with only /data and /tmp visible to it,
// as a browser WASI shim would give it a small in-memory file system.
//
// Usage: node run-wasi.mjs <module.wasm> <data dir> <tmp dir> [args...]
import { readFile } from 'node:fs/promises';
import { WASI } from 'node:wasi';

const [wasmPath, dataDir, tmpDir, ...args] = process.argv.slice(2);
const wasi = new WASI({
  version: 'preview1',
  args: ['manby', ...args],
  env: {},
  preopens: { '/data': dataDir, '/tmp': tmpDir },
  returnOnExit: true,
});
const t0 = performance.now();
const module = await WebAssembly.compile(await readFile(wasmPath));
const t1 = performance.now();
const instance = await WebAssembly.instantiate(module, wasi.getImportObject());
const code = wasi.start(instance);
const t2 = performance.now();
const mem = instance.exports.memory.buffer.byteLength;
console.error(
  `[run-wasi] exit=${code} compile=${(t1 - t0).toFixed(0)}ms run=${(t2 - t1).toFixed(0)}ms memory=${(mem / 2 ** 20).toFixed(0)}MiB`
);
process.exitCode = code;
