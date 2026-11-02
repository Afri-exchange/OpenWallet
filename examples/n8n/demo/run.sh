#!/bin/sh
# Runs the imported demo workflow headlessly and prints a short summary.
set -eu
N8N_BIN=${N8N_BIN:-n8n}
# a second n8n process (the CLI) needs its own task-broker port when the editor is already running
export N8N_RUNNERS_BROKER_PORT=${N8N_RUNNERS_BROKER_PORT:-5680}
out=$(mktemp); trap 'rm -f "$out"' EXIT
"$N8N_BIN" execute --id=agentCardsDemo0001 > "$out" 2>&1 || true
python3 -I - "$out" <<'PY'
import json, sys
t = open(sys.argv[1]).read()
j = json.loads(t[t.index("{"):t.rindex("}") + 1]) if "{" in t else {}
run = j.get("data", {}).get("resultData", {}).get("runData", {})
def last(name):
    r = run.get(name)
    return r[-1]["data"]["main"][0][0]["json"] if r else None
res, summ = last("Result"), last("Demo summary")
print("status:", j.get("status"))
if res: print("agent card result:", res.get("result"), "| amount cents:", res.get("amountCents"), "| host:", res.get("checkoutHost"))
if summ: print("stripe says:", summ.get("stripeSaysPaymentStatus"), "/", summ.get("stripeSessionStatus"), "| demoPassed:", summ.get("demoPassed"))
else: print(t[-1500:])
PY
