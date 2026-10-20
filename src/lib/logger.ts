type Level = "debug" | "info" | "warn" | "error";

const SECRET_KEYS = /token|secret|password|authorization|api[_-]?key|cookie/i;
const SECRET_VALUES = /(sk-[A-Za-z0-9_-]{8,}|EAA[A-Za-z0-9]{10,})/g;

function redact(value: unknown, depth = 0): unknown {
  if (depth > 6) return "[depth]";
  if (typeof value === "string") return value.replace(SECRET_VALUES, "[redacted]");
  if (value instanceof Error) return { name: value.name, message: redact(value.message), stack: value.stack };
  if (Array.isArray(value)) return value.map((v) => redact(v, depth + 1));
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value).map(([k, v]) => [k, SECRET_KEYS.test(k) ? "[redacted]" : redact(v, depth + 1)]),
    );
  }
  return value;
}

function write(level: Level, msg: string, fields: Record<string, unknown> = {}): void {
  if (process.env.LOG_SILENT === "true") return;
  const line = JSON.stringify({ ts: new Date().toISOString(), level, msg, ...(redact(fields) as object) });
  if (level === "error" || level === "warn") process.stderr.write(line + "\n");
  else process.stdout.write(line + "\n");
}

/** Structured JSON logger. Secrets are redacted by key name and by value shape. */
export const log = {
  debug: (msg: string, fields?: Record<string, unknown>) => write("debug", msg, fields),
  info: (msg: string, fields?: Record<string, unknown>) => write("info", msg, fields),
  warn: (msg: string, fields?: Record<string, unknown>) => write("warn", msg, fields),
  error: (msg: string, fields?: Record<string, unknown>) => write("error", msg, fields),
};

export { redact };
