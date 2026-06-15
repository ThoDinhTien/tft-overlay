#!/usr/bin/env bash
# Cập nhật meta TFT định kỳ: aggregate (Riot API) -> merge -> comps.json.
# Tự BỎ QUA sạch nếu chưa có key TFT hợp lệ (đang chờ approve) — không làm hỏng timer.
set -uo pipefail

PROJECT_DIR="/home/tientho/Code/tft-overlay"
ENV_FILE="$HOME/.config/tft-overlay/riot.env"
LOG="$HOME/.claude/cron/logs/tft-meta.log"
NODE="/home/tientho/.nvm/versions/node/v20.20.2/bin/node"

ts() { date '+%Y-%m-%d %H:%M:%S'; }
log() { echo "[$(ts)] $*" >> "$LOG"; }

mkdir -p "$(dirname "$LOG")"

# Nạp key + cấu hình region từ file env (ưu tiên env sẵn có nếu đã export).
if [ -f "$ENV_FILE" ]; then set -a; . "$ENV_FILE"; set +a; fi
: "${PLATFORM:=vn2}"
: "${REGION:=sea}"

if [ -z "${RIOT_API_KEY:-}" ]; then
  log "SKIP: chưa có RIOT_API_KEY trong $ENV_FILE (đang chờ key TFT?)"
  exit 0
fi

# Key phải truy cập được endpoint TFT (LoL-only key sẽ 403).
code=$(curl -s -o /dev/null -w "%{http_code}" -m 15 \
  -H "X-Riot-Token: $RIOT_API_KEY" \
  "https://$PLATFORM.api.riotgames.com/tft/status/v1/platform-data")
if [ "$code" != "200" ]; then
  log "SKIP: key không truy cập TFT (HTTP $code) — kiểm tra Game Focus=TFT / key còn hạn"
  exit 0
fi

cd "$PROJECT_DIR" || { log "ERR: không vào được $PROJECT_DIR"; exit 1; }
log "START aggregate (PLATFORM=$PLATFORM REGION=$REGION)"

TMP=$(mktemp)
if RIOT_API_KEY="$RIOT_API_KEY" PLATFORM="$PLATFORM" REGION="$REGION" \
   "$NODE" scripts/aggregate_comps.mjs > "$TMP" 2>&1; then
  tr '\r' '\n' < "$TMP" | tail -7 >> "$LOG"
  if "$NODE" scripts/merge_stats.mjs >> "$LOG" 2>&1; then
    log "DONE: đã cập nhật comps.json"
  else
    log "ERR: merge_stats thất bại"
  fi
else
  tr '\r' '\n' < "$TMP" | tail -7 >> "$LOG"
  log "ERR: aggregate_comps thất bại"
fi
rm -f "$TMP"
