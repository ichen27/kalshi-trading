/**
 * Kalshi WebSocket Client
 *
 * Real-time market data streaming: orderbook, ticker, trades.
 * Authenticated channels: fills, order updates, portfolio, balance.
 * Auto-reconnect with exponential backoff.
 *
 * Kalshi WS protocol uses: { id, cmd, params } for commands
 * and { type, ... } or { sid, ... } for server messages.
 */

import WebSocket from 'ws';
import { signRequest } from './auth.js';
import { createLogger } from '../utils/logger.js';
import type { KalshiConfig } from './client.js';

const log = createLogger('WS');

// =============================================================================
// Types
// =============================================================================

export type WebSocketState = 'disconnected' | 'connecting' | 'connected' | 'reconnecting';

export interface TickerUpdate {
  ticker: string;
  yes_bid: number;
  yes_ask: number;
  no_bid: number;
  no_ask: number;
  last_price: number;
  volume: number;
  open_interest: number;
  ts: string;
}

export interface TradeUpdate {
  ticker: string;
  trade_id: string;
  side: 'yes' | 'no';
  price: number;
  count: number;
  taker_side: 'buy' | 'sell';
  ts: string;
}

export interface OrderbookLevel {
  price: number;
  quantity: number;
}

export interface OrderbookSnapshot {
  ticker: string;
  yes: OrderbookLevel[][];
  no: OrderbookLevel[][];
}

export interface FillUpdate {
  fill_id: string;
  order_id: string;
  ticker: string;
  side: 'yes' | 'no';
  action: 'buy' | 'sell';
  count: number;
  price: number;
  fee: number;
  is_taker: boolean;
  ts: string;
}

export interface OrderUpdate {
  order_id: string;
  ticker: string;
  side: 'yes' | 'no';
  action: 'buy' | 'sell';
  type: 'limit' | 'market';
  status: string;
  yes_price: number;
  no_price: number;
  remaining_count: number;
  filled_count: number;
  ts: string;
}

export interface BalanceUpdate {
  balance: number;
  portfolio_value: number;
  ts: string;
}

export type EventHandler<T> = (data: T) => void;

interface EventHandlers {
  ticker: EventHandler<TickerUpdate>[];
  trade: EventHandler<TradeUpdate>[];
  orderbook: EventHandler<OrderbookSnapshot>[];
  fill: EventHandler<FillUpdate>[];
  order_update: EventHandler<OrderUpdate>[];
  balance: EventHandler<BalanceUpdate>[];
  connected: EventHandler<void>[];
  disconnected: EventHandler<{ reason: string }>[];
  error: EventHandler<{ error: Error }>[];
  raw: EventHandler<Record<string, unknown>>[];
}

// =============================================================================
// WebSocket URLs
// =============================================================================

const WS_URLS = {
  demo: 'wss://demo-api.kalshi.co/trade-api/ws/v2',
  production: 'wss://api.elections.kalshi.com/trade-api/ws/v2',
};

// =============================================================================
// Client
// =============================================================================

export class KalshiWebSocket {
  private config: KalshiConfig;
  private ws: WebSocket | null = null;
  private state: WebSocketState = 'disconnected';
  private reconnectAttempt = 0;
  private maxReconnectDelay = 30000;
  private pingInterval: ReturnType<typeof setInterval> | null = null;
  private msgId = 0;
  private pendingSubs: Array<{ channels: string[]; tickers?: string[] }> = [];
  private handlers: EventHandlers = {
    ticker: [],
    trade: [],
    orderbook: [],
    fill: [],
    order_update: [],
    balance: [],
    connected: [],
    disconnected: [],
    error: [],
    raw: [],
  };

  constructor(config: KalshiConfig) {
    this.config = config;
  }

  get connectionState(): WebSocketState {
    return this.state;
  }

  // ---------------------------------------------------------------------------
  // Event handlers
  // ---------------------------------------------------------------------------

  on<K extends keyof EventHandlers>(event: K, handler: EventHandlers[K][number]): void {
    (this.handlers[event] as unknown[]).push(handler);
  }

  off<K extends keyof EventHandlers>(event: K, handler: EventHandlers[K][number]): void {
    const list = this.handlers[event] as unknown[];
    const idx = list.indexOf(handler);
    if (idx >= 0) list.splice(idx, 1);
  }

  private emit<K extends keyof EventHandlers>(event: K, data: Parameters<EventHandlers[K][number]>[0]): void {
    for (const handler of this.handlers[event]) {
      try {
        (handler as (d: unknown) => void)(data);
      } catch (err) {
        log.error('Handler error', { event, err: String(err) });
      }
    }
  }

  // ---------------------------------------------------------------------------
  // Connection
  // ---------------------------------------------------------------------------

