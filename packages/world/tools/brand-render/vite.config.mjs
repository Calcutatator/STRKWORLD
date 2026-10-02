// Local render tool only (see README.md). `/save` exists on the dev server
// alone: it is registered in `configureServer`, which `vite build` and
// `vite preview` never call, and it writes only into ./out (gitignored).
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const out = resolve(here, 'out');

export default {
  root: here,
  // The pages import the World's sources and the repo's hoisted node_modules.
  server: { port: 5199, strictPort: true, fs: { allow: [resolve(here, '../../../..')] } },
  optimizeDeps: { include: ['three'] },
  plugins: [{
    name: 'brand-render-save',
    configureServer(server) {
      server.middlewares.use('/save', (req, res) => {
        if (req.method !== 'POST') { res.statusCode = 405; res.end(); return; }
        const name = (new URL(req.url ?? '', 'http://x').searchParams.get('name') ?? '').replace(/[^a-z0-9._-]/gi, '');
        if (!name.endsWith('.png') || name.startsWith('.')) { res.statusCode = 400; res.end('name must be a .png file name'); return; }
        const chunks = [];
        req.on('data', (c) => chunks.push(c));
        req.on('end', () => {
          const b64 = Buffer.concat(chunks).toString().split(',')[1] ?? '';
          mkdirSync(out, { recursive: true });
          writeFileSync(resolve(out, name), Buffer.from(b64, 'base64'));
          res.end('ok');
        });
      });
    },
  }],
};
