// MATSim Kachelwerk worker: step 1 (a MATSim network, optionally with its link geometries file, to
// GeoJSON) and step 2 (manby.wasm, run through an in-memory WASI, to PMTiles). One compiled
// module, a new instance per run; the GeoJSON of the last network stays here, so a second run
// with other options skips step 1.
//
// Reading the network follows matsim_trace: every link attribute is kept, true geometries come
// from the linkGeometries CSV (SUMO reader) or the origgeom attribute (OSM readers), and a link
// always starts and ends on its nodes. GeoParquet (as matsim_trace writes it) is read here too,
// with hyparquet, when its links go into layers. The layers come from the page's rules, the first
// that matches wins; tile.py's road classes are the preset.
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

/** One CSV record into fields; quotes may hold the delimiter, "" is a quote. */
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

/** Points of a geometry cell as [x0, y0, x1, y1, …]: "(x,y),(x,y)" from the SUMO reader, WKT, or "x y, x y". */
function parseGeometry(raw) {
  let t = raw.trim();
  const wkt = /^LINESTRING\s*Z?\s*\((.*)\)$/is.exec(t);
  if (wkt) t = wkt[1];
  const out = [];
  if (!wkt && t.includes("(")) {
    for (const group of t.split("(").slice(1)) {
      const [x, y, extra] = group.split(")")[0].split(",");
      if (extra !== undefined) continue;
      const px = Number(x);
      const py = Number(y);
      if (Number.isFinite(px) && Number.isFinite(py) && x.trim() && y?.trim()) out.push(px, py);
    }
    return out;
  }
  for (const token of t.split(",")) {
    const [x, y] = token.trim().split(/\s+/);
    const px = Number(x);
    const py = Number(y);
    if (x && y && Number.isFinite(px) && Number.isFinite(py)) out.push(px, py);
  }
  return out;
}

