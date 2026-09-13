#!/usr/bin/env python3
"""Verify idle-v3 source geometry, supplied Blender readback and native SVGs.

Run with Python 3.9+ from any directory, after the coordinator has reopened
source/avatar-1.blend in Blender and run readback.py through native MCP.
Writes review/source-parity.json only after every check passes. Uses stdlib
only; does not call Blender, rasterize SVGs, or compare source/PNG pixels.
"""

import hashlib
import importlib.util
import json
import math
from pathlib import Path
import re
import struct
import sys
import xml.etree.ElementTree as ET


ROOT = Path(__file__).resolve().parent.parent
DIRECTIONS = ("down", "left", "right", "up")
TOLERANCE = 0.0002
NS = "http://www.w3.org/2000/svg"
NUMBER = r"[-+]?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][-+]?\d+)?"
TOKENS = re.compile(r"[MLZz]|" + NUMBER)
STANDARD_DTD = re.compile(
    r'<!DOCTYPE\s+svg\s+PUBLIC\s+"-//W3C//DTD SVG 1\.1//EN"\s+'
    r'"http://www\.w3\.org/Graphics/SVG/1\.1/DTD/svg11\.dtd"\s*>')


def check(condition, message):
    if not condition:
        raise ValueError(message)


def read_json(path):
    return json.loads(path.read_text(encoding="utf-8"))


def fingerprint(path):
    raw = path.read_bytes()
    check(raw, str(path) + ": empty artifact")
    return {"bytes": len(raw), "sha256": hashlib.sha256(raw).hexdigest()}


def relative(path):
    # All report paths are relative to idle-v3, including ../concept evidence.
    import os
    return Path(os.path.relpath(path, ROOT)).as_posix()


def number(value, label):
    check(isinstance(value, str) and re.fullmatch(NUMBER + r"(?:px)?", value),
          label + ": invalid numeric attribute")
    result = float(value[:-2] if value.endswith("px") else value)
    check(math.isfinite(result), label + ": nonfinite number")
    return result


def color(value, label):
    check(isinstance(value, str) and re.fullmatch(r"#[0-9a-fA-F]{6}", value),
          label + ": expected an exact #RRGGBB fill")
    return value.upper()


def validate_contours(contours, label):
    check(isinstance(contours, list) and contours, label + ": no contours")
    for loop in contours:
        check(isinstance(loop, list) and len(loop) >= 3, label + ": invalid loop")
        for point in loop:
            check(isinstance(point, list) and len(point) == 2 and
                  all(type(v) in (int, float) and math.isfinite(v) and
                      -TOLERANCE <= v <= 64 + TOLERANCE for v in point),
                  label + ": expected finite in-canvas XY points")


def loop_error(actual, expected):
    if len(actual) != len(expected):
        return None
    for orientation in (expected, list(reversed(expected))):
        for offset, point in enumerate(orientation):
            if max(abs(a - b) for a, b in zip(actual[0], point)) > TOLERANCE:
                continue
            ordered = orientation[offset:] + orientation[:offset]
            error = max(abs(a - b) for got, want in zip(actual, ordered)
                        for a, b in zip(got, want))
            if error <= TOLERANCE:
                return error
    return None


def compare_contours(actual, expected, label):
    validate_contours(actual, label)
    validate_contours(expected, label)
    check(len(actual) == len(expected), label + ": contour count changed")
    remaining = list(actual)
    maximum = 0.0
    for index, expected_loop in enumerate(expected):
        candidates = [(i, loop_error(loop, expected_loop))
                      for i, loop in enumerate(remaining)]
        matches = [(i, error) for i, error in candidates if error is not None]
        check(matches, label + ": contour {} differs from source".format(index))
        i, error = min(matches, key=lambda item: item[1])
        remaining.pop(i)
        maximum = max(maximum, error)
    return maximum


def path_contours(data, label):
    check(isinstance(data, str) and data, label + ": missing path data")
    check(not re.sub(r"[\s,]", "", TOKENS.sub("", data)),
          label + ": expected native absolute M/L/close path syntax")
    tokens = TOKENS.findall(data)
    index, contours = 0, []
    while index < len(tokens):
        points = []
        while index < len(tokens) and tokens[index] not in ("Z", "z"):
            check(tokens[index] == ("M" if not points else "L"),
                  label + ": each contour requires M followed by explicit L commands")
            values = tokens[index + 1:index + 3]
            check(len(values) == 2 and all(re.fullmatch(NUMBER, v) for v in values),
                  label + ": incomplete coordinate pair")
            points.append([float(v) for v in values])
            index += 3
        check(index < len(tokens) and tokens[index] in ("Z", "z"),
              label + ": unclosed path")
        contours.append(points)
        index += 1
    validate_contours(contours, label)
    return contours


