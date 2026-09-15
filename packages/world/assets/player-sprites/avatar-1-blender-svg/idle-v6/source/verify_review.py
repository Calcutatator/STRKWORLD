#!/usr/bin/env python3
"""Read-only handoff-evidence guard; never judges art or grants user approval."""
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
REFERENCE_HASHES = {
    '../concept/avatar-1-concept-v2.png': '8c0d58a07d1372d2e8c9bcdbddac6e997763a8ffd2b910be83e8ec47b69f1c92',
    '../reference/approved-concept-turnaround.png': 'f1de96b3038042aaca726c18ae87fe374e8dac2bbda7d0a2359d53f44ad08ed4',
}
EXTERNAL_FILES = set(REFERENCE_HASHES) | {'../concept/approval.json', '../reference/reference-manifest.json'}
ARTIFACTS = ({f'frames/{d}/idle.png' for d in DIRECTIONS} |
             {f'svg/{d}/idle.svg' for d in DIRECTIONS} |
             {'source/avatar-1.blend', 'source/idle-geometry.json', 'source/palette.json'})
PARITY_INPUTS = ARTIFACTS | {
    'source/blender-readback.json', 'source/blender-environment.json',
    'source/authoring.py', 'source/export_svg.py', 'source/readback.py',
    'source/source_contract.py', 'source/verify_source.py',
    'review/user-decisions.json',
} | EXTERNAL_FILES
AUTHORING_INPUTS = {
    'source/artist-grid.json', 'source/idle-geometry.json', 'source/avatar-1.blend',
    'source/authoring.py', 'source/export_svg.py', 'source/readback.py',
    'source/blender-readback.json', 'source/source_contract.py', 'source/verify_source.py',
} | {f'svg/{d}/idle.svg' for d in DIRECTIONS}
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


def local_file(root, relative, allow_references=False):
    require(isinstance(relative, str) and relative and not Path(relative).is_absolute(),
            'Evidence paths must be nonempty relative paths: ' + str(relative))
    target = (root / relative).resolve()
    allowed_external = allow_references and relative in EXTERNAL_FILES
    require(target.is_relative_to(root.resolve()) or
            (allowed_external and target == (root.parent / relative.removeprefix('../')).resolve()),
            'Evidence path escapes its allowed source: ' + relative)
    require(target.is_file(), 'Missing evidence: ' + relative)
    return target


def current_hash(root, relative, expected, allow_references=False):
    require(isinstance(expected, str) and re.fullmatch(r'[0-9a-f]{64}', expected),
            'Missing or invalid SHA-256: ' + relative)
    path = local_file(root, relative, allow_references)
    require(file_hash(path) == expected, 'Stale evidence: ' + relative)
    return path


def inventoried_file(root, inventory, relative):
    require(relative in inventory, 'Producer fileInventory omits inspected evidence: ' + str(relative))
    return current_hash(root, relative, inventory[relative], allow_references=True)


def png_size(path):
    raw = path.read_bytes()
    require(len(raw) >= 33 and raw[:8] == b'\x89PNG\r\n\x1a\n' and raw[12:16] == b'IHDR',
            'Invalid PNG evidence: ' + path.name)
    dimensions = list(struct.unpack('>II', raw[16:24]))
    require(all(value > 0 for value in dimensions), 'Empty PNG evidence: ' + path.name)
    return dimensions


def positive(value):
    return type(value) in (int, float) and math.isfinite(value) and value > 0


