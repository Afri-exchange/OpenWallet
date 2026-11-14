#!/bin/sh
# Reproduces the n8n demo on a fresh machine: creates the n8n credentials from environment variables
# (never printed, written only to a 0600 temp file that is deleted), then imports the workflow.
#
# Needs (in the shell): AGENT_CARDS_AGENT_TOKEN  (the ak_ key, from scripts/dev-quickstart.ts -> .env.sandbox-keys)
#                       STRIPE_SANDBOX_SECRET_KEY (a Stripe TEST-mode secret key, sk_test_...)
# Needs n8n 2.x on Node 24 (see ../README.md); N8N_BIN defaults to `n8n`.
set -eu
here=$(cd "$(dirname "$0")" && pwd)
N8N_BIN=${N8N_BIN:-n8n}
: "${AGENT_CARDS_AGENT_TOKEN:?set AGENT_CARDS_AGENT_TOKEN (ak_...)}"
: "${STRIPE_SANDBOX_SECRET_KEY:?set STRIPE_SANDBOX_SECRET_KEY (sk_test_...)}"
case "$STRIPE_SANDBOX_SECRET_KEY" in sk_test_*|rk_test_*) ;; *) echo "refusing: that is not a Stripe test-mode key" >&2; exit 1;; esac
tmp=$(mktemp); trap 'rm -f "$tmp"' EXIT; chmod 600 "$tmp"
node -e '
const e = process.env;
console.log(JSON.stringify([
  { id: "agentCardsAgent0001", name: "Agent Cards agent (ak_)", type: "httpHeaderAuth", data: { name: "Authorization", value: "Bearer " + e.AGENT_CARDS_AGENT_TOKEN } },
  { id: "stripeSandbox0001", name: "Stripe sandbox (sk_test)", type: "httpBasicAuth", data: { user: e.STRIPE_SANDBOX_SECRET_KEY, password: "" } },
]));' > "$tmp"
"$N8N_BIN" import:credentials --input="$tmp"
"$N8N_BIN" import:workflow --input="$here/../agent-pays-stripe-demo.workflow.json"
echo "imported. Open n8n, workflow 'Agent Card demo: agent pays a Stripe checkout link', press Execute workflow."