def inspect_approval(geometry, design):
    concept_dir = ROOT.parent / "concept"
    approval_path = concept_dir / "approval.json"
    approval = read_json(approval_path)
    check(approval["status"] == "approved" and approval["revision"] == "concept-v2",
          "Exact fresh concept-v2 approval is required")
    concept_path = (concept_dir / approval["artifact"]).resolve()
    check(concept_path == concept_dir / "avatar-1-concept-v2.png",
          "Approval points to a different concept image")
    digest = fingerprint(concept_path)["sha256"]
    decision = approval["userDecision"]
    check(decision["decision"] == "approved" and decision["reviewer"] == "James" and
          decision["quote"] == "Yes good concept move forward" and
          decision["artifact"] == approval["artifact"] and
          decision["sha256"] == approval["sha256"] == digest,
          "Explicit concept approval does not match the current image")
    check(geometry["conceptSha256"] == design["approvedConceptSha256"] == digest,
          "Source geometry/design contract is bound to a different concept")
    check((ROOT / "source" / design["approvedConcept"]).resolve() == concept_path,
          "Design contract points to a different concept")
    return {"status": "approved", "artifact": relative(concept_path),
            "sha256": digest, "record": relative(approval_path),
            "scope": "Concept identity only; no sprite, animation or game approval"}


def inspect_readback(document, geometry):
    master = (ROOT / "source/avatar-1.blend").resolve()
    declared = Path(document["reopenedMaster"])
    check(declared.is_absolute() and declared.resolve() == master and master.is_file(),
          "Readback must identify this revision's actual absolute saved-master path")
    check(isinstance(document["blender"], str) and document["blender"],
          "Readback must identify the Blender version")
    check(set(document["views"]) == set(DIRECTIONS), "Readback needs exactly four views")
    views = {}
    for direction in DIRECTIONS:
        actual, expected = document["views"][direction], geometry["views"][direction]
        check(isinstance(actual, list) and len(actual) == len(expected),
              direction + ": Blender region count differs from source")
        maximum = 0.0
        for index, (region, shape) in enumerate(zip(actual, expected)):
            label = "Blender {} shape {}".format(direction, index)
            check(region["part"] == "{:03d}_{}".format(index, shape["part"]),
                  label + ": source part/order changed")
            check(region.get("materialName", region.get("color")) == shape["color"],
                  label + ": palette material changed")
            check(type(region["fillId"]) is int and region["fillId"] > 0 and
                  region["hideStroke"] is True and region["cyclic"] is True,
                  label + ": filled cyclic hidden-stroke state required")
            maximum = max(maximum, compare_contours(region["contours"], shape["contours"], label))
        views[direction] = {"shapeCount": len(expected), "maximumCoordinateError": maximum,
                            "orderedPartsMaterialsContoursAndFillState": "pass"}
    return {"status": "pass", "reopenedMaster": str(master),
            "masterSha256": fingerprint(master)["sha256"], "blender": document["blender"],
            "views": views,
            "provenanceLimit": "Checks the supplied readback's declared master path and geometry; the coordinator performed reopening. This script does not independently open or parse the .blend."}