def source_parity(root, report, inventory):
    require(report['schemaVersion'] == 1 and report['revision'] == 'idle-v6' and
            report['mechanicalStatus'] == 'pass' and report['directions'] == list(DIRECTIONS),
            'Current complete four-view v6 source parity is required')
    files = report['files']
    require(isinstance(files, dict) and PARITY_INPUTS <= set(files),
            'Source parity omits required source and reference inputs')
    require(set(files) <= set(inventory), 'Producer fileInventory omits source-parity inputs')
    for relative, entry in files.items():
        path = current_hash(root, relative, entry['sha256'], allow_references=True)
        require(inventory[relative] == entry['sha256'] and type(entry['bytes']) is int and
                entry['bytes'] == path.stat().st_size, 'Source parity hash/byte count differs: ' + relative)
    require(report['blenderReadbackParity']['status'] == 'pass' and
            report['blenderReadbackParity']['masterSha256'] == file_hash(root / 'source/avatar-1.blend'),
            'Saved-master parity is absent or stale')
    require(report['upstreamProvenance']['status'] == 'hashes-match-current-inputs' and
            report['environmentEvidence']['status'] == 'consistent-with-current-artifacts',
            'Source provenance or environment parity is unknown')
    require(report['conceptApproval']['status'] == 'approved' and
            report['conceptApproval']['artifact'] == '../concept/avatar-1-concept-v2.png' and
            report['conceptApproval']['sha256'] == REFERENCE_HASHES['../concept/avatar-1-concept-v2.png'] and
            report['spriteStyleAuthority']['artifact'] == '../reference/approved-concept-turnaround.png' and
            report['spriteStyleAuthority']['sha256'] == REFERENCE_HASHES['../reference/approved-concept-turnaround.png'],
            'Source parity must bind both exact visual authorities')
    pixel = report['pixelContract']
    require(pixel['cell'] == [64, 64] and pixel['feetPivot'] == [32, 56] and pixel['pngDensity'] == 1 and
            pixel['maximumOpaqueColorsGlobal'] == 32 and pixel['alpha'] == 'binary' and
            type(pixel['authoredPaletteColors']) is int and 0 < pixel['authoredPaletteColors'] <= 32,
            'Source pixel contract differs from the native 64px draft')
    require(set(report['frames']) == set(DIRECTIONS), 'Source parity frame inventory differs')
    global_colors = set()
    for direction in DIRECTIONS:
        frame = report['frames'][direction]
        require(frame['orderedGeometryAndExactPaletteFills'] == 'pass' and frame['embeddedImages'] == 0 and
                frame['pathCount'] == frame['sourceShapeCount'] and type(frame['pathCount']) is int and
                frame['pathCount'] > 0, direction + ': complete native SVG source parity is required')
        png = frame['png']
        require(png['file'] == f'frames/{direction}/idle.png' and png['dimensions'] == [64, 64] and
                png['pngDensity'] == 1 and png['alpha'] == 'binary' and png['sourcePixelParity'] == 'pass',
                direction + ': complete exact PNG pixel parity is required')
        colors = png['opaqueColors']
        require(isinstance(colors, list) and len(colors) == len(set(colors)) == png['opaqueColorCount'] and
                0 < len(colors) <= 32 and all(isinstance(c, str) and re.fullmatch(r'#[0-9A-F]{6}', c) for c in colors),
                direction + ': invalid opaque palette inventory')
        global_colors.update(colors)
    require(type(pixel['renderedOpaqueColorsGlobal']) is int and
            len(global_colors) == pixel['renderedOpaqueColorsGlobal'] and 0 < len(global_colors) <= 32,
            'Rendered global palette count is inconsistent or exceeds 32')


def source_records(root, records, expected, base, inventory=None, inventory_prefix=''):
    require(isinstance(records, list) and len(records) == len(expected) and
            {record['path'] for record in records} == expected, 'Engine source inventory is incomplete or unknown')
    for record in records:
        require('present' not in record or record['present'] is True, 'Engine source was absent: ' + record['path'])
        current_hash(base, record['path'], record['sha256'])
        if inventory is not None:
            relative = inventory_prefix + record['path']
            inventoried_file(root, inventory, relative)
            require(inventory[relative] == record['sha256'], 'Engine/producer source hash differs: ' + relative)


