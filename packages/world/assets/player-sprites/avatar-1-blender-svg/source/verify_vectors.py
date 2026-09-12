#!/usr/bin/env python3
"""Verify authored idle polygons against their native Blender SVG exports.

Run with Python 3.9+ from any directory. This reads the current artifacts and
writes review/source-parity.json only after all checks pass. It does not call
Blender, regenerate artwork, rasterize SVGs, or establish visual approval.

Blender 5.2 converts scene-linear material colors to sRGB, then casts each
channel times 255 to uint8 without rounding. Native SVG channels may differ
from authored palette channels by one; that bounded difference is recorded.
"""

import hashlib
import json
import math
from pathlib import Path
import re
import struct
import sys
import xml.etree.ElementTree as ET


ROOT = Path(__file__).resolve().parent.parent
DIRECTIONS = ("down", "left", "right", "up")
COORDINATE_TOLERANCE = 0.0001
COLOR_CHANNEL_TOLERANCE = 1
SVG_NAMESPACE = "http://www.w3.org/2000/svg"
NUMBER = r"[-+]?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][-+]?\d+)?"
TOKEN = re.compile(r"[MLZz]|" + NUMBER)


def check(condition, message):
    if not condition:
        raise ValueError(message)


def fingerprint(path):
    data = path.read_bytes()
    return {"bytes": len(data), "sha256": hashlib.sha256(data).hexdigest()}


def read_json(path):
    return json.loads(path.read_text(encoding="utf-8"))


def rgb(value, label):
    check(isinstance(value, str) and re.fullmatch(r"#[0-9A-Fa-f]{6}", value),
          label + ": expected #RRGGBB")
    return tuple(int(value[i:i + 2], 16) for i in (1, 3, 5))


def svg_number(value, label):
    check(isinstance(value, str) and re.fullmatch(NUMBER + r"(?:px)?", value),
          label + ": expected a finite SVG number")
    result = float(value[:-2] if value.endswith("px") else value)
    check(math.isfinite(result), label + ": nonfinite number")
    return result


def points_from_path(data, label):
    check(isinstance(data, str), label + ": missing path data")
    check(not re.sub(r"[\s,]", "", TOKEN.sub("", data)),
          label + ": unsupported path syntax")
    tokens = TOKEN.findall(data)
    check(len(tokens) >= 10 and tokens[0] == "M" and tokens[-1] in ("Z", "z"),
          label + ": expected a closed absolute M/L polygon")
    points = []
    index = 0
    while index < len(tokens) - 1:
        check(tokens[index] == ("M" if index == 0 else "L"),
              label + ": only one M followed by explicit L commands is accepted")
        check(index + 2 < len(tokens) - 1, label + ": incomplete coordinate pair")
        pair = tokens[index + 1:index + 3]
        check(all(re.fullmatch(NUMBER, item) for item in pair),
              label + ": invalid coordinate pair")
        point = [float(item) for item in pair]
        check(all(math.isfinite(item) for item in point), label + ": nonfinite point")
        points.append(point)
        index += 3
    check(index == len(tokens) - 1 and len(points) >= 3,
          label + ": malformed polygon closure")
    return points


def compare_points(actual, expected, label):
    check(len(actual) == len(expected), label + ": vertex count changed")
    maximum = 0.0
    for index, (exported, authored) in enumerate(zip(actual, expected)):
        check(len(exported) == 2 and len(authored) == 2,
              label + ": each point must have two coordinates")
        for axis, (value, target) in enumerate(zip(exported, authored)):
            check(isinstance(target, (int, float)) and math.isfinite(target),
                  label + ": authored coordinate is not finite")
            check(0 <= target <= 64, label + ": authored point is outside the cell")
            difference = abs(value - target)
            check(difference <= COORDINATE_TOLERANCE,
                  "{}: point {} axis {} differs by {}".format(label, index, axis, difference))
            maximum = max(maximum, difference)
    return maximum


