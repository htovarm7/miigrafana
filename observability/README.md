# Local observability PoC — Grafana + Loki + Prometheus

This is a standalone repo, separate from `MiiCelBack`, that only holds the observability infra (Loki/Prometheus/Grafana configs, dashboards, docker-compose). It's meant to sit as a **sibling directory** next to `MiiCelBack`:

```
miicel/
├── MiiCelBack/   (the app repo)
└── miigrafana/   (this repo)
```

This stack is **only for testing on your machine** the proposal in [OBSERVABILIDAD.md](../OBSERVABILIDAD.md). It's not a replacement for `MiiCelBack`'s `docker-compose.production.yml` — that one gets touched separately, once the team decides to go to production, and it will need its own copy of this Loki/Prometheus/Grafana config (see [OBSERVABILIDAD.md](../OBSERVABILIDAD.md) for the production-VPN version).

The actual app-side wiring lives in `MiiCelBack`, not here:
- Logs → Loki: `GrafanaLoki` sink in `MiiCelBack/src/MiiCel.Api/MiiCel.Api.Management/appsettings.Development.json`.
- Metrics → Prometheus: `AddOpenTelemetry()...AddPrometheusExporter()` + `MapPrometheusScrapingEndpoint()` in `MiiCelBack/src/MiiCel.Api/MiiCel.Api.Management/Program.cs`, exposed at `GET /metrics`.
- Test endpoint that fails on purpose: `GET /api/home/test-error` in `MiiCelBack/src/MiiCel.Api/MiiCel.Api.Management/Controllers/HomeController.cs` (remove once the demo is no longer needed).
- Request logs are enriched with `UserId` (from the JWT claim) and `Endpoint` so failures can be traced back to a specific user (see "Finding what a specific user did" below).

`MiiCel.Api.Users` already has the same `UserId`/`Endpoint` wiring as Management (identical `Program.cs` pattern). `MiiCel.Api.Workers` (the Temporal worker host) does not have it yet — it currently uses plain `Console.WriteLine`, no Serilog at all — replicate the pattern there when the team decides to move to that phase.

