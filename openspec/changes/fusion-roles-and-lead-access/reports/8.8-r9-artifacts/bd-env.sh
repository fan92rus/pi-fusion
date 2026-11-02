#!/bin/bash
T="C:/Users/user/AppData/Local/Temp/fusion-bd-leadr9-20261102-160648"
for a in "$@"; do
  case "$a" in
    *--global*) echo "REJECTED: --global запрещён в harness (tasks 8.8(b))" >&2; exit 99 ;;
  esac
done
export HOME="$T/home"
export USERPROFILE="$T/home"
export XDG_CONFIG_HOME="$T/xdg/config"
export XDG_DATA_HOME="$T/xdg/data"
export XDG_STATE_HOME="$T/xdg/state"
export XDG_CACHE_HOME="$T/xdg/cache"
export APPDATA="$T/appdata/roaming"
export LOCALAPPDATA="$T/appdata/local"
export TEMP="$T/temp/temp"
export TMP="$T/temp/tmp"
export TMPDIR="$T/temp/tmpdir"
NAMES=$(env | grep -E '^(BEADS_|BD_|DOLT_)' | cut -d= -f1 || true)
if [ -n "$NAMES" ]; then unset $NAMES; fi
cd "$T/work" || exit 98
exec bd "$@"
