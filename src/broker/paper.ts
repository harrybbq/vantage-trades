/**
 * A simulated broker, for proving the ledger before real money or a real API.
 *
 * It keeps its own books in the `paper` schema and knows nothing about agents,
 * because a paper broker that read from the ledger would make reconciliation
 * circular — comparing the ledger against itself and always agreeing.
 *
 * Costs are modelled, not idealised. Spread, slippage and commission are the
 * dominant drag on a small account: frequent trading on GBP 1,000 can shed
 * several percent a year before any strategy decision is made. A simulator
 * that fills at the mid price makes losing strategies look profitable, which
 * is the single most expensive way to be wrong here.
 */

import type { Sql } from '../db.js';
import { notional, parseQty, type Minor, type Qty } from '../money.js';
import type {
  BrokerAccount,
  BrokerAdapter,
  BrokerFill,
  BrokerPosition,
  FundableBroker,
  PlaceOrderRequest,
  PlacedOrder,
  Quote,
} from './types.js';

export interface PaperBrokerCosts {
  /** Half-spread in basis points, paid on every trade in both directions. */
  spreadBps: bigint;
  /** Additional adverse price movement in basis points, on market orders. */
  slippageBps: bigint;
  /** Flat commission per fill, in minor units. */
  commissionMinor: Minor;
}

/**
 * Defaults sit near the pessimistic end on purpose. A simulator that flatters
 * a strategy is worse than no simulator, because it produces a number that
 * feels earned.
 */
export const DEFAULT_COSTS: PaperBrokerCosts = {
  spreadBps: 5n,
  slippageBps: 2n,
  commissionMinor: 100n,
};

const BPS = 10_000n;

export class PaperBroker implements BrokerAdapter, FundableBroker {
  readonly name = 'paper';
  readonly isPaper = true;

  constructor(
    private readonly tx: Sql,
    private readonly costs: PaperBrokerCosts = DEFAULT_COSTS,
  ) {}

  /** Simulates the manual bank transfer that a real broker API cannot do. */
  async fundAccount(amountMinor: Minor): Promise<void> {
    if (amountMinor <= 0n) throw new Error('funding must be positive');
    await this.tx.query(`update paper.account set cash_minor = cash_minor + $1`, [
      amountMinor.toString(),
    ]);
  }

  async setPrice(symbol: string, priceMinor: Minor): Promise<void> {
    await this.tx.query(
      `insert into paper.market_prices (symbol, price_minor, updated_at)
       values ($1, $2, now())
       on conflict (symbol) do update
         set price_minor = excluded.price_minor, updated_at = now()`,
      [symbol.toUpperCase(), priceMinor.toString()],
    );
  }

  async getAccount(): Promise<BrokerAccount> {
    const cash = await this.cashMinor();
    const positions = await this.tx.query<{ symbol: string; qty: string }>(
      `select symbol, qty::text as qty from paper.positions where qty > 0`,
    );

    let marketValue = 0n;
    for (const row of positions.rows) {
      const price = await this.priceOf(row.symbol);
      marketValue += notional(parseQty(row.qty), price);
    }

    return { asOf: new Date(), cashMinor: cash, equityMinor: cash + marketValue };
  }

  async getPositions(): Promise<BrokerPosition[]> {
    const result = await this.tx.query<{ symbol: string; qty: string }>(
      `select symbol, qty::text as qty from paper.positions where qty > 0 order by symbol`,
    );
    return result.rows.map((r) => ({ symbol: r.symbol, qty: parseQty(r.qty) }));
  }

  async getQuotes(symbols: readonly string[]): Promise<Quote[]> {
    if (symbols.length === 0) return [];
    const result = await this.tx.query<{ symbol: string; price_minor: bigint; updated_at: Date }>(
      `select symbol, price_minor, updated_at from paper.market_prices where symbol = any($1)`,
      [symbols.map((s) => s.toUpperCase())],
    );
    return result.rows.map((r) => ({
      symbol: r.symbol,
      pricePerUnitMinor: r.price_minor,
      asOf: r.updated_at,
    }));
  }

