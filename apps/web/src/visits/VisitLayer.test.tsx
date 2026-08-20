import { Children, isValidElement, type ReactElement, type ReactNode } from 'react';
import { describe, expect, it, vi } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { FakePrivacyOperations } from '@strkworld/privacy';
import type { ShellEvents, WorldEvents } from '@strkworld/shared';
import { createEventBus } from '../bus/event-bus.js';
import { COPY } from '../copy.js';
import { PrivacyProvider } from '../privacy/PrivacyProvider.js';
import { SessionNoticeLayer } from '../privacy/SessionNoticeLayer.js';
import { createSubmissionUncertainty } from '../privacy/submission-uncertainty.js';
import { PRIVACY_REGISTER, type RouteGrade } from '../privacy/register.js';
import { VisitLayerView, visitLayerActions } from './VisitLayer.js';
import { createVisitController } from './visit-controller.js';

function render(node: React.ReactElement): string {
  return renderToStaticMarkup(
    <PrivacyProvider operations={new FakePrivacyOperations()}>{node}</PrivacyProvider>,
  );
}

function findButton(node: ReactNode, label: string): ReactElement<{
  children?: ReactNode;
  onClick?: () => void;
}> {
  let found: ReactElement<{ children?: ReactNode; onClick?: () => void }> | null = null;
  const visit = (current: ReactNode): void => {
    if (found || !isValidElement<{ children?: ReactNode; onClick?: () => void }>(current)) return;
    if (current.type === 'button' && current.props.children === label) {
      found = current;
      return;
    }
    Children.forEach(current.props.children, visit);
  };
  visit(node);
  if (!found) throw new Error(`Button not found: ${label}`);
  return found;
}

