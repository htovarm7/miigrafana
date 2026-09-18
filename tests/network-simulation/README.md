# Network segmentation simulation

Proves the planned Azure access model locally, before any VM/VNet/WireGuard range exists. See "External ingestion: the token gateway" in [OBSERVABILIDAD.md](../../OBSERVABILIDAD.md) for the full design this simulates.

## What each local network stands in for

| Local Docker network | Stands in for | Who's allowed to reach what |
|---|---|---|
| `net-vnet-sim` | The Azure VNet (other MiiCelBack VMs + miigrafana's own services) | Full access to Loki/Grafana directly — no token, private-network traffic |
| `net-vpn-sim` | WireGuard-connected admin clients | Grafana only |
| `net-public-sim` | The public internet (the React Native app, or anyone else) | Only the gateway's push endpoint, and only with a valid token |

Two different access-control mechanisms are being tested — that's the actual point, not just "three networks":

- **Gateway (Loki push, and now the Faro `/collect` route too)**: reachable from anywhere, gated by the `X-API-Key` header (application-layer auth) — a phone or a browser on the public internet can't be restricted by source IP, so this is the mechanism that has to work regardless of network.
- **Grafana**: reachable only from `net-vpn-sim`'s subnet, via the `grafana-gate` nginx container's `allow`/`deny` rules — network-layer auth, standing in for the real Azure NSG rule that will only permit the WireGuard IP range.

## Running it

```bash
bash run-test.sh
```

Brings up the simulation, runs `curl` from throwaway containers attached to each network, prints `PASS`/`FAIL` for 7 checks, tears everything down, and exits non-zero if anything failed.

## What a failure would mean

- Check 1 or 2 failing → the gateway's Loki-push token check itself is broken (fix `observability/nginx/gateway.conf.template` first — this is shared with the real `docker-compose.observability.yml`).
- Check 3 failing → the VPN range can't reach Grafana at all — the real WireGuard clients wouldn't be able to use the dashboard.
- Check 4 failing → the public internet CAN reach Grafana — this is the dangerous one; it means the Azure NSG rule (or, in this simulation, `nginx/grafana-gate.conf`'s `allow` CIDR) isn't actually restricting anything.
- Check 5 failing → Loki's query API is reachable from outside the trusted network entirely, bypassing the gateway — also dangerous, means log data could be read by anyone.
- Check 6 or 7 failing → same as 1/2 but for the `/collect` route (Grafana Faro, added alongside the web demo) — check the `location = /collect` block in `gateway.conf.template` specifically, since it has its own CORS-preflight handling that the Loki-push route doesn't need.

## What this doesn't test

- TLS — the real gateway should sit behind HTTPS in production; this simulation is plain HTTP throughout, since it's only testing reachability/access-control logic, not transport security.
- The actual Azure NSG, VNet peering, or WireGuard setup — those are configured in Azure, not here. This only proves the *model* (one public token-gated endpoint, everything else network-restricted) is sound before spending time wiring the real infrastructure.
