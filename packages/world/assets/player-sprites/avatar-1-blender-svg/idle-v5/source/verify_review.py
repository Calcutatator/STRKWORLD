#!/usr/bin/env python3
"""Read-only stale-evidence guard; this cannot judge or attest artistic quality."""
import hashlib
import json
import math
from pathlib import Path
import re
import struct
import sys

ROOT = Path(__file__).resolve().parent.parent
DIRECTIONS = ('down', 'left', 'right', 'up')
SURFACES = ('road', 'pavement', 'grass')
QUESTION = 'Is this in-game result obviously good enough to approve?'
ARTIFACTS = ({f'frames/{d}/idle.png' for d in DIRECTIONS} |
             {f'svg/{d}/idle.svg' for d in DIRECTIONS} |
             {'source/avatar-1.blend', 'source/idle-geometry.json', 'source/palette.json'})
PARITY_INPUTS = ARTIFACTS | {
    'source/blender-readback.json', 'source/blender-environment.json',
    'source/authoring.py', 'source/export_svg.py', 'source/readback.py',
    'source/source_contract.py', 'source/verify_source.py',
    '../concept/approval.json', '../concept/avatar-1-concept-v2.png',
    'review/user-decisions.json', 'source/vectorize_studies.py',
} | {f'source/vectors/{d}-bezier.svg' for d in DIRECTIONS}
PREVIEW_INPUTS = {'main.ts', 'style.css', 'index.html', 'serve.mjs'}
TOWN_INPUTS = {
    'packages/world/src/map/street.ts', 'packages/world/src/kenney-urban.ts',
    'packages/world/src/scenes/street-scene.ts',
    'packages/world/assets/third-party/kenney-rpg-urban/tilemap.png',
}


def require(condition, message):
    if not condition:
        raise ValueError(message)


def object_pairs(pairs):
    result = {}
    for key, value in pairs:
        require(key not in result, 'Duplicate JSON key: ' + key)
        result[key] = value
    return result


def read_json(path):
    return json.loads(path.read_text(), object_pairs_hook=object_pairs,
                      parse_constant=lambda value: (_ for _ in ()).throw(ValueError('Invalid JSON number: ' + value)))


def file_hash(path):
    return hashlib.sha256(path.read_bytes()).hexdigest()


def local_file(root, relative, allow_concept=False):
    require(isinstance(relative, str) and relative and not Path(relative).is_absolute(),
            'Evidence paths must be relative: ' + str(relative))
    target = (root / relative).resolve()
    concept_allowed = allow_concept and relative in {
        '../concept/approval.json', '../concept/avatar-1-concept-v2.png'}
    require(target.is_relative_to(root.resolve()) or
            (concept_allowed and target.parent == (root.parent / 'concept').resolve()),
            'Evidence path escapes its allowed source: ' + relative)
    require(target.is_file(), 'Missing evidence: ' + relative)
    return target


def current_hash(root, relative, expected, allow_concept=False):
    require(isinstance(expected, str) and re.fullmatch(r'[0-9a-f]{64}', expected),
            'Missing or invalid SHA-256: ' + relative)
    path = local_file(root, relative, allow_concept)
    require(file_hash(path) == expected, 'Stale evidence: ' + relative)
    return path


def binding(root, entry, expected_file=None):
    require(isinstance(entry, dict), 'Missing file/hash evidence binding')
    relative = entry['file']
    if expected_file is not None:
        require(relative == expected_file, 'Unexpected evidence file: ' + str(relative))
    return current_hash(root, relative, entry['sha256'])


def png_size(path):
    raw = path.read_bytes()
    require(len(raw) >= 33 and raw[:8] == b'\x89PNG\r\n\x1a\n' and raw[12:16] == b'IHDR',
            'Invalid PNG evidence: ' + path.name)
    size = list(struct.unpack('>II', raw[16:24]))
    require(all(v > 0 for v in size), 'Empty PNG evidence: ' + path.name)
    return size


def positive(value):
    return type(value) in (int, float) and math.isfinite(value) and value > 0


