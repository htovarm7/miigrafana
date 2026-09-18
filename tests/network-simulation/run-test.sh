#!/usr/bin/env bash
# Brings up the local network-segmentation simulation, runs curl from
# ephemeral containers on each simulated network, and prints PASS/FAIL for
# each check described in README.md. Exits non-zero if anything fails.

set -u
cd "$(dirname "$0")"

PROJECT="miigrafana-nettest"
CURL_IMAGE="curlimages/curl:8.10.1"
FAILURES=0

net() { echo "${PROJECT}_$1"; }

pass_fail() {
  local label="$1" expected="$2" actual="$3"
  if [ "$actual" = "$expected" ]; then
    echo "PASS  $label (expected $expected, got $actual)"
  else
    echo "FAIL  $label (expected $expected, got $actual)"
    FAILURES=$((FAILURES + 1))
  fi
}

echo "== Starting the network simulation =="
docker compose -p "$PROJECT" -f docker-compose.test.yml up -d
echo "Waiting for services to settle..."
sleep 12

echo ""
echo "== Running checks =="

# 1. Gateway + valid token, from the public network -> Loki accepts it (204).
CODE=$(docker run --rm --network "$(net net-public-sim)" "$CURL_IMAGE" \
  -s -o /dev/null -w '%{http_code}' -X POST "http://gateway:8080/loki/api/v1/push" \
  -H 'Content-Type: application/json' -H 'X-API-Key: network-sim-key' \
  -d '{"streams":[{"stream":{"app":"net-sim-check"},"values":[["'"$(date +%s%N)"'","{\"Reason\":\"network sim check\"}"]]}]}')
pass_fail "1. gateway + valid token, from public network" "204" "$CODE"

# 2. Gateway + missing token, from the public network -> rejected (401).
CODE=$(docker run --rm --network "$(net net-public-sim)" "$CURL_IMAGE" \
  -s -o /dev/null -w '%{http_code}' -X POST "http://gateway:8080/loki/api/v1/push" \
  -H 'Content-Type: application/json' -d '{"streams":[]}')
pass_fail "2. gateway + missing token, from public network" "401" "$CODE"

# 3. Grafana (via the gate), from the VPN network -> allowed through.
CODE=$(docker run --rm --network "$(net net-vpn-sim)" "$CURL_IMAGE" \
  -s -o /dev/null -w '%{http_code}' "http://grafana-gate:3000/login")
pass_fail "3. grafana via gate, from VPN network" "200" "$CODE"

# 4. Grafana (via the gate), from the public network -> blocked (403).
CODE=$(docker run --rm --network "$(net net-public-sim)" "$CURL_IMAGE" \
  -s -o /dev/null -w '%{http_code}' "http://grafana-gate:3000/login")
pass_fail "4. grafana via gate, from public network" "403" "$CODE"

# 5. Loki direct from the public network must not resolve (curl exit != 0).
docker run --rm --network "$(net net-public-sim)" "$CURL_IMAGE" \
  -s -o /dev/null "http://loki:3100/loki/api/v1/query?query=%7Bapp%3D%22x%22%7D" >/dev/null 2>&1
EXIT_CODE=$?
if [ "$EXIT_CODE" -ne 0 ]; then
  echo "PASS  5. loki direct, from public network (unreachable, curl exit $EXIT_CODE)"
else
  echo "FAIL  5. loki direct, from public network (expected unreachable, but curl succeeded)"
  FAILURES=$((FAILURES + 1))
fi

echo ""
echo "== Tearing down =="
docker compose -p "$PROJECT" -f docker-compose.test.yml down

echo ""
if [ "$FAILURES" -eq 0 ]; then
  echo "All checks passed."
else
  echo "$FAILURES check(s) failed."
fi
exit "$FAILURES"
