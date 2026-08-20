#!/usr/bin/env python3
"""Reject bracketed 1-2px alpha channels not in the reviewed whitelist."""

from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

from PIL import Image


ROOT = Path(__file__).resolve().parents[1]
REPORT = ROOT / "qa/channel-review.json"
CELL = 64
ROWS = ["down", "left", "right", "up"]
COLUMNS = ["idle", "contact-left", "passing-left", "contact-right", "passing-right"]


def scan(cell: Image.Image) -> list[tuple[str, int, int, int]]:
    alpha = cell.getchannel("A")
    opaque = [(x, y) for y in range(CELL) for x in range(CELL) if alpha.getpixel((x, y))]
    if not opaque:
        return []
    xs = [x for x, _ in opaque]
    ys = [y for _, y in opaque]
    xmin, xmax, ymin, ymax = min(xs), max(xs), min(ys), max(ys)
    found: list[tuple[str, int, int, int]] = []
    for y in range(ymin, ymax + 1):
        x = xmin
        while x <= xmax:
            if alpha.getpixel((x, y)):
                x += 1
                continue
            start = x
            while x <= xmax and not alpha.getpixel((x, y)):
                x += 1
            end = x - 1
            if (
                end - start + 1 <= 2
                and start > xmin
                and end < xmax
                and alpha.getpixel((start - 1, y))
                and alpha.getpixel((end + 1, y))
            ):
                found.append(("horizontal", start, y, end - start + 1))
    for x in range(xmin, xmax + 1):
        y = ymin
        while y <= ymax:
            if alpha.getpixel((x, y)):
                y += 1
                continue
            start = y
            while y <= ymax and not alpha.getpixel((x, y)):
                y += 1
            end = y - 1
            if (
                end - start + 1 <= 2
                and start > ymin
                and end < ymax
                and alpha.getpixel((x, start - 1))
                and alpha.getpixel((x, end + 1))
            ):
                found.append(("vertical", x, start, end - start + 1))
    return found


def identity(key: int, row: int, column: int, item: tuple[str, int, int, int]) -> tuple:
    orientation, x, y, length = item
    return (f"avatar-{key}", ROWS[row], COLUMNS[column], orientation, x, y, length)


def current_candidates() -> set[tuple]:
    result = set()
    for key in range(1, 17):
        sheet = Image.open(ROOT / f"avatar-{key}.png").convert("RGBA")
        for row in range(4):
            for column in range(5):
                cell = sheet.crop(
                    (column * CELL, row * CELL, (column + 1) * CELL, (row + 1) * CELL)
                )
                result.update(identity(key, row, column, item) for item in scan(cell))
    return result


def whitelist_set(report: dict) -> set[tuple]:
    return {
        (
            item["key"],
            item["row"],
            item["column"],
            item["orientation"],
            item["x"],
            item["y"],
            item["length"],
        )
        for item in report.get("whitelist", [])
    }


def assert_whitelist_matches(current: set[tuple], whitelist: set[tuple]) -> None:
    if current != whitelist:
        missing = sorted(current - whitelist)
        stale = sorted(whitelist - current)
        raise AssertionError(
            f"channel whitelist mismatch: unclassified={missing[:8]}, stale={stale[:8]}"
        )


def self_test() -> int:
    cell = Image.new("RGBA", (CELL, CELL), (0, 0, 0, 0))
    for y in range(8, 24):
        for x in range(8, 24):
            cell.putpixel((x, y), (1, 2, 3, 255))
    cell.putpixel((16, 16), (0, 0, 0, 0))
    injected = scan(cell)
    if not injected:
        raise AssertionError("self-test failed to inject a bracketed channel")
    candidate = ("avatar-1", "down", "idle", *injected[0])
    try:
        assert_whitelist_matches({candidate}, set())
    except AssertionError:
        pass
    else:
        raise AssertionError("self-test failed to reject an injected unclassified channel")
    try:
        assert_whitelist_matches({candidate}, {candidate, ("avatar-1", "down", "idle", "horizontal", 9, 9, 1)})
    except AssertionError:
        pass
    else:
        raise AssertionError("self-test failed to reject a stale whitelist entry")
    print("narrow-channels negative test: pass (injected and stale whitelist entries rejected)")
    return 0


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--self-test", action="store_true")
    args = parser.parse_args()
    if args.self_test:
        return self_test()
    report = json.loads(REPORT.read_text())
    ledger = report.get("classificationLedger", [])
    if report.get("candidateCountBeforeRepair") != 864 or len(ledger) != 864:
        raise AssertionError("the complete 864-candidate classification ledger is missing")
    if any(not item.get("classification") or not item.get("rationale") for item in ledger):
        raise AssertionError("a channel classification lacks a rationale")
    if report.get("unreviewedCandidates"):
        raise AssertionError("unreviewed channel candidates remain")
    whitelist_items = report.get("whitelist", [])
    if len(whitelist_items) != report.get("intentionalNegativeSpaceWhitelist"):
        raise AssertionError("whitelist count does not match its report metadata")
    if any(
        item.get("classification") != "intentional-negative-space"
        or item.get("retained") is not True
        or not item.get("cluster")
        or "anatomically readable" not in item.get("rationale", "").lower()
        for item in whitelist_items
    ):
        raise AssertionError("a retained channel lacks an anatomical cluster rationale")
    whitelist = whitelist_set(report)
    current = current_candidates()
    assert_whitelist_matches(current, whitelist)
    print(
        "narrow-channels: pass "
        f"(864 classified; {len(current)} reviewed intentional channels; "
        f"{report.get('accidentalChannelPixelsRepaired', 0) + report.get('derivedChannelPixelsRepaired', 0)} pixels repaired)"
    )
    return 0


if __name__ == "__main__":
    sys.exit(main())
