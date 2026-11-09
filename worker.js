// MATSim Kachelwerk worker: step 1 (a MATSim network, optionally with its link geometries file, to
// GeoJSON) and step 2 (manby.wasm, run through an in-memory WASI, to PMTiles). One compiled
// module, a new instance per run; the GeoJSON of the last network stays here, so a second run
// with other options skips step 1.
//
// Reading the network follows matsim_trace: every link attribute is kept, true geometries come
// from the linkGeometries CSV (SUMO reader) or the origgeom attribute (OSM readers), and a link
// always starts and ends on its nodes. The road classes for the zoom staggering follow tile.py.
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

// ---------- road classes, as in tile.py ----------
// a pt link carries only transit modes; a road that buses also use ("car,pt") is not one
const PT_MODES = new Set(["pt", "bus", "tram", "rail", "train", "subway", "metro", "ferry", "funicular", "gondola", "cablecar", "cable_car", "monorail", "artificial"]);
const isPtLink = (modes) => {
  const list = modes.split(",").map((m) => m.trim().toLowerCase()).filter(Boolean);
  return list.length > 0 && list.every((m) => PT_MODES.has(m));
};
const BIG = new Set(["motorway", "trunk"]);
const MID = new Set(["primary", "secondary", "tertiary"]);
const NO_VALUE = new Set(["", "none", "nan", "null", "na", "<na>", "-"]);
const TRUTHY = new Set(["true", "1", "t", "yes", "y"]);
const hasValue = (v) => v !== undefined && v !== null && !NO_VALUE.has(String(v).trim().toLowerCase());
/** 'highway.service|psv' (SUMO reader) and 'service' (OSM) are the same class. */
const normalizeType = (t) => String(t).trim().toLowerCase().split("|")[0].trim().replace(/^highway\./, "");
// the layers from bottom to top; the map draws them in this order
const CLASSES = ["minor_path", "minor_car", "pt", "bike", "main", "motorway"];

