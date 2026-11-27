// Local driver: npx ts-node logsTelemetry.test.ts [gatewayBaseUrl] [apiKey]

import {
  configureLogger,
  flushLogs,
  installGlobalCrashHandler,
  logError,
  logFatal,
  logInfo,
  logWarning,
  LogStorage,
} from "./logsTelemetry";

const baseUrl = process.argv[2] ?? "http://localhost:8081";
const apiKey = process.argv[3] ?? "dev-local-only-key";
let failures = 0;

function check(label: string, ok: boolean) {
  console.log(`${ok ? "PASS" : "FAIL"}  ${label}`);
  if (!ok) failures += 1;
}

function memoryStorage(): LogStorage & { data: Map<string, string> } {
  const data = new Map<string, string>();
  return {
    data,
    getItem: async (k) => data.get(k) ?? null,
    setItem: async (k, v) => void data.set(k, v),
    removeItem: async (k) => void data.delete(k),
  };
}

async function main() {
  const correlationId = `test-${Date.now()}`;
  const userId = "8842";
  console.log(`Using gateway ${baseUrl}, CorrelationId=${correlationId}`);

  // 1. Immediate mode (batchIntervalMs 0): every line is accepted by the gateway.
  configureLogger({ baseUrl, apiKey, service: "miicel-mobile", batchIntervalMs: 0 });
  check("info accepted", await logInfo("App started", { userId, correlationId, event: "app.start" }));
  check("warning accepted", await logWarning("HTTP 400", { userId, correlationId, event: "api.request", endpoint: "login", status: 400, durationMs: 120 }));
  check("error accepted", await logError("Simulated error", { userId, correlationId, stage: "PurchaseScreen" }));

  // 2. Batch mode: info waits in the queue until flushLogs().
  configureLogger({ baseUrl, apiKey, service: "miicel-mobile", batchIntervalMs: 60000 });
  await logInfo("Queued line 1", { userId, correlationId });
  await logInfo("Queued line 2", { userId, correlationId });
  check("batch flush accepted", await flushLogs());

  // 3. Wrong key: nothing is accepted and the line stays queued (no throw).
  configureLogger({ baseUrl, apiKey: "wrong-key", service: "miicel-mobile", batchIntervalMs: 0 });
  check("wrong key rejected", !(await logError("Should be rejected", { correlationId })));

  // 4. Fatal crash with a dead network: saved to storage, sent on the next launch.
  const storage = memoryStorage();
  configureLogger({ baseUrl: "http://127.0.0.1:1", apiKey, service: "miicel-mobile", batchIntervalMs: 0, storage });
  await logFatal("Simulated fatal crash", { userId, correlationId, event: "app.crash", stage: "GlobalCrashHandler" });
  check("fatal crash persisted while offline", storage.data.has("logsTelemetry:pending"));
  configureLogger({ baseUrl, apiKey, service: "miicel-mobile", batchIntervalMs: 0, storage });
  await new Promise((r) => setTimeout(r, 1000));
  check("persisted crash sent on next launch", !storage.data.has("logsTelemetry:pending"));

  // 5. Global handler: fake ErrorUtils, previous handler must still run.
  let previousCalled = false;
  let handler: ((e: Error, fatal?: boolean) => void) | undefined;
  (globalThis as any).ErrorUtils = {
    getGlobalHandler: () => () => { previousCalled = true; },
    setGlobalHandler: (h: (e: Error, fatal?: boolean) => void) => { handler = h; },
  };
  configureLogger({ baseUrl, apiKey, service: "miicel-mobile", batchIntervalMs: 0, storage: memoryStorage() });
  installGlobalCrashHandler(() => ({ userId, correlationId }));
  handler!(new TypeError("undefined is not an object (evaluating 'x.y')"), true);
  await new Promise((r) => setTimeout(r, 1800));
  check("global handler logs the crash and calls the previous handler", previousCalled);

  console.log("\nCheck in Loki:");
  console.log(`  {app="miicel-mobile"} | json | CorrelationId="${correlationId}"`);

  if (failures > 0) {
    console.error(`${failures} check(s) failed.`);
    process.exitCode = 1;
  }
}

main();
