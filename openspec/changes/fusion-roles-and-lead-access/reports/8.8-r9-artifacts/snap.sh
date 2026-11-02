#!/bin/bash
T="/c/Users/user/AppData/Local/Temp/fusion-bd-leadr9-20261102-160648"
PROJ="/d/Documents/Repositories/pi-fusion"
LABEL="$1"
OUT="$T/harness/snap/$LABEL.txt"
{
  echo "# snapshot $LABEL $(date -u +%FT%TZ)"
  echo "# tree T"
  (cd "$T" && find . -type f -not -path './harness/snap/*' -printf '%P\n' | sort | while IFS= read -r f; do
     printf '%s  %s\n' "$(sha256sum "$f" | cut -d' ' -f1)" "$f"
   done)
  echo "# project .beads"
  if [ -d "$PROJ/.beads" ]; then
    (cd "$PROJ/.beads" && find . -type f -printf '%P\n' | sort | while IFS= read -r f; do
       printf '%s  %s\n' "$(sha256sum "$f" | cut -d' ' -f1)" "$f"
     done)
  else
    echo "ABSENT"
  fi
} > "$OUT"
echo "wrote $OUT"
