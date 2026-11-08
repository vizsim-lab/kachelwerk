"""MATSim network.xml(.gz) -> GeoParquet, one LineString per link.

A stand-in for step 1 of the pipeline (matsim_trace), only to have a
realistic input for testing manby. Coordinates stay in the network's CRS,
which goes into the GeoParquet metadata so that manby reprojects.

Usage: python3 -I matsim_to_geoparquet.py network.xml.gz out.parquet EPSG:25832
"""
import gzip
import json
import struct
import sys
import xml.etree.ElementTree as ET

import pyarrow as pa
import pyarrow.parquet as pq

src, dst, crs = sys.argv[1], sys.argv[2], sys.argv[3]
authority, code = crs.split(":")

opener = gzip.open if src.endswith(".gz") else open
nodes = {}
cols = {k: [] for k in ["id", "from", "to", "length", "freespeed", "freespeed_kmh", "capacity", "permlanes", "modes", "geometry"]}
bbox = [float("inf"), float("inf"), float("-inf"), float("-inf")]

with opener(src, "rb") as f:
    for _, el in ET.iterparse(f, events=("end",)):
        if el.tag == "node":
            nodes[el.get("id")] = (float(el.get("x")), float(el.get("y")))
            el.clear()
        elif el.tag == "link":
            (x1, y1), (x2, y2) = nodes[el.get("from")], nodes[el.get("to")]
            cols["id"].append(el.get("id"))
            cols["from"].append(el.get("from"))
            cols["to"].append(el.get("to"))
            for k in ["length", "freespeed", "capacity", "permlanes"]:
                cols[k].append(float(el.get(k)))
            cols["freespeed_kmh"].append(round(float(el.get("freespeed")) * 3.6, 1))
            cols["modes"].append(el.get("modes"))
            # WKB LineString, little-endian, two points
            cols["geometry"].append(struct.pack("<BII4d", 1, 2, 2, x1, y1, x2, y2))
            bbox = [min(bbox[0], x1, x2), min(bbox[1], y1, y2), max(bbox[2], x1, x2), max(bbox[3], y1, y2)]
            el.clear()

table = pa.table(
    {
        "id": pa.array(cols["id"], pa.string()),
        "from": pa.array(cols["from"], pa.string()),
        "to": pa.array(cols["to"], pa.string()),
        "length": pa.array(cols["length"], pa.float64()),
        "freespeed": pa.array(cols["freespeed"], pa.float64()),
        "freespeed_kmh": pa.array(cols["freespeed_kmh"], pa.float64()),
        "capacity": pa.array(cols["capacity"], pa.float64()),
        "permlanes": pa.array(cols["permlanes"], pa.float64()),
        "modes": pa.array(cols["modes"], pa.string()),
        "geometry": pa.array(cols["geometry"], pa.binary()),
    }
)
geo = {
    "version": "1.1.0",
    "primary_column": "geometry",
    "columns": {
        "geometry": {
            "encoding": "WKB",
            "geometry_types": ["LineString"],
            "crs": {"type": "ProjectedCRS", "name": crs, "id": {"authority": authority, "code": int(code)}},
            "bbox": bbox,
        }
    },
}
table = table.replace_schema_metadata({b"geo": json.dumps(geo).encode()})
pq.write_table(table, dst, compression="zstd")
print(f"{len(cols['id'])} links from {len(nodes)} nodes -> {dst}, bbox {bbox}")
