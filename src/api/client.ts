/**
 * Kalshi REST API Client
 *
 * Handles all REST interactions: markets, orders, balance, positions.
 * Includes rate limiting, retries with exponential backoff, and timeout handling.
 */

import { getAuthHeaders } from './auth.js';
import { createLogger } from '../utils/logger.js';

const log = createLogger('API');

// =============================================================================
// Types
// =============================================================================

export interface KalshiConfig {
  apiKeyId: string;
  privateKey: string;
  environment: 'demo' | 'production';
}

export interface Market {
  ticker: string;
  event_ticker: string;
  title: string;
  subtitle?: string;
  yes_bid: number;
  yes_ask: number;
  no_bid: number;
  no_ask: number;
  last_price: number;
  volume: number;
  volume_24h: number;
  open_interest: number;
  status: string;
  result?: string;
  expiration_time: string;
  close_time?: string;
}

export interface Order {
  order_id: string;
  client_order_id?: string;
  ticker: string;
  side: 'yes' | 'no';
  action: 'buy' | 'sell';
  type: 'limit' | 'market';
  status: string;
  yes_price: number;
  no_price: number;
  fill_count: number;
  remaining_count: number;
  initial_count: number;
  taker_fees: number;
  maker_fees: number;
  created_time: string;
  last_update_time: string;
}

export interface CreateOrderRequest {
  ticker: string;
  side: 'yes' | 'no';
  action: 'buy' | 'sell';
  type: 'limit' | 'market';
  count: number;
  yes_price?: number;
  no_price?: number;
  client_order_id?: string;
  time_in_force?: string;
  expiration_ts?: number;
  post_only?: boolean;
}

export interface MarketPosition {
  ticker: string;
  total_traded: number;
  position: number;
  market_exposure: number;
  realized_pnl: number;
  resting_orders_count: number;
  fees_paid: number;
  last_updated_ts: string;
}

export interface EventPosition {
  event_ticker: string;
  total_cost: number;
  event_exposure: number;
  realized_pnl: number;
  fees_paid: number;
}

export interface BalanceResponse {
  balance: number;
  portfolio_value: number;
  updated_ts: string;
}

export interface KalshiEvent {
  event_ticker: string;
  title: string;
  category: string;
  sub_title?: string;
  mutually_exclusive: boolean;
  series_ticker?: string;
}

export class KalshiApiError extends Error {
  statusCode: number;
  apiMessage: string;

  constructor(statusCode: number, apiMessage: string) {
    super(`Kalshi API Error ${statusCode}: ${apiMessage}`);
    this.name = 'KalshiApiError';
    this.statusCode = statusCode;
    this.apiMessage = apiMessage;
  }
}

// =============================================================================
// Rate Limiter
// =============================================================================

class RateLimiter {
  private lastRequestTime = 0;
  private retryAfterUntil = 0;

  constructor(private minIntervalMs: number = 100) {}

  async waitForSlot(): Promise<void> {
    const now = Date.now();

    if (this.retryAfterUntil > now) {
      const waitMs = this.retryAfterUntil - now;
      log.debug('Rate limit wait', { waitMs });
      await sleep(waitMs);
    }

    const elapsed = Date.now() - this.lastRequestTime;
    if (elapsed < this.minIntervalMs) {
      await sleep(this.minIntervalMs - elapsed);
    }

    this.lastRequestTime = Date.now();
  }

  setRetryAfter(seconds: number): void {
    this.retryAfterUntil = Date.now() + seconds * 1000;
  }

