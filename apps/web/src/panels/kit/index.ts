/**
 * The panel kit: small shared controls for the building panels, so a swap, a
 * supply, a stake and a send all read as the same city.
 *
 * Three rules for using it:
 *
 * 1. **Opt in, per panel.** Nothing here assumes every amount field wants Max
 *    or every panel wants a cog. Follow the panel's own category: a swap
 *    (avnu) has Max, a flip, a slippage cog and a rate row; a lending panel
 *    (Vesu) has a balance line, APY and health rows; a staking counter
 *    (Endur) has a balance line and little else; a send (a wallet) has an
 *    amount and a recipient. Fewer rows beats more.
 * 2. **The building's look, not the kit's.** Every rule in the kit's CSS
 *    (`.ui-*` in `styles.css`) reads the window's `--ui-*` tokens, so the
 *    Vault stays in Vesu's light theme, the Exchange in its own, and so on.
 *    Text sits on `--ui-surface` and uses only tokens `styles.test.ts` holds
 *    at WCAG AA in every theme.
 * 3. **Amounts are `bigint`.** Parsing and display go through `format.ts`.
 *
 * The parts:
 *
 * - `AmountField`: label, token slot, number. Optional balance line
 *   ("Pool balance: 12.5 STRK"), Max and 50% (only when `max` is passed),
 *   USD line, hint and its own validation (invalid, exceeds balance, below
 *   minimum). `max` returns `null` for "no honest maximum", which disables
 *   the button; build it with `maxAfterReserve(spendable, feeReserve(...))`
 *   so a Max of the fee token leaves the pool fee behind. Never pass a
 *   wallet's aggregate as spendable (D-022).
 * - `TokenSelect`: a styled native select showing "STRK · 12.5"; native for
 *   keyboard, screen readers and phone pickers.
 * - `SettingsPopover`: a cog with presets, an optional custom value and a
 *   warning slot; Escape or a press outside closes it. Keep advanced options
 *   (custom slippage) in here, not on the panel.
 * - `DetailRows` (+ `InvertibleRate`, `BeforeAfter`): label/value rows with a
 *   tone for the figure agreed to or one to look at twice.
 * - `FlipButton`, `QuoteTimer`: the swap direction control and a quote's
 *   refresh countdown.
 * - `primaryAction`: the primary button's words and state, "Enter an amount",
 *   "Insufficient STRK", then the caller's own ("Review swap").
 *
 * Text inputs here are ordinary inputs, so the world's keyboard ignores them
 * while focused (`packages/world/src/dom-keyboard.ts`) and the visit's input
 * gate holds the avatar while a panel is open.
 */
export { AmountField, type AmountFieldProps } from './AmountField.js';
export { TokenSelect, tokenOptionText, type TokenOption, type TokenSelectProps } from './TokenSelect.js';
export { SettingsPopover, type SettingsPopoverProps, type SettingsPreset } from './SettingsPopover.js';
export { DetailRows, InvertibleRate, BeforeAfter, type DetailRow, type DetailTone } from './DetailRows.js';
export { FlipButton } from './FlipButton.js';
export { QuoteTimer, type QuoteTimerProps } from './QuoteTimer.js';
export {
  balanceText, checkAmount, feeReserve, fractionOf, maxAfterReserve, primaryAction, type AmountCheck,
} from './amount-math.js';
