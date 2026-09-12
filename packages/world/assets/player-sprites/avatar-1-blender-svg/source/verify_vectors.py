#!/usr/bin/env python3
"""Verify concept-derived compound regions through Blender, SVG, and PNG.

Run with Python 3.9+ from any directory. This reads the current artifacts and
writes review/source-parity.json only after all checks pass. Pillow decodes PNG
pixels. This does not call Blender, rasterize SVGs, or establish visual approval.

Each native compound path must match its ordered source region, with equivalent
cyclic start/winding accepted for individual contours. The native fill must
match the exact palette hex; authoring.py compensates for Blender's truncation.
An independent even-odd fill of the source contours must recreate construction
pixels, and final PNG pixels must equal those construction pixels byte-for-byte.
"""

import hashlib
import json
import math
from pathlib import Path
import re
import sys
import xml.etree.ElementTree as ET
from PIL import Image, __version__ as PILLOW_VERSION


ROOT = Path(__file__).resolve().parent.parent
DIRECTIONS = ("down", "left", "right", "up")
COORDINATE_TOLERANCE = 0.0001
COLOR_CHANNEL_TOLERANCE = 0
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


def contours_from_path(data, label):
    check(isinstance(data, str), label + ": missing path data")
    check(not re.sub(r"[\s,]", "", TOKEN.sub("", data)),
          label + ": unsupported path syntax")
    tokens = TOKEN.findall(data)
    check(len(tokens) >= 10, label + ": expected closed absolute M/L contours")
    contours = []
    index = 0
    while index < len(tokens):
        points = []
        while index < len(tokens) and tokens[index] not in ("Z", "z"):
            check(tokens[index] == ("M" if not points else "L"),
                  label + ": each contour needs one M followed by explicit L commands")
            check(index + 2 < len(tokens), label + ": incomplete coordinate pair")
            pair = tokens[index + 1:index + 3]
            check(all(re.fullmatch(NUMBER, item) for item in pair), label + ": invalid coordinate pair")
            point = [float(item) for item in pair]
            check(all(math.isfinite(item) for item in point), label + ": nonfinite point")
            points.append(point)
            index += 3
        check(index < len(tokens) and tokens[index] in ("Z", "z") and len(points) >= 3,
              label + ": malformed contour closure")
        contours.append(points)
        index += 1
    return contours


def equivalent_loop_error(actual, expected):
    if len(actual) != len(expected):
        return None
    candidates = []
    for orientation in (expected, list(reversed(expected))):
        for offset, point in enumerate(orientation):
            if max(abs(a - b) for a, b in zip(actual[0], point)) > COORDINATE_TOLERANCE:
                continue
            aligned = orientation[offset:] + orientation[:offset]
            error = max(abs(a - b) for got, want in zip(actual, aligned) for a, b in zip(got, want))
            if error <= COORDINATE_TOLERANCE:
                candidates.append(error)
    return min(candidates) if candidates else None


def compare_contours(actual, expected, label):
    check(isinstance(actual, list) and len(actual) == len(expected), label + ": contour count changed")
    for contours in (actual, expected):
        for loop in contours:
            check(isinstance(loop, list) and len(loop) >= 3, label + ": invalid contour")
            for point in loop:
                check(len(point) == 2 and all(type(v) in (int, float) and math.isfinite(v) for v in point),
                      label + ": each point needs two finite coordinates")
    unmatched = list(enumerate(actual))
    maximum = 0.0
    reordered = False
    for index, loop in enumerate(expected):
        matches = [(position, original_index, equivalent_loop_error(candidate, loop))
                   for position, (original_index, candidate) in enumerate(unmatched)]
        matches = [match for match in matches if match[2] is not None]
        check(matches, label + ": contour {} has no geometrically equivalent match".format(index))
        position, original_index, error = min(matches, key=lambda match: (match[2], match[1]))
        unmatched.pop(position)
        reordered = reordered or original_index != index
        maximum = max(maximum, error)
    return {"maximumCoordinateError": maximum, "equivalentContourOrderChanged": reordered}


def evenodd_contains(contours, x, y):
    inside = False
    for loop in contours:
        for a, b in zip(loop, loop[1:] + loop[:1]):
            if (a[1] > y) != (b[1] > y) and x < (b[0] - a[0]) * (y - a[1]) / (b[1] - a[1]) + a[0]:
                inside = not inside
    return inside