  connect(): void {
    if (this.state === 'connected' || this.state === 'connecting') return;

    this.state = 'connecting';
    const wsUrl = WS_URLS[this.config.environment];

    const timestampMs = Date.now().toString();
    const path = '/trade-api/ws/v2';
    const signature = signRequest('GET', path, timestampMs, this.config.privateKey);

    log.info('Connecting', { env: this.config.environment });

    this.ws = new WebSocket(wsUrl, {
      headers: {
        'KALSHI-ACCESS-KEY': this.config.apiKeyId,
        'KALSHI-ACCESS-SIGNATURE': signature,
        'KALSHI-ACCESS-TIMESTAMP': timestampMs,
      },
    });

    this.ws.on('open', () => {
      this.state = 'connected';
      this.reconnectAttempt = 0;
      log.info('Connected');
      this.emit('connected', undefined as unknown as void);

      // Send any pending subscriptions
      for (const sub of this.pendingSubs) {
        this.sendCmd('subscribe', sub);
      }
      this.pendingSubs = [];

      // Start keepalive ping
      this.pingInterval = setInterval(() => {
        if (this.ws?.readyState === WebSocket.OPEN) {
          this.ws.ping();
        }
      }, 30000);
    });

    this.ws.on('message', (raw: WebSocket.Data) => {
      try {
        const msg = JSON.parse(raw.toString());
        this.handleMessage(msg);
      } catch (err) {
        log.warn('Failed to parse message', { err: String(err) });
      }
    });

    this.ws.on('close', (code: number, reason: Buffer) => {
      const reasonStr = reason.toString() || `code=${code}`;
      log.warn('Disconnected', { code, reason: reasonStr });
      this.cleanup();
      this.state = 'disconnected';
      this.emit('disconnected', { reason: reasonStr });
      this.scheduleReconnect();
    });

    this.ws.on('error', (err: Error) => {
      log.error('WebSocket error', { msg: err.message });
      this.emit('error', { error: err });
    });
  }

  disconnect(): void {
    this.state = 'disconnected';
    this.reconnectAttempt = -1;
    this.cleanup();
    if (this.ws) {
      this.ws.close(1000, 'Client disconnect');
      this.ws = null;
    }
    log.info('Disconnected by client');
  }

  private cleanup(): void {
    if (this.pingInterval) {
      clearInterval(this.pingInterval);
      this.pingInterval = null;
    }
  }

  private scheduleReconnect(): void {
    if (this.reconnectAttempt < 0) return;
    this.state = 'reconnecting';
    const delay = Math.min(1000 * 2 ** this.reconnectAttempt, this.maxReconnectDelay);
    this.reconnectAttempt++;
    log.info('Reconnecting', { attempt: this.reconnectAttempt, delayMs: delay });
    setTimeout(() => this.connect(), delay);
  }

  // ---------------------------------------------------------------------------
  // Send command (Kalshi WS protocol: { id, cmd, params })
  // ---------------------------------------------------------------------------

  private sendCmd(cmd: string, params: Record<string, unknown>): void {
    if (this.ws?.readyState !== WebSocket.OPEN) return;
    this.msgId++;
    const msg = { id: this.msgId, cmd, params };
    this.ws.send(JSON.stringify(msg));
    log.debug('Sent', { cmd, params });
  }

  // ---------------------------------------------------------------------------
  // Subscriptions
  // ---------------------------------------------------------------------------

  subscribeTicker(tickers: string[]): void {
    const sub = { channels: ['ticker'], market_tickers: tickers };
    if (this.state === 'connected') {
      this.sendCmd('subscribe', sub);
    } else {
      this.pendingSubs.push(sub);
    }
  }

  subscribeOrderbook(tickers: string[]): void {
    const sub = { channels: ['orderbook_delta'], market_tickers: tickers };
    if (this.state === 'connected') {
      this.sendCmd('subscribe', sub);
    } else {
      this.pendingSubs.push(sub);
    }
  }

  subscribeTrades(tickers: string[]): void {
    const sub = { channels: ['trade'], market_tickers: tickers };
    if (this.state === 'connected') {
      this.sendCmd('subscribe', sub);
    } else {
      this.pendingSubs.push(sub);
    }
  }

  subscribeFills(): void {
    const sub = { channels: ['fill'] };
    if (this.state === 'connected') {
      this.sendCmd('subscribe', sub);
    } else {
      this.pendingSubs.push(sub);
    }
  }

  subscribeOrders(): void {
    const sub = { channels: ['order_group_updates'] };
    if (this.state === 'connected') {
      this.sendCmd('subscribe', sub);
    } else {
      this.pendingSubs.push(sub);
    }
  }

  subscribeBalance(): void {
    const sub = { channels: ['market_positions'] };
    if (this.state === 'connected') {
      this.sendCmd('subscribe', sub);
    } else {
      this.pendingSubs.push(sub);
    }
  }

