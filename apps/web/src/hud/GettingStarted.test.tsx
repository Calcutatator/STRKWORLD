import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import { COPY } from '../copy.js';
import { GettingStarted } from './GettingStarted.js';

/**
 * The card is copy about another package's code, so its claims are pinned to
 * that code: if the World rebinds a key, this fails and the copy is updated
 * with it rather than quietly teaching the wrong control.
 */
const source = (path: string): string =>
  readFileSync(fileURLToPath(new URL(path, import.meta.url)), 'utf8');

describe('Getting started card', () => {
  it("matches the World's real bindings", () => {
    const inputs = COPY.guide.controls.map(({ input }) => input);
    expect(inputs).toEqual(['WASD or arrow keys', 'Shift', 'Drag', 'Scroll', 'F', 'E', 'Esc']);

    const keyboard = source('../../../../packages/world/src/dom-keyboard.ts');
    for (const binding of [
      "up: Object.freeze(['ArrowUp', 'KeyW'])",
      "down: Object.freeze(['ArrowDown', 'KeyS'])",
      "left: Object.freeze(['ArrowLeft', 'KeyA'])",
      "right: Object.freeze(['ArrowRight', 'KeyD'])",
      "Object.freeze(['ShiftLeft', 'ShiftRight'])",
      "KeyF: 'keydown-F'",
      "KeyE: 'keydown-E'",
    ]) {
      expect(keyboard).toContain(binding);
    }

    // Either mouse button orbits; the wheel zooms.
    const camera = source('../../../../packages/world/src/three/camera-rig.ts');
    expect(camera).toContain('event.button !== 0 && event.button !== 2');
    expect(camera).toContain("['wheel', onWheel");

    // E belongs to the sandbox on the street; F follows the avatar everywhere.
    const session = source('../../../../packages/world/src/world-session.ts');
    expect(session).toContain("if (this.inputGate.suspended || this.area !== 'street') return;");

    // Escape closes a counter or Menu Mode (React owns it, not the World).
    const visits = source('../visits/VisitLayer.tsx');
    expect(visits).toContain("if (event.key !== 'Escape') return;");
  });

  it('renders the card closed as `hidden`, so the ? control always has a target', () => {
    const closed = renderToStaticMarkup(
      <GettingStarted id="guide" titleId="guide-title" open={false} onDismiss={vi.fn()} />,
    );
    expect(closed).toContain('id="guide"');
    expect(closed).toContain('hidden=""');
    expect(closed).toContain('aria-labelledby="guide-title"');

    const open = renderToStaticMarkup(
      <GettingStarted id="guide" titleId="guide-title" open onDismiss={vi.fn()} />,
    );
    expect(open).not.toContain('hidden=""');
    expect(open).toContain(COPY.guide.title);
    expect(open).toContain(COPY.guide.sandbox);
    expect(open).toContain(COPY.guide.dismiss);
    for (const step of COPY.guide.route) expect(open).toContain(step);
  });
});
