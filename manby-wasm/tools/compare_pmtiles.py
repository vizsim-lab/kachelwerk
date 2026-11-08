"""Compares two PMTiles v3 archives tile by tile.

Reports whether the archives are byte-identical, whether every tile's
decompressed contents are, and which tiles differ.

Usage: python3 -I compare_pmtiles.py a.pmtiles b.pmtiles
"""
import gzip
import struct
import sys


def varint(b, pos):
    shift = result = 0
    while True:
        byte = b[pos]
        pos += 1
        result |= (byte & 0x7F) << shift
        if byte < 0x80:
            return result, pos
        shift += 7


def decompress(data, kind):
    if kind == 2:  # gzip
        return gzip.decompress(data)
    if kind in (0, 1):  # unknown / none
        return data
    raise ValueError(f"compression {kind} not handled")


def directory(data):
    n, pos = varint(data, 0)
    entries = [[0, 0, 0, 0] for _ in range(n)]  # tile_id, run_length, length, offset
    last = 0
    for e in entries:
        d, pos = varint(data, pos)
        last += d
        e[0] = last
    for e in entries:
        e[1], pos = varint(data, pos)
    for e in entries:
        e[2], pos = varint(data, pos)
    for i, e in enumerate(entries):
        v, pos = varint(data, pos)
        e[3] = entries[i - 1][3] + entries[i - 1][2] if v == 0 and i > 0 else v - 1
    return entries


def tiles(path):
    b = open(path, "rb").read()
    assert b[:7] == b"PMTiles" and b[7] == 3, "not PMTiles v3"
    (root_off, root_len, meta_off, meta_len, leaf_off, leaf_len, data_off, data_len,
     n_addr, n_entries, n_contents) = struct.unpack_from("<11Q", b, 8)
    clustered, internal, tile_comp, tile_type, minz, maxz = struct.unpack_from("<6B", b, 96)
    out = {}

    def walk(off, length):
        for tile_id, run, size, o in directory(decompress(b[off:off + length], internal)):
            if run == 0:
                walk(leaf_off + o, size)
            else:
                raw = b[data_off + o:data_off + o + size]
                for k in range(run):
                    out[tile_id + k] = raw

    walk(root_off, root_len)
    meta = decompress(b[meta_off:meta_off + meta_len], internal)
    return b, out, tile_comp, meta, (minz, maxz)


a_bytes, a, a_comp, a_meta, a_z = tiles(sys.argv[1])
b_bytes, b, b_comp, b_meta, b_z = tiles(sys.argv[2])
print(f"archives byte-identical: {a_bytes == b_bytes}")
print(f"tiles: {len(a)} vs {len(b)}, zooms {a_z} vs {b_z}")
same_raw = sum(1 for k in a if b.get(k) == a[k])
same_content = sum(1 for k in a if k in b and decompress(a[k], a_comp) == decompress(b[k], b_comp))
print(f"tiles with identical bytes: {same_raw}/{len(a)}")
print(f"tiles with identical decompressed contents: {same_content}/{len(a)}")
print(f"metadata identical: {a_meta == b_meta}")
diff = [k for k in sorted(a) if k not in b or decompress(a[k], a_comp) != decompress(b[k], b_comp)]
if diff:
    print("differing tile ids:", diff[:20])
    k = diff[0]
    da, db = decompress(a[k], a_comp), decompress(b.get(k, b""), b_comp)
    print(f"first differing tile {k}: {len(da)} vs {len(db)} bytes decompressed")
