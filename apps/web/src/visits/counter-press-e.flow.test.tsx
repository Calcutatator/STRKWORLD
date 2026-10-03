// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { FakePrivacyOperations, type PublicShieldPlanner, type WalletRoutePolicy } from '@strkworld/privacy';
import type { BuildingId, ShellEvents, StationId, WorldEvents } from '@strkworld/shared';
import { createEventBus } from '../bus/event-bus.js';
import { COPY } from '../copy.js';
import { BridgeProvider, type BridgeRuntimeLoader } from '../bridge/BridgeProvider.js';
import type { ConnectState } from '../connect/connect-machine.js';
import { DegenCatalogProvider } from '../panels/exchange/DegenCatalogProvider.js';
import { createDemoOperations } from '../privacy/demo-operations.js';
import { PrivacyProvider } from '../privacy/PrivacyProvider.js';
import { VisitLayer } from './VisitLayer.js';
import { parseRoutePolicy } from '../production/config.js';
// The real World, by relative path: `@strkworld/world`'s export map offers
// only the three.js runtime entries, and this suite drives the engine-free
// session (D-059) with a view that draws nothing.
import {
  createWorldSession,
  type WorldFrame,
  type WorldKeyboard,
  type WorldSession,
  type WorldSessionView,
} from '../../../../packages/world/src/world-session.js';
import {
  FIXED_ROOM_LEVELS,
  FIXED_ROOM_TILE_SIZE,
  createFixedRoom,
  createFixedRoomLevel,
  fixedRoomDefinitionsFor,
  fixedRoomLiftAt,
  isFixedRoomExit,
  isFixedRoomSolidAt,
  type FixedRoomLevelId,
  type FixedRoomLevelMap,
  type FixedRoomStationDefinition,
} from '../../../../packages/world/src/fixed-room.js';
import { createStreetMap, TILE_SIZE, tileToWorld } from '../../../../packages/world/src/map/street.js';
import { ROOM_ORIGIN } from '../../../../packages/world/src/world-layout.js';
import type { MovementInput } from '../../../../packages/world/src/street-movement.js';

/**
 * Every counter in the city, opened the way a player opens one: walk into the
 * building, stand at the counter, press E (D-117), and the counter's own
 * window appears (D-103). The real World session, the real press-E
 * interaction system, the real Shell station registry and the real panels —
 * only the renderer, the keyboard and the wallet are fakes.
 *
 * It runs in the production-like configuration: the route policy this build's
 * variables parse to, with shield, unshield, transfer, stake, unstake, the
 * Vault, borrowing, swap, the degen floor and the Bridge all switched on.
 * `deploy/RAILWAY.md` is where those variables live. A counter that is not
 * switched on stays locked, shows no chip, and swallows E (D-123).
 */

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

// Vite inlines `import.meta.env`, so `vi.stubEnv` cannot reach
// `detectRoutePolicy()`. The Shell reads the live policy through it, so it is
// replaced here by the real parser's answer for a production-like environment.
const livePolicy = vi.hoisted(() => ({ current: null as WalletRoutePolicy | null }));
vi.mock('../production/config.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../production/config.js')>()),
  detectRoutePolicy: () => livePolicy.current,
}));

const STRK = '0x04718f5a0fc34cc1af16a1cdee98ffb20c31f5cd61d6ab07201858f4287c938d';
const ETH = '0x049d36570d4e46f48e99674bd3fcc84644ddd6b96f7c741b1562b82f9e004dc7';
const USDC = '0x033068f6539f8e6e6b131e6b2b814e6c34a5224bc66947c47dab9dfee93b35fb';
const USDT = '0x068f5c6a61780768455de69077e07e89787839bf8166decfbf92b645209c0fb8';
const WBTC = '0x03fe2b97c1fd336e750087d68b9b867997fd64a2661ff3ca5a7c771641e8e7ac';
const XSTRK = '0x028d709c875c0ceac3dce7065bec5328186dc89fe254527084d1689910954b0a';

