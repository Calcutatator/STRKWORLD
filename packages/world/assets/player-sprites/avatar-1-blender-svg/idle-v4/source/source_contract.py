"""Shared input validation for internal v4 Blender construction, not art QA."""
import hashlib
import json
import math
from pathlib import Path
import re

PREFIX = 'AV1V4 | '
VIEW_ORDER = ('down', 'left', 'right', 'up')


def sha256(path):
    return hashlib.sha256(Path(path).read_bytes()).hexdigest()


def require(condition, message):
    if not condition:
        raise ValueError(message)


def inspect_grid_provenance(source, geometry, palette, references):
    """Bind a grid-assisted construction to its current explicit input files.

    This checks provenance hashes, not whether sampling or tracing is a good
    artistic method. It does not replay the construction scripts.
    """
    root = source.parent
    provenance = geometry.get('provenance', {})
    grid_path = source / 'artist-grid.json'
    if not grid_path.is_file() and 'artistGridSha256' not in provenance:
        return {'status': 'not-applicable-to-direct-geometry', 'files': []}
    require(grid_path.is_file() and provenance.get('artistGridSha256') == sha256(grid_path),
            'Geometry artistGridSha256 is stale; retrace the current artist grid')
    grid = json.loads(grid_path.read_text())
    grid_provenance = grid['provenance']
    require(all(provenance.get(key) == value for key, value in grid_provenance.items()),
            'Geometry provenance differs from current artist-grid provenance')
    require(grid_provenance['conceptSha256'] == geometry['conceptSha256'],
            'Artist-grid concept binding changed')
    require(grid['cell'] == geometry['cell'] == [64, 64] and
            grid['feetPivot'] == geometry['feetPivot'] == [32, 56],
            'Grid and vector cell/feet registration must remain 64x64 and [32,56]')
    require(set(grid['views']) == set(geometry['views']), 'Grid and vector direction inventories differ')
    require(grid['palette'] == palette['colors'], 'Artist grid and exported palette differ')
    art_palette_path = source / 'art-palette.json'
    require(json.loads(art_palette_path.read_text())['colors'] == grid['palette'],
            'Authored palette differs from current artist-grid palette; rebuild explicitly')
    expected_references = [{'file': ref['relative'], 'sha256': ref['sha256']} for ref in references]
    require(grid_provenance['constructionReferences'] == expected_references,
            'Recorded construction-study file/hash inventory differs from the actual current study bytes')
    files = ['source/artist-grid.json', 'source/art-palette.json',
             'source/grid_from_studies.cjs', 'source/refine_grid.cjs',
             'source/apply_head_refinement.cjs', 'source/trace_grid.py',
             'source/rasterize.cjs', 'source/verify_pixels.cjs']
    head = grid_provenance.get('headRefinement')
    if head is not None:
        require(isinstance(head, dict) and head.get('file') == 'source/head-refinement.json',
                'Head refinement must identify the current revision source patch')
        patch_path = root / head['file']
        require(patch_path.is_file() and head.get('sha256') == sha256(patch_path),
                'Applied head-refinement hash differs from the current patch file')
        files.append(head['file'])
    for relative in files:
        require((root / relative).is_file(), 'Missing upstream construction file: ' + relative)
    return {'status': 'hashes-match-current-inputs', 'artistGridSha256': sha256(grid_path),
            'constructionReferences': expected_references, 'headRefinement': head,
            'cell': [64, 64], 'feetPivot': [32, 56], 'files': files,
            'scope': 'Current grid, palette, study and applied-patch bindings; script hashes are inventory, not execution attestation',
            'constructionReplay': 'not-performed-by-this-check'}


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
        require(decision['status'] in ('internal-refinement', 'pending', 'approved', 'rejected', 'withdrawn'),
                'Unrecognized review state')
    geometry = json.loads((source / 'idle-geometry.json').read_text())
    require(geometry['conceptSha256'] == approval['sha256'], 'Geometry concept binding changed')
    require(isinstance(geometry['views'], dict) and geometry['views'] and
            set(geometry['views']) <= set(VIEW_ORDER), 'Expected one or more supported idle views')
    directions = tuple(d for d in VIEW_ORDER if d in geometry['views'])
    palette = json.loads((source / 'palette.json').read_text())
    colors = palette['colors']
    limit = palette.get('maximumColorsPerFrame', 24)
    require(type(limit) is int and 0 < limit <= 24 and 0 < len(colors) <= limit,
            'The authored palette must contain at most 24 colors')
    names, hexes = set(), set()
    for entry in colors:
        require(isinstance(entry['name'], str) and entry['name'] and
                re.fullmatch(r'#[0-9a-fA-F]{6}', entry['hex']), 'Malformed palette entry')
        require(entry['name'] not in names and entry['hex'].upper() not in hexes,
                'Duplicate palette name or RGB value')
        names.add(entry['name']); hexes.add(entry['hex'].upper())
    for direction in directions:
        shapes = geometry['views'][direction]
        require(isinstance(shapes, list) and shapes, direction + ': empty geometry')
        for shape in shapes:
            require(isinstance(shape['part'], str) and shape['part'] and shape['color'] in names,
                    direction + ': invalid semantic part or color')
            require(isinstance(shape['contours'], list) and shape['contours'],
                    direction + ': missing contours')
            for contour in shape['contours']:
                require(isinstance(contour, list) and len(contour) >= 3,
                        direction + ': a fill needs at least three vertices')
                for point in contour:
                    require(isinstance(point, list) and len(point) == 2 and
                            all(type(v) in (int, float) and math.isfinite(v) and 0 <= v <= 64
                                for v in point), direction + ': expected finite in-cell XY points')
    reference_paths = geometry.get('constructionReferences')
    if reference_paths is None:
        reference_paths = [p.relative_to(root).as_posix()
                           for p in sorted((root / 'studies').glob('*construction*.png'))]
    require(isinstance(reference_paths, list), 'constructionReferences must be a list of paths')
    references = []
    for relative in reference_paths:
        require(isinstance(relative, str), 'Construction reference paths must be strings')
        path = (root / relative).resolve()
        require(path.is_relative_to((root / 'studies').resolve()) and path.is_file(),
                'Construction reference must exist under this revision studies/')
        references.append({'path': path, 'relative': path.relative_to(root).as_posix(),
                           'sha256': sha256(path),
                           'approval': 'Not approved concept art; internal ImageGen construction study'})
    grid_provenance = inspect_grid_provenance(source, geometry, palette, references)
    return {'source': source, 'root': root, 'approval': approval, 'conceptPath': concept_path,
            'geometry': geometry, 'directions': directions, 'palette': palette,
            'geometrySha256': sha256(source / 'idle-geometry.json'),
            'paletteSha256': sha256(source / 'palette.json'), 'references': references,
            'gridProvenance': grid_provenance}


def linear(value):
    return value / 12.92 if value <= 0.04045 else ((value + 0.055) / 1.055) ** 2.4


def material_rgba(hex_color):
    # Native SVG conversion truncates uint8; a quarter-unit sRGB bias preserves
    # the exact desired integer RGB through Blender's float color conversion.
    rgb = [min(255, int(hex_color[i:i+2], 16) + 0.25) / 255 for i in (1, 3, 5)]
    return (*[linear(value) for value in rgb], 1.0)