describe('VisitLayerView', () => {
  it('sends the exact active building through the native Game Mode exit control', () => {
    const world = createEventBus<WorldEvents>();
    const shell = createEventBus<ShellEvents>();
    const exits = vi.fn();
    shell.on('world:exit-building', exits);
    const controller = createVisitController(shell);
    controller.listen(world);
    world.emit('building:entered', { building: 'bank' });

    const view = VisitLayerView({
      state: controller.store.getState(),
      connected: true,
      ...visitLayerActions(controller),
    });
    if (view === null) throw new Error('Visiting view did not render');
    expect(render(view)).toContain(`class="exit-building-button"`);

    findButton(view, COPY.gameMode.exit).props.onClick?.();

    expect(exits).toHaveBeenCalledOnce();
    expect(exits).toHaveBeenCalledWith({ building: 'bank' });
    expect(controller.store.getState()).toMatchObject({ name: 'visiting', building: 'bank' });

    world.emit('building:exited', { building: 'bank' });
    expect(controller.store.getState()).toEqual({ name: 'outside' });
  });

  it('keeps the Leave building action available over Menu Mode until World exits', () => {
    const world = createEventBus<WorldEvents>();
    const shell = createEventBus<ShellEvents>();
    const exits = vi.fn();
    shell.on('world:exit-building', exits);
    const controller = createVisitController(shell);
    controller.listen(world);
    world.emit('building:entered', { building: 'post-office' });
    controller.openMenu();

    const view = VisitLayerView({
      state: controller.store.getState(),
      connected: true,
      ...visitLayerActions(controller),
    });
    if (view === null) throw new Error('Menu visit did not render');
    expect(render(view)).toContain(COPY.gameMode.exit);

    findButton(view, COPY.gameMode.exit).props.onClick?.();

    expect(exits).toHaveBeenCalledOnce();
    expect(exits).toHaveBeenCalledWith({ building: 'post-office' });
    expect(controller.store.getState()).toEqual({
      name: 'visiting',
      building: 'post-office',
      surface: { name: 'menu' },
    });

    world.emit('building:exited', { building: 'bank' });
    expect(controller.store.getState()).toMatchObject({
      name: 'visiting',
      building: 'post-office',
      surface: { name: 'menu' },
    });

    world.emit('building:exited', { building: 'post-office' });
    expect(controller.store.getState()).toEqual({ name: 'outside' });
  });

  it.each([
    { surface: 'admitted station', connected: true, lockStation: false },
    { surface: 'connection prompt', connected: false, lockStation: false },
    { surface: 'locked station', connected: true, lockStation: true },
  ])('keeps the Leave building action available over $surface', ({ connected, lockStation }) => {
    const world = createEventBus<WorldEvents>();
    const shell = createEventBus<ShellEvents>();
    const exits = vi.fn();
    const owners = vi.fn();
    shell.on('world:exit-building', exits);
    shell.on('world:control-owner', owners);
    const controller = createVisitController(shell);
    controller.listen(world);
    world.emit('building:entered', { building: 'bank' });
    world.emit('station:activated', { building: 'bank', station: 'bank:shielding' });
    const ownerCallsBeforeExit = owners.mock.calls.length;
    const register = lockStation
      ? PRIVACY_REGISTER.map((entry) =>
          entry.route === 'bank.shield'
            ? {
                ...entry,
                disclosure: null,
                approvedBy: null,
                approvedOn: null,
                rationale: null,
              }
            : entry,
        )
      : PRIVACY_REGISTER;

    const view = VisitLayerView({
      state: controller.store.getState(),
      connected,
      register,
      ...visitLayerActions(controller),
    });
    if (view === null) throw new Error('Station visit did not render');
    expect(render(view)).toContain(COPY.gameMode.exit);

    findButton(view, COPY.gameMode.exit).props.onClick?.();

    expect(exits).toHaveBeenCalledOnce();
    expect(exits).toHaveBeenCalledWith({ building: 'bank' });
    expect(controller.store.getState()).toEqual({
      name: 'visiting',
      building: 'bank',
      surface: { name: 'station', station: 'bank:shielding' },
    });
    expect(owners).toHaveBeenCalledTimes(ownerCallsBeforeExit);

    world.emit('building:exited', { building: 'exchange' });
    expect(controller.store.getState()).toMatchObject({
      name: 'visiting',
      building: 'bank',
      surface: { name: 'station' },
    });
    expect(owners).toHaveBeenCalledTimes(ownerCallsBeforeExit);

    world.emit('building:exited', { building: 'bank' });
    expect(controller.store.getState()).toEqual({ name: 'outside' });
    expect(owners).toHaveBeenCalledTimes(ownerCallsBeforeExit + 1);
    expect(owners).toHaveBeenLastCalledWith({ building: 'bank', owner: 'world' });

    world.emit('building:exited', { building: 'bank' });
    expect(owners).toHaveBeenCalledTimes(ownerCallsBeforeExit + 1);
  });

  it('shows the native Game Mode controls without mounting a financial form', () => {
    const markup = render(
      <VisitLayerView
        state={{ name: 'visiting', building: 'bank', surface: { name: 'room' } }}
        connected
        onOpenMenu={() => {}}
        onRequestExit={() => {}}
        onCloseSurface={() => {}}
        onDismissLocked={() => {}}
      />,
    );

    expect(markup).toContain('class="menu-mode-button"');
    expect(markup).toContain('Menu Mode');
    expect(markup).toContain('Leave building');
    expect(markup).not.toContain('name="amount"');
  });

  it('renders the existing full Bank panel in Menu Mode', () => {
    const markup = render(
      <VisitLayerView
        state={{ name: 'visiting', building: 'bank', surface: { name: 'menu' } }}
        connected
        onOpenMenu={() => {}}
        onRequestExit={() => {}}
        onCloseSurface={() => {}}
        onDismissLocked={() => {}}
      />,
    );

    expect(markup).toContain('data-experience="menu"');
    expect(markup).toContain('Private transfer');
    expect(markup).toContain('Add to this visit');
  });

  it('renders the shielding station as the same Bank flow limited to one action', () => {
    const markup = render(
      <VisitLayerView
        state={{
          name: 'visiting',
          building: 'bank',
          surface: { name: 'station', station: 'bank:shielding' },
        }}
        connected
        onOpenMenu={() => {}}
        onRequestExit={() => {}}
        onCloseSurface={() => {}}
        onDismissLocked={() => {}}
      />,
    );

    expect(markup).toContain('data-experience="station"');
    expect(markup).toContain('Shield');
    expect(markup).toContain('Unshield');
    expect(markup).not.toContain('Private transfer');
    expect(markup).toContain('This station confirms one action at a time.');
    expect(markup).toContain('Review this action');
    expect(markup).not.toContain('Add to this visit');
    expect(markup).not.toContain('Nothing queued yet');
  });

  it('renders the Post Office station as one private transfer action', () => {
    const markup = render(
      <VisitLayerView
        state={{
          name: 'visiting',
          building: 'post-office',
          surface: { name: 'station', station: 'post-office:transfer' },
        }}
        connected
        onOpenMenu={() => {}}
        onRequestExit={() => {}}
        onCloseSurface={() => {}}
        onDismissLocked={() => {}}
      />,
    );

    expect(markup).toContain('data-experience="station"');
    expect(markup).toContain('The Post Office');
    expect(markup).toContain('Private transfer');
    expect(markup).not.toContain('Shield');
    expect(markup).not.toContain('Unshield');
    expect(markup).not.toContain('Add to this visit');
    expect(markup).not.toContain('Nothing queued yet');
    expect(markup).toContain('This station confirms one action at a time.');
  });

  it('renders Post Office Menu Mode as a transfer-only batch surface', () => {
    const markup = render(
      <VisitLayerView
        state={{ name: 'visiting', building: 'post-office', surface: { name: 'menu' } }}
        connected
        onOpenMenu={() => {}}
        onRequestExit={() => {}}
        onCloseSurface={() => {}}
        onDismissLocked={() => {}}
      />,
    );

    expect(markup).toContain('data-experience="menu"');
    expect(markup).toContain('Private transfer');
    expect(markup).toContain('Add to this visit');
    expect(markup).toContain('Nothing queued yet');
    expect(markup).not.toContain('Shield');
    expect(markup).not.toContain('Unshield');
  });

  it('re-runs the privacy gate and renders no financial form when a station is disabled', () => {
    const unapprovedShield: RouteGrade = {
      ...PRIVACY_REGISTER.find((entry) => entry.route === 'bank.shield')!,
      disclosure: null,
      approvedBy: null,
      approvedOn: null,
      rationale: null,
    };
    const register = [
      ...PRIVACY_REGISTER.filter((entry) => entry.route !== 'bank.shield'),
      unapprovedShield,
    ];
    const markup = render(
      <VisitLayerView
        state={{
          name: 'visiting',
          building: 'bank',
          surface: { name: 'station', station: 'bank:shielding' },
        }}
        connected
        register={register}
        onOpenMenu={() => {}}
        onRequestExit={() => {}}
        onCloseSurface={() => {}}
        onDismissLocked={() => {}}
      />,
    );

    expect(markup).toContain('data-lock-reason="unapproved-route"');
    expect(markup).not.toContain('name="amount"');
  });

  it('renders Exchange Menu and station as one-swap surfaces with no batch vocabulary', () => {
    for (const surface of [{ name: 'menu' }, { name: 'station', station: 'exchange:swap' }] as const) {
      const markup = render(<VisitLayerView state={{ name: 'visiting', building: 'exchange', surface }} connected onOpenMenu={() => {}} onRequestExit={() => {}} onCloseSurface={() => {}} onDismissLocked={() => {}} />);
      expect(markup).toContain('This Exchange prepares and confirms one swap at a time.');
      expect(markup).not.toContain('Add to this visit');
      expect(markup).not.toContain('Nothing queued yet');
    }
  });

  it('locks a disabled Exchange station without exposing a balance or amount form', () => {
    const disabled = PRIVACY_REGISTER.map((entry) => entry.route === 'exchange.swap' ? { ...entry, disclosure: null, approvedBy: null, approvedOn: null, rationale: null } : entry);
    const markup = render(<VisitLayerView state={{ name: 'visiting', building: 'exchange', surface: { name: 'station', station: 'exchange:swap' } }} connected register={disabled} onOpenMenu={() => {}} onRequestExit={() => {}} onCloseSurface={() => {}} onDismissLocked={() => {}} />);
    expect(markup).toContain('data-lock-reason="unapproved-route"');
    expect(markup).not.toContain('name="amount"');
    expect(markup).not.toContain('Show my balance');
  });

  it('fails closed when a stale or unknown station reaches the view', () => {
    const markup = render(
      <VisitLayerView
        state={{
          name: 'visiting',
          building: 'bank',
          surface: { name: 'station', station: 'bank:not-registered' },
        }}
        connected
        onOpenMenu={() => {}}
        onRequestExit={() => {}}
        onCloseSurface={() => {}}
        onDismissLocked={() => {}}
      />,
    );

    expect(markup).toContain('data-lock-reason="unknown-route"');
    expect(markup).not.toContain('name="amount"');
  });

  it('keeps submission uncertainty above room, Menu, station and exited visit surfaces', () => {
    const uncertainty = createSubmissionUncertainty();
    uncertainty.retain();
    const states = [
      { name: 'visiting', building: 'bank', surface: { name: 'room' } },
      { name: 'visiting', building: 'bank', surface: { name: 'menu' } },
      {
        name: 'visiting',
        building: 'bank',
        surface: { name: 'station', station: 'bank:shielding' },
      },
      { name: 'outside' },
    ] as const;

    for (const state of states) {
      const markup = renderToStaticMarkup(
        <PrivacyProvider
          operations={new FakePrivacyOperations()}
          submissionUncertainty={uncertainty}
        >
          <VisitLayerView
            state={state}
            connected
            onOpenMenu={() => {}}
            onRequestExit={() => {}}
            onCloseSurface={() => {}}
            onDismissLocked={() => {}}
          />
          <SessionNoticeLayer />
        </PrivacyProvider>,
      );
      expect(markup).toContain('submission-uncertainty');
      expect(markup).not.toContain('Try again');
      expect(markup).not.toContain('Nothing was sent');
    }
  });
});
