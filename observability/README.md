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

Users and Workers don't have the wiring yet — replicate the same pattern in `MiiCelBack` when the team decides to move to that phase.

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

## Log retention: 3 months of history, queryable by day/month

Loki is configured to keep **90 days (2160h)** of logs before deleting them, via `compactor.retention_enabled: true` + `limits_config.retention_period: 2160h` in [observability/loki/loki-config.yml](loki/loki-config.yml). The compactor runs every 10 minutes and needs a `delete_request_store` configured (set to `filesystem`, same backend as the chunks) — without it Loki refuses to start with retention enabled.

Day/month granularity isn't a separate setting you query by — Loki already indexes chunks in 24h periods (`schema_config.configs[0].index.period: 24h`), so any time range (today, last 30 days, a specific month) is just a normal Grafana time-range query; nothing extra to configure to "browse by day/month". In Grafana, use the time picker (top right) — an absolute range like `2026-06-01` to `2026-06-30` works the same as `now-24h`.

Retention notes:
- This is bounded by disk on `loki-data` (the Docker volume) — for 3 months of MiiCel's log volume this should be small, but if the demo runs for a while and disk becomes a concern, lower `retention_period` or prune the volume (`docker compose -f docker-compose.observability.yml down -v`).
- `retention_delete_delay: 2h` means data isn't deleted immediately after the retention window passes — it's a grace period before the compactor actually removes it.
- This same config is what should carry over to the production compose file when the team is ready (see the Phase 1 note in [OBSERVABILIDAD.md](../OBSERVABILIDAD.md)) — just remember production will need its own persistent volume/disk sized for 90 days of real traffic, not the local demo's.

## Switching to a fully dockerized API later

Once you have `AZURE_DEVOPS_PAT`/`AZURE_DEVOPS_ENDPOINT` available (see the `TODO` in `MiiCelBack/.env`) and want to run the API itself inside Docker instead of `dotnet run`:

1. In `MiiCelBack/src/MiiCel.Api/MiiCel.Api.Management/appsettings.Development.json`, change the Loki sink URI from `http://localhost:3200` to `http://loki:3100`.
2. In `observability/prometheus/prometheus.yml`, change the scrape target from `host.docker.internal:5011` to `miicel.api.management:8080` (the Compose service name, resolved via Docker's internal DNS).
3. Run everything together so the containers share the same Compose network — this means running from the `MiiCelBack` repo and pointing at this repo's compose file:

```bash
cd ../MiiCelBack
docker compose -f docker-compose.yml -f docker-compose.override.yml -f ../miigrafana/docker-compose.observability.yml up --build
```

## Shutting down

```bash
docker compose -f docker-compose.observability.yml down
```

Add `-v` if you also want to delete the data volumes (`loki-data`, `prometheus-data`, `grafana-data`) — this also wipes whatever log history you'd accumulated. Stop the `dotnet run` process separately (Ctrl+C, or kill the process if it was started in the background).

## Notes

- If Loki isn't up, the Serilog sink doesn't break the app — it just fails silently (or via `Serilog.Debugging.SelfLog` if you enable it). It's safe to leave it in `appsettings.Development.json` even when you're sometimes working without the observability stack up.
- The HTTP metric names (`http_server_request_duration_seconds_*`) come from OpenTelemetry's [stable semantic conventions](https://opentelemetry.io/docs/specs/semconv/http/http-metrics/) for ASP.NET Core. If inspecting `http://localhost:5011/metrics` shows different names (due to a package version change), adjust the dashboard queries accordingly.
