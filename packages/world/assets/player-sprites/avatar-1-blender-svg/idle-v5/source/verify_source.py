#!/usr/bin/env python3
"""Check technical v5 geometry -> live GP readback -> native SVG parity.

The coordinator must reopen avatar-1.blend and execute readback.py via native
MCP before this script. It checks current hashes and supplied readback data;
it does not independently parse .blend, judge art, or authorize a handoff.
Supports any nonempty subset of the four idle directions. PNGs are optional.
"""
import hashlib
import json
import math
from pathlib import Path
import re
import struct
import sys
import xml.etree.ElementTree as ET
import source_contract as contract

ROOT = Path(__file__).resolve().parent.parent
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
    # All report paths are relative to idle-v5, including ../concept evidence.
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
                      -TOLERANCE <= v <= contract.CANVAS + TOLERANCE for v in point),
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


def inspect_svg(path, shapes, palette):
    raw = path.read_text(encoding="utf-8")
    check(len(raw.encode("utf-8")) <= 32 * 1024 * 1024, str(path) + ": SVG too large")
    check("<!ENTITY" not in raw.upper(), str(path) + ": entities forbidden")
    check(all(name == "xml" for name in re.findall(r"<\?([^\s?]+)", raw)),
          str(path) + ": non-XML processing instructions forbidden")
    without_dtd = STANDARD_DTD.sub("", raw)
    check("<!DOCTYPE" not in without_dtd.upper(), str(path) + ": nonstandard DOCTYPE")
    root = ET.fromstring(without_dtd)
    tag = lambda name: "{" + NS + "}" + name
    check(root.tag == tag("svg"), str(path) + ": SVG namespace/root changed")
    check([number(root.get(k), k) for k in ("width", "height")] == [contract.CANVAS, contract.CANVAS] and
          [number(root.get(k, "0"), k) for k in ("x", "y")] == [0, 0],
          str(path) + ": expected unshifted 512x512 viewport")
    check([number(v, "viewBox") for v in re.split(r"[\s,]+", root.get("viewBox", "").strip())]
          == [0, 0, contract.CANVAS, contract.CANVAS], str(path) + ": viewBox changed")
    clips = list(root.iter(tag("clipPath")))
    check(len(clips) == 1 and clips[0].get("id") and len(clips[0]) == 1 and
          clips[0][0].tag == tag("rect"), str(path) + ": one camera clip required")
    clip, rect = clips[0], clips[0][0]
    check([number(rect.get(k), k) for k in ("x", "y", "width", "height")] == [0, 0, contract.CANVAS, contract.CANVAS]
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


def inspect_readback(document, data, palette):
    master = (ROOT / 'source/avatar-1.blend').resolve()
    check(Path(document['reopenedMaster']).is_absolute() and
          Path(document['reopenedMaster']).resolve() == master and master.is_file(),
          'Readback must identify this revision actual saved master')
    check(document['liveDataIsDirty'] is False and document['masterSha256AtReadback'] == contract.sha256(master),
          'Readback was dirty or its saved master bytes are stale')
    check(document['geometrySha256'] == data['geometrySha256'] and
          document['paletteSha256'] == data['paletteSha256'] and
          document['geometryProvenance'] == data['geometry'].get('provenance', {}),
          'Readback source metadata differs from current geometry/palette')
    check(set(document['views']) == set(data['directions']), 'Readback direction inventory differs')
    views = {}
    for direction in data['directions']:
        transform = document['transforms'][direction]
        check(transform['location'] == [0, 0, 0] and transform['rotationEuler'] == [0, 0, 0] and
              transform['scale'] == [1, 1, 1] and transform['strokeDepthOrder'] == '2D',
              direction + ': unexpected transform or stroke depth ordering')
        actual = document['views'][direction]
        expected = data['geometry']['views'][direction]
        check(len(actual) == len(expected), direction + ': Blender region count differs')
        maximum = 0.0
        for index, (region, shape) in enumerate(zip(actual, expected)):
            label = 'Blender {} shape {}'.format(direction, index)
            check(region['part'] == '{:03d}_{}'.format(index, shape['part']) and
                  region['materialName'] == shape['color'], label + ': ordered part/material changed')
            check(region['fillId'] == 1 and region['hideStroke'] is True and region['cyclic'] is True and
                  region['fillOpacity'] == 1 and region['materialShowFill'] is True and
                  region['materialShowStroke'] is False, label + ': native fill state changed')
            rgba = contract.material_rgba(palette[shape['color']])
            check(len(region['materialLinearRgba']) == 4 and
                  max(abs(a-b) for a,b in zip(region['materialLinearRgba'], rgba)) < 1e-6,
                  label + ': actual linear material fill changed')
            maximum = max(maximum, compare_contours(region['contours'], shape['contours'], label))
        views[direction] = {'shapeCount': len(expected), 'maximumCoordinateError': maximum,
                            'orderedPartsMaterialsContoursAndFillState': 'pass'}
    expected_refs = {data['approval']['sha256']: 'Approved concept identity'}
    expected_refs.update({ref['sha256']: 'Not approved concept art' for ref in data['references']})
    packed = document['packedReferences']
    check(len(packed) == 1 + len(data['references']) and
          {ref['sha256'] for ref in packed} == set(expected_refs), 'Packed reference inventory changed')
    for ref in packed:
        check(ref['packed'] is True and ref['packedBytesSha256'] == ref['sha256'] and
              ref['approvalScope'].startswith(expected_refs[ref['sha256']]),
              'Packed reference bytes or approval label changed')
    return {'status': 'pass', 'blender': document['blender'], 'masterSha256': contract.sha256(master),
            'views': views, 'packedReferences': packed,
            'provenanceLimit': 'Coordinator-managed reload; this verifier checks its supplied live readback and current file hash'}


def inspect_environment(document, data, frames, readback):
    check(document['nativeMcpTools'] is True and document['blender'] == readback['blender'],
          'Native MCP environment and readback disagree')
    check(document['scene'] == 'AV1V5 | Idle authoring' and document['frame'] == 1 and
          document['render'] == [contract.CANVAS, contract.CANVAS] and document['camera'] ==
          {'type': 'ORTHO', 'orthoScale': contract.CANVAS, 'location': [0, -1024, 0]}, 'Environment framing changed')
    check(document['masterSha256'] == contract.sha256(ROOT / 'source/avatar-1.blend') and
          document['geometrySha256'] == data['geometrySha256'] and
          document['paletteSha256'] == data['paletteSha256'] and
          document['conceptSha256'] == data['approval']['sha256'] and
          document['geometryProvenance'] == data['geometry'].get('provenance', {}),
          'Environment source/master metadata is stale')
    check(document['approval'] == 'internal-refinement' and document['artisticQa'] == 'not-assessed',
          'Technical environment must not grant art approval')
    exports = document['exports']
    check(len(exports) == len(data['directions']) and
          {entry['direction'] for entry in exports} == set(data['directions']),
          'Environment export inventory differs')
    for entry in exports:
        direction = entry['direction']; path = 'svg/{}/idle.svg'.format(direction)
        check(entry['svg'] == path and entry['images'] == 0 and
              entry['paths'] == frames[direction]['pathCount'] and entry['sha256'] == contract.sha256(ROOT / path),
              direction + ': environment export metadata is stale')
    return {'status': 'consistent-with-current-artifacts', 'nativeMcpToolsReported': True,
            'scope': 'Supplied native-MCP metadata consistency, not independent transport attestation'}


def main():
    check(len(sys.argv) == 1, 'Usage: python3 source/verify_source.py')
    data = contract.load(ROOT / 'source', require_internal=False)
    palette = {entry['name']: entry['hex'].upper() for entry in data['palette']['colors']}
    readback = read_json(ROOT / 'source/blender-readback.json')
    blender = inspect_readback(readback, data, palette)
    files = ['source/idle-geometry.json', 'source/palette.json', 'source/avatar-1.blend',
             'source/blender-readback.json', 'source/blender-environment.json',
             'source/authoring.py', 'source/export_svg.py', 'source/readback.py',
             'source/source_contract.py', 'source/verify_source.py', '../concept/approval.json',
             '../concept/' + data['approval']['artifact'], 'review/user-decisions.json']
    files.extend(ref['relative'] for ref in data['references'])
    files.extend(data['constructionProvenance']['files'])
    frames = {}
    for direction in data['directions']:
        svg = 'svg/{}/idle.svg'.format(direction)
        frames[direction] = inspect_svg(ROOT / svg, data['geometry']['views'][direction], palette)
        files.append(svg)
        png = 'frames/{}/idle.png'.format(direction)
        if (ROOT / png).is_file():
            raw = (ROOT / png).read_bytes()
            check(len(raw) >= 33 and raw[:8] == b'\x89PNG\r\n\x1a\n' and raw[12:16] == b'IHDR' and
                  struct.unpack('>II', raw[16:24]) == (contract.PNG_SIZE, contract.PNG_SIZE), png + ': invalid 256x256 PNG header')
            frames[direction]['png'] = {'file': png, 'headerDimensions': [contract.PNG_SIZE, contract.PNG_SIZE], 'sourcePixelParity': 'not-asserted'}
            files.append(png)
        else:
            frames[direction]['png'] = {'status': 'not-yet-exported', 'sourcePixelParity': 'not-asserted'}
    environment = inspect_environment(read_json(ROOT / 'source/blender-environment.json'), data, frames, readback)
    report = {'schemaVersion': 1, 'revision': 'idle-v5', 'mechanicalStatus': 'pass',
              'stage': 'internal-refinement', 'directions': data['directions'],
              'conceptApproval': {'status': 'approved', 'sha256': data['approval']['sha256'],
                                  'artifact': '../concept/' + data['approval']['artifact']},
              'artisticQuality': 'not-assessed', 'userIdleApproval': 'not-established',
              'animationAcceptance': 'not-tested', 'gameAcceptance': 'not-tested',
              'scope': 'Current upstream input bindings and geometry/palette to supplied live GP readback and native SVG path/fill parity',
              'coordinateTolerance': TOLERANCE,
              'limits': ['The coordinator performs reopening; this script does not independently open or parse .blend.',
                         'Construction-study hashes and declared high-detail input files are checked; the vectorizer is inventoried but not replayed here.',
                         'PNG headers and hashes are optional inventory only; this script does not compare PNG pixels.',
                         'A partial view inventory is a valid internal construction experiment, not a complete sprite set.',
                         'Technical parity says nothing about likeness, beauty, readability, visual QA, or readiness for handoff.'],
              'upstreamProvenance': data['constructionProvenance'],
              'blenderReadbackParity': blender, 'environmentEvidence': environment,
              'frames': frames, 'files': {name: fingerprint(ROOT / name) for name in files}}
    destination = ROOT / 'review/source-parity.json'; destination.parent.mkdir(parents=True, exist_ok=True)
    destination.write_text(json.dumps(report, indent=2) + '\n')
    print('Verified {} ordered regions across {} declared view(s); technical Blender/SVG parity only.'.format(
        sum(frame['pathCount'] for frame in frames.values()), len(frames)))
    print(destination)


if __name__ == '__main__':
    try:
        main()
    except (ValueError, KeyError, OSError, TypeError, ET.ParseError, struct.error) as error:
        print('Source verification failed: ' + str(error), file=sys.stderr)
        sys.exit(1)
