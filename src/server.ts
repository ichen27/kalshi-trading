/**
 * Dashboard HTTP Server
 *
 * Built-in HTTP server using Node's native `http` module (zero dependencies).
 * Serves a single-page dashboard with live updates via Server-Sent Events (SSE).
 * Provides REST API endpoints for an external cron agent to execute trades.
 */

import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { createLogger } from './utils/logger.js';
import { reloadStrategies } from './engine/strategy-loader.js';
import type { KalshiClient } from './api/client.js';
import type { StrategyAllocator } from './engine/allocator.js';
import type { KalshiWebSocket, TickerUpdate, TradeUpdate, FillUpdate, OrderUpdate, BalanceUpdate, OrderbookSnapshot } from './api/websocket.js';

const log = createLogger('HTTP');

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

interface ServerDeps {
  client: KalshiClient;
  allocator: StrategyAllocator;
  ws: KalshiWebSocket;
  strategiesFile?: string;
}

// Active SSE connections
const sseClients = new Set<http.ServerResponse>();

function broadcastSSE(event: string, data: unknown): void {
  const payload = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
  for (const res of sseClients) {
    try {
      res.write(payload);
    } catch {
      sseClients.delete(res);
    }
  }
}

function json(res: http.ServerResponse, data: unknown, status = 200): void {
  res.writeHead(status, {
    'Content-Type': 'application/json',
    'Access-Control-Allow-Origin': '*',
  });
  res.end(JSON.stringify(data));
}

function notFound(res: http.ServerResponse): void {
  res.writeHead(404, { 'Content-Type': 'text/plain' });
  res.end('Not Found');
}

function readBody(req: http.IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => chunks.push(chunk));
    req.on('end', () => resolve(Buffer.concat(chunks).toString()));
    req.on('error', reject);
  });
}

