const COLORS = {
  reset: '\x1b[0m',
  dim: '\x1b[2m',
  red: '\x1b[31m',
  green: '\x1b[32m',
  yellow: '\x1b[33m',
  blue: '\x1b[34m',
  cyan: '\x1b[36m',
  white: '\x1b[37m',
};

type LogLevel = 'debug' | 'info' | 'warn' | 'error';

const LEVEL_CONFIG: Record<LogLevel, { color: string; label: string; priority: number }> = {
  debug: { color: COLORS.dim, label: 'DBG', priority: 0 },
  info: { color: COLORS.cyan, label: 'INF', priority: 1 },
  warn: { color: COLORS.yellow, label: 'WRN', priority: 2 },
  error: { color: COLORS.red, label: 'ERR', priority: 3 },
};

let minLevel: LogLevel = 'info';

export function setLogLevel(level: LogLevel) {
  minLevel = level;
}

function timestamp(): string {
  return new Date().toISOString().slice(11, 23);
}

function log(level: LogLevel, tag: string, msg: string, data?: Record<string, unknown>) {
  const cfg = LEVEL_CONFIG[level];
  if (cfg.priority < LEVEL_CONFIG[minLevel].priority) return;

  const parts = [
    `${COLORS.dim}${timestamp()}${COLORS.reset}`,
    `${cfg.color}${cfg.label}${COLORS.reset}`,
    `${COLORS.white}[${tag}]${COLORS.reset}`,
    msg,
  ];

  if (data && Object.keys(data).length > 0) {
    const formatted = Object.entries(data)
      .map(([k, v]) => `${k}=${typeof v === 'object' ? JSON.stringify(v) : v}`)
      .join(' ');
    parts.push(`${COLORS.dim}${formatted}${COLORS.reset}`);
  }

  console.log(parts.join(' '));
}

export function createLogger(tag: string) {
  return {
    debug: (msg: string, data?: Record<string, unknown>) => log('debug', tag, msg, data),
    info: (msg: string, data?: Record<string, unknown>) => log('info', tag, msg, data),
    warn: (msg: string, data?: Record<string, unknown>) => log('warn', tag, msg, data),
    error: (msg: string, data?: Record<string, unknown>) => log('error', tag, msg, data),
  };
}
