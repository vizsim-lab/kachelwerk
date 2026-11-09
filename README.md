# MATSim Kachelwerk

Macht aus einem MATSim-Netz oder anderen Geodaten Vektorkacheln (PMTiles) und zeigt sie in
MapLibre, komplett im Browser. Ein Server ist nicht nötig, und eigene Dateien verlassen den Rechner
nicht.

Die Seite: <https://vizsim-lab.github.io/kachelwerk/>

Oben wählt man, was man kachelt:

- **MATSim-Netz:** `network.xml` (auch `.xml.gz`) oder GeoParquet aus matsim_trace, dazu
  automatisch die Link-Geometrien, Zoomstufen nach Straßenklasse wie in `tile.py` (kein Link fällt
  weg), ein Filter für pt-Links und die Netze aus dem VSP-SVN
- **Geodaten:** GeoJSON (auch zeilenweise), GeoParquet, FlatGeobuf (`.fgb`) oder CSV mit `lon` und
  `lat`, jeweils auch als `.gz`; Punkte, Linien und Flächen

Lädt man eine Datei der anderen Art, wechselt die Seite von selbst.

## Ablauf

1. **Netz:** Ein MATSim-Netz wird im Web Worker zu GeoJSON, gelesen wie in matsim_trace: Jeder Link
   behält seine `<attributes>` (Namen klein geschrieben, `java.lang.Double` und Co. als Zahl,
   `allowed_speed` und die Steigungswerte immer als Zahl). Dazu kommen `freespeed` in km/h und
   das Attribut `pt` (nur Verkehrsmittel des ÖV wie `pt`, `bus`, `rail`; eine Straße mit `car,pt`
   zählt nicht). Auskommentierte Knoten und Links bleiben draußen. Links ohne Ausdehnung, etwa die
   Schleifen an pt-Haltestellen, werden Punkte, damit auch sie in den Kacheln sind. Das CRS kommt
   aus dem Netz-Attribut `coordinateReferenceSystem`, sonst aus dem Formular. Geodaten gehen ohne
   diesen Schritt an manby.
2. **Link-Geometrien:** Den echten Verlauf bekommen die Links aus der Geometrie-Datei
   (`…-network-linkGeometries.csv`, wie sie MATSims SUMO-Konverter schreibt: `LinkId,Geometry` mit
   `"(x,y),(x,y),…"` im CRS des Netzes) oder aus dem Link-Attribut `origgeom` der OSM-Reader; die
   Datei geht vor. Wie in matsim_trace beginnt und endet jeder Link auf seinen Knoten, Punkte der
   Datei, die schon auf einem Knoten liegen, fallen weg, und ein Verlauf, der gegen die
   Link-Richtung läuft (die `*_bike-reverse`-Links), wird umgedreht. Links ohne Eintrag, etwa die
   pt-Links, bleiben gerade. Die Datei kommt automatisch mit:
   - aus dem VSP-SVN: neben dem Netz, bei einem Netz aus `output/` im `input/`-Ordner des Szenarios
   - von der Festplatte: wenn man den ganzen Ordner wählt oder hineinzieht, oder Netz und
     Geometrie-Datei zusammen; liegen mehrere Netze im Ordner, fragt die Seite nach
   WKT (`LINESTRING (…)`) und `.csv.gz` gehen auch.
