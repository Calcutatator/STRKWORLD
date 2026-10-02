#!/usr/bin/env python3
"""
Re-make the Degen floor's cardboard cat cutout from the lead-supplied photo.

    python3 packages/world/tools/degen-cat/make-cutout.py
    python3 packages/world/tools/degen-cat/make-cutout.py --preview /tmp/preview.png

Reads `crying-cat.jpg` beside this script (the "crying cat" meme photo the
lead supplied, 640x640) and writes `assets/degen-cat/cutout.webp`, which the
room builder hangs on the standee behind the DEGEN SWAP counter.

What it does, and what it never does:

- The photo's pixels are used exactly as they are: cropped 1:1 (no resize,
  no redraw, no filter, no colour change). Every pixel inside the silhouette
  is the photo's own pixel.
- The silhouette is a die-cut outline traced by hand over the photo
  (`OUTLINE`, in the photo's pixel coordinates): ears, top of the head,
  cheeks and fur edge, down to a cut across the chest. The laptop, the wall
  and the blanket fall outside it. The outline is smoothed by corner
  cutting, keeping the ear tips and the cut's ends sharp, and rasterised at
  4x then box-averaged, so the edge is clean and only about one pixel soft:
  a die cut, not a feathered matte.
- Outside the silhouette runs a thin white card border, as a printed
  standee has, then transparency. Transparent pixels carry the border's
  colour so mipmaps never fringe dark.
- The WebP is lossless, and the script decodes what it wrote and checks
  every pixel fully inside the silhouette against the photo.
- It also rewrites `src/three/degen-cat-outline.ts`: the texture's size and
  the card's silhouette (the outline grown by most of the border) in UV, so
  the 3D card's cardboard edge follows the die cut.

Needs only Python 3 and Pillow (with WebP support).
"""
from __future__ import annotations

import argparse
import hashlib
import sys
from pathlib import Path

from PIL import Image, ImageChops, ImageDraw

HERE = Path(__file__).resolve().parent
SOURCE = HERE / "crying-cat.jpg"
SOURCE_SHA256 = "70cffe5c49c3bb829b831f24a0a4cb6f5348403969972b9691adeb499f9dee09"
TARGET = HERE.parent.parent / "assets" / "degen-cat" / "cutout.webp"
OUTLINE_MODULE = HERE.parent.parent / "src" / "three" / "degen-cat-outline.ts"

# The die-cut outline in the photo's pixels, clockwise from the left ear's tip
# (which the photo's frame clips). A third element marks a sharp corner.
OUTLINE: list[tuple[float, float] | tuple[float, float, str]] = [
    (124, 1, "corner"),  # left ear, tip (clipped by the frame)
    (138, 1, "corner"),
    (152, 20),
    (170, 37),
    (190, 50),
    (210, 58),  # left ear meets the head
    (250, 55),
    (290, 48),
    (330, 51),
    (370, 55),
    (410, 62),
    (450, 63),  # right ear, leading edge
    (490, 59),
    (520, 46),
    (560, 32),
    (590, 21),
    (606, 9, "corner"),  # right ear, tip
    (603, 25),
    (588, 40),
    (567, 55),
    (543, 70),
    (527, 88),  # back of the right ear
    (524, 110),
    (523, 130),
    (526, 150),
    (528, 172),
    (534, 192),  # right cheek
    (546, 210),
    (556, 238),
    (566, 260),
    (585, 299),
    (608, 344),  # neck and shoulder
    (617, 390),
    (614, 428, "corner"),  # the cut across the chest
    (585, 452),
    (520, 470),
    (400, 482),
    (280, 476),
    (215, 467),
    (176, 461, "corner"),
    (176, 420),  # chest fur, left
    (177, 390),
    (174, 375),
    (163, 356),
    (153, 342),  # left cheek
    (132, 312),
    (128, 290),
    (126, 260),
    (122, 235),
    (122, 210),
    (123, 175),
    (128, 150),
    (129, 110),
    (127, 60),  # left ear, outer edge
    (126, 30),
]

BORDER_PX = 7  # the white card border, in photo pixels
BORDER_RGB = (247, 245, 240)  # printed-card white, a touch warm
SUPERSAMPLE = 4
PAD = BORDER_PX + 3