def engine_metadata(root, entry, inventory):
    surface = entry['surface']
    for kind in ('viewport', 'canvas', 'evidence'):
        expected = f'review/phaser-{surface}-' + (f'{kind}.png' if kind != 'evidence' else 'evidence.raw.json')
        require(entry[kind] == expected, 'Unexpected engine capture path: ' + str(entry[kind]))
    viewport_path = inventoried_file(root, inventory, entry['viewport'])
    canvas_path = inventoried_file(root, inventory, entry['canvas'])
    envelope = read_json(inventoried_file(root, inventory, entry['evidence']))
    require(envelope['success'] is True and envelope.get('error') is None,
            'Browser evidence capture failed')
    data = envelope['data']['result']
    require(data['ready'] is True and data['readyForReview'] is True and data['reviewStatus'] == 'pending' and
            data['stage'] == 'isolated-idle-review-candidate' and data['renderer'] == 'WebGL' and
            data['errors'] == [] and data['previewKind'] == 'isolated-actual-Phaser-street-draft' and
            data['canonicalLiveGameAcceptance'] is False and
            isinstance(data['phaserVersion'], str) and re.fullmatch(r'\d+\.\d+\.\d+(?:[-+].*)?', data['phaserVersion']),
            'Engine evidence is unready, errored, or outside the pending Phaser draft')
    require(data['camera']['zoom'] == 2 and data['camera']['actualGameZoom'] == 2,
            'Engine capture must show the actual game zoom of 2')
    avatar = data['avatar']
    require(avatar['surface'] == surface and avatar['lineup'] is True and
            avatar['logicalCell'] == [64, 64] and avatar['cssCell'] == [128, 128] and
            avatar['sourceCell'] == [64, 64] and avatar['sourceDensity'] == 1 and
            avatar['scale'] == [1, 1] and avatar['origin'] == [0.5, 0.875] and
            avatar['logicalFeet'] == [32, 56] and avatar['sourceFeet'] == [32, 56] and
            avatar['physicsSourceSize'] == [24, 24] and avatar['physicsSourceOffset'] == [20, 44] and
            avatar['physicsWorldSize'] == [24, 24] and avatar['filterName'] == 'NEAREST' and
            avatar['binaryAlphaRequired'] is True and avatar['opaquePaletteLimit'] == 32,
            'Engine lineup, native64 density, feet, body or pixel contract differs')
    require(avatar['filters'] == {d: 1 for d in DIRECTIONS} and
            all(type(value) is int for value in avatar['filters'].values()),
            'All four avatar textures must use Phaser NEAREST filtering (1)')
    viewport, canvas = data['viewport'], data['canvas']
    require(viewport == {'width': 1280, 'height': 900, 'devicePixelRatio': 1},
            'Review captures require viewport 1280x900 at DPR 1')
    require(all(positive(canvas[key]) for key in ('backingWidth', 'backingHeight', 'cssWidth', 'cssHeight')),
            'Canvas CSS/backing dimensions are missing or invalid')
    require(canvas['backingToCssX'] == canvas['backingWidth'] / canvas['cssWidth'] == 1 and
            canvas['backingToCssY'] == canvas['backingHeight'] / canvas['cssHeight'] == 1,
            'Canvas scaling contradicts actual 128px CSS cells at zoom 2')
    require(png_size(viewport_path) == [1280, 900] and
            png_size(canvas_path) == [round(canvas['cssWidth']), round(canvas['cssHeight'])],
            'Capture dimensions disagree with viewport/canvas evidence')
    frames = data['sourceFrames']
    require(isinstance(frames, dict) and set(frames) == set(DIRECTIONS),
            'Engine metadata must identify all four loaded PNG sources')
    for direction, frame in frames.items():
        relative = f'frames/{direction}/idle.png'
        require(frame['present'] is True and frame['width'] == 64 and frame['height'] == 64 and
                Path(frame['path']).resolve() == (root / relative).resolve(),
                direction + ': loaded frame is absent, has the wrong size or belongs to another revision')
        current_hash(root, relative, frame['sha256'])
        require(inventory[relative] == frame['sha256'], direction + ': engine frame differs from inspected PNG')
    require(set(data['references']) == {'concept', 'style'}, 'Engine reference inventory differs')
    for role, relative in (('concept', '../concept/avatar-1-concept-v2.png'),
                           ('style', '../reference/approved-concept-turnaround.png')):
        reference = data['references'][role]
        path = current_hash(root, relative, REFERENCE_HASHES[relative], allow_references=True)
        require(reference['sha256'] == REFERENCE_HASHES[relative] and
                Path(reference['path']).resolve() == path and
                [reference['width'], reference['height']] == png_size(path),
                'Engine ' + role + ' reference changed')
    repository = root.parents[5].resolve()
    require(Path(data['repositoryRoot']).resolve() == repository and
            Path(data['worktree']['path']).resolve() == repository, 'Engine serves another worktree')
    source_records(root, data['authoringSources'], AUTHORING_INPUTS, root, inventory)
    source_records(root, data['previewSources'], PREVIEW_INPUTS, root / 'preview', inventory, 'preview/')
    source_records(root, data['town']['sources'], TOWN_INPUTS, repository)
    decision = data['reviewDecision']
    require(Path(decision['path']).resolve() == (root / 'review/user-decisions.json').resolve() and
            decision['sha256'] == file_hash(root / 'review/user-decisions.json') and
            decision['userDecision'] is None and decision['readyForReview'] is True,
            'Engine approval-state evidence is stale or claims user approval')


