# manby.wasm

`manby.wasm` im Hauptordner ist [manby](https://github.com/birkskyum/manby) `main` @ `aebebd3`
(v0.1.9) mit den drei Patches aus `patches/`, gebaut für `wasm32-wasip1` und mit `llvm-strip`
ohne Debuginfo.

SHA-256: `5aaa01fffd753c30a688b60b1430261bdee3dec4d856897d7690e258716d079f`

## Patches

Die Patches sind für `git am` auf manby `aebebd3` gedacht. Der native Build bleibt dabei
unverändert, abgesehen vom Bugfix in 0001.

1. **0001 `fix(ingest)`**: GeoParquet, dessen CRS nur in den `geo`-Metadaten steht (so sieht es die
   GeoParquet-Spezifikation vor), wurde nicht umprojiziert. Die Koordinaten wurden als Lon/Lat
   gelesen, und die Features fielen aus der Welt. Das betrifft auch den **nativen** Build.
   Ursache: Das Schema des Readers verliert nach der Spaltenprojektion die Metadaten. manbys eigener
   Test lief nur durch, weil die Fixture das CRS zusätzlich als GeoArrow-Extension trägt.
   Der Patch enthält einen neuen Test, der ohne den Fix fehlschlägt.
2. **0002 `fix(tiler)`**: tippecanoes Größenlimits werden in `usize` hochgerechnet. Mit 32 Bit
   (WASM) läuft das über, und das 500-KB-Limit schrumpft auf wenige Bytes. Jetzt wird in `u64`
   gerechnet; bei 64 Bit ändert sich nichts.
3. **0003 `feat`**: Build für `wasm32-wasip1`. Er enthält:
   - Ersatz für die Unix-Traits (`pread`/`pwrite`)
   - Stubs für alles, was WASI nicht hat: `fork`/`exec`-Filter, Signale, `rlimit`, `statfs`, `dup`,
     `mmap`
   - `mkstemp` in Rust
   - jemalloc nur nativ
   - einen Single-Thread-Pfad: Die Pools sind der aufrufende Thread, und der Koordinator arbeitet
     die Tasks selbst ab
   - GeoParquet wird unter WASI in den Speicher gelesen

0001 und 0002 taugen als eigene Upstream-PRs.

Mit den Patches laufen alle Integrationstests von manby nativ durch, und von den 93 Unit-Tests
92. Der eine, der scheitert (`compress::tests::bound_is_zlibs_own`), vergleicht manbys
zlib-Formel mit der gelinkten zlib. In der Testumgebung linkte der native Build aber zlib-ng 2.3.3
statt der Original-zlib. zlib-ng gibt für 17 Bytes eine Schranke von 43 statt 42 Bytes an; die
Original-zlib 1.3 kommt auf 42, wie manbys Formel. Der Fehler hängt also nicht an den Patches.

## Getestet

Der Weg MATSim-Netz → GeoParquet → PMTiles, WASM gegen den nativen Build:

| Netz | Links | CRS | Optionen | Tiles inhaltlich identisch |
|---|---|---|---|---|
| Kelheim (matsim-libs) | 20.087 | EPSG:25832 | `-zg --drop-densest-as-needed` | 39 / 39 |
| Kelheim | 20.087 | EPSG:25832 | `-z14 --drop-densest-as-needed` | 701 / 701 |
| Berlin (matsim-libs, alt) | 27.664 | EPSG:31468 | `-zg --drop-densest-as-needed` | 17 / 17 |

- Baut man den nativen Build gegen dieselbe zlib (`LIBZ_SYS_STATIC=1`), sind die Tiles Byte für
  Byte gleich. Gegen zlib-ng weichen nur die gzip-Bytes einiger großer Tiles ab; entpackt sind auch
  sie gleich.
- Laufzeit Kelheim `-z14`: WASM rund 1,6–2 s auf einem Thread, nativ 0,7 s auf 2 Kernen. Der
  Speicher bleibt bei rund 34 MiB.
- Größe: 9,8 MB, mit gzip 3,0 MB, mit brotli 2,2 MB.
- Gelaufen ist manby.wasm mit Nodes WASI, mit dem Browser-Shim
  [`@bjorn3/browser_wasi_shim`](https://www.npmjs.com/package/@bjorn3/browser_wasi_shim) 0.4.2 in
  Node und in Chromium, dort über `../worker.js`.

## Bauen

Der übliche Weg, mit rustup-Target und [wasi-sdk](https://github.com/WebAssembly/wasi-sdk/releases)
für die C-Bibliotheken (zlib, libdeflate, zstd, SQLite). So ist er nicht ausprobiert:

```sh
git clone https://github.com/birkskyum/manby && cd manby
git switch -c wasm aebebd3
git am /pfad/zu/kachelwerk/manby-wasm/patches/*.patch
rustup target add wasm32-wasip1
WASI_SDK=/opt/wasi-sdk /pfad/zu/kachelwerk/manby-wasm/tools/build-wasi.sh
llvm-strip -o manby.wasm target/wasm32-wasip1/release/manby.wasm
```

So ist die beiliegende Datei entstanden: Ubuntu 24.04, Rust 1.97.0 ohne rustup-Target, std aus
`rust-src` gebaut, C-Bibliotheken mit dem System-clang gegen Ubuntus `wasi-libc`
(0.0~git20230113.4362b18-3). Diese wasi-libc ist älter als 2024 und hat keine pthread-Stubs, dafür
gibt es `tools/pthread_stub.c`.

```sh
sudo apt install clang lld llvm wasi-libc libclang-rt-18-dev-wasm32
# Die Ubuntu-Pakete nutzen noch den alten Target-Namen wasm32-wasi
sudo ln -s wasm32-wasi /usr/include/wasm32-wasip1
sudo ln -s wasm32-wasi /usr/lib/wasm32-wasip1
sudo ln -s wasi /usr/lib/llvm-18/lib/clang/18/lib/wasip1
# CRT und libc als "self-contained"-Teil des Rust-Targets
S="$(rustc --print sysroot)/lib/rustlib/wasm32-wasip1/lib/self-contained"
mkdir -p "$S" && ln -s /usr/lib/wasm32-wasi/* "$S/"
rustup component add rust-src
BUILD_STD=1 /pfad/zu/kachelwerk/manby-wasm/tools/build-wasi.sh
llvm-strip -o manby.wasm target/wasm32-wasip1/release/manby.wasm
```

Das Skript legt `pthread_stub.o` und `libwasi_pthread_stub.a` neben sich ab.

## Grenzen

- Es läuft nur ein Thread. Mehr Threads gingen nur über `wasm32-wasip1-threads` mit
  SharedArrayBuffer, wofür COOP/COEP-Header nötig sind. GitHub Pages setzt die nicht.
- WASM hat höchstens 4 GB Speicher, und `--memory-budget` kann nicht auf Platte auslagern.
- Die Filter `-C` und `-c` funktionieren nicht, weil WASI keine Prozesse hat.
- Es gibt nur PMTiles-Ausgabe. MBTiles und Kachelverzeichnisse schreibt manby über einen eigenen
  Writer-Thread, und der startet unter WASI nicht („Not supported“).
- Nicht getestet: `manby join`, `--tile-format=mlt`, GeoParquet über URLs (Feature `remote`).

## tools/

- `build-wasi.sh`, `pthread_stub.c`: Build, siehe oben
- `matsim_to_geoparquet.py`: Platzhalter für Schritt 1 (statt matsim_trace), MATSim-Netz → GeoParquet
- `run-wasi.mjs`: führt manby.wasm mit Nodes eigenem WASI aus
- `run-shim.mjs`: führt manby.wasm über den Browser-Shim aus, rein im Speicher
- `compare_pmtiles.py`: vergleicht zwei PMTiles Tile für Tile
