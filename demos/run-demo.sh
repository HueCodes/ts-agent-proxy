#!/usr/bin/env bash
# Reproducible demo: spin up ts-agent-proxy with a profile that knows about a
# typo-squat and an attacker host, run agent-sim.sh under it, and dump a few
# sample audit lines.
#
# This is the script the README and demo GIF are produced from. It assumes
# `npx tsx` and `curl` are on PATH. No real upstream is required for the
# blocked-by-the-proxy paths (they fail before the upstream connect); the
# allowed paths reach out to real hosts on the public internet.

set -u

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
LOG_DIR="${TMPDIR:-/tmp}/ts-agent-proxy-demo"
mkdir -p "$LOG_DIR"
AUDIT_LOG="$LOG_DIR/audit.log"
PROXY_LOG="$LOG_DIR/proxy.log"

DEMO_POLICY="$LOG_DIR/policy.yaml"
cat > "$DEMO_POLICY" <<'EOF'
mode: strict
defaultAction: deny
rules:
  - id: anthropic
    domain: api.anthropic.com
  - id: github-api
    domain: api.github.com
block:
  domains:
    - evil-anthropoc.com
    - attacker.example
EOF

echo "policy: $DEMO_POLICY"
echo "audit log: $AUDIT_LOG"
echo "proxy log: $PROXY_LOG"
echo

cd "$REPO_ROOT"

npx tsx src/index.ts run --profile=claude-code -- bash "$REPO_ROOT/demos/agent-sim.sh" \
  > >(tee "$PROXY_LOG") 2>&1

echo
echo "=== sample audit log entries (from proxy stdout) ==="
grep -E 'DENIED|ALLOWED' "$PROXY_LOG" | head -20

# Persist a sample line file the README can quote from. We capture the
# DENIED audit lines here because that's what the README "What it catches by
# default" section pulls from. We keep them as JSON so a future tool can
# parse them.
grep -E 'DENIED' "$PROXY_LOG" | head -5 > "$REPO_ROOT/demos/sample-audit.log" || true
echo
echo "wrote sample audit lines to demos/sample-audit.log"