3. **Kacheln:** [manby](https://github.com/birkskyum/manby), eine Rust-Portierung von tippecanoe,
   läuft als WebAssembly auf einem Thread. Für ein Netz staffelt es die Links nach Straßenklasse,
   siehe unten; Geodaten (und ein Netz ohne Staffelung) bekommen `-zg --drop-densest-as-needed`.
   Weitere tippecanoe-Optionen gehen über das Formular. Ein zweiter Lauf mit anderen Optionen
   oder Zoomstufen nutzt das GeoJSON des ersten.
4. **Ergebnis:** Die PMTiles kommen direkt aus dem Speicher in MapLibre. Gefärbt wird nach einem
   Zahlen-Attribut, bei MATSim nach Straßenklassen (30/50/80/120 km/h). pt-Links lassen sich
   ausblenden oder allein zeigen; das ist ein Filter der Karte, die PMTiles enthalten alle Links
   samt Attribut `pt`. Ein Klick zeigt die Attribute, die `.pmtiles` lässt sich speichern.

## Zoomstufen nach Straßenklasse

Ein großes Netz wie Berlin (rund 485.000 Links) passt in den niedrigen Zoomstufen nicht in
tippecanoes Größenlimits: Ohne `--drop-densest-as-needed` kommt manby nur bis Zoomstufe 4, mit
fehlen Links. Wie in `tile.py` mit freestiler wird deshalb jede Straßenklasse ein eigener Layer,
der erst ab seiner Zoomstufe in den Kacheln liegt:

| Layer | Links | ab Zoom |
| --- | --- | --- |
| `motorway` | `type` motorway, trunk | 4 |
| `main` | `type` primary, secondary, tertiary | 8 |
| `bike` | `bicycle_infra` hat einen Wert; schlägt die Straßenklasse | 9 |
| `pt` | nur Verkehrsmittel des ÖV | 10 |
| `minor_car` | übrige Links für Autos (`has_car`, sonst `car` in `modes`) | 11 |
| `minor_path` | alle übrigen | 12 |

`type` wird wie in `tile.py` auf den OSM-Wert gebracht (`highway.service|psv` → `service`);
`*_link`-Typen wie `motorway_link` sind Nebenstraßen. Den `pt`-Layer gibt es in `tile.py` nicht.
Die Zoomstufen lassen sich im Formular ändern. manby läuft dann mit

```sh
manby -Z4 --smallest-maximum-zoom-guess=13 --no-feature-limit --no-tile-size-limit \
  -j '{"motorway":[">=","$zoom",4],"main":[">=","$zoom",8],…}' …
```

Es gibt keine Größenlimits, und die höchste Zoomstufe ist mindestens 13, wie in `tile.py`: Dort
ist eine Kachel-Einheit kleiner als ein Meter, sodass auch sehr kurze Links Linien bleiben. Bei
einer festen höchsten Zoomstufe gelten Klassen darüber ab dieser Stufe. Jeder Link liegt so in der
obersten Zoomstufe; dafür werden die Kacheln in den mittleren Stufen groß (siehe Grenzen).
GeoParquet liest manby selbst; dort wirkt dieselbe Staffelung als Filter auf einen Layer, und ein
`type` mit Zusatz hinter `|` zählt als Nebenstraße. Beim Klick zeigt das Popup den Layer.

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
- `staffel`: `0` ohne Staffelung, sonst sechs Zoomstufen in der Reihenfolge `motorway`, `main`,
  `bike`, `pt`, `minor_car`, `minor_path`, etwa `4,8,9,10,11,12`; fehlt er, gelten diese
- `data`: statt `net` für Geodaten
- `crs`: nur nötig, wenn die Datei kein CRS nennt und es nicht dem Standard entspricht

Andere Server gehen auch, über das Adressfeld im SVN-Bereich, wenn sie den Abruf aus dem Browser
erlauben (CORS).

## Hintergrundkarte

[OpenFreeMap](https://openfreemap.org/) mit den Stilen Positron und Dark, oder keine. Ohne eigene
Wahl richtet sich die Karte nach Hell/Dunkel des Systems; eine Wahl merkt sich der Browser, ebenso
die Staffelung. Die
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

- manby läuft auf einem Thread. Kelheim (20.087 Links) braucht rund 3 s. Ein Testnetz in Berlins
  Größe (482.088 Links aus 24 überlagerten Kopien von Kelheim) braucht gestaffelt rund 60 s, bei
  380 MiB WASM-Speicher.
- Gestaffelt fällt nichts weg, deshalb werden die Kacheln dichter Netze in den mittleren
  Zoomstufen groß: im Testnetz bis 12 MB (entpackt) mit 138.000 Links in einer Kachel bei z10 und
  z11. Die Karte braucht dort einige Sekunden. Setzt eine Klasse später ein (etwa Hauptstraßen ab
  z9), verteilen sich ihre Links auf viermal so viele Kacheln.
- WebAssembly hat höchstens 4 GB Speicher; sehr große Dateien passen eventuell nicht.
- Es gibt nur PMTiles-Ausgabe. Shapefiles liest manby nicht.

## Lizenzen

Für den eigenen Code in diesem Repository ist noch keine Lizenz festgelegt. Die enthaltene
Drittsoftware und ihre Lizenzen stehen in [`THIRD_PARTY_LICENSES.md`](THIRD_PARTY_LICENSES.md):
manby (BSD-2-Clause) mit den Rust-Crates und C-Bibliotheken in `manby.wasm`, dazu MapLibre GL JS,
pmtiles, der WASI-Shim und die Schriften in `vendor/`. Die Karte von OpenFreeMap beruht auf
OpenMapTiles und OpenStreetMap; die Quellen stehen in der Karte unten rechts.