/** The browser half of `deploy/RAILWAY.md`, with every counter's switch on. */
const PRODUCTION_ENV = {
  PROD: true,
  VITE_STRK20_SHIELD_ENABLED: 'true',
  VITE_STRK20_SHIELD_MAX_INTENTS: '1',
  VITE_STRK20_SHIELD_ALLOWED_TOKENS: [STRK, ETH, USDC, USDT, WBTC].join(','),
  VITE_STRK20_UNSHIELD_ENABLED: 'true',
  VITE_STRK20_UNSHIELD_MAX_INTENTS: '1',
  VITE_STRK20_UNSHIELD_MAX_RELAY_FEE: '10000000000000000000',
  VITE_STRK20_UNSHIELD_ALLOWED_TOKENS: STRK,
  VITE_STRK20_TRANSFER_ENABLED: 'true',
  VITE_STRK20_TRANSFER_MAX_INTENTS: '1',
  VITE_STRK20_TRANSFER_MAX_RELAY_FEE: '10000000000000000000',
  VITE_STRK20_TRANSFER_ALLOWED_TOKENS: STRK,
  VITE_STRK20_STAKE_ENABLED: 'true',
  VITE_STRK20_STAKE_MAX_RELAY_FEE: '10000000000000000000',
  VITE_STRK20_STAKE_ALLOWED_TOKENS: [STRK, XSTRK].join(','),
  VITE_STRK20_UNSTAKE_ENABLED: 'true',
  VITE_STRK20_VAULT_ENABLED: 'true',
  VITE_STRK20_VAULT_ALLOWED_TOKENS: [STRK, ETH, USDC].join(','),
  VITE_STRK20_BORROW_ENABLED: 'true',
  VITE_STRK20_SWAP_ENABLED: 'true',
  VITE_STRK20_SWAP_ALLOWED_TOKENS: [STRK, ETH, USDC].join(','),
  VITE_STRK20_SWAP_SLIPPAGE_BPS: '50',
  VITE_STRK20_SWAP_DEGEN_ENABLED: 'true',
} as const;

const PRODUCTION_POLICY = parseRoutePolicy(PRODUCTION_ENV);
/** The same build with borrowing left off, as the live deployment has it. */
const BORROW_OFF_POLICY = parseRoutePolicy({ ...PRODUCTION_ENV, VITE_STRK20_BORROW_ENABLED: undefined });

const CONNECTED: ConnectState = {
  name: 'connected',
  capability: { supportsStrk20: true, walletApiVersion: '0.10.4', registration: 'registered', supportsShadowAccounts: true },
  registrationConfirmed: true,
};

// ---------------------------------------------------------------------------
// The World's fakes: a renderer that draws nothing, and a keyboard.
// ---------------------------------------------------------------------------

function createSilentView(): WorldSessionView {
  return {
    setPlayerPosition: () => {},
    setPlayerMotion: () => {},
    setPlayerAvatar: () => {},
    setStreetVisible: () => {},
    setDoorsVisible: () => {},
    setLabelsVisible: () => {},
    setRemoteVisible: () => {},
    showRoom: () => {},
    renderRoom: () => {},
    showRooftop: () => {},
    syncStudio: () => {},
    destroyStudio: () => {},
    setCameraBounds: () => {},
  };
}

const NO_KEYS: MovementInput = Object.freeze({ left: false, right: false, up: false, down: false });
type ActionHandler = (event: { repeat: boolean; target: unknown }) => void;

class TestKeyboard implements WorldKeyboard {
  enabled = true;
  sprinting = false;
  readonly held = NO_KEYS;
  private readonly interact = new Set<ActionHandler>();

  disableGlobalCapture(): void {}
  enableGlobalCapture(): void {}
  resetKeys(): void {}

  on(event: string, handler: ActionHandler): this {
    if (event === 'keydown-E') this.interact.add(handler);
    return this;
  }