def inspect_svg(path, shapes, palette):
    raw = path.read_bytes()
    check(len(raw) <= 8 * 1024 * 1024, str(path) + ": SVG exceeds 8 MiB")
    check(b"<!ENTITY" not in raw.upper(), str(path) + ": entity declarations are forbidden")
    root = ET.fromstring(raw)
    check(root.tag == "{" + SVG_NAMESPACE + "}svg", str(path) + ": wrong root namespace")
    check(svg_number(root.get("width"), "width") == 64 and
          svg_number(root.get("height"), "height") == 64,
          str(path) + ": viewport is not 64x64")
    check([float(n) for n in re.split(r"[\s,]+", root.get("viewBox", "").strip())] == [0, 0, 64, 64],
          str(path) + ": viewBox changed")
    check(svg_number(root.get("x", "0"), "x") == 0 and
          svg_number(root.get("y", "0"), "y") == 0,
          str(path) + ": root viewport shifted")

    allowed = {"svg", "g", "clipPath", "rect", "path"}
    allowed_attributes = {"version", "x", "y", "width", "height", "viewBox", "id", "clip-path",
                          "d", "fill-rule", "fill", "stroke", "fill-opacity", "opacity", "stroke-opacity"}
    clips = root.findall(".//{" + SVG_NAMESPACE + "}clipPath")
    check(len(clips) == 1, str(path) + ": exactly one full-cell camera clip is required")
    clip = clips[0]
    check(clip.get("id") and len(clip) == 1 and clip[0].tag == "{" + SVG_NAMESPACE + "}rect",
          str(path) + ": invalid camera clip")
    rect = clip[0]
    check([svg_number(rect.get(key), key) for key in ("x", "y", "width", "height")] == [0, 0, 64, 64]
          and rect.get("fill") == "none", str(path) + ": camera clip changes authored framing")
    paths = []
    for element in root.iter():
        check(element.tag.startswith("{" + SVG_NAMESPACE + "}"), "Foreign SVG namespace")
        tag = element.tag.split("}", 1)[1]
        check(tag in allowed, str(path) + ": unexpected element " + tag)
        check(set(element.attrib) <= allowed_attributes, str(path) + ": unexpected SVG attributes")
        check(tag != "svg" or element is root, str(path) + ": nested viewport is forbidden")
        check(tag != "rect" or element is rect, str(path) + ": unexpected non-path artwork")
        if "clip-path" in element.attrib:
            check(element.get("clip-path") == "url(#{})".format(clip.get("id")),
                  str(path) + ": unexpected clipping")
        for attribute in ("opacity", "fill-opacity", "stroke-opacity"):
            if attribute in element.attrib:
                check(svg_number(element.get(attribute), attribute) == 1,
                      str(path) + ": non-opaque " + attribute)
        if tag == "path":
            paths.append(element)

    check(len(paths) == len(shapes),
          "{}: expected {} paths, found {}".format(path, len(shapes), len(paths)))
    polygon_reports = []
    for index, (element, shape) in enumerate(zip(paths, shapes)):
        label = "{} polygon {} ({})".format(path.parent.name, index, shape["part"])
        check(element.get("stroke") == "none", label + ": outline stroke is enabled")
        check(element.get("fill-opacity") is not None and
              svg_number(element.get("fill-opacity"), label) == 1,
              label + ": fill opacity must explicitly be 1")
        check(element.get("fill-rule") == "evenodd", label + ": native fill rule changed")
        expected_hex = palette[shape["color"]]
        actual_hex = element.get("fill")
        differences = [actual - expected for actual, expected in zip(
            rgb(actual_hex, label), rgb(expected_hex, label))]
        check(max(abs(value) for value in differences) <= COLOR_CHANNEL_TOLERANCE,
              label + ": native SVG fill differs from the authored palette by more than one channel level")
        max_error = compare_points(points_from_path(element.get("d"), label), shape["points"], label)
        polygon_reports.append({
            "index": index, "part": shape["part"], "color": shape["color"],
            "vertices": len(shape["points"]), "maximumCoordinateError": max_error,
            "authoredFill": expected_hex.upper(), "nativeSvgFill": actual_hex.upper(),
            "nativeMinusAuthoredChannels": differences,
        })
    return {
        "pathCount": len(paths), "authoredPolygonCount": len(shapes),
        "painterOrderAndVertices": "pass", "opaqueFillsWithoutOutlines": "pass",
        "maximumCoordinateError": max(item["maximumCoordinateError"] for item in polygon_reports),
        "maximumAbsoluteColorChannelError": max(abs(value) for item in polygon_reports
                                                for value in item["nativeMinusAuthoredChannels"]),
        "polygons": polygon_reports,
    }


