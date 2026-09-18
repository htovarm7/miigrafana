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
| `Reason` | a short, human-readable description of the failure. Business-exception text stays in whatever language it already is (Spanish, per the team's convention) — only field *names* and code comments are English | New/existing, standardized shape |
| `Service` | which process emitted the line: `miicel-api-users`, `miicel-api-management`, `miicel-api-workers`. Mirrors the existing Loki stream label (`app` in the `GrafanaLoki` sink config) as a queryable body field, so a LogQL query spanning multiple services doesn't have to rely on stream labels alone | New — implemented in Management via `Enrich.WithProperty("Service", ...)` in `Program.cs` |
| `CorrelationId` | ties every stage of ONE multi-step operation together, across services (an HTTP request that later continues inside a Temporal Worker). **Reuse an ID the flow already has** — e.g. `SaleGUID` (already on `PurchaseServicePlanCommand`/`SaleLogEntity`/`SaleAttemptEntity`) or `WorkflowId` (already on `RechargeCommand`). Never invent a new ID scheme for a flow that already carries one | New |

**Naming discipline matters here**: this table is intentionally exhaustive — don't add ad-hoc variants of these fields (`userid`, `UsuarioId`, `Action`, `Motivo`, etc.). If a new flow's failure doesn't fit cleanly into `Stage`/`Reason`, that's a sign that flow needs its own reviewed addition to this table, not a one-off field name invented on the spot.

**Why `Reason`, not `Message`**: Serilog already reserves a `Message` property for the fully-rendered log text. If your template literally uses `{Message}` as a custom property name, Serilog silently renames it to `_Message` in the emitted JSON to avoid clobbering its own field — confirmed against a real Loki query while building the example below. `Reason` sidesteps the collision entirely; use it, not `Message`.

### The rules

1. **One log line per failure.** Log it once, at the point that decides not to let the exception keep bubbling up unlogged. Never log the same exception again at a higher layer just because it's being rethrown or wrapped — that's exactly the 2-3-lines-per-error problem this project already fixed once (see the repository/service refactor on the `grafana-smoke-test` branch of `MiiCelBack`: catches that only logged-and-rethrew were removed, catches that swallow the exception were left alone since they're the only record of the failure).
2. **Log level**: `Warning` for an expected/business failure (a known validation rule, a known `MiiErrorCode`); `Error` for an unexpected/infrastructure failure (SQL, gRPC transport, an unhandled exception).
3. **`CorrelationId` before `Stage`.** If a flow doesn't have an ID that already threads through every stage, add that first — a `Stage` without a `CorrelationId` tells you *what* failed but not *which specific attempt*, so you can't reconstruct the full trace of one operation.

### A real, working example — try it right now

`GET /api/home/test-multistage` (Management API, `HomeController.cs`) is a live, working reference implementation of this pattern — not pseudo-code. It simulates a 3-stage flow (`ValidateUser` → `CallExternalService` → `PersistResult`), tags every line with `Stage`/`CorrelationId`/`UserId`/`Service`/`Reason`, and fails at whichever stage you ask it to:

```bash
curl "http://localhost:5011/api/home/test-multistage?userId=9001&failAt=CallExternalService"
# {"correlationId":"79d81dd8-...", "message":"Fallo simulado - busca este CorrelationId en Grafana/Loki..."}
```

Then, in Grafana → Explore → Loki:

```
{app="miicel-api-management"} | json | CorrelationId="79d81dd8-..."
```

returns exactly two lines: `Stage=ValidateUser` (Information, "Etapa ValidateUser completada") and `Stage=CallExternalService` (Error, "Etapa CallExternalService fallo", full exception attached) — `PersistResult` never ran, and there's no third, duplicate line from it further up the pipeline. Read `HomeController.cs`'s `TestMultiStage`/`RunStage` methods for exactly how it's wired — that's the checklist below made concrete.

### How to instrument a new flow (checklist)

This is deliberately generic — apply it to a service method, a Temporal Activity, or a gRPC/HTTP client call, whichever needs it next. The `PlaceOrder`/`ReservePayment` examples below are illustrative pseudo-code for cases `test-multistage` doesn't cover (a real business method, a Temporal Activity) — for the exact same pattern already running, see `test-multistage` above instead.

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
        _logger.LogError(ex, "{Reason}", "Failed to load customer");
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
        _logger.LogError(ex, "{Reason}", "Failed to reserve payment");
        return MiiResult<OrderResult>.Failure(MiiError.Get(MiiErrorCode.MiiCelUnknownError));
    }

    // ...remaining stages, same pattern
}
```

**Important**: if a stage's failure is allowed to keep propagating past this method unlogged (e.g. rethrown instead of converted into a `MiiResult` here), whoever catches it next won't see `Stage`/`CorrelationId` — those only live inside the `LogContext` scope that's still active at the point you log. Log inside the innermost scope that still has the full context, not after it's already bubbled out (`test-multistage`'s own controller action demonstrates exactly this: it catches the exception itself, right where `CorrelationId` is still in scope, instead of letting it become an unhandled 500 further up).

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
        _logger.LogError(ex, "{Reason}", "Failed to reserve payment in MiiPago");
        throw; // Temporal needs the exception to keep propagating to drive retries/compensation
    }
}
```

