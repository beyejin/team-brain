#!/bin/sh
set -eu

repo_root=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
sync_script="$repo_root/scripts/sync.sh"
label='com.team-brain.sync'
agent_dir="$HOME/Library/LaunchAgents"
log_dir="$HOME/Library/Logs/team-brain"
plist="$agent_dir/$label.plist"

mkdir -p "$agent_dir" "$log_dir"

python3 - "$plist" "$sync_script" "$log_dir" "$label" <<'PY'
import plistlib
import sys

plist_path, sync_script, log_dir, label = sys.argv[1:]
launch_agent = {
    "Label": label,
    "ProgramArguments": ["/bin/sh", sync_script],
    "StartCalendarInterval": {"Hour": 9, "Minute": 0},
    "StandardOutPath": f"{log_dir}/sync.log",
    "StandardErrorPath": f"{log_dir}/sync-error.log",
}
with open(plist_path, "wb") as output:
    plistlib.dump(launch_agent, output)
PY

launchctl bootout "gui/$(id -u)" "$plist" >/dev/null 2>&1 || true
launchctl bootstrap "gui/$(id -u)" "$plist"
launchctl enable "gui/$(id -u)/$label"
printf '%s\n' '등록했습니다: 매일 오전 9시 동기화'
