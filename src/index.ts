/**
 * Kalshi Trading System - Entry Point
 *
 * Boots the API client, WebSocket feed, and strategy allocator.
 * Demonstrates the modular foundation: each strategy gets allocated cash
 * and independent state tracking.
 */

import 'dotenv/config';
import { KalshiClient } from './api/client.js';
import { KalshiWebSocket } from './api/websocket.js';
import { StrategyAllocator } from './engine/allocator.js';
import { loadStrategies, watchStrategies } from './engine/strategy-loader.js';
import { createLogger, setLogLevel } from './utils/logger.js';
import { startServer } from './server.js';

const STRATEGIES_FILE = './strategies.json';

const log = createLogger('MAIN');

// =============================================================================
// Config from env
// =============================================================================

function loadConfig() {
  const apiKeyId = process.env.KALSHI_API_KEY_ID?.trim();
  const privateKey = process.env.KALSHI_API_PRIVATE_KEY?.trim();
  const env = (process.env.KALSHI_ENV?.trim() || 'demo') as 'demo' | 'production';

  if (!apiKeyId || !privateKey) {
    log.error('Missing KALSHI_API_KEY_ID or KALSHI_API_PRIVATE_KEY in .env');
    process.exit(1);
  }

  return { apiKeyId, privateKey, environment: env };
}

// =============================================================================
// Main
// =============================================================================

async function main() {
  setLogLevel('debug');
  log.info('=== Kalshi Trading System ===');

  const config = loadConfig();
  log.info('Config loaded', { env: config.environment });

  // --- REST Client ---
  const client = new KalshiClient(config);

  // --- Fetch balance & initialize allocator ---
  log.info('Fetching account balance...');
  const { balance, portfolio_value } = await client.getBalance();
  log.info('Account', { balance: `$${(balance / 100).toFixed(2)}`, portfolio: `$${(portfolio_value / 100).toFixed(2)}` });

  const allocator = new StrategyAllocator(balance);

  // --- Load strategies from config file + watch for changes ---
  loadStrategies(allocator, STRATEGIES_FILE);
  watchStrategies(allocator, STRATEGIES_FILE);

  // --- Print allocation snapshot ---
  const snap = allocator.getSnapshot();
  log.info('--- Allocation Snapshot ---');
  log.info(`Total cash: $${(snap.totalCash / 100).toFixed(2)}`);
  log.info(`Unallocated (reserve): $${(snap.unallocatedCash / 100).toFixed(2)} (${((snap.unallocatedCash / snap.totalCash) * 100).toFixed(1)}%)`);
  for (const s of snap.strategies) {
    log.info(`  [${s.id}] ${s.name}: $${(s.allocatedCash / 100).toFixed(2)} (${(s.allocationPct * 100).toFixed(0)}%) | avail: $${(s.availableCash / 100).toFixed(2)}`);
  }

  // --- Fetch current positions ---
  log.info('Fetching positions...');
  const { market_positions } = await client.getPositions();
  if (market_positions.length === 0) {
    log.info('No open positions');
  } else {
    for (const p of market_positions) {
      log.info(`  Position: ${p.ticker} qty=${p.position} exposure=${p.market_exposure} pnl=${p.realized_pnl}`);
    }
  }

  // --- Fetch some active markets (with volume) ---
  log.info('Fetching markets...');
  const { markets: allMarkets } = await client.getMarkets({ limit: 100, status: 'open' });
  // Filter to markets that actually have bids/asks (active trading)
  const activeMarkets = allMarkets.filter(m => m.yes_bid > 0 || m.yes_ask > 0);
  const markets = activeMarkets.length > 0 ? activeMarkets : allMarkets;
  log.info(`Got ${allMarkets.length} markets, ${activeMarkets.length} with active quotes`);
  for (const m of markets.slice(0, 5)) {
    log.info(`  ${m.ticker}: "${m.title.slice(0, 60)}" yes=${m.yes_bid}/${m.yes_ask} vol=${m.volume_24h}`);
  }

  // --- WebSocket: live market data ---
  const ws = new KalshiWebSocket(config);

  ws.on('connected', () => {
    log.info('WebSocket connected - subscribing to live data');

    // Subscribe to all live channels for the first few markets
    const tickers = markets.slice(0, 10).map(m => m.ticker);
    if (tickers.length > 0) {
      ws.subscribeTicker(tickers);
      ws.subscribeTrades(tickers);
      ws.subscribeOrderbook(tickers);
      log.info('Subscribed to tickers, trades, orderbook', { tickers });
    }

    // Subscribe to authenticated channels
    ws.subscribeFills();
    ws.subscribeOrders();
    ws.subscribeBalance();
    log.info('Subscribed to fills, orders, balance');
  });

  ws.on('ticker', (update) => {
    log.info(`TICK ${update.ticker}: yes=${update.yes_bid}/${update.yes_ask} last=${update.last_price}`);

    // Update allocator prices for unrealized P&L tracking
    allocator.updatePrice(update.ticker, update.yes_bid);
  });

  ws.on('fill', (fill) => {
    log.info(`FILL ${fill.ticker}: ${fill.action} ${fill.count}x ${fill.side} @ ${fill.price}c fee=${fill.fee}c`);
  });

  ws.on('order_update', (update) => {
    log.info(`ORDER ${update.order_id}: ${update.status} ${update.ticker} filled=${update.filled_count} remain=${update.remaining_count}`);
  });

  ws.on('balance', (update) => {
    log.info(`BALANCE: $${(update.balance / 100).toFixed(2)} portfolio=$${(update.portfolio_value / 100).toFixed(2)}`);
    allocator.updateTotalCash(update.balance);
  });

  ws.on('disconnected', ({ reason }) => {
    log.warn('WebSocket disconnected', { reason });
  });

  ws.on('error', ({ error }) => {
    log.error('WebSocket error', { msg: error.message });
  });

  ws.connect();

  // --- Dashboard server ---
  const server = startServer({ client, allocator, ws, strategiesFile: STRATEGIES_FILE });

  // --- Graceful shutdown ---
  const shutdown = () => {
    log.info('Shutting down...');
    server.close();
    ws.disconnect();
    process.exit(0);
  };

  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);

  log.info('System running. Press Ctrl+C to stop.');
  log.info('---');
  log.info('Available operations (import from api/client):');
  log.info('  client.buy(ticker, side, count, limitPrice?)');
  log.info('  client.sell(ticker, side, count, limitPrice?)');
  log.info('  client.getMarkets(), client.getBalance(), client.getPositions()');
  log.info('  client.createOrder(), client.cancelOrder()');
  log.info('---');

  // Keep process alive
  await new Promise(() => {});
}

main().catch(err => {
  log.error('Fatal error', { msg: err.message, stack: err.stack });
  process.exit(1);
});