/** A linkGeometries file (LinkId,Geometry) as a map from link id to its points. */
async function readLinkGeometries(bytes) {
  const map = new Map();
  let delim = null;
  let idCol = 0;
  let geomCol = 1;
  let rows = 0;
  let invalid = 0;
  let record = "";
  for await (const batch of lineBatches(bytes)) {
    for (let line of batch) {
      if (line.endsWith("\r")) line = line.slice(0, -1);
      // a quoted cell may span lines
      record = record ? `${record}\n${line}` : line;
      if ((record.split('"').length - 1) % 2 === 1) continue;
      const text = record;
      record = "";
      if (!text) continue;
      if (delim === null) {
        delim = [",", ";", "\t"].reduce((best, d) => (text.split(d).length > text.split(best).length ? d : best), ",");
        const head = csvFields(text, delim).map((h) => h.trim().toLowerCase());
        const g = head.findIndex((h) => /geom|wkt|shape|coord/.test(h));
        const i = head.findIndex((h) => /^(link_?id|id|link)$/.test(h));
        if (g >= 0) {
          geomCol = g;
          idCol = i >= 0 ? i : g === 0 ? 1 : 0;
          continue;
        }
        // no header: the first line is data
      }
      const f = csvFields(text, delim);
      const id = f[idCol]?.trim();
      const points = f.length > geomCol ? parseGeometry(f[geomCol]) : [];
      if (!id || points.length < 4) {
        invalid++;
        continue;
      }
      rows++;
      map.set(id, Float64Array.from(points));
    }
    status(`Link-Geometrien lesen: ${de(rows)} Zeilen …`);
  }
  if (map.size === 0) {
    throw new Error("Die Geometrie-Datei enthält keine lesbaren Geometrien. Erwartet wird eine CSV mit LinkId und Geometry, z. B. „(x,y),(x,y)“.");
  }
  return { map, rows, invalid };
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

// ---------- layers: rules, the first that matches wins ----------
// a pt link carries only transit modes; a road that buses also use ("car,pt") is not one
const PT_MODES = new Set(["pt", "bus", "tram", "rail", "train", "subway", "metro", "ferry", "funicular", "gondola", "cablecar", "cable_car", "monorail", "artificial"]);
const isPtLink = (modes) => {
  const list = modes.split(",").map((m) => m.trim().toLowerCase()).filter(Boolean);
  return list.length > 0 && list.every((m) => PT_MODES.has(m));
};
const NO_VALUE = new Set(["", "none", "nan", "null", "na", "<na>", "-"]);
const TRUTHY = new Set(["true", "1", "t", "yes", "y"]);
const hasValue = (v) => v !== undefined && v !== null && !NO_VALUE.has(String(v).trim().toLowerCase());
/** 'highway.service|psv' (SUMO reader) and 'service' (OSM) are the same type, as in tile.py. */
const normalizeType = (t) => String(t).trim().toLowerCase().split("|")[0].trim().replace(/^highway\./, "");
const normText = (v) => String(v).trim().toLowerCase();
const asNumber = (v) => (typeof v === "number" ? v : typeof v === "string" && v.trim() !== "" ? Number(v) : NaN);

/**
 * The page's rules as a function from a link's properties to its layer: { name, attr, op, values }
 * with op in (one of the values), contains (a value in a list like modes), has (any value), true,
 * gte, lte (against the first value) or rest. type compares as in tile.py, everything else
 * without case. A link no rule takes goes to the last layer.
 */
function classifier(rules) {
  const tests = rules.map(({ name, attr, op, values = [] }) => {
    const norm = attr === "type" ? normalizeType : normText;
    const set = new Set(values.map(norm));
    const limit = asNumber(values[0]);
    const test = {
      in: (p) => p[attr] != null && set.has(norm(p[attr])),
      contains: (p) => p[attr] != null && String(p[attr]).split(/[,;\s]+/).some((t) => t && set.has(norm(t))),
      has: (p) => hasValue(p[attr]),
      true: (p) => p[attr] === true || p[attr] === 1 || (typeof p[attr] === "string" && TRUTHY.has(normText(p[attr]))),
      gte: (p) => asNumber(p[attr]) >= limit,
      lte: (p) => asNumber(p[attr]) <= limit,
    }[op] ?? (() => true);
    return [name, test];
  });
  const last = rules[rules.length - 1].name;
  return (p) => {
    for (const [name, test] of tests) if (test(p)) return name;
    return last;
  };
}

// ---------- what is in the network, for the page's rule editor ----------
const CATALOG_SKIP = new Set(["id", "from", "to", "link_id", "from_node", "to_node"]);
const MAX_VALUES = 300; // more distinct values (names, lengths) are not offered as choices

/** Per attribute: on how many links, whether it is a number, its range, and its values (type as tile.py sees it) and list entries with counts. */
class Catalog {
  constructor() {
    this.attrs = new Map();
  }
  add(props) {
    for (const k in props) {
      const v = props[k];
      if (v === undefined || v === null || v === "") continue;
      let a = this.attrs.get(k);
      if (!a) {
        a = { n: 0, numbers: 0, min: Infinity, max: -Infinity, values: CATALOG_SKIP.has(k) ? null : new Map(), tokens: CATALOG_SKIP.has(k) ? null : new Map(), lists: 0 };
        this.attrs.set(k, a);
      }
      a.n++;
      if (typeof v === "number") {
        a.numbers++;
        if (v < a.min) a.min = v;
        if (v > a.max) a.max = v;
      }
      if (a.values) {
        const key = k === "type" ? normalizeType(v) : typeof v === "string" ? v.trim() : String(v);
        a.values.set(key, (a.values.get(key) ?? 0) + 1);
        if (a.values.size > MAX_VALUES) a.values = null;
      }
      if (a.tokens && typeof v === "string" && /[,;]/.test(v)) {
        a.lists++;
        for (const t of v.split(/[,;]+/)) {
          const key = normText(t);
          if (key) a.tokens.set(key, (a.tokens.get(key) ?? 0) + 1);
        }
        if (a.tokens.size > MAX_VALUES) a.tokens = null;
      }
    }
  }
  toJSON() {
    const top = (m) => (m ? [...m].sort((x, y) => y[1] - x[1]).slice(0, 60) : null);
    return [...this.attrs].map(([name, a]) => ({
      name,
      n: a.n,
      numeric: a.numbers === a.n,
      min: a.numbers ? a.min : null,
      max: a.numbers ? a.max : null,
      values: top(a.values),
      // entries of comma lists like modes, for "contains"
      tokens: a.lists ? top(a.tokens) : null,
    })).sort((x, y) => y.n - x.n);
  }
}

// ---------- link geometry, as in matsim_trace ----------
const SAME_POINT_M = 1e-3; // the CSV rounds to 1e-6 m, the network keeps full precision
const same = (ax, ay, bx, by) => Math.abs(ax - bx) <= SAME_POINT_M && Math.abs(ay - by) <= SAME_POINT_M;
const dist = (ax, ay, bx, by) => Math.hypot(ax - bx, ay - by);

/** The points between the nodes: CSV points without repeats and without ends that sit on a node. */
function innerPoints(points, fx, fy, tx, ty) {
  const shape = [];
  for (let i = 0; i + 1 < points.length; i += 2) {
    const n = shape.length;
    if (n && same(shape[n - 2], shape[n - 1], points[i], points[i + 1])) continue;
    shape.push(points[i], points[i + 1]);
  }
  const onNode = (x, y) => same(x, y, fx, fy) || same(x, y, tx, ty);
  if (shape.length && onNode(shape[0], shape[1])) shape.splice(0, 2);
  if (shape.length && onNode(shape[shape.length - 2], shape[shape.length - 1])) shape.splice(-2, 2);
  return shape;
}

/** origgeom: "nodeId,x,y nodeId,x,y …", the OSM nodes simplification dropped, without the link's own nodes. */
function origGeomPoints(raw) {
  const out = [];
  for (const token of raw.trim().split(/\s+/)) {
    const parts = token.split(",");
    if (parts.length !== 3) continue;
    const x = Number(parts[1]);
    const y = Number(parts[2]);
    if (parts[1] && parts[2] && Number.isFinite(x) && Number.isFinite(y)) out.push(x, y);
  }
  return out;
}

// metres to the centimetre, degrees to 1e-7; manby reprojects and quantizes anyway
const coord = (v) => (Math.abs(v) > 1000 ? Math.round(v * 100) / 100 : Math.round(v * 1e7) / 1e7);

/**
 * The link as a GeoJSON geometry: from-node, the inner points (turned round when they run against
 * the link) and to-node. A link without extent, like the loop at a pt stop, becomes a point, so
 * that it is in the tiles as well; a line of length 0 would not be.
 */
function linkGeometry(fx, fy, tx, ty, shape) {
  const parts = [];
  let lx = NaN;
  let ly = NaN;
  const push = (x, y) => {
    const cx = coord(x);
    const cy = coord(y);
    if (cx === lx && cy === ly) return;
    parts.push(`[${cx},${cy}]`);
    lx = cx;
    ly = cy;
  };
  push(fx, fy);
  const n = shape.length;
  if (n) {
    // MATSim's OsmBicycleReader copies origgeom onto the *_bike-reverse links unchanged
    const reversed = dist(shape[0], shape[1], tx, ty) + dist(shape[n - 2], shape[n - 1], fx, fy) <
      dist(shape[0], shape[1], fx, fy) + dist(shape[n - 2], shape[n - 1], tx, ty);
    if (reversed) for (let i = n - 2; i >= 0; i -= 2) push(shape[i], shape[i + 1]);
    else for (let i = 0; i < n; i += 2) push(shape[i], shape[i + 1]);
  }
  push(tx, ty);
  return parts.length >= 2 ? `{"type":"LineString","coordinates":[${parts.join(",")}]}` : `{"type":"Point","coordinates":${parts[0]}}`;
}

// ---------- the network ----------
const NUMERIC_CLASS = /^java\.lang\.(Double|Float|Integer|Long|Short)$/;
// matsim_trace types these as numbers whatever class they were written with
const NUMERIC_EXTRAS = new Set(["allowed_speed", "averageelevation", "elevationgain", "elevationloss", "gradient", "maxgradient"]);
const RESERVED = new Set(["id", "from", "to", "length", "freespeed", "freespeed_kmh", "capacity", "permlanes", "modes", "pt", "type"]);

function attributeValue(name, cls, raw) {
  const text = unescapeXml(raw).trim();
  if ((cls && NUMERIC_CLASS.test(cls)) || NUMERIC_EXTRAS.has(name)) {
    const n = Number(text);
    return text && text.toLowerCase() !== "nan" && Number.isFinite(n) ? n : undefined;
  }
  if (cls === "java.lang.Boolean") return text === "true";
  return text || undefined;
}

/** Step 1: a MATSim network (v1 or v2, plain or gzipped) as GeoJSON bytes, each link in the layer its rules give. */
async function matsimToGeoJSON(bytes, geometries, rules) {
  const reader = textReader(bytes);
  const tagRe = /<(\/?)(node|link|attribute)\b([^>]*)>/g;
  const attrRe = /([\w:.-]+)="([^"]*)"/g;
  const crsRe = /<attribute\s+name="coordinateReferenceSystem"[^>]*>\s*([^<\s]+)\s*<\/attribute>/;
  const parseAttrs = (s) => {
    const a = {};
    attrRe.lastIndex = 0;
    let m;
    while ((m = attrRe.exec(s))) a[m[1]] = m[2];
    return a;
  };
  const nodes = new Map();
  const out = new FeatureWriter();
  const catalog = new Catalog();
  const classify = rules ? classifier(rules) : null;
  const stats = { missing: 0, points: 0, withGeometry: 0, fromCsv: 0, fromOrigGeom: 0, csvMatched: 0, ptLinks: 0, typed: 0, collisions: new Set(), layers: {}, carLink: 0, bikeLink: 0 };
  let rest = "";
  let head = "";
  let crs = null;
  let link = null; // the open <link>, until </link>
  let attr = null; // the open <attribute> of that link: { name, cls, text }

  function finishLink(l) {
    const id = unescapeXml(l.a.id ?? "");
    const fromId = unescapeXml(l.a.from ?? "");
    const toId = unescapeXml(l.a.to ?? "");
    const from = nodes.get(fromId);
    const to = nodes.get(toId);
    if (!from || !to) {
      stats.missing++;
      return;
    }
    const extra = l.extra;
    const modes = unescapeXml(l.a.modes ?? "");
    const pt = isPtLink(modes);
    if (pt) stats.ptLinks++;
    const type = l.a.type !== undefined ? unescapeXml(l.a.type) : extra.type ?? extra["osm:way:highway"];
    if (type !== undefined) stats.typed++;

    // geometry: the CSV wins over origgeom, as in matsim_trace
    let shape = [];
    const csv = geometries?.get(id);
    if (csv) {
      stats.csvMatched++;
      shape = innerPoints(csv, from[0], from[1], to[0], to[1]);
      if (shape.length) stats.fromCsv++;
    }
    const orig = extra.origgeom;
    delete extra.origgeom;
    if (!shape.length && typeof orig === "string") {
      shape = origGeomPoints(orig);
      if (shape.length) stats.fromOrigGeom++;
    }
    if (shape.length) stats.withGeometry++;

    const freespeed = Number(l.a.freespeed);
    const props = {
      id,
      from: fromId,
      to: toId,
      length: Number(l.a.length),
      freespeed,
      freespeed_kmh: Math.round(freespeed * 36) / 10,
      capacity: Number(l.a.capacity),
      permlanes: Number(l.a.permlanes),
      modes,
      pt,
    };
    if (type !== undefined) props.type = type;
    for (const [k, v] of Object.entries(extra)) {
      if (RESERVED.has(k)) {
        if (k !== "type") stats.collisions.add(k);
        continue;
      }
      if (v !== undefined) props[k] = v;
    }
    if (hasValue(extra.car_link)) stats.carLink++;
    if (hasValue(extra.bike_link)) stats.bikeLink++;

    catalog.add(props);
    const geometry = linkGeometry(from[0], from[1], to[0], to[1], shape);
    if (geometry.startsWith('{"type":"Point"')) stats.points++;
    out.add(feature(props, geometry, classify, stats));
    if (out.count % 50000 === 0) status(`MATSim-Netz lesen: ${de(out.count)} Links …`);
  }

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
    let at = 0;
    let m;
    while ((m = tagRe.exec(chunk))) {
      if (attr) attr.text += chunk.slice(at, m.index);
      at = m.index + m[0].length;
      const [, closing, tag, body] = m;
      const selfClosing = body.endsWith("/");
      if (tag === "node") {
        if (closing || link) continue;
        const a = parseAttrs(body);
        const x = Number(a.x);
        const y = Number(a.y);
        if (Number.isFinite(x) && Number.isFinite(y)) nodes.set(unescapeXml(a.id), [x, y]);
      } else if (tag === "link") {
        if (closing) {
          if (link) finishLink(link);
          link = null;
          attr = null;
        } else {
          const l = { a: parseAttrs(body), extra: {} };
          if (selfClosing) finishLink(l);
          else link = l;
        }
      } else if (link) {
        // <attribute> of the open link; those of nodes and of the network are not needed
        if (closing) {
          if (attr) {
            const v = attributeValue(attr.name, attr.cls, attr.text.replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, "$1"));
            if (v !== undefined) link.extra[attr.name] = v;
          }
          attr = null;
        } else {
          const a = parseAttrs(body);
          if (!a.name) continue;
          const name = unescapeXml(a.name).toLowerCase();
          if (selfClosing) {
            const v = attributeValue(name, a.class, a.value ?? "");
            if (v !== undefined) link.extra[name] = v;
          } else {
            attr = { name, cls: a.class, text: "" };
          }
        }
      }
    }
    if (attr) attr.text += chunk.slice(at);
    if (done) break;
  }
  if (out.count === 0) {
    throw new Error("In der Datei stehen keine <link>-Elemente. Ist es ein MATSim-Netz (network.xml)?");
  }
  return { bytes: out.finish(), links: out.count, nodes: nodes.size, crs, stats, catalog: catalog.toJSON() };
}

