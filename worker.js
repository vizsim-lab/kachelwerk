// MATSim Kachelwerk worker: step 1 (MATSim network XML, optionally with its link geometries file,
// to GeoJSON, when the input is not GeoParquet already) and step 2 (manby.wasm, run through an
// in-memory WASI, to PMTiles). One compiled module, a new instance per run; the GeoJSON of the
// last network stays here, so a second run with other options skips step 1.
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
const de = (n) => n.toLocaleString("de-DE");

/** The text of a file, plain or gzipped, in pieces as they arrive. */
function textReader(bytes) {
  let stream = new Blob([bytes]).stream();
  if (bytes[0] === 0x1f && bytes[1] === 0x8b) stream = stream.pipeThrough(new DecompressionStream("gzip"));
  return stream.pipeThrough(new TextDecoderStream()).getReader();
}

/** Its lines, a batch per piece. */
async function* lineBatches(bytes) {
  const reader = textReader(bytes);
  let rest = "";
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    const text = rest + value;
    const cut = text.lastIndexOf("\n");
    if (cut < 0) {
      rest = text;
      continue;
    }
    yield text.slice(0, cut).split("\n");
    rest = text.slice(cut + 1);
  }
  if (rest) yield [rest];
}

/** One CSV line into fields; quotes may hold the delimiter, "" is a quote. */
function csvFields(line, delim) {
  const out = [];
  let i = 0;
  for (;;) {
    if (line[i] === '"') {
      let value = "";
      let j = i + 1;
      for (;;) {
        const q = line.indexOf('"', j);
        if (q < 0) {
          value += line.slice(j);
          j = line.length;
          break;
        }
        if (line[q + 1] === '"') {
          value += line.slice(j, q + 1);
          j = q + 2;
          continue;
        }
        value += line.slice(j, q);
        j = q + 1;
        break;
      }
      out.push(value);
      const d = line.indexOf(delim, j);
      if (d < 0) return out;
      i = d + 1;
    } else {
      const d = line.indexOf(delim, i);
      if (d < 0) {
        out.push(line.slice(i));
        return out;
      }
      out.push(line.slice(i, d));
      i = d + 1;
    }
  }
}

const NUM = String.raw`[-+]?(?:\d+\.?\d*|\.\d+)(?:[eE][-+]?\d+)?`;
const PAREN_LINE = new RegExp(String.raw`^\(${NUM},${NUM}\)(?:,\(${NUM},${NUM}\))+$`);
const WKT_LINE = /^LINESTRING\s*Z?\s*\(([^()]*)\)$/i;

/** A link geometry as the inside of a GeoJSON coordinates array, or null. */
function coordinates(text) {
  const t = text.trim();
  if (t[0] === "(") {
    // MATSim's SUMO converter: (x,y),(x,y),… in the network's CRS
    const compact = t.replace(/\s+/g, "");
    return PAREN_LINE.test(compact) ? compact.replaceAll("(", "[").replaceAll(")", "]") : null;
  }
  const wkt = WKT_LINE.exec(t);
  if (!wkt) return null;
  const points = wkt[1].split(",").map((p) => p.trim().split(/\s+/).slice(0, 2).map(Number));
  if (points.length < 2 || points.some((p) => p.length < 2 || !p.every(Number.isFinite))) return null;
  return points.map((p) => `[${p[0]},${p[1]}]`).join(",");
}

/** A linkGeometries file (LinkId,Geometry) as a map from link id to coordinates. */
async function readLinkGeometries(bytes) {
  const map = new Map();
  let delim = null;
  let idCol = 0;
  let geomCol = 1;
  let rows = 0;
  let bad = 0;
  for await (const batch of lineBatches(bytes)) {
    for (let line of batch) {
      if (line.endsWith("\r")) line = line.slice(0, -1);
      if (!line) continue;
      if (delim === null) {
        delim = [",", ";", "\t"].reduce((best, d) => (line.split(d).length > line.split(best).length ? d : best), ",");
        const head = csvFields(line, delim).map((h) => h.trim().toLowerCase());
        const g = head.findIndex((h) => /geom|wkt|shape|coord/.test(h));
        const i = head.findIndex((h) => /^(link_?id|id|link)$/.test(h));
        if (g >= 0) {
          geomCol = g;
          idCol = i >= 0 ? i : g === 0 ? 1 : 0;
          continue;
        }
        // no header: the first line is data
      }
      const f = csvFields(line, delim);
      rows++;
      const c = f.length > geomCol ? coordinates(f[geomCol]) : null;
      if (c === null) bad++;
      else map.set(f[idCol], c);
    }
    status(`Link-Geometrien lesen: ${de(rows)} Zeilen …`);
  }
  if (map.size === 0) {
    throw new Error("Die Geometrie-Datei enthält keine lesbaren Geometrien. Erwartet wird eine CSV mit LinkId und Geometry, z. B. „(x,y),(x,y)“.");
  }
  return { map, rows, bad };
}