  /**
   * Place an order. Market orders fill immediately; limit orders fill only if
   * the adjusted price is acceptable, and are otherwise rejected rather than
   * left resting — a resting-order book is more simulation than this needs.
   *
   * A rejection is returned as a rejected order, not thrown. That is how a real
   * broker behaves, and code that only handles the happy path is code that will
   * be surprised in production.
   */
  async placeOrder(request: PlaceOrderRequest): Promise<PlacedOrder> {
    const existing = await this.tx.query<{ id: string; created_at: Date }>(
      `select id, created_at from paper.orders where idempotency_key = $1`,
      [request.idempotencyKey],
    );
    const prior = existing.rows[0];
    if (prior) {
      // The retry path: same key, same order, no second position.
      return { brokerOrderId: prior.id, acceptedAt: prior.created_at };
    }

    const symbol = request.symbol.toUpperCase();
    const price = await this.priceOf(symbol);
    const executionPrice = this.applyCosts(price, request.side);

    const rejection = await this.rejectionReason(request, symbol, executionPrice);

    const order = await this.tx.query<{ id: string; created_at: Date }>(
      `insert into paper.orders
         (symbol, side, qty, limit_price_minor, status, reject_reason, idempotency_key)
       values ($1, $2, $3, $4, $5, $6, $7)
       returning id, created_at`,
      [
        symbol,
        request.side,
        formatQtyForPg(request.qty),
        request.limitPriceMinor?.toString() ?? null,
        rejection ? 'rejected' : 'filled',
        rejection,
        request.idempotencyKey,
      ],
    );
    const row = order.rows[0];
    if (!row) throw new Error('failed to place paper order');

    if (!rejection) {
      await this.fill(row.id, symbol, request.side, request.qty, executionPrice);
    }

    return { brokerOrderId: row.id, acceptedAt: row.created_at };
  }

  async cancelOrder(brokerOrderId: string): Promise<void> {
    // Fills are immediate here, so by the time anything could cancel, the order
    // is already done. Saying so plainly beats silently succeeding.
    const result = await this.tx.query<{ status: string }>(
      `select status from paper.orders where id = $1`,
      [brokerOrderId],
    );
    const status = result.rows[0]?.status;
    if (!status) throw new Error(`no such paper order: ${brokerOrderId}`);
    if (status === 'filled') {
      throw new Error(`paper order ${brokerOrderId} already filled and cannot be cancelled`);
    }
    await this.tx.query(`update paper.orders set status = 'cancelled' where id = $1`, [
      brokerOrderId,
    ]);
  }

  async getFills(since: Date): Promise<BrokerFill[]> {
    const result = await this.tx.query<{
      id: string;
      order_id: string;
      symbol: string;
      side: 'buy' | 'sell';
      qty: string;
      price_minor: bigint;
      fee_minor: bigint;
      filled_at: Date;
    }>(
      `select id, order_id, symbol, side, qty::text as qty, price_minor, fee_minor, filled_at
         from paper.fills where filled_at >= $1 order by filled_at, id`,
      [since],
    );

    return result.rows.map((r) => ({
      brokerFillId: r.id,
      brokerOrderId: r.order_id,
      symbol: r.symbol,
      side: r.side,
      qty: parseQty(r.qty),
      pricePerUnitMinor: r.price_minor,
      feeMinor: r.fee_minor,
      filledAt: r.filled_at,
    }));
  }

  // -------------------------------------------------------------------------

  private async rejectionReason(
    request: PlaceOrderRequest,
    symbol: string,
    executionPrice: Minor,
  ): Promise<string | null> {
    if (request.side === 'buy') {
      const cost = notional(request.qty, executionPrice) + this.costs.commissionMinor;
      const cash = await this.cashMinor();
      if (cost > cash) {
        return `insufficient buying power: needs ${cost}, account holds ${cash}`;
      }
      if (request.limitPriceMinor !== undefined && executionPrice > request.limitPriceMinor) {
        return `limit not met: would fill at ${executionPrice}, limit ${request.limitPriceMinor}`;
      }
      return null;
    }

    const held = await this.qtyOf(symbol);
    if (request.qty > held) {
      // No shorting. The ledger has no concept of a negative position, and
      // allowing one here would let the simulator drift somewhere the ledger
      // cannot follow.
      return `insufficient position: holds ${held} (scale 8), asked to sell ${request.qty}`;
    }
    if (request.limitPriceMinor !== undefined && executionPrice < request.limitPriceMinor) {
      return `limit not met: would fill at ${executionPrice}, limit ${request.limitPriceMinor}`;
    }
    return null;
  }

