// @vitest-environment jsdom
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { FakePrivacyOperations } from '@strkworld/privacy';

const loader = vi.hoisted(() => vi.fn());
vi.mock('./demo-loader.js', () => ({ loadDemoOperations: loader }));

import { PrivacyProvider, usePrivacy } from './PrivacyProvider.js';

function Probe() {
  const { operations } = usePrivacy();
  return <p data-loaded={operations ? 'yes' : 'no'}>demo app</p>;
}

describe('PrivacyProvider lazy demo loader', () => {
  const previousActEnvironment = (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT;

  beforeAll(() => {
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  });

  beforeEach(() => {
    loader.mockReset();
  });

  afterAll(() => {
    if (previousActEnvironment === undefined) delete (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT;
    else (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = previousActEnvironment;
  });

  it('shows a retry surface when the demo seam cannot load', async () => {
    loader.mockRejectedValueOnce(new Error('demo chunk unavailable'));
    const container = document.createElement('div');
    const root = createRoot(container);

    await act(async () => {
      root.render(
        <PrivacyProvider demo fallback={<p>loading</p>}>
          <Probe />
        </PrivacyProvider>,
      );
      await flushReact();
    });

    expect(container.querySelector('[role="alert"]')?.textContent).toContain('could not load');
    expect(container.querySelector('button')?.textContent).toContain('Try again');
    expect(container.textContent).not.toBe('loading');

    await act(async () => root.unmount());
    container.remove();
  });

  it('loads the demo seam after retrying a failed lazy import', async () => {
    loader
      .mockRejectedValueOnce(new Error('demo chunk unavailable'))
      .mockResolvedValueOnce(new FakePrivacyOperations());
    const container = document.createElement('div');
    const root = createRoot(container);

    await act(async () => {
      root.render(
        <PrivacyProvider demo fallback={<p>loading</p>}>
          <Probe />
        </PrivacyProvider>,
      );
      await flushReact();
    });
    expect(container.querySelector('button')?.textContent).toContain('Try again');

    await act(async () => {
      container.querySelector('button')?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
      await flushReact();
    });

    expect(loader).toHaveBeenCalledTimes(2);
    expect(container.querySelector('[data-loaded="yes"]')).not.toBeNull();

    await act(async () => root.unmount());
    container.remove();
  });

  it('does not let a retired demo failure mask a newly supplied explicit seam', async () => {
    let rejectDemo!: (error: unknown) => void;
    loader.mockReturnValueOnce(new Promise<never>((_resolve, reject) => {
      rejectDemo = reject;
    }));
    const container = document.createElement('div');
    const root = createRoot(container);

    await act(async () => {
      root.render(
        <PrivacyProvider demo fallback={<p>loading</p>}>
          <Probe />
        </PrivacyProvider>,
      );
      await Promise.resolve();
    });

    await act(async () => {
      root.render(
        <PrivacyProvider operations={new FakePrivacyOperations()}>
          <Probe />
        </PrivacyProvider>,
      );
      await flushReact();
    });
    expect(container.querySelector('[data-loaded="yes"]')).not.toBeNull();

    await act(async () => {
      rejectDemo(new Error('retired demo chunk failed'));
      await flushReact();
    });
    expect(container.querySelector('[role="alert"]')).toBeNull();
    expect(container.querySelector('[data-loaded="yes"]')).not.toBeNull();

    await act(async () => root.unmount());
    container.remove();
  });

  it('consumes a late loader rejection after the provider unmounts', async () => {
    let rejectDemo!: (error: unknown) => void;
    loader.mockReturnValueOnce(new Promise<never>((_resolve, reject) => {
      rejectDemo = reject;
    }));
    const container = document.createElement('div');
    const root = createRoot(container);

    await act(async () => {
      root.render(
        <PrivacyProvider demo fallback={<p>loading</p>}>
          <Probe />
        </PrivacyProvider>,
      );
      await Promise.resolve();
    });

    await act(async () => root.unmount());
    await act(async () => {
      rejectDemo(new Error('unmounted demo chunk failed'));
      await flushReact();
    });

    expect(container.textContent).toBe('');
    container.remove();
  });
});

async function flushReact(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
  await new Promise<void>((resolve) => setTimeout(resolve, 0));
}
