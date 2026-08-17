import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import type { ShellEvents, WorldEvents } from '@strkworld/shared';
import { createEventBus } from './bus/event-bus.js';
import { App } from './App.js';
import './styles.css';

/**
 * STRKWORLD shell entry point.
 *
 * Two buses, created once here and never again. They are the world↔shell seam
 * (D-010): the world emits `WorldEvents` and listens for `ShellEvents`, the
 * shell does the reverse. Creating them at module scope keeps the references
 * stable across React's renders — including StrictMode's deliberate
 * double-mount, which would otherwise hand the world a fresh bus on the second
 * pass and strand every subscription made against the first.
 *
 * The world's own lifecycle (Phaser, WebGL) is ref-counted inside
 * `@strkworld/world` precisely so that double-mount is safe; nothing here needs
 * to defend against it beyond keeping these two references fixed.
 */
const worldOut = createEventBus<WorldEvents>();
const shellIn = createEventBus<ShellEvents>();

const container = document.getElementById('root');
if (!container) {
  throw new Error('STRKWORLD: no #root element to mount into — check index.html.');
}

createRoot(container).render(
  <StrictMode>
    <App worldOut={worldOut} shellIn={shellIn} />
  </StrictMode>,
);
