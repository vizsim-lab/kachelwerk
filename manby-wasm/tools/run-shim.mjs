// Runs manby.wasm through @bjorn3/browser_wasi_shim, the in-memory WASI a web
// page would use, here in Node: the GeoParquet goes in as bytes, the
// PMTiles comes out as bytes, and no real file system is involved.
//
// Usage: node run-shim.mjs <shim dir> <manby.wasm> <in.parquet> <out.pmtiles> [manby flags...]
import { readFile, writeFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';

const [shimDir, wasmPath, inPath, outPath, ...flags] = process.argv.slice(2);
const { WASI, File, OpenFile, ConsoleStdout, PreopenDirectory } = await import(
  pathToFileURL(`${shimDir}/dist/index.js`).href
);

const data = new PreopenDirectory(
  '/data',
  new Map([['input.parquet', new File(new Uint8Array(await readFile(inPath)))]])
);
const fds = [
  new OpenFile(new File([])),
  ConsoleStdout.lineBuffered((line) => console.log(line)),
  ConsoleStdout.lineBuffered((line) => console.error(line)),
  data,
  new PreopenDirectory('/tmp', new Map()),
];
const wasi = new WASI(['manby', ...flags, '-o', '/data/out.pmtiles', '/data/input.parquet'], [], fds);

const t0 = performance.now();
const module = await WebAssembly.compile(await readFile(wasmPath));
const instance = await WebAssembly.instantiate(module, { wasi_snapshot_preview1: wasi.wasiImport });
const t1 = performance.now();
const code = wasi.start(instance);
const t2 = performance.now();
const out = data.dir.contents.get('out.pmtiles');
console.error(
  `[shim] exit=${code} compile=${(t1 - t0).toFixed(0)}ms run=${(t2 - t1).toFixed(0)}ms ` +
    `memory=${(instance.exports.memory.buffer.byteLength / 2 ** 20).toFixed(0)}MiB ` +
    `out=${out ? out.data.length : 'missing'} bytes`
);
if (out) await writeFile(outPath, out.data);
process.exitCode = code;
