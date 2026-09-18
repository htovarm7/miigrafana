# Network simulation

Validates the access model locally: only the gateway is public (token required), Grafana is reachable only from the VPN range, Loki is private.

```bash
bash run-test.sh
```

| # | Check | Expected |
|---|---|---|
| 1 | Public → gateway push, valid token | 204 |
| 2 | Public → gateway push, no token | 401 |
| 3 | VPN → Grafana | 200 |
| 4 | Public → Grafana | 403 |
| 5 | Public → Loki direct | unreachable |

If 4 or 5 fail, something private is exposed: check `nginx/grafana-gate.conf` (simulated NSG rule) and which networks Loki is attached to.