/** GeoJSON features written in encoded pieces, so that no single huge string is built. */
class FeatureWriter {
  constructor() {
    this.encoder = new TextEncoder();
    this.parts = [];
    this.length = 0;
    this.chunks = [];
    this.bytes = 0;
    this.count = 0;
  }
  add(feature) {
    this.parts.push(feature);
    this.length += feature.length;
    this.count++;
    if (this.length > 1 << 22) this.flush();
  }
  flush() {
    if (!this.parts.length) return;
    const chunk = this.encoder.encode((this.chunks.length ? "," : "") + this.parts.join(","));
    this.chunks.push(chunk);
    this.bytes += chunk.length;
    this.parts = [];
    this.length = 0;
  }
  finish() {
    this.flush();
    const head = this.encoder.encode('{"type":"FeatureCollection","features":[');
    const tail = this.encoder.encode("]}");
    const out = new Uint8Array(head.length + this.bytes + tail.length);
    out.set(head);
    let at = head.length;
    for (const c of this.chunks) {
      out.set(c, at);
      at += c.length;
    }
    out.set(tail, at);
    this.chunks = [];
    return out;
  }
}

const ENTITIES = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'" };
const unescapeXml = (s) =>
  s.includes("&")
    ? s.replace(/&(#x[0-9a-f]+|#\d+|\w+);/gi, (m, e) =>
        e[0] === "#" ? String.fromCodePoint(e[1] === "x" || e[1] === "X" ? parseInt(e.slice(2), 16) : Number(e.slice(1))) : ENTITIES[e] ?? m)
    : s;

// a pt link carries only transit modes; a road that buses also use ("car,pt") is not one
const PT_MODES = new Set(["pt", "bus", "tram", "rail", "train", "subway", "metro", "ferry", "funicular", "gondola", "cablecar", "cable_car", "monorail", "artificial"]);
const isPtLink = (modes) => {
  const list = modes.split(",").map((m) => m.trim().toLowerCase()).filter(Boolean);
  return list.length > 0 && list.every((m) => PT_MODES.has(m));
};

/** Step 1 stand-in: a MATSim network (v1 or v2, plain or gzipped) as GeoJSON bytes. */
async function matsimToGeoJSON(bytes, geometries) {
  const reader = textReader(bytes);
  const tagRe = /<(node|link)\s([^>]*)>/g;
  const attrRe = /([\w:.-]+)="([^"]*)"/g;
  const crsRe = /<attribute\s+name="coordinateReferenceSystem"[^>]*>\s*([^<\s]+)\s*<\/attribute>/;
  const nodes = new Map();
  const out = new FeatureWriter();
  let rest = "";
  let head = "";
  let crs = null;
  let missing = 0;
  let withGeometry = 0;
  let ptLinks = 0;

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
        const x = Number(a.x);
        const y = Number(a.y);
        if (Number.isFinite(x) && Number.isFinite(y)) nodes.set(unescapeXml(a.id), `${x},${y}`);
        continue;
      }
      const id = unescapeXml(a.id ?? "");
      const fromId = unescapeXml(a.from ?? "");
      const toId = unescapeXml(a.to ?? "");
      const from = nodes.get(fromId);
      const to = nodes.get(toId);
      if (!from || !to) {
        missing++;
        continue;
      }
      let coords = geometries?.get(id);
      if (coords) withGeometry++;
      else coords = `[${from}],[${to}]`;
      const freespeed = Number(a.freespeed);
      const modes = unescapeXml(a.modes ?? "");
      const pt = isPtLink(modes);
      if (pt) ptLinks++;
      const properties = JSON.stringify({
        id,
        from: fromId,
        to: toId,
        length: Number(a.length),
        freespeed,
        freespeed_kmh: Math.round(freespeed * 36) / 10,
        capacity: Number(a.capacity),
        permlanes: Number(a.permlanes),
        modes,
        pt,
      });
      out.add(`{"type":"Feature","properties":${properties},"geometry":{"type":"LineString","coordinates":[${coords}]}}`);
      if (out.count % 50000 === 0) status(`MATSim-Netz lesen: ${de(out.count)} Links …`);
    }
    if (done) break;
  }
  if (out.count === 0) {
    throw new Error("In der Datei stehen keine <link>-Elemente. Ist es ein MATSim-Netz (network.xml)?");
  }
  return { bytes: out.finish(), links: out.count, nodes: nodes.size, crs, missing, withGeometry, ptLinks };
}

