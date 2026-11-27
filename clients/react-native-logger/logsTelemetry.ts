// Ships structured logs from the React Native app to the gateway (POST /loki/api/v1/push).
// Field names are PascalCase and must match docs/log-format.md and the dashboards.

export type LogLevel = "info" | "warning" | "error";

export interface LogStorage {
  getItem(key: string): Promise<string | null>;
  setItem(key: string, value: string): Promise<void>;
  removeItem(key: string): Promise<void>;
}

export interface LoggerConfig {
  /** Gateway base URL, e.g. "http://localhost:8081". */
  baseUrl: string;
  /** Sent as the X-API-Key header. */
  apiKey: string;
  /** Loki `app` label and `Service` field, e.g. "miicel-mobile". */
  service: string;
  /** Wait before sending queued info/warning lines. 0 = send every line at once. Default 3000. */
  batchIntervalMs?: number;
  /** Max lines kept in memory while offline; oldest are dropped. Default 200. */
  maxQueue?: number;
  /** Optional (AsyncStorage-like). Lets a fatal crash survive until the next launch. */
  storage?: LogStorage;
  /** Fields added to every line (version, platform, env...). Evaluated per line. */
  getContext?: () => Record<string, string | number | boolean | null | undefined>;
}

export interface LogFields {
  userId?: string;
  /** Groups all lines of one session/operation. */
  correlationId?: string;
  /** Step/screen/flow where it happened. */
  stage?: string;
  /** Machine-readable event name, e.g. "api.request", "app.crash". */
  event?: string;
  /** Business process, e.g. "auth", "loans". */
  flow?: string;
  /** Normalized API route (no host, query or ids). */
  endpoint?: string;
  /** HTTP status. */
  status?: number;
  durationMs?: number;
  /** Extra flat fields. */
  extra?: Record<string, string | number | boolean | null | undefined>;
}

interface Entry {
  level: LogLevel;
  ts: string; // unix ns
  line: string;
}

const PENDING_KEY = "logsTelemetry:pending";
const DEFAULT_BATCH_MS = 3000;
const DEFAULT_MAX_QUEUE = 200;
const BATCH_SIZE = 20;
const MAX_REASON = 300;
const MAX_STACK = 2000;

let config: LoggerConfig | null = null;
let queue: Entry[] = [];
let timer: ReturnType<typeof setTimeout> | null = null;
let seq = 0;

// Call once at app startup, before any log call. Also sends crashes saved by a previous run.
export function configureLogger(next: LoggerConfig): void {
  config = next;
  void restorePending();
}

const clip = (value: string, max: number) =>
  value.length > max ? `${value.slice(0, max)}...` : value;

function buildEntry(level: LogLevel, reason: string, fields: LogFields): Entry {
  if (!config) {
    throw new Error("logsTelemetry: configureLogger() must be called before logging anything.");
  }
  const context = config.getContext ? config.getContext() : {};
  const line: Record<string, unknown> = {
    Service: config.service,
    Reason: clip(reason, MAX_REASON),
    ...(fields.event !== undefined ? { Event: fields.event } : {}),
    ...(fields.flow !== undefined ? { Flow: fields.flow } : {}),
    ...(fields.userId !== undefined ? { UserId: fields.userId } : {}),
    ...(fields.correlationId !== undefined ? { CorrelationId: fields.correlationId } : {}),
    ...(fields.stage !== undefined ? { Stage: fields.stage } : {}),
    ...(fields.endpoint !== undefined ? { Endpoint: fields.endpoint } : {}),
    ...(fields.status !== undefined ? { Status: fields.status } : {}),
    ...(fields.durationMs !== undefined ? { DurationMs: fields.durationMs } : {}),
    ...context,
    ...(fields.extra ?? {}),
  };
  // Unique, increasing nanosecond timestamp (Loki keeps lines with different ts apart).
  seq = (seq + 1) % 1000;
  const ts = (BigInt(Date.now()) * 1_000_000n + BigInt(seq)).toString();
  return { level, ts, line: JSON.stringify(line) };
}

function buildPushBody(entries: Entry[]) {
  const byLevel = new Map<LogLevel, Entry[]>();
  for (const e of entries) {
    byLevel.set(e.level, [...(byLevel.get(e.level) ?? []), e]);
  }
  return {
    streams: [...byLevel.entries()].map(([level, list]) => ({
      stream: { app: config!.service, level },
      values: list.map((e) => [e.ts, e.line]),
    })),
  };
}

// POSTs entries; never throws. True if the gateway accepted them (204).
async function post(entries: Entry[]): Promise<boolean> {
  if (!config || entries.length === 0) return true;
  try {
    const response = await fetch(`${config.baseUrl}/loki/api/v1/push`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-API-Key": config.apiKey },
      body: JSON.stringify(buildPushBody(entries)),
    });
    return response.status === 204;
  } catch {
    // Logging must never crash the app.
    return false;
  }
}