/** One GeoJSON feature, put into its layer when there are rules. */
function feature(props, geometry, classify, stats) {
  let tippecanoe = "";
  if (classify) {
    const layer = classify(props);
    stats.layers[layer] = (stats.layers[layer] ?? 0) + 1;
    tippecanoe = `,"tippecanoe":{"layer":${JSON.stringify(layer)}}`;
  }
  return `{"type":"Feature"${tippecanoe},"properties":${JSON.stringify(props)},"geometry":${geometry}}`;
}

// ---------- GeoParquet, read here so that its links go into layers too ----------
let parquetLib;
/** hyparquet and the decompressors it does not bring itself (it has snappy; no brotli); loaded the first time they are needed. */
function parquetModules() {
  parquetLib ??= Promise.all([
    import("./vendor/hyparquet/index.js"), // hyparquet 1.31.5
    import("./vendor/hyparquet-compressors/gzip.js"), // hyparquet-compressors 1.1.2
    import("./vendor/hyparquet-compressors/lz4.js"),
    import("./vendor/fzstd/fzstd.js"), // fzstd 0.1.1
  ]).then(([hp, gzip, lz4, zstd]) => ({
    ...hp,
    compressors: {
      GZIP: (input, length) => gzip.gunzip(input, new Uint8Array(length)),
      LZ4: lz4.decompressLz4,
      LZ4_RAW: lz4.decompressLz4Raw,
      ZSTD: (input, length) => zstd.decompress(input, new Uint8Array(length)),
    },
  }));
  parquetLib.catch(() => (parquetLib = undefined));
  return parquetLib;
}

