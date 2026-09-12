/**
 * Ships structured audit logs from the React Native app to miigrafana's
 * public ingestion gateway (see OBSERVABILIDAD.md, "External ingestion: the
 * token gateway"), using the same field contract already used by
 * MiiCel.Api.Management/Users: UserId, Service, Reason, CorrelationId, and
 * an optional Stage.
 *
 * Dependency-free - only uses the global `fetch`, which React Native
 * provides natively. No React Native APIs are imported here on purpose, so
 * this file can also run under plain Node/ts-node for local testing (see
 * logsTelemetry.test.ts).
 */

export type LogLevel = "info" | "warning" | "error";

export interface LoggerConfig {
  /** Base URL of the gateway, e.g. "https://grafana.miicaja.org" or "http://localhost:8081" for local testing. */
  baseUrl: string;
  /** Shared secret checked by the gateway (X-API-Key header). */
  apiKey: string;
  /** Loki stream label identifying this app, e.g. "miicel-mobile". */
  service: string;
}

export interface LogFields {
  userId?: string;
  /** Ties this log to other log lines from the same operation/session, across services. */
  correlationId?: string;
  /** Which step/screen/flow this happened in, if the caller has one. */
  stage?: string;
  /** Arbitrary extra structured fields - kept flat, not nested, to match the existing Loki field shape. */
  extra?: Record<string, string | number | boolean | null | undefined>;
}

let config: LoggerConfig | null = null;

/** Call once at app startup, before any logError/logInfo/logWarning call. */
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

/**
 * Sends one log line to the gateway. Never throws on a failed/rejected
 * request (e.g. no network, or a bad API key) - logging must never crash the
 * app it's trying to report a crash from. Returns true if the gateway
 * accepted the line (HTTP 204), false otherwise.
 */
async function send(
  level: LogLevel,
  reason: string,
  fields: LogFields = {},
): Promise<boolean> {
  if (!config) {
    // Fail silently and loudly-in-dev: configureLogger() is a setup bug, not
    // a runtime condition worth crashing over.
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
    // Network error, gateway unreachable, etc. - swallow it. A crash
    // reporter that itself crashes the app defeats the point.
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

/**
 * Wires this logger into React Native's global error handler, so an
 * uncaught JS exception is reported here automatically - the actual "en
 * caso de crasheo le notifique a este servicio de logs" requirement.
 *
 * Call this once at app startup, after configureLogger(). Not called
 * automatically by this module, since ErrorUtils is a React Native global
 * that doesn't exist under plain Node (kept out of this file's own runtime
 * path so logsTelemetry.test.ts can still run under ts-node).
 *
 * Usage (in the app's entry point):
 *   import { configureLogger, installGlobalCrashHandler } from "./logsTelemetry";
 *   configureLogger({ baseUrl: "...", apiKey: "...", service: "miicel-mobile" });
 *   installGlobalCrashHandler(() => currentUserId);
 */
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
