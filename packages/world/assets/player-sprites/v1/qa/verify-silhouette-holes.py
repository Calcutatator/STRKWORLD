#!/usr/bin/env python3
"""Reject unreviewed enclosed transparent pixels in every sprite cell."""

from __future__ import annotations

import json
import sys
from collections import deque
from pathlib import Path

from PIL import Image


ROOT = Path(__file__).resolve().parents[1]
CELL = 64
ROWS = 4
COLUMNS = 5
REPORT = ROOT / "qa/interior-holes.json"


def enclosed_transparency(image: Image.Image) -> list[list[int]]:
    alpha = image.getchannel("A")
    exterior: set[tuple[int, int]] = set()
    for x in range(CELL):
        for y in (0, CELL - 1):
            if alpha.getpixel((x, y)) == 0:
                exterior.add((x, y))
    for y in range(CELL):
        for x in (0, CELL - 1):
            if alpha.getpixel((x, y)) == 0:
                exterior.add((x, y))

    queue = deque(exterior)
    while queue:
        x, y = queue.popleft()
        for nx, ny in ((x - 1, y), (x + 1, y), (x, y - 1), (x, y + 1)):
            if (
                0 <= nx < CELL
                and 0 <= ny < CELL
                and (nx, ny) not in exterior
                and alpha.getpixel((nx, ny)) == 0
            ):
                exterior.add((nx, ny))
                queue.append((nx, ny))

    return [
        [x, y]
        for y in range(CELL)
        for x in range(CELL)
        if alpha.getpixel((x, y)) == 0 and (x, y) not in exterior
    ]


def main() -> int:
    report = json.loads(REPORT.read_text()) if REPORT.exists() else {}
    whitelist = {
        (item["key"], item["row"], item["column"], item["x"], item["y"])
        for item in report.get("whitelist", [])
    }
    rows = ["down", "left", "right", "up"]
    columns = ["idle", "contact-left", "passing-left", "contact-right", "passing-right"]
    failures = []
    total = 0
    for key in range(1, 17):
        sheet = Image.open(ROOT / f"avatar-{key}.png").convert("RGBA")
        for row in range(ROWS):
            for column in range(COLUMNS):
                cell = sheet.crop(
                    (column * CELL, row * CELL, (column + 1) * CELL, (row + 1) * CELL)
                )
                pixels = enclosed_transparency(cell)
                total += len(pixels)
                for x, y in pixels:
                    identity = (f"avatar-{key}", rows[row], columns[column], x, y)
                    if identity not in whitelist:
                        failures.append(identity)
    if failures:
        raise AssertionError(
            f"{len(failures)} unreviewed enclosed transparent pixels: {failures[:12]}"
        )
    if total:
        raise AssertionError(f"{total} enclosed transparent pixels are whitelisted; review required")
    print("silhouette-holes: pass (320 cells, zero enclosed transparent pixels)")
    return 0


if __name__ == "__main__":
    sys.exit(main())
