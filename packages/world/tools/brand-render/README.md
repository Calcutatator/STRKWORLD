# Brand render tool

A local Vite page that renders the brand kit's images ([`docs/brand/`](../../../../docs/brand/README.md),
D-113) from the World's own code: the avatar figures (`src/three/avatar-figure.ts`,
`src/three/avatar-looks.ts`), the street (`src/three/street-builder.ts`) and the
lighting (`src/three/lighting.ts`). It is a development tool. Nothing here is
bundled into the game, and the game never imports it.

## Run it

From the repo root:

```bash
npm run render:brand --workspace=@strkworld/world
# or, equivalently
npx vite --config packages/world/tools/brand-render/vite.config.mjs
```

Vite serves on `http://localhost:5199/` (strict port). Open a page with the
parameters below in a browser with WebGL. Each render is drawn on the page and
POSTed to the dev server's `/save` endpoint, which writes the PNG into `out/`
next to this file (gitignored). The page logs `saved <name>` and then `DONE`,
or `ERR` with a stack.

`/save` exists only on the dev server: it is registered in `configureServer`,
which `vite build` and `vite preview` never run. It accepts only a POST with a
plain `.png` file name and writes only into `out/`. Do not expose the server
(no `--host`).

`brand.html` loads Press Start 2P from Google Fonts at render time, to rasterise
the wordmark's letters. That fetch happens in this local page only; the game
ships no copy of the font.

## The wordmark (`brand.html`)

The approved wordmark, `docs/brand/assets/wordmark.png`, is:

```
http://localhost:5199/brand.html?mode=voxel&yaw=-24&pitch=-16&dist=100&w=4800&h=3000
```

then cropped to its alpha bounding box (for example
`magick out/wordmark.png -trim +repage wordmark.png`), which gives 2658x1498.

| Param | Default | Meaning |
|---|---|---|
| `mode` | `voxel` | The only mode. Directions B and C were explored and rejected (D-113) |
| `text` | `STRK\|WORLD` | Lines, split on `\|`, stacked and centred |
| `gap` | `1` | Cubes between letters (each letter trimmed to its own ink) |
| `w`, `h` | `2400`, `1500` | Canvas size in pixels (transparent) |
| `fov` | `24` | Camera field of view, degrees |
| `yaw`, `pitch` | `-14`, `-10` | Camera angles, degrees |
| `dist` | `95` | Camera distance, in cubes |
| `name` | `wordmark.png` | Output file name |

## Characters and the street (`index.html`)

`http://localhost:5199/?mode=<cast|portrait|world>&...` All modes take
`exposure` (default `1.0`) and `name` (output file name; `cast` names its own
files). The renderer uses ACES tone mapping and the World's sun, hemisphere and
shadow constants.

**`mode=cast`** (the default): one transparent full-body render per avatar,
same camera for all so their scales match. Writes `cast-<key>-y<yaw>.png`.

| Param | Default | Meaning |
|---|---|---|
| `keys` | `9,10,11,12,13,14,15,16` | Avatar numbers (`avatar-N`), comma-separated |
| `yaws` | `0` | Figure turn, radians, comma-separated (one render each) |
| `w`, `h` | `1000`, `1400` | Canvas size |
| `pitch`, `fov` | `8`, `18` | Camera pitch and field of view, degrees |
| `aim`, `span` | `1.05`, `2.7` | Framed window: centre height and height, world units |
| `idle` | `400` | Milliseconds of idle animation before the frame |

**`mode=portrait`**: a square head-and-shoulders close-up of one avatar.

| Param | Default | Meaning |
|---|---|---|
| `key` | `1` | Avatar number |
| `w` | `1600` | Square size |
| `yaw` | `0.3` | Figure turn, radians |
| `aim`, `span` | figure height − 0.3, `0.75` | Framed centre height and height |
| `fov`, `pitch` | `14`, `4` | Degrees |
| `ox` | `0` | Sideways camera offset |
| `fill`, `fx` | `0`, `2` | Optional warm fill light intensity and x position |
| `idle` | `400` | As above |

**`mode=world`**: the street from `buildStreet()` with the game's sky gradient,
fog and optional voxel clouds. Opaque. This render was the reference image for
the kit's AI-generated backdrop (see the brand guide's provenance).

| Param | Default | Meaning |
|---|---|---|
| `w`, `h` | `1500`, `500` | Canvas size |
| `tx`, `ty`, `tz` | `30`, `0`, `14` | Camera target, world units |
| `yaw`, `pitch`, `dist`, `fov` | `0`, `20`, `40`, `30` | Camera; angles in degrees |
| `top`, `horizon` | `0x6f9edb`, `0xf2dcc0` | Sky top and horizon/fog colours |
| `fogn`, `fogf` | `40`, `120` | Fog near and far |
| `shadow` | `40` | Half-size of the sun's shadow camera |
| `clouds`, `cloudy` | on, `14` | `clouds=0` turns them off; `cloudy` sets their height |