def inspect_png_header(path):
    data = path.read_bytes()
    check(data[:8] == b"\x89PNG\r\n\x1a\n" and data[12:16] == b"IHDR",
          str(path) + ": invalid PNG header")
    check(struct.unpack(">II", data[16:24]) == (64, 64), str(path) + ": PNG is not 64x64")


def blender_name_matches(actual, authored):
    # Blender appends a numeric suffix when an existing datablock uses a name.
    return isinstance(actual, str) and bool(re.fullmatch(re.escape(authored) + r"(?:\.\d{3,})?", actual))


def inspect_blender_readback(document, geometry):
    check(Path(document["reopenedMaster"]).resolve() == ROOT / "source/avatar-1.blend",
          "Blender readback identifies a different master")
    check(set(document["views"]) == set(DIRECTIONS), "Blender readback must contain all four views")
    result = {}
    for direction in DIRECTIONS:
        actual = document["views"][direction]
        expected = geometry["views"][direction]
        check(len(actual) == len(expected), direction + ": Blender polygon count changed")
        fill_ids = {}
        maximum = 0.0
        for index, (stroke, shape) in enumerate(zip(actual, expected)):
            label = "Blender {} polygon {}".format(direction, index)
            check(blender_name_matches(stroke["part"], shape["part"]), label + ": layer/part order changed")
            check(blender_name_matches(stroke["materialName"], shape["color"]), label + ": palette material changed")
            check(stroke["hideStroke"] is True and stroke["cyclic"] is True,
                  label + ": polygon must be cyclic with its stroke hidden")
            fill_id = stroke["fillId"]
            check(type(fill_id) is int and fill_id > 0, label + ": fill group must be a positive integer")
            previous_ids = fill_ids.setdefault(stroke["part"], set())
            check(fill_id not in previous_ids, label + ": independent polygons share a fill group")
            previous_ids.add(fill_id)
            maximum = max(maximum, compare_points(stroke["points"], shape["points"], label))
        result[direction] = {"polygonCount": len(actual), "maximumCoordinateError": maximum,
                             "orderedPartsPaletteMaterialsAndFillState": "pass"}
    return {"status": "pass", "source": "source/blender-readback.json",
            "blenderVersion": document["blender"], "views": result,
            "scope": "Compare the supplied readback from the reopened master; this verifier does not call Blender"}


def inspect_reload_report(document):
    check(document["status"] == "pass", "Saved-file reload report is not passing")
    expected = {"{}/{}/idle.{}".format(folder, direction, extension)
                for direction in DIRECTIONS for folder, extension in (("svg", "svg"), ("frames", "png"))}
    check({item["file"] for item in document["files"]} == expected and len(document["files"]) == 8,
          "Reload evidence must contain exactly four SVGs and four PNGs")
    for item in document["files"]:
        current_hash = fingerprint(ROOT / item["file"])["sha256"]
        check(item["sameBytes"] is True and item["beforeSha256"] == item["afterSha256"] == current_hash,
              item["file"] + ": current artifact no longer matches saved-file reload evidence")
    return {"status": "pass", "source": "review/reload-parity.json", "matchingCurrentFiles": 8,
            "scope": "Validate supplied before/after hashes against current files; this verifier does not repeat the reload"}


