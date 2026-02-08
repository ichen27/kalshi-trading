/**
 * Strategy Loader
 *
 * Reads strategy definitions from a JSON file and syncs them into the allocator.
 * Watches the file for changes and hot-reloads: adds new strategies, removes
 * deleted ones (if safe), and updates allocations/config for changed ones.
 */

import fs from 'node:fs';
import path from 'node:path';
import { createLogger } from '../utils/logger.js';
import type { StrategyAllocator } from './allocator.js';
import type { StrategyConfig } from './types.js';

const log = createLogger('LOADER');

function readStrategiesFile(filePath: string): StrategyConfig[] {
  const raw = fs.readFileSync(filePath, 'utf-8');
  const parsed = JSON.parse(raw);
  if (!Array.isArray(parsed)) {
    throw new Error('strategies.json must be a JSON array');
  }
  return parsed as StrategyConfig[];
}

export function loadStrategies(allocator: StrategyAllocator, filePath: string): void {
  const resolved = path.resolve(filePath);
  log.info('Loading strategies', { file: resolved });

  const strategies = readStrategiesFile(resolved);

  for (const config of strategies) {
    if (allocator.hasStrategy(config.id)) {
      log.warn('Strategy already loaded, skipping', { id: config.id });
      continue;
    }
    allocator.addStrategy(config);
  }

  log.info('Strategies loaded', { count: strategies.length });
}

export function reloadStrategies(allocator: StrategyAllocator, filePath: string): void {
  const resolved = path.resolve(filePath);
  log.info('Reloading strategies', { file: resolved });

  const newConfigs = readStrategiesFile(resolved);
  const newIds = new Set(newConfigs.map(c => c.id));
  const currentConfigs = allocator.getAllStrategies();
  const currentIds = new Set(currentConfigs.map(c => c.id));

  // Add new strategies
  for (const config of newConfigs) {
    if (!currentIds.has(config.id)) {
      log.info('Adding new strategy', { id: config.id });
      allocator.addStrategy(config);
    }
  }

  // Remove deleted strategies (only if safe)
  for (const existing of currentConfigs) {
    if (!newIds.has(existing.id)) {
      try {
        allocator.removeStrategy(existing.id);
        log.info('Removed strategy', { id: existing.id });
      } catch (err) {
        log.warn('Cannot remove strategy (has positions/orders)', {
          id: existing.id,
          reason: (err as Error).message,
        });
      }
    }
  }

  // Update changed strategies
  for (const config of newConfigs) {
    if (!currentIds.has(config.id)) continue; // already added above

    const current = allocator.getConfig(config.id);

    // Check allocation change
    if (Math.abs(current.allocationPct - config.allocationPct) > 0.0001) {
      allocator.reallocate(config.id, config.allocationPct);
    }

    // Check config field changes
    const changes: Partial<Pick<StrategyConfig, 'enabled' | 'params' | 'name' | 'type'>> = {};
    if (current.enabled !== config.enabled) changes.enabled = config.enabled;
    if (current.name !== config.name) changes.name = config.name;
    if (current.type !== config.type) changes.type = config.type;
    if (JSON.stringify(current.params) !== JSON.stringify(config.params)) changes.params = config.params;

    if (Object.keys(changes).length > 0) {
      allocator.updateStrategyConfig(config.id, changes);
    }
  }

  log.info('Strategies reloaded');
}

export function watchStrategies(allocator: StrategyAllocator, filePath: string): fs.FSWatcher {
  const resolved = path.resolve(filePath);
  log.info('Watching strategies file', { file: resolved });

  let debounceTimer: ReturnType<typeof setTimeout> | null = null;

  const watcher = fs.watch(resolved, (eventType) => {
    if (eventType !== 'change') return;

    // Debounce: fs.watch fires multiple events per save
    if (debounceTimer) clearTimeout(debounceTimer);
    debounceTimer = setTimeout(() => {
      try {
        reloadStrategies(allocator, resolved);
      } catch (err) {
        log.error('Failed to reload strategies', { msg: (err as Error).message });
      }
    }, 300);
  });

  return watcher;
}