/** The CRS of a GeoParquet column as manby's -s: missing means CRS84, null means unknown. */
function geoParquetCrs(crs) {
  if (crs === undefined) return "EPSG:4326";
  if (crs === null) return null;
  if (typeof crs === "string") return /^(OGC:)?CRS84$/i.test(crs) ? "EPSG:4326" : crs;
  const id = crs.id ?? crs.ids?.[0];
  if (!id) return null;
  if (/^OGC$/i.test(id.authority) && /^CRS84$/i.test(String(id.code))) return "EPSG:4326";
  return `${id.authority}:${id.code}`;
}

/** A Parquet value as a GeoJSON property; undefined drops it. */
function plain(v) {
  if (v === null || v === undefined) return undefined;
  if (typeof v === "bigint") return Number(v);
  if (typeof v === "number" || typeof v === "string" || typeof v === "boolean") return v;
  if (v instanceof Date) return v.toISOString();
  if (Array.isArray(v)) return v.map((x) => plain(x) ?? "").join(","); // lists, as tile.py makes them
  if (ArrayBuffer.isView(v)) return undefined;
  return JSON.stringify(v, (k, x) => (typeof x === "bigint" ? Number(x) : x));
}

/** A GeoJSON geometry from hyparquet, rounded like the network's; a line without extent becomes a point. */
function geometryJson(g) {
  const pt = (c) => `[${coord(c[0])},${coord(c[1])}]`;
  const line = (cs) => {
    const parts = [];
    let last = "";
    for (const c of cs) {
      const q = pt(c);
      if (q !== last) parts.push(q);
      last = q;
    }
    return parts;
  };
  const ring = (cs) => `[${cs.map(pt).join(",")}]`;
  switch (g?.type) {
    case "Point":
      return `{"type":"Point","coordinates":${pt(g.coordinates)}}`;
    case "MultiPoint":
      return `{"type":"MultiPoint","coordinates":[${g.coordinates.map(pt).join(",")}]}`;
    case "LineString": {
      const parts = line(g.coordinates);
      if (parts.length >= 2) return `{"type":"LineString","coordinates":[${parts.join(",")}]}`;
      return parts.length ? `{"type":"Point","coordinates":${parts[0]}}` : null;
    }
    case "MultiLineString": {
      const lines = g.coordinates.map(line).filter((l) => l.length >= 2);
      if (lines.length) return `{"type":"MultiLineString","coordinates":[${lines.map((l) => `[${l.join(",")}]`).join(",")}]}`;
      const first = g.coordinates.flat()[0];
      return first ? `{"type":"Point","coordinates":${pt(first)}}` : null;
    }
    case "Polygon":
      return `{"type":"Polygon","coordinates":[${g.coordinates.map(ring).join(",")}]}`;
    case "MultiPolygon":
      return `{"type":"MultiPolygon","coordinates":[${g.coordinates.map((poly) => `[${poly.map(ring).join(",")}]`).join(",")}]}`;
    default:
      return null;
  }
}

