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

Open `http://localhost:8090`, click **1. Initialize Faro**, then **2. Send an info log** and **3. Simulate a crash**. The page's own log panel shows what was sent; check it actually landed with:

```bash
curl -s 'http://localhost:3200/loki/api/v1/query_range?query={service_name=~".+"}|="miicel-web-demo"' | python -m json.tool
```

You'll see the custom fields (`context_UserId`, `context_Service`, `context_Reason`, `context_CorrelationId`) alongside everything Faro captures automatically for free: web-vitals (FCP/FID/TTFB), browser/OS/session metadata, and — for the simulated crash — a full stack trace, with zero extra code beyond `pushError()`.

## Known gap: not yet labeled like the other dashboards

The other services' logs use an `app="miicel-api-management"`-style Loki stream label, which the existing dashboards filter on. This demo's logs currently land under Loki's default `service_name="unknown_service"` label instead, since `observability/alloy/config.alloy` doesn't yet relabel Faro's `app_name` field into a proper `app` stream label. Fine for proving the integration works (which is what this demo is for) — but adding a dedicated web-app Grafana dashboard later needs that relabeling step added to the Alloy config first.

## Not done here (prototype only)

- No public route through `observability/nginx/gateway.conf.template` — Alloy's port is only reachable locally. A real public web app would need its own gated route, same idea as the mobile app's, added deliberately rather than reusing the existing `/loki/api/v1/push` route (which the network-segmentation test asserts is the *only* thing the gateway proxies).
- Not added to `docker-compose.production.yml`.
- No Grafana dashboard for this source yet (see the labeling gap above).
