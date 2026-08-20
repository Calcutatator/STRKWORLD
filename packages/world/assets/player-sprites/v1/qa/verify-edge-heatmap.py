#!/usr/bin/env python3
"""Ensure the edge heatmap contains evidence for every key/row/frame block."""

from __future__ import annotations

import sys
from pathlib import Path

from PIL import Image


ROOT = Path(__file__).resolve().parents[1]
BLOCK = 128
BACKGROUND = (35, 35, 41, 255)


def main() -> int:
    heatmap = Image.open(ROOT / "qa/edge-heatmap.png").convert("RGBA")
    # Four key panels across and four down. Each panel contains five poses by
    # four facings, so the full image is 20 by 16 diagnostic blocks.
    expected_size = (20 * BLOCK, 16 * BLOCK)
    if heatmap.size != expected_size:
        raise AssertionError(f"edge heatmap is {heatmap.size}, expected {expected_size}")
    blank = []
    for key in range(1, 17):
        for row in range(4):
            for column in range(5):
                block = heatmap.crop(
                    (
                        (((key - 1) % 4) * 5 + column) * BLOCK,
                        (((key - 1) // 4) * 4 + row) * BLOCK,
                        (((key - 1) % 4) * 5 + column + 1) * BLOCK,
                        (((key - 1) // 4) * 4 + row + 1) * BLOCK,
                    )
                )
                if not any(pixel != BACKGROUND for pixel in block.getdata()):
                    blank.append((key, row, column))
    if blank:
        raise AssertionError(f"blank edge evidence blocks: {blank}")
    print("edge-heatmap: pass (320 nonblank key/row/frame blocks)")
    return 0


if __name__ == "__main__":
    sys.exit(main())