def inspect_svg(path, shapes, palette):
    raw = path.read_text(encoding="utf-8")
    check(len(raw.encode("utf-8")) <= 8 * 1024 * 1024, str(path) + ": SVG too large")
    check("<!ENTITY" not in raw.upper(), str(path) + ": entities forbidden")
    check(all(name == "xml" for name in re.findall(r"<\?([^\s?]+)", raw)),
          str(path) + ": non-XML processing instructions forbidden")
    without_dtd = STANDARD_DTD.sub("", raw)
    check("<!DOCTYPE" not in without_dtd.upper(), str(path) + ": nonstandard DOCTYPE")
    root = ET.fromstring(without_dtd)
    tag = lambda name: "{" + NS + "}" + name
    check(root.tag == tag("svg"), str(path) + ": SVG namespace/root changed")
    check([number(root.get(k), k) for k in ("width", "height")] == [64, 64] and
          [number(root.get(k, "0"), k) for k in ("x", "y")] == [0, 0],
          str(path) + ": expected unshifted 64x64 viewport")
    check([number(v, "viewBox") for v in re.split(r"[\s,]+", root.get("viewBox", "").strip())]
          == [0, 0, 64, 64], str(path) + ": viewBox changed")
    clips = list(root.iter(tag("clipPath")))
    check(len(clips) == 1 and clips[0].get("id") and len(clips[0]) == 1 and
          clips[0][0].tag == tag("rect"), str(path) + ": one camera clip required")
    clip, rect = clips[0], clips[0][0]
    check([number(rect.get(k), k) for k in ("x", "y", "width", "height")] == [0, 0, 64, 64]
          and rect.get("fill") == "none", str(path) + ": camera clip changed")
    allowed_tags = {tag(name) for name in ("svg", "g", "clipPath", "rect", "path")}
    allowed_attrs = {"version", "x", "y", "width", "height", "viewBox", "id", "clip-path",
                     "d", "fill-rule", "fill", "stroke", "fill-opacity", "opacity", "stroke-opacity"}
    ids, paths = set(), []
    for element in root.iter():
        check(element.tag in allowed_tags and set(element.attrib) <= allowed_attrs,
              str(path) + ": unsupported element/attribute (including images, resources, transforms or filters)")
        check(element.tag != tag("svg") or element is root, "Nested SVG viewport forbidden")
        check(element.tag != tag("rect") or element is rect, "Non-path artwork forbidden")
        if element.get("id") is not None:
            check(element.get("id") not in ids, str(path) + ": duplicate SVG id")
            ids.add(element.get("id"))
        if element.get("clip-path") is not None:
            check(element.get("clip-path") == "url(#{})".format(clip.get("id")), "Unexpected clipping")
        for attr in ("opacity", "fill-opacity", "stroke-opacity"):
            if element.get(attr) is not None:
                check(number(element.get(attr), attr) == 1, str(path) + ": partial opacity")
        if element.tag == tag("path"):
            paths.append(element)
    check(len(paths) == len(shapes), str(path) + ": SVG/source path count differs")
    maximum = 0.0
    for index, (element, shape) in enumerate(zip(paths, shapes)):
        label = "{} SVG shape {}".format(path.parent.name, index)
        check(element.get("stroke") == "none" and element.get("fill-rule") == "evenodd" and
              number(element.get("fill-opacity"), label) == 1, label + ": native fill state changed")
        check(color(element.get("fill"), label) == palette[shape["color"]],
              label + ": native fill differs from exact source palette")
        maximum = max(maximum, compare_contours(
            path_contours(element.get("d"), label), shape["contours"], label))
    return {"pathCount": len(paths), "sourceShapeCount": len(shapes), "embeddedImages": 0,
            "orderedGeometryAndExactPaletteFills": "pass", "maximumCoordinateError": maximum}


def inspect_environment(document, geometry, frames, readback):
    check(document["nativeMcpTools"] is True and document["blender"] == readback["blender"],
          "Environment/readback must identify native MCP and the same Blender version")
    check(document["scene"] == "AV1V3 | Idle authoring" and document["frame"] == 1 and
          document["render"] == [64, 64] and document["camera"]["type"] == "ORTHO" and
          document["camera"]["orthoScale"] == 64 and document["camera"]["location"] == [0, -128, 0],
          "Environment framing differs from idle-v3 authoring")
    expected_paths = {"master": "source/avatar-1.blend", "construction": "source/idle-geometry.json",
                      "palette": "source/palette.json", "reference": "../concept/avatar-1-concept-v2.png"}
    check(all(document.get(key) == value for key, value in expected_paths.items()) and
          document["conceptSha256"] == geometry["conceptSha256"], "Environment source binding changed")
    exports = document["exports"]
    check(isinstance(exports, list) and len(exports) == 4 and
          {item["direction"] for item in exports} == set(DIRECTIONS), "Four export records required")
    for item in exports:
        direction = item["direction"]
        check(item["svg"] == "svg/{}/idle.svg".format(direction) and item["images"] == 0 and
              item["paths"] == frames[direction]["pathCount"], "Environment export inventory is stale")
    return {"status": "consistent-with-current-artifacts", "nativeMcpToolsReported": True,
            "scope": "Validate supplied native-MCP environment metadata, not independent MCP transport attestation"}


