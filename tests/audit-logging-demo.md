# Audit logging demo (per-user, per-stage tracing)

**Endpoint**: `GET /api/home/test-multistage` (`MiiCel.Api.Management`)

This demonstrates the "Logging standard" documented in [OBSERVABILIDAD.md](../OBSERVABILIDAD.md#logging-standard-per-user-per-stage-audit-fields): every log line for one operation shares the same `CorrelationId`, and each stage is tagged with `Stage`/`UserId`/`Service`/`Reason` so a failure can be traced to the exact step that broke, not just "something failed".

It's a self-contained demo endpoint — it doesn't touch any real business flow (see the OBSERVABILIDAD.md section for where this pattern applies next, e.g. the purchase flow).

**Related demos**:
- [`../clients/react-native-logger/`](../clients/react-native-logger/) — the same standard, implemented in TypeScript for the React Native mobile app, going through the public token gateway instead of a direct in-network request. Run `npm run test:local` there for the same kind of trace, but for `{app="miicel-mobile"}`.
- [`../tests/network-simulation/`](network-simulation/) — validates the network access model (public token gateway vs. VPN-only Grafana) that the mobile app's traffic goes through, before any real VM/VNet exists.
- [`../clients/web-faro-demo/`](../clients/web-faro-demo/) — a standalone page showing Grafana's own Faro Web SDK shipping browser telemetry (logs, errors with stack traces, web-vitals) through Alloy into Loki — worth comparing against the manual `UserId`/`Stage`/`Reason` approach above.

## Case 1: all stages succeed

```bash
curl "http://localhost:5011/api/home/test-multistage?userId=8842&failAt=none"
```

`CorrelationId: 995d9cf0-2d05-4af0-b8c5-5a70001c512f`

```
[Information] Stage=ValidateUser         UserId=8842   Service=miicel-api-management
             Reason: Etapa ValidateUser completada
[Information] Stage=CallExternalService  UserId=8842   Service=miicel-api-management
             Reason: Etapa CallExternalService completada
[Information] Stage=PersistResult        UserId=8842   Service=miicel-api-management
             Reason: Etapa PersistResult completada
```

## Case 2: fails at the `CallExternalService` stage

```bash
curl "http://localhost:5011/api/home/test-multistage?userId=8842&failAt=CallExternalService"
```

`CorrelationId: 0a89a577-32a7-43d0-ad43-92788dfc1121`

```
[Information] Stage=ValidateUser         UserId=8842   Service=miicel-api-management
             Reason: Etapa ValidateUser completada
[Error      ] Stage=CallExternalService  UserId=8842   Service=miicel-api-management
             Reason: Etapa CallExternalService fallo
             Exception: System.InvalidOperationException: Fallo simulado en la etapa CallExternalService para el usuario 8842
```

**Note**: `PersistResult` never appears above — it never ran, because `CallExternalService` failed first and the flow stopped there. That's the point: you know exactly which of the 3 stages broke, not just that "something" failed somewhere in the request.

## Equivalent LogQL query

In Grafana → **Explore** → **Loki** datasource:

```
{app="miicel-api-management"} | json | CorrelationId="0a89a577-32a7-43d0-ad43-92788dfc1121"
```

## Raw JSON log lines

As actually written to disk / shipped to Loki for Case 2:

```json
{
  "@t": "2026-09-04T20:50:41.7179769Z",
  "@mt": "{Reason}",
  "@tr": "dd101978e372898d845043e519776669",
  "@sp": "5fc82b733e0d62e3",
  "Reason": "Etapa ValidateUser completada",
  "SourceContext": "MiiCel.Api.Management.Controllers.HomeController",
  "ActionId": "7422df27-8189-4e53-b06a-a82ffb7043dc",
  "ActionName": "MiiCel.Api.Management.Controllers.HomeController.TestMultiStage (MiiCel.Api.Management)",
  "RequestId": "0HNOAOONDB6EJ:00000001",
  "RequestPath": "/api/home/test-multistage",
  "ConnectionId": "0HNOAOONDB6EJ",
  "Stage": "ValidateUser",
  "CorrelationId": "0a89a577-32a7-43d0-ad43-92788dfc1121",
  "Endpoint": "MiiCel.Api.Management.Controllers.HomeController.TestMultiStage (MiiCel.Api.Management)",
  "UserId": "8842",
  "Service": "miicel-api-management"
}
```

```json
{
  "@t": "2026-09-04T20:50:41.7181662Z",
  "@mt": "{Reason}",
  "@l": "Error",
  "@x": "System.InvalidOperationException: Fallo simulado en la etapa CallExternalService para el usuario 8842\r\n   at MiiCel.Api.Management.Controllers.HomeController.RunStage(String stage, String userId, String failAt) in C:\\Users\\soyhe\\Desktop\\miicel\\MiiCelBack\\src\\MiiCel.Api\\MiiCel.Api.Management\\Controllers\\HomeController.cs:line 101",
  "@tr": "dd101978e372898d845043e519776669",
  "@sp": "5fc82b733e0d62e3",
  "Reason": "Etapa CallExternalService fallo",
  "SourceContext": "MiiCel.Api.Management.Controllers.HomeController",
  "ActionId": "7422df27-8189-4e53-b06a-a82ffb7043dc",
  "ActionName": "MiiCel.Api.Management.Controllers.HomeController.TestMultiStage (MiiCel.Api.Management)",
  "RequestId": "0HNOAOONDB6EJ:00000001",
  "RequestPath": "/api/home/test-multistage",
  "ConnectionId": "0HNOAOONDB6EJ",
  "Stage": "CallExternalService",
  "CorrelationId": "0a89a577-32a7-43d0-ad43-92788dfc1121",
  "Endpoint": "MiiCel.Api.Management.Controllers.HomeController.TestMultiStage (MiiCel.Api.Management)",
  "UserId": "8842",
  "Service": "miicel-api-management"
}
```
