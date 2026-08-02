/**
 * What a strategy is, and — more importantly — what it is not.
 *
 * A strategy is a **pure function** from a snapshot of the world to a list of
 * intentions. It gets no database handle, no broker, no network and no clock.
 * It cannot place an order; it can only ask for one, and the runner decides
 * whether that request survives the halt check, the budget cap, the universe
 * and the order-size rail.
 *
 * That shape is the point. It means a strategy can be tested exhaustively with
 * no mocking, it cannot reach around the rails however it is written, and when
 * an LLM eventually writes one of these, the blast radius is a list of
 * suggestions rather than an open connection to a brokerage account.
 */

import type { Minor, Qty } from '../money.js';

export interface PriceBar {
  /** Oldest first. */
  asOf: Date;
  closeMinor: Minor;
}

export interface StrategyInput {
  asOf: Date;
  /** Only symbols the owner has permitted. The runner does not offer others. */
  universe: string[];
  /** Close history per symbol, oldest first. May be short or missing. */
  history: Map<string, PriceBar[]>;
  /** What this agent currently holds. Never another agent's positions. */
  positions: Map<string, Qty>;
  /** Uninvested capital available to this agent. */
  cashMinor: Minor;
  /** The agent's total budget cap, for sizing. */
  allocatedMinor: Minor;
}

export type Intent =
  | { action: 'buy'; symbol: string; notionalMinor: Minor; why: string }
  | { action: 'sell'; symbol: string; qty: Qty; why: string };

export interface Strategy {
  readonly name: string;
  /**
   * `why` on each intent is not decoration. When an agent does something
   * surprising at 04:00, the reason it gave at the time is the only account
   * of what it thought it was doing.
   */
  decide(input: StrategyInput): Intent[];
}