  parseRetryAfter(response: Response): number {
    const header = response.headers.get('Retry-After');
    if (!header) return 0;
    const seconds = parseInt(header, 10);
    if (!isNaN(seconds) && seconds > 0) return seconds;
    const date = Date.parse(header);
    if (!isNaN(date)) {
      const delayMs = date - Date.now();
      return delayMs > 0 ? Math.ceil(delayMs / 1000) : 0;
    }
    return 0;
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

// =============================================================================
// Client
// =============================================================================

const BASE_URLS = {
  demo: 'https://demo-api.kalshi.co/trade-api/v2',
  production: 'https://api.elections.kalshi.com/trade-api/v2',
};

const RETRYABLE_STATUS_CODES = new Set([408, 429, 500, 502, 503, 504]);
const MAX_RETRIES = 3;
const RETRY_BASE_DELAY_MS = 1000;
const DEFAULT_TIMEOUT_MS = 30000;

export class KalshiClient {
  private config: KalshiConfig;
  private baseUrl: string;
  private rateLimiter: RateLimiter;

  constructor(config: KalshiConfig) {
    this.config = config;
    this.baseUrl = BASE_URLS[config.environment];
    this.rateLimiter = new RateLimiter();
    log.info('Client initialized', { env: config.environment });
  }

  get environment(): string {
    return this.config.environment;
  }

  // ---------------------------------------------------------------------------
  // Core request method
  // ---------------------------------------------------------------------------

  private async request<T>(method: string, endpoint: string, body?: Record<string, unknown>): Promise<T> {
    const path = `/trade-api/v2${endpoint}`;
    const url = `${this.baseUrl}${endpoint}`;
    let lastError: Error | null = null;

    for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
      await this.rateLimiter.waitForSlot();
      const start = Date.now();

      try {
        const headers = getAuthHeaders(method, path, this.config.apiKeyId, this.config.privateKey);
        const options: RequestInit = { method, headers };
        if (body) options.body = JSON.stringify(body);

        if (attempt > 0) log.debug('Retry', { method, endpoint, attempt });

        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), DEFAULT_TIMEOUT_MS);
        let response: Response;
        try {
          response = await fetch(url, { ...options, signal: controller.signal });
        } finally {
          clearTimeout(timeout);
        }

        const durationMs = Date.now() - start;

        if (!response.ok) {
          let apiMessage = `HTTP ${response.status}`;
          try {
            const errorData = await response.json();
            apiMessage = errorData.error?.message || errorData.message || apiMessage;
          } catch {
            apiMessage = response.statusText || apiMessage;
          }

          log.warn('API error', { method, endpoint, status: response.status, durationMs, msg: apiMessage });

          if (response.status === 429) {
            const retryAfter = this.rateLimiter.parseRetryAfter(response);
            if (retryAfter > 0) this.rateLimiter.setRetryAfter(retryAfter);
          }

          if (RETRYABLE_STATUS_CODES.has(response.status) && attempt < MAX_RETRIES - 1) {
            const delay = response.status === 429
              ? Math.max(RETRY_BASE_DELAY_MS * 2 ** attempt, (this.rateLimiter.parseRetryAfter(response) || 1) * 1000)
              : RETRY_BASE_DELAY_MS * 2 ** attempt;
            await sleep(delay);
            continue;
          }

          throw new KalshiApiError(response.status, apiMessage);
        }

        log.debug('OK', { method, endpoint, durationMs });
        return response.json();
      } catch (error) {
        lastError = error as Error;
        if (error instanceof Error && error.name === 'AbortError') {
          if (attempt < MAX_RETRIES - 1) { await sleep(RETRY_BASE_DELAY_MS * 2 ** attempt); continue; }
          throw new KalshiApiError(408, 'Request timeout');
        }
        if (error instanceof TypeError && attempt < MAX_RETRIES - 1) {
          log.warn('Network error', { endpoint, msg: error.message });
          await sleep(RETRY_BASE_DELAY_MS * 2 ** attempt);
          continue;
        }
        if (error instanceof KalshiApiError) throw error;
        throw error;
      }
    }

