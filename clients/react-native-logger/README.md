# react-native-logger

Dependency-free logger (`logsTelemetry.ts`, uses global `fetch`) that ships logs to the gateway. Copy the file into the React Native app.

```ts
import { configureLogger, installGlobalCrashHandler, logError } from "./logsTelemetry";

configureLogger({ baseUrl: "https://<gateway-host>", apiKey: "<GATEWAY_API_KEY>", service: "miicel-mobile" });
installGlobalCrashHandler(() => currentUserId);

await logError("Payment failed", { userId: currentUserId, stage: "Checkout" });
```

## Use in MiiCajaMobileV2

The app wraps this file in `services/Telemetry.js` (adds user, env, platform and a per-session `CorrelationId`) and calls `initTelemetry()` in `App.js`. Config comes from `.env`; without it logging is disabled:

```
EXPO_PUBLIC_LOGS_GATEWAY_URL=http://<host>:8081
EXPO_PUBLIC_LOGS_API_KEY=<GATEWAY_API_KEY>
EXPO_PUBLIC_LOGS_SERVICE=miicel-mobile
EXPO_PUBLIC_LOGS_ENV=qa
```

- Android emulator: use `http://10.0.2.2:8081`; a physical device needs the PC/server IP.
- `EXPO_PUBLIC_*` values ship inside the bundle, so use a QA-only key.
- Never log tokens, passwords or request bodies.

Test against a running stack: `npm install && npm run test:local` (defaults to `http://localhost:8081`, `dev-local-only-key`).

Query in Grafana → Explore → Loki: `{app="miicel-mobile"} | json | UserId="123"`

## Dashboard

`observability/grafana/dashboards/mobile-app/miicel-mobile-app-overview.json` is provisioned automatically (folder `MiiCel/Mobile App`). Variables: environment, platform, search, UserId, CorrelationId.

| Section | Panels |
|---|---|
| Summary | Errors, Warnings, Crashes, HTTP 5xx, Sessions, Active users |
| Trends | Logs by level, HTTP errors by status |
| Breakdown | Top failing endpoints, Errors by stage, Sessions by platform |
| Logs | Crashes, Errors, Audit by user, Full session trace |

It relies on the fields in [docs/log-format.md](../../docs/log-format.md).
