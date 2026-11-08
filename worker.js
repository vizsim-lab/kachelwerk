// MATSim Kachelwerk worker: step 1 (MATSim network XML to GeoJSON, when the
// input is not GeoParquet already) and step 2 (manby.wasm, run through an
// in-memory WASI, to PMTiles). One compiled module, a new instance per run.
import {
  WASI,
  File as WasiFile,
  OpenFile,
  ConsoleStdout,
  PreopenDirectory,
} from "./vendor/browser_wasi_shim/index.js"; // @bjorn3/browser_wasi_shim 0.4.2

let compiled;

function manbyModule() {
  compiled ??= (async () => {
    const res = await fetch(new URL("manby.wasm", import.meta.url));
    if (!res.ok) throw new Error(`manby.wasm konnte nicht geladen werden (HTTP ${res.status}).`);
    try {
      return await WebAssembly.compileStreaming(res.clone());
    } catch (e) {
      // compileStreaming needs the application/wasm type; compile() does not
      if (e instanceof WebAssembly.CompileError) throw e;
      return await WebAssembly.compile(await res.arrayBuffer());
    }
  })();
  compiled.catch(() => (compiled = undefined));
  return compiled;
}

const status = (text) => postMessage({ type: "status", text });
const log = (line) => postMessage({ type: "log", line });

/** Step 1 stand-in: a MATSim network (v1 or v2, plain or gzipped) as GeoJSON bytes. */
async function matsimToGeoJSON(bytes) {
  let stream = new Blob([bytes]).stream();
  if (bytes[0] === 0x1f && bytes[1] === 0x8b) stream = stream.pipeThrough(new DecompressionStream("gzip"));
  const reader = stream.pipeThrough(new TextDecoderStream()).getReader();

  const tagRe = /<(node|link)\s([^>]*)>/g;
  const attrRe = /([\w:.-]+)="([^"]*)"/g;
  const crsRe = /<attribute\s+name="coordinateReferenceSystem"[^>]*>\s*([^<\s]+)\s*<\/attribute>/;
  const nodes = new Map();
  const features = [];
  let rest = "";
  let head = "";
  let crs = null;
  let missing = 0;

  for (;;) {
    const { value, done } = await reader.read();
    const text = rest + (value ?? "");
    let cut = done ? text.length : text.lastIndexOf(">") + 1;
    // a comment still open at the cut waits for the next piece
    const open = text.lastIndexOf("<!--", cut);
    const close = open < 0 ? -1 : text.indexOf("-->", open);
    if (!done && open >= 0 && (close < 0 || close + 3 > cut)) cut = open;
    // commented-out nodes and links are not part of the network
    const chunk = text.slice(0, cut).replace(/<!--[\s\S]*?-->/g, "");
    rest = text.slice(cut);
    if (crs === null && head.length < 1 << 20) {
      head += chunk;
      const m = crsRe.exec(head);
      if (m) crs = m[1];
    }
    tagRe.lastIndex = 0;
    let m;
    while ((m = tagRe.exec(chunk))) {
      const a = {};
      attrRe.lastIndex = 0;
      let am;
      while ((am = attrRe.exec(m[2]))) a[am[1]] = am[2];
      if (m[1] === "node") {
        nodes.set(a.id, [Number(a.x), Number(a.y)]);
        continue;
      }
      const from = nodes.get(a.from);
      const to = nodes.get(a.to);
      if (!from || !to) {
        missing++;
        continue;
      }
      const freespeed = Number(a.freespeed);
      features.push(
        JSON.stringify({
          type: "Feature",
          properties: {
            id: a.id,
            from: a.from,
            to: a.to,
            length: Number(a.length),
            freespeed,
            freespeed_kmh: Math.round(freespeed * 36) / 10,
            capacity: Number(a.capacity),
            permlanes: Number(a.permlanes),
            modes: a.modes ?? "",
          },
          geometry: { type: "LineString", coordinates: [from, to] },
        })
      );
      if (features.length % 50000 === 0) status(`MATSim-Netz lesen: ${features.length.toLocaleString("de-DE")} Links …`);
    }
    if (done) break;
  }
  if (features.length === 0) {
    throw new Error("In der Datei stehen keine <link>-Elemente. Ist es ein MATSim-Netz (network.xml)?");
  }
  const json = `{"type":"FeatureCollection","features":[${features.join(",")}]}`;
  return { bytes: new TextEncoder().encode(json), links: features.length, nodes: nodes.size, crs, missing };
}

