import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import { COPY } from '../copy.js';
import { GettingStarted } from './GettingStarted.js';
import { guideRouteSteps } from './guide-route.js';

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
    expect(inputs).toEqual(['WASD or arrow keys', 'Shift', 'F', 'E', 'Esc']);

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

    // The camera is fixed: it takes no pointer or wheel input at all, so the
    // card lists no Drag or Scroll row.
    const camera = source('../../../../packages/world/src/three/camera-rig.ts');
    expect(camera).toContain('export const CAMERA_YAW = 0');
    expect(camera).not.toContain('addEventListener');
    expect(camera).not.toMatch(/'(wheel|pointerdown|pointermove)'/);

    // E belongs to the sandbox, the Privacy Plaza (D-076) and the football
    // pitch (D-078) on the street; F follows the avatar everywhere.
    const session = source('../../../../packages/world/src/world-session.ts');
    expect(session).toContain("if (this.inputGate.suspended || this.area !== 'street') return;");
    expect(session).toContain('this.plaza?.activate();');
    expect(session).toContain('channel.kick();');
    expect(COPY.guide.controls.find(({ input }) => input === 'E')?.effect).toMatch(/Privacy Plaza/);
    expect(COPY.guide.controls.find(({ input }) => input === 'E')?.effect).toContain('E · KICK');

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
    expect(open).toContain(COPY.guide.plaza.replace(/'/g, '&#x27;'));
    expect(open).toContain(COPY.guide.pitchTitle);
    expect(open).toContain(COPY.guide.pitch);
    expect(open).toContain(COPY.guide.dismiss);
    for (const step of guideRouteSteps()) expect(open).toContain(step);
  });
});

describe('the first route follows what this build opens', () => {
  const only = (...open: string[]) => (routeId: string) => open.includes(routeId);

  it('shows the whole route when every door is open', () => {
    const steps = guideRouteSteps(only('bridge.deposit', 'bank.shield', 'exchange.swap', 'post-office.transfer'));
    expect(steps).toEqual([
      COPY.guide.route.bridge,
      COPY.guide.route.bank,
      COPY.guide.route.swapOrSend,
    ]);
  });

  it('never points at a shut door: the production default shows no route at all', () => {
    expect(guideRouteSteps(only())).toEqual([]);
    const markup = renderToStaticMarkup(
      <GettingStarted id="guide" titleId="guide-title" open onDismiss={vi.fn()} />,
    );
    // Tests run outside production, so every approved route is open here.
    expect(markup).not.toContain(COPY.guide.route.none);
  });

  it('drops the Bridge when the Bank cannot shield its arrival', () => {
    expect(guideRouteSteps(only('bridge.deposit', 'post-office.transfer'))).toEqual([COPY.guide.route.send]);
    expect(guideRouteSteps(only('bridge.deposit', 'bank.shield'))).toEqual([
      COPY.guide.route.bridge,
      COPY.guide.route.bank,
    ]);
    expect(guideRouteSteps(only('exchange.swap'))).toEqual([COPY.guide.route.swap]);
  });

  it('never calls the Bridge private', () => {
    expect(COPY.guide.route.bridge).toMatch(/public/);
    expect(COPY.guide.route.bridge).not.toMatch(/privat/i);
  });
});
