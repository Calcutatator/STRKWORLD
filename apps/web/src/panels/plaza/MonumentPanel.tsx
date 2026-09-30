import { COPY } from '../../copy.js';
import { usePoolStatsWindow } from '../../plaza/PlazaProvider.js';
import type { PoolStatsView } from '../../plaza/pool-stats-poller.js';
import { formatCompactUsd, formatExactUsd, formatHoldingLine, formatPlazaCount } from '../../plaza/pool-stats.js';
import { PanelFrame } from '../PanelFrame.js';

/**
 * The Privacy Plaza monument's window (D-076): the pool's public figures —
 * accounts, deposits and, since D-080, the pool's USD value and its top
 * holdings, read by the backend from Voyager through strkprice.com — and a
 * few plain lines on why a bigger crowd means more privacy. No money, no
 * wallet: nothing in it is about the player, and it asks nothing of them.
 */
export function MonumentPanel({ onClose }: { onClose: () => void }) {
  const { view } = usePoolStatsWindow();
  return <MonumentPanelView view={view} onClose={onClose} />;
}

/** Pure render half, so every state is a static-render test. */
export function MonumentPanelView({
  view,
  onClose,
}: {
  view: PoolStatsView;
  onClose: () => void;
}) {
  const copy = COPY.plaza.monument;
  const stats = view.stats;
  const figure = (value: number | null | undefined): string =>
    value === null || value === undefined ? copy.unknown : formatPlazaCount(value);
  const topHoldings = stats?.topHoldings ?? null;
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
            {stats?.valueUsd == null ? (
              copy.unknown
            ) : (
              <span title={formatExactUsd(stats.valueUsd)}>{formatCompactUsd(stats.valueUsd)}</span>
            )}
          </dd>
        </div>
        {topHoldings && topHoldings.length > 0 ? (
          <div>
            <dt>{copy.topHoldings}</dt>
            <dd data-stat="top-holdings">
              <ul className="plaza-held">
                {topHoldings.map((holding) => (
                  <li key={holding.symbol}>{formatHoldingLine(holding)}</li>
                ))}
              </ul>
            </dd>
          </div>
        ) : null}
      </dl>
      {view.status === 'failed' && stats === null ? (
        <p className="panel-notice plaza-stats-failed" role="status">
          {copy.failed}
        </p>
      ) : null}
      <p className="plaza-source">{copy.source}</p>
      <h3 className="plaza-subhead">{copy.setTitle}</h3>
      <p className="plaza-set">{copy.set.join(' ')}</p>
      <p className="plaza-edges">{copy.edges}</p>
    </PanelFrame>
  );
}
