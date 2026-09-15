"""Validate v6 pixel-cluster inputs and both visual references; not art QA."""
import hashlib
import json
from pathlib import Path
import re

PREFIX = 'AV1V6 | '
VIEW_ORDER = ('down', 'left', 'right', 'up')
CANVAS = 64
CENTER = 32
PNG_SIZE = 64
LOGICAL_CELL = 64
MAX_COLORS = 32
CONCEPT_SHA256 = '8c0d58a07d1372d2e8c9bcdbddac6e997763a8ffd2b910be83e8ec47b69f1c92'
STYLE_SHA256 = 'f1de96b3038042aaca726c18ae87fe374e8dac2bbda7d0a2359d53f44ad08ed4'


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
    require(concept_path == (concept / 'avatar-1-concept-v2.png').resolve(),
            'v6 identity reference must be the exact approved concept-v2 artifact')
    require(sha256(concept_path) == approval['sha256'] == CONCEPT_SHA256,
            'Approved concept bytes or binding changed')
    style_path = root.parent / 'reference/approved-concept-turnaround.png'
    require(sha256(style_path) == STYLE_SHA256, 'Original approved sprite-style bytes changed')
    reference_manifest = json.loads((root.parent / 'reference/reference-manifest.json').read_text())
    style_authority = reference_manifest['spriteStyleAuthority']
    require(style_authority['file'] == 'reference/approved-concept-turnaround.png' and
            style_authority['sha256'] == STYLE_SHA256, 'Sprite style authority binding changed')
    decision = json.loads((root / 'review/user-decisions.json').read_text())
    if require_internal:
        require(decision['status'] == 'internal-refinement',
                'Only an explicitly internal-refinement revision may be overwritten')
    else:
        require(decision['status'] in ('internal-refinement', 'pending', 'approved', 'rejected',
                'withdrawn', 'withdrawn-unapproved-requires-refinement'), 'Unrecognized review state')
    geometry = json.loads((source / 'idle-geometry.json').read_text())
    require(geometry['conceptSha256'] == CONCEPT_SHA256, 'Geometry concept binding changed')
    require(geometry['styleSha256'] == STYLE_SHA256, 'Geometry sprite-style binding changed')
    require(geometry.get('cell') == [64, 64] and geometry.get('feetPivot') == [32, 56] and
            geometry.get('logicalCell', [64, 64]) == [64, 64],
            'Expected 64x64 source/logical cell and feet [32,56]')
    require(isinstance(geometry['views'], dict) and geometry['views'] and
            set(geometry['views']) <= set(VIEW_ORDER), 'Expected one or more supported idle views')
    directions = tuple(d for d in VIEW_ORDER if d in geometry['views'])
    palette = json.loads((source / 'palette.json').read_text())
    colors = palette['colors']
    limit = palette.get('maximumColorsGlobal', MAX_COLORS)
    require(type(limit) is int and 0 < limit <= MAX_COLORS and
            isinstance(colors, list) and 0 < len(colors) <= limit,
            'All views share one palette with at most 32 opaque RGB colors globally')
    names, hexes = set(), set()
    for entry in colors:
        require(isinstance(entry['name'], str) and entry['name'] and len(entry['name']) <= 48 and
                isinstance(entry['hex'], str) and re.fullmatch(r'#[0-9a-fA-F]{6}', entry['hex']),
                'Malformed palette entry')
        require(entry['name'] not in names and entry['hex'].upper() not in hexes,
                'Duplicate palette name or RGB value')
        require(all(int(entry['hex'][i:i+2], 16) <= 254 for i in (1, 3, 5)),
                'Use palette channels <=254 for exact native Blender SVG color roundtrip')
        names.add(entry['name']); hexes.add(entry['hex'].upper())
    for direction in directions:
        shapes = geometry['views'][direction]
        require(isinstance(shapes, list) and shapes, direction + ': empty geometry')
        for shape in shapes:
            require(isinstance(shape['part'], str) and shape['part'] and len(shape['part']) <= 80 and
                    shape['color'] in names, direction + ': invalid part or color')
            require(isinstance(shape['contours'], list) and shape['contours'], direction + ': missing contours')
            for contour in shape['contours']:
                require(isinstance(contour, list) and len(contour) >= 4,
                        direction + ': a pixel-aligned fill needs at least four vertices')
                for point in contour:
                    require(isinstance(point, list) and len(point) == 2 and
                            all(type(v) is int and 0 <= v <= CANVAS for v in point),
                            direction + ': expected integer pixel-edge XY coordinates in the 64x64 cell')
                for start, end in zip(contour, contour[1:] + contour[:1]):
                    require(start != end and (start[0] == end[0] or start[1] == end[1]),
                            direction + ': pixel-cluster contour edges must be nonzero and orthogonal')
                area2 = sum(a[0] * b[1] - b[0] * a[1] for a, b in zip(contour, contour[1:] + contour[:1]))
                require(area2 != 0, direction + ': degenerate contour')
    reference_paths = geometry.get('constructionReferences')
    require(isinstance(reference_paths, list), 'Declare constructionReferences explicitly, including [] if none')
    require(all(isinstance(path, str) for path in reference_paths), 'Construction reference paths must be strings')
    require(len(set(reference_paths)) == len(reference_paths), 'Duplicate construction reference')
    references = []
    for relative in reference_paths:
        path = (root / relative).resolve()
        require(path.is_relative_to((root / 'studies').resolve()) and path.is_file(),
                'Construction reference must exist under this revision studies/')
        require(path.suffix.lower() in ('.png', '.jpg', '.jpeg'),
                'Packed construction studies must be bitmap references; geometry remains vector')
        references.append({'path': path, 'relative': path.relative_to(root).as_posix(), 'sha256': sha256(path),
                           'approval': 'Internal construction study; not an approved sprite or concept'})
    provenance = geometry.get('provenance', {})
    expected_references = [{'file': ref['relative'], 'sha256': ref['sha256']} for ref in references]
    require(provenance.get('constructionReferences') == expected_references,
            'Geometry construction study paths/hashes do not match current input bytes')
    input_files = []
    for entry in provenance.get('inputFiles', []):
        require(isinstance(entry, dict) and isinstance(entry.get('file'), str), 'Invalid inputFiles record')
        path = (root / entry['file']).resolve()
        require(path.is_relative_to(root) and path.is_file() and entry.get('sha256') == sha256(path),
                'Declared construction input is missing, out of revision, or stale')
        input_files.append(path.relative_to(root).as_posix())
    upstream = {'status': 'hashes-match-current-inputs', 'constructionReferences': expected_references,
                'cell': [64, 64], 'feetPivot': [32, 56], 'logicalCell': [64, 64], 'pngDensity': 1,
                'files': list(dict.fromkeys(input_files)),
                'scope': 'Current declared study and construction input bytes; script hashes are inventory, not execution attestation',
                'constructionReplay': 'not-performed-by-this-check'}
    return {'source': source, 'root': root, 'approval': approval, 'conceptPath': concept_path,
            'stylePath': style_path, 'styleSha256': STYLE_SHA256, 'styleAuthority': style_authority,
            'geometry': geometry, 'directions': directions, 'palette': palette,
            'geometrySha256': sha256(source / 'idle-geometry.json'),
            'paletteSha256': sha256(source / 'palette.json'), 'references': references,
            'constructionProvenance': upstream}


def linear(value):
    return value / 12.92 if value <= 0.04045 else ((value + 0.055) / 1.055) ** 2.4


def material_rgba(hex_color):
    # The native SVG conversion truncates uint8. Inputs are already <=254;
    # a quarter-unit sRGB bias preserves the exact intended integer channel.
    rgb = [(min(254, int(hex_color[i:i+2], 16)) + 0.25) / 255 for i in (1, 3, 5)]
    return (*[linear(value) for value in rgb], 1.0)