def source_parity(root, report):
    require(report['schemaVersion'] == 1 and report['revision'] == 'idle-v5' and
            report['mechanicalStatus'] == 'pass' and report['directions'] == list(DIRECTIONS),
            'Current complete four-view source parity is required')
    files = report['files']
    require(isinstance(files, dict) and PARITY_INPUTS <= set(files),
            'Source parity omits required current inputs')
    for relative, entry in files.items():
        path = current_hash(root, relative, entry['sha256'], allow_concept=True)
        require(type(entry['bytes']) is int and entry['bytes'] == path.stat().st_size,
                'Stale source parity byte count: ' + relative)
    require(report['blenderReadbackParity']['status'] == 'pass' and
            report['blenderReadbackParity']['masterSha256'] == file_hash(root / 'source/avatar-1.blend'),
            'Saved-master parity is absent or stale')
    require(report['upstreamProvenance']['status'] == 'hashes-match-current-inputs' and
            report['environmentEvidence']['status'] == 'consistent-with-current-artifacts',
            'Source provenance or environment parity is unknown')
    for direction in DIRECTIONS:
        frame = report['frames'][direction]
        require(frame['orderedGeometryAndExactPaletteFills'] == 'pass' and
                frame['embeddedImages'] == 0 and frame['pathCount'] == frame['sourceShapeCount'] and
                type(frame['pathCount']) is int and frame['pathCount'] > 0,
                direction + ': complete native SVG source parity is required')


def raster_parity(root, inspection_hash):
    report = read_json(root / 'review/raster-qa.json')
    require(report['schemaVersion'] == 1 and report['revision'] == 'idle-v5' and
            report['mechanicalStatus'] == 'pass' and report['directions'] == list(DIRECTIONS),
            'Current four-view raster evidence is required')
    source = report['source']
    current_hash(root, source['script'], source['scriptSha256'])
    current_hash(root, 'source/idle-geometry.json', source['geometrySha256'])
    current_hash(root, 'source/palette.json', source['paletteSha256'])
    current_hash(root, '../concept/avatar-1-concept-v2.png', source['conceptSha256'], allow_concept=True)
    require(report['review']['file'] == 'review/idle-inspection.png' and
            report['review']['pngSha256'] == inspection_hash,
            'The inspected source board is not bound to current raster evidence')
    frames = report['frames']
    require(isinstance(frames, list) and len(frames) == 4 and
            {f['frame'] for f in frames} == {f'frames/{d}/idle.png' for d in DIRECTIONS},
            'Raster report must cover all four current frames')
    for frame in frames:
        direction = frame['frame'].split('/')[1]
        require(frame['svg'] == f'svg/{direction}/idle.svg' and frame['dimensions'] == [256, 256],
                'Raster report has an unexpected SVG/frame pairing or size')
        current_hash(root, frame['frame'], frame['pngSha256'])
        current_hash(root, frame['svg'], frame['svgSha256'])


def engine_metadata(root, entry):
    surface = entry['surface']
    viewport_path = binding(root, entry['viewport'], f'review/engine/phaser-{surface}-viewport.png')
    canvas_path = binding(root, entry['canvas'], f'review/engine/phaser-{surface}-canvas.png')
    metadata_path = binding(root, entry['metadata'])
    require(entry['metadata']['file'] in {
        f'review/engine/phaser-{surface}-evidence.raw.json',
        f'review/engine/phaser-{surface}-evidence.json'}, 'Unexpected engine metadata file')
    data = read_json(metadata_path)
    if 'success' in data:  # Original browser-tool envelope, preserved verbatim.
        require(data['success'] is True and data['error'] is None, 'Browser evidence capture failed')
        data = data['data']['result']
    require(data['ready'] is True and data['renderer'] == 'WebGL' and data['errors'] == [] and
            data['previewKind'] == 'isolated-actual-Phaser-street-draft' and
            data['canonicalLiveGameAcceptance'] is False, 'Engine evidence is unready, errored, or outside draft scope')
    require(data['camera']['zoom'] == 2 and data['camera']['actualGameZoom'] == 2,
            'Engine evidence must show the actual game zoom of 2')
    avatar = data['avatar']
    require(avatar['surface'] == surface and avatar['lineup'] is True and
            avatar['logicalCell'] == [64, 64] and avatar['cssCell'] == [128, 128] and
            avatar['sourceCell'] == [256, 256] and avatar['sourceDensity'] == 4 and
            avatar['scale'] == [0.25, 0.25] and avatar['origin'] == [0.5, 0.875] and
            avatar['logicalFeet'] == [32, 56] and avatar['sourceFeet'] == [128, 224] and
            avatar['physicsWorldSize'] == [24, 24], 'Engine lineup, density, scale, feet or body contract differs')
    require(avatar['filters'] == {d: 0 for d in DIRECTIONS} and
            all(type(v) is int for v in avatar['filters'].values()),
            'All four avatar textures must use Phaser LINEAR filtering (0)')
    viewport, canvas = data['viewport'], data['canvas']
    require(all(positive(viewport[k]) for k in ('width', 'height', 'devicePixelRatio')) and
            all(positive(canvas[k]) for k in ('backingWidth', 'backingHeight', 'cssWidth', 'cssHeight')),
            'Viewport, CSS, backing or DPR metadata is missing or invalid')
    require(canvas['backingToCssX'] == canvas['backingWidth'] / canvas['cssWidth'] and
            canvas['backingToCssY'] == canvas['backingHeight'] / canvas['cssHeight'] and
            [64 * 2 * canvas['cssWidth'] / canvas['backingWidth'],
             64 * 2 * canvas['cssHeight'] / canvas['backingHeight']] == [128, 128],
            'Canvas backing-to-CSS scaling contradicts the recorded game CSS size')
    dpr = viewport['devicePixelRatio']
    require(png_size(viewport_path) == [round(viewport['width'] * dpr), round(viewport['height'] * dpr)] and
            png_size(canvas_path) == [round(canvas['cssWidth'] * dpr), round(canvas['cssHeight'] * dpr)],
            'Engine screenshot dimensions disagree with recorded viewport/canvas and DPR')
    frames = data['sourceFrames']
    require(set(frames) == set(DIRECTIONS), 'Engine metadata must identify all four loaded frame sources')
    for direction, frame in frames.items():
        require(frame['present'] is True and frame['width'] == 256 and frame['height'] == 256,
                direction + ': loaded frame is missing or has the wrong size')
        current_hash(root, f'frames/{direction}/idle.png', frame['sha256'])
    for records, expected, base in ((data['previewSources'], PREVIEW_INPUTS, root / 'preview'),
                                    (data['town']['sources'], TOWN_INPUTS, root.parents[5])):
        require(isinstance(records, list) and len(records) == len(expected) and
                {record['path'] for record in records} == expected, 'Engine source inventory is incomplete or unknown')
        for record in records:
            current_hash(base, record['path'], record['sha256'])


