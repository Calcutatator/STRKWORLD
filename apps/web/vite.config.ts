import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

/**
 * Build config for the shell.
 *
 * Only the React plugin, on purpose. This file carries **no** site-wide policy:
 * no `server.headers`, and in particular never the cross-origin isolation
 * pair. (The header names are not spelled out here: `check-invariants.sh`
 * greps this file for them without parsing comments, so naming them would trip
 * that check — the deploy scaffolding's `index.html` avoids them for the same
 * reason.) Cross-origin isolation breaks the `postMessage` popups and
 * cross-origin iframes web wallets rely on, and we do no in-browser proving, so
 * we never need it (D-005). `scripts/check-headers.mjs` builds and serves this
 * and fails if either header appears.
 *
 * Phaser is pulled in through a dynamic import in the world runtime, so it lands
 * in its own lazy chunk rather than the entry chunk — Phaser 4 does not
 * tree-shake, and a single eager import would ship the whole engine up front.
 */
export default defineConfig({
  plugins: [react()],
});
