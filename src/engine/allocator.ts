/**
 * Strategy Allocator
 *
 * Manages the pool of total cash and allocates portions to each strategy.
 * Each strategy gets its own independent state: capital, positions, P&L.
 *
 * Usage:
 *   const allocator = new StrategyAllocator(totalCashCents);
 *   allocator.addStrategy({ id: 'arb', name: 'Arbitrage', ... allocationPct: 0.3, ... });
 *   allocator.addStrategy({ id: 'val', name: 'Value', ... allocationPct: 0.5, ... });
 *   // 20% remains unallocated (reserve)
 */

import { createLogger } from '../utils/logger.js';
import type {
  StrategyConfig,
  StrategyState,
  PositionEntry,
  AllocationSnapshot,
  TrackedOrder,
} from './types.js';

const log = createLogger('ALLOC');

export class StrategyAllocator {
  private totalCash: number;
  private configs = new Map<string, StrategyConfig>();
  private states = new Map<string, StrategyState>();
  private orders = new Map<string, TrackedOrder>(); // orderId -> TrackedOrder

  constructor(totalCashCents: number) {
    this.totalCash = totalCashCents;
    log.info('Allocator initialized', { totalCash: totalCashCents });
  }

  // ---------------------------------------------------------------------------
  // Strategy registration
  // ---------------------------------------------------------------------------

  addStrategy(config: StrategyConfig): void {
    if (this.configs.has(config.id)) {
      throw new Error(`Strategy '${config.id}' already registered`);
    }

    // Validate total allocation doesn't exceed 100%
    const currentAlloc = this.totalAllocationPct();
    if (currentAlloc + config.allocationPct > 1.0001) { // small epsilon for float
      throw new Error(
        `Cannot allocate ${(config.allocationPct * 100).toFixed(1)}% to '${config.id}'. ` +
        `Current total: ${(currentAlloc * 100).toFixed(1)}%, would exceed 100%.`
      );
    }

    this.configs.set(config.id, config);

    const allocatedCash = Math.floor(this.totalCash * config.allocationPct);
    const state: StrategyState = {
      strategyId: config.id,
      status: config.enabled ? 'idle' : 'paused',
      allocatedCash,
      availableCash: allocatedCash,
      lockedInOrders: 0,
      positions: new Map(),
      realizedPnl: 0,
      unrealizedPnl: 0,
      fees: 0,
      ordersPlaced: 0,
      ordersFilled: 0,
      ordersCancelled: 0,
      lastActivityAt: null,
      errorCount: 0,
      lastError: null,
    };

    this.states.set(config.id, state);
    log.info('Strategy added', {
      id: config.id,
      name: config.name,
      pct: `${(config.allocationPct * 100).toFixed(1)}%`,
      cash: allocatedCash,
    });
  }

  hasStrategy(id: string): boolean {
    return this.configs.has(id);
  }

  updateStrategyConfig(id: string, partial: Partial<Pick<StrategyConfig, 'enabled' | 'params' | 'name' | 'type'>>): void {
    const config = this.getConfig(id);
    const state = this.getState(id);

    if (partial.enabled !== undefined) {
      config.enabled = partial.enabled;
      if (!partial.enabled && state.status !== 'error') {
        state.status = 'paused';
      } else if (partial.enabled && state.status === 'paused') {
        state.status = 'idle';
      }
    }
    if (partial.params !== undefined) config.params = partial.params;
    if (partial.name !== undefined) config.name = partial.name;
    if (partial.type !== undefined) config.type = partial.type;

    log.info('Strategy config updated', { id, changes: Object.keys(partial) });
  }

  getOrdersByStrategy(strategyId: string): TrackedOrder[] {
    const result: TrackedOrder[] = [];
    for (const order of this.orders.values()) {
      if (order.strategyId === strategyId) result.push(order);
    }
    return result;
  }

  removeStrategy(strategyId: string): void {
    const state = this.getState(strategyId);
    if (state.positions.size > 0) {
      throw new Error(`Cannot remove '${strategyId}': has open positions`);
    }
    if (state.lockedInOrders > 0) {
      throw new Error(`Cannot remove '${strategyId}': has locked capital in orders`);
    }
    this.configs.delete(strategyId);
    this.states.delete(strategyId);
    log.info('Strategy removed', { id: strategyId });
  }