/** Step 1 for GeoParquet: its rows as GeoJSON, with pt and freespeed_kmh as for a MATSim network. */
async function parquetToGeoJSON(bytes, rules) {
  status("GeoParquet lesen …");
  const { parquetMetadata, parquetRead, compressors } = await parquetModules();
  const file = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
  const metadata = parquetMetadata(file);
  const geo = JSON.parse(metadata.key_value_metadata?.find((kv) => kv.key === "geo")?.value ?? "null");
  const column = geo?.primary_column;
  if (!column || !geo.columns?.[column]) {
    throw new Error("Die Parquet-Datei hat keine GeoParquet-Metadaten (geo). Ohne sie weiß die Seite nicht, wo die Geometrie steht.");
  }
  const encoding = geo.columns[column].encoding;
  if (encoding !== "WKB") throw new Error(`Die Geometrie ist als ${encoding} gespeichert; die Seite liest nur WKB.`);
  const crs = geoParquetCrs(geo.columns[column].crs);

  const out = new FeatureWriter();
  const catalog = new Catalog();
  const classify = rules ? classifier(rules) : null;
  const stats = { missing: 0, points: 0, ptLinks: 0, typed: 0, layers: {}, carLink: 0, bikeLink: 0, collisions: new Set() };
  const total = Number(metadata.num_rows);
  let start = 0;
  for (const group of metadata.row_groups) {
    const n = Number(group.num_rows);
    const columns = new Map();
    try {
      await parquetRead({
        file,
        metadata,
        compressors,
        rowStart: start,
        rowEnd: start + n,
        onChunk: ({ columnName, columnData, rowStart }) => {
          let col = columns.get(columnName);
          if (!col) columns.set(columnName, (col = new Array(n)));
          for (let i = 0; i < columnData.length; i++) col[rowStart - start + i] = columnData[i];
        },
      });
    } catch (err) {
      const codec = /compress|codec|unsupported/i.test(err?.message ?? "") ? " Diese Kompression kann die Seite nicht entpacken." : "";
      throw new Error(`Die GeoParquet-Datei ließ sich nicht lesen: ${err?.message ?? err}.${codec} Im Modus Geodaten liest manby sie selbst, als einen Layer.`);
    }
    const cols = [...columns];
    for (let r = 0; r < n; r++) {
      const props = {};
      let geometry = null;
      for (const [name, values] of cols) {
        if (name === column) geometry = values[r];
        else {
          const v = plain(values[r]);
          if (v !== undefined) props[name] = v;
        }
      }
      // as for MATSim-XML: pt from the modes, the speed in km/h too
      if (props.pt === undefined && typeof props.modes === "string") props.pt = isPtLink(props.modes);
      if (props.pt === true) stats.ptLinks++;
      const speed = asNumber(props.freespeed ?? props.free_speed_mps);
      if (props.freespeed_kmh === undefined && Number.isFinite(speed)) props.freespeed_kmh = Math.round(speed * 36) / 10;
      if (props.type !== undefined) stats.typed++;
      if (hasValue(props.car_link)) stats.carLink++;
      if (hasValue(props.bike_link)) stats.bikeLink++;
      const g = geometryJson(geometry);
      if (!g) {
        stats.missing++;
        continue;
      }
      if (geometry.type !== "Point" && g.startsWith('{"type":"Point"')) stats.points++;
      catalog.add(props);
      out.add(feature(props, g, classify, stats));
      if (out.count % 50000 === 0) status(`GeoParquet lesen: ${de(out.count)} von ${de(total)} Zeilen …`);
    }
    start += n;
  }
  if (out.count === 0) throw new Error("In der GeoParquet-Datei steht keine lesbare Geometrie.");
  return { bytes: out.finish(), links: out.count, nodes: null, crs, crsMissing: crs === null, stats, catalog: catalog.toJSON() };
}

