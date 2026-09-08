import type { Logger as PinoLogger } from 'pino';
import { getProcessLogger, loggerGeneration } from './internal/logger-state.js';

/**
 * The facade's logger surface: the pino-compatible subset modules may use. Levels per ADR-0009 —
 * `fatal` process-fatal, `error` boundary-handled failure, `warn` degraded, `info`
 * lifecycle/business, `debug` dev diagnosis. No `trace` level, deliberately.
 */
export interface Logger {
  fatal(obj: object, msg: string): void;
  fatal(msg: string): void;
  error(obj: object, msg: string): void;
  error(msg: string): void;
  warn(obj: object, msg: string): void;
  warn(msg: string): void;
  info(obj: object, msg: string): void;
  info(msg: string): void;
  debug(obj: object, msg: string): void;
  debug(msg: string): void;
  child(bindings: object): Logger;
}

type Level = 'fatal' | 'error' | 'warn' | 'info' | 'debug';

/**
 * A logger that re-resolves its underlying pino child whenever the process logger is replaced
 * (`initObservability` runs after module construction in the boot order) — modules never handle
 * "logger not ready".
 */
class LazyBoundLogger implements Logger {
  private cached: PinoLogger | undefined;
  private cachedGeneration = -1;

  constructor(private readonly bindings: object) {}

  private resolve(): PinoLogger {
    const generation = loggerGeneration();
    if (this.cached === undefined || this.cachedGeneration !== generation) {
      this.cached = getProcessLogger().child(this.bindings);
      this.cachedGeneration = generation;
    }
    return this.cached;
  }

  private emit(level: Level, objOrMsg: object | string, msg?: string): void {
    const logger = this.resolve();
    if (typeof objOrMsg === 'string') {
      logger[level](objOrMsg);
    } else {
      logger[level](objOrMsg, msg);
    }
  }

  fatal(objOrMsg: object | string, msg?: string): void {
    this.emit('fatal', objOrMsg, msg);
  }
  error(objOrMsg: object | string, msg?: string): void {
    this.emit('error', objOrMsg, msg);
  }
  warn(objOrMsg: object | string, msg?: string): void {
    this.emit('warn', objOrMsg, msg);
  }
  info(objOrMsg: object | string, msg?: string): void {
    this.emit('info', objOrMsg, msg);
  }
  debug(objOrMsg: object | string, msg?: string): void {
    this.emit('debug', objOrMsg, msg);
  }

  child(bindings: object): Logger {
    return new LazyBoundLogger({ ...this.bindings, ...bindings });
  }
}

/** @internal Used by `createModuleObservability`; not part of the module-facing surface. */
export function createModuleLogger(moduleName: string): Logger {
  return new LazyBoundLogger({ module: moduleName });
}