  unsubscribe(channels: string[], tickers?: string[]): void {
    const params: Record<string, unknown> = { channels };
    if (tickers) params.market_tickers = tickers;
    this.sendCmd('unsubscribe', params);
  }

  // ---------------------------------------------------------------------------
  // Message routing
  // ---------------------------------------------------------------------------

  private handleMessage(msg: Record<string, unknown>): void {
    // Emit raw for debugging
    this.emit('raw', msg);

    const type = msg.type as string | undefined;

    // Some messages come as { sid, msg: { ... } } wrapper
    const inner = (msg.msg as Record<string, unknown>) || msg;
    const innerType = (inner.type as string) || type;

    if (!innerType) {
      // Could be a command response: { id, ... }
      if (msg.id !== undefined) {
        if (msg.error) {
          log.warn('Command error', { id: msg.id, error: msg.error });
        }
        return;
      }
      log.debug('Untyped message', { keys: Object.keys(msg).join(',') });
      return;
    }

    switch (innerType) {
      case 'ticker':
        this.emit('ticker', {
          ticker: (inner.market_ticker ?? inner.ticker) as string,
          yes_bid: (inner.yes_bid ?? 0) as number,
          yes_ask: (inner.yes_ask ?? 0) as number,
          no_bid: (inner.no_bid ?? 0) as number,
          no_ask: (inner.no_ask ?? 0) as number,
          last_price: (inner.last_price ?? inner.yes_price ?? 0) as number,
          volume: (inner.volume ?? inner.volume_24h ?? 0) as number,
          open_interest: (inner.open_interest ?? 0) as number,
          ts: (inner.ts ?? new Date().toISOString()) as string,
        });
        break;

      case 'trade':
        this.emit('trade', {
          ticker: (inner.market_ticker ?? inner.ticker) as string,
          trade_id: (inner.trade_id ?? '') as string,
          side: (inner.side ?? 'yes') as 'yes' | 'no',
          price: (inner.yes_price ?? inner.price ?? 0) as number,
          count: (inner.count ?? 0) as number,
          taker_side: (inner.taker_side ?? 'buy') as 'buy' | 'sell',
          ts: (inner.ts ?? inner.created_time ?? new Date().toISOString()) as string,
        });
        break;

      case 'orderbook_snapshot':
      case 'orderbook_delta':
        this.emit('orderbook', {
          ticker: (inner.market_ticker ?? inner.ticker) as string,
          yes: (inner.yes ?? []) as OrderbookLevel[][],
          no: (inner.no ?? []) as OrderbookLevel[][],
        });
        break;

      case 'fill':
        this.emit('fill', {
          fill_id: (inner.fill_id ?? '') as string,
          order_id: (inner.order_id ?? '') as string,
          ticker: (inner.market_ticker ?? inner.ticker ?? '') as string,
          side: (inner.side ?? 'yes') as 'yes' | 'no',
          action: (inner.action ?? 'buy') as 'buy' | 'sell',
          count: (inner.count ?? 0) as number,
          price: (inner.yes_price ?? inner.price ?? 0) as number,
          fee: (inner.fee ?? 0) as number,
          is_taker: (inner.is_taker ?? false) as boolean,
          ts: (inner.ts ?? new Date().toISOString()) as string,
        });
        break;

      case 'order_group_updates':
        this.emit('order_update', {
          order_id: (inner.order_id ?? '') as string,
          ticker: (inner.market_ticker ?? inner.ticker ?? '') as string,
          side: (inner.side ?? 'yes') as 'yes' | 'no',
          action: (inner.action ?? 'buy') as 'buy' | 'sell',
          type: (inner.order_type ?? inner.type ?? 'limit') as 'limit' | 'market',
          status: (inner.status ?? '') as string,
          yes_price: (inner.yes_price ?? 0) as number,
          no_price: (inner.no_price ?? 0) as number,
          remaining_count: (inner.remaining_count ?? 0) as number,
          filled_count: (inner.filled_count ?? 0) as number,
          ts: (inner.ts ?? new Date().toISOString()) as string,
        });
        break;

      case 'market_positions':
        // Position updates can also carry balance info
        log.debug('Position update', { ticker: inner.market_ticker });
        break;

      case 'subscribed':
        log.info('Subscribed', { channel: inner.channel ?? (msg.msg as Record<string, unknown>)?.channel });
        break;

      case 'unsubscribed':
        log.info('Unsubscribed', { channel: inner.channel ?? (msg.msg as Record<string, unknown>)?.channel });
        break;

      case 'error':
        log.error('Server error', { code: inner.code, msg: inner.message ?? inner.msg });
        break;

      default:
        log.debug('Unknown type', { type: innerType });
    }
  }
}
