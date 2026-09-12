# react-native-logger

Ships structured audit logs from the React Native app to miigrafana's public ingestion gateway, using the same field contract documented in [OBSERVABILIDAD.md](../../OBSERVABILIDAD.md#logging-standard-per-user-per-stage-audit-fields): `UserId`, `Service`, `Reason`, `CorrelationId`, optional `Stage`.

## Usage in the app

```ts
import { configureLogger, installGlobalCrashHandler, logError } from "./logsTelemetry";

// Once, at app startup:
configureLogger({
  baseUrl: "https://grafana.miicaja.org", // or the gateway's local/dev URL
  apiKey: "<the shared gateway key>",
  service: "miicel-mobile",
});
installGlobalCrashHandler(() => currentUserId); // reports uncaught JS exceptions automatically

// Anywhere else in the app:
await logError("Payment failed", { userId: currentUserId, stage: "CheckoutScreen" });
```

`logError`/`logWarning`/`logInfo` never throw — a logging call failing (bad network, wrong key) must never crash the app it's trying to report a crash from. They resolve to `false` if the gateway didn't accept the line.

## Testing it locally

Requires the gateway running (`docker compose -f ../../docker-compose.observability.yml up -d`, or the network-simulation stack in `../../tests/network-simulation/`):

```bash
npm install
npm run test:local              # http://localhost:8081, dev-local-only-key
npm run test:local -- <url> <key>  # against a different gateway
```

Then check the trace in Grafana → Explore → Loki, or directly against Loki's API:

```
{app="miicel-mobile"} | json | CorrelationId="<the one printed by the script>"
```

## Copying this into the real React Native project

This folder is dependency-free on purpose (only uses the global `fetch`) so it drops straight into a React Native project — copy `logsTelemetry.ts` in, there's nothing else to install.
