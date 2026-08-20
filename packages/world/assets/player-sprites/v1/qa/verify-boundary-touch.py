#!/usr/bin/env python3
"""Reject opaque sprite pixels touching any logical-cell boundary."""

from pathlib import Path

from PIL import Image


ROOT = Path(__file__).resolve().parents[1]
CELL = 64


def main() -> int:
    hits = []
    for key in range(1, 17):
        image = Image.open(ROOT / f"avatar-{key}.png").convert("RGBA")
        for row in range(4):
            for column in range(5):
                frame = image.crop(
                    (column * CELL, row * CELL, (column + 1) * CELL, (row + 1) * CELL)
                )
                coords = [
                    (x, y)
                    for y in range(CELL)
                    for x in range(CELL)
                    if (x in (0, CELL - 1) or y in (0, CELL - 1))
                    and frame.getpixel((x, y))[3]
                ]
                if coords:
                    hits.append((key, row, column, coords))
    if hits:
        raise AssertionError(f"{len(hits)} cells touch a logical boundary: {hits}")
    print("boundary-touch: pass (320 cells, zero opaque edge pixels)")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