// ---------- layers in the tiles ----------
/** -j: every layer appears from its zoom on. */
function layerFilter(layers) {
  const f = {};
  for (const l of layers) f[l.name] = [">=", "$zoom", l.zoom];
  return JSON.stringify(f);
}

// step 1 of the last network: { key, input, info }
let prepared = null;

/** Step 1 for a MATSim network or a GeoParquet of one, kept for the next run with the same key. */
async function prepareNetwork(job) {
  if (prepared?.key === job.key) {
    log(`Schritt 1: GeoJSON aus dem letzten Lauf (${de(prepared.info.links)} Links)`);
    return prepared;
  }
  if (!job.bytes) throw new Error("Die Netzdaten fehlen. Lade das Netz bitte noch einmal.");
  prepared = null; // let the old GeoJSON go before building the new one
  const rules = job.layers;
  const info = {};
  let geometries = null;
  let g;
  if (job.kind === "parquet") {
    g = await parquetToGeoJSON(new Uint8Array(job.bytes), rules);
  } else {
    if (job.geometry) {
      status("Link-Geometrien lesen …");
      const r = await readLinkGeometries(new Uint8Array(job.geometry));
      geometries = r.map;
      Object.assign(info, { geometryRows: r.rows });
      log(`Link-Geometrien: ${de(r.rows)} Zeilen` + (r.invalid ? `, ${de(r.invalid)} ohne lesbare Geometrie` : ""));
    }
    status("MATSim-Netz lesen …");
    g = await matsimToGeoJSON(new Uint8Array(job.bytes), geometries, rules);
  }
  const s = g.stats;
  Object.assign(info, {
    links: g.links,
    nodes: g.nodes,
    ptLinks: s.ptLinks,
    crsFromFile: g.crs,
    missing: s.missing,
    points: s.points,
    withGeometry: geometries || s.fromOrigGeom ? s.withGeometry : null,
    csvMatched: geometries ? s.csvMatched : null,
    layerCounts: rules ? s.layers : null,
    catalog: g.catalog,
  });
  const mb = `GeoJSON ${de(Math.round(g.bytes.length / 1048576))} MB`;
  if (job.kind === "parquet") {
    log(`Schritt 1: ${de(g.links)} Zeilen aus GeoParquet` + (s.ptLinks ? `, ${de(s.ptLinks)} pt-Links` : "") +
      (s.missing ? `, ${de(s.missing)} ohne Geometrie übersprungen` : "") + `, ${mb}`);
    if (g.crsMissing) log("Die GeoParquet-Datei nennt kein CRS; es gilt das aus dem Formular");
  } else {
    log(`Schritt 1: ${de(g.links)} Links, ${de(g.nodes)} Knoten` +
      (s.ptLinks ? `, ${de(s.ptLinks)} pt-Links` : "") +
      (s.missing ? `, ${de(s.missing)} Links ohne Knoten übersprungen` : "") + `, ${mb}`);
  }
  if (geometries) {
    log(`Geometrie-CSV: ${de(s.csvMatched)} Zeilen passen zu einem Link, ${de(info.geometryRows - s.csvMatched)} ohne Link; ` +
      `${de(s.fromCsv)} Links bekommen ihren Verlauf (die übrigen sind schon gerade)`);
  }
  if (s.fromOrigGeom) log(`origgeom: ${de(s.fromOrigGeom)} Links bekommen ihren Verlauf aus dem Attribut`);
  if (s.points) log(`${de(s.points)} Links ohne Ausdehnung (Anfang und Ende am selben Ort, etwa die Schleifen an pt-Haltestellen) als Punkt`);
  if (s.collisions.size) log(`Link-Attribute übersprungen, weil sie mit festen Spalten kollidieren: ${[...s.collisions].join(", ")}`);
  if (rules) {
    log("Layer: " + rules.map((r) => `${r.name} ${de(s.layers[r.name] ?? 0)}`).join(", "));
    const known = new Set(g.catalog.map((a) => a.name));
    for (const r of rules) {
      if (r.op !== "rest" && r.attr && !known.has(r.attr)) log(`Kein Link hat das Attribut ${r.attr}; über diese Regel bekommt der Layer ${r.name} nichts.`);
    }
  }
  if (s.carLink || s.bikeLink) log(`Split-Link-Paarung: ${de(s.carLink)} Rad-Zwillinge (car_link), ${de(s.bikeLink)} Fahrbahnen mit Zwilling (bike_link)`);
  prepared = { key: job.key, input: g.bytes, info };
  return prepared;
}

