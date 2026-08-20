#!/usr/bin/env python3
"""Recompute qa-report.json metrics from the exact committed PNG sheets."""

from __future__ import annotations

import argparse
import copy
import json
import sys
from pathlib import Path

from PIL import Image


ROOT = Path(__file__).resolve().parents[1]
REPORT = ROOT / "qa/qa-report.json"
CELL = 64
ROWS = ["down", "left", "right", "up"]
COLUMNS = ["idle", "contact-left", "passing-left", "contact-right", "passing-right"]


def interior_transparent_pixels(cell: Image.Image) -> int:
    alpha = cell.getchannel("A")
    transparent = {
        (x, y)
        for y in range(CELL)
        for x in range(CELL)
        if alpha.getpixel((x, y)) == 0
    }
    exterior: set[tuple[int, int]] = set()
    stack = [point for point in transparent if point[0] in (0, 63) or point[1] in (0, 63)]
    while stack:
        point = stack.pop()
        if point in exterior or point not in transparent:
            continue
        exterior.add(point)
        x, y = point
        stack.extend(((x - 1, y), (x + 1, y), (x, y - 1), (x, y + 1)))
    return len(transparent - exterior)


def recompute() -> dict:
    cells: list[dict] = []
    changed_total = 0
    above_counts: list[int] = []
    upper_body_shares: list[float] = []
    interior_total = 0
    nonbinary: list[dict] = []
    feet_failures: list[dict] = []
    max_colors = 0
    for key in range(1, 17):
        sheet = Image.open(ROOT / f"avatar-{key}.png").convert("RGBA")
        for row_index, row in enumerate(ROWS):
            idle = sheet.crop((0, row_index * CELL, CELL, (row_index + 1) * CELL))
            idle_box = idle.getchannel("A").getbbox()
            if idle_box is None:
                raise AssertionError(f"empty directional idle: avatar-{key} {row}")
            hip_gate = idle_box[1] + round((idle_box[3] - idle_box[1]) * 0.65)
            for column_index, column in enumerate(COLUMNS):
                cell = sheet.crop(
                    (column_index * CELL, row_index * CELL,
                     (column_index + 1) * CELL, (row_index + 1) * CELL)
                )
                alpha = cell.getchannel("A")
                bbox = alpha.getbbox()
                if bbox is None:
                    raise AssertionError(f"empty cell: avatar-{key} {row}/{column}")
                visible_colors = len({pixel[:3] for pixel in cell.getdata() if pixel[3]})
                changed = sum(a != b for a, b in zip(idle.getdata(), cell.getdata()))
                interior = interior_transparent_pixels(cell)
                interior_total += interior
                if any(value not in (0, 255) for value in alpha.getdata()):
                    nonbinary.append({"key": f"avatar-{key}", "row": row, "column": column})
                if bbox[3] - 1 != 56:
                    feet_failures.append({
                        "key": f"avatar-{key}",
                        "row": row,
                        "column": column,
                        "maxOpaqueY": bbox[3] - 1,
                    })
                max_colors = max(max_colors, visible_colors)
                cells.append({
                    "key": key,
                    "row": row,
                    "column": column,
                    "bbox": list(bbox),
                    "visibleColors": visible_colors,
                    "interiorTransparentPixels": interior,
                    "changedFromDirectionalIdle": changed,
                })
                if column_index:
                    changed_total += changed
                    changed_pixels = [
                        y
                        for y in range(CELL)
                        for x in range(CELL)
                        if idle.getpixel((x, y)) != cell.getpixel((x, y))
                    ]
                    above = sum(y < hip_gate for y in changed_pixels)
                    above_counts.append(above)
                    upper_body_shares.append(above / changed)
    return {
        "cellReports": cells,
        "interiorTransparentPixels": interior_total,
        "nonBinaryAlphaCells": nonbinary,
        "feetFailures": feet_failures,
        "maxVisibleColorsPerCell": max_colors,
        "wholeBodyMotion": {
            "nonIdleCells": len(above_counts),
            "totalChangedPixels": changed_total,
            "minChangedPixelsAboveHip": min(above_counts),
            "minUpperBodyShare": round(min(upper_body_shares), 6),
        },
    }


def assert_matches(report: dict, actual: dict) -> None:
    for field in (
        "interiorTransparentPixels",
        "nonBinaryAlphaCells",
        "feetFailures",
        "maxVisibleColorsPerCell",
        "cellReports",
    ):
        if report.get(field) != actual[field]:
            raise AssertionError(f"qa-report field is stale: {field}")
    recorded_motion = report.get("wholeBodyMotion", {})
    for field, value in actual["wholeBodyMotion"].items():
        if recorded_motion.get(field) != value:
            raise AssertionError(f"qa-report aggregate is stale: wholeBodyMotion.{field}")


def self_test() -> int:
    report = json.loads(REPORT.read_text())
    actual = recompute()
    mutated = copy.deepcopy(report)
    mutated["cellReports"][1]["changedFromDirectionalIdle"] += 1
    try:
        assert_matches(mutated, actual)
    except AssertionError:
        pass
    else:
        raise AssertionError("self-test failed to reject a mutated per-cell metric")
    mutated = copy.deepcopy(report)
    mutated["wholeBodyMotion"]["totalChangedPixels"] += 1
    try:
        assert_matches(mutated, actual)
    except AssertionError:
        pass
    else:
        raise AssertionError("self-test failed to reject a mutated aggregate metric")
    print("qa-report negative test: pass (per-cell and aggregate mutations rejected)")
    return 0


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--self-test", action="store_true")
    args = parser.parse_args()
    if args.self_test:
        return self_test()
    report = json.loads(REPORT.read_text())
    assert_matches(report, recompute())
    print("qa-report: pass (320 cell metrics and whole-body aggregates correlate to PNGs)")
    return 0


if __name__ == "__main__":
    sys.exit(main())