def reconstruct_regions(shapes, palette, label):
    output = bytearray(64 * 64 * 4)
    covered = set()
    region_ids = set()
    for shape in shapes:
        region = shape["region"]
        check(type(region) is int and region > 0 and region not in region_ids,
              label + ": region IDs must be unique positive integers")
        region_ids.add(region)
        contours = shape["contours"]
        check(isinstance(contours, list) and contours, label + ": region needs contours")
        vertices = []
        for loop in contours:
            check(len(loop) >= 4, label + ": cell-boundary loop requires at least four vertices")
            for point, following in zip(loop, loop[1:] + loop[:1]):
                check(len(point) == 2 and all(type(v) in (int, float) and math.isfinite(v)
                                            and v == int(v) and 0 <= v <= 64 for v in point),
                      label + ": construction boundaries must use integer cell corners")
                check((point[0] == following[0]) != (point[1] == following[1]),
                      label + ": construction boundaries must have nonzero horizontal/vertical edges")
                vertices.append(point)
        pixels = set()
        for y in range(int(min(p[1] for p in vertices)), int(max(p[1] for p in vertices))):
            for x in range(int(min(p[0] for p in vertices)), int(max(p[0] for p in vertices))):
                if evenodd_contains(contours, x + 0.5, y + 0.5):
                    pixels.add(y * 64 + x)
        check(type(shape["pixelArea"]) is int and len(pixels) == shape["pixelArea"] > 0,
              label + ": region {} filled area differs from pixelArea".format(region))
        check(not pixels & covered, label + ": independently traced color regions overlap")
        covered.update(pixels)
        color = bytes(rgb(palette[shape["color"]], label) + (255,))
        for pixel in pixels:
            output[pixel * 4:pixel * 4 + 4] = color
    return bytes(output), len(covered)


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
    region_reports = []
    for index, (element, shape) in enumerate(zip(paths, shapes)):
        label = "{} region {} ({})".format(path.parent.name, shape["region"], shape["part"])
        check(element.get("stroke") == "none", label + ": outline stroke is enabled")
        check(element.get("fill-opacity") is not None and
              svg_number(element.get("fill-opacity"), label) == 1,
              label + ": fill opacity must explicitly be 1")
        check(element.get("fill-rule") == "evenodd", label + ": native fill rule changed")
        expected_hex = palette[shape["color"]]
        actual_hex = element.get("fill")
        differences = [actual - expected for actual, expected in zip(
            rgb(actual_hex, label), rgb(expected_hex, label))]
        check(all(value == 0 for value in differences),
              label + ": native SVG fill must equal the exact construction palette")
        comparison = compare_contours(contours_from_path(element.get("d"), label), shape["contours"], label)
        region_reports.append({
            "index": index, "region": shape["region"], "part": shape["part"], "color": shape["color"],
            "contourCount": len(shape["contours"]), "vertices": sum(len(loop) for loop in shape["contours"]),
            "pixelArea": shape["pixelArea"], **comparison,
            "authoredFill": expected_hex.upper(), "nativeSvgFill": actual_hex.upper(),
            "nativeMinusAuthoredChannels": differences,
        })
    return {
        "pathCount": len(paths), "authoredRegionCount": len(shapes),
        "regionOrderAndContours": "pass", "opaqueFillsWithoutOutlines": "pass",
        "maximumCoordinateError": max(item["maximumCoordinateError"] for item in region_reports),
        "maximumAbsoluteColorChannelError": max(abs(value) for item in region_reports
                                                for value in item["nativeMinusAuthoredChannels"]),
        "regions": region_reports,
    }


def decode_png(path):
    with Image.open(path) as image:
        check(image.format == "PNG" and image.size == (64, 64), str(path) + ": expected a 64x64 PNG")
        check(getattr(image, "n_frames", 1) == 1, str(path) + ": animation is not an idle cell")
        return image.convert("RGBA").tobytes()


