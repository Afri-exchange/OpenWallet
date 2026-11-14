# Trial Guard: free trials that can't bill you

"Sign me up for Pixelforge and Lumen." A Claude agent with an Agent Card pays each free trial's $1 card check. Its owner is in **privacy mode**, so every payment is a fresh **one-time card** holding exactly that amount. When the trial ends, the shop tries to bill the monthly price on the card it kept. That card was made for one $1 charge, so the renewal is refused, and nobody had to remember to cancel.

Sandbox only. The three trial shops are made up. The cards, the payments and the renewal attempts are real Miden sandbox calls. No real money moves.

## What it shows

- **Privacy mode** (`privacyMode: true` on the user): one-time Miden Lite cards, one per payment.
- **Agent limits**: $2 per payment and $5 a day. The agent can pay card checks, but it can't pay a subscription even if you ask it to.
- **Idempotency**: one key per trial per run (`trial-<run>-<trialId>`), so asking twice never pays twice.
- **Renewal day**: each shop's monthly charge is sent to Miden against the card it was given, and the page shows Miden's answer word for word.

## Run it

```sh
scripts/sandbox-up.sh                                  # the service on 127.0.0.1:8787 (needs MIDEN_* in your shell)
node --import tsx examples/trial-guard/setup.ts        # privacy-mode user + funded agent; keys to .env.trial-guard (git-ignored)
examples/trial-guard/start.sh                          # http://127.0.0.1:8791
```

The page needs `ANTHROPIC_API_KEY` (or `AI_KEY`) and `MIDEN_*` in your shell. To try it without a model, run `TRIAL_GUARD_SCRIPTED=1 examples/trial-guard/start.sh`: a fixed script signs up for the trials you name. Stop it with `kill $(cat .run/trial-guard.pid)`.

Try:

1. "What trials are there?"
2. "Sign me up for Pixelforge and Lumen." Two one-time cards are made, $1 each.
3. Press **Skip to renewal day**. Pixelforge tries $14.99 and Lumen tries $9.99, each on its own used card.
4. "Just pay for a month of Streamly." The agent explains that $12.99 is over its $2 limit.

## Known limits

- **Two trials at a time.** Miden allows a customer 3 cards, and one-time cards count. The user's own card is one of the three, so only two trials can run. A third signup fails with Miden's "Maximum Number of Cards Per customer Limit 3 Exceeded", and the page explains why. For a fresh run, run `setup.ts` again (it makes a new user). **Start over** clears the page, but the cards already made still count.
- **Two sandbox shortcuts**, both marked in `server.ts`. These shops never really get a card number. So to act out "the shop renews", the demo reads which one-time card paid each signup from the service's Postgres (`app_one_time_card`, only rows for the demo's own user). Then it asks Miden's sandbox simulator (`POST /api/v1/mock/authorization`) to charge that card. A real shop would just charge the card number it kept.
- A renewal is tried **once** and recorded before the call (the simulator is not idempotent). An unclear answer (timeout, 5xx) shows as "couldn't tell" and is never retried.
- Binds to 127.0.0.1 only, and refuses cross-origin POSTs. There is no passcode, so don't tunnel it as it is.

## Status

Run against the Miden sandbox on 2026-11-11 with Claude as the agent: Pixelforge and Lumen were signed up, each with its own one-time card ($1.00 each). On renewal day Miden refused both renewals ($14.99 and $9.99) with `116 No Sufficient funds`. A third trial (Streamly) was refused with Miden's 3-card cap, and nothing was charged. "Pay for a month" was turned down by the agent because of its $2 limit.

What Miden refused on was the empty card balance. Whether the one-swipe setting would also block a charge the card could cover hasn't been tested, and in this demo it can't come up, because the card holds only the card check.