/** Radinfrastruktur beats the road class; then motorway, main, pt, and the minor roads by car access. */
function roadClass(type, modes, extra, pt) {
  if (hasValue(extra.bicycle_infra)) return "bike";
  const t = type ? normalizeType(type) : "";
  if (BIG.has(t)) return "motorway";
  if (MID.has(t)) return "main";
  if (pt) return "pt";
  const car = extra.has_car !== undefined ? TRUTHY.has(String(extra.has_car).trim().toLowerCase()) : /(^|[,\s])car([,\s]|$)/i.test(modes);
  return car ? "minor_car" : "minor_path";
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

/** Step 1 stand-in: a MATSim network (v1 or v2, plain or gzipped) as GeoJSON bytes. */
async function matsimToGeoJSON(bytes, geometries, stagger) {
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
  const stats = { missing: 0, points: 0, withGeometry: 0, fromCsv: 0, fromOrigGeom: 0, csvMatched: 0, ptLinks: 0, typed: 0, collisions: new Set(), classes: {}, bigBike: 0, midBike: 0, carLink: 0, bikeLink: 0 };
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

    let tippecanoe = "";
    if (stagger) {
      const cls = roadClass(type, modes, extra, pt);
      stats.classes[cls] = (stats.classes[cls] ?? 0) + 1;
      if (cls === "bike" && type) {
        const t = normalizeType(type);
        if (BIG.has(t)) stats.bigBike++;
        else if (MID.has(t)) stats.midBike++;
      }
      tippecanoe = `,"tippecanoe":{"layer":"${cls}"}`;
    }
    const geometry = linkGeometry(from[0], from[1], to[0], to[1], shape);
    if (geometry.startsWith('{"type":"Point"')) stats.points++;
    out.add(`{"type":"Feature"${tippecanoe},"properties":${JSON.stringify(props)},"geometry":${geometry}}`);
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
  return { bytes: out.finish(), links: out.count, nodes: nodes.size, crs, stats };
}

// ---------- zoom staggering ----------
/** -j for the layers of step 1: a class appears from its zoom on. */
function layerFilter(zooms) {
  const f = {};
  for (const cls of CLASSES) f[cls] = [">=", "$zoom", zooms[cls]];
  return JSON.stringify(f);
}

/** -j for GeoParquet (e.g. from matsim_trace), whose features cannot be split into layers: the same zooms on one layer. */
function parquetFilter(zooms) {
  const empty = ["", "NONE", "None", "none", "nan", "NaN", "null", "NA", "<NA>", "-"];
  const bike = ["all", ["has", "bicycle_infra"], ["!in", "bicycle_infra", ...empty]];
  const noBike = ["any", ["!has", "bicycle_infra"], ["in", "bicycle_infra", ...empty]];
  // "has" first: manby warns about every comparison with an attribute a feature lacks
  const types = (list) => ["all", ["has", "type"], ["in", "type", ...list.flatMap((t) => [t, `highway.${t}`])]];
  const from = (cls) => [">=", "$zoom", zooms[cls]];
  return JSON.stringify({
    "*": ["any",
      from("minor_path"),
      ["all", from("motorway"), types([...BIG]), noBike],
      ["all", from("main"), types([...MID]), noBike],
      ["all", from("bike"), bike],
      ["all", from("pt"), ["has", "modes"], ["==", "modes", "pt"]],
      // without has_car every minor road counts as one for cars
      ["all", from("minor_car"), ["any", ["!has", "has_car"], ["in", "has_car", true, "true", "1", "t", "yes", "y"]]],
    ],
  });
}

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
    Object.assign(info, { geometryRows: g.rows });
    log(`Link-Geometrien: ${de(g.rows)} Zeilen` + (g.invalid ? `, ${de(g.invalid)} ohne lesbare Geometrie` : ""));
  }
  status("MATSim-Netz lesen …");
  const g = await matsimToGeoJSON(new Uint8Array(job.bytes), geometries, Boolean(job.stagger));
  const s = g.stats;
  Object.assign(info, {
    links: g.links,
    nodes: g.nodes,
    ptLinks: s.ptLinks,
    crsFromFile: g.crs,
    missing: s.missing,
    points: s.points,
    typed: s.typed,
    withGeometry: geometries || s.fromOrigGeom ? s.withGeometry : null,
    classes: job.stagger ? s.classes : null,
    csvMatched: geometries ? s.csvMatched : null,
  });
  log(`Schritt 1: ${de(g.links)} Links, ${de(g.nodes)} Knoten` +
    (s.ptLinks ? `, ${de(s.ptLinks)} pt-Links` : "") +
    (s.missing ? `, ${de(s.missing)} Links ohne Knoten übersprungen` : "") +
    `, GeoJSON ${de(Math.round(g.bytes.length / 1048576))} MB`);
  if (geometries) {
    log(`Geometrie-CSV: ${de(s.csvMatched)} Zeilen passen zu einem Link, ${de(info.geometryRows - s.csvMatched)} ohne Link; ` +
      `${de(s.fromCsv)} Links bekommen ihren Verlauf (die übrigen sind schon gerade)`);
  }
  if (s.fromOrigGeom) log(`origgeom: ${de(s.fromOrigGeom)} Links bekommen ihren Verlauf aus dem Attribut`);
  if (s.points) log(`${de(s.points)} Links ohne Ausdehnung (Anfang und Ende am selben Ort, etwa die Schleifen an pt-Haltestellen) als Punkt`);
  if (s.collisions.size) log(`Link-Attribute übersprungen, weil sie mit festen Spalten kollidieren: ${[...s.collisions].join(", ")}`);
  if (job.stagger) {
    log("Klassen: " + CLASSES.slice().reverse().filter((c) => s.classes[c]).map((c) => `${c} ${de(s.classes[c])}`).join(", "));
    if (!s.typed) log("Warnung: Kein Link hat das Attribut type. Alle Links gelten als Nebenstraße oder Weg (Layer motorway und main bleiben leer).");
    if (s.bigBike) log(`${de(s.bigBike)} Links der Klasse motorway/trunk haben Radinfrastruktur und liegen deshalb in bike`);
    if (s.midBike) log(`${de(s.midBike)} Links der Klasse primary/secondary/tertiary haben Radinfrastruktur und liegen deshalb in bike`);
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

  const args = ["manby", "-n", job.name];
  const zooms = job.stagger;
  if (zooms) {
    // every link stays: the classes come in by zoom, and no size limit makes manby drop or give up
    const fixed = job.maxzoom === "auto" ? null : Number(job.maxzoom);
    const z = {};
    for (const cls of CLASSES) z[cls] = fixed === null ? zooms[cls] : Math.min(zooms[cls], fixed);
    const lowest = Math.min(...CLASSES.map((c) => z[c]));
    const highest = Math.max(...CLASSES.map((c) => z[c]));
    // at z13 a tile unit is under a metre in Germany, fine enough that even short links stay lines
    // (z13 is also tile.py's default)
    if (fixed === null) args.push(`--smallest-maximum-zoom-guess=${Math.max(highest, 13)}`);
    else args.push(`-z${fixed}`);
    args.push(`-Z${lowest}`, "--no-feature-limit", "--no-tile-size-limit");
    if (job.kind === "matsim") args.push("-j", layerFilter(z));
    else args.push("-l", job.layer, "-j", parquetFilter(z));
    if (fixed !== null && CLASSES.some((c) => zooms[c] > fixed)) {
      log(`Zoomstufen über ${fixed} gelten als ${fixed}, damit kein Link fehlt`);
    }
    info.stagger = z;
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
