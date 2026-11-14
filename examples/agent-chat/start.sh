#!/bin/sh
# Starts the agent chat demo in the background on 127.0.0.1:8790 (pid in .run/agent-chat.pid, log .run/agent-chat.log).
# Needs: the sandbox service running with hosted checkouts + test-card mode
#   (set -a; . ./.env.card-vault; set +a; SWAP_ENABLED=1 SWAP_STRIPE_TEST_CARD=1 scripts/sandbox-up.sh),
# ANTHROPIC_API_KEY and STRIPE_SANDBOX_SECRET_KEY (sk_test_) in the environment, and agent keys in .env.agent-chat
# (examples/agent-chat/setup-agent.ts) or .env.sandbox-keys (scripts/dev-quickstart.ts).
# The passcode testers type is AGENT_CHAT_PASSCODE, or one generated into .run/agent-chat.passcode.
set -e
cd "$(dirname "$0")/../.."
mkdir -p .run
if [ -f .run/agent-chat.pid ] && kill -0 "$(cat .run/agent-chat.pid)" 2>/dev/null; then
  echo "already running (pid $(cat .run/agent-chat.pid))"; exit 0
fi
set -a
if [ -f .env.agent-chat ]; then . ./.env.agent-chat; elif [ -f .env.sandbox-keys ]; then . ./.env.sandbox-keys; fi
set +a
if [ -z "${AGENT_CHAT_PASSCODE:-}" ]; then
  [ -s .run/agent-chat.passcode ] || (umask 077; LC_ALL=C tr -dc 'a-z2-9' < /dev/urandom | head -c 10 > .run/agent-chat.passcode)
  AGENT_CHAT_PASSCODE="$(cat .run/agent-chat.passcode)"
fi
export AGENT_CHAT_PASSCODE
(cd examples/agent-chat && [ -d node_modules ] || pnpm install --ignore-workspace >/dev/null)
nohup node --import tsx examples/agent-chat/server.ts >> .run/agent-chat.log 2>&1 &
echo $! > .run/agent-chat.pid
sleep 3
curl -fsS http://127.0.0.1:${PORT:-8790}/healthz >/dev/null && echo "agent chat running (pid $(cat .run/agent-chat.pid)) at http://127.0.0.1:${PORT:-8790}; passcode in .run/agent-chat.passcode; log .run/agent-chat.log"
