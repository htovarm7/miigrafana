# Observability — MiiCel Back

## Context and motivation

Today, to find out if something is failing in production, you have to:

1. SSH into the server where the production `docker-compose` runs.
2. Go into each container one by one (`miicel-api-users`, `miicel-api-management`, `miicel-api-workers`) and check `Logs/*.log` or `docker logs`.
3. Manually correlate what happened, because there's no way to see "which endpoint is slow" or "how many recharges are failing" without reading logs one by one.

This doesn't scale: there's no way to know **which part of the system the problem is in** (API Users? Management? the Temporal Worker? the gRPC call to MiiIdentidad/MiiPago? Datalogic?) without blindly going into each container. There are also no alerts — an error is only discovered if someone looks for it or if an end user reports the failure.

**Goal**: have a single dashboard, reachable only over the internal VPN (the same network where SQL Server, MiiIdentidad, and MiiPago already live — `192.168.42.x` IPs), that answers three questions without needing SSH:

- Which service/endpoint is failing or slow **right now**? (metrics)
- What exactly happened on that request/recharge? (logs)
- Where in the Controller → Service → gRPC/SQL → Temporal chain did it break? (traces)

## Why Grafana (Loki + Prometheus + Grafana) and not just Seq

| | Seq | Grafana Loki + Prometheus + Grafana |
|---|---|---|
| What it covers | Logs only | Logs + metrics + alerts (+ traces if Tempo is added) |
| Answers "which part of the system has the problem" | Not directly, you have to infer it by reading logs | Yes — the metrics dashboard points at the service/endpoint before reading a single log |
| Fits the current architecture | Yes (Serilog is already in place) | Yes (everything is Docker Compose, same `miivida_vnet` network) |
| License | Free with limits, paid afterward | 100% open source |
| Alerts | Paid plan only | Native and free |

Seq fixes the symptom (scattered logs) but not the team's real question: "where is the problem?". That question is answered by a metrics view, which Seq doesn't have. That's why the proposal is to go straight to the Grafana stack instead of implementing Seq as an intermediate step.

## What each piece gives us

- **Loki** — log aggregation for the 4 services (Users, Management, Workers, and optionally Console) in one searchable place. Receives logs via a Serilog sink, without changing the format already in use.
- **Prometheus** — time-series metrics: latency per endpoint, HTTP error rate, health of the gRPC connections to MiiIdentidad/MiiPago, custom counters (successful/failed recharges, in-flight Temporal workflows).
- **Grafana** — the single dashboard that ties together logs + metrics (+ traces if Tempo is added later) and lets you configure alerts (e.g. "error rate > 5% over 5 minutes" → notification).

This isn't about replacing Serilog or the current logging architecture — it adds an additional destination (`WriteTo`) and a new metrics layer.

## Proposed architecture

Everything runs as additional services inside the same `docker-compose.production.yml`, on the existing `miivida_vnet` network (external), same as Users/Management/Workers today:

```
miivida_vnet (internal network, same one SQL/gRPC/Temporal already use)
├── miicel-api-users        (existing)
├── miicel-api-management   (existing)
├── miicel-api-workers      (existing)
├── loki                    (new — receives logs)
├── prometheus               (new — scrapes metrics from /metrics)
└── grafana                  (new — dashboard, VPN-only access)
```

**VPN-only access**: the Grafana container does not publish a port to `0.0.0.0`. It binds only to the server's internal VPN IP, the same pattern already used for SQL Server and the gRPC services:

```yaml
grafana:
  image: grafana/grafana-oss:latest
  networks:
    - miivida_vnet
  ports:
    - "192.168.42.X:3000:3000"   # only reachable from inside the VPN
```

Nothing new to learn networking-wise — it's the same scheme already followed for everything else.

## Code changes

### 1. Logs → Loki (low effort)

Add the `Serilog.Sinks.Grafana.Loki` sink (NuGet) and an additional `WriteTo` entry in `appsettings.{Environment}.json` for each of the 4 executable projects, alongside the existing `Console`/`File` sinks:

```json
{
  "Name": "GrafanaLoki",
  "Args": {
    "uri": "http://loki:3100",
    "labels": [
      { "key": "app", "value": "miicel-api-management" },
      { "key": "env", "value": "production" }
    ]
  }
}
```

Doesn't require touching `Program.cs` or `ServiceCollectionExtension.cs` — Serilog is already configured from `appsettings`.

### 2. Metrics → Prometheus (medium effort)

In each `Program.cs` for Users/Management/Workers, add `OpenTelemetry.Extensions.Hosting` + `OpenTelemetry.Exporter.Prometheus.AspNetCore`:

```csharp
builder.Services.AddOpenTelemetry()
    .WithMetrics(m => m
        .AddAspNetCoreInstrumentation()
        .AddRuntimeInstrumentation()
        .AddPrometheusExporter());

app.MapPrometheusScrapingEndpoint(); // exposes /metrics
```

Register the `map` in `ServiceCollectionExtension.cs` if you want it centralized, or inline in each `Program.cs` (they're thin shells, so that's fine there too).

### 3. Traces (optional, later phase)

Add `OpenTelemetry.Instrumentation.AspNetCore` + `.GrpcClient` + `.SqlClient` to automatically capture Controller → gRPC (MiiIdentidad/MiiPago) → Dapper without manually instrumenting every service method. To correlate with Temporal, use the `WorkflowId` as a structured field in `RechargeWorkflow`/`RechargeActivities` logs.

### 4. Health checks (complementary)

`GET /api/home/ping` already exists. It can be enriched with `AspNetCore.HealthChecks.SqlServer` and a custom check for the gRPC channel, so Prometheus/Grafana can show SQL and external dependency health separately from the generic "up/down" status.

## Implementation plan (phases)

1. **Phase 1 — Centralized logs**: stand up Loki + Grafana in the production compose, add the Serilog sink to the 4 projects. Immediate result: stop SSHing in to read logs.
2. **Phase 2 — Metrics**: add Prometheus + OpenTelemetry instrumentation in Users/Management/Workers. Result: a dashboard with latency/errors per service, foundation for alerts.
3. **Phase 3 — Alerts**: configure rules in Grafana (e.g. error rate, service down, failed health check) with notifications (Slack/email/Telegram).
4. **Phase 4 (optional) — Traces**: add Tempo + trace instrumentation to correlate Controller → gRPC → SQL → Temporal in a single view.

Each phase is incremental and doesn't block the next ones — the team can stop after Phase 1 or 2 if that's decided to be enough for now.

## Resource impact

Loki + Prometheus + Grafana are lightweight compared to an ELK stack; on a server with the 4 GB RAM / 2 vCore already documented as a requirement in `README.md`, it's viable, though it's worth monitoring Prometheus/Loki disk usage (configurable retention, e.g. 15-30 days) to avoid filling up the 64 GB SSD.