  // ---------------------------------------------------------------------------
  // Cash management
  // ---------------------------------------------------------------------------

  updateTotalCash(newTotalCents: number): void {
    const oldTotal = this.totalCash;
    this.totalCash = newTotalCents;

    // Re-allocate each strategy proportionally
    for (const [id, config] of this.configs) {
      const state = this.states.get(id)!;
      const newAlloc = Math.floor(newTotalCents * config.allocationPct);
      const delta = newAlloc - state.allocatedCash;
      state.allocatedCash = newAlloc;
      state.availableCash = Math.max(0, state.availableCash + delta);
    }

    log.info('Total cash updated', { old: oldTotal, new: newTotalCents });
  }

  /** Reallocate a strategy's percentage (rebalances cash) */
  reallocate(strategyId: string, newPct: number): void {
    const config = this.getConfig(strategyId);
    const state = this.getState(strategyId);

    const otherAlloc = this.totalAllocationPct() - config.allocationPct;
    if (otherAlloc + newPct > 1.0001) {
      throw new Error(`Cannot reallocate to ${(newPct * 100).toFixed(1)}%. Other strategies use ${(otherAlloc * 100).toFixed(1)}%.`);
    }

    const oldAlloc = state.allocatedCash;
    config.allocationPct = newPct;
    const newAlloc = Math.floor(this.totalCash * newPct);
    const delta = newAlloc - oldAlloc;

    state.allocatedCash = newAlloc;
    state.availableCash = Math.max(0, state.availableCash + delta);

    log.info('Strategy reallocated', { id: strategyId, pct: `${(newPct * 100).toFixed(1)}%`, cash: newAlloc });
  }

  // ---------------------------------------------------------------------------
  // Order lifecycle (tracks capital locking)
  // ---------------------------------------------------------------------------

  /** Reserve cash for an order. Returns false if insufficient funds. */
  reserveForOrder(strategyId: string, order: TrackedOrder): boolean {
    const state = this.getState(strategyId);
    const cost = order.count * order.price;

    if (order.action === 'buy' && state.availableCash < cost) {
      log.warn('Insufficient funds', { strategy: strategyId, need: cost, available: state.availableCash });
      return false;
    }

    if (order.action === 'buy') {
      state.availableCash -= cost;
      state.lockedInOrders += cost;
    }

    state.ordersPlaced++;
    state.lastActivityAt = new Date();
    this.orders.set(order.orderId, { ...order, strategyId });

    log.debug('Order reserved', { strategy: strategyId, orderId: order.orderId, cost });
    return true;
  }

  /** Order filled: move locked capital into position */
  onOrderFilled(orderId: string, fillPrice: number, fillCount: number, fee: number): void {
    const tracked = this.orders.get(orderId);
    if (!tracked) { log.warn('Unknown order filled', { orderId }); return; }

    const state = this.getState(tracked.strategyId);
    const cost = fillCount * fillPrice;

    if (tracked.action === 'buy') {
      // Unlock the reserved amount
      const reservedCost = fillCount * tracked.price;
      state.lockedInOrders = Math.max(0, state.lockedInOrders - reservedCost);

      // If fill price is less than reserved, return difference
      if (fillPrice < tracked.price) {
        state.availableCash += (tracked.price - fillPrice) * fillCount;
      }

      // Add/update position
      const existing = state.positions.get(tracked.ticker);
      if (existing && existing.side === tracked.side) {
        const totalQty = existing.quantity + fillCount;
        existing.avgCostBasis = Math.round(
          (existing.avgCostBasis * existing.quantity + fillPrice * fillCount) / totalQty
        );
        existing.quantity = totalQty;
      } else {
        state.positions.set(tracked.ticker, {
          ticker: tracked.ticker,
          side: tracked.side,
          quantity: fillCount,
          avgCostBasis: fillPrice,
          currentPrice: fillPrice,
        });
      }
    } else {
      // Sell: return proceeds to available cash
      const pos = state.positions.get(tracked.ticker);
      if (pos) {
        const pnl = (fillPrice - pos.avgCostBasis) * fillCount;
        state.realizedPnl += pnl;
        pos.quantity -= fillCount;
        if (pos.quantity <= 0) state.positions.delete(tracked.ticker);
      }
      state.availableCash += cost;
    }

    state.fees += fee;
    state.ordersFilled++;
    state.lastActivityAt = new Date();

    log.info('Order filled', { strategy: tracked.strategyId, orderId, fillPrice, fillCount, fee });
  }

