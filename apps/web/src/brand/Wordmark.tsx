/**
 * The STRKWORLD wordmark (D-113): Direction A's cube letters, as approved.
 *
 * The one place the title is drawn, so swapping the mark is a change to this
 * file alone. The images are web copies of `docs/brand/assets/wordmark.png`
 * (2658×1498), resized and never redrawn or recoloured, and bundled
 * same-origin like every other asset.
 */
const WORDMARK_1X = new URL('./assets/wordmark-1200.webp', import.meta.url).href;
const WORDMARK_2X = new URL('./assets/wordmark-2400.webp', import.meta.url).href;

/** The 1x image's size; the 2x copy is twice it. The master's aspect is kept. */
export const WORDMARK_SIZE = Object.freeze({ width: 1200, height: 676 });

export function Wordmark({ className }: { className?: string }) {
  return (
    <h1 className={className ? `brand-wordmark ${className}` : 'brand-wordmark'}>
      <img
        src={WORDMARK_1X}
        srcSet={`${WORDMARK_1X} 1x, ${WORDMARK_2X} 2x`}
        width={WORDMARK_SIZE.width}
        height={WORDMARK_SIZE.height}
        alt="STRKWORLD"
        decoding="async"
        draggable={false}
      />
    </h1>
  );
}
