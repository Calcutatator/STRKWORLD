import { COPY } from '../../copy.js';
import { usePoolStatsWindow } from '../../plaza/PlazaProvider.js';
import type { PoolStatsView } from '../../plaza/pool-stats-poller.js';
import { formatPanelAmount, formatPlazaCount, plazaHeldLines, type PlazaToken } from '../../plaza/pool-stats.js';
import { PanelFrame } from '../PanelFrame.js';

/**
 * The Privacy Plaza monument's window (D-076): the pool's public figures,
 * the same three as the monument's faces, and a few plain lines on why a
 * bigger crowd means more privacy. No money, no wallet: nothing in it is
 * about the player, and it asks nothing of them.
 */
export function MonumentPanel({ onClose }: { onClose: () => void }) {
  const { view, tokens } = usePoolStatsWindow();
  return <MonumentPanelView view={view} tokens={tokens} onClose={onClose} />;
}

/** Pure render half, so every state is a static-render test. */
export function MonumentPanelView({
  view,
  tokens,
  onClose,
}: {
  view: PoolStatsView;
  tokens: readonly PlazaToken[];
  onClose: () => void;
}) {
  const copy = COPY.plaza.monument;
  const stats = view.stats;
  const held = plazaHeldLines(stats?.held ?? null, tokens, formatPanelAmount);
  const figure = (value: number | null | undefined): string =>
    value === null || value === undefined ? copy.unknown : formatPlazaCount(value);
  return (
    <PanelFrame title={copy.title} building="plaza" disclosure={null} onClose={onClose}>
      <p className="panel-intro">{copy.intro}</p>
      {view.demo ? (
        <p className="panel-notice plaza-demo" role="note">
          {copy.demo}
        </p>
      ) : null}
      <dl className="plaza-stats" aria-busy={view.status === 'loading' ? true : undefined}>
        <div>
          <dt>{copy.accounts}</dt>
          <dd data-stat="accounts">{figure(stats?.accounts)}</dd>
        </div>
        <div>
          <dt>{copy.deposits24h}</dt>
          <dd data-stat="deposits24h">{figure(stats?.deposits24h)}</dd>
        </div>
        <div>
          <dt>{copy.held}</dt>
          <dd data-stat="held">
            {held ? (
              <ul className="plaza-held">
                {held.map((line) => (
                  <li key={line}>{line}</li>
                ))}
              </ul>
            ) : (
              copy.unknown
            )}
          </dd>
        </div>
      </dl>
      {view.status === 'failed' && stats === null ? (
        <p className="panel-notice plaza-stats-failed" role="status">
          {copy.failed}
        </p>
      ) : null}
      <h3 className="plaza-subhead">{copy.setTitle}</h3>
      <p className="plaza-set">{copy.set.join(' ')}</p>
      <p className="plaza-edges">{copy.edges}</p>
    </PanelFrame>
  );
}
