// @vitest-environment jsdom
import { renderToStaticMarkup } from 'react-dom/server';
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { describe, expect, it } from 'vitest';
import { WORDMARK_SIZE } from '../brand/Wordmark.js';
import { TitleScreen } from './TitleScreen.js';
import { webglLikely } from './TitleBackdrop.js';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

describe('the title screen (D-115)', () => {
  it('puts the wordmark over the menu, with the backdrop behind', () => {
    const markup = renderToStaticMarkup(
      <TitleScreen>
        <section className="room room-connect">menu</section>
      </TitleScreen>,
    );
    const container = document.createElement('div');
    container.innerHTML = markup;
    const screen = container.querySelector('[data-testid="title-screen"]')!;
    const [backdrop, front] = [...screen.children];
    expect(backdrop?.className).toBe('title-backdrop');
    expect(backdrop?.getAttribute('aria-hidden')).toBe('true');
    const title = front!.querySelector('h1.brand-wordmark img')!;
    expect(title.getAttribute('alt')).toBe('STRKWORLD');
    expect(title.getAttribute('src')).toMatch(/wordmark-1200\.webp$/);
    expect(title.getAttribute('srcset')).toMatch(/wordmark-2400\.webp 2x$/);
    expect(Number(title.getAttribute('width')) / Number(title.getAttribute('height'))).toBeCloseTo(2658 / 1498, 2);
    expect(WORDMARK_SIZE.width).toBe(1200);
    // The menu comes after the title, and is the step's own markup.
    expect(front!.querySelector('.title-menu > .room-connect')?.textContent).toBe('menu');
  });

  it('shows the palette gradient and loads no scene where WebGL cannot run', async () => {
    // jsdom has no WebGL: the backdrop must not even try.
    expect(webglLikely(window)).toBe(false);
    const container = document.createElement('div');
    document.body.appendChild(container);
    const root = createRoot(container);
    await act(async () => {
      root.render(<TitleScreen><p>menu</p></TitleScreen>);
    });
    const backdrop = container.querySelector('.title-backdrop')!;
    expect(backdrop.getAttribute('data-status')).toBe('unavailable');
    expect(backdrop.childElementCount).toBe(0);
    await act(async () => root.unmount());
    container.remove();
  });

  it('expects WebGL wherever a rendering context type exists', () => {
    expect(webglLikely(null)).toBe(false);
    expect(webglLikely({ WebGLRenderingContext: function WebGL() {} } as unknown as Window)).toBe(true);
    expect(webglLikely({ WebGL2RenderingContext: function WebGL2() {} } as unknown as Window)).toBe(true);
  });
});