  off(event: string, handler: ActionHandler): this {
    if (event === 'keydown-E') this.interact.delete(handler);
    return this;
  }

  /** E, exactly as the DOM keyboard delivers it; silent while input is suspended. */
  pressE(): void {
    if (!this.enabled) return;
    for (const handler of [...this.interact]) handler({ repeat: false, target: null });
  }
}

/** The one private field this suite reaches for, as `world-session.test.ts` does. */
function place(session: WorldSession, position: { x: number; y: number }): void {
  (session as unknown as { position: { x: number; y: number } }).position = { ...position };
}

// ---------------------------------------------------------------------------
// Geometry: where a player stands to use a counter.
// ---------------------------------------------------------------------------

const STREET = createStreetMap({ vaultOpen: true });

function doorTile(building: BuildingId): { x: number; y: number } {
  const door = STREET.doors.find((candidate) => candidate.building === building);
  if (!door) throw new Error(`No door for ${building}`);
  return { x: door.x, y: door.y };
}

function floorOf(building: BuildingId, level: FixedRoomLevelId): FixedRoomLevelMap {
  const definition = fixedRoomDefinitionsFor({ vaultOpen: true }).find((candidate) => candidate.building === building);
  if (!definition) throw new Error(`No room for ${building}`);
  if (level === 'ground') return createFixedRoom(definition);
  const upper = FIXED_ROOM_LEVELS[building]?.find((candidate) => candidate.level === level);
  if (!upper) throw new Error(`No ${level} floor in ${building}`);
  return createFixedRoomLevel(upper);
}

function stationOf(floor: FixedRoomLevelMap, station: StationId): FixedRoomStationDefinition {
  const found = floor.stations.find((candidate) => candidate.station === station);
  if (!found) throw new Error(`No ${station} on this floor`);
  return found;
}

/** A free tile in the counter's approach ring (D-033). */
function standingTile(floor: FixedRoomLevelMap, station: FixedRoomStationDefinition): { x: number; y: number } {
  for (let y = station.y - 1; y <= station.y + station.height; y++) {
    for (let x = station.x - 1; x <= station.x + station.width; x++) {
      const inside = x >= station.x && x < station.x + station.width
        && y >= station.y && y < station.y + station.height;
      if (inside || isFixedRoomSolidAt(floor, x, y) || isFixedRoomExit(floor, x, y) || fixedRoomLiftAt(floor, x, y)) continue;
      return { x, y };
    }
  }
  throw new Error(`No standing tile for ${station.station}`);
}

function interiorCentre(tile: { x: number; y: number }): { x: number; y: number } {
  return {
    x: ROOM_ORIGIN.x + tile.x * FIXED_ROOM_TILE_SIZE + FIXED_ROOM_TILE_SIZE / 2,
    y: ROOM_ORIGIN.y + tile.y * FIXED_ROOM_TILE_SIZE + FIXED_ROOM_TILE_SIZE / 2,
  };
}

// ---------------------------------------------------------------------------
// The harness: one React tree and one World session over the same two buses.
// ---------------------------------------------------------------------------

let root: Root | null = null;
let container: HTMLElement | null = null;
let session: WorldSession | null = null;

afterEach(() => {
  const owner = root;
  root = null;
  if (owner) act(() => owner.unmount());
  container?.remove();
  container = null;
  session?.destroy();
  session = null;
  livePolicy.current = null;
});

async function settle(): Promise<void> {
  for (let turn = 0; turn < 3; turn += 1) {
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
  }
}

interface CityOptions {
  readonly policy?: WalletRoutePolicy | null;
  /**
   * The Bridge's optional recovery runtime never answers, as it does not in a
   * browser with Web Storage blocked or full, or when its chunk cannot be
   * fetched (`bridge/production-runtime.ts`, `main.tsx`).
   */
  readonly bridgeRuntimeStalls?: boolean;
  /** D-061: this build plans no reserve shield, so the Bridge is recovery-only. */
  readonly shieldPlanner?: boolean;
}

