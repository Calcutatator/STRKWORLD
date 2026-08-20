#!/usr/bin/env python3
"""Verify full-cell, four-background readability evidence against the sheets."""

from __future__ import annotations

import sys
from pathlib import Path

from PIL import Image, ImageChops


ROOT = Path(__file__).resolve().parents[1]
CELL = 128
PANEL = 544
HEADER = 32
BACKGROUNDS = [(88, 108, 76), (66, 73, 82), (176, 162, 132), (112, 70, 57)]


def expected_slot(source: Image.Image, background: tuple[int, int, int]) -> Image.Image:
    cell = source.resize((CELL, CELL), Image.Resampling.NEAREST)
    rendered = Image.new("RGB", (CELL, CELL), background)
    rendered.paste(cell.convert("RGB"), mask=cell.getchannel("A"))
    return rendered


def main() -> int:
    evidence = Image.open(ROOT / "qa/background-readability.png").convert("RGB")
    # One complete 544px board per row: grass, slate, paving, brick.
    expected_size = (PANEL, PANEL * 4)
    if evidence.size != expected_size:
        raise AssertionError(f"background evidence is {evidence.size}, expected {expected_size}")
    mismatches = []
    empty = []
    for panel, background in enumerate(BACKGROUNDS):
        ox = 0
        oy = panel * PANEL
        for index in range(16):
            key = index + 1
            source = Image.open(ROOT / f"avatar-{key}.png").convert("RGBA").crop((0, 0, 64, 64))
            expected = expected_slot(source, background)
            x = ox + (index % 4) * CELL
            y = oy + HEADER + (index // 4) * CELL
            actual = evidence.crop((x, y, x + CELL, y + CELL))
            if ImageChops.difference(actual, expected).getbbox() is not None:
                mismatches.append((panel, key))
            if not any(pixel != background for pixel in actual.getdata()):
                empty.append((panel, key))
    if mismatches:
        raise AssertionError(f"background slots do not correlate to full source cells: {mismatches[:8]}")
    if empty:
        raise AssertionError(f"empty background slots: {empty[:8]}")
    print("background-readability: pass (16 full-cell renders x 4 backgrounds = 64 total)")
    return 0


if __name__ == "__main__":
    sys.exit(main())