def smooth(points, iterations: int = 3):
    """Chaikin corner cutting on a closed outline; corners stay where they are."""
    pts = [(p[0], p[1], len(p) > 2) for p in points]
    for _ in range(iterations):
        out = []
        n = len(pts)
        for i in range(n):
            x0, y0, c0 = pts[i]
            x1, y1, c1 = pts[(i + 1) % n]
            if c0:
                out.append((x0, y0, True))
            else:
                out.append((0.75 * x0 + 0.25 * x1, 0.75 * y0 + 0.25 * y1, False))
            if not c1:
                out.append((0.25 * x0 + 0.75 * x1, 0.25 * y0 + 0.75 * y1, False))
        pts = out
    return [(x, y) for x, y, _ in pts]


def make_cutout(photo: Image.Image) -> Image.Image:
    xs = [p[0] for p in OUTLINE]
    ys = [p[1] for p in OUTLINE]
    left, top = int(min(xs)) - PAD, int(min(ys)) - PAD
    right, bottom = int(max(xs)) + PAD + 1, int(max(ys)) + PAD + 1
    width, height = right - left, bottom - top

    outline = smooth(OUTLINE)
    s = SUPERSAMPLE
    big = [((x - left) * s, (y - top) * s) for x, y in outline]

    inner_big = Image.new("L", (width * s, height * s), 0)
    ImageDraw.Draw(inner_big).polygon(big, fill=255)
    outer_big = inner_big.copy()
    draw = ImageDraw.Draw(outer_big)
    # The border: the outline stroked with round joins, so it grows evenly.
    draw.line(big + [big[0]], fill=255, width=2 * BORDER_PX * s, joint="curve")
    r = BORDER_PX * s
    for x, y in big:
        draw.ellipse((x - r, y - r, x + r, y + r), fill=255)

    inner = inner_big.resize((width, height), Image.Resampling.BOX)
    outer = outer_big.resize((width, height), Image.Resampling.BOX)

    # The photo, 1:1, on a canvas that may reach past its frame (only border lives there).
    canvas_photo = Image.new("RGB", (width, height), BORDER_RGB)
    canvas_photo.paste(photo, (-left, -top))
    # Never sample past the frame: the silhouette stays inside the photo.
    frame = Image.new("L", (width, height), 0)
    frame.paste(255, (-left, -top, -left + photo.width, -top + photo.height))
    inner = ImageChops.multiply(inner, frame)

    card = Image.new("RGB", (width, height), BORDER_RGB)
    rgb = Image.composite(canvas_photo, card, inner)
    out = rgb.convert("RGBA")
    out.putalpha(outer)
    return out


def offset(points, distance: float):
    """Each vertex moved out along its corner's bisector: never past the true offset curve."""
    n = len(points)
    out = []
    for i in range(n):
        (ax, ay), (bx, by), (cx, cy) = points[i - 1], points[i], points[(i + 1) % n]
        normals = []
        for (x0, y0), (x1, y1) in (((ax, ay), (bx, by)), ((bx, by), (cx, cy))):
            dx, dy = x1 - x0, y1 - y0
            length = (dx * dx + dy * dy) ** 0.5 or 1.0
            # Clockwise on screen with y down: (dy, -dx) points out.
            normals.append((dy / length, -dx / length))
        nx, ny = normals[0][0] + normals[1][0], normals[0][1] + normals[1][1]
        length = (nx * nx + ny * ny) ** 0.5 or 1.0
        out.append((bx + nx / length * distance, by + ny / length * distance))
    return out


def simplify(points, tolerance: float):
    """Douglas-Peucker on a closed outline (split at the vertex farthest from the first)."""

    def dp(run):
        if len(run) < 3:
            return run
        (x0, y0), (x1, y1) = run[0], run[-1]
        dx, dy = x1 - x0, y1 - y0
        length = (dx * dx + dy * dy) ** 0.5 or 1.0
        far, index = 0.0, 0
        for i in range(1, len(run) - 1):
            x, y = run[i]
            d = abs(dy * (x - x0) - dx * (y - y0)) / length
            if d > far:
                far, index = d, i
        if far <= tolerance:
            return [run[0], run[-1]]
        return dp(run[: index + 1])[:-1] + dp(run[index:])

    x0, y0 = points[0]
    split = max(range(len(points)), key=lambda i: (points[i][0] - x0) ** 2 + (points[i][1] - y0) ** 2)
    first = dp(points[: split + 1])
    second = dp(points[split:] + [points[0]])
    return first[:-1] + second[:-1]