async function enterCity(options: CityOptions = {}) {
  const { policy = PRODUCTION_POLICY, bridgeRuntimeStalls = false, shieldPlanner = true } = options;
  livePolicy.current = policy;
  const world = createEventBus<WorldEvents>();
  const shell = createEventBus<ShellEvents>();
  const keyboard = new TestKeyboard();
  const operations = createDemoOperations({ funded: true });
  // Composed as `ProductionRoot` composes it: a dormant loader, the connected
  // account and D-061's reserve planner, and no service until the loader answers.
  const planner: PublicShieldPlanner | null = shieldPlanner
    ? { planMax: async () => { throw new Error('not planned here'); } }
    : null;
  const loadRuntime: BridgeRuntimeLoader = bridgeRuntimeStalls
    ? () => new Promise(() => {})
    : async () => ({ service: {} as never, loadSources: async () => [] });

  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  await act(async () => {
    root!.render(
      <PrivacyProvider operations={operations} initialConnectState={CONNECTED} shellBus={shell}>
        <BridgeProvider loadRuntime={loadRuntime} account="0xabc" readAccount={() => '0xabc'} planner={planner}>
          <DegenCatalogProvider demo build={{ production: false }}>
            <VisitLayer world={world} shell={shell} />
          </DegenCatalogProvider>
        </BridgeProvider>
      </PrivacyProvider>,
    );
  });
  await settle();

  session = createWorldSession({
    config: { out: world, in: shell },
    view: createSilentView(),
    keyboard,
    vaultOpen: true,
  });

  const live = session;
  const tick = async (deltaMs = 16, frame?: WorldFrame): Promise<void> => {
    await act(async () => live.update(deltaMs, frame));
  };

  return {
    keyboard,
    get session() { return live; },
    tick,
    async walkInto(building: BuildingId): Promise<void> {
      place(live, tileToWorld(doorTile(building).x, doorTile(building).y));
      await tick();
      expect(live.area).toBe(building);
      // The Bridge's optional runtime loads on entry; its capabilities, and
      // the station snapshot that follows them, arrive a microtask later.
      await settle();
    },
    async ride(to: FixedRoomLevelId): Promise<void> {
      const from = live.level;
      if (!from) throw new Error('Not in a room');
      const lift = floorOf(live.area as BuildingId, from).lifts.find((candidate) => candidate.to === to);
      if (!lift) throw new Error(`No lift to ${to}`);
      place(live, interiorCentre({ x: lift.x, y: lift.y }));
      await tick();
      expect(live.level).toBe(to);
    },
    async standAt(building: BuildingId, level: FixedRoomLevelId, station: StationId): Promise<void> {
      const floor = floorOf(building, level);
      place(live, interiorCentre(standingTile(floor, stationOf(floor, station))));
      await tick();
    },
    async pressE(): Promise<void> {
      await act(async () => keyboard.pressE());
      await settle();
    },
  };
}

/** The one window on screen, or none. */
function panel(): HTMLElement | null {
  const panels = [...container!.querySelectorAll<HTMLElement>('.panel')];
  expect(panels.length).toBeLessThan(2);
  return panels[0] ?? null;
}

function lockNotice(): string | null {
  return container!.querySelector('.room-locked')?.getAttribute('data-lock-reason') ?? null;
}

// ---------------------------------------------------------------------------
// The cases: every counter the production build switches on.
// ---------------------------------------------------------------------------

interface CounterCase {
  readonly building: BuildingId;
  readonly level: FixedRoomLevelId;
  readonly station: StationId;
  /** A class the counter's own window carries, so no other window can pass for it. */
  readonly marker: string;
}