  /** Order cancelled: release locked capital */
  onOrderCancelled(orderId: string): void {
    const tracked = this.orders.get(orderId);
    if (!tracked) return;

    const state = this.getState(tracked.strategyId);

    if (tracked.action === 'buy') {
      const cost = tracked.count * tracked.price;
      state.lockedInOrders = Math.max(0, state.lockedInOrders - cost);
      state.availableCash += cost;
    }

    state.ordersCancelled++;
    this.orders.delete(orderId);

    log.debug('Order cancelled, capital released', { strategy: tracked.strategyId, orderId });
  }

  // ---------------------------------------------------------------------------
  // Price updates
  // ---------------------------------------------------------------------------

  updatePrice(ticker: string, price: number): void {
    for (const state of this.states.values()) {
      const pos = state.positions.get(ticker);
      if (pos) {
        pos.currentPrice = price;
      }
    }
    // Recalc unrealized P&L
    this.recalcUnrealizedPnl();
  }

  private recalcUnrealizedPnl(): void {
    for (const state of this.states.values()) {
      let unrealized = 0;
      for (const pos of state.positions.values()) {
        const pnlPerContract = pos.currentPrice - pos.avgCostBasis;
        unrealized += pnlPerContract * pos.quantity;
      }
      state.unrealizedPnl = unrealized;
    }
  }

  // ---------------------------------------------------------------------------
  // Queries
  // ---------------------------------------------------------------------------

  getConfig(strategyId: string): StrategyConfig {
    const config = this.configs.get(strategyId);
    if (!config) throw new Error(`Strategy '${strategyId}' not found`);
    return config;
  }

  getState(strategyId: string): StrategyState {
    const state = this.states.get(strategyId);
    if (!state) throw new Error(`Strategy '${strategyId}' not found`);
    return state;
  }

  getAllStrategies(): StrategyConfig[] {
    return [...this.configs.values()];
  }

  getSnapshot(): AllocationSnapshot {
    const strategies = [...this.configs.values()].map(config => {
      const state = this.states.get(config.id)!;

      const positions = [...state.positions.values()].map(pos => ({
        ticker: pos.ticker,
        side: pos.side,
        quantity: pos.quantity,
        avgCostBasis: pos.avgCostBasis,
        currentPrice: pos.currentPrice,
        unrealizedPnl: (pos.currentPrice - pos.avgCostBasis) * pos.quantity,
      }));

      return {
        id: config.id,
        name: config.name,
        type: config.type,
        enabled: config.enabled,
        allocationPct: config.allocationPct,
        allocatedCash: state.allocatedCash,
        availableCash: state.availableCash,
        lockedInOrders: state.lockedInOrders,
        unrealizedPnl: state.unrealizedPnl,
        realizedPnl: state.realizedPnl,
        fees: state.fees,
        positionCount: state.positions.size,
        positions,
        ordersPlaced: state.ordersPlaced,
        ordersFilled: state.ordersFilled,
        ordersCancelled: state.ordersCancelled,
        status: state.status,
      };
    });

    const allocatedTotal = strategies.reduce((sum, s) => sum + s.allocatedCash, 0);

    return {
      totalCash: this.totalCash,
      unallocatedCash: this.totalCash - allocatedTotal,
      strategies,
    };
  }

  getTotalCash(): number {
    return this.totalCash;
  }

  private totalAllocationPct(): number {
    let total = 0;
    for (const config of this.configs.values()) {
      total += config.allocationPct;
    }
    return total;
  }
}
