#!/usr/bin/env bash
# Deploy nach /opt/bookandbuy auf dem VPS.
#
# WICHTIG: data/ und .env werden NICHT angefasst — der Server ist die
# lebende Instanz (freigegebene Kategorien, Entwürfe, Klick-Log,
# Suggestions entstehen dort und dürfen nie überschrieben werden).
set -euo pipefail
cd "$(dirname "$0")/.."

SERVER=root@185.211.61.100
DEST=/opt/bookandbuy

rsync -az --delete \
  --exclude node_modules \
  --exclude dist \
  --exclude .git \
  --exclude .astro \
  --exclude data \
  --exclude .env \
  ./ "$SERVER:$DEST/"

ssh "$SERVER" "cd $DEST && npm install --omit=dev --no-audit --no-fund >/dev/null 2>&1; systemctl restart bookandbuy-admin && node node_modules/astro/astro.js build 2>&1 | tail -2"

echo "Deploy fertig: https://www.bookandbuy.de"
