/**
 * The broker adapter boundary.
 *
 * The ledger is broker-agnostic and stays that way. Alpaca vs IBKR is still an
 * open decision, and keeping every broker-specific detail behind this
 * interface is what stops that decision from being structural — a swap should
 * be one new file, not a migration.
 *
 * Nothing here is implemented yet, deliberately. Per the build order, the
 * ledger has to reconcile against a real paper account before an agent is
 * allowed to place anything.
 *
 * Implementations run server-side only and hold the credentials. No broker
 * key ever reaches client code, and never through a VITE_-prefixed variable —
 * those are bundled into public JavaScript.
 */

import type { Minor, Qty } from '../money.js';

export interface BrokerPosition {
  symbol: string;
  qty: Qty;
}

export interface BrokerAccount {
  asOf: Date;
  cashMinor: Minor;
  equityMinor: Minor;
}

export interface PlaceOrderRequest {
  /**
   * Attribution travels with the order rather than being attached afterwards.
   * Reconstructing which agent asked for a fill after the fact is close to
   * impossible once two agents hold the same symbol.
   */
  agentId: string;
  symbol: string;
  side: 'buy' | 'sell';
  qty: Qty;
  /** Omitted means market. */
  limitPriceMinor?: Minor;
  /**
   * Passed through to the broker where supported, so that a retry after a
   * network timeout cannot open a second position. The same key is unique in
   * ledger.orders, so both sides of the boundary refuse the duplicate.
   */
  idempotencyKey: string;
}

export interface PlacedOrder {
  brokerOrderId: string;
  acceptedAt: Date;
}

export interface BrokerFill {
  brokerFillId: string;
  brokerOrderId: string;
  symbol: string;
  side: 'buy' | 'sell';
  qty: Qty;
  pricePerUnitMinor: Minor;
  feeMinor: Minor;
  filledAt: Date;
}

export interface Quote {
  symbol: string;
  pricePerUnitMinor: Minor;
  asOf: Date;
}

export interface BrokerAdapter {
  readonly name: string;
  /**
   * False means this adapter is pointed at real money. Kept explicit so it can
   * be asserted before anything is placed: paper trading holds until the
   * ledger has reconciled cleanly for weeks.
   */
  readonly isPaper: boolean;

  getAccount(): Promise<BrokerAccount>;
  getPositions(): Promise<BrokerPosition[]>;
  placeOrder(request: PlaceOrderRequest): Promise<PlacedOrder>;
  cancelOrder(brokerOrderId: string): Promise<void>;
  /** Fills at or after `since`, for the poller that feeds `recordFill`. */
  getFills(since: Date): Promise<BrokerFill[]>;
  /**
   * Prices for valuing positions. These are stored into ledger.marks rather
   * than read at display time, so a figure shown in the UI can be reproduced
   * later and reconciliation compares like with like.
   */
  getQuotes(symbols: readonly string[]): Promise<Quote[]>;
}

/**
 * Deliberately not part of `BrokerAdapter`.
 *
 * Real broker APIs cannot deposit or withdraw cash — that is a fraud boundary,
 * not an oversight, and money enters the account by manual bank transfer. Only
 * the simulator can do this, and keeping it off the shared interface means no
 * code written against `BrokerAdapter` can come to depend on something that
 * will not exist against a real broker.
 */
export interface FundableBroker {
  fundAccount(amountMinor: Minor): Promise<void>;
}