const EXTENSIONS = { parquet: "parquet", geojson: "geojson", fgb: "fgb", csv: "csv" };

// step 1 of the last MATSim network: { key, input, info }
let prepared = null;

async function prepareMatsim(job) {
  if (prepared?.key === job.key) {
    log(`Schritt 1: GeoJSON aus dem letzten Lauf (${de(prepared.info.links)} Links)`);
    return prepared;
  }
  if (!job.bytes) throw new Error("Die Netzdaten fehlen. Lade das Netz bitte noch einmal.");
  prepared = null; // let the old GeoJSON go before building the new one
  let geometries = null;
  const info = {};
  if (job.geometry) {
    status("Link-Geometrien lesen …");
    const g = await readLinkGeometries(new Uint8Array(job.geometry));
    geometries = g.map;
    Object.assign(info, { geometryRows: g.rows, geometryBad: g.bad });
    log(`Link-Geometrien: ${de(g.map.size)} gelesen` + (g.bad ? `, ${de(g.bad)} Zeilen ohne lesbare Geometrie` : ""));
  }
  status("MATSim-Netz lesen …");
  const g = await matsimToGeoJSON(new Uint8Array(job.bytes), geometries);
  Object.assign(info, { links: g.links, nodes: g.nodes, ptLinks: g.ptLinks, crsFromFile: g.crs, missing: g.missing, withGeometry: geometries ? g.withGeometry : null });
  log(`Schritt 1: ${de(g.links)} Links, ${de(g.nodes)} Knoten` +
    (geometries ? `, ${de(g.withGeometry)} mit Geometrie aus der Datei` : "") +
    (g.ptLinks ? `, ${de(g.ptLinks)} pt-Links` : "") +
    (g.missing ? `, ${de(g.missing)} Links ohne Knoten übersprungen` : "") +
    `, GeoJSON ${de(Math.round(g.bytes.length / 1048576))} MB`);
  prepared = { key: job.key, input: g.bytes, info };
  return prepared;
}

async function tile(job) {
  const t0 = performance.now();
  status("manby laden …");
  const modulePromise = manbyModule();

  let input;
  let inputName;
  let crs = job.crs;
  const info = { kind: job.kind, key: null };
  if (job.kind === "matsim") {
    const p = await prepareMatsim(job);
    input = p.input;
    inputName = "input.geojson";
    Object.assign(info, p.info, { key: p.key });
    if (p.info.crsFromFile) crs = p.info.crsFromFile;
    log(p.info.crsFromFile ? `CRS ${crs} aus der Datei` : `CRS ${crs} aus dem Formular`);
  } else {
    prepared = null;
    input = new Uint8Array(job.bytes);
    if (input[0] === 0x1f && input[1] === 0x8b) {
      status("Datei entpacken …");
      input = new Uint8Array(await new Response(new Blob([input]).stream().pipeThrough(new DecompressionStream("gzip"))).arrayBuffer());
    }
    inputName = `input.${EXTENSIONS[job.kind] ?? "geojson"}`;
  }
  // GeoParquet names its own CRS; -s only applies when it does not
  info.crs = job.kind === "matsim" ? crs : job.kind === "parquet" ? null : crs;
  const t1 = performance.now();

  const args = ["manby", "-l", job.layer, "-n", job.name];
  args.push(job.maxzoom === "auto" ? "-zg" : `-z${job.maxzoom}`);
  if (job.dropDensest) args.push("--drop-densest-as-needed");
  if (crs) args.push("-s", crs);
  args.push(...job.extra, "-o", "/data/out.pmtiles", `/data/${inputName}`);
  log("$ " + args.join(" "));

  const module = await modulePromise;
  status("Kacheln …");
  // a view of the input, not a copy; read-only, so that a run cannot change the cached GeoJSON
  const inputFile = new WasiFile(new ArrayBuffer(0), { readonly: true });
  inputFile.data = input;
  const data = new PreopenDirectory("/data", new Map([[inputName, inputFile]]));
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
  const runner = new WASI(args, [], fds, { debug: false });
  const instance = await WebAssembly.instantiate(module, { wasi_snapshot_preview1: runner.wasiImport });
  const code = runner.start(instance);
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
