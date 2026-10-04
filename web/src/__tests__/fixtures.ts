import type { AgentView, ControlPanelView } from '../lib/api';

export function agent(over: Partial<AgentView> = {}): AgentView {
  return {
    id: 'momentum-1',
    name: 'Momentum',
    status: 'running',
    allocatedMinor: '200000',
    cashMinor: '39864',
    deployedMinor: '164000',
    equityMinor: '203872',
    realisedMinor: '2304',
    feesMinor: '0',
    pnlPctSinceStart: 1.94,
    pnlPctToday: -0.2,
    universe: ['AZN', 'ULVR', 'ISF'],
    holdings: [
      { symbol: 'AZN', qty: '4.00000000', costBasisMinor: '45200', marketValueMinor: '46840' },
      { symbol: 'ULVR', qty: '12.00000000', costBasisMinor: '57120', marketValueMinor: '56688' },
    ],
    unpricedSymbols: [],
    maxOrderPct: 25,
    dailyLossCapPct: 3,
    startedAt: '2026-08-25T09:00:00.000Z',
    createdAt: '2026-08-25T08:00:00.000Z',
    todayMinor: '-410',
    ...over,
  };
}

export function view(over: Partial<ControlPanelView> = {}): ControlPanelView {
  return {
    asOf: '2026-10-02T18:00:00.000Z',
    totalEquityMinor: '476222',
    unallocatedMinor: '150000',
    allocatedMinor: '360000',
    todayMinor: '-410',
    reconciliation: { status: 'ok', asOf: '2026-10-02T22:37:00.000Z', runAt: '2026-10-02T22:37:00.000Z', summary: 'clean', stale: false },
    agents: [agent()],
    ownership: { symbols: [], ledgerCashMinor: '0', brokerCashMinor: '0' },
    ...over,
  };
}
