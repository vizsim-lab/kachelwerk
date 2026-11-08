# MATSim Kachelwerk

Macht aus einem MATSim-Netz Vektorkacheln (PMTiles) und zeigt sie in MapLibre, komplett im
Browser. Ein Server ist nicht nötig, und eigene Dateien verlassen den Rechner nicht.

Die Seite: <https://vizsim-lab.github.io/kachelwerk/>

## Ablauf

1. **Netz:** Ein MATSim-`network.xml` (auch `.xml.gz`) wird im Web Worker zu GeoJSON, `freespeed`
   zusätzlich in km/h. Auskommentierte Knoten und Links bleiben draußen. Das CRS kommt aus dem
   Netz-Attribut `coordinateReferenceSystem`, sonst aus dem Formular. GeoParquet geht unverändert
   an manby, das sein CRS selbst liest. Hier soll später matsim_trace als WASM einsteigen.
2. **Link-Geometrien:** Liegt die Geometrie-Datei dabei (`…-network-linkGeometries.csv`, wie sie
   MATSims SUMO-Konverter schreibt: `LinkId,Geometry` mit `"(x,y),(x,y),…"` im CRS des Netzes),
   bekommen die Links ihren echten Verlauf statt einer geraden Linie. Links ohne Eintrag, etwa die
   pt-Links, bleiben gerade. WKT (`LINESTRING (…)`) geht auch, ebenso `.csv.gz`.
3. **Kacheln:** [manby](https://github.com/birkskyum/manby), eine Rust-Portierung von tippecanoe,
   läuft als WebAssembly mit `-zg --drop-densest-as-needed -s <CRS>` auf einem Thread. Weitere
   tippecanoe-Optionen gehen über das Formular. Ein zweiter Lauf mit anderen Optionen nutzt das
   GeoJSON des ersten.
4. **Ergebnis:** Die PMTiles kommen direkt aus dem Speicher in MapLibre. Gefärbt wird nach
   MATSim-Straßenklassen (30/50/80/120 km/h), ein Klick zeigt die Attribute eines Links. Die
   `.pmtiles` lässt sich speichern.

Netz und Geometrie-Datei lassen sich zusammen auswählen oder hineinziehen; die Geometrie-Datei
kann auch später dazukommen.

## Netze aus dem VSP-SVN

„Aus dem VSP-SVN laden“ blättert durch das öffentliche SVN der VSP an der TU Berlin
(`public-svn/matsim/scenarios/countries/de`). Angezeigt werden nur Ordner, Netze, GeoParquet und
Geometrie-Dateien. Ein Klick auf ein Netz lädt es samt der passenden `linkGeometries`-Datei aus
demselben Ordner und kachelt es.

Danach zeigt die Adresszeile auf genau dieses Netz und lässt sich teilen, zum Beispiel:

<https://vizsim-lab.github.io/kachelwerk/?net=kelheim/kelheim-v3.0/input/kelheim-v3.0-network-with-pt.xml.gz>

- `net`: Pfad unter `countries/de/` oder eine volle Adresse
- `geo`: Geometrie-Datei neben dem Netz oder volle Adresse, `0` für keine; fehlt der Parameter,
  sucht die Seite die passende Datei im Ordner des Netzes
- `crs`: nur nötig, wenn das Netz kein CRS nennt und es nicht EPSG:25832 ist

Andere Server gehen auch, über das Adressfeld im SVN-Bereich, wenn sie den Abruf aus dem Browser
erlauben (CORS).

## Hintergrundkarte

[OpenFreeMap](https://openfreemap.org/) mit den Stilen Positron und Dark, oder keine. Ohne eigene
Wahl richtet sich die Karte nach Hell/Dunkel des Systems; eine Wahl merkt sich der Browser. Das
Netz liegt unter den Beschriftungen, und die Linienfarben passen sich der Karte an.

## Anfragen an andere Server

Bibliotheken und Schriften liegen in `vendor/`. Andere Server fragt die Seite nur an für

- das Beispielnetz (`raw.githubusercontent.com`), wenn kein anderes Netz verlinkt ist,
- die Hintergrundkarte (`tiles.openfreemap.org`), außer bei „Ohne“,
- Netze aus dem VSP-SVN (`svn.vsp.tu-berlin.de`), wenn man sie dort auswählt oder verlinkt.

Eigene Dateien verlassen den Rechner nicht.

## Dateien

- `index.html`: Oberfläche, Karte, SVN-Browser
- `worker.js`: Netz und Geometrien zu GeoJSON, dann manby, beides im Web Worker über einen WASI-Shim
- `manby.wasm`: manby für `wasm32-wasip1`; wie die Datei entsteht, steht in
  [`manby-wasm/`](manby-wasm/README.md)
- `vendor/`: MapLibre GL JS 5.6.0, pmtiles 4.3.0, `@bjorn3/browser_wasi_shim` 0.4.2 und die
  Schriften, jeweils mit Lizenz

## Beispielnetz

Ohne Link lädt die Seite beim Öffnen `network-with-pt.xml.gz` aus
[matsim-libs](https://github.com/matsim-org/matsim-libs/tree/033fd8ba25af5075ed645cb1972aa67873316237/examples/scenarios/kelheim),
fest auf einen Commit. Es ist ein Ausschnitt aus dem
[MATSim-Szenario Kelheim](https://github.com/matsim-scenarios/matsim-kelheim) und steht unter
[CC BY-NC 4.0](https://creativecommons.org/licenses/by-nc/4.0/deed.de). Deshalb liegt es nicht in
diesem Repository.

## Lokal starten

Die Seite muss über HTTP laufen, weil Web Worker und `fetch` mit `file://` nicht gehen:

```sh
python3 -m http.server 8000   # dann http://localhost:8000
```

Für GitHub Pages reicht „Deploy from a branch“ mit `main` und `/ (root)`. `.wasm` wird dort als
`application/wasm` ausgeliefert, besondere Header braucht die Seite nicht.

## Grenzen

- manby läuft auf einem Thread. Kelheim (20.087 Links) braucht rund 2 s, ein Testnetz mit
  400.000 Links und Geometrien rund 45 s bei 275 MiB WASM-Speicher.
- WebAssembly hat höchstens 4 GB Speicher; sehr große Netze passen eventuell nicht.
- Es gibt nur PMTiles-Ausgabe.

## Lizenzen

Für den eigenen Code in diesem Repository ist noch keine Lizenz festgelegt. Die enthaltene
Drittsoftware und ihre Lizenzen stehen in [`THIRD_PARTY_LICENSES.md`](THIRD_PARTY_LICENSES.md):
manby (BSD-2-Clause) mit den Rust-Crates und C-Bibliotheken in `manby.wasm`, dazu MapLibre GL JS,
pmtiles, der WASI-Shim und die Schriften in `vendor/`. Die Karte von OpenFreeMap beruht auf
OpenMapTiles und OpenStreetMap; die Quellen stehen in der Karte unten rechts.