  /**
   * The price moves against you in both directions. That is the whole point.
   *
   * The adjustment rounds up, never down. Integer division would truncate and
   * quietly make trading cheaper than configured, and a simulator that shades
   * costs in the strategy's favour is how a negative-expectancy idea gets
   * funded.
   */
  private applyCosts(midMinor: Minor, side: 'buy' | 'sell'): Minor {
    const adverseBps = this.costs.spreadBps + this.costs.slippageBps;
    const numerator = midMinor * adverseBps;
    const adjustment = numerator === 0n ? 0n : (numerator + BPS - 1n) / BPS;
    const price = side === 'buy' ? midMinor + adjustment : midMinor - adjustment;
    return price > 0n ? price : 1n;
  }

  private async fill(
    orderId: string,
    symbol: string,
    side: 'buy' | 'sell',
    qty: Qty,
    priceMinor: Minor,
  ): Promise<void> {
    const gross = notional(qty, priceMinor);
    const fee = this.costs.commissionMinor;

    await this.tx.query(
      `insert into paper.fills (order_id, symbol, side, qty, price_minor, fee_minor)
       values ($1, $2, $3, $4, $5, $6)`,
      [orderId, symbol, side, formatQtyForPg(qty), priceMinor.toString(), fee.toString()],
    );

    if (side === 'buy') {
      await this.tx.query(
        `update paper.account set cash_minor = cash_minor - $1`,
        [(gross + fee).toString()],
      );
      await this.tx.query(
        `insert into paper.positions (symbol, qty, cost_total_minor)
         values ($1, $2, $3)
         on conflict (symbol) do update
           set qty = paper.positions.qty + excluded.qty,
               cost_total_minor = paper.positions.cost_total_minor + excluded.cost_total_minor`,
        [symbol, formatQtyForPg(qty), gross.toString()],
      );
      return;
    }

    await this.tx.query(`update paper.account set cash_minor = cash_minor + $1`, [
      (gross - fee).toString(),
    ]);

    // The broker releases cost at its own blended average — it has no lots.
    // The ledger's FIFO figure will differ, and that is expected: they are
    // answering different questions.
    const position = await this.tx.query<{ qty: string; cost_total_minor: bigint }>(
      `select qty::text as qty, cost_total_minor from paper.positions where symbol = $1 for update`,
      [symbol],
    );
    const row = position.rows[0];
    if (!row) throw new Error(`paper broker has no position in ${symbol}`);

    const heldQty = parseQty(row.qty);
    const remainingQty = heldQty - qty;
    const releasedCost =
      remainingQty === 0n ? row.cost_total_minor : (row.cost_total_minor * qty) / heldQty;

    await this.tx.query(
      `update paper.positions set qty = $2, cost_total_minor = $3 where symbol = $1`,
      [
        symbol,
        formatQtyForPg(remainingQty),
        (row.cost_total_minor - releasedCost).toString(),
      ],
    );
  }

  private async cashMinor(): Promise<Minor> {
    const result = await this.tx.query<{ cash_minor: bigint }>(
      `select cash_minor from paper.account`,
    );
    return result.rows[0]?.cash_minor ?? 0n;
  }

  private async qtyOf(symbol: string): Promise<Qty> {
    const result = await this.tx.query<{ qty: string }>(
      `select qty::text as qty from paper.positions where symbol = $1`,
      [symbol],
    );
    const qty = result.rows[0]?.qty;
    return qty === undefined ? 0n : parseQty(qty);
  }

  private async priceOf(symbol: string): Promise<Minor> {
    const result = await this.tx.query<{ price_minor: bigint }>(
      `select price_minor from paper.market_prices where symbol = $1`,
      [symbol],
    );
    const price = result.rows[0]?.price_minor;
    if (price === undefined) {
      throw new Error(`no market price for ${symbol}; set one before trading it`);
    }
    return price;
  }
}

function formatQtyForPg(qty: Qty): string {
  const negative = qty < 0n;
  const abs = negative ? -qty : qty;
  return `${negative ? '-' : ''}${abs / 100000000n}.${(abs % 100000000n).toString().padStart(8, '0')}`;
}