def main():
    # Tie the authored path files to the sampled geometry as well as the
    # geometry to the actual native source. A changed recipe cannot hide
    # behind a still-matching previous readback.
    spec = importlib.util.spec_from_file_location('avatar_curve_sampler', ROOT / 'source/build_geometry.py')
    sampler = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(sampler)
    sampled = read_json(ROOT / 'source/idle-geometry.json')
    for filename in ('front-back.json', 'profiles.json'):
        for direction, shapes in read_json(ROOT / 'source' / filename).items():
            expected = [{'part': s['part'], 'color': s['color'], 'contours': sampler.sample_path(s['d'])} for s in shapes]
            check(sampled['views'][direction] == expected, direction + ': authored paths differ from sampled geometry; rebuild before verification')
    check(len(sys.argv) == 1, "Usage: python3 source/verify_source.py")
    geometry = read_json(ROOT / "source/idle-geometry.json")
    design = read_json(ROOT / "source/design-contract.json")
    palette_doc = read_json(ROOT / "source/palette.json")
    check(geometry["revision"] == design["revision"] == "idle-v3" and
          set(geometry["views"]) == set(DIRECTIONS), "Source must contain exactly four idle-v3 views")
    colors = palette_doc["colors"]
    palette = {item["name"]: color(item["hex"], "palette") for item in colors}
    check(len(palette) == len(colors) and 0 < len(palette) <= palette_doc["maximumColorsPerFrame"] <= 24,
          "Palette names/count violate the source contract")
    check(palette == {name: color(value, "design palette") for name, value in design["palette"].items()},
          "Generated palette differs from the authored design contract")
    for direction, shapes in geometry["views"].items():
        check(isinstance(shapes, list) and shapes, direction + ": empty source")
        for shape in shapes:
            check(isinstance(shape["part"], str) and shape["part"] and shape["color"] in palette,
                  direction + ": invalid part or palette reference")
            validate_contours(shape["contours"], direction)
    approval = inspect_approval(geometry, design)
    readback = read_json(ROOT / "source/blender-readback.json")
    blender = inspect_readback(readback, geometry)
    paths = ["source/idle-geometry.json", "source/palette.json", "source/design-contract.json",
             "source/avatar-1.blend", "source/blender-readback.json", "source/blender-environment.json",
             "source/readback.py", "source/verify_source.py", "source/authoring.py", "source/export_svg.py",
             "source/build_geometry.py", "source/rasterize.cjs", "source/front-back.json", "source/profiles.json",
             "../concept/approval.json", "../concept/avatar-1-concept-v2.png"]
    frames = {}
    for direction in DIRECTIONS:
        svg, png = "svg/{}/idle.svg".format(direction), "frames/{}/idle.png".format(direction)
        frames[direction] = inspect_svg(ROOT / svg, geometry["views"][direction], palette)
        png_bytes = (ROOT / png).read_bytes()
        check(len(png_bytes) >= 33 and png_bytes[:8] == b"\x89PNG\r\n\x1a\n" and
              png_bytes[12:16] == b"IHDR" and struct.unpack(">II", png_bytes[16:24]) == (64, 64),
              png + ": expected PNG header and 64x64 dimensions")
        frames[direction]["png"] = {"file": png, "headerDimensions": [64, 64],
                                      "sourcePixelParity": "not-asserted"}
        paths.extend((svg, png))
    environment = inspect_environment(read_json(ROOT / "source/blender-environment.json"),
                                      geometry, frames, readback)
    report = {"schemaVersion": 1, "revision": "idle-v3", "mechanicalStatus": "pass",
              "conceptApproval": approval, "userIdleApproval": "not-established-by-this-verifier",
              "animationAcceptance": "not-tested", "gameAcceptance": "not-tested",
              "scope": "Source contours/materials to supplied reopened-master readback and native SVG geometry/fill parity; current artifact hashes",
              "coordinateTolerance": TOLERANCE,
              "contourEquivalence": "Exact shape paint order; cyclic start, winding and contour order may differ within even-odd fills. Vertex count and coordinates must match.",
              "sourceToPngPixelParity": "not-asserted: smooth vector rasterization and deliberate binary-alpha/palette treatment are separate from source contour parity",
              "limits": ["No Blender or MCP call is performed; reopening provenance is supplied by the coordinator and evidence files.",
                         "The report binds the declared reopened master path and current binary hash; it does not independently parse .blend contents.",
                         "PNG header dimensions and file hashes are recorded; PNG pixels are not decoded and SVG rasterization is not rerun.",
                         "No likeness, artistic approval, animation, or live-game claim follows from mechanical parity."],
              "blenderReadbackParity": blender, "environmentEvidence": environment,
              "frames": frames, "files": {name: fingerprint(ROOT / name) for name in paths}}
    destination = ROOT / "review/source-parity.json"
    destination.parent.mkdir(parents=True, exist_ok=True)
    destination.write_text(json.dumps(report, indent=2) + "\n", encoding="utf-8")
    print("Verified {} source shapes across four views; Blender/SVG contour and fill checks passed.".format(
        sum(frame["pathCount"] for frame in frames.values())))
    print(destination)


if __name__ == "__main__":
    try:
        main()
    except (ValueError, KeyError, OSError, TypeError, ET.ParseError, struct.error) as error:
        print("Source verification failed: " + str(error), file=sys.stderr)
        sys.exit(1)
