/**
 * The two controls that matter most when something is wrong.
 *
 * Kill is irreversible, so its button must stay dead until the agent's id is
 * typed, and "Halt instead" must sell nothing. Halt must never wait behind
 * anything in flight.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import * as api from '../lib/api';
import { KillDialog } from '../components/dialogs';
import { AgentPanel } from '../components/panel/Sections';
import { agent, view } from './fixtures';

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

const preview = {
  agentId: 'meanrev-1',
  positions: [
    { symbol: 'GSK', qty: '20.00000000', costBasisMinor: '29000', lastPriceMinor: '1471', others: [] },
    { symbol: 'ULVR', qty: '5.00000000', costBasisMinor: '23450', lastPriceMinor: '4724', others: [{ agentId: 'momentum-1', qty: '12.00000000' }] },
    { symbol: 'BARC', qty: '120.00000000', costBasisMinor: '37000', lastPriceMinor: null, others: [] },
  ],
  uninvestedCashMinor: '9310',
  summary: '',
};

function openKill(onHaltInstead?: () => void) {
  vi.spyOn(api, 'previewKill').mockResolvedValue(preview);
  const kill = vi.spyOn(api, 'kill').mockResolvedValue(view());
  const onDone = vi.fn();
  const target = agent({ id: 'meanrev-1', name: 'Mean reversion', status: 'halted', equityMinor: null, unpricedSymbols: ['BARC'] });
  render(<KillDialog agent={target} onClose={vi.fn()} onDone={onDone} onError={vi.fn()} {...(onHaltInstead ? { onHaltInstead } : {})} />);
  return { kill, onDone };
}

describe('the Kill dialog', () => {
  it('names what it will sell, with last prices, and only this agent’s share of a shared holding', async () => {
    openKill();
    expect(await screen.findByText('GSK')).toBeTruthy();
    expect(screen.getByText(/Only its own 5\. momentum-1 keeps its 12\./)).toBeTruthy();
    expect(screen.getByText('£14.71')).toBeTruthy();
    // No price is "—", never the cost and never zero.
    expect(screen.getAllByText('—').length).toBeGreaterThan(0);
    expect(screen.getByText(/plus whatever BARC sell for/)).toBeTruthy();
  });

  it('cannot be confirmed until the agent id is typed exactly', async () => {
    const { kill } = openKill();
    const go = await screen.findByRole('button', { name: /Sell 3 and stand down/ });
    expect((go as HTMLButtonElement).disabled).toBe(true);

    await userEvent.type(screen.getByRole('textbox'), 'meanrev');
    expect((go as HTMLButtonElement).disabled).toBe(true);
    await userEvent.type(screen.getByRole('textbox'), '-1');
    expect((go as HTMLButtonElement).disabled).toBe(false);

    await userEvent.click(go);
    await waitFor(() => expect(kill).toHaveBeenCalledWith('meanrev-1', 'meanrev-1'));
  });

  it('offers Halt instead, and halting sells nothing', async () => {
    const onHalt = vi.fn();
    const { kill } = openKill(onHalt);
    await userEvent.click(await screen.findByRole('button', { name: /Halt instead/ }));
    expect(onHalt).toHaveBeenCalledOnce();
    expect(kill).not.toHaveBeenCalled();
  });
});

describe('Halt on an agent card', () => {
  const actions = { onCapital: vi.fn(), onUniverse: vi.fn(), onHalt: vi.fn(), onStart: vi.fn(), onKill: vi.fn() };

  it('stays usable while something else is in flight', async () => {
    render(<AgentPanel agent={agent()} color="var(--a1)" series={undefined} busy={true} first={false} {...actions} />);
    const halt = screen.getByRole('button', { name: /Halt/ });
    expect((halt as HTMLButtonElement).disabled).toBe(false);
    expect((screen.getByRole('button', { name: 'Capital' }) as HTMLButtonElement).disabled).toBe(true);
    await userEvent.click(halt);
    expect(actions.onHalt).toHaveBeenCalledOnce();
  });

  it('is not offered to an agent being killed, which cannot go back to trading', () => {
    render(<AgentPanel agent={agent({ status: 'killing' })} color="var(--a1)" series={undefined} busy={false} first={false} {...actions} />);
    expect(screen.queryByRole('button', { name: /Resume|Start/ })).toBeNull();
    expect(screen.getByRole('button', { name: /Finish kill/ })).toBeTruthy();
  });
});