**Standardizing logs across services**: before wiring up a new service (or adding step-by-step tracing to an existing multi-step flow, e.g. "which stage of a purchase failed"), read the **"Logging standard: per-user, per-stage audit fields"** section in [OBSERVABILIDAD.md](../OBSERVABILIDAD.md#logging-standard-per-user-per-stage-audit-fields) first. It defines the exact field names (`UserId`, `Endpoint`, `Stage`, `Reason`, `Service`, `CorrelationId`), the one-line-per-failure rule, and a generic instrumentation checklist — so a new service's logs stay queryable the same way as everything already shipped, instead of drifting into ad-hoc field names. `GET /api/home/test-multistage` (Management) is a live, working example of the whole pattern — see the next section.

## Current setup: `dotnet run` (no Docker build needed)

For now the API is meant to run on the host with `dotnet run` (no Azure DevOps PAT required), while Loki/Prometheus/Grafana run in Docker. That's why:
- `appsettings.Development.json` (in `MiiCelBack`) points the Loki sink at `http://localhost:3200` (reachable from a host process — Loki's host-side port is remapped to `3200` because `3100` sits inside a Windows Hyper-V excluded port range on this machine; see the comment in [docker-compose.observability.yml](../docker-compose.observability.yml)).
- [observability/prometheus/prometheus.yml](prometheus/prometheus.yml) scrapes `host.docker.internal:5011` — Docker Desktop's alias for your laptop, since the API's `http` launch profile listens on port `5011` (see `MiiCelBack/src/MiiCel.Api/MiiCel.Api.Management/Properties/launchSettings.json`).

> If `docker compose up` fails with `ports are not available: ... 0.0.0.0:3100 ... forbidden by its access permissions`, that's Windows, not this stack — check `netsh interface ipv4 show excludedportrange protocol=tcp` and remap the host port in `docker-compose.observability.yml` (and the Loki sink URI in `MiiCelBack`) to something outside the listed ranges, same as was done here.

### 1. Start Loki + Prometheus + Grafana

```bash
docker compose -f docker-compose.observability.yml up -d
```

This brings up:
- `loki` on `http://localhost:3200` (host port; containers reach it internally at `loki:3100`)
- `prometheus` on `http://localhost:9090`
- `grafana` on `http://localhost:3000` (anonymous login enabled as admin, **local only** — see `GF_AUTH_ANONYMOUS_ENABLED` in [docker-compose.observability.yml](../docker-compose.observability.yml))

### 2. Start the Management API (from the `MiiCelBack` repo)

```bash
dotnet run --project ../MiiCelBack/src/MiiCel.Api/MiiCel.Api.Management/MiiCel.Api.Management.csproj
```

It listens on `http://localhost:5011` (`http` profile) with `ASPNETCORE_ENVIRONMENT=Development`, which is what activates the Loki sink and the `/metrics` endpoint.

## How to test it

1. Open `http://localhost:9090/targets` and confirm the `miicel-api-management` job is `UP` (takes a few seconds for the first scrape).
2. Generate normal traffic: hit `http://localhost:5011/api/home/ping` a couple of times.
3. Trigger a deliberate failure: `http://localhost:5011/api/home/test-error`. This:
   - Throws an unhandled exception (caught by `ErrorHandlingMiddleware`, responds 500).
   - Writes an error log with Serilog, which reaches Loki via the `GrafanaLoki` sink.
   - Gets counted in Prometheus metrics with `http_response_status_code=500` and `error_type=System.InvalidOperationException`.
4. Open Grafana at `http://localhost:3000` → dashboard **MiiCel Back - Overview (local)** (already provisioned, folder "MiiCel"). You should see:
   - The 5xx error panel move.
   - The exception log in the **Errores (level=error)** panel — this is the one to actually look at when hunting for a failure, see below.
   - The endpoint's p95 latency.
5. Alternative way to see logs without the dashboard: in Grafana, go to **Explore**, pick the **Loki** datasource, and run `{app="miicel-api-management"}`.

## "I see too many logs, I can't tell which one failed"

Two separate fixes for this, one in the app and one in the dashboard:

**1. Cut the noise at the source (in `MiiCelBack`).** Two things were flooding the log stream:
   - The built-in ASP.NET Core request logging (`Microsoft.AspNetCore` category) was set to `Information`, so every request produced *five* framework log lines ("Request starting", "Executing endpoint", "Executed endpoint", "Request finished"...) on top of Serilog's own one-line summary. Fixed by overriding `Microsoft.AspNetCore` to `Warning` in `appsettings.Development.json` — Serilog's compact `HTTP GET /path responded 200 in Xms` line is enough.
   - Prometheus scrapes `/metrics` every 5 seconds, and each scrape was generating its own log line, drowning out real traffic. `Program.cs` now sets that specific request's log level to `Verbose` (below the minimum), so `/metrics` scrapes stop generating log lines entirely.

**2. Split the dashboard's logs panel.** The dashboard now has two log panels instead of one:
   - **Errores (level=error)** — only `level="error"` lines. This is where an actual failure shows up.
   - **Todos los logs** — everything else, for context.

   Both panels share a `search` template variable (top of the dashboard, a regex textbox) so you can type e.g. `saldo-insuficiente` or a `UserId` and both panels filter live, without editing the query.

## Finding "what did this specific user do that broke"

This is the actual question the team wants answered without SSHing in, so it's worth calling out explicitly.

`Program.cs` (in `MiiCelBack`) enriches every request log with `UserId` (from the `ClaimTypes.NameIdentifier` JWT claim — same claim the controllers already read, see `_userId` in e.g. `CatalogController.cs`) and `Endpoint`. That happens automatically for any `[Authorize]` endpoint with a real token; no per-controller change needed.

To try it without a real JWT, `test-error` accepts `userId` and `reason` query params and logs them as structured fields:

```bash
curl "http://localhost:5011/api/home/test-error?userId=8842&reason=saldo-insuficiente"
curl "http://localhost:5011/api/home/test-error?userId=1900&reason=telefono-invalido"
```

Then in Grafana → **Explore** → **Loki**, filter to just that one user's failures with LogQL:

```
{app="miicel-api-management"} | json | UserId="8842"
```

That returns only the `8842` request — the structured exception (type, message, full stack trace) and the request-level "responded 500" line, with `1900`'s failure filtered out. On a real authenticated endpoint the same query works with the actual `UserId` claim value, so support can go from "user says recharge X failed" straight to the exact log line without reading every request.

## Testing it with Postman

If you have a real JWT (issued by MiiIdentidad, or minted locally against the `Jwt` secret in `appsettings.Development.json`), Postman is the quickest way to exercise a real authenticated endpoint locally and watch the audit trail land in Grafana.

**What you can test today** (already shipped, live-testable):

1. In Postman, create an environment with `baseUrl` (`http://localhost:5011` for Management, `http://localhost:5001` for Users) and `token` (your JWT).
2. Add an `Authorization: Bearer {{token}}` header (or use Postman's Bearer Token auth tab) and call any `[Authorize]` endpoint — e.g. `GET {{baseUrl}}/api/catalog/mobileapp` (Management) or `POST {{baseUrl}}/api/purchase/serviceplan` (Users).
3. Whatever the outcome, open Grafana → **Explore** → **Loki** and filter by the `UserId` from your token's claim:
   ```
   {app=~".+"} | json | UserId="<your UserId>"
   ```
   You'll see every log line — success or failure — tagged with that user, across whichever service you hit. If the request failed, per the "single line per error" behavior already shipped, there's exactly one `level="error"` line with the full exception, not three.

**Stage-by-stage tracing, live today (demo, not a real business flow)**: `GET /api/home/test-multistage` on the Management API is a working, callable example of the full "Logging standard" pattern from [OBSERVABILIDAD.md](../OBSERVABILIDAD.md#logging-standard-per-user-per-stage-audit-fields) — no JWT needed, `[AllowAnonymous]` like `test-error`.

1. In Postman: `GET {{baseUrl}}/api/home/test-multistage?userId=9001&failAt=CallExternalService` (valid `failAt` values: `ValidateUser`, `CallExternalService`, `PersistResult`). The response body includes a `correlationId`.
2. Grafana → **Explore** → **Loki**:
   ```
   {app="miicel-api-management"} | json | CorrelationId="<the correlationId from the response>"
   ```
   Returns exactly the stages that ran before the failure — e.g. with `failAt=CallExternalService`: one `Information` line for `Stage=ValidateUser` ("completed"), one `Error` line for `Stage=CallExternalService` ("failed", full exception attached) — `PersistResult` never shows up, since it never ran. That's the real, working shape of "which step of the flow broke", not an illustration.
3. **This is a self-contained demo, not the purchase flow** — applying the same pattern to `PurchaseService`/`RechargeActivities` (a real `SaleGUID`-based `CorrelationId` across the Users API and the Temporal Worker) is the next real piece of work, described at the end of the OBSERVABILIDAD.md section linked above.

## Log retention: 3 months of history, queryable by day/month

Loki is configured to keep **90 days (2160h)** of logs before deleting them, via `compactor.retention_enabled: true` + `limits_config.retention_period: 2160h` in [observability/loki/loki-config.yml](loki/loki-config.yml). The compactor runs every 10 minutes and needs a `delete_request_store` configured (set to `filesystem`, same backend as the chunks) — without it Loki refuses to start with retention enabled.

Day/month granularity isn't a separate setting you query by — Loki already indexes chunks in 24h periods (`schema_config.configs[0].index.period: 24h`), so any time range (today, last 30 days, a specific month) is just a normal Grafana time-range query; nothing extra to configure to "browse by day/month". In Grafana, use the time picker (top right) — an absolute range like `2026-06-01` to `2026-06-30` works the same as `now-24h`.

Retention notes:
- This is bounded by disk on `loki-data` (the Docker volume) — for 3 months of MiiCel's log volume this should be small, but if the demo runs for a while and disk becomes a concern, lower `retention_period` or prune the volume (`docker compose -f docker-compose.observability.yml down -v`).
- `retention_delete_delay: 2h` means data isn't deleted immediately after the retention window passes — it's a grace period before the compactor actually removes it.
- This same config is what should carry over to the production compose file when the team is ready (see the Phase 1 note in [OBSERVABILIDAD.md](../OBSERVABILIDAD.md)) — just remember production will need its own persistent volume/disk sized for 90 days of real traffic, not the local demo's.

## Switching to a fully dockerized API later

`docker-compose.observability.yml` already joins the external `miivida_vnet` network — the same one `MiiCelBack`'s own `docker-compose.development.yml`/`.staging.yml`/`.production.yml` join to reach SQL Server, MiiIdentidad and MiiPago. That means **miigrafana keeps running as its own, separate `docker compose` project** (its own containers, its own `docker compose up`/`down`) — it does not need to be merged into MiiCelBack's compose files to be reachable from them, and doesn't require MiiCelBack's compose files to reference this repo at all.

Once you have `AZURE_DEVOPS_PAT`/`AZURE_DEVOPS_ENDPOINT` available (see the `TODO` in `MiiCelBack/.env`) and want to run the API itself inside Docker instead of `dotnet run`:

1. Make sure the `miivida_vnet` network exists (it's created once, typically by ops, the same as for the other MiiVida services): `docker network create miivida_vnet` if it doesn't already.
2. In `MiiCelBack`'s environment config for the target environment (e.g. `.env.development`, following the existing `AppSettings__*` env-var convention), point the Loki sink URI at the container DNS name instead of `localhost`: `http://loki:3100` instead of `http://localhost:3200`.
3. In [observability/prometheus/prometheus.yml](prometheus/prometheus.yml), swap the commented-out `miicel.api.management:8080`/`miicel.api.users:8080` block in for the `host.docker.internal:...` one currently active — the comments in that file mark exactly which lines to swap.
4. Bring up each stack independently, both joining `miivida_vnet`:

```bash
# From the MiiCelBack repo, on whichever compose files match the target environment:
cd ../MiiCelBack
docker compose --env-file .env.development -f docker-compose.yml -f docker-compose.development.yml up --build

# From this repo, separately:
cd ../miigrafana
docker compose -f docker-compose.observability.yml up -d
```

Neither `docker compose` invocation references the other repo's compose file — they're two independent projects that happen to share one Docker network.

## Shutting down

```bash
docker compose -f docker-compose.observability.yml down
```

Add `-v` if you also want to delete the data volumes (`loki-data`, `prometheus-data`, `grafana-data`) — this also wipes whatever log history you'd accumulated. Stop the `dotnet run` process separately (Ctrl+C, or kill the process if it was started in the background).

## Notes

- If Loki isn't up, the Serilog sink doesn't break the app — it just fails silently (or via `Serilog.Debugging.SelfLog` if you enable it). It's safe to leave it in `appsettings.Development.json` even when you're sometimes working without the observability stack up.
- The HTTP metric names (`http_server_request_duration_seconds_*`) come from OpenTelemetry's [stable semantic conventions](https://opentelemetry.io/docs/specs/semconv/http/http-metrics/) for ASP.NET Core. If inspecting `http://localhost:5011/metrics` shows different names (due to a package version change), adjust the dashboard queries accordingly.
