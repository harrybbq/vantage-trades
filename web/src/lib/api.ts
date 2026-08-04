/**
 * Talking to the control API.
 *
 * Every mutating call returns the whole panel view, so the screen is always
 * showing what the server just committed rather than a guess the client
 * patched together. For anything that moves money, an optimistic update is a
 * lie the UI tells until it is contradicted — not a trade worth making here.
 */

export interface HoldingView {
  symbol: string;
  qty: string;
  costBasisMinor: string;
  marketValueMinor: string | null;
}

export interface AgentView {
  id: string;
  name: string;
  status: 'idle' | 'running' | 'halted' | 'killed';
  allocatedMinor: string;
  cashMinor: string;
  deployedMinor: string;
  equityMinor: string | null;
  realisedMinor: string;
  feesMinor: string;
  pnlPctSinceStart: number | null;
  pnlPctToday: number | null;
  universe: string[];
  holdings: HoldingView[];
  unpricedSymbols: string[];
}

export interface ControlPanelView {
  asOf: string;
  totalEquityMinor: string | null;
  unallocatedMinor: string;
  allocatedMinor: string;
  todayMinor: string | null;
  reconciliation: { status: 'ok' | 'diverged' | 'error'; asOf: string; summary: string } | null;
  agents: AgentView[];
}

export interface CurvePoint {
  date: string;
  equityMinor: string;
  benchmarkMinor: string | null;
}

export interface AgentCurve {
  agentId: string;
  name: string;
  status: string;
  points: CurvePoint[];
  returnPct: number | null;
}

export interface StatsView {
  benchmarkSymbol: string;
  fund: CurvePoint[];
  fundReturnPct: number | null;
  benchmarkReturnPct: number | null;
  excessPct: number | null;
  agents: AgentCurve[];
  reconciliations: {
    runAt: string;
    asOf: string;
    status: string;
    cashDiffMinor: string;
    equityDiffMinor: string | null;
    summary: string;
  }[];
  totalFeesMinor: string;
  totalTrades: number;
  note: string | null;
}

export interface KillPreview {
  agentId: string;
  positions: { symbol: string; qty: string; costBasisMinor: string }[];
  uninvestedCashMinor: string;
  summary: string;
}

import { accessToken } from './auth';

const BASE = import.meta.env['VITE_API_URL'] ?? '/api/control';

/**
 * Carries the server's own message. Halt, budget caps, the universe and the
 * kill guards all produce messages written to be read by the owner, and
 * replacing them with "something went wrong" would throw away the only
 * explanation of why the thing they just clicked did not happen.
 */
export class ApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
  }
}

async function request<T>(init?: RequestInit): Promise<T> {
  // Read the token per request. The client refreshes in the background, and a
  // cached token goes stale mid-session and produces a 401 that looks like a
  // permissions problem rather than an expiry.
  const token = await accessToken();

  let response: Response;
  try {
    response = await fetch(BASE, {
      ...init,
      headers: {
        'content-type': 'application/json',
        ...(token ? { authorization: `Bearer ${token}` } : {}),
        ...(init?.headers ?? {}),
      },
    });
  } catch {
    throw new ApiError('Could not reach the control API. Is the server running?', 0);
  }

  const payload = (await response.json().catch(() => ({}))) as { error?: string };

  if (!response.ok) {
    throw new ApiError(payload.error ?? `Request failed (${response.status})`, response.status);
  }

  return payload as T;
}

export const fetchPanel = (): Promise<ControlPanelView> => request<ControlPanelView>();

export const fetchStats = (): Promise<StatsView> =>
  request<StatsView>({ method: 'POST', body: JSON.stringify({ action: 'stats' }) });

const post = <T>(body: Record<string, unknown>): Promise<T> =>
  request<T>({ method: 'POST', body: JSON.stringify(body) });

/**
 * Run the reconciliation now.
 *
 * Slower than every other call here — it talks to the price feed and the
 * broker before it answers — so callers should expect seconds, not the
 * milliseconds the rest of these take.
 */
export const reconcileNow = () => post<ControlPanelView>({ action: 'reconcileNow' });

export const createAgent = (id: string, name: string) =>
  post<ControlPanelView>({ action: 'createAgent', id, name });

export const recordDeposit = (amount: string, reference: string) =>
  post<ControlPanelView>({ action: 'recordDeposit', amount, reference });

export const recordWithdrawal = (amount: string, reference: string) =>
  post<ControlPanelView>({ action: 'recordWithdrawal', amount, reference });

export const allocate = (agentId: string, amount: string) =>
  post<ControlPanelView>({ action: 'allocate', agentId, amount });

export const returnCapital = (agentId: string, amount: string) =>
  post<ControlPanelView>({ action: 'returnCapital', agentId, amount });

export const halt = (agentId: string, reason?: string) =>
  post<ControlPanelView>({ action: 'halt', agentId, reason });

export const start = (agentId: string) => post<ControlPanelView>({ action: 'start', agentId });

export const globalHalt = (reason?: string) =>
  post<ControlPanelView>({ action: 'globalHalt', reason });

export const previewKill = (agentId: string) =>
  post<KillPreview>({ action: 'previewKill', agentId });

export const kill = (agentId: string, confirm: string) =>
  post<ControlPanelView>({ action: 'kill', agentId, confirm });

export const addSymbol = (agentId: string, symbol: string) =>
  post<ControlPanelView>({ action: 'addSymbol', agentId, symbol });

export const removeSymbol = (agentId: string, symbol: string) =>
  post<ControlPanelView & { stillHeld: boolean }>({ action: 'removeSymbol', agentId, symbol });
