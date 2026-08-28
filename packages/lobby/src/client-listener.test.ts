import { describe, expect, it, vi } from 'vitest';
import { LobbyClient, type LobbyStatusEvent, type PeerSnapshot } from './client.js';

function client(): LobbyClient {
  return new LobbyClient({
    endpoint: 'ws://127.0.0.1:1',
    start: { x: 0, y: 0 },
  });
}

describe('LobbyClient listener ownership', () => {
  it('isolates a throwing status replay and still returns its cleanup', async () => {
    const lobby = client();
    const error = new Error('status replay failed');
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const listener = vi.fn(() => {
      throw error;
    });

    try {
      let stop!: () => void;
      expect(() => {
        stop = lobby.onStatus(listener);
      }).not.toThrow();
      stop();
      await lobby.disconnect();

      expect(listener).toHaveBeenCalledOnce();
      expect(consoleError).toHaveBeenCalledWith('lobby client: status subscriber threw');
      expect(consoleError).not.toHaveBeenCalledWith(
        'lobby client: status subscriber threw',
        error,
      );
    } finally {
      consoleError.mockRestore();
    }
  });

  it('isolates a throwing peer replay and still returns its cleanup', async () => {
    const lobby = client();
    const error = new Error('peer replay failed');
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const listener = vi.fn(() => {
      throw error;
    });

    try {
      let stop!: () => void;
      expect(() => {
        stop = lobby.onPeers(listener);
      }).not.toThrow();
      stop();
      await lobby.disconnect();

      expect(listener).toHaveBeenCalledOnce();
      expect(consoleError).toHaveBeenCalledWith('lobby client: peer subscriber threw');
      expect(consoleError).not.toHaveBeenCalledWith(
        'lobby client: peer subscriber threw',
        error,
      );
    } finally {
      consoleError.mockRestore();
    }
  });

  it('keeps status delivery moving after a subscriber throws', async () => {
    const lobby = client();
    const error = new Error('status transition failed');
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const later = vi.fn();
    lobby.onStatus((event) => {
      if (event.status === 'closed') throw error;
    });
    lobby.onStatus(later);

    try {
      await expect(lobby.disconnect()).resolves.toBeUndefined();
      expect(later).toHaveBeenLastCalledWith({ status: 'closed', reason: 'client-left' });
      expect(consoleError).toHaveBeenCalledWith('lobby client: status subscriber threw');
      expect(consoleError).not.toHaveBeenCalledWith(
        'lobby client: status subscriber threw',
        error,
      );
    } finally {
      consoleError.mockRestore();
    }
  });

  it('keeps peer delivery moving after a subscriber throws', async () => {
    const lobby = client();
    const error = new Error('peer transition failed');
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    let first = true;
    const later = vi.fn();
    lobby.onPeers(() => {
      if (first) {
        first = false;
        return;
      }
      throw error;
    });
    lobby.onPeers(later);

    try {
      await expect(lobby.disconnect()).resolves.toBeUndefined();
      expect(later).toHaveBeenCalledTimes(2);
      expect(later).toHaveBeenLastCalledWith([]);
      expect(consoleError).toHaveBeenCalledWith('lobby client: peer subscriber threw');
      expect(consoleError).not.toHaveBeenCalledWith(
        'lobby client: peer subscriber threw',
        error,
      );
    } finally {
      consoleError.mockRestore();
    }
  });

  it('gives a status listener added during delivery one immediate replay only', async () => {
    const lobby = client();
    const lateClosed: LobbyStatusEvent[] = [];
    let added = false;
    lobby.onStatus((event) => {
      if (event.status !== 'closed' || added) return;
      added = true;
      lobby.onStatus((late) => {
        if (late.status === 'closed') lateClosed.push(late);
      });
    });

    await lobby.disconnect();

    expect(lateClosed).toEqual([{ status: 'closed' }]);
  });

  it('does not redeliver an in-flight status transition to a replacement generation', async () => {
    const lobby = client();
    const secondClosed: LobbyStatusEvent[] = [];
    const second = (event: LobbyStatusEvent) => {
      if (event.status === 'closed') secondClosed.push(event);
    };
    let replaced = false;
    let stopSecond!: () => void;
    lobby.onStatus((event) => {
      if (event.status !== 'closed' || replaced) return;
      replaced = true;
      stopSecond();
      stopSecond = lobby.onStatus(second);
    });
    stopSecond = lobby.onStatus(second);

    await lobby.disconnect();

    expect(secondClosed).toEqual([{ status: 'closed' }]);
  });

  it('gives a peer listener added during delivery one immediate replay only', async () => {
    const lobby = client();
    const lateSnapshots: Array<readonly PeerSnapshot[]> = [];
    let first = true;
    lobby.onPeers(() => {
      if (first) {
        first = false;
        return;
      }
      lobby.onPeers((peers) => lateSnapshots.push(peers));
    });

    await lobby.disconnect();

    expect(lateSnapshots).toEqual([[]]);
  });

  it('does not redeliver an in-flight peer transition to a replacement generation', async () => {
    const lobby = client();
    const secondSnapshots: Array<readonly PeerSnapshot[]> = [];
    const second = (peers: readonly PeerSnapshot[]) => secondSnapshots.push(peers);
    let first = true;
    let stopSecond!: () => void;
    lobby.onPeers(() => {
      if (first) {
        first = false;
        return;
      }
      stopSecond();
      stopSecond = lobby.onPeers(second);
    });
    stopSecond = lobby.onPeers(second);
    secondSnapshots.length = 0;

    await lobby.disconnect();

    expect(secondSnapshots).toEqual([[]]);
  });

  it('skips a status listener unsubscribed before its captured turn', async () => {
    const lobby = client();
    const second = vi.fn();
    let stopSecond!: () => void;
    lobby.onStatus((event) => {
      if (event.status === 'closed') stopSecond();
    });
    stopSecond = lobby.onStatus(second);
    second.mockClear();

    await lobby.disconnect();

    expect(second).not.toHaveBeenCalled();
  });

  it('skips a peer listener unsubscribed before its captured turn', async () => {
    const lobby = client();
    const second = vi.fn();
    let first = true;
    let stopSecond!: () => void;
    lobby.onPeers(() => {
      if (first) {
        first = false;
        return;
      }
      stopSecond();
    });
    stopSecond = lobby.onPeers(second);
    second.mockClear();

    await lobby.disconnect();

    expect(second).not.toHaveBeenCalled();
  });

  it('keeps replacement status ownership after stale cleanup', async () => {
    const lobby = client();
    const closed: LobbyStatusEvent[] = [];
    const listener = (event: LobbyStatusEvent) => {
      if (event.status === 'closed') closed.push(event);
    };
    const staleStop = lobby.onStatus(listener);
    lobby.onStatus(listener);

    staleStop();
    staleStop();
    await lobby.disconnect();

    expect(closed).toEqual([{ status: 'closed', reason: 'client-left' }]);
  });

  it('keeps replacement peer ownership after stale cleanup', async () => {
    const lobby = client();
    const snapshots: Array<readonly PeerSnapshot[]> = [];
    const listener = (peers: readonly PeerSnapshot[]) => snapshots.push(peers);
    const staleStop = lobby.onPeers(listener);
    lobby.onPeers(listener);

    staleStop();
    staleStop();
    snapshots.length = 0;
    await lobby.disconnect();

    expect(snapshots).toEqual([[]]);
  });
});
