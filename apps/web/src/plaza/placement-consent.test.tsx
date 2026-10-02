// @vitest-environment jsdom
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { FakePrivacyOperations, type PlacementCheck } from '@strkworld/privacy';
import type { ShellEvents, WorldEvents } from '@strkworld/shared';
import { createEventBus } from '../bus/event-bus.js';
import { COPY } from '../copy.js';
import { PlacementPanel } from '../panels/plaza/PlacementPanel.js';
import { PrivacyProvider } from '../privacy/PrivacyProvider.js';
import { VisitLayer } from '../visits/VisitLayer.js';
import { PlazaProvider } from './PlazaProvider.js';

/**
 * Leaderboard phase 1, the consent pop-up (D-122, amended 2026-10-02 at the
 * lead's request): the placement stand asks before every check, and nothing
 * reaches the app owner's tally until the player presses Continue.
 *
 * One check is one step in `packages/privacy` — the wallet's season
 * commitment, the backend's pinned shadow read and the tally's check-in — so
 * "no tally call" is asserted on `checkPlacement` itself: that one call is
 * the whole disclosure.
 */

/** As `placement.test.tsx`: Vite inlines `import.meta.env`, so the switch is stood in for. */
const stand = vi.hoisted(() => ({ on: true }));
vi.mock('../production/config.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../production/config.js')>()),
  detectPlacementStand: () => stand.on,
}));

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

/** The fake, counting every call that would reach the tally. */
class CountingOperations extends FakePrivacyOperations {
  checks = 0;

  override async checkPlacement(signal?: AbortSignal): Promise<PlacementCheck> {
    this.checks += 1;
    return super.checkPlacement(signal);
  }
}

let root: Root | null = null;
let container: HTMLElement | null = null;

beforeEach(() => {
  try {
    globalThis.localStorage?.clear();
  } catch {
    // A browser without storage is a first check, which is what these want.
  }
});

afterEach(() => {
  const owner = root;
  root = null;
  if (owner) act(() => owner.unmount());
  container?.remove();
  container = null;
});

function mount(node: React.ReactElement): void {
  container = document.createElement('div');
  document.body.append(container);
  root = createRoot(container);
  act(() => root!.render(node));
}

/** The stand's panel on its own, with a counting operations seam. */
function panel(): CountingOperations {
  const operations = new CountingOperations();
  mount(
    <PrivacyProvider operations={operations}>
      <PlacementPanel onClose={() => {}} />
    </PrivacyProvider>,
  );
  return operations;
}

const dialog = (): HTMLElement | null => container!.querySelector('[role="dialog"]');
const checkButton = (): HTMLButtonElement => container!.querySelector<HTMLButtonElement>('.placement-check')!;
const button = (className: string): HTMLButtonElement => container!.querySelector<HTMLButtonElement>(className)!;

async function press(element: HTMLElement): Promise<void> {
  await act(async () => {
    element.dispatchEvent(new MouseEvent('click', { bubbles: true }));
  });
}

async function key(init: KeyboardEventInit): Promise<void> {
  await act(async () => {
    window.dispatchEvent(new KeyboardEvent('keydown', { bubbles: true, ...init }));
  });
}

describe('the consent pop-up, before every placement check', () => {
  it('appears on "Check privately" with the lead\'s words, and sends nothing yet', async () => {
    const operations = panel();
    expect(dialog()).toBeNull();

    await press(checkButton());

    const asked = dialog()!;
    expect(asked.getAttribute('aria-modal')).toBe('true');
    expect(asked.querySelector('.consent-title')!.textContent).toBe('Check your placement');
    expect(asked.querySelector('.consent-body')!.textContent).toBe(
      "Checking your placement shares tracking information with the STRKWORLD app owner only — which of your private actions this season are yours. It's never public or shown to other players. Only continue if you're comfortable sharing this.",
    );
    expect(asked.querySelector('.consent-confirm')!.textContent).toBe('Continue');
    expect(asked.querySelector('.consent-cancel')!.textContent).toBe('Cancel');
    // The heading, body and both labels are the authored copy.
    expect(asked.querySelector('.consent-title')!.textContent).toBe(COPY.plaza.placement.consent.title);
    expect(asked.querySelector('.consent-body')!.textContent).toBe(COPY.plaza.placement.consent.body);
    // Nothing has left the device.
    expect(operations.checks).toBe(0);
  });

  it('sends nothing on Cancel, on Escape or on a press outside', async () => {
    for (const close of [
      async () => press(button('.consent-cancel')),
      async () => key({ key: 'Escape' }),
      async () => act(async () => {
        document.body.dispatchEvent(new MouseEvent('pointerdown', { bubbles: true }));
      }),
    ]) {
      const operations = panel();
      await press(checkButton());
      expect(dialog()).not.toBeNull();

      await close();

      expect(dialog()).toBeNull();
      expect(operations.checks).toBe(0);
      // The window itself is untouched: no result, no failure, no notice.
      expect(container!.querySelector('.placement')!.getAttribute('data-phase')).toBe('ready');
      expect(container!.textContent).not.toContain(COPY.plaza.placement.failed);
      const owner = root;
      root = null;
      act(() => owner!.unmount());
      container!.remove();
    }
  });

  it('calls the tally exactly once on Continue, and asks again before the next check', async () => {
    const operations = panel();

    await press(checkButton());
    await press(button('.consent-confirm'));

    expect(operations.checks).toBe(1);
    expect(dialog()).toBeNull();
    expect(container!.querySelector('[data-stat="top"]')!.textContent).toContain('Top ');

    // The next check asks again: consent is never remembered between checks.
    await press(checkButton());
    expect(dialog()).not.toBeNull();
    expect(operations.checks).toBe(1);
    await press(button('.consent-confirm'));
    expect(operations.checks).toBe(2);
  });

  it('remembers no answer, and offers no way to stop being asked', async () => {
    panel();
    await press(checkButton());
    // No "don't ask again": the lead asked for the warning before every check.
    expect(dialog()!.querySelectorAll('input, [type="checkbox"]')).toHaveLength(0);
    expect(dialog()!.querySelectorAll('button')).toHaveLength(2);
    // And the dialog cannot remember an answer: it touches no storage at all.
    const source = readFileSync(join(process.cwd(), 'apps/web/src/panels/ConsentDialog.tsx'), 'utf8');
    expect(source).not.toMatch(/localStorage|sessionStorage|ViewerStorage|document\.cookie/);
  });
});

