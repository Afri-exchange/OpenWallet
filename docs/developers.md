# Developer API: cards for your users' agents

You build a product with agents in it (a shopping agent, say). Your users each pass KYC once and get a card, fund it, and your agents spend from it within limits your users control. You call this API from your server; your users only ever see the hosted `/connect` page.

Sandbox only for now: the service refuses to start against a non-sandbox Miden URL.

```
your server ──dk_ key──► /developer/v1/*      create users, agents, limits, settings, events
your user's browser ──us_ session──► /connect  KYC and spend controls (hosted by us)
your agent ──ak_ token──► /mcp or /agent/v1/*  get_wallet, pay, pay_checkout, ...
us ──signed webhook──► your server             kyc.updated, card.issued, funding.completed, spend.settled
```

**Runnable examples:** [examples/developer](../examples/developer/README.md) has a script for each section below (onboarding, limits, privacy mode, MCP agent, webhook receiver).

## Roles and tokens

| Token | Who holds it | What it opens |
| --- | --- | --- |
| `dk_...` developer key | your server | `/developer/v1/*` for your users only. A user that is not yours is a 404. |
| `us_...` session | one end user's browser | the owner API (`/api/me/*`) for that one user, for at most 24h (default 1h). It cannot mint a permanent token. |
| `ak_...` agent token | one agent | the agent API and MCP, inside that agent's limits |

You never see a user's identity documents: KYC goes from the user's browser (session) straight to Miden.

## Quick start

```bash
# 1. Sign up (open). The key is shown once.
curl -s localhost:8787/developer/v1/signup -H 'content-type: application/json' \
  -d '{"name":"Shopbot","email":"dev@shopbot.example"}'
# -> { "developerId": "dev_...", "key": "dk_..." }

# 2. Create a user for one of your customers. Idempotent on externalId (your own id).
curl -s localhost:8787/developer/v1/users -H "authorization: Bearer $DK" -H 'content-type: application/json' \
  -d '{"externalId":"cust-42","email":"ada@example.com"}'
# 201 on first call, 200 with the same user after that

# 3. Send the user to KYC and spend controls.
curl -s -X POST localhost:8787/developer/v1/users/$UID/sessions -H "authorization: Bearer $DK" \
  -H 'content-type: application/json' -d '{"ttlSeconds":3600}'
# -> { "token": "us_...", "expiresAt": "...", "url": "https://.../connect#session=us_..." }
```

Open `url` in the user's browser or a webview. The session sits in the URL fragment, so it never reaches a server log. When KYC is approved the user has a card and a USDC deposit address (`GET /developer/v1/users/:id`), and you get `kyc.updated` and `card.issued` webhooks.

```bash
# 4. Once approved: create an agent with limits (the user's tier caps them), and give it money from the user's card.
curl -s localhost:8787/developer/v1/users/$UID/agents -H "authorization: Bearer $DK" -H 'content-type: application/json' \
  -d '{"name":"shopper","perTransactionCents":2000,"dailyCents":10000,"allowedMccs":["5734","5815"]}'
# -> { "agentId": "a_...", "token": "ak_...", "policy": {...} }   give the ak_ token to your agent
curl -s localhost:8787/developer/v1/users/$UID/agents/$AID/fund -H "authorization: Bearer $DK" \
  -H 'content-type: application/json' -d '{"amountCents":5000}'
```

The agent connects to `/mcp` (streamable HTTP, `Authorization: Bearer ak_...`) or calls `/agent/v1/*`. See [checkout SDK](../sdk/checkout/README.md) and [checkout swap](checkout-swap.md).

Try it: [`01-onboard.ts`](../examples/developer/01-onboard.ts) runs steps 1 to 4 end to end.

## Letting users control their agents

Two ways, same server-side checks:

- **Hosted page** (`/connect`): per-payment limit, daily limit, merchant-category allowlist, pause, fund/reclaim. Nothing to build.
- **Your own UI**: call `POST /developer/v1/users/:id/agents/:agentId/limits` from your server with what your user chose. Limits can never exceed the user's card (`quick`/`full` tier); the server says which limit and by how much.

