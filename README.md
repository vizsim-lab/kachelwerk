# MATSim Kachelwerk

Macht aus einem MATSim-Netz oder anderen Geodaten Vektorkacheln (PMTiles) und zeigt sie in
MapLibre, komplett im Browser. Ein Server ist nicht nötig, und eigene Dateien verlassen den Rechner
nicht.

Die Seite: <https://vizsim-lab.github.io/kachelwerk/>

Oben wählt man, was man kachelt:

- **MATSim-Netz:** `network.xml` (auch `.xml.gz`) oder GeoParquet aus matsim_trace, dazu
  automatisch die Link-Geometrien, eigene Layer mit Regeln, Zoomstufen und Farben (Vorgabe wie
  in `tile.py`, kein Link fällt weg), ein Filter für pt-Links und die Netze aus dem VSP-SVN
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
   aus dem Netz-Attribut `coordinateReferenceSystem`, sonst aus dem Formular. Ein GeoParquet-Netz
   liest die Seite dafür selbst (mit [hyparquet](https://github.com/hyparam/hyparquet)), damit
   seine Links in dieselben Layer kommen; `pt` und `freespeed_kmh` bekommt es wie ein XML-Netz.
   Geodaten gehen ohne diesen Schritt an manby.
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
   läuft als WebAssembly auf einem Thread. Für ein Netz kommen die Links in Layer, die ab ihrer
   Zoomstufe in den Kacheln liegen, siehe unten; Geodaten (und ein Netz ohne Layer) bekommen
   `-zg --drop-densest-as-needed`. Weitere tippecanoe-Optionen gehen über das Formular. Ein
   zweiter Lauf mit anderen Optionen oder Zoomstufen nutzt das GeoJSON des ersten.
4. **Ergebnis:** Die PMTiles kommen direkt aus dem Speicher in MapLibre. Gefärbt wird nach Layer
   oder nach einem Zahlen-Attribut, bei MATSim nach Straßenklassen (30/50/80/120 km/h). pt-Links
   lassen sich ausblenden oder allein zeigen; das ist ein Filter der Karte, die PMTiles enthalten
   alle Links samt Attribut `pt`. Ein Klick zeigt die Attribute und den Layer, die `.pmtiles` lässt
   sich speichern.

## Layer und Zoomstufen

Ein großes Netz wie Berlin (rund 485.000 Links) passt in den niedrigen Zoomstufen nicht in
tippecanoes Größenlimits: Ohne `--drop-densest-as-needed` kommt manby nur bis Zoomstufe 4, mit
fehlen Links. Wie in `tile.py` mit freestiler kommen die Links deshalb in Layer, die erst ab ihrer
Zoomstufe in den Kacheln liegen. Die Layer stellt man in Schritt 2 selbst ein:

- **Regel:** ein Attribut und eine Bedingung: *ist einer von*, *enthält* (ein Eintrag einer Liste
  wie `modes`), *hat einen Wert*, *ist wahr*, *mindestens*, *höchstens*. Ein Link kommt in den
  ersten Layer, dessen Regel passt; der letzte Layer nimmt alle übrigen. Nach dem ersten Kacheln
  stehen die Attribute des Netzes zur Auswahl und ihre Werte mit Anzahl zum Anklicken.
- **Zoomstufe:** ab wann der Layer in den Kacheln liegt.
- **Farbe, Breite, gestrichelt:** wirken sofort in der Karte, ohne neu zu kacheln.
- Layer anlegen, umbenennen, verschieben, entfernen (mit Rückgängig); „Vorgabe aus tile.py“ holt
  die Vorgabe zurück. Bis zu acht Layer.

Die Vorgabe sind die Klassen aus `tile.py`, dazu ein Layer für pt:

| Layer | Regel | ab Zoom | Farbe |
| --- | --- | --- | --- |
| `bike` | `bicycle_infra` hat einen Wert (schlägt die Straßenklasse) | 9 | Türkis |
| `motorway` | `type` ist motorway, trunk | 4 | Blau |
| `main` | `type` ist primary, secondary, tertiary | 8 | Orange |
| `pt` | `pt` ist wahr (nur Verkehrsmittel des ÖV) | 10 | Dunkelgrau, gestrichelt |
| `minor_car` | `modes` enthält car | 11 | Grau |
| `minor_path` | alle übrigen | 12 | Hellgrau |

`type` wird wie in `tile.py` auf den OSM-Wert gebracht (`highway.service|psv` → `service`), andere
Werte ohne Groß- und Kleinschreibung verglichen; `*_link`-Typen wie `motorway_link` sind in der
Vorgabe Nebenstraßen. Anders als `tile.py` schaut die Vorgabe für Autos nur auf `modes`, nicht auf
`has_car`; wer `has_car` hat, stellt die Regel auf „`has_car` ist wahr“. Die drei Farben der
großen Klassen bleiben auch bei Farbfehlsichtigkeit unterscheidbar, wenn sie aneinanderstoßen;
pt unterscheiden die Striche, die Nebenstraßen Grau und Breite.

manby läuft dann mit

```sh
manby -Z4 --smallest-maximum-zoom-guess=13 --no-feature-limit --no-tile-size-limit \
  -j '{"bike":[">=","$zoom",9],"motorway":[">=","$zoom",4],…}' …
```

Es gibt keine Größenlimits, und die höchste Zoomstufe ist mindestens 13, wie in `tile.py`: Dort
ist eine Kachel-Einheit kleiner als ein Meter, sodass auch sehr kurze Links Linien bleiben. Bei
einer festen höchsten Zoomstufe gelten Layer darüber ab dieser Stufe. Jeder Link liegt so in der
obersten Zoomstufe; dafür werden die Kacheln in den mittleren Stufen groß (siehe Grenzen). Andere
Zoomstufen nutzen das GeoJSON des letzten Laufs, andere Regeln brauchen Schritt 1 neu.

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
- `layer`: die Layer, wenn sie von der Vorgabe abweichen, je Layer
  `Name:Zoom:Attribut:Bedingung:Werte:Farbe:Breite:gestrichelt`, getrennt durch `;`, etwa
  `wohnstrasse:13:type:in:residential:violet:1:0`; fehlt er, gilt die Vorgabe
- `staffel`: `0` für einen einzigen Layer ohne Staffelung (die ältere Form mit sechs Zoomstufen,
  etwa `4,8,9,10,11,12`, geht weiter)
- `data`: statt `net` für Geodaten
- `crs`: nur nötig, wenn die Datei kein CRS nennt und es nicht dem Standard entspricht

Andere Server gehen auch, über das Adressfeld im SVN-Bereich, wenn sie den Abruf aus dem Browser
erlauben (CORS).

## Hintergrundkarte

[OpenFreeMap](https://openfreemap.org/) mit den Stilen Positron und Dark, oder keine. Ohne eigene
Wahl richtet sich die Karte nach Hell/Dunkel des Systems; eine Wahl merkt sich der Browser, ebenso
die Layer. Die Daten liegen unter den Beschriftungen, und die Farben passen sich der Karte an: Die
Layerfarben aus der Auswahl haben je eine helle und eine dunkle Stufe, eigene Farben bleiben, wie
sie sind.

## Anfragen an andere Server

Bibliotheken und Schriften liegen in `vendor/`. Andere Server fragt die Seite nur an für

- das Beispielnetz (`raw.githubusercontent.com`), wenn kein anderes Netz verlinkt ist und die
  Seite auf „MATSim-Netz“ steht,
- die Hintergrundkarte (`tiles.openfreemap.org`), außer bei „Ohne“,
- Dateien aus dem VSP-SVN (`svn.vsp.tu-berlin.de`), wenn man sie dort auswählt oder verlinkt.

Eigene Dateien verlassen den Rechner nicht.

## Dateien

- `index.html`: Oberfläche, Karte, SVN-Browser
- `worker.js`: Netz und Geometrien zu GeoJSON, die Links in ihre Layer, dann manby, alles im Web
  Worker über einen WASI-Shim
- `manby.wasm`: manby für `wasm32-wasip1`; wie die Datei entsteht, steht in
  [`manby-wasm/`](manby-wasm/README.md)
- `vendor/`: MapLibre GL JS 5.6.0, pmtiles 4.3.0, `@bjorn3/browser_wasi_shim` 0.4.2, hyparquet
  1.31.5 mit den Entpackern aus hyparquet-compressors 1.1.2 und fzstd 0.1.1 (lädt der Worker nur
  für GeoParquet-Netze) und die Schriften, jeweils mit Lizenz

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
  z11. Die Karte braucht dort einige Sekunden. Setzt ein Layer später ein (etwa Hauptstraßen ab
  z9), verteilen sich seine Links auf viermal so viele Kacheln.
- GeoParquet-Netze liest die Seite mit WKB-Geometrie, unkomprimiert oder mit Snappy, Gzip, Zstd
  oder LZ4; Brotli und GeoArrow-Geometrie nicht. Im Modus Geodaten liest manby die Datei selbst.
- WebAssembly hat höchstens 4 GB Speicher; sehr große Dateien passen eventuell nicht.
- Es gibt nur PMTiles-Ausgabe. Shapefiles liest manby nicht.

## Lizenzen

Für den eigenen Code in diesem Repository ist noch keine Lizenz festgelegt. Die enthaltene
Drittsoftware und ihre Lizenzen stehen in [`THIRD_PARTY_LICENSES.md`](THIRD_PARTY_LICENSES.md):
manby (BSD-2-Clause) mit den Rust-Crates und C-Bibliotheken in `manby.wasm`, dazu MapLibre GL JS,
pmtiles, der WASI-Shim, hyparquet und die Schriften in `vendor/`. Die Karte von OpenFreeMap beruht auf
OpenMapTiles und OpenStreetMap; die Quellen stehen in der Karte unten rechts.