describe('the pop-up\'s focus', () => {
  it('moves into the dialog, keeps Tab inside it, and goes back to the trigger on close', async () => {
    panel();
    const trigger = checkButton();
    trigger.focus();
    expect(document.activeElement).toBe(trigger);

    await press(trigger);
    expect(document.activeElement).toBe(dialog());

    // jsdom does not move focus on Tab itself, so what is asserted here is the
    // trap: every Tab that would leave the dialog is turned back into it.
    await key({ key: 'Tab', shiftKey: true });
    expect(document.activeElement).toBe(button('.consent-cancel'));
    await key({ key: 'Tab' });
    expect(document.activeElement).toBe(button('.consent-confirm'));
    await key({ key: 'Tab', shiftKey: true });
    expect(document.activeElement).toBe(button('.consent-cancel'));
    // Focus parked outside is pulled back to the first control.
    trigger.focus();
    await key({ key: 'Tab' });
    expect(document.activeElement).toBe(button('.consent-confirm'));

    await key({ key: 'Escape' });
    expect(dialog()).toBeNull();
    expect(document.activeElement).toBe(checkButton());
  });
});

describe('the World and the window behind the pop-up', () => {
  it('hears no keystroke while it is open, and hears them again once it closes', async () => {
    // The World's own keyboard listens for `keydown` on the window in the
    // bubble phase (`dom-keyboard.ts`), and so does the visit layer's Escape.
    // This stands in for both.
    const heard: string[] = [];
    const listener = (event: Event): void => {
      heard.push((event as KeyboardEvent).code || (event as KeyboardEvent).key);
    };
    window.addEventListener('keydown', listener);
    try {
      const operations = panel();
      await press(checkButton());

      for (const code of ['KeyE', 'KeyW', 'ArrowLeft', 'Space']) await key({ code, key: code });
      expect(heard).toEqual([]);
      expect(operations.checks).toBe(0);
      expect(dialog()).not.toBeNull();

      await key({ key: 'Escape' });
      expect(dialog()).toBeNull();
      for (const code of ['KeyE', 'Space']) await key({ code, key: code });
      expect(heard).toEqual(['KeyE', 'Space']);
    } finally {
      window.removeEventListener('keydown', listener);
    }
  });

  it('keeps the stand\'s window open on the Escape that answers it, through the real visit layer', async () => {
    const world = createEventBus<WorldEvents>();
    const shell = createEventBus<ShellEvents>();
    const owners: Array<ShellEvents['world:control-owner']> = [];
    shell.on('world:control-owner', (payload) => owners.push(payload));
    const operations = new CountingOperations();
    mount(
      <PrivacyProvider operations={operations}>
        <PlazaProvider world={world} shell={shell} demo>
          <VisitLayer world={world} shell={shell} />
        </PlazaProvider>
      </PrivacyProvider>,
    );

    await act(async () => world.emit('station:activated', { building: 'plaza', station: 'plaza:placement' }));
    expect(container!.textContent).toContain(COPY.plaza.placement.title);
    expect(owners).toEqual([{ building: 'plaza', owner: 'shell' }]);

    await press(checkButton());
    expect(dialog()).not.toBeNull();

    // The first Escape answers the dialog and goes no further: the stand's
    // window stays open and the Shell still owns the controls.
    await key({ key: 'Escape' });
    expect(dialog()).toBeNull();
    expect(operations.checks).toBe(0);
    expect(container!.querySelector('.panel')).not.toBeNull();
    expect(owners).toEqual([{ building: 'plaza', owner: 'shell' }]);

    // The next one closes the window and hands the keyboard back.
    await key({ key: 'Escape' });
    expect(container!.querySelector('.panel')).toBeNull();
    expect(owners.at(-1)).toEqual({ building: 'plaza', owner: 'world' });
  });
});
