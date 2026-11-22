#!/bin/zsh
# GigaCM runner for the Mac Mini. launchd starts this every 30 seconds.
# It asks the portal for work; if a refresh was requested (or a scheduled scan is due) it runs the scan
# with Claude Code on this Mac, using this Mac's Chrome, then reports done/failed back to the portal.
#   poll.sh          normal poll (what launchd runs)
#   poll.sh --test   check that Claude Code here can see the Mac Mini's Chrome; runs no scan
set -u
DIR="${GIGACM_DIR:-${0:A:h:h}}"                      # the repo checkout this script lives in
CONF="${GIGACM_CONF:-$HOME/.gigacm}"
LOG="${GIGACM_LOG:-$HOME/Library/Logs/gigacm-runner.log}"
PORTAL="${GIGACM_PORTAL:-https://gigca-cm-portal-production.up.railway.app}"
CLAUDE="${GIGACM_CLAUDE:-$(command -v claude || echo "$HOME/.local/bin/claude")}"
MINI_BROWSER="901fbec1-ee36-465a-acee-5c71701b2a9a"
MAX_SECONDS=2100                                      # stop a stuck scan after 35 minutes

log() { print -r -- "$(date '+%Y-%m-%d %H:%M:%S') $*" >> "$LOG"; }
# Read a field from JSON without extra tools (JavaScript for Automation ships with macOS).
json_get() { osascript -l JavaScript -e 'function run(a){const o=JSON.parse(a[0]);const v=a[1].split(".").reduce((x,k)=>x==null?x:x[k],o);return v==null?"":typeof v==="object"?JSON.stringify(v):String(v)}' "$1" "$2" 2>/dev/null; }
mkdir -p "$CONF" "${LOG:h}"

if [[ "${1:-}" == "--test" ]]; then
  [[ -x "$CLAUDE" ]] || { print "Claude Code not found (looked for: $CLAUDE). Install it first."; exit 1; }
  print "Asking Claude Code on this Mac to list the Chrome browsers it can reach..."
  out=$(cd /tmp && "$CLAUDE" -p "Load the tool mcp__claude-in-chrome__list_connected_browsers with ToolSearch if needed, call it once, and reply with only the deviceIds it returns, one per line. If you have no Claude in Chrome tools, reply exactly NO_CHROME_TOOLS. Do nothing else." \
        --chrome --no-session-persistence --allowedTools "ToolSearch,mcp__claude-in-chrome__list_connected_browsers" 2>&1)
  print -r -- "$out"
  if print -r -- "$out" | grep -q "$MINI_BROWSER"; then print "OK: the Mac Mini's Chrome is reachable."; exit 0; fi
  if print -r -- "$out" | grep -q "NO_CHROME_TOOLS"; then print "FAILED: Claude Code got no Claude in Chrome tools. Open Chrome, check the Claude extension is signed in, and try again."; exit 1; fi
  print "FAILED: the Mac Mini's Chrome ($MINI_BROWSER) was not in the list. If the output above mentions logging in, run 'claude' once and sign in."; exit 1
fi

TOKEN="$(<"$CONF/runner_token")" 2>/dev/null || TOKEN=""
[[ "$TOKEN" =~ '^[A-Za-z0-9_-]{16,}$' ]] || { log "no valid runner token in $CONF/runner_token"; exit 1; }

# One scan at a time. A lock older than 45 minutes is left over from a crash.
LOCK="$CONF/run.lock"
if ! mkdir "$LOCK" 2>/dev/null; then
  [[ -n "$(find "$LOCK" -maxdepth 0 -mmin +45 2>/dev/null)" ]] && rm -rf "$LOCK" && mkdir "$LOCK" 2>/dev/null || exit 0
fi
trap 'rm -rf "$LOCK"' EXIT

resp=$(curl -fsS -m 20 -X POST -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" \
  -d "{\"host\":\"$(hostname -s | tr -cd 'A-Za-z0-9._-')\"}" "$PORTAL/api/runner/claim" 2>&1) || { log "claim failed: ${resp:0:200}"; exit 0; }
scope=$(json_get "$resp" scope)
[[ -z "$scope" ]] && exit 0                            # nothing to do; this is the normal case
ids=$(json_get "$resp" ids); [[ -z "$ids" ]] && ids="[]"
P='((lp|dc)\.(capcut|artlist|creatify|melius)|dms|slack)'
[[ "$scope" =~ "^(all|capcut|artlist|creatify|melius|dms|slack|channel:(capcut|artlist|creatify|melius):[0-9]{15,22}|parts:$P(,$P)*)\$" ]] || scope=all

finish() { # status detail
  local body; body=$(osascript -l JavaScript -e 'function run(a){return JSON.stringify({ids:JSON.parse(a[0]),status:a[1],detail:a[2]})}' "$ids" "$1" "$2")
  curl -fsS -m 20 -X POST -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" -d "$body" "$PORTAL/api/runner/finish" >/dev/null 2>&1 || log "could not report finish"
}

log "start scope=$scope ids=$ids"
git -C "$DIR" pull --ff-only -q >/dev/null 2>&1 || log "git pull failed; using the scripts already here"
[[ -x "$CLAUDE" ]] || { log "claude not found at $CLAUDE"; finish failed "Claude Code is not installed on the Mac Mini"; exit 1; }
prompt="$(sed "s/__RUNNER_TOKEN__/$TOKEN/" "$DIR/runner/prompt.md")"$'\n\n'"SCOPE=$scope"

out=$(cd "$DIR" && perl -e 'alarm shift; exec @ARGV' "$MAX_SECONDS" "$CLAUDE" -p "$prompt" --chrome --no-session-persistence \
      --allowedTools "ToolSearch,Read,Glob,Grep,mcp__claude-in-chrome" 2>&1)
code=$?
print -r -- "$out" | tail -40 | sed 's/^/    /' >> "$LOG"
result=$(print -r -- "$out" | grep -E '^RESULT: ' | tail -1)
if [[ $code -eq 0 && "$result" == "RESULT: ok" ]]; then
  finish done ""; log "done scope=$scope"
else
  detail="${result#RESULT: failed - }"
  [[ -z "$result" ]] && detail=$([[ $code -eq 142 ]] && print "stopped after $((MAX_SECONDS/60)) minutes" || print -r -- "$out" | tail -1 | cut -c1-200)
  finish failed "$detail"; log "failed scope=$scope code=$code: $detail"
fi
# keep the log from growing forever
[[ $(stat -f%z "$LOG" 2>/dev/null || echo 0) -gt 5000000 ]] && tail -c 2000000 "$LOG" > "$LOG.tmp" && mv "$LOG.tmp" "$LOG"
exit 0
