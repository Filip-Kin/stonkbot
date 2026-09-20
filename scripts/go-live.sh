#!/usr/bin/env bash
# Cut the bot over from the paper book to the funded live Alpaca account and
# reset the scoreboard so the live run starts from zero.
#
#   ./scripts/go-live.sh <LIVE_KEY_ID> <LIVE_SECRET_KEY>
#
# Live keys come from app.alpaca.markets, NOT the paper dashboard, and their ids
# do not start with PK. Nothing is written to the repo: the keys go into Coolify's
# env and the gitignored .env only.
#
# Order matters. The account is checked and locked down BEFORE any env is touched,
# so a bad key or an unfunded account aborts with the bot still running on paper.
set -euo pipefail

KEY_ID="${1:-}"
SECRET="${2:-}"
[ -n "$KEY_ID" ] && [ -n "$SECRET" ] || { echo "usage: $0 <LIVE_KEY_ID> <LIVE_SECRET_KEY>" >&2; exit 2; }

REPO="/media/nas/filip/ncdata/filip/files/Projects/stonkbot"
DATA="/data/stonkbot"
APP_UUID="vrhrm4bdzswviluapy481pgh"
PANEL="https://panel.filipkin.com/api/v1"
LIVE_URL="https://api.alpaca.markets"
AUTH="Authorization: Bearer $(grep -oP 'COOLIFY_TOKEN=\K.*' "$HOME/.stonkbot-deploy" 2>/dev/null || echo "${COOLIFY_TOKEN:-}")"
alp() { curl -fsS "$LIVE_URL$1" -H "APCA-API-KEY-ID: $KEY_ID" -H "APCA-API-SECRET-KEY: $SECRET" "${@:2}"; }

# --- 1. the account must be real, live and funded -------------------------------
echo "==> checking the live account"
ACCT=$(alp /v2/account)
python3 - "$ACCT" <<'PY'
import json,sys
a=json.loads(sys.argv[1])
print(f"    {a['account_number']}  status={a['status']}  equity=${a['equity']}  cash=${a['cash']}")
if a["status"] != "ACTIVE": sys.exit(f"    account is {a['status']}, not ACTIVE - aborting")
if float(a["cash"]) <= 0: sys.exit("    account has no settled cash - the deposit has not landed yet, aborting")
PY

# --- 2. broker-level locks, before a single order can be placed -----------------
# fractional_trading is not optional: a 12% position on a $200 book is ~$24, far
# under one share of most of the watchlist.
echo "==> applying broker safety locks"
alp /v2/account/configurations -X PATCH -H 'content-type: application/json' \
  -d '{"no_shorting":true,"max_margin_multiplier":"1","fractional_trading":true}' \
  | python3 -c 'import sys,json;d=json.load(sys.stdin);print("   ",{k:d[k] for k in ("no_shorting","max_margin_multiplier","fractional_trading")})'

# --- 3. point the deployment at the live account --------------------------------
# Coolify returns each key twice; the duplicate carries is_preview=true and is for
# PR previews. The by-key PATCH updates the non-preview row, which is the one the
# running container gets. Leave the preview row alone.
echo "==> updating Coolify env"
for kv in "ALPACA_KEY_ID=$KEY_ID" "ALPACA_SECRET_KEY=$SECRET" "ALPACA_TRADING_URL=$LIVE_URL" "MODE=live"; do
  curl -fsS -X PATCH "$PANEL/applications/$APP_UUID/envs" -H "$AUTH" -H 'content-type: application/json' \
    -d "{\"key\":\"${kv%%=*}\",\"value\":\"${kv#*=}\"}" -o /dev/null
  echo "    ${kv%%=*} set"
done
# Keep the gitignored .env in step so a plain-docker rollback lands on the same account.
cd "$REPO"
sed -i -E "s|^ALPACA_KEY_ID=.*|ALPACA_KEY_ID=$KEY_ID|; s|^ALPACA_SECRET_KEY=.*|ALPACA_SECRET_KEY=$SECRET|; \
           s|^ALPACA_TRADING_URL=.*|ALPACA_TRADING_URL=$LIVE_URL|; s|^MODE=.*|MODE=live|" .env

# --- 4. reset the scoreboard ----------------------------------------------------
# benchmark_history is deliberately KEPT: the frozen Arena page plots SCHD from it,
# and renderChart clips the benchmark to the bot's own first equity point anyway.
echo "==> resetting the board"
for c in $(docker ps -q --filter "name=bot-$APP_UUID") $(docker ps -q --filter "name=dashboard-$APP_UUID"); do docker stop "$c" >/dev/null; done
BACKUP="$HOME/backups/stonkbot-pre-live-$(date +%Y%m%d-%H%M).db"
mkdir -p "$HOME/backups"
sudo sqlite3 "$DATA/stonkbot.db" "PRAGMA wal_checkpoint(TRUNCATE);" >/dev/null
sudo cp "$DATA/stonkbot.db" "$BACKUP"
sudo sqlite3 "$DATA/stonkbot.db" \
  "DELETE FROM equity_history; DELETE FROM trades; DELETE FROM daily_summary; \
   DELETE FROM position_opens; DELETE FROM day_trades;"
sudo tee "$DATA/state.json" >/dev/null <<'JSON'
{"tradingDay":"","dayOpenEquity":0,"haltedForDay":false,"inceptionEquity":0,
 "benchmarkInceptionPrice":0,"buysToday":0,"sellsToday":0,"realizedPlToday":0,
 "closeSummarySentDay":"","highWater":{}}
JSON
sudo rm -f "$DATA/signals.json"
echo "    backed up to $BACKUP"

# --- 5. deploy and verify -------------------------------------------------------
echo "==> deploying"
DEP=$(curl -fsS -X POST "$PANEL/deploy" -H "$AUTH" -H 'content-type: application/json' \
  -d "{\"uuid\":\"$APP_UUID\"}" | python3 -c 'import sys,json;print(json.load(sys.stdin)["deployments"][0]["deployment_uuid"])')
for _ in $(seq 1 60); do
  ST=$(curl -fsS "$PANEL/deployments/$DEP" -H "$AUTH" | python3 -c 'import sys,json;print(json.load(sys.stdin).get("status"))')
  [ "$ST" = finished ] || [ "$ST" = failed ] && break
  sleep 10
done
echo "    deployment $ST"
[ "$ST" = finished ] || exit 1

sleep 15
# The Arena is over. A redeploy recreates its container from the compose file, so
# stop it again until the service is removed from docker-compose.coolify.yml.
EXP=$(docker ps -q --filter "name=experiment-$APP_UUID") && [ -n "$EXP" ] && docker stop "$EXP" >/dev/null && echo "    experiment container stopped"
BOT=$(docker ps -q --filter "name=bot-$APP_UUID")
docker logs "$BOT" 2>&1 | tail -5
curl -fsS -o /dev/null -w "    dashboard %{http_code}\n" https://stonkbot.filipkin.com/
echo "==> live on $(python3 -c 'import json,sys;print(json.loads(sys.argv[1])["account_number"])' "$ACCT")"
