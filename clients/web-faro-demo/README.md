# Faro Web SDK demo

Standalone prototype, not a real MiiCel webapp — shows how `@grafana/faro-web-sdk` (Grafana's official browser RUM/telemetry SDK) integrates with this stack, since the user asked to see how that would look before deciding whether to adopt it for a real web app.

See "Frontend telemetry with Grafana Faro (web only)" in [OBSERVABILIDAD.md](../../OBSERVABILIDAD.md) for the full write-up, including why this doesn't extend to the React Native app (`clients/react-native-logger/` stays the mobile solution — see that section for why).

## Why this needs an extra piece: Alloy

Faro does **not** push to Loki directly. It posts to a *Faro receiver* — here, Grafana Alloy's `faro.receiver` component (`observability/alloy/config.alloy`), which then forwards to Loki. That's a new container (`alloy`, added to `docker-compose.observability.yml`) — bringing in Faro is a small infrastructure addition, not just an npm install / script tag.

## Running it

```bash
# 1. Make sure the stack (including the new alloy service) is up:
docker compose -f ../../docker-compose.observability.yml up -d

# 2. Serve this folder (opening index.html directly as a file:// URL won't
#    work — the browser needs a real origin for fetch/CORS):
python -m http.server 8090
```

Open `http://localhost:8090`, click **1. Initialize Faro**, then **2. Send an info log** and **3. Simulate a crash**. By default the page talks to the gateway's `/collect` route (`http://localhost:8081/collect`, `X-API-Key: dev-local-only-key`) — the same production-shaped, token-gated path the mobile app's logs already go through — not Alloy's port directly. The page's own log panel shows what was sent; check it actually landed with:

```bash
curl -s 'http://localhost:3200/loki/api/v1/query_range?query={app="miicel-web-demo"}' | python -m json.tool
```

You'll see the custom fields (`context_UserId`, `context_Service`, `context_Reason`, `context_CorrelationId`) alongside everything Faro captures automatically for free: web-vitals (FCP/FID/TTFB), browser/OS/session metadata, and — for the simulated crash — a full stack trace, with zero extra code beyond `pushError()`.

## Grafana dashboard

`observability/alloy/config.alloy` has a `loki.process` stage that relabels Faro's `app_name` field into a real `app="miicel-web-demo"` Loki stream label — the same convention the other services' dashboards already use. **MiiCel/Web Faro Demo** in Grafana has 5 panels: a note that this is a prototype, an LCP (Largest Contentful Paint) timeseries built entirely from Faro's automatic web-vitals capture (`max_over_time(... | unwrap value_lcp [$__interval])` — LogQL's `unwrap` needs a range-aggregation function wrapped around it, not just a bare log-stream expression), the errors-only view, all logs, and per-`UserId` audit (via `| logfmt | context_UserId=~"$userId"`, since Faro's own lines are logfmt-shaped, not JSON).

## What's real vs. prototype here

The **path** is production-shaped and fully wired: gateway route with its own token check and CORS handling (`observability/nginx/gateway.conf.template`'s `/collect` location), Alloy included in `docker-compose.production.yml` (loopback-only — only reachable through the gateway), a real Grafana dashboard. The network-simulation test (`tests/network-simulation/`) covers this route too (checks 6/7).

What's still a prototype: `index.html` itself, since there's no real MiiCel web app in these repos to wire Faro into — this is what a real one's setup would look like, not a real one.