def write_outline_module(path: Path, size: tuple[int, int]) -> int:
    """The card's silhouette for the room builder: the outline plus most of its border, in UV."""
    xs = [p[0] for p in OUTLINE]
    ys = [p[1] for p in OUTLINE]
    left, top = int(min(xs)) - PAD, int(min(ys)) - PAD
    width, height = size
    card = simplify(offset(smooth(OUTLINE), BORDER_PX - 1.5), 0.8)
    rows = ",\n".join(
        f"  [{(x - left) / width:.4f}, {1 - (y - top) / height:.4f}]" for x, y in card
    )
    path.write_text(
        "// Generated by tools/degen-cat/make-cutout.py from its OUTLINE. Do not edit by hand:\n"
        "// change the outline there and run the script, which rewrites this file and the cutout.\n"
        "\n"
        "/** The cutout texture's size in pixels (assets/degen-cat/cutout.webp). */\n"
        f"export const DEGEN_CAT_CUTOUT_SIZE = Object.freeze({{ width: {width}, height: {height} }});\n"
        "\n"
        "/**\n"
        " * The die-cut card's silhouette in the cutout's UV space (u right, v up): the\n"
        " * cat's outline grown by most of its white border, so the card's edge sits\n"
        " * just inside the printed border and shows as cardboard only from the side.\n"
        " */\n"
        "export const DEGEN_CAT_OUTLINE: readonly (readonly [number, number])[] = Object.freeze([\n"
        f"{rows},\n"
        "] as const);\n"
    )
    return len(card)


def verify(path: Path, photo: Image.Image) -> int:
    """Decode what was written and check every fully inside pixel is the photo's own."""
    written = Image.open(path).convert("RGBA")
    xs = [p[0] for p in OUTLINE]
    ys = [p[1] for p in OUTLINE]
    left, top = int(min(xs)) - PAD, int(min(ys)) - PAD
    s = SUPERSAMPLE
    inner_big = Image.new("L", (written.width * s, written.height * s), 0)
    ImageDraw.Draw(inner_big).polygon([((x - left) * s, (y - top) * s) for x, y in smooth(OUTLINE)], fill=255)
    inner = inner_big.resize(written.size, Image.Resampling.BOX).load()
    got = written.load()
    want = photo.load()
    kept = 0
    for y in range(written.height):
        for x in range(written.width):
            if inner[x, y] != 255:
                continue
            px, py = x + left, y + top
            if not (0 <= px < photo.width and 0 <= py < photo.height):
                continue
            if got[x, y][:3] != want[px, py] or got[x, y][3] != 255:
                raise SystemExit(f"pixel ({x}, {y}) is not the photo's pixel ({px}, {py})")
            kept += 1
    return kept


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--out", type=Path, default=TARGET)
    parser.add_argument("--outline", type=Path, default=OUTLINE_MODULE)
    parser.add_argument("--preview", type=Path, help="also write the cutout over a checkerboard as PNG")
    args = parser.parse_args()

    data = SOURCE.read_bytes()
    digest = hashlib.sha256(data).hexdigest()
    if digest != SOURCE_SHA256:
        print(f"{SOURCE} is not the supplied photo (sha256 {digest})", file=sys.stderr)
        return 1
    photo = Image.open(SOURCE).convert("RGB")
    cutout = make_cutout(photo)

    args.out.parent.mkdir(parents=True, exist_ok=True)
    # Lossless, so what ships is the photo's pixels and not a re-encoding of them.
    cutout.save(args.out, "WEBP", lossless=True, quality=100, method=6, exact=True)
    exact = verify(args.out, photo)
    print(f"{args.out}\n  {cutout.width}x{cutout.height}, {args.out.stat().st_size} bytes, {exact} photo pixels kept exactly")
    points = write_outline_module(args.outline, cutout.size)
    print(f"{args.outline}\n  {points} outline points")

    if args.preview:
        checker = Image.new("RGB", cutout.size, (40, 40, 48))
        draw = ImageDraw.Draw(checker)
        for y in range(0, cutout.height, 16):
            for x in range(0, cutout.width, 16):
                if (x // 16 + y // 16) % 2:
                    draw.rectangle((x, y, x + 15, y + 15), fill=(70, 70, 84))
        checker.paste(cutout, (0, 0), cutout)
        checker.save(args.preview)
        print(f"  preview {args.preview}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