**3. `Stage` and `Service` don't need to be passed manually on every call** — push them into `LogContext` once, near the top of the method/activity being instrumented (`LogContext.PushProperty("Stage", nameof(ReservePayment))`), the same way `UserId`/`Endpoint` are already pushed once per HTTP request in `Program.cs`. `Service` doesn't need per-request pushing at all — add it once, for the whole process, via `.Enrich.WithProperty("Service", "miicel-api-workers")` in the `UseSerilog(...)` configuration call (exactly as done for Management — see `Program.cs`), since it never changes within one process.

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

### Where this applies next

`test-multistage` is a self-contained demo — it doesn't touch any real business flow. The purchase/recharge flow is the clearest real candidate to apply this to next: `PurchaseService.PurchaseServicePlan` (in `MiiCelBack`) currently wraps roughly ten stages (validate → load purchase info → load plan pricing → load store invoicing → call the Datalogic broker → execute the sale → post-process → reschedule the subscription) in one outer `try/catch`, collapsing every possible failure into a generic error. The Temporal `RechargeActivities` class already has each of those stages isolated as its own `[Activity]` method with an injected `ILogger` that's never actually called — that's the natural starting point, since the isolation this standard asks for already exists there, it just needs the logging calls added, following the exact same pattern as `test-multistage`.

## External ingestion: the token gateway

Everything above assumes the log's source is inside the trusted network (an ASP.NET Core request, a Temporal activity — all running on `MiiCelBack`'s own VM, reachable over the private Azure VNet). The React Native mobile app is different: it runs on whatever network the phone is on, so its logs — including crash reports — necessarily arrive over the **public internet**, not the VNet. That's the one case that needs a public endpoint, and the one case that needs an actual auth check instead of relying on network placement.

### Why only the gateway is public

Confirmed deployment model: MiiCelBack (.NET 8) runs on an Ubuntu VM with Docker; miigrafana gets its own VM in the **same/peered Azure VNet**, so VM-to-VM traffic (Prometheus scraping `/metrics`, MiiCelBack's Serilog sink shipping logs to Loki) stays on private IPs and never needs a token — placement on the private network *is* the access control for that traffic. The mobile app can't be placed on that private network, so it's the only caller that needs the public endpoint, and the only one that needs to prove who it is via a header.

Only one thing is public: a write-only nginx gateway in front of Loki's push API. Loki's query API, Prometheus, and Grafana's UI are never exposed publicly — the other VMs reach them over the VNet, and a human admin reaches Grafana over the WireGuard VPN (`grafana.miicaja.org` resolves to the VM's public IP via Cloudflare DNS, but the Azure NSG rule only accepts inbound connections from the WireGuard IP range — the name resolves, the connection doesn't, unless you're on the VPN).

