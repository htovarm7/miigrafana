// Local driver: npx ts-node logsTelemetry.test.ts [gatewayBaseUrl] [apiKey]

import {
  configureLogger,
  logError,
  logInfo,
  logWarning,
} from "./logsTelemetry";

async function main() {
  const baseUrl = process.argv[2] ?? "http://localhost:8081";
  const apiKey = process.argv[3] ?? "dev-local-only-key";

  configureLogger({ baseUrl, apiKey, service: "miicel-mobile" });

  const correlationId = `test-${Date.now()}`;
  const userId = "8842";

  console.log(`Using gateway ${baseUrl}, CorrelationId=${correlationId}`);

  const infoOk = await logInfo("App opened", { userId, correlationId, stage: "AppStart" });
  console.log(`logInfo (AppStart):    ${infoOk ? "accepted" : "REJECTED"}`);

  const warnOk = await logWarning("Slow network detected", {
    userId,
    correlationId,
    stage: "NetworkCheck",
  });
  console.log(`logWarning (NetworkCheck): ${warnOk ? "accepted" : "REJECTED"}`);

  const errorOk = await logError("Simulated crash: TypeError in PurchaseScreen", {
    userId,
    correlationId,
    stage: "PurchaseScreen",
    extra: { screen: "PurchaseScreen" },
  });
  console.log(`logError (PurchaseScreen): ${errorOk ? "accepted" : "REJECTED"}`);

  console.log("");
  console.log("Now check Loki for the full trace of this one session:");
  console.log(
    `  {app="miicel-mobile"} | json | CorrelationId="${correlationId}"`,
  );

  if (!infoOk || !warnOk || !errorOk) {
    console.error("At least one log line was rejected by the gateway - check the API key.");
    process.exitCode = 1;
  }
}

main();
