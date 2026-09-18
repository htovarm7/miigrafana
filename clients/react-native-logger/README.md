# react-native-logger

Dependency-free logger (`logsTelemetry.ts`, uses global `fetch`) that ships logs to the gateway. Copy the file into the React Native app.

```ts
import { configureLogger, installGlobalCrashHandler, logError } from "./logsTelemetry";

configureLogger({ baseUrl: "https://<gateway-host>", apiKey: "<GATEWAY_API_KEY>", service: "miicel-mobile" });
installGlobalCrashHandler(() => currentUserId);

await logError("Payment failed", { userId: currentUserId, stage: "Checkout" });
```

Test against a running stack: `npm install && npm run test:local` (defaults to `http://localhost:8081`, `dev-local-only-key`).

Query in Grafana → Explore → Loki: `{app="miicel-mobile"} | json | UserId="123"`
