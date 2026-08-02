/**
 * Every control-panel action that changes something.
 *
 * These are the only write paths the UI has. Each takes an explicit `actor`,
 * which is recorded — when an agent stops trading at 04:00 you want to know
 * whether it halted itself, you halted it, or the global switch caught it.
 *
 * Nothing here trusts an amount, a symbol or an id from the browser. The
 * database constraints are the real guard, but these validate first so the
 * failure is a clear message rather than a raised Postgres exception.
 */

import { inTransaction } from '../db.js';
import { formatQty, parseMoney, type Minor } from '../money.js';
import { createAgent } from '../ledger/agents.js';
import { allocate, deallocate, recordDeposit, recordWithdrawal } from '../ledger/allocation.js';
import { halt, start, globalHalt, previewKill, standDown, type KillPreview } from '../ledger/control.js';
import { addToUniverse, removeFromUniverse } from '../ledger/universe.js';
import { controlPanelView, type ControlPanelView } from './view.js';

export class ValidationError extends Error {}

const AGENT_ID = /^[a-z0-9][a-z0-9-]{1,62}$/;

function checkAgentId(id: unknown): string {
  if (typeof id !== 'string' || !AGENT_ID.test(id)) {
    throw new ValidationError(
      'agent id must be lowercase letters, digits and hyphens, 2-63 characters',
    );
  }
  return id;
}

/**
 * Parse an amount that arrived over the wire.
 *
 * Accepts a decimal string only. A JSON number would already have been through
 * a double by the time it got here, and `parseMoney` refuses anything it
 * cannot represent exactly rather than rounding it into the ledger.
 */
function checkAmount(raw: unknown): Minor {
  if (typeof raw !== 'string') {
    throw new ValidationError('amount must be a decimal string, e.g. "500.00"');
  }
  let amount: Minor;
  try {
    amount = parseMoney(raw);
  } catch (error) {
    throw new ValidationError(error instanceof Error ? error.message : 'invalid amount');
  }
  if (amount <= 0n) throw new ValidationError('amount must be positive');
  return amount;
}

export async function doCreateAgent(
  input: { id: unknown; name: unknown },
  actor: string,
): Promise<ControlPanelView> {
  const id = checkAgentId(input.id);
  const name = typeof input.name === 'string' ? input.name.trim() : '';
  if (!name) throw new ValidationError('name is required');

  return inTransaction(async (tx) => {
    await createAgent(tx, { id, name });
    // Deliberately no universe and no capital: a new agent must be given both
    // before it can place anything.
    return controlPanelView(tx);
  });
}

/**
 * Record that real cash arrived in the brokerage account.
 *
 * This does not move money — it cannot. Retail broker APIs do not let software
 * deposit or withdraw, which is a deliberate fraud boundary; the transfer
 * happens at your bank and this tells the ledger it happened. Getting that
 * backwards is the difference between bookkeeping and a payment system.
 *
 * The reference is required and unique, so recording the same transfer twice
 * is refused rather than silently doubling the pool.
 */
export async function doRecordDeposit(
  input: { amount: unknown; reference: unknown },
  actor: string,
): Promise<ControlPanelView> {
  const amount = checkAmount(input.amount);
  const reference = typeof input.reference === 'string' ? input.reference.trim() : '';
  if (reference.length < 3) {
    throw new ValidationError(
      'a bank reference is required, so this entry can be matched to the real transfer later',
    );
  }

  return inTransaction(async (tx) => {
    await recordDeposit(tx, amount, new Date(), `deposit:${reference}`);
    return controlPanelView(tx);
  });
}

/** Record that real cash left the brokerage account. */
export async function doRecordWithdrawal(
  input: { amount: unknown; reference: unknown },
  actor: string,
): Promise<ControlPanelView> {
  const amount = checkAmount(input.amount);
  const reference = typeof input.reference === 'string' ? input.reference.trim() : '';
  if (reference.length < 3) {
    throw new ValidationError('a bank reference is required');
  }

  return inTransaction(async (tx) => {
    await recordWithdrawal(tx, amount, new Date(), `withdrawal:${reference}`);
    return controlPanelView(tx);
  });
}

