import { Fragment } from 'react';
import { COPY } from '../copy.js';

/**
 * Where to get a wallet, for a choose-a-wallet card whose discovery lists
 * none (D-073). Static display content that opens each site in a new tab.
 * Nothing here feeds discovery, the wallet list or the STRK20 path, and a
 * wallet named here is listed and treated exactly like any other once it
 * registers (SPEC §5 rules 1 and 2).
 */
export function GetAWallet() {
  return (
    <p className="room-detail room-links" data-testid="get-a-wallet">
      {COPY.connect.getWallet}{' '}
      {COPY.connect.installLinks.map((link, index) => (
        <Fragment key={link.href}>
          {index > 0 ? <span aria-hidden="true"> · </span> : null}
          <a href={link.href} target="_blank" rel="noopener noreferrer">
            {link.label}
          </a>
        </Fragment>
      ))}
    </p>
  );
}
