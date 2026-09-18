// Ships structured logs from the React Native app to the gateway (POST /loki/api/v1/push).

export type LogLevel = "info" | "warning" | "error";

export interface LoggerConfig {
  /** Gateway base URL, e.g. "http://localhost:8081". */
  baseUrl: string;
  /** Sent as the X-API-Key header. */
  apiKey: string;
  /** Loki `app` label, e.g. "miicel-mobile". */
  service: string;
}

export interface LogFields {
  userId?: string;
  /** Groups all lines of one operation/session. */
  correlationId?: string;
  /** Step/screen/flow where it happened. */
  stage?: string;
  /** Extra flat fields. */
  extra?: Record<string, string | number | boolean | null | undefined>;
}

let config: LoggerConfig | null = null;

// Call once at app startup, before any log call.
export function configureLogger(next: LoggerConfig): void {
  config = next;
}

function buildPushBody(level: LogLevel, reason: string, fields: LogFields) {
  if (!config) {
    throw new Error(
      "logsTelemetry: configureLogger() must be called before logging anything.",
    );
  }

  const line: Record<string, unknown> = {
    Service: config.service,
    Reason: reason,
    ...(fields.userId !== undefined ? { UserId: fields.userId } : {}),
    ...(fields.correlationId !== undefined
      ? { CorrelationId: fields.correlationId }
      : {}),
    ...(fields.stage !== undefined ? { Stage: fields.stage } : {}),
    ...(fields.extra ?? {}),
  };

  const nowNs = (BigInt(Date.now()) * 1_000_000n).toString();

  return {
    streams: [
      {
        stream: { app: config.service, level },
        values: [[nowNs, JSON.stringify(line)]],
      },
    ],
  };
}

// Sends one log line; never throws. Returns true if the gateway accepted it (204).
async function send(
  level: LogLevel,
  reason: string,
  fields: LogFields = {},
): Promise<boolean> {
  if (!config) {
    console.warn(
      "logsTelemetry: dropped a log line because configureLogger() was never called.",
    );
    return false;
  }

  try {
    const response = await fetch(`${config.baseUrl}/loki/api/v1/push`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-API-Key": config.apiKey,
      },
      body: JSON.stringify(buildPushBody(level, reason, fields)),
    });
    return response.status === 204;
  } catch {
    // Logging must never crash the app.
    return false;
  }
}

export function logInfo(reason: string, fields?: LogFields): Promise<boolean> {
  return send("info", reason, fields);
}

export function logWarning(
  reason: string,
  fields?: LogFields,
): Promise<boolean> {
  return send("warning", reason, fields);
}

export function logError(
  reason: string,
  fields?: LogFields,
): Promise<boolean> {
  return send("error", reason, fields);
}

// Reports uncaught JS exceptions via React Native's global handler. Call after configureLogger().
export function installGlobalCrashHandler(getUserId: () => string | undefined): void {
  const g = globalThis as unknown as {
    ErrorUtils?: {
      getGlobalHandler: () => (error: Error, isFatal?: boolean) => void;
      setGlobalHandler: (handler: (error: Error, isFatal?: boolean) => void) => void;
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
    void logError(error.message, {
      userId: getUserId(),
      stage: "GlobalCrashHandler",
      extra: { isFatal: Boolean(isFatal), stack: error.stack ?? null },
    });
    previousHandler(error, isFatal);
  });
}