def main():
    check(len(sys.argv) == 1, "Usage: python3 source/verify_vectors.py")
    geometry = read_json(ROOT / "source/idle-geometry.json")
    palette_document = read_json(ROOT / "source/palette.json")
    palette = {item["name"]: item["hex"] for item in palette_document["colors"]}
    check(len(palette) == len(palette_document["colors"]), "Palette names must be unique")
    check(geometry["cell"] == [64, 64] and geometry["feetPivot"] == [32, 56],
          "Authored cell or feet pivot contract changed")
    check(set(geometry["views"]) == set(DIRECTIONS), "Exactly four authored directions are required")
    frames = {}
    files = ["source/idle-geometry.json", "source/palette.json", "source/authoring.py",
             "source/export_svg.py", "source/rasterize.cjs", "source/verify_vectors.py",
             "source/avatar-1.blend"]
    for direction in DIRECTIONS:
        svg = "svg/{}/idle.svg".format(direction)
        png = "frames/{}/idle.png".format(direction)
        shapes = geometry["views"][direction]
        check(isinstance(shapes, list) and len(shapes) > 0, direction + ": no authored polygons")
        frames[direction] = inspect_svg(ROOT / svg, shapes, palette)
        inspect_png_header(ROOT / png)
        files.extend((svg, png))
    for optional in ("source/blender-environment.json", "source/blender-readback.json",
                     "review/qa.json", "review/idle-approval.png", "review/reload-parity.json",
                     "review/user-decisions.json"):
        if (ROOT / optional).is_file():
            files.append(optional)
    report = {
        "schemaVersion": 1, "avatar": "avatar-1", "pose": "idle",
        "mechanicalStatus": "pass", "userIdleApproval": "pending",
        "animationAcceptance": "not-tested", "liveGameAcceptance": "not-tested",
        "scope": "Ordered authored polygons and palette compared to native SVG paths; current artifact hashes recorded",
        "tolerances": {
            "coordinateAbsolute": COORDINATE_TOLERANCE,
            "colorChannelAbsolute": COLOR_CHANNEL_TOLERANCE,
            "colorReason": "Blender 5.2 native SVG export converts linear RGB to sRGB and truncates uint8 channels; allow at most one level of drift",
        },
        "limits": [
            "This script does not open Blender; saved-master readback and reload provenance come from the supplied evidence files",
            "PNG hashes and 64x64 headers are checked here; rasterization and review crop parity are recorded separately in review/qa.json",
            "Mechanical parity does not establish aesthetic approval, animation quality, or game acceptance",
        ],
        "frames": frames,
        "files": {name: fingerprint(ROOT / name) for name in files},
    }
    readback_path = ROOT / "source/blender-readback.json"
    report["blenderReadbackParity"] = (inspect_blender_readback(read_json(readback_path), geometry)
                                       if readback_path.is_file() else {"status": "not-provided"})
    reload_path = ROOT / "review/reload-parity.json"
    report["savedFileReloadEvidence"] = (inspect_reload_report(read_json(reload_path))
                                         if reload_path.is_file() else {"status": "not-provided"})
    destination = ROOT / "review/source-parity.json"
    destination.parent.mkdir(parents=True, exist_ok=True)
    destination.write_text(json.dumps(report, indent=2) + "\n", encoding="utf-8")
    print("Source-to-SVG parity passed for {} polygons across four views.".format(
        sum(frame["pathCount"] for frame in frames.values())))
    print(destination)


if __name__ == "__main__":
    try:
        main()
    except (ValueError, KeyError, OSError, ET.ParseError, TypeError, struct.error) as error:
        print("Source parity verification failed: " + str(error), file=sys.stderr)
        sys.exit(1)
