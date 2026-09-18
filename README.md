# miigrafana

Grafana + Loki + Prometheus for MiiCel Back. Standalone repo; no changes to `MiiCelBack` are needed to start it.

## Structure

```
docker-compose.observability.yml   Base stack: gateway, loki, prometheus, grafana
docker-compose.production.yml      Production overlay (bind to private IP, no anonymous login)
observability/
  loki/loki-config.yml             Loki storage + 90-day retention
  prometheus/prometheus.yml        Scrape targets (one job per API)
  nginx/gateway.conf.template      Public gateway: only POST /loki/api/v1/push with X-API-Key
  grafana/
    provisioning/datasources/      Prometheus + Loki datasources (uids: prometheus, loki)
    provisioning/dashboards/       One provider/folder per service
    dashboards/<service>/*.json    Dashboards: management, users, mobile-app
clients/react-native-logger/       Logger to copy into the mobile app
tests/network-simulation/          Local check of the public/VPN/private access model
```

## Run

```bash
docker network create miivida_vnet   # once; shared with MiiCelBack
docker compose -f docker-compose.observability.yml up -d
```

| Service | URL |
|---|---|
| Grafana | http://localhost:3000 (anonymous admin, local only) |
| Prometheus | http://localhost:9090 |
| Loki | http://localhost:3200 (host port; `loki:3100` inside Docker) |
| Gateway | http://localhost:8081 |

## Connect a MiiCel API

Each API needs three changes.

**1. Packages**: `Serilog.Sinks.Grafana.Loki`, `OpenTelemetry.Extensions.Hosting`, `OpenTelemetry.Instrumentation.AspNetCore`, `OpenTelemetry.Instrumentation.Runtime`, `OpenTelemetry.Exporter.Prometheus.AspNetCore`.

**2. Logs → Loki**: add a sink to `Serilog:WriteTo` in `appsettings.{Environment}.json` (and `"Enrich": ["FromLogContext"]`).

```json
{
  "Name": "GrafanaLoki",
  "Args": {
    "uri": "http://localhost:3200",
    "labels": [
      { "key": "app", "value": "miicel-api-management" },
      { "key": "env", "value": "development" }
    ]
  }
}
```

`uri`: `http://localhost:3200` when the API runs with `dotnet run`; `http://loki:3100` when it runs in Docker on `miivida_vnet`; `http://<PRIVATE_IP>:3100` from another VM. The `app` label must match the dashboard queries (`{app="miicel-api-management"}`).

**3. Metrics → Prometheus** in `Program.cs`:

```csharp
builder.Services.AddOpenTelemetry().WithMetrics(m => m
    .AddAspNetCoreInstrumentation().AddRuntimeInstrumentation().AddPrometheusExporter());
app.MapPrometheusScrapingEndpoint(); // GET /metrics
```

Then set the API's host/port in `observability/prometheus/prometheus.yml` (`host.docker.internal:<port>` for `dotnet run`, `<compose-service>:8080` in Docker).

### Log fields

Dashboards and audit queries expect these JSON fields on each log line. Use the exact names.

| Field | Meaning |
|---|---|
| `UserId` | User of the request (JWT `NameIdentifier`), set via Serilog `LogContext` |
| `Endpoint` | Route called |
| `Service` | `miicel-api-users`, `miicel-api-management`, ... |
| `Stage` | Step of a multi-step flow that failed (optional) |
| `Reason` | Short failure description |
| `CorrelationId` | Ties all lines of one operation together (reuse `SaleGUID` / `WorkflowId`) |

Log each failure once (don't re-log when rethrowing). Set `Microsoft.AspNetCore` to `Warning` and skip `/metrics` request logs to keep noise down.

```
{app="miicel-api-management"} | json | level="error" | UserId="8842"
{app=~".+"} | json | CorrelationId="<id>"
```

## Mobile app / external sources

The gateway is the only public endpoint. Send Loki push JSON to `POST /loki/api/v1/push` with header `X-API-Key: <GATEWAY_API_KEY>`. See [clients/react-native-logger](clients/react-native-logger/README.md).

## Production

Create `.env` next to the compose files:

```
PRIVATE_IP=<VM private IP>
GATEWAY_API_KEY=<secret>
GRAFANA_ADMIN_PASSWORD=<secret>
```

```bash
docker compose -f docker-compose.observability.yml -f docker-compose.production.yml up -d
```

Loki, Prometheus and Grafana bind to `PRIVATE_IP` only; the gateway is the only public port (put TLS in front of it). Restricting Grafana to the VPN range is an Azure NSG rule, not part of this repo. Verify the model locally with `bash tests/network-simulation/run-test.sh`.

## Troubleshooting

- **`network miivida_vnet not found`**: `docker network create miivida_vnet`.
- **Port `3100` forbidden (Windows)**: the host port is already remapped to `3200`; check `netsh interface ipv4 show excludedportrange protocol=tcp` for other conflicts.
- **Prometheus target DOWN**: open http://localhost:9090/targets; check the port in `prometheus.yml` and that `GET /metrics` responds on the API.
- **No logs in Loki**: check the sink `uri` for where the API runs; Loki down never breaks the API, it just drops the logs. Test with `curl http://localhost:3200/ready`.
- **No metrics in dashboards**: metric names (`http_server_request_duration_seconds_*`) depend on the OpenTelemetry package version; compare with the API's `/metrics` output.
- **Gateway returns 401**: `X-API-Key` doesn't match `GATEWAY_API_KEY`.
- **Old logs disappear**: retention is 90 days (`limits_config.retention_period` in `loki-config.yml`).
