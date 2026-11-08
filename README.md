# MATSim Kachelwerk

Macht aus einem MATSim-Netz oder anderen Geodaten Vektorkacheln (PMTiles) und zeigt sie in
MapLibre, komplett im Browser. Ein Server ist nicht nötig, und eigene Dateien verlassen den Rechner
nicht.

Die Seite: <https://vizsim-lab.github.io/kachelwerk/>

Oben wählt man, was man kachelt:

- **MATSim-Netz:** `network.xml` (auch `.xml.gz`) oder GeoParquet aus matsim_trace, dazu
  automatisch die Link-Geometrien, ein Filter für pt-Links und die Netze aus dem VSP-SVN
- **Geodaten:** GeoJSON (auch zeilenweise), GeoParquet, FlatGeobuf (`.fgb`) oder CSV mit `lon` und
  `lat`, jeweils auch als `.gz`; Punkte, Linien und Flächen

Lädt man eine Datei der anderen Art, wechselt die Seite von selbst.

## Ablauf

1. **Netz:** Ein MATSim-Netz wird im Web Worker zu GeoJSON, `freespeed` zusätzlich in km/h, und jeder
   Link bekommt das Attribut `pt` (nur Verkehrsmittel des ÖV wie `pt`, `bus`, `rail`; eine Straße
   mit `car,pt` zählt nicht). Auskommentierte Knoten und Links bleiben draußen. Das CRS kommt aus
   dem Netz-Attribut `coordinateReferenceSystem`, sonst aus dem Formular. Hier soll später
   matsim_trace als WASM einsteigen. Geodaten gehen ohne diesen Schritt an manby.
2. **Link-Geometrien:** Die Geometrie-Datei (`…-network-linkGeometries.csv`, wie sie MATSims
   SUMO-Konverter schreibt: `LinkId,Geometry` mit `"(x,y),(x,y),…"` im CRS des Netzes) gibt den
   Links ihren echten Verlauf. Links ohne Eintrag, etwa die pt-Links, bleiben gerade. Sie kommt
   automatisch mit:
   - aus dem VSP-SVN: neben dem Netz, bei einem Netz aus `output/` im `input/`-Ordner des Szenarios
   - von der Festplatte: wenn man den ganzen Ordner wählt oder hineinzieht, oder Netz und
     Geometrie-Datei zusammen; liegen mehrere Netze im Ordner, fragt die Seite nach
   WKT (`LINESTRING (…)`) und `.csv.gz` gehen auch.
3. **Kacheln:** [manby](https://github.com/birkskyum/manby), eine Rust-Portierung von tippecanoe,
   läuft als WebAssembly mit `-zg --drop-densest-as-needed` auf einem Thread. Weitere
   tippecanoe-Optionen gehen über das Formular. Ein zweiter Lauf mit anderen Optionen nutzt das
   GeoJSON des ersten.
4. **Ergebnis:** Die PMTiles kommen direkt aus dem Speicher in MapLibre. Gefärbt wird nach einem
   Zahlen-Attribut, bei MATSim nach Straßenklassen (30/50/80/120 km/h). pt-Links lassen sich
   ausblenden oder allein zeigen; das ist ein Filter der Karte, die PMTiles enthalten alle Links
   samt Attribut `pt`. Ein Klick zeigt die Attribute, die `.pmtiles` lässt sich speichern.

## Daten aus dem VSP-SVN

„Aus dem VSP-SVN laden“ blättert durch das öffentliche SVN der VSP an der TU Berlin
(`public-svn/matsim/scenarios/countries/de`). Angezeigt werden nur Ordner und Dateien, die zur
gewählten Art passen. Ein Klick lädt die Datei und kachelt sie.

Danach zeigt die Adresszeile auf genau diese Datei und lässt sich teilen, zum Beispiel:

<https://vizsim-lab.github.io/kachelwerk/?net=kelheim/kelheim-v3.0/input/kelheim-v3.0-network-with-pt.xml.gz>

- `net`: ein Netz, als Pfad unter `countries/de/` oder volle Adresse
- `geo`: die Geometrie-Datei, vom Ordner des Netzes aus oder als volle Adresse, `0` für keine;
  fehlt der Parameter, sucht die Seite selbst
- `pt`: `ohne` oder `nur`
- `data`: statt `net` für Geodaten
- `crs`: nur nötig, wenn die Datei kein CRS nennt und es nicht dem Standard entspricht

Andere Server gehen auch, über das Adressfeld im SVN-Bereich, wenn sie den Abruf aus dem Browser
erlauben (CORS).

## Hintergrundkarte

[OpenFreeMap](https://openfreemap.org/) mit den Stilen Positron und Dark, oder keine. Ohne eigene
Wahl richtet sich die Karte nach Hell/Dunkel des Systems; eine Wahl merkt sich der Browser. Die
Daten liegen unter den Beschriftungen, und die Farben passen sich der Karte an.

## Anfragen an andere Server

Bibliotheken und Schriften liegen in `vendor/`. Andere Server fragt die Seite nur an für

- das Beispielnetz (`raw.githubusercontent.com`), wenn kein anderes Netz verlinkt ist und die
  Seite auf „MATSim-Netz“ steht,
- die Hintergrundkarte (`tiles.openfreemap.org`), außer bei „Ohne“,
- Dateien aus dem VSP-SVN (`svn.vsp.tu-berlin.de`), wenn man sie dort auswählt oder verlinkt.

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
diesem Repository. Steht die Seite zuletzt auf „Geodaten“, lädt sie kein Beispiel.

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
- WebAssembly hat höchstens 4 GB Speicher; sehr große Dateien passen eventuell nicht.
- Es gibt nur PMTiles-Ausgabe. Shapefiles liest manby nicht.

## Lizenzen

Für den eigenen Code in diesem Repository ist noch keine Lizenz festgelegt. Die enthaltene
Drittsoftware und ihre Lizenzen stehen in [`THIRD_PARTY_LICENSES.md`](THIRD_PARTY_LICENSES.md):
manby (BSD-2-Clause) mit den Rust-Crates und C-Bibliotheken in `manby.wasm`, dazu MapLibre GL JS,
pmtiles, der WASI-Shim und die Schriften in `vendor/`. Die Karte von OpenFreeMap beruht auf
OpenMapTiles und OpenStreetMap; die Quellen stehen in der Karte unten rechts.
