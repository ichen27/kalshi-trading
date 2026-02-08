/**
 * Core engine types for the modular strategy system.
 *
 * Each strategy gets an allocated portion of total cash and maintains
 * its own independent state: P&L, positions, order history.
 */

// =============================================================================
// Strategy Identity & Configuration
// =============================================================================

export interface StrategyConfig {
  /** Unique strategy ID */
  id: string;
  /** Human-readable name */
  name: string;
  /** Strategy type tag */
  type: string;
  /** Whether this strategy is active */
  enabled: boolean;
  /** Fraction of total cash allocated (0-1). Sum across all strategies <= 1. */
  allocationPct: number;
  /** Strategy-specific parameters */
  params: Record<string, unknown>;
}

// =============================================================================
// Strategy State (independent per strategy)
// =============================================================================

export type StrategyStatus = 'idle' | 'active' | 'paused' | 'error';

export interface StrategyState {
  /** Config ID this state belongs to */
  strategyId: string;
  status: StrategyStatus;

  // --- Capital ---
  /** Cash allocated to this strategy (cents) */
  allocatedCash: number;
  /** Cash currently available (allocated - in open orders - in positions cost basis) */
  availableCash: number;
  /** Cash locked in open orders */
  lockedInOrders: number;

  // --- Positions ---
  /** Positions held by this strategy: ticker -> PositionEntry */
  positions: Map<string, PositionEntry>;

  // --- P&L ---
  realizedPnl: number;
  unrealizedPnl: number;
  fees: number;

  // --- Tracking ---
  ordersPlaced: number;
  ordersFilled: number;
  ordersCancelled: number;
  lastActivityAt: Date | null;

  // --- Errors ---
  errorCount: number;
  lastError: string | null;
}

export interface PositionEntry {
  ticker: string;
  side: 'yes' | 'no';
  quantity: number;
  avgCostBasis: number; // cents per contract
  currentPrice: number; // latest known price
}

// =============================================================================
// Allocation Snapshot
// =============================================================================

export interface AllocationSnapshot {
  totalCash: number;
  unallocatedCash: number;
  strategies: Array<{
    id: string;
    name: string;
    type: string;
    enabled: boolean;
    allocationPct: number;
    allocatedCash: number;
    availableCash: number;
    lockedInOrders: number;
    unrealizedPnl: number;
    realizedPnl: number;
    fees: number;
    positionCount: number;
    positions: Array<{
      ticker: string;
      side: 'yes' | 'no';
      quantity: number;
      avgCostBasis: number;
      currentPrice: number;
      unrealizedPnl: number;
    }>;
    ordersPlaced: number;
    ordersFilled: number;
    ordersCancelled: number;
    status: StrategyStatus;
  }>;
}

// =============================================================================
// Order Tracking (per strategy)
// =============================================================================

export interface TrackedOrder {
  orderId: string;
  strategyId: string;
  ticker: string;
  side: 'yes' | 'no';
  action: 'buy' | 'sell';
  count: number;
  price: number;
  status: string;
  createdAt: Date;
}
