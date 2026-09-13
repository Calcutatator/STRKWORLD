"""Sample authored curves into native Grease Pencil fill contours.

The JSON paths describe the new approved character, not sampled raster pixels.
The sampled geometry is shared by the source audit and Blender authoring.
"""
import hashlib
import json
import math
import re
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
CONCEPT = ROOT.parent / 'concept'

def approval_gate():
    approval = json.loads((CONCEPT / 'approval.json').read_text())
    assert approval['status'] == 'approved', 'Fresh concept requires explicit user approval'
    assert hashlib.sha256((CONCEPT / approval['artifact']).read_bytes()).hexdigest() == approval['sha256']
    return approval

def sample_path(path):
    tokens = re.findall(r'[A-Za-z]|[-+]?(?:\d*\.)?\d+(?:[eE][-+]?\d+)?', path)
    assert not re.sub(r'[A-Za-z]|[-+]?(?:\d*\.)?\d+(?:[eE][-+]?\d+)?|[\s,]', '', path)
    contours = []; points = []; index = 0; command = None; current = None
    while index < len(tokens):
        if tokens[index].isalpha():
            command = tokens[index]; index += 1
            assert command in ('M', 'L', 'Q', 'C', 'Z', 'z'), command
            if command in ('Z', 'z'):
                if points and points[-1] == points[0]: points.pop()
                assert len(points) >= 3
                contours.append(points); points = []; current = None; command = None
                continue
        count = {'M': 2, 'L': 2, 'Q': 4, 'C': 6}[command]
        values = list(map(float, tokens[index:index+count])); index += count
        assert len(values) == count and all(math.isfinite(v) and 0 <= v <= 64 for v in values)
        if command == 'M':
            assert not points, 'Close every subpath before moving'
            current = values; points.append(current); command = 'L'
        elif command == 'L':
            current = values; points.append(current)
        else:
            assert current is not None
            controls = [current] + [values[i:i+2] for i in range(0, len(values), 2)]
            length = sum(math.dist(a, b) for a, b in zip(controls, controls[1:]))
            steps = max(8, math.ceil(length / 0.12))
            for step in range(1, steps+1):
                t = step/steps; work = controls
                while len(work) > 1:
                    work = [[a[j]*(1-t)+b[j]*t for j in range(2)] for a,b in zip(work,work[1:])]
                points.append(work[0])
            current = controls[-1]
    assert not points, 'Every fill must be explicitly closed'
    return contours

def main():
    approval = approval_gate()
    decision = json.loads((ROOT / 'review/user-decisions.json').read_text())
    assert decision['status'] == 'pending', 'Preserve any already reviewed sprite revision'
    contract = json.loads((ROOT / 'source/design-contract.json').read_text())
    assert contract['approvedConceptSha256'] == approval['sha256']
    views = {}
    for file in ('front-back.json', 'profiles.json'):
        authored = json.loads((ROOT / 'source' / file).read_text())
        for direction, shapes in authored.items():
            assert direction not in views
            views[direction] = []
            for shape in shapes:
                assert shape['color'] in contract['palette']
                views[direction].append({'part': shape['part'], 'color': shape['color'], 'contours': sample_path(shape['d'])})
    assert set(views) == {'down', 'left', 'right', 'up'}
    doc = {'revision': 'idle-v3', 'conceptSha256': approval['sha256'], 'method': 'authored curved paths sampled to native vector contours; no raster tracing', 'views': views}
    (ROOT/'source/idle-geometry.json').write_text(json.dumps(doc,separators=(',',':'))+'\n')
    (ROOT/'source/palette.json').write_text(json.dumps({'maximumColorsPerFrame':24,'colors':[{'name':k,'hex':v} for k,v in contract['palette'].items()]},indent=2)+'\n')
    print(json.dumps({'shapes':{d:len(v) for d,v in views.items()},'conceptSha256':approval['sha256']}))

if __name__ == '__main__': main()
