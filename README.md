# agent-cards

Virtual cards for AI agents, funded with stablecoins, built on the [Miden Workspace API](https://docs.miden.co/getting-started).

> Note: the Miden docs describe a card-issuance / wallet-as-a-service REST API (midencards.io), not the Miden blockchain.

**Status: working end to end in the Miden sandbox.** A user passes KYC, gets a card and a USDC deposit address (Base Sepolia), funds the card, and hands budgets to agents that pay over MCP or REST. See [Sandbox service](#sandbox-service-end-to-end) and [Open items](#open-items) for what production still needs.

## Integrating? Start here

Building a merchant that takes agent payments, or connecting an agent? Follow **[docs/getting-started.md](docs/getting-started.md)**: `scripts/sandbox-up.sh`, then `node --import tsx scripts/dev-quickstart.ts` gives you sandbox keys (a merchant `mk_…` key and a funded test agent `ak_…` token, saved to the git-ignored `.env.sandbox-keys`) and proves them with a paid test checkout. Then read the [checkout SDK](sdk/checkout/README.md) and run the [sample shop](examples/shop/README.md). The rest of this README is for people working on agent-cards itself.

## How it fits together

```
agent ──► CardService ──► MidenClient ──► Miden Workspace API
              │                ▲
              ▼                │
        FundingSource ─────────┘
   (MidenWalletFunding)

SpendPolicy + evaluate(): local limits checked per authorization attempt
```

- An agent gets a card via `CardService.issue(agentId, policy)`.
- The card is loaded with `CardService.topUp(...)`, which hands off to a `FundingSource` that converts stablecoin (USDC/USDT) into card balance.
- Each card carries a `SpendPolicy` (per-transaction cap, daily cap, optional merchant category allowlist), checked with `evaluate()`.

## Layout

| Path | What it is |
| --- | --- |
| `src/miden/client.ts` | `MidenClient`: client-credentials token (cached, refreshed 30s before expiry) and signed requests with `Reference`, `Signature`, `UniqueKey`, `MidenAuthorization` and `Authorization: Bearer` headers. `configFromEnv()` builds its config. |
| `src/miden/signature.ts` | Request signing: SHA-1 over `METHOD&urlencoded(url)&reference&clientId&clientSecret`, base64-encoded. Two modes, because the docs disagree (see below). |
| `src/funding/types.ts` | `FundingSource` interface, `FundingRequest` / `FundingReceipt`, `Stablecoin` (`"USDC" \| "USDT"`). |
| `src/funding/miden-wallet.ts` | `MidenWalletFunding`: tops up a card from the Miden USD wallet. |
| `src/cards/service.ts` | `CardService`: `issue` and `topUp`. |
| `src/cards/policy.ts` | `SpendPolicy` and `evaluate()`. |
| `src/chain/base-usdc-watcher.ts` | `BaseUsdcWatcher`: polls `eth_getLogs` for USDC `Transfer`s on Base to our deposit addresses, waits `confirmations` blocks (default 10), credits `ledger.confirmDeposit`, then advances a cursor. Replays are no-ops (ledger key is chain+txHash+logIndex). Sub-cent dust is reported, never credited. `rescan(from, to)` backfills. |
| `src/chain/pg.ts` | `PgCursor` (forward-only) and `PgDepositAddresses` (one address → one card; an address needs a card). |
| `src/app/` | The sandbox service: `service.ts` (flows), `server.ts` (HTTP, MCP), `mcp.ts` / `mcp-stdio.ts` (agent tools), `hd-wallet.ts`, `dashboard.html`, `main.ts`. See [Sandbox service](#sandbox-service-end-to-end). |
| `src/index.ts` | Re-exports everything above. |
| `test/` | `node:test` tests for the policy and signature code. |

## Configuration

`configFromEnv()` reads these variables and throws if any required one is missing:

| Variable | Required | Meaning |
| --- | --- | --- |
| `MIDEN_BASE_URL` | yes | API base URL; request paths are appended to it |
| `MIDEN_TOKEN_URL` | yes | OAuth client-credentials token endpoint |
| `MIDEN_CLIENT_ID` | yes | Client ID |
| `MIDEN_CLIENT_SECRET` | yes | Client secret (used for the token and in every signature) |
| `MIDEN_UNIQUE_KEY` | yes | Sent as the `UniqueKey` header |
| `MIDEN_WEBHOOK_HASH` | for webhooks | HMAC key for verifying `x-signature`; read by `scripts/webhook-*.ts` |

Nothing loads a `.env` file automatically; export the variables in your shell or use `node --env-file=.env`. `.env` and `.env.*` are git-ignored (except `.env.example`).

### Signature

base64 of the **hex** SHA-1 string over `METHOD&urlencode(fullUrl)&reference&clientId&clientSecret`, confirmed against the sandbox on 2026-10-19 (base64 of the raw digest gets 403 "Invalid Signature"). The signed URL includes the query string.

### Sandbox smoke check

`node --env-file=.env --import tsx scripts/sandbox-smoke.ts` gets a token and lists wallet balances. It is read-only and prints no credentials. A 401/403 with correct keys usually means this machine's IP is not whitelisted in the Miden dashboard.

## Usage

```ts
import { CardService, MidenClient, MidenWalletFunding, configFromEnv, evaluate } from "./src/index.js";

const miden = new MidenClient(configFromEnv());
const cards = new CardService(miden, new MidenWalletFunding(miden));

const card = await cards.issue("agent-42", { perTransactionCents: 5_000, dailyCents: 20_000, allowedMccs: ["5734"] });

// Top-ups take an idempotency key so a retry never double-funds.
await cards.topUp(card, 10_000, "USDC", "topup-agent-42-0001");

evaluate(card.policy, { amountCents: 2_500, mcc: "5734", spentTodayCents: 0 });
// => { ok: true }  or  { ok: false, reason: "daily limit exceeded" }
```

Amounts are in USD cents throughout.

## Dev

Requires Node 20+ and pnpm.

```
pnpm install
pnpm test        # tsx --test test/*.test.ts
pnpm typecheck   # tsc --noEmit
pnpm build       # emits to dist/
```

## Sandbox service (end to end)

`src/app/` is a running service on top of the library: a user passes KYC, gets a card and a USDC deposit address, funds the card with stablecoin, and hands budgets to agents, which pay over **MCP** or REST. It is **sandbox-only** (it refuses to start against a non-sandbox Miden URL) and listens on `127.0.0.1:8787`.

```
scripts/sandbox-up.sh                                   # Postgres (brew services) + the service; needs MIDEN_* in the env
                                                        # (turns on ALLOW_SIMULATED_DEPOSITS=1; stop: kill $(cat .run/server.pid))
node --import tsx scripts/sandbox-demo.ts               # full end-to-end check against the Miden sandbox (moves sandbox money)
open http://127.0.0.1:8787                              # owner dashboard
```

| Step | What happens | Real or simulated |
| --- | --- | --- |
| Sign up | Account + user token (`uk_…`, shown once, stored hashed) | real |
| KYC | Identity goes straight to Miden `kyc-submit`; never stored or logged. Background poller issues the card on approval | real Miden sandbox (dummy identities approve instantly) |
| Card | One card per user, limits from the tier (`src/cards/tiers.ts`, placeholder amounts) | real Miden sandbox card |
| Deposit address | Per-card address from our own HD wallet (`.sandbox-wallet.json`, mode 600, git-ignored, **testnet only**) | real, Base Sepolia |
| Deposit | `BaseUsdcWatcher` credits USDC sent to the address (5 confirmations, free public RPC). Get test USDC at faucet.circle.com → Base Sepolia. The dashboard also has **Simulate deposit** (only with `ALLOW_SIMULATED_DEPOSITS=1` against the sandbox host), labelled as such in the ledger (`chain = sandbox-sim`). Money that cannot move yet (under the $1 minimum top-up, or over the tier's lifetime cap) shows why (`awaitingFundingReason`) | real chain watching; simulate is a shortcut |
| Card top-up | Credited funds move holding → pending → card with a Miden top-up (`app_funding`, idempotent by funding id, retried after a crash). An "already seen" answer, or a top-up still reserved after 20h, is settled only by finding it on the card's `CardFunding` list; not found stays reserved for review | real Miden sandbox top-up |
| Agents | Owner creates agents with per-payment/daily limits (limits above the card's are refused with a 400) and gives them a budget from the card. Each gets an agent token (`ak_…`, shown once) | real (our ledger) |
| Agent pays | MCP tools `get_wallet`, `pay`, `list_transactions`, or `POST /agent/v1/pay`. Our policy and the agent's sub-balance are checked and debited first, then the card is charged with Miden's **sandbox purchase simulator**. Daily limits (the agent's, and the card's shared by all its agents) are checked in Postgres under a row lock on the card, so several server processes cannot overspend. A definite card decline reverses our debit; a lost answer (timeout, 5xx) leaves the payment `processing` with the money held, and a background reconcile settles it from the card's Authorization list (matched exactly by a per-spend merchant id): approved or declined as the card shows. With no card record after 10 min it is flagged "needs review" and the money stays held; nothing is refunded on absence alone, since the card's list can lag or page out. The simulator is never re-sent: it is not idempotent | the charge is Miden's simulated authorization |

Connecting an agent (the dashboard shows these with the token filled in):

```
# MCP over HTTP (Claude Code)
claude mcp add --transport http agent-cards http://127.0.0.1:8787/mcp --header "Authorization: Bearer ak_..."
# MCP over stdio (Claude Desktop and other process-launching clients)
AGENT_CARDS_URL=http://127.0.0.1:8787 AGENT_CARDS_TOKEN=ak_... node --import tsx src/app/mcp-stdio.ts
# Plain HTTP
curl -s http://127.0.0.1:8787/agent/v1/pay -H "Authorization: Bearer ak_..." -H "content-type: application/json" \
  -d '{"amountCents":500,"merchant":"Example API","mcc":"5734","idempotencyKey":"order-1"}'
```

Verified 2026-10-19: `scripts/sandbox-demo.ts` passes every check against the Miden sandbox (KYC → card → $25 deposit → Miden top-up → agent funded → MCP and REST payments → limits, idempotency, revocation; Miden's card balance and transaction list match our ledger to the cent). A real LLM agent (Claude Code, headless, with only this MCP server) checked its wallet, made a $3.50 purchase, and was correctly refused a $6 one over its limit. `test/app.test.ts` covers the failure paths with a fake Miden (top-up timeout then "already seen" found on the card or not, rejected top-up, tier cap, card decline after our debit, lost card answer settled by reconcile either way, crash mid-payment, restart restoring daily totals, the card-wide daily limit, Host guard, cross-site POSTs, token separation and rotation).

### Checkout for merchants

Merchants can take payments from agents with **`sdk/checkout`** (`@agent-cards/checkout`, no dependencies; see [its README](sdk/checkout/README.md)). A merchant signs up for a secret key (`mk_…`) and creates a fixed-price checkout (`cs_…`, with a `/pay/cs_…` page). The agent pays it with the MCP tool `pay_checkout` or with `POST /agent/v1/checkouts/<id>/pay`. The merchant fulfils the order once the checkout reads `paid`. The payment is an ordinary agent payment (`AppService.pay`), so agent and card limits, the MCC allowlist, idempotency and reconcile all apply. `src/app/checkout.ts` guarantees each checkout is paid at most once: an atomic claim, plus a spend key per attempt (`checkout:<id>:<n>`), so a declined attempt can be retried and the same attempt is never charged twice. Sandbox only: the card is charged through Miden's simulator under the merchant's name. **Settlement** (boss's decision, 2026-10-19: we are merchant of record, so card details reach neither agents nor merchants): a checkout that moves to `paid` under the attempt guard credits `merchant:<id>` in our ledger (`external:merchant → merchant:<id>`, key `checkout-settle:<checkout id>`, so at most once per checkout; a crash before the credit is healed by `sync()` via `app_checkout.settled_seq`). A charge approved after its checkout moved on is not credited; it goes to review. Merchants see `GET /merchant/v1/balance` and request payouts with `POST /merchant/v1/payouts`. A payout is reserved (`merchant → payout_pending`, key `payout-reserve:<id>`) before anything is sent, completed or released only on the rail's definite answer (`CheckoutService.settlePayout`, ops only; never released on a missing answer). Merchant balances cannot go negative (ledger and database CHECK). `Ledger.refundCheckout` takes back at most what a checkout settled, once, and fails rather than overdraw a merchant who has been paid out. **Payout rail: USDC on Base Sepolia, testnet only** (boss's decision, 2026-10-19; bank transfers later). The merchant sets an address (`POST /merchant/v1/payout-address`; never one of our deposit addresses or the payout account). A new address can be paid only after a delay (`PAYOUT_ADDRESS_DELAY_S`: 10 minutes in the sandbox, 24 h by default in code), and each payout records the address it was requested to, so a stolen key cannot redirect money at once. `PayoutSender` (`src/app/payouts.ts`, in the background loop, one sender across processes by advisory lock) signs a transfer from our payout account (`m/44'/60'/1'/0/0`, logged at startup; fund it with test USDC and Base Sepolia ETH) at an explicit nonce, stores the signed bytes, and only then broadcasts, with one transfer in flight at a time. A lost answer is rebroadcast with the same bytes, so it can be mined at most once. After 5 confirmations it is `sent`; a revert on chain is `failed`, with the money back in the balance; no answer is never a failure. If our nonce is used by another transaction, the payout is flagged `needs_review`, the money stays reserved, and the queue stops. Ops cannot settle a `sending` payout by hand (see the ops note below for the one exception). `settlePayout` claims the payout row before it moves any money, so ops and the sender can never both settle one payout: ops can only settle a `requested` payout, the rail only a `sending` one. If a transfer fails to sign while our payout account has enough USDC and gas, the cause is that payout (say, a blacklisted address): it is skipped so it cannot block other merchants, and after 3 tries it fails and its money is released (safe: nothing was signed). If the account is short of USDC or gas, the queue stops. `UsdcPayoutRail` refuses mainnet. Because testnet USDC has no value, the items below are accepted for the sandbox, but each blocks mainnet. Not built: real key custody for the payout account, re-authentication by email for a payout-address change, plus a notification to the merchant with a way to cancel pending payouts during the address delay (the delay protects no one if the real merchant never hears of the change), re-authentication or at least a notification for `POST /merchant/v1/key` (a stolen `mk_` key can rotate the real merchant out of their own account), fee bumping for a transfer stuck on low gas (`maxFeePerGas` is 3× base fee plus tip, so a fee spike can strand one; a bump must replace the transfer at the same nonce, stored and rebroadcast the same way, never send a new one), a settlement hold (build it with Miden's capture webhook, item 7, not on a timer) (Lin's review, 2026-10-19: today a merchant is credited on card authorization and can request a payout at once, but an authorization can be reversed or charged back and no money reaches us yet; credit `merchant_unsettled:<id>` first and move it to `merchant:<id>` only on capture or after a hold window, with payouts drawing only on `merchant:<id>`), merchant KYB before the first payout (signup is open, so a stolen agent token plus a self-made merchant could pay itself out), and a refund API (the card side; the agent's credit must hang off the same `checkout-refund:<id>` key so the two cannot drift apart). The rail may send only payouts whose `payout-reserve:<id>` exists. Spend keys starting `checkout:` are reserved (an agent cannot pre-spend under one), and a checkout is marked paid only by a spend for its exact price and merchant. Before production (Lin's review, 2026-10-19): merchant names and MCCs are self-declared, so an agent's MCC allowlist is only as good as the merchant's word, and the MCC must come from the acquirer or network. Merchant signup is unverified. The public `/pay` and `/v1/checkouts` endpoints need rate limiting. Tests: `test/checkout.test.ts`.

**Ops: clearing a checkout held for review.** A checkout with `needs_review` set stays `processing`, and nobody can pay it, until a person decides. Find them with `SELECT checkout_id, attempt, spend_id, needs_review FROM app_checkout WHERE needs_review IS NOT NULL;`. The payment behind it is an ordinary spend, settled (or held) on its own by reconcile; check it in `app_spend` first. If the merchant was paid in full by that spend, leave the checkout alone (or, for "approved after the checkout moved on", refund one of the two charges). If the spend does not belong to this checkout (wrong amount or merchant), reopen the checkout. The next claim takes a new attempt and so a new spend key. Pin the reopen to the attempt you reviewed: a stale "approved after the checkout moved on" note can sit on a checkout whose newer attempt is still in flight, and reopening that would let it be charged twice:

```sql
UPDATE app_checkout
SET status = 'open', card_id = NULL, agent_id = NULL, spend_id = NULL, claimed_at = NULL,
    needs_review = NULL, last_error = 'reopened by ops after review', updated_at = now()
WHERE checkout_id = 'cs_…' AND attempt = <attempt you reviewed> AND status = 'processing' AND needs_review IS NOT NULL;
```

If the UPDATE affects 0 rows, re-check: someone claimed the checkout in the meantime. The public `/pay` and `/v1/checkouts` endpoints are only reachable from this machine while the server binds 127.0.0.1; rate limiting becomes a must the moment that bind changes.

**Ops: a payout flagged `needs_review` (nonce replaced).** The queue is stopped behind it, and the money stays reserved. Find it with `SELECT payout_id, rail_reference, nonce, needs_review FROM app_payout WHERE needs_review IS NOT NULL AND status = 'sending';`. A person, not code, must check: on a Base Sepolia block explorer, confirm that `rail_reference` is not on chain at any depth, and find which transaction did use that nonce from the payout account. A lagging public RPC node can report "replaced" wrongly, and releasing then would pay the merchant twice. Only then settle it with `checkout.settlePayout(id, { sent: false, failure: "…" }, { afterReview: true })` (money back to the merchant), or with `{ sent: true, railReference: "<the hash that did go out>" }` if our transfer did land under another hash. `afterReview` works only while `needs_review` is set. A crash (or error) between the row update and the ledger step leaves the money in `payout_pending` only until the next `CheckoutService.sync()`, which re-runs `settlePayout` with the row's own outcome for every sent/failed payout that has a reservation and no complete/release entry; calling `settlePayout` again by hand does the same. The same goes for a `failed` payout that still shows pending money (ops failed it while its reservation was still being made): call `settlePayout` again with the same failure to release it.

Owner tokens can be replaced with `POST /api/me/token` (the old one stops working). Every POST must be `content-type: application/json`, and a browser `Origin` other than ours gets a 403.

**Not production-ready, by design:** the deposit mnemonic is a local file (production needs HSM/KMS or a custody provider, plus sweeping to treasury); agents can only pay through the sandbox simulator (real merchants would need card details handed to the agent, which bypasses our limits unless Miden's authorization is customer-managed, item 3 below); owner tokens do not expire and signup does not verify the email (production needs email verification or magic-link login); deposits credit after 5 blocks on testnet, while Base mainnet must use `finality: "finalized"` (wired in `main.ts` for `chain = base`); the free RPC has no SLA.

## Open items

Auth, signing, KYC, card issuance, top-ups and simulated purchases are verified against the sandbox (2026-10-19, see `docs/miden-api.md` and [Sandbox service](#sandbox-service-end-to-end)).

1. **Sandbox verification: done.** Amounts are dollars (confirmed); `clientReference` is not unique on Miden's side, so idempotency rests on the `Reference` header (derived from it); our reference is visible in Miden's transaction lists. Still unverified: webhooks (item 7).
2. **Card KYC / cardholder:** decided 2026-10-19: every user does their own quick Card KYC at signup (`src/users/onboarding.ts`) and gets ONE real card under their own Miden customer (`src/cards/tiers.ts`: quick/full tiers set the limits; amounts are placeholders). Agents are ledger sub-balances with their own spend policy on that card (`src/agents/wallets.ts`, `Ledger.allocateToAgent` etc.), so they need no KYC. Reason: Miden caps a customer at 3 cards (sandbox), and retail cards cannot be issued under a KYB business customer. Agent limits are enforced by us only for spends that go through `AgentWallets.spend()`; card details used directly bypass them unless Miden's authorization is customer-managed (item 3).
3. **Authorization model:** Miden-managed (our `authorize()` is advisory; limits must be pushed to Miden) vs customer-managed (Miden calls us per transaction). Not decided. Security review (Lin, 2026-10-19) rates this the top production gap: with real merchants, purchases arrive through Miden's authorization, not `/agent/v1/pay`, so the authorization callback must become where agent policy and sub-balances are enforced (signature-checked with `MIDEN_WEBHOOK_HASH`), and agents must never see card details. Blocked on the model decision and on webhooks (item 7).
4. **Chain watching (USDC on Base): built and running in the sandbox service** on Base Sepolia with our own HD wallet and a free public RPC (boss's decision for the sandbox, 2026-10-19). Checked read-only against Base mainnet too. `PgCursor` / `PgDepositAddresses` now run against Postgres in the tests. Before production: real key custody and sweeping, and a paid RPC (the public `mainnet.base.org` returns 429 on `eth_getLogs`).
5. **Funding the USD wallet:** how the stablecoins we receive become dollars in the Miden USD wallet (bank wire vs Miden stablecoin collection) is open.
6. `CardService.authorize()` keeps spend in memory per process. The sandbox service does not use it: agent spends are persisted in `app_spend`, and daily limits are enforced in Postgres.
7. **Webhooks:** the signature scheme is documented (HMAC-SHA256 over `eventId&eventTime`, `src/webhooks/signature.ts`) but not yet seen on a live delivery, and subscribing is blocked by Miden rejecting an "authorization URL" we never send (see `docs/miden-api.md`). `scripts/webhook-receiver.ts` plus `scripts/webhook-subscribe.ts` are ready for when that is cleared. The signature does not cover the body, and Miden sends the hash itself in a `webhook-hash` header, so never trust webhook amounts without re-reading them from the API.
