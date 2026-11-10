#!/usr/bin/env python3
"""Generate the application icon set from code (no binary assets in the repo).

Run from the repository root:  python3 scripts/gen_icons.py
"""

import struct
import zlib
from pathlib import Path

OUT = Path(__file__).resolve().parent.parent / "src-tauri" / "icons"

BASE = (15, 23, 42)        # slate-900
PANEL = (30, 41, 59)       # slate-800
ACCENT = (45, 212, 191)    # teal-400
ACCENT_DIM = (13, 148, 136)
PAPER = (226, 232, 240)


def rounded_alpha(x, y, size, radius):
    """1 inside a rounded square, 0 outside, with a small antialiased edge."""
    dx = min(x, size - 1 - x)
    dy = min(y, size - 1 - y)
    if dx >= radius or dy >= radius:
        return 1.0
    cx = radius - dx
    cy = radius - dy
    distance = (cx * cx + cy * cy) ** 0.5
    return max(0.0, min(1.0, radius - distance + 0.5))


def render(size):
    radius = max(1.0, size * 0.22)
    rows = []
    for y in range(size):
        row = []
        for x in range(size):
            alpha = rounded_alpha(x, y, size, radius)
            if alpha <= 0:
                row.append((0, 0, 0, 0))
                continue
            color = BASE
            # Ledger page: a lighter panel inset from the edge.
            inset = size * 0.2
            if inset <= x <= size - inset and inset <= y <= size - inset:
                color = PANEL
            # Two debit/credit bars.
            bar_left = size * 0.3
            bar_right = size * 0.7
            for index, (top, width) in enumerate(
                ((0.34, 1.0), (0.5, 0.62), (0.66, 0.82))
            ):
                y0 = size * top
                if y0 <= y <= y0 + max(1, size * 0.055) and bar_left <= x <= bar_left + (bar_right - bar_left) * width:
                    color = ACCENT if index != 1 else PAPER
            # Teal corner mark.
            if x < size * 0.24 and y < size * 0.24:
                color = ACCENT_DIM
            row.append((color[0], color[1], color[2], int(round(alpha * 255))))
        rows.append(row)
    return rows


def write_png(path, size):
    rows = render(size)
    raw = b"".join(
        b"\x00" + b"".join(bytes(pixel) for pixel in row) for row in rows
    )

    def chunk(tag, data):
        return (
            struct.pack(">I", len(data))
            + tag
            + data
            + struct.pack(">I", zlib.crc32(tag + data) & 0xFFFFFFFF)
        )

    header = struct.pack(">IIBBBBB", size, size, 8, 6, 0, 0, 0)
    png = (
        b"\x89PNG\r\n\x1a\n"
        + chunk(b"IHDR", header)
        + chunk(b"IDAT", zlib.compress(raw, 9))
        + chunk(b"IEND", b"")
    )
    path.write_bytes(png)
    return png


def write_ico(path, pngs):
    count = len(pngs)
    header = struct.pack("<HHH", 0, 1, count)
    offset = 6 + 16 * count
    entries = b""
    payload = b""
    for size, data in pngs:
        entries += struct.pack(
            "<BBBBHHII",
            0 if size >= 256 else size,
            0 if size >= 256 else size,
            0,
            0,
            1,
            32,
            len(data),
            offset,
        )
        offset += len(data)
        payload += data
    path.write_bytes(header + entries + payload)


def write_icns(path, png):
    # 'ic08' carries a 256x256 PNG; enough for the macOS bundle entry.
    body = b"ic08" + struct.pack(">I", len(png) + 8) + png
    path.write_bytes(b"icns" + struct.pack(">I", len(body) + 8) + body)


def main():
    OUT.mkdir(parents=True, exist_ok=True)
    sizes = {32: "32x32.png", 128: "128x128.png", 256: "128x128@2x.png", 512: "icon.png"}
    rendered = {}
    for size, name in sizes.items():
        rendered[size] = write_png(OUT / name, size)
    write_png(OUT / "icon-512.png", 512)
    write_ico(OUT / "icon.ico", [(16, write_png(OUT / "16x16.png", 16)), (32, rendered[32]), (48, write_png(OUT / "48x48.png", 48)), (256, rendered[256])])
    write_icns(OUT / "icon.icns", rendered[256])
    print(f"wrote icons to {OUT}")


if __name__ == "__main__":
    main()