// Sends everything queued. Lines that fail go back to the queue (capped).
export async function flushLogs(): Promise<boolean> {
  if (timer) {
    clearTimeout(timer);
    timer = null;
  }
  if (!config || queue.length === 0) return true;
  const batch = queue;
  queue = [];
  const ok = await post(batch);
  if (!ok) {
    queue = [...batch, ...queue].slice(-(config.maxQueue ?? DEFAULT_MAX_QUEUE));
  }
  return ok;
}

function enqueue(entry: Entry, immediate: boolean): Promise<boolean> {
  if (!config) {
    console.warn("logsTelemetry: dropped a log line because configureLogger() was never called.");
    return Promise.resolve(false);
  }
  queue.push(entry);
  queue = queue.slice(-(config.maxQueue ?? DEFAULT_MAX_QUEUE));
  const interval = config.batchIntervalMs ?? DEFAULT_BATCH_MS;
  if (immediate || interval <= 0 || queue.length >= BATCH_SIZE) return flushLogs();
  if (!timer) timer = setTimeout(() => void flushLogs(), interval);
  return Promise.resolve(true);
}

function send(level: LogLevel, reason: string, fields: LogFields = {}): Promise<boolean> {
  if (!config) {
    console.warn("logsTelemetry: dropped a log line because configureLogger() was never called.");
    return Promise.resolve(false);
  }
  // Errors go out at once; info/warning wait for the batch.
  return enqueue(buildEntry(level, reason, fields), level === "error");
}

export const logInfo = (reason: string, fields?: LogFields) => send("info", reason, fields);
export const logWarning = (reason: string, fields?: LogFields) => send("warning", reason, fields);
export const logError = (reason: string, fields?: LogFields) => send("error", reason, fields);

// Fatal crash: the process may die right after this, so save the line first and
// send it now; if the send does not finish, it goes out on the next launch.
export async function logFatal(reason: string, fields: LogFields = {}): Promise<void> {
  if (!config) return;
  const entry = buildEntry("error", reason, fields);
  try {
    await config.storage?.setItem(PENDING_KEY, JSON.stringify([entry]));
  } catch {
    // Storage is best effort.
  }
  if (await enqueue(entry, true)) {
    try {
      await config.storage?.removeItem(PENDING_KEY);
    } catch {
      // Ignore.
    }
  }
}

async function restorePending(): Promise<void> {
  if (!config?.storage) return;
  try {
    const raw = await config.storage.getItem(PENDING_KEY);
    if (!raw) return;
    const entries = JSON.parse(raw) as Entry[];
    const results = await Promise.all(
      entries.map((e) => {
        // Mark it so dashboards can tell a late crash from a live one.
        const line = { ...JSON.parse(e.line), Recovered: true };
        return enqueue({ ...e, line: JSON.stringify(line) }, true);
      }),
    );
    // Keep it saved until the gateway accepted it.
    if (results.every(Boolean)) await config.storage.removeItem(PENDING_KEY);
  } catch {
    // Corrupt or unreadable: leave it, it is retried on the next launch.
  }
}

type GlobalErrorHandler = (error: Error, isFatal?: boolean) => void;

// Reports uncaught JS exceptions via React Native's global handler. Call after configureLogger().
export function installGlobalCrashHandler(
  getFields: () => LogFields,
  onCrash?: (error: Error, isFatal: boolean) => LogFields,
): void {
  const g = globalThis as unknown as {
    ErrorUtils?: {
      getGlobalHandler: () => GlobalErrorHandler;
      setGlobalHandler: (handler: GlobalErrorHandler) => void;
    };
  };

  if (!g.ErrorUtils) {
    console.warn(
      "logsTelemetry: ErrorUtils is not available - installGlobalCrashHandler() only works inside React Native.",
    );
    return;
  }

  const previousHandler = g.ErrorUtils.getGlobalHandler();

  g.ErrorUtils.setGlobalHandler((error, isFatal) => {
    const fatal = Boolean(isFatal);
    const base = getFields();
    const more = onCrash ? onCrash(error, fatal) : {};
    const fields: LogFields = {
      ...base,
      ...more,
      event: fatal ? "app.crash" : "app.error",
      stage: "GlobalCrashHandler",
      extra: {
        ...(base.extra ?? {}),
        ...(more.extra ?? {}),
        IsFatal: fatal,
        ErrorName: error?.name ?? "Error",
        Stack: clip(error?.stack ?? "", MAX_STACK),
      },
    };
    const reason = error?.message ?? String(error);
    // Hand over to the previous handler once the line is saved/sent, never later than 1.5 s.
    const done = fatal ? logFatal(reason, fields) : logError(reason, fields).then(() => undefined);
    Promise.race([done, new Promise((resolve) => setTimeout(resolve, 1500))]).finally(() =>
      previousHandler(error, isFatal),
    );
  });
}
