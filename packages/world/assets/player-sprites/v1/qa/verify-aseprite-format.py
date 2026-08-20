#!/usr/bin/env python3
"""Validate the D-052 Aseprite compressed-cel format and PNG parity."""

from __future__ import annotations

import struct
import sys
import zlib
from pathlib import Path

from PIL import Image


ROOT = Path(__file__).resolve().parents[1]
SOURCE = ROOT / "source/player-sprites.aseprite"
CELL = 64
EXPECTED_FRAMES = 320


def png_cell(key: int, row: int, column: int) -> bytes:
    image = Image.open(ROOT / f"avatar-{key}.png").convert("RGBA")
    return image.crop(
        (column * CELL, row * CELL, (column + 1) * CELL, (row + 1) * CELL)
    ).tobytes()


def main() -> int:
    data = SOURCE.read_bytes()
    if struct.unpack_from("<HHH", data, 6) != (EXPECTED_FRAMES, CELL, CELL):
        raise AssertionError("Aseprite header is not 320 frames at 64x64")

    offset = 128
    cel_index = 0
    while offset < len(data):
        frame_size = struct.unpack_from("<I", data, offset)[0]
        frame = data[offset : offset + frame_size]
        chunk_count = struct.unpack_from("<I", frame, 12)[0]
        if chunk_count == 0:
            chunk_count = struct.unpack_from("<H", frame, 6)[0]
        chunk_offset = 16
        frame_cels = 0
        for _ in range(chunk_count):
            chunk_size, chunk_type = struct.unpack_from("<IH", frame, chunk_offset)
            chunk = frame[chunk_offset : chunk_offset + chunk_size]
            if chunk_type == 0x2005:
                if len(chunk) < 26:
                    raise AssertionError(f"cel {cel_index} has no dimension fields")
                width, height = struct.unpack_from("<HH", chunk, 22)
                if (width, height) != (CELL, CELL):
                    raise AssertionError(
                        f"cel {cel_index} dimensions are {width}x{height}, not 64x64"
                    )
                raw = zlib.decompress(chunk[26:])
                key = cel_index // 20 + 1
                row, column = divmod(cel_index % 20, 5)
                if raw != png_cell(key, row, column):
                    raise AssertionError(f"cel {cel_index} differs from its PNG cell")
                cel_index += 1
                frame_cels += 1
            chunk_offset += chunk_size
        if frame_cels != 1:
            raise AssertionError(
                f"frame at offset {offset} contains {frame_cels} cels; expected one"
            )
        offset += frame_size

    if cel_index != EXPECTED_FRAMES:
        raise AssertionError(f"parsed {cel_index} cels, expected {EXPECTED_FRAMES}")
    print(f"aseprite-format: pass ({cel_index} spec-correct cels, pixel-identical)")
    return 0


if __name__ == "__main__":
    sys.exit(main())