export function startServer(deps: ServerDeps): http.Server {
  const { client, allocator, ws, strategiesFile } = deps;
  const port = parseInt(process.env.PORT || '3456', 10);

  // Wire up WebSocket events to SSE broadcast
  ws.on('ticker', (update: TickerUpdate) => broadcastSSE('ticker', update));
  ws.on('trade', (update: TradeUpdate) => broadcastSSE('trade', update));
  ws.on('orderbook', (snapshot: OrderbookSnapshot) => broadcastSSE('orderbook', snapshot));
  ws.on('fill', (fill: FillUpdate) => broadcastSSE('fill', fill));
  ws.on('order_update', (update: OrderUpdate) => broadcastSSE('order_update', update));
  ws.on('balance', (update: BalanceUpdate) => broadcastSSE('balance', update));

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url || '/', `http://localhost:${port}`);
    const pathname = url.pathname;
    const method = req.method || 'GET';

    try {
      // --- Execution API: single strategy ---
      const strategyMatch = pathname.match(/^\/api\/strategies\/([^/]+)$/);
      if (strategyMatch && method === 'GET') {
        const id = strategyMatch[1];
        if (!allocator.hasStrategy(id)) {
          json(res, { error: `Strategy '${id}' not found` }, 404);
          return;
        }
        const config = allocator.getConfig(id);
        const state = allocator.getState(id);
        const orders = allocator.getOrdersByStrategy(id);
        json(res, {
          config,
          state: {
            ...state,
            positions: [...state.positions.values()],
          },
          openOrders: orders,
        });
        return;
      }

      // --- Execution API: place order for strategy ---
      const orderMatch = pathname.match(/^\/api\/strategies\/([^/]+)\/orders$/);
      if (orderMatch && method === 'POST') {
        const strategyId = orderMatch[1];
        if (!allocator.hasStrategy(strategyId)) {
          json(res, { error: `Strategy '${strategyId}' not found` }, 404);
          return;
        }

        const body = JSON.parse(await readBody(req));
        const { ticker, side, action, type, count, price } = body;

        if (!ticker || !side || !action || !type || !count || price === undefined) {
          json(res, { error: 'Missing required fields: ticker, side, action, type, count, price' }, 400);
          return;
        }

        const orderId = randomUUID();
        const trackedOrder = {
          orderId,
          strategyId,
          ticker,
          side,
          action,
          count,
          price,
          status: 'pending',
          createdAt: new Date(),
        };

        const reserved = allocator.reserveForOrder(strategyId, trackedOrder);
        if (!reserved) {
          json(res, { error: 'Insufficient funds for this strategy' }, 400);
          return;
        }

        try {
          const apiOrder = await client.createOrder({
            ticker,
            side,
            action,
            type,
            count,
            ...(side === 'yes' ? { yes_price: price } : { no_price: price }),
          });
          json(res, { order: apiOrder.order, trackedOrderId: orderId }, 201);
        } catch (err) {
          // Release reservation on API failure
          allocator.onOrderCancelled(orderId);
          json(res, { error: (err as Error).message }, 502);
        }
        return;
      }

      // --- Execution API: cancel order ---
      const cancelMatch = pathname.match(/^\/api\/orders\/([^/]+)$/);
      if (cancelMatch && method === 'DELETE') {
        const orderId = cancelMatch[1];
        try {
          const result = await client.cancelOrder(orderId);
          allocator.onOrderCancelled(orderId);
          json(res, { order: result.order });
        } catch (err) {
          json(res, { error: (err as Error).message }, 502);
        }
        return;
      }

      // --- Execution API: single market ---
      const marketMatch = pathname.match(/^\/api\/markets\/([^/]+)$/);
      if (marketMatch && method === 'GET') {
        const ticker = marketMatch[1];
        try {
          const result = await client.getMarket(ticker);
          json(res, result);
        } catch (err) {
          json(res, { error: (err as Error).message }, 502);
        }
        return;
      }

      // --- Execution API: force reload strategies ---
      if (pathname === '/api/strategies/reload' && method === 'POST') {
        if (!strategiesFile) {
          json(res, { error: 'No strategies file configured' }, 400);
          return;
        }
        try {
          reloadStrategies(allocator, strategiesFile);
          json(res, { ok: true, strategies: allocator.getAllStrategies() });
        } catch (err) {
          json(res, { error: (err as Error).message }, 500);
        }
        return;
      }

      // --- Existing REST API ---
      if (pathname === '/api/portfolio' && method === 'GET') {
        const [balanceData, positionsData] = await Promise.all([
          client.getBalance(),
          client.getPositions(),
        ]);

        // Filter to non-zero positions only
        const active = positionsData.market_positions.filter(p => p.position !== 0);

        // Enrich with market title and bet side
        const enriched = await Promise.all(
          active.map(async (p) => {
            try {
              const { market } = await client.getMarket(p.ticker);
              return {
                ...p,
                title: market.title,
                side: p.position > 0 ? 'yes' as const : 'no' as const,
              };
            } catch {
              return { ...p, title: p.ticker, side: p.position > 0 ? 'yes' as const : 'no' as const };
            }
          })
        );

        json(res, {
          balance: balanceData.balance,
          portfolio_value: balanceData.portfolio_value,
          positions: enriched,
        });
        return;
      }

      if (pathname === '/api/strategies' && method === 'GET') {
        const snapshot = allocator.getSnapshot();
        json(res, snapshot);
        return;
      }

      if (pathname === '/api/markets' && method === 'GET') {
        const { markets } = await client.getMarkets({ limit: 100, status: 'open' });
        json(res, { markets });
        return;
      }

      // --- SSE Stream ---
      if (pathname === '/api/stream') {
        res.writeHead(200, {
          'Content-Type': 'text/event-stream',
          'Cache-Control': 'no-cache',
          'Connection': 'keep-alive',
          'Access-Control-Allow-Origin': '*',
        });
        res.write(':\n\n'); // comment to flush headers
        sseClients.add(res);
        req.on('close', () => sseClients.delete(res));
        return;
      }

      // --- Static: serve dashboard.html ---
      if (pathname === '/' || pathname === '/index.html') {
        const htmlPath = path.join(__dirname, 'ui', 'dashboard.html');
        try {
          const html = fs.readFileSync(htmlPath, 'utf-8');
          res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
          res.end(html);
        } catch {
          res.writeHead(500, { 'Content-Type': 'text/plain' });
          res.end('Dashboard file not found');
        }
        return;
      }

      notFound(res);
    } catch (err) {
      log.error('Request error', { path: pathname, msg: (err as Error).message });
      json(res, { error: (err as Error).message }, 500);
    }
  });

  server.listen(port, () => {
    log.info(`Dashboard: http://localhost:${port}`);

    // Auto-open browser (macOS). Non-blocking, fails silently.
    const dashboardUrl = `http://localhost:${port}`;
    execFile('open', [dashboardUrl], (err) => {
      if (err) log.debug('Could not auto-open browser', { msg: err.message });
    });
  });

  return server;
}
