#!/bin/sh
# Starts the Trial Guard demo in the background on 127.0.0.1:8791 (pid .run/trial-guard.pid, log .run/trial-guard.log).
# Needs: the sandbox service (scripts/sandbox-up.sh), keys from examples/trial-guard/setup.ts in .env.trial-guard,
# MIDEN_* in the environment (the "renewal day" charges go through Miden's sandbox simulator), and ANTHROPIC_API_KEY
# (or AI_KEY). TRIAL_GUARD_SCRIPTED=1 runs a fixed script instead of Claude.
set -e
cd "$(dirname "$0")/../.."
mkdir -p .run
if [ -f .run/trial-guard.pid ] && kill -0 "$(cat .run/trial-guard.pid)" 2>/dev/null; then
  echo "already running (pid $(cat .run/trial-guard.pid)) at http://127.0.0.1:${PORT:-8791}"; exit 0
fi
[ -f .env.trial-guard ] || { echo "no .env.trial-guard: run node --import tsx examples/trial-guard/setup.ts first" >&2; exit 1; }
set -a; . ./.env.trial-guard; set +a
if [ -z "${ANTHROPIC_API_KEY:-}" ] && [ -n "${AI_KEY:-}" ]; then export ANTHROPIC_API_KEY="$AI_KEY"; fi
nohup node --import tsx examples/trial-guard/server.ts >> .run/trial-guard.log 2>&1 &
echo $! > .run/trial-guard.pid
sleep 3
curl -fsS "http://127.0.0.1:${PORT:-8791}/healthz" >/dev/null && echo "trial guard running (pid $(cat .run/trial-guard.pid)) at http://127.0.0.1:${PORT:-8791}; log .run/trial-guard.log"
