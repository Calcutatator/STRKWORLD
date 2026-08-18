import { describe, expect, it, vi } from 'vitest';
import { installPresenceTeardown } from './lifecycle.js';
import type { PresenceController } from './presence-controller.js';

describe('installPresenceTeardown', () => {
  it('owns pagehide and HMR teardown without involving React effects', () => {
    const destroy = vi.fn(async () => {});
    const presence = { destroy } as unknown as PresenceController;
    let pagehide!: (event?: { persisted?: boolean }) => void;
    const page = { addEventListener: vi.fn((_type, callback) => { pagehide = callback; }), removeEventListener: vi.fn() };
    const hot = { dispose: vi.fn() };
    const remove = installPresenceTeardown(presence, page, hot);
    pagehide({ persisted: true });
    expect(destroy).not.toHaveBeenCalled();
    expect(page.removeEventListener).not.toHaveBeenCalled();
    pagehide();
    expect(destroy).toHaveBeenCalledTimes(1);
    expect(page.removeEventListener).toHaveBeenCalledTimes(1);
    hot.dispose.mock.calls[0]?.[0]();
    expect(destroy).toHaveBeenCalledTimes(1);
    expect(page.removeEventListener).toHaveBeenCalledTimes(1);
    remove();
    expect(page.removeEventListener).toHaveBeenCalledTimes(1);
  });
});
