#!/bin/zsh
# Sets up the GigaCM runner on the Mac Mini. Run it once, on the Mac Mini, from Terminal:
#   zsh ~/gigacm-portal/runner/install.sh
# It stores the runner token privately (~/.gigacm, readable only by you), checks that Claude Code can reach
# this Mac's Chrome, and installs a background job that asks the portal for work every 30 seconds.
# To remove it later: zsh ~/gigacm-portal/runner/install.sh --uninstall
set -e
LABEL="com.gigacm.runner"
PLIST="$HOME/Library/LaunchAgents/$LABEL.plist"
DIR="${0:A:h:h}"
CONF="$HOME/.gigacm"
LOG="$HOME/Library/Logs/gigacm-runner.log"

if [[ "${1:-}" == "--uninstall" ]]; then
  launchctl bootout "gui/$UID/$LABEL" 2>/dev/null || true
  rm -f "$PLIST"; print "GigaCM runner removed. (Your token is still in $CONF; delete that folder if you want it gone.)"; exit 0
fi

CLAUDE="$(command -v claude || true)"
[[ -z "$CLAUDE" && -x "$HOME/.local/bin/claude" ]] && CLAUDE="$HOME/.local/bin/claude"
[[ -n "$CLAUDE" ]] || { print "Claude Code is not installed on this Mac. Install it (https://claude.com/claude-code), run 'claude' once to sign in, then run this again."; exit 1; }

mkdir -p "$CONF" && chmod 700 "$CONF"
if [[ ! -s "$CONF/runner_token" ]]; then
  read -rs "tok?Paste the portal's runner token (RUNNER_TOKEN in Railway) and press Enter. It won't show as you type: "; print
  [[ "$tok" =~ '^[A-Za-z0-9_-]{16,}$' ]] || { print "That doesn't look like the runner token. Nothing was installed."; exit 1; }
  print -r -- "$tok" > "$CONF/runner_token"; chmod 600 "$CONF/runner_token"
fi

print "Step 1 of 2: checking that Claude Code can reach this Mac's Chrome..."
zsh "$DIR/runner/poll.sh" --test || { print "\nSetup stopped: fix the problem above, then run this again."; exit 1; }

print "Step 2 of 2: installing the background job (every 30 seconds)..."
mkdir -p "${PLIST:h}" "${LOG:h}"
cat > "$PLIST" <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>Label</key><string>$LABEL</string>
  <key>ProgramArguments</key><array><string>/bin/zsh</string><string>$DIR/runner/poll.sh</string></array>
  <key>StartInterval</key><integer>30</integer>
  <key>RunAtLoad</key><true/>
  <key>EnvironmentVariables</key><dict>
    <key>PATH</key><string>${CLAUDE:h}:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin</string>
    <key>GIGACM_CLAUDE</key><string>$CLAUDE</string>
  </dict>
  <key>StandardOutPath</key><string>$LOG</string>
  <key>StandardErrorPath</key><string>$LOG</string>
</dict></plist>
EOF
launchctl bootout "gui/$UID/$LABEL" 2>/dev/null || true
launchctl bootstrap "gui/$UID" "$PLIST"
print "\nDone. The Mac Mini now checks the portal every 30 seconds; the portal should show 'Mac Mini online' within a minute."
print "Log: $LOG"
print "Keep this Mac awake (System Settings > Energy: prevent automatic sleeping) with Chrome open and signed in to LaunchPoint, Discord and Slack."
