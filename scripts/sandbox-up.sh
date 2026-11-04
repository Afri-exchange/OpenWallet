#!/bin/sh
# Starts the agent-cards sandbox service in the background (Postgres via brew services).
# Simulated deposits are on here (ALLOW_SIMULATED_DEPOSITS=0 to turn them off).
# Needs MIDEN_CLIENT_ID, MIDEN_CLIENT_SECRET, MIDEN_UNIQUE_KEY in the environment.
set -e
cd "$(dirname "$0")/.."
for k in MIDEN_CLIENT_ID MIDEN_CLIENT_SECRET MIDEN_UNIQUE_KEY; do
  eval "v=\${$k:-}"; [ -n "$v" ] || { echo "missing $k in the environment" >&2; exit 1; }
done
brew services start postgresql@16 >/dev/null
export PATH="/opt/homebrew/opt/postgresql@16/bin:$PATH"
until pg_isready -q; do sleep 1; done
psql -lqt | cut -d'|' -f1 | grep -qw agent_cards || createdb agent_cards
mkdir -p .run
if [ -f .run/server.pid ] && kill -0 "$(cat .run/server.pid)" 2>/dev/null; then
  echo "already running (pid $(cat .run/server.pid)) at http://127.0.0.1:8787"; exit 0
fi
ALLOW_SIMULATED_DEPOSITS="${ALLOW_SIMULATED_DEPOSITS:-1}" nohup node --import tsx src/main.ts >> .run/server.log 2>&1 &
echo $! > .run/server.pid
sleep 4
curl -fsS http://127.0.0.1:8787/healthz >/dev/null && echo "running (pid $(cat .run/server.pid)) at http://127.0.0.1:8787; log: .run/server.log"