Demo: [`02-limits.ts`](../examples/developer/02-limits.ts) shows each refusal, a limit change, reclaim and revoke.

Other agent calls: `POST .../agents/:agentId/{fund,reclaim,revoke}`, `GET /developer/v1/users/:id` (balances, agents, recent spends).

## Privacy mode

`POST /developer/v1/settings {"privacyMode": true}` makes new users private. Or choose per user: `POST /developer/v1/users {"externalId":..., "email":..., "privacyMode": true}`.

In privacy mode every payment is made with a **fresh one-time card** (a Miden Lite card: one swipe, exactly the payment amount) instead of the user's own card:

- A merchant never sees a card number that works twice, and two purchases cannot be linked by card.
- The user's money stays in our Miden wallet, not on their card, and pays for each one-time card as it is made. Ledger balances look the same to you.
- The user's agent limits, balances and idempotency work as before. If a one-time card cannot be made, the payment is voided and nothing is charged.
- The mode is fixed when the user is created. Changing the default later affects new users only (money already on a user's own card could not pay a one-time card).
- Details of a one-time card are deleted from our vault as soon as its checkout page has been filled.

Demo: [`03-privacy.ts`](../examples/developer/03-privacy.ts). As an app: [Trial Guard](../examples/trial-guard/README.md), an agent that signs up for free trials with one-time cards, so no trial can bill after it ends.

**Known limits (sandbox):**

- Miden caps a customer at **3 cards, Lite cards included**. A privacy user already holds their own card, so only two one-time cards can exist at once until Miden lifts the cap for us. Past the cap a payment fails with Miden's message ("Maximum Number of Cards Per customer Limit 3 Exceeded, Contact Support"). **This blocks real use until Miden confirms a higher limit or that finished cards stop counting.**
- Miden's mock authorization did not enforce the single swipe (two $0.50 charges on one card both approved). The docs say the second swipe is declined with a "swipe count exceeded" event. Not proven on a real network.
- Miden refuses to terminate a card on the day it was made. One-time cards are set to end by themselves two days after issue (`ONE_TIME_TERMINATE_DAYS`). Whether an ended card frees a slot is untested.
- A payment under $1 makes a $1 card (Miden's minimum); the rest stays on the card.
- An issue call that times out is flagged `needs_review` in `app_one_time_card` and the payment is voided: the card may exist and hold money, so a person has to look. Nothing guesses.

## Webhooks

Set where events go (HTTPS; in the sandbox `http://localhost` is allowed too):

```bash
curl -s localhost:8787/developer/v1/settings -H "authorization: Bearer $DK" -H 'content-type: application/json' \
  -d '{"webhookUrl":"https://shopbot.example/hooks/agent-cards"}'
# -> { ..., "webhookSecret": "whsec_..." }   shown once; setting a new URL makes a new secret
```

Events: `kyc.updated`, `card.issued`, `funding.completed`, `spend.settled` (approved, declined or voided, once final). Body:

```json
{ "id": "evt_...", "type": "spend.settled", "createdAt": "...", "userId": "u_...", "externalId": "cust-42",
  "data": { "spendId": "...", "cardId": "...", "agentId": "a_...", "status": "approved", "amountCents": 750, "merchant": "Acme", "mcc": "5734", "reason": null } }
```

Headers: `x-agentcards-event-id` (dedupe on this: a retry is the same event) and `x-agentcards-signature: t=<unix seconds>,v1=<hex>`, where `v1 = HMAC-SHA256(secret, "<t>.<raw body>")`. Check it against the raw bytes, and reject a `t` more than five minutes old.

```js
import { createHmac, timingSafeEqual } from "node:crypto";
function verify(secret, header, rawBody) {
  const { t, v1 } = Object.fromEntries(header.split(",").map((p) => p.split("=")));
  if (Math.abs(Date.now() / 1000 - Number(t)) > 300) return false;
  const want = createHmac("sha256", secret).update(`${t}.${rawBody}`).digest();
  return v1.length === 64 && timingSafeEqual(want, Buffer.from(v1, "hex"));
}
```

A working receiver: [`webhook-receiver.ts`](../examples/developer/webhook-receiver.ts), with the verifier and its tests in [`webhook-verify.ts`](../examples/developer/webhook-verify.ts).

Answer any 2xx. Anything else (or no answer in 10 seconds) is retried after 30s, 1m, 2m, ... up to 6h, eight tries in all; `GET /developer/v1/events` shows status, attempts and the last error (never the body). Redirects are not followed. We refuse webhook URLs that resolve to private addresses (outside the sandbox).

## Reference

| Call | Does |
| --- | --- |
| `POST /developer/v1/signup` | open; `{name, email}` -> `{developerId, key}` |
| `GET /developer/v1/me` | profile, privacy default, webhook URL, user count |
| `POST /developer/v1/key` | rotate the key (old one stops at once) |
| `POST /developer/v1/settings` | `{privacyMode?, webhookUrl?}` (null removes the webhook) |
| `GET /developer/v1/events?limit=` | webhook delivery log |
| `POST /developer/v1/users` | `{externalId, email, privacyMode?}`; same `externalId` returns the same user |
| `GET /developer/v1/users?externalId=&limit=` | list yours |
| `GET /developer/v1/users/:id` | one user: KYC status, card, balances, deposit address, agents |
| `POST /developer/v1/users/:id/sessions` | `{ttlSeconds?}` 60 to 86400 -> `{token, expiresAt, url}` |
| `DELETE /developer/v1/users/:id/sessions` | end all of the user's browser sessions (rotating the developer key ends all of yours) |
| `POST /developer/v1/users/:id/agents` | `{name, perTransactionCents, dailyCents, allowedMccs?}` -> agent and its `ak_` token (once) |
| `POST /developer/v1/users/:id/agents/:aid/limits` | change limits |
| `POST /developer/v1/users/:id/agents/:aid/fund` `reclaim` `revoke` | move money, or stop the agent |

Errors are `{"error": "..."}` with 400 (bad input), 401 (bad key), 404 (not yours or not found), 409 (state, e.g. KYC not done yet), 422 (Miden said no).

## Before production

- DNS rebinding: the webhook host is checked when set and at each delivery, but the HTTP client resolves it again. Pin the resolved address before going live.
- The webhook secret is stored readable (we must sign with it). Move it to a KMS-wrapped column.
- Developer signup is open and unverified (same as merchant signup). Add email verification and rate limits.
- Sessions are bearer tokens in a URL fragment. Issue them only to the user's own device, and keep `ttlSeconds` short.
- A privacy user's funds sit in our Miden wallet: the wallet balance must always cover the sum of privacy users' balances (README open item 5, funding the wallet, applies in full).
- Everything under "Known limits" for privacy mode.
- Custody: a developer can create agents (getting their `ak_` tokens), fund and spend for their users, so the developer fully controls their users' balances. Sessions can do the same through `/api/me/*`, which is why they are short-lived and revocable.
- Webhooks are at-least-once: a crash after your 2xx but before we record it re-sends. Dedupe on `x-agentcards-event-id`. An event can also be lost if the process dies between the state change and the outbox insert; reconcile against `GET /developer/v1/users/:id`.
- Privacy mode costs money when a card is made and the payment then fails: the one-time card keeps its funds until it terminates (2 days), while the ledger refunds the agent. We cap this at 50 one-time cards per user per day and refuse payments under $1 (Miden's minimum card load), but there is no automatic recovery of stranded card balance, and no alarm yet for wallet balance below the sum of privacy balances.
- A webhook URL is not private in sandbox mode (the guard is off so local receivers work). Never expose a sandbox instance to the internet.
- Developers can create users with any email, which blocks that person from signing up themselves. Add email verification with developer signup.
