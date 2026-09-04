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

## Logging standard: per-user, per-stage audit fields

Today's logging already tags every HTTP request in `MiiCel.Api.Users`/`MiiCel.Api.Management` with `UserId` and `Endpoint` (via Serilog `LogContext`), and a repo/service/controller failure is reduced to a single log line instead of one per layer. That answers "did user X hit an error", but not the question the team actually needs answered: **which step of a multi-step flow broke** — e.g. a purchase fails: was it validation, the MiiIdentidad lookup, the MiiPago reservation, the Datalogic broker call, or the database write?

This section defines the standard field set and rules for that — a **pattern to apply to any multi-step service method, gRPC/HTTP client call, or Temporal workflow/activity**, not a one-off for any single flow. It's written so it can be implemented incrementally, one method at a time, without a big-bang rewrite.

### The field contract

Every audit log line — whatever service or layer emits it — uses exactly these field names, PascalCase, English:

| Field | Meaning | Status |
|---|---|---|
| `UserId` | the user whose request/action this is | Already implemented (HTTP `LogContext.PushProperty` in both APIs) |
| `Endpoint` | the HTTP route that was called | Already implemented |
| `Stage` | which step of a multi-step flow failed — the name of the method/activity being instrumented (e.g. `GetSaleInfoFromBroker`, `ValidateAndReservePayment`). No enum needed, the method name as a plain string is enough | New — apply when instrumenting a multi-step flow |
| `Message` | a short, human-readable description of the failure. Business-exception text stays in whatever language it already is (Spanish, per the team's convention) — only field *names* and code comments are English | New/existing, standardized shape |
| `Service` | which process emitted the line: `miicel-api-users`, `miicel-api-management`, `miicel-api-workers`. Mirrors the existing Loki stream label (`app` in the `GrafanaLoki` sink config) as a queryable body field, so a LogQL query spanning multiple services doesn't have to rely on stream labels alone | New |
| `CorrelationId` | ties every stage of ONE multi-step operation together, across services (an HTTP request that later continues inside a Temporal Worker). **Reuse an ID the flow already has** — e.g. `SaleGUID` (already on `PurchaseServicePlanCommand`/`SaleLogEntity`/`SaleAttemptEntity`) or `WorkflowId` (already on `RechargeCommand`). Never invent a new ID scheme for a flow that already carries one | New |

**Naming discipline matters here**: this table is intentionally exhaustive — don't add ad-hoc variants of these fields (`userid`, `UsuarioId`, `Action`, `Motivo`, etc.). If a new flow's failure doesn't fit cleanly into `Stage`/`Message`, that's a sign that flow needs its own reviewed addition to this table, not a one-off field name invented on the spot.

### The rules

1. **One log line per failure.** Log it once, at the point that decides not to let the exception keep bubbling up unlogged. Never log the same exception again at a higher layer just because it's being rethrown or wrapped — that's exactly the 2-3-lines-per-error problem this project already fixed once (see the repository/service refactor on the `grafana-smoke-test` branch of `MiiCelBack`: catches that only logged-and-rethrew were removed, catches that swallow the exception were left alone since they're the only record of the failure).
2. **Log level**: `Warning` for an expected/business failure (a known validation rule, a known `MiiErrorCode`); `Error` for an unexpected/infrastructure failure (SQL, gRPC transport, an unhandled exception).
3. **`CorrelationId` before `Stage`.** If a flow doesn't have an ID that already threads through every stage, add that first — a `Stage` without a `CorrelationId` tells you *what* failed but not *which specific attempt*, so you can't reconstruct the full trace of one operation.

### How to instrument a new flow (checklist)

This is deliberately generic — apply it to a service method, a Temporal Activity, or a gRPC/HTTP client call, whichever needs it next. The two examples below are illustrative pseudo-code, not real files in this codebase.

**1. A multi-step service method** — wrap each stage in its own `catch`, not one catch around the whole method:

```csharp
// Illustrative example — not a real file. Each stage gets its own catch instead
// of one try/catch around the whole method, so a failure is tagged with exactly
// which stage it happened in.
public async Task<MiiResult<OrderResult>> PlaceOrder(PlaceOrderCommand command)
{
    var correlationId = command.OrderGuid; // reuse an ID the flow already has

    Customer customer;
    try
    {
        customer = await _customerRepository.GetById(command.CustomerId);
    }
    catch (Exception ex)
    {
        _logger.LogError(ex, "{Message}",
            "Failed to load customer for order {OrderGuid}"); // Message field
        // Stage/Service/UserId/CorrelationId come from LogContext — see step 3
        return MiiResult<OrderResult>.Failure(MiiError.Get(MiiErrorCode.MiiCelUnknownError));
    }

    Payment payment;
    try
    {
        payment = await _paymentGrpcClient.Reserve(command.PaymentInfo);
    }
    catch (Exception ex)
    {
        _logger.LogError(ex, "{Message}", "Failed to reserve payment");
        return MiiResult<OrderResult>.Failure(MiiError.Get(MiiErrorCode.MiiCelUnknownError));
    }

    // ...remaining stages, same pattern
}
```

**2. A Temporal Activity** — push `CorrelationId` (and `UserId`, if the activity's input carries it) into `LogContext` at the top, so every log line inside that activity — including ones from repositories/clients it calls — picks it up automatically, then log once on failure:

```csharp
// Illustrative example.
[Activity]
public async Task<PaymentResult> ReservePayment(ReservePaymentInput input)
{
    using var _ = LogContext.PushProperty("CorrelationId", input.SaleGuid);
    using var __ = LogContext.PushProperty("UserId", input.UserId);

    try
    {
        return await _paymentGrpcClient.Reserve(input.PaymentInfo);
    }
    catch (Exception ex)
    {
        _logger.LogError(ex, "{Message}", "Failed to reserve payment in MiiPago");
        throw; // Temporal needs the exception to keep propagating to drive retries/compensation
    }
}
```

**3. `Stage` and `Service` don't need to be passed manually on every call** — push them into `LogContext` once, near the top of the method/activity being instrumented (`LogContext.PushProperty("Stage", nameof(ReservePayment))`), the same way `UserId`/`Endpoint` are already pushed once per HTTP request in `Program.cs`. `Service` can be pushed once at startup (`LogContext.PushProperty("Service", "miicel-api-workers")`), since it never changes within one process.

### A note on today's inconsistency between Users and Management

Investigating the current setup surfaced one thing worth fixing whenever this standard gets applied: `MiiCel.Api.Management`'s `ErrorHandlingMiddleware` deliberately does **not** log — it relies on `UseSerilogRequestLogging`'s own completion line (which already carries the exception when one occurred) to be the single audit line. `MiiCel.Api.Users`'s `ErrorHandlingMiddleware`, instead, logs explicitly inside itself for each exception type it handles. Both currently produce one line per failure — via two different mechanisms. Pick one and use it consistently for any new middleware/handler; the recommendation is Management's approach (rely on the request-completion line) for pure HTTP failures, since it already gets `RequestMethod`/`StatusCode`/`Elapsed` for free — but an explicit call is unavoidable for non-HTTP contexts (Temporal activities, background jobs) which have no request-completion line to rely on.

### LogQL examples (once a flow has `Stage`/`CorrelationId`/`Service`)

```
# Every error for one user, any service
{app=~".+"} | json | level="error" | UserId="8842"

# Full stage-by-stage trace of one specific operation (e.g. one purchase attempt)
{app=~".+"} | json | CorrelationId="3f2a1c9e-..."

# Every past failure of one specific stage, across all users — e.g. "is MiiPago reservation flaky?"
{app=~".+"} | json | Stage="ValidateAndReservePayment" | level="error"

# Cross-service search without relying on Loki stream labels
{app=~".+"} | json | Service="miicel-api-workers" | level="error"
```

### Where this applies first

The purchase/recharge flow is the clearest real candidate — `PurchaseService.PurchaseServicePlan` (in `MiiCelBack`) currently wraps roughly ten stages (validate → load purchase info → load plan pricing → load store invoicing → call the Datalogic broker → execute the sale → post-process → reschedule the subscription) in one outer `try/catch`, collapsing every possible failure into a generic error. The Temporal `RechargeActivities` class already has each of those stages isolated as its own `[Activity]` method with an injected `ILogger` that's never actually called — that's the natural starting point, since the isolation this standard asks for already exists there, it just needs the logging calls added. Neither is changed by this document; this is the reference for whoever picks that work up next.