```
Internet (React Native app) ──(public IP, X-API-Key required)──> [nginx gateway] ──> Loki :3100 (push only)
                                                                                          ▲
Other VMs in the VNet (private IP) ─────────────────────────────────────────────────────┘  (Prometheus scrape, Loki push — no token, private network only)
Admin (WireGuard VPN) ──(NSG allows only the VPN range)──> Grafana :3000
```

### How it works

`docker-compose.observability.yml`'s `gateway` service (nginx) proxies exactly one route, `POST /loki/api/v1/push` → `http://loki:3100/loki/api/v1/push`, and requires a `X-API-Key` header matching the `GATEWAY_API_KEY` env var — anything else gets `401`, and every other route (including Loki's own query API) is a flat `404` through this container; those stay reachable only on the private network. Loki's own config (`auth_enabled: false`) is untouched — the check lives entirely in the gateway, in front of it.

`docker-compose.production.yml` is the environment-specific overlay for the real VM: binds Loki/Prometheus/Grafana's ports to the VM's **private** IP (never the internet), publishes only `gateway` on the public interface, and hardens Grafana (`GF_AUTH_ANONYMOUS_ENABLED=false`, a real admin password). The WireGuard-range-only restriction on Grafana is an **Azure NSG rule**, not anything in this repo — the compose file only controls which interface a port binds to, not which source IPs may connect to it.

### How to add a new external source

Any external caller — any language, any stack, no Docker/VM of its own required — follows the same recipe: `POST` a Loki-shaped JSON body (`{"streams":[{"stream":{"app":"<service>","level":"..."},"values":[["<epoch-ns>","<json-encoded line>"]]}]}`) to the gateway with the `X-API-Key` header, using the field contract from the "Logging standard" section above (`UserId`, `Service`, `Reason`, `CorrelationId`, optional `Stage`). `clients/react-native-logger/logsTelemetry.ts` is the reference implementation — copy the pattern, not necessarily the file, for a different stack.

### Validating this locally, before any VM exists

`tests/network-simulation/` proves the model — public token gateway + network-restricted Grafana — with three local Docker networks standing in for the VNet, the WireGuard range, and the public internet. Run `bash tests/network-simulation/run-test.sh`; see that folder's README for what each of the 5 checks means and what a failure would indicate.

### What's not implemented here

- The actual Azure VM/VNet/WireGuard range/Cloudflare DNS record — infra done outside these repos.
- TLS on the public gateway — a real deployment should terminate HTTPS somewhere in front of it (Cloudflare, an Azure load balancer, or a cert on nginx itself), depending on how the rest of the Azure setup already handles TLS.
- Wiring `MiiCelBack`'s `appsettings.Production.json`/`.Staging.json` (neither exists yet) to point at miigrafana's private IP — flagged as a prerequisite for whoever deploys `MiiCelBack` to that VM, not implemented in this repo.

## Frontend telemetry with Grafana Faro (web only)

