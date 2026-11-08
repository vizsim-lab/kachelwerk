# MATSim Kachelwerk

Macht aus einem MATSim-Netz Vektorkacheln (PMTiles) und zeigt sie in MapLibre, komplett im
Browser. Ein Server ist nicht nötig, und eigene Dateien verlassen den Rechner nicht.

Die Seite: <https://vizsim-lab.github.io/kachelwerk/>

## Ablauf

1. **Netz:** Ein MATSim-`network.xml` (auch `.xml.gz`) wird im Web Worker zu GeoJSON, `freespeed`
   zusätzlich in km/h. Auskommentierte Knoten und Links bleiben draußen. Das CRS kommt aus dem
   Netz-Attribut `coordinateReferenceSystem`, sonst aus dem Formular. GeoParquet geht unverändert
   an manby, das sein CRS selbst liest. Hier soll später matsim_trace als WASM einsteigen.
2. **Kacheln:** [manby](https://github.com/birkskyum/manby), eine Rust-Portierung von tippecanoe,
   läuft als WebAssembly mit `-zg --drop-densest-as-needed -s <CRS>` auf einem Thread. Weitere
   tippecanoe-Optionen gehen über das Formular.
3. **Ergebnis:** Die PMTiles kommen direkt aus dem Speicher in MapLibre. Gefärbt wird nach
   MATSim-Straßenklassen (30/50/80/120 km/h), ein Klick zeigt die Attribute eines Links. Die
   `.pmtiles` lässt sich speichern.

## Dateien

- `index.html`: Oberfläche und Karte
- `worker.js`: Schritt 1 und 2 im Web Worker, manby läuft dort über einen WASI-Shim
- `manby.wasm`: manby für `wasm32-wasip1`; wie die Datei entsteht, steht in
  [`manby-wasm/`](manby-wasm/README.md)
- `vendor/`: MapLibre GL JS 5.6.0, pmtiles 4.3.0, `@bjorn3/browser_wasi_shim` 0.4.2 und die
  Schriften, jeweils mit Lizenz. Sie liegen hier, damit beim Öffnen keine Anfragen an CDNs oder
  Schriftdienste gehen.

## Beispielnetz

Beim Öffnen lädt die Seite `network-with-pt.xml.gz` aus
[matsim-libs](https://github.com/matsim-org/matsim-libs/tree/033fd8ba25af5075ed645cb1972aa67873316237/examples/scenarios/kelheim),
fest auf einen Commit, von `raw.githubusercontent.com`. Es ist ein Ausschnitt aus dem
[MATSim-Szenario Kelheim](https://github.com/matsim-scenarios/matsim-kelheim) und steht unter
[CC BY-NC 4.0](https://creativecommons.org/licenses/by-nc/4.0/deed.de). Deshalb liegt es nicht in
diesem Repository. Das ist die einzige Anfrage an einen anderen Server.

## Lokal starten

Die Seite muss über HTTP laufen, weil Web Worker und `fetch` mit `file://` nicht gehen:

```sh
python3 -m http.server 8000   # dann http://localhost:8000
```

Für GitHub Pages reicht „Deploy from a branch“ mit `main` und `/ (root)`. `.wasm` wird dort als
`application/wasm` ausgeliefert, besondere Header braucht die Seite nicht.

## Grenzen

- manby läuft auf einem Thread. Kelheim (20.087 Links) braucht damit rund 2 s.
- WebAssembly hat höchstens 4 GB Speicher; sehr große Netze passen eventuell nicht.
- Es gibt nur PMTiles-Ausgabe, und die Karte hat keine Hintergrundkarte.

## Lizenzen

Für den eigenen Code in diesem Repository ist noch keine Lizenz festgelegt. Die enthaltene
Drittsoftware und ihre Lizenzen stehen in [`THIRD_PARTY_LICENSES.md`](THIRD_PARTY_LICENSES.md):
manby (BSD-2-Clause) mit den Rust-Crates und C-Bibliotheken in `manby.wasm`, dazu MapLibre GL JS,
pmtiles, der WASI-Shim und die Schriften in `vendor/`.