const COUNTERS: readonly CounterCase[] = [
  { building: 'bank', level: 'ground', station: 'bank:shielding', marker: '.bank-experience' },
  { building: 'bank', level: 'ground', station: 'bank:unshielding', marker: '.bank-experience' },
  { building: 'bank', level: 'ground', station: 'bank:staking', marker: '.bank-experience' },
  { building: 'bank', level: 'ground', station: 'bank:unstaking', marker: '.bank-experience[data-mode="unstake"]' },
  { building: 'post-office', level: 'ground', station: 'post-office:transfer', marker: '.bank-experience' },
  { building: 'exchange', level: 'ground', station: 'exchange:swap', marker: '.exchange-experience' },
  { building: 'exchange', level: 'degen', station: 'exchange:degen', marker: '.exchange-experience' },
  { building: 'vault', level: 'ground', station: 'vault:supply', marker: '.vault-experience' },
  { building: 'vault', level: 'ground', station: 'vault:redeem', marker: '.vault-experience' },
  { building: 'vault', level: 'ground', station: 'vault:borrow', marker: '.borrow-experience' },
  { building: 'vault', level: 'ground', station: 'vault:repay', marker: '.borrow-experience' },
  { building: 'bridge', level: 'ground', station: 'bridge:deposit', marker: '.bridge-experience' },
];

describe('press E at a counter (D-117, D-123): every switched-on counter opens its window', () => {
  it.each(COUNTERS.map((entry) => [`${entry.building}/${entry.station}`, entry] as const))(
    '%s',
    async (_name, counter) => {
      const city = await enterCity();
      await city.walkInto(counter.building);
      if (counter.level !== 'ground') await city.ride(counter.level);
      await city.standAt(counter.building, counter.level, counter.station);

      // D-123: the counter is chosen, so it glows and its key chip reads.
      expect(city.session.interactionPrompt).toMatchObject({ id: counter.station });
      expect(panel()).toBeNull();

      await city.pressE();

      expect(lockNotice()).toBeNull();
      const window = panel();
      expect(window).not.toBeNull();
      expect(window!.closest(counter.marker) ?? window!.querySelector(counter.marker)).not.toBeNull();
    },
  );

  /**
   * The Bridge is the one counter whose window needs a runtime that is not in
   * the boot graph: production fetches it when the player walks in (D-061).
   * The counter must not wait for it. A counter locked on something the player
   * cannot see has no shimmer, no chip and swallows E (D-123), so a Bridge
   * whose chunk is slow — or whose browser will never give it one — reads as
   * broken: "I went to the bridge counter and it's not popping up an
   * interface". Its lock is the account and the planner; its window reports
   * the runtime.
   */
  it('opens the Bridge counter while its optional runtime is still arriving, and says so', async () => {
    const city = await enterCity({ bridgeRuntimeStalls: true });
    await city.walkInto('bridge');
    await city.standAt('bridge', 'ground', 'bridge:deposit');

    expect(city.session.interactionPrompt).toMatchObject({ id: 'bridge:deposit' });
    await city.pressE();

    expect(lockNotice()).toBeNull();
    const window = panel();
    expect(window).not.toBeNull();
    expect(window!.closest('.bridge-experience')).not.toBeNull();
    expect(window!.textContent).toContain(COPY.bridge.arriving);
  });

  it('keeps the Bridge counter locked in a build with no reserve planner (D-061)', async () => {
    const city = await enterCity({ shieldPlanner: false });
    await city.walkInto('bridge');
    await city.standAt('bridge', 'ground', 'bridge:deposit');

    expect(city.session.interactionPrompt).toBeNull();
    await city.pressE();
    expect(panel()).toBeNull();
  });

  it('leaves a counter this build has not switched on locked, with no chip and no window (D-123)', async () => {
    const city = await enterCity({ policy: BORROW_OFF_POLICY });
    await city.walkInto('vault');
    await city.standAt('vault', 'ground', 'vault:borrow');

    expect(city.session.interactionPrompt).toBeNull();
    await city.pressE();
    expect(panel()).toBeNull();
  });
});
