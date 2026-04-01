/**
 * Structured JSON logger for the DLMM exit crank.
 *
 * Outputs one JSON object per line to stdout/stderr with:
 *   ts, level, module, msg, and optional contextual fields.
 *
 * Usage:
 *   const log = createLogger("monitor");
 *   log.info("Found exits", { count: 3 });
 *   log.error("RPC failed", { error: err.message, exitPda: "abc..." });
 */

export type LogLevel = "info" | "warn" | "error";

export interface LogEntry {
  ts: string;
  level: LogLevel;
  module: string;
  msg: string;
  [key: string]: unknown;
}

export interface Logger {
  info(msg: string, extra?: Record<string, unknown>): void;
  warn(msg: string, extra?: Record<string, unknown>): void;
  error(msg: string, extra?: Record<string, unknown>): void;
}

/**
 * Create a logger bound to a module name.
 *
 * @param module - Module name (e.g. "monitor", "emergency", "crank")
 * @param writer - Optional writer function for testing (defaults to process.stdout/stderr)
 */
export function createLogger(
  module: string,
  writer?: (line: string, level: LogLevel) => void
): Logger {
  const write =
    writer ??
    ((line: string, level: LogLevel) => {
      if (level === "error") {
        process.stderr.write(line + "\n");
      } else {
        process.stdout.write(line + "\n");
      }
    });

  function emit(level: LogLevel, msg: string, extra?: Record<string, unknown>): void {
    const entry: LogEntry = {
      ts: new Date().toISOString(),
      level,
      module,
      msg,
      ...extra,
    };
    write(JSON.stringify(entry), level);
  }

  return {
    info: (msg, extra?) => emit("info", msg, extra),
    warn: (msg, extra?) => emit("warn", msg, extra),
    error: (msg, extra?) => emit("error", msg, extra),
  };
}