def compare_rgba(actual, expected, label):
    check(len(actual) == len(expected) == 64 * 64 * 4, label + ": wrong decoded RGBA size")
    changed = [offset // 4 for offset in range(0, len(actual), 4)
               if actual[offset:offset + 4] != expected[offset:offset + 4]]
    check(not changed, "{}: {} RGBA pixels differ; first changed pixel {}".format(
        label, len(changed), (changed[0] % 64, changed[0] // 64) if changed else None))
    return {"status": "pass", "differentPixels": 0, "comparedPixels": 4096,
            "rgbaSha256": hashlib.sha256(actual).hexdigest(), "transparentRgbIncluded": True}


def inspect_construction_and_png(direction, shapes, palette, geometry):
    construction_relative = "source/construction/{}.png".format(direction)
    construction_path = ROOT / construction_relative
    input_record = geometry["inputs"][direction]
    check(input_record["file"] == construction_relative and
          input_record["sha256"] == fingerprint(construction_path)["sha256"],
          direction + ": construction PNG differs from the geometry's recorded input")
    construction = decode_png(construction_path)
    check(all(value in (0, 255) for value in construction[3::4]), direction + ": construction alpha must be binary")
    recreated, opaque_pixels = reconstruct_regions(shapes, palette, direction)
    check(input_record["opaquePixels"] == opaque_pixels and input_record["regions"] == len(shapes),
          direction + ": geometry input region/area totals are stale")
    construction_parity = compare_rgba(recreated, construction, direction + " independent vector fill")
    final_png = decode_png(ROOT / "frames/{}/idle.png".format(direction))
    png_parity = compare_rgba(final_png, construction, direction + " final PNG versus construction")
    return {"construction": construction_relative, "opaquePixels": opaque_pixels,
            "independentEvenOddFill": construction_parity, "finalPngDecodedRgba": png_parity}


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
        check(len(actual) == len(expected), direction + ": Blender region count changed")
        fill_ids = {}
        maximum = 0.0
        total_contours = 0
        for index, (region, shape) in enumerate(zip(actual, expected)):
            label = "Blender {} region {}".format(direction, shape["region"])
            check(blender_name_matches(region["part"], shape["part"]), label + ": layer/part order changed")
            material_name = region.get("materialName", region.get("color"))
            check(blender_name_matches(material_name, shape["color"]), label + ": palette material changed")
            check(region["hideStroke"] is True and region["cyclic"] is True,
                  label + ": every contour must be cyclic with its stroke hidden")
            fill_id = region["fillId"]
            check(type(fill_id) is int and fill_id > 0, label + ": fill group must be a positive integer")
            previous_ids = fill_ids.setdefault(region["part"], set())
            check(fill_id not in previous_ids, label + ": independent regions share a fill group")
            previous_ids.add(fill_id)
            comparison = compare_contours(region["contours"], shape["contours"], label)
            maximum = max(maximum, comparison["maximumCoordinateError"])
            total_contours += len(region["contours"])
        result[direction] = {"regionCount": len(actual), "contourCount": total_contours,
                             "maximumCoordinateError": maximum,
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
    check(0 < len(palette) <= palette_document["maximumColorsPerFrame"] <= 24,
          "Construction palette exceeds the 24-color contract")
    check(geometry["cell"] == [64, 64] and geometry["feetPivot"] == [32, 56],
          "Authored cell or feet pivot contract changed")
    check(set(geometry["views"]) == set(DIRECTIONS), "Exactly four authored directions are required")
    check(set(geometry["inputs"]) == set(DIRECTIONS), "All four construction input records are required")
    frames = {}
    files = ["source/idle-geometry.json", "source/palette.json", "source/authoring.py",
             "source/export_svg.py", "source/rasterize.cjs", "source/verify_vectors.py",
             "source/build_reference_vectors.py", "source/avatar-1.blend"]
    for direction in DIRECTIONS:
        svg = "svg/{}/idle.svg".format(direction)
        png = "frames/{}/idle.png".format(direction)
        shapes = geometry["views"][direction]
        check(isinstance(shapes, list) and len(shapes) > 0, direction + ": no authored color regions")
        frames[direction] = inspect_svg(ROOT / svg, shapes, palette)
        frames[direction]["constructionParity"] = inspect_construction_and_png(direction, shapes, palette, geometry)
        files.extend((svg, png, "source/construction/{}.png".format(direction)))
    for optional in ("source/blender-environment.json", "source/blender-readback.json",
                     "source/readback.py", "source/make_reference_review.cjs",
                     "reference/reference-manifest.json", "reference/studies/study.cjs",
                     "reference/studies/study.json",
                     "review/qa.json", "review/idle-approval.png", "review/reload-parity.json",
                     "review/user-decisions.json"):
        if (ROOT / optional).is_file():
            files.append(optional)
    report = {
        "schemaVersion": 2, "avatar": "avatar-1", "pose": "idle",
        "mechanicalStatus": "pass", "userIdleApproval": "pending",
        "animationAcceptance": "not-tested", "liveGameAcceptance": "not-tested",
        "scope": "Compound region geometry to native SVG parity, independent even-odd construction-mask parity, and exact decoded final-PNG versus construction RGBA equality",
        "tolerances": {
            "coordinateAbsolute": COORDINATE_TOLERANCE,
            "colorChannelAbsolute": COLOR_CHANNEL_TOLERANCE,
            "colorReason": "Quarter-level material bias compensates Blender's uint8 truncation; native SVG must equal the exact construction palette",
            "contourEquivalence": "Region paint order is exact. Within each region, cyclic start, winding, and contour order may differ under even-odd filling; vertices and topology must match",
            "decodedRgbaDifferentPixels": 0,
        },
        "pngDecoder": {"library": "Pillow", "version": PILLOW_VERSION, "mode": "RGBA",
                       "iccTransformApplied": False},
        "limits": [
            "This script does not open Blender; saved-master readback and reload provenance come from the supplied evidence files",
            "Decoded construction/final PNG pixels are compared exactly; this verifier does not rerun the SVG rasterizer",
            "Construction fidelity to the original concept is a separate review; exact construction parity does not establish aesthetic approval, animation quality, or game acceptance",
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
    print("Source-to-SVG and exact construction-to-PNG parity passed for {} regions across four views.".format(
        sum(frame["pathCount"] for frame in frames.values())))
    print(destination)


if __name__ == "__main__":
    try:
        main()
    except (ValueError, KeyError, OSError, ET.ParseError, TypeError) as error:
        print("Source parity verification failed: " + str(error), file=sys.stderr)
        sys.exit(1)