def producer_attestation(review):
    require(type(review['schemaVersion']) is int and review['schemaVersion'] == 1 and
            review['revision'] == 'idle-v5', 'Unknown visual review schema/revision')
    require(review['producerPersonallyInspected'] is True and review['question'] == QUESTION and
            review['answer'] == 'yes' and review['knownBlockingDefects'] == [],
            'Producer inspection and an unqualified yes with no known blockers are required')
    require('userApproval' in review and review['userApproval'] is None,
            'This pre-handoff record must keep user approval separate and unset')


def verify(root=ROOT):
    review = read_json(root / 'review/visual-qa.json')
    producer_attestation(review)
    artifacts = review['reviewedArtifacts']
    require(isinstance(artifacts, dict) and ARTIFACTS <= set(artifacts), 'Review omits required source/export hashes')
    for relative, sha256 in artifacts.items():
        path = current_hash(root, relative, sha256)
        if relative in {f'frames/{d}/idle.png' for d in DIRECTIONS}:
            require(png_size(path) == [256, 256], 'Reviewed PNG frame is not 256x256')
    inspection = binding(root, review['sourceEvidence'], 'review/idle-inspection.png')
    png_size(inspection)
    parity_path = binding(root, review['sourceParity'], 'review/source-parity.json')
    source_parity(root, read_json(parity_path))
    raster_parity(root, review['sourceEvidence']['sha256'])
    engines = review['engineEvidence']
    require(isinstance(engines, list) and len(engines) == len(SURFACES) and
            {entry['surface'] for entry in engines} == set(SURFACES),
            'Road, pavement and grass engine evidence are all required exactly once')
    for entry in engines:
        engine_metadata(root, entry)
    decision = read_json(root / 'review/user-decisions.json')
    require(decision['status'] in ('internal-refinement', 'pending') and
            decision['userDecision'] is None and decision['animationAuthorized'] is False and
            decision['runtimeIntegrationAuthorized'] is False,
            'Pre-handoff validation cannot grant user, animation or production integration approval')


def main():
    require(len(sys.argv) == 1, 'Usage: python3 source/verify_review.py')
    verify()
    print('Review evidence is current and records the producer inspection; user approval remains unset.')
    print('Procedural stale-evidence guard only: no automated aesthetic judgment or independent inspection attestation.')


if __name__ == '__main__':
    try:
        main()
    except (OSError, ValueError, KeyError, TypeError, AttributeError, struct.error) as error:
        print('Review evidence rejected: ' + str(error), file=sys.stderr)
        sys.exit(1)
