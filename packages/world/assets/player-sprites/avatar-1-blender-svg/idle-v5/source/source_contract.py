"""Validate high-detail v5 inputs. This module never grants artistic approval."""
import hashlib
import json
import math
from pathlib import Path
import re

PREFIX = 'AV1V5 | '
VIEW_ORDER = ('down', 'left', 'right', 'up')
CANVAS = 512
CENTER = 256
PNG_SIZE = 256
LOGICAL_CELL = 64


def sha256(path):
    return hashlib.sha256(Path(path).read_bytes()).hexdigest()


def require(condition, message):
    if not condition:
        raise ValueError(message)


def load(source_dir, require_internal=True):
    source = Path(source_dir).resolve()
    root = source.parent
    concept = root.parent / 'concept'
    approval = json.loads((concept / 'approval.json').read_text())
    require(approval['status'] == 'approved', 'Fresh concept approval is required')
    concept_path = (concept / approval['artifact']).resolve()
    require(concept_path.parent == concept.resolve(), 'Concept must be a local concept artifact')
    require(sha256(concept_path) == approval['sha256'], 'Approved concept bytes changed')
    decision = json.loads((root / 'review/user-decisions.json').read_text())
    if require_internal:
        require(decision['status'] == 'internal-refinement',
                'Only an explicitly internal-refinement revision may be overwritten')
    else:
        require(decision['status'] in ('internal-refinement', 'pending', 'approved', 'rejected', 'withdrawn',
                'withdrawn-unapproved-requires-refinement'), 'Unrecognized review state')
    geometry = json.loads((source / 'idle-geometry.json').read_text())
    require(geometry['conceptSha256'] == approval['sha256'], 'Geometry concept binding changed')
    require(geometry.get('cell') == [CANVAS, CANVAS] and geometry.get('feetPivot') == [256, 448]
            and geometry.get('logicalCell') == [LOGICAL_CELL, LOGICAL_CELL],
            'Expected 512x512 source, feet [256,448], and unchanged logical 64x64 cell')
    require(isinstance(geometry['views'], dict) and geometry['views'] and
            set(geometry['views']) <= set(VIEW_ORDER), 'Expected one or more supported idle views')
    directions = tuple(d for d in VIEW_ORDER if d in geometry['views'])
    palette = json.loads((source / 'palette.json').read_text())
    colors = palette['colors']
    limit = palette.get('maximumColorsPerFrame', 256)
    require(type(limit) is int and 0 < limit <= 256 and 0 < len(colors) <= limit,
            'The authored flat-fill palette must contain at most 256 colors; rendered antialias colors are unrestricted')
    names, hexes = set(), set()
    for entry in colors:
        require(isinstance(entry['name'], str) and entry['name'] and len(entry['name']) <= 48
                and re.fullmatch(r'#[0-9a-fA-F]{6}', entry['hex']), 'Malformed palette entry')
        require(entry['name'] not in names and entry['hex'].upper() not in hexes,
                'Duplicate palette name or RGB value')
        names.add(entry['name']); hexes.add(entry['hex'].upper())
    for direction in directions:
        shapes = geometry['views'][direction]
        require(isinstance(shapes, list) and shapes, direction + ': empty geometry')
        for shape in shapes:
            require(isinstance(shape['part'], str) and shape['part'] and len(shape['part']) <= 80
                    and shape['color'] in names, direction + ': invalid part or color')
            require(isinstance(shape['contours'], list) and shape['contours'], direction + ': missing contours')
            for contour in shape['contours']:
                require(isinstance(contour, list) and len(contour) >= 3,
                        direction + ': a fill needs at least three vertices')
                for point in contour:
                    require(isinstance(point, list) and len(point) == 2 and
                            all(type(v) in (int, float) and math.isfinite(v) and 0 <= v <= CANVAS
                                for v in point), direction + ': expected finite source-canvas XY points')
    reference_paths = geometry.get('constructionReferences')
    require(isinstance(reference_paths, list) and reference_paths,
            'Declare all construction study paths explicitly; implicit discovery is disabled')
    require(len(set(reference_paths)) == len(reference_paths), 'Duplicate construction reference')
    references = []
    for relative in reference_paths:
        require(isinstance(relative, str), 'Construction reference paths must be strings')
        path = (root / relative).resolve()
        require(path.is_relative_to((root / 'studies').resolve()) and path.is_file(),
                'Construction reference must exist under this revision studies/')
        require(path.suffix.lower() in ('.png', '.jpg', '.jpeg'),
                'Packed construction studies must be bitmap references; geometry remains vector')
        references.append({'path': path, 'relative': path.relative_to(root).as_posix(), 'sha256': sha256(path),
                           'approval': 'Not approved concept art; internal ImageGen construction study'})
    provenance = geometry.get('provenance', {})
    expected_references = [{'file': ref['relative'], 'sha256': ref['sha256']} for ref in references]
    require(provenance.get('constructionReferences') == expected_references,
            'Geometry construction study paths/hashes do not match current input bytes')
    require('artistGridSha256' not in provenance and not (source / 'artist-grid.json').exists(),
            'v5 construction must not use or relabel a low-resolution artist pixel grid')
    input_files = ['source/vectorize_studies.py']
    for entry in provenance.get('inputFiles', []):
        require(isinstance(entry, dict) and isinstance(entry.get('file'), str), 'Invalid inputFiles record')
        path = (root / entry['file']).resolve()
        require(path.is_relative_to(root) and path.is_file() and entry.get('sha256') == sha256(path),
                'Declared vector construction input is missing, out of revision, or stale')
        input_files.append(entry['file'])
    for relative in input_files:
        require((root / relative).is_file(), 'Missing upstream construction file: ' + relative)
    upstream = {'status': 'hashes-match-current-inputs', 'constructionReferences': expected_references,
                'cell': [CANVAS, CANVAS], 'feetPivot': [256,448], 'logicalCell': [64,64],
                'files': list(dict.fromkeys(input_files)),
                'scope': 'Current declared study and construction input bytes; script hashes are inventory, not execution attestation',
                'constructionReplay': 'not-performed-by-this-check'}
    return {'source': source, 'root': root, 'approval': approval, 'conceptPath': concept_path,
            'geometry': geometry, 'directions': directions, 'palette': palette,
            'geometrySha256': sha256(source / 'idle-geometry.json'),
            'paletteSha256': sha256(source / 'palette.json'), 'references': references,
            'constructionProvenance': upstream}


def linear(value):
    return value / 12.92 if value <= 0.04045 else ((value + 0.055) / 1.055) ** 2.4


def material_rgba(hex_color):
    # Native SVG conversion truncates uint8. A quarter-unit sRGB bias preserves
    # integer RGB through float conversion. Exact exported fills are verified.
    rgb = [min(255, int(hex_color[i:i+2], 16) + 0.25) / 255 for i in (1, 3, 5)]
    return (*[linear(value) for value in rgb], 1.0)