def verify(root=ROOT):
    root = root.resolve()
    review = read_json(root / 'review/visual-qa.json')
    require(review['revision'] == 'idle-v6' and review['producerQuestion'] == QUESTION and
            review['answer'] == 'yes' and review['producerPersonallyInspected'] is True and
            review['comparedBothReferences'] is True and review['blockingDefects'] == [],
            'Producer must personally inspect both references and the engine, answer yes, and have no blockers')
    inventory = review['fileInventory']
    required = PARITY_INPUTS | AUTHORING_INPUTS | {'review/source-parity.json', 'source/verify_review.py'} | \
        {'preview/' + name for name in PREVIEW_INPUTS}
    require(isinstance(inventory, dict) and required <= set(inventory),
            'Producer fileInventory omits required source, preview, export or reference evidence')
    for relative, sha256 in inventory.items():
        path = current_hash(root, relative, sha256, allow_references=True)
        if relative in {f'frames/{d}/idle.png' for d in DIRECTIONS}:
            require(png_size(path) == [64, 64], 'Reviewed PNG frame is not native64')
    for relative, digest in REFERENCE_HASHES.items():
        require(inventory[relative] == digest, 'Producer review substitutes a visual authority')
    source_parity(root, read_json(root / 'review/source-parity.json'), inventory)
    decision = read_json(root / 'review/user-decisions.json')
    require(decision['revision'] == 'idle-v6' and decision['status'] == 'pending' and
            decision['readyForReview'] is True and decision['userDecision'] is None and
            decision['animationAuthorized'] is False and decision['runtimeIntegrationAuthorized'] is False,
            'Handoff requires pending exact-idle approval, with animation and integration unauthorized')
    hashes = decision['reviewedHashes']
    require(isinstance(hashes, dict) and ARTIFACTS <= set(hashes),
            'Pending decision omits exact reviewed source/export hashes')
    for relative, digest in hashes.items():
        inventoried_file(root, inventory, relative)
        require(inventory[relative] == digest, 'Pending decision and producer review hashes differ: ' + relative)
    engines = review['engineInspections']
    require(isinstance(engines, list) and len(engines) == len(SURFACES) and
            {entry['surface'] for entry in engines} == set(SURFACES),
            'Road, pavement and grass engine inspections are each required exactly once')
    for entry in engines:
        engine_metadata(root, entry, inventory)


def main():
    require(len(sys.argv) == 1, 'Usage: python3 source/verify_review.py')
    verify()
    print('Current evidence records producer inspection of all four native64 idles on three Phaser surfaces.')
    print('Read-only procedural guard only: no aesthetic judgment or independent inspection attestation; user approval remains unset.')


if __name__ == '__main__':
    try:
        main()
    except (OSError, ValueError, KeyError, TypeError, AttributeError, struct.error) as error:
        print('Review evidence rejected: ' + str(error), file=sys.stderr)
        sys.exit(1)