    throw lastError || new KalshiApiError(500, 'Unknown error after retries');
  }

  // ---------------------------------------------------------------------------
  // Account
  // ---------------------------------------------------------------------------

  async getBalance(): Promise<BalanceResponse> {
    return this.request('GET', '/portfolio/balance');
  }

  // ---------------------------------------------------------------------------
  // Markets
  // ---------------------------------------------------------------------------

  async getMarkets(params?: {
    limit?: number;
    cursor?: string;
    event_ticker?: string;
    series_ticker?: string;
    status?: string;
    tickers?: string;
  }): Promise<{ markets: Market[]; cursor?: string }> {
    const q = new URLSearchParams();
    if (params?.limit) q.set('limit', params.limit.toString());
    if (params?.cursor) q.set('cursor', params.cursor);
    if (params?.event_ticker) q.set('event_ticker', params.event_ticker);
    if (params?.series_ticker) q.set('series_ticker', params.series_ticker);
    if (params?.status) q.set('status', params.status);
    if (params?.tickers) q.set('tickers', params.tickers);
    const qs = q.toString();
    return this.request('GET', qs ? `/markets?${qs}` : '/markets');
  }

  async getMarket(ticker: string): Promise<{ market: Market }> {
    return this.request('GET', `/markets/${ticker}`);
  }

  async getEvent(eventTicker: string): Promise<{ event: KalshiEvent; markets: Market[] }> {
    return this.request('GET', `/events/${eventTicker}`);
  }

  // ---------------------------------------------------------------------------
  // Orders (Buy / Sell)
  // ---------------------------------------------------------------------------

  async createOrder(order: CreateOrderRequest): Promise<{ order: Order }> {
    const body: Record<string, unknown> = {
      ticker: order.ticker,
      side: order.side,
      action: order.action,
      type: order.type,
      count: order.count,
    };
    if (order.yes_price !== undefined) body.yes_price = order.yes_price;
    if (order.no_price !== undefined) body.no_price = order.no_price;
    if (order.client_order_id) body.client_order_id = order.client_order_id;
    if (order.time_in_force) body.time_in_force = order.time_in_force;
    if (order.expiration_ts !== undefined) body.expiration_ts = order.expiration_ts;
    if (order.post_only !== undefined) body.post_only = order.post_only;

    log.info('Creating order', { ticker: order.ticker, side: order.side, action: order.action, count: order.count });
    return this.request('POST', '/portfolio/orders', body);
  }

  async cancelOrder(orderId: string): Promise<{ order: Order }> {
    log.info('Cancelling order', { orderId });
    return this.request('DELETE', `/portfolio/orders/${orderId}`);
  }

  async getOrders(params?: {
    limit?: number;
    cursor?: string;
    ticker?: string;
    status?: string;
  }): Promise<{ orders: Order[]; cursor?: string }> {
    const q = new URLSearchParams();
    if (params?.limit) q.set('limit', params.limit.toString());
    if (params?.cursor) q.set('cursor', params.cursor);
    if (params?.ticker) q.set('ticker', params.ticker);
    if (params?.status) q.set('status', params.status);
    const qs = q.toString();
    return this.request('GET', qs ? `/portfolio/orders?${qs}` : '/portfolio/orders');
  }

  // ---------------------------------------------------------------------------
  // Positions
  // ---------------------------------------------------------------------------

  async getPositions(params?: {
    limit?: number;
    cursor?: string;
    ticker?: string;
    event_ticker?: string;
    settlement_status?: string;
  }): Promise<{ market_positions: MarketPosition[]; event_positions: EventPosition[]; cursor?: string }> {
    const q = new URLSearchParams();
    if (params?.limit) q.set('limit', params.limit.toString());
    if (params?.cursor) q.set('cursor', params.cursor);
    if (params?.ticker) q.set('ticker', params.ticker);
    if (params?.event_ticker) q.set('event_ticker', params.event_ticker);
    if (params?.settlement_status) q.set('settlement_status', params.settlement_status);
    const qs = q.toString();
    return this.request('GET', qs ? `/portfolio/positions?${qs}` : '/portfolio/positions');
  }

  // ---------------------------------------------------------------------------
  // Convenience: Buy / Sell helpers
  // ---------------------------------------------------------------------------

  async buy(ticker: string, side: 'yes' | 'no', count: number, limitPrice?: number): Promise<{ order: Order }> {
    return this.createOrder({
      ticker,
      side,
      action: 'buy',
      type: limitPrice !== undefined ? 'limit' : 'market',
      count,
      ...(side === 'yes' && limitPrice !== undefined ? { yes_price: limitPrice } : {}),
      ...(side === 'no' && limitPrice !== undefined ? { no_price: limitPrice } : {}),
    });
  }

  async sell(ticker: string, side: 'yes' | 'no', count: number, limitPrice?: number): Promise<{ order: Order }> {
    return this.createOrder({
      ticker,
      side,
      action: 'sell',
      type: limitPrice !== undefined ? 'limit' : 'market',
      count,
      ...(side === 'yes' && limitPrice !== undefined ? { yes_price: limitPrice } : {}),
      ...(side === 'no' && limitPrice !== undefined ? { no_price: limitPrice } : {}),
    });
  }
}
