// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { FakePrivacyOperations, type PlacementCheck, type WalletSession } from '@strkworld/privacy';
import { COPY } from '../copy.js';
import { PlacementPanel, PlacementPanelView } from '../panels/plaza/PlacementPanel.js';
import { PrivacyProvider } from '../privacy/PrivacyProvider.js';

/**
 * Leaderboard phase 1, the waiting state's one warning (D-122, amended
 * 2026-10-03). A check makes at most one wallet prompt — the season commitment
 * — and none when this connection already shared it, so the stand says "Your
 * wallet will ask to share your season ID" exactly when a prompt is coming.
 *
 * The consent pop-up is unchanged and still comes first
 * (`placement-consent.test.tsx`); this is what the panel shows after Continue.
 */

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

const HINT = 'Your wallet will ask to share your season ID';
const LINE = '.placement-wallet-prompt';

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

/** An operations seam that says whether a check would prompt, and holds the check open. */
class PromptingOperations extends FakePrivacyOperations {
  willPrompt = true;
  checks = 0;
  private release: (() => void) | null = null;

  // The shipped fake caches nothing, so this is the adapter's read standing in.
  placementWillPrompt(): boolean {
    return this.willPrompt;
  }

  override async checkPlacement(signal?: AbortSignal): Promise<PlacementCheck> {
    this.checks += 1;
    // The first commitment is shared by this check, so the next prompts nothing.
    this.willPrompt = false;
    await new Promise<void>((resolve) => { this.release = resolve; });
    return super.checkPlacement(signal);
  }

  async finish(): Promise<void> {
    const release = this.release;
    this.release = null;
    await act(async () => { release?.(); });
  }
}

/** The stand's panel over a connected account, which is what a probe tab has. */
function panel(operations: PromptingOperations, account: string | null = '0xabc'): void {
  // One frozen snapshot: `useSyncExternalStore` needs a stable identity.
  const snapshot = Object.freeze({
    phase: account ? 'connected' : 'selection-required',
    account,
    choices: Object.freeze([]),
  });
  const session = {
    operations,
    getSnapshot: () => snapshot,
    subscribe: () => () => {},
  } as unknown as WalletSession;
  container = document.createElement('div');
  document.body.append(container);
  root = createRoot(container);
  act(() => root!.render(
    <PrivacyProvider operations={operations} walletSession={session} shellBus={null}>
      <PlacementPanel onClose={() => {}} />
    </PrivacyProvider>,
  ));
}

const checkButton = (): HTMLButtonElement => container!.querySelector<HTMLButtonElement>('.placement-check')!;
const hint = (): HTMLElement | null => container!.querySelector<HTMLElement>(LINE);

async function press(element: HTMLElement): Promise<void> {
  await act(async () => {
    element.dispatchEvent(new MouseEvent('click', { bubbles: true }));
  });
}

/** "Check privately", then Continue on the pop-up: the only path a check starts on. */
async function consentedCheck(): Promise<void> {
  await press(checkButton());
  await press(container!.querySelector<HTMLButtonElement>('.consent-confirm')!);
}

describe('the waiting state warns about the one wallet prompt', () => {
  it('says so on the first check of a session, and never before Continue', async () => {
    const operations = new PromptingOperations();
    panel(operations);
    expect(hint()).toBeNull();

    await press(checkButton());
    // The pop-up is up and nothing has been asked yet.
    expect(operations.checks).toBe(0);
    expect(hint()).toBeNull();

    await press(container!.querySelector<HTMLButtonElement>('.consent-confirm')!);
    expect(operations.checks).toBe(1);
    expect(hint()!.textContent).toBe(HINT);
    expect(hint()!.getAttribute('role')).toBe('status');

    await operations.finish();
    // The result replaces the waiting state, warning and all.
    expect(hint()).toBeNull();
  });

  it('says nothing on a second check, because nothing is asked', async () => {
    const operations = new PromptingOperations();
    panel(operations);
    await consentedCheck();
    expect(hint()!.textContent).toBe(HINT);
    await operations.finish();

    await consentedCheck();
    expect(operations.checks).toBe(2);
    // Still waiting on the check, and this time with no warning.
    expect(container!.querySelector('.placement')!.getAttribute('data-phase')).toBe('checking');
    expect(hint()).toBeNull();
    await operations.finish();
  });

  it('says nothing in the practice city, where no wallet is connected', async () => {
    const operations = new PromptingOperations();
    panel(operations, null);
    await consentedCheck();
    expect(hint()).toBeNull();
    await operations.finish();
  });

  it('says nothing when the seam cannot answer at all', () => {
    // A seam without the optional read is treated as "a prompt may come".
    const bare = new FakePrivacyOperations() as FakePrivacyOperations & { placementWillPrompt?: () => boolean };
    expect(bare.placementWillPrompt?.() ?? true).toBe(true);
  });
});

describe('the warning is the authored copy, in the waiting state only', () => {
  it('renders in the checking phase and nowhere else', () => {
    const markup = (phase: Parameters<typeof PlacementPanelView>[0]['phase']) =>
      renderToStaticMarkup(
        <PlacementPanelView phase={phase} previous={null} demo={false} onCheck={() => {}} onClose={() => {}} />,
      );
    expect(markup({ name: 'checking', prompting: true })).toContain(COPY.plaza.placement.walletPrompt);
    for (const phase of [
      { name: 'checking' } as const,
      { name: 'checking', prompting: false } as const,
      { name: 'ready' } as const,
      { name: 'refused' } as const,
      { name: 'failed' } as const,
    ]) {
      expect(markup(phase), phase.name).not.toContain(COPY.plaza.placement.walletPrompt);
    }
  });

  it('names the season ID and never the commitment itself', () => {
    expect(COPY.plaza.placement.walletPrompt).toBe(HINT);
    expect(COPY.plaza.placement.walletPrompt).not.toMatch(/commitment|0x/i);
  });
});
