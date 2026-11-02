#!/bin/sh
# Prints {"cpu":12,"mem":63,"batt":87,"ac":true} (macOS).
export PATH="/usr/sbin:/usr/bin:/bin:/sbin:$PATH"
cpu=$(ps -A -o %cpu= | awk -v n="$(sysctl -n hw.ncpu)" '{s+=$1} END {printf "%d", s/n}')
mem=$(memory_pressure 2>/dev/null | awk -F': ' '/free percentage/ {gsub("%","",$2); printf "%d", 100-$2}')
b=$(pmset -g batt)
batt=$(printf '%s' "$b" | grep -Eo '[0-9]+%' | head -1 | tr -d %)
ac=$(printf '%s' "$b" | grep -q 'AC Power' && echo true || echo false)
printf '{"cpu":%s,"mem":%s,"batt":%s,"ac":%s}' "${cpu:-null}" "${mem:-null}" "${batt:-null}" "$ac"
