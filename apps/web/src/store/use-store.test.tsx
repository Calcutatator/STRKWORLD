import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { useStore } from './use-store.js';
import type { ReadableStore } from './store.js';

describe('useStore', () => {
  it('retains the store receiver for external-store callbacks', () => {
    const value = 7;
    let store!: ReadableStore<number>;
    store = {
      subscribe(this: ReadableStore<number>, listener: (state: number) => void) {
        if (this !== store) throw new Error('ReadableStore receiver lost');
        void listener;
        return () => undefined;
      },
      getState(this: ReadableStore<number>) {
        if (this !== store) throw new Error('ReadableStore receiver lost');
        return value;
      },
      getServerSnapshot(this: ReadableStore<number>) {
        if (this !== store) throw new Error('ReadableStore receiver lost');
        return value;
      },
    } satisfies ReadableStore<number>;

    function Probe() {
      return <span>{useStore(store)}</span>;
    }

    expect(() => renderToStaticMarkup(<Probe />)).not.toThrow();
  });
});