async function tile(job) {
  const t0 = performance.now();
  status("manby laden …");
  const modulePromise = manbyModule();

  let input = new Uint8Array(job.bytes);
  let inputName = "input.parquet";
  let crs = job.crs;
  const info = { kind: job.kind };
  if (job.kind === "matsim") {
    status("MATSim-Netz lesen …");
    const g = await matsimToGeoJSON(input);
    input = g.bytes;
    inputName = "input.geojson";
    Object.assign(info, { links: g.links, nodes: g.nodes, crsFromFile: g.crs, missing: g.missing });
    if (g.crs) crs = g.crs;
    log(`Schritt 1: ${g.links.toLocaleString("de-DE")} Links, ${g.nodes.toLocaleString("de-DE")} Knoten` +
      (g.crs ? `, CRS ${g.crs} aus der Datei` : `, CRS ${crs} aus dem Formular`) +
      (g.missing ? `, ${g.missing} Links ohne Knoten übersprungen` : ""));
  }
  // GeoParquet names its own CRS; -s only applies when it does not
  info.crs = job.kind === "matsim" ? crs : null;
  const t1 = performance.now();

  const args = ["manby", "-l", job.layer, "-n", job.name];
  args.push(job.maxzoom === "auto" ? "-zg" : `-z${job.maxzoom}`);
  if (job.dropDensest) args.push("--drop-densest-as-needed");
  if (crs) args.push("-s", crs);
  args.push(...job.extra, "-o", "/data/out.pmtiles", `/data/${inputName}`);
  log("$ " + args.join(" "));

  const module = await modulePromise;
  status("Kacheln …");
  const data = new PreopenDirectory("/data", new Map([[inputName, new WasiFile(input)]]));
  let pending = "";
  const decoder = new TextDecoder();
  const stderr = new ConsoleStdout((bytes) => {
    pending += decoder.decode(bytes, { stream: true });
    const parts = pending.split(/[\r\n]/);
    pending = parts.pop();
    for (const p of parts) {
      const line = p.trim();
      if (!line) continue;
      const pct = /^(\d+(?:\.\d+)?)%/.exec(line);
      if (pct) postMessage({ type: "progress", pct: Number(pct[1]) });
      else log(line);
    }
  });
  const fds = [new OpenFile(new WasiFile([])), stderr, stderr, data, new PreopenDirectory("/tmp", new Map())];
  const wasi = new WASI(args, [], fds, { debug: false });
  const instance = await WebAssembly.instantiate(module, { wasi_snapshot_preview1: wasi.wasiImport });
  const code = wasi.start(instance);
  if (pending.trim()) log(pending.trim());
  const t2 = performance.now();

  const out = data.dir.contents.get("out.pmtiles");
  if (code !== 0 || !out || out.data.length === 0) {
    throw new Error(`manby hat mit Code ${code} abgebrochen. Die Meldungen stehen im Protokoll.`);
  }
  const pmtiles = out.data.slice();
  postMessage(
    {
      type: "done",
      pmtiles,
      info: { ...info, msStep1: t1 - t0, msTiling: t2 - t1, memory: instance.exports.memory.buffer.byteLength },
    },
    [pmtiles.buffer]
  );
}

onmessage = async (e) => {
  try {
    await tile(e.data);
  } catch (err) {
    postMessage({ type: "error", message: err?.message ?? String(err) });
  }
};
