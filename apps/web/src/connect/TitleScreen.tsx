import type { ReactNode } from 'react';
import { Wordmark } from '../brand/Wordmark.js';
import { TitleBackdrop } from './TitleBackdrop.js';

/**
 * The title screen: the way into STRKWORLD, after Cube World's.
 *
 * The real overworld floats behind, the wordmark sits big at the top, and
 * whatever step of the way in the player is at stacks below it as a simple
 * menu: choosing a wallet, the capability check and its rooms, and the entry
 * gate's cards (D-072). The steps keep their own markup, copy and behaviour;
 * this only frames them. Nothing here sees money or the wallet.
 */
export function TitleScreen({ children }: { children: ReactNode }) {
  return (
    <div className="title-screen" data-testid="title-screen">
      <TitleBackdrop />
      <div className="title-front">
        <Wordmark className="title-wordmark" />
        <div className="title-menu">{children}</div>
      </div>
    </div>
  );
}
