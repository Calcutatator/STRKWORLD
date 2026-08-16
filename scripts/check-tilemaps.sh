#!/usr/bin/env bash
# Asserts every exported Tiled map has its tilesets embedded.
#
# Phaser rejects external tilesets with a console.warn, NOT an error — so a
# mis-exported map loads "successfully" and renders blank tiles. Author
# discipline cannot catch that; a build-time check can.
#
# The check is on `source`, not on `.tsx`: Phaser's test is `if (set.source)`,
# which rejects any external pointer, including a `.tsj` JSON tileset.
set -uo pipefail
fail=0
maps=$(find packages/world -name "*.json" -path "*map*" 2>/dev/null)

if [ -z "$maps" ]; then
  echo " ok  no tilemaps yet"
  exit 0
fi

for map in $maps; do
  bad=$(python3 - "$map" <<'PYEOF'
import json, sys
try:
    d = json.load(open(sys.argv[1]))
except Exception:
    sys.exit(0)
if not isinstance(d, dict) or "tilesets" not in d:
    sys.exit(0)
external = [t.get("source") for t in d.get("tilesets", []) if t.get("source")]
if external:
    print(", ".join(external))
PYEOF
)
  if [ -n "$bad" ]; then
    printf '\033[31mFAIL\033[0m  %s references external tileset(s): %s\n' "$map" "$bad"
    echo "      Phaser only console.warns — this map would load with blank tiles."
    echo "      Fix: Tiled → Map → Embed Tilesets, re-export."
    echo "      Or:  tiled --export-map json --embed-tilesets <in.tmx> <out.json>"
    fail=1
  else
    printf '\033[32m ok \033[0m  %s tilesets embedded\n' "$map"
  fi
done
exit "$fail"