const EXTENSIONS = { parquet: "parquet", geojson: "geojson", fgb: "fgb", csv: "csv" };

async function tile(job) {
  const t0 = performance.now();
  status("manby laden …");
  const modulePromise = manbyModule();

  let input;
  let inputName;
  let crs = job.crs;
  const info = { kind: job.kind, key: null };
  // a network goes through step 1; so does GeoParquet when its links go into layers
  const network = job.kind === "matsim" || (job.kind === "parquet" && Boolean(job.layers));
  if (network) {
    const p = await prepareNetwork(job);
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
  // GeoParquet read by manby names its own CRS; WGS84 is no reprojection worth a mention
  info.crs = (network || job.kind !== "parquet") && crs && !/^EPSG:4326$/i.test(crs) ? crs : null;
  const t1 = performance.now();

  const args = ["manby", "-n", job.name];
  if (network && job.layers) {
    // every link stays: the layers come in by zoom, and no size limit makes manby drop or give up
    const fixed = job.maxzoom === "auto" ? null : Number(job.maxzoom);
    const layers = job.layers.map((l) => ({ name: l.name, zoom: fixed === null ? l.zoom : Math.min(l.zoom, fixed) }));
    const zooms = layers.map((l) => l.zoom);
    // at z13 a tile unit is under a metre in Germany, fine enough that even short links stay lines
    // (z13 is also tile.py's default)
    if (fixed === null) args.push(`--smallest-maximum-zoom-guess=${Math.max(...zooms, 13)}`);
    else args.push(`-z${fixed}`);
    args.push(`-Z${Math.min(...zooms)}`, "--no-feature-limit", "--no-tile-size-limit", "-j", layerFilter(layers));
    if (fixed !== null && job.layers.some((l) => l.zoom > fixed)) {
      log(`Zoomstufen über ${fixed} gelten als ${fixed}, damit kein Link fehlt`);
    }
    info.layers = layers.map((l) => ({ ...l, n: info.layerCounts?.[l.name] ?? 0 }));
  } else {
    args.push("-l", job.layer, job.maxzoom === "auto" ? "-zg" : `-z${job.maxzoom}`);
    if (job.dropDensest) args.push("--drop-densest-as-needed");
  }
  if (crs) args.push("-s", crs);
  args.push(...job.extra, "-o", "/data/out.pmtiles", `/data/${inputName}`);
  log("$ " + args.map((a) => (/[\s"{}[\]$]/.test(a) ? `'${a}'` : a)).join(" "));

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