export async function doAllocate(
  input: { agentId: unknown; amount: unknown },
  actor: string,
): Promise<ControlPanelView> {
  const agentId = checkAgentId(input.agentId);
  const amount = checkAmount(input.amount);

  return inTransaction(async (tx) => {
    await allocate(tx, agentId, amount);
    return controlPanelView(tx);
  });
}

export async function doReturnCapital(
  input: { agentId: unknown; amount: unknown },
  actor: string,
): Promise<ControlPanelView> {
  const agentId = checkAgentId(input.agentId);
  const amount = checkAmount(input.amount);

  return inTransaction(async (tx) => {
    await deallocate(tx, agentId, amount);
    return controlPanelView(tx);
  });
}

export async function doHalt(
  input: { agentId: unknown; reason?: unknown },
  actor: string,
): Promise<ControlPanelView> {
  const agentId = checkAgentId(input.agentId);
  const reason = typeof input.reason === 'string' ? input.reason : undefined;

  return inTransaction(async (tx) => {
    await halt(tx, agentId, actor, reason);
    return controlPanelView(tx);
  });
}

export async function doStart(
  input: { agentId: unknown },
  actor: string,
): Promise<ControlPanelView> {
  const agentId = checkAgentId(input.agentId);

  return inTransaction(async (tx) => {
    await start(tx, agentId, actor);
    return controlPanelView(tx);
  });
}

export async function doGlobalHalt(
  input: { reason?: unknown },
  actor: string,
): Promise<ControlPanelView> {
  const reason = typeof input.reason === 'string' ? input.reason : undefined;

  return inTransaction(async (tx) => {
    await globalHalt(tx, actor, reason);
    return controlPanelView(tx);
  });
}

export interface KillPreviewView {
  agentId: string;
  positions: { symbol: string; qty: string; costBasisMinor: string }[];
  uninvestedCashMinor: string;
  summary: string;
}

/**
 * What killing this agent would sell.
 *
 * Converted to strings here rather than handed straight out: `KillPreview`
 * carries bigints, and `JSON.stringify` throws on those. Every number that
 * leaves this process does so as a string of minor units.
 */
export async function doPreviewKill(input: { agentId: unknown }): Promise<KillPreviewView> {
  const agentId = checkAgentId(input.agentId);
  const preview: KillPreview = await inTransaction((tx) => previewKill(tx, agentId));

  return {
    agentId: preview.agentId,
    positions: preview.positions.map((p) => ({
      symbol: p.symbol,
      qty: formatQty(p.qty),
      costBasisMinor: p.costBasisMinor.toString(),
    })),
    uninvestedCashMinor: preview.uninvestedCashMinor.toString(),
    summary: preview.summary,
  };
}

/**
 * Stand an agent down. Refuses while it still holds anything.
 *
 * The confirmation is checked here as well as in the browser: a UI check is
 * decoration, and this is the irreversible one.
 */
export async function doKill(
  input: { agentId: unknown; confirm: unknown },
  actor: string,
): Promise<ControlPanelView> {
  const agentId = checkAgentId(input.agentId);
  if (input.confirm !== agentId) {
    throw new ValidationError(
      `kill must be confirmed by repeating the agent id; expected ${agentId}`,
    );
  }

  return inTransaction(async (tx) => {
    await standDown(tx, agentId, actor);
    return controlPanelView(tx);
  });
}

export async function doAddSymbol(
  input: { agentId: unknown; symbol: unknown },
  actor: string,
): Promise<ControlPanelView> {
  const agentId = checkAgentId(input.agentId);
  if (typeof input.symbol !== 'string') throw new ValidationError('symbol is required');

  return inTransaction(async (tx) => {
    await addToUniverse(tx, agentId, input.symbol as string, actor);
    return controlPanelView(tx);
  });
}

export async function doRemoveSymbol(
  input: { agentId: unknown; symbol: unknown },
  actor: string,
): Promise<ControlPanelView & { stillHeld: boolean }> {
  const agentId = checkAgentId(input.agentId);
  if (typeof input.symbol !== 'string') throw new ValidationError('symbol is required');

  return inTransaction(async (tx) => {
    const { stillHeld } = await removeFromUniverse(tx, agentId, input.symbol as string);
    const view = await controlPanelView(tx);
    return { ...view, stillHeld };
  });
}