[Grafana Faro](https://github.com/grafana/faro-web-sdk) is Grafana's own browser RUM (real user monitoring) SDK — worth knowing about since it does, for free, a lot of what `clients/react-native-logger/logsTelemetry.ts` does by hand: structured logs/errors with full stack traces, plus things that library doesn't attempt at all (web-vitals, session/browser metadata, automatic fetch/XHR correlation). Two facts decided how far this goes right now:

**Faro doesn't push to Loki directly.** It posts to a *Faro receiver*, normally Grafana Alloy's `faro.receiver` component, which then forwards to Loki. So adopting Faro for a web app means running Alloy as an additional container, not just adding a script tag — see `observability/alloy/config.alloy` and the `alloy` service in `docker-compose.observability.yml`.

**There is an experimental React Native port** (`@grafana/faro-react-native`, [grafana/faro-react-native-sdk](https://github.com/grafana/faro-react-native-sdk)), but it requires native modules (CocoaPods/Gradle autolinking) and the project itself is labeled experimental. `logsTelemetry.ts` is already built, dependency-free, and verified working end-to-end — it stays the mobile solution. Faro for React Native is a future option to revisit once the port matures, not something to swap in now for something that already works.

**So, for now**: Faro is a web-only prototype, but it goes through the real production-shaped path end to end: `clients/web-faro-demo/` (not a real MiiCel webapp — there isn't one in these repos) → the gateway's `/collect` route (`X-API-Key`-gated, same as the mobile app's route) → Alloy's `faro.receiver` → a `loki.process` relabeling stage (promotes Faro's `app_name` field to a real `app` stream label, matching the convention every other dashboard already relies on) → Loki, tagging custom context with the same `UserId`/`Service`/`Reason`/`CorrelationId` fields as everything else, on top of everything Faro captures automatically. See that folder's README for how to run it.

The `/collect` route needed its own CORS handling that `/loki/api/v1/push` doesn't — it's called from an actual browser on a different origin, so the preflight `OPTIONS` request (which never carries the app's custom headers, including the ones Faro's own SDK adds internally like `X-Faro-Session-Id`) has to be answered with `Access-Control-Allow-Headers: *` before the token check runs, and the actual proxied response must **not** also add `Access-Control-Allow-Origin` itself since Alloy already sets it — doing both duplicates the header and browsers reject it outright. Both were real bugs hit while building this, not hypothetical — see the comments in `observability/nginx/gateway.conf.template`.

**MiiCel/Web Faro Demo** (Grafana folder) has a working dashboard: errors, all logs, per-`UserId` audit, plus a Largest Contentful Paint timeseries built entirely from Faro's automatic web-vitals capture — nothing our own manual `UserId`/`Stage`/`Reason` approach gets you, it's what Faro adds on top for free.

`docker-compose.production.yml` publishes Alloy on `127.0.0.1` only (loopback) — the gateway reaches it over the internal Docker network regardless of that binding, so the `/collect` route is the *only* way anything outside the container network can reach it, same principle as Loki behind `/loki/api/v1/push`.

## Alerting: Slack as a contact point

### What to request from whoever owns the Slack workspace

Ask for an **Incoming Webhook URL** for a specific channel (name it, e.g. `#miicel-alertas`) — not a bot token. They get it from [api.slack.com/apps](https://api.slack.com/apps) → their Slack app → **Incoming Webhooks** → **Add New Webhook to Workspace** → pick the channel → copy the URL (`https://hooks.slack.com/services/...`). This is the simplest option: one URL, already scoped to one channel, nothing to negotiate on OAuth scopes. Grafana also supports a bot-token method (`Recipient` = channel ID + `Token` = `xoxb-...` bot token) if the team already has a Slack app with `chat:write` installed, but the webhook is less setup for the same result.

### How it's configured

`observability/grafana/provisioning/alerting/contact-points.yaml` provisions a Slack contact point named "Slack - MiiCel alerts", reading the webhook URL from the `SLACK_WEBHOOK_URL` environment variable via Grafana's own **native** `$variable` interpolation in provisioning files (confirmed against the current Grafana docs — no custom templating/envsubst step needed here, unlike the nginx gateway's config). Set the real value in whichever `docker-compose.*.yml`'s `grafana` service environment, or a `.env` file — never commit the real webhook URL.

**A real gotcha found while building this**: if `SLACK_WEBHOOK_URL` is unset/empty, Grafana doesn't just skip the contact point — it **refuses to start entirely**, because its Slack integration validation requires a `recipient` whenever `url` resolves to empty (the "Slack chat API" path). `docker-compose.observability.yml` defaults `SLACK_WEBHOOK_URL` to a syntactically valid but non-functional placeholder (`https://hooks.slack.com/services/PLACEHOLDER/PLACEHOLDER/PLACEHOLDER`) specifically to avoid this — Grafana starts fine, the contact point just 404s until the real URL replaces it.

### How to test it, and how to actually use it

In Grafana → **Alerting** → **Contact points** → "Slack - MiiCel alerts" → **Test** sends a real test notification through it — the fastest way to confirm the webhook URL is correct. To actually route alerts there, either set it as the default in **Notification policies**, or select it per alert rule. No alert rules are provisioned in this repo yet — that's a separate, later step once there's something worth alerting on (e.g. the error-rate panels already in the Management/Users dashboards).
