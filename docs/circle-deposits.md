# Circle deposits (sandbox)

Instead of polling Base for transfers to addresses we derive, a Circle developer-controlled wallet is created for each card on the fly, and Circle calls us when USDC arrives. Code: `src/chain/circle.ts`, route `POST /webhooks/circle` in `src/app/server.ts`, wiring in `src/app/main.ts`, tests `test/circle.test.ts`. Reference: Circle's skills page (developers.circle.com/ai/skills), `use-developer-controlled-wallets`.

**Status: unit-tested against mocks, and checked end to end once in the sandbox** with a real 20 USDC faucet deposit on Base Sepolia (Circle wallet per card, signed webhook, ledger credit; the catch-up pass covers missed deliveries). Only that one path was exercised: ETH-SEPOLIA, a redelivery from Circle itself and a longer outage were not.

Open before production: sweeping and withdrawals are not built (see Limits); transfers under one cent are neither credited nor logged by the webhook (reconcile logs them once); and a window busier than 500 inbound transfers is only partly covered by the catch-up pass (see Limits).

## Setup

1. Circle Console: create a **TEST** API key, and generate and register an entity secret (32 random bytes as 64 hex characters; keep Circle's recovery file safe).
2. Environment (never in the repo): `CIRCLE_API_KEY` (`TEST_API_KEY:...`, anything else is refused), `CIRCLE_ENTITY_SECRET`, `CIRCLE_WALLET_SET_ID`.
3. `tsx scripts/circle-setup.ts wallet-set` prints a wallet set id for `CIRCLE_WALLET_SET_ID`. Keep it fixed: it is part of the wallet idempotency key.
4. Circle must reach `/webhooks/circle` over public HTTPS (a tunnel for a laptop). List the tunnel host in `WEBHOOK_ONLY_HOSTS` (comma separated) and **not** in `ALLOWED_HOSTS`: a webhook-only host answers just `/webhooks/circle` and `/healthz` (everything else is a 404), so the public tunnel never exposes the dashboard or APIs. Restart the service for it to take effect, then `tsx scripts/circle-setup.ts subscribe https://<host>/webhooks/circle`.
5. Start the service. With the key set, new cards get Circle wallets (BASE-SEPOLIA, EOA) and the chain pollers are off (`CHAIN_WATCHER=1` keeps them for older HD addresses).

## Flow

`ensureDepositAddress` → `deriveAddress(index)` → `createDepositWallet(index)` (idempotent per index, so a retry returns the same wallet) → address stored in `deposit_address` before it is shown.

Webhook: verify `X-Circle-Signature` (ECDSA SHA-256, public key by `X-Circle-Key-Id`) over the raw body, then **re-read the transaction from Circle's API** and credit only if it is `INBOUND`, `COMPLETE`, on a supported chain, a USDC token, to one of our addresses. The ledger key is `deposit:circle-<chain>:<txHash>:0`, so Circle's at-least-once redelivery credits once. Non-2xx makes Circle retry; ignored events return 200. Sub-cent dust is never credited; dust left over from a credited deposit is logged once. A notification key lookup that fails is logged with Circle's real status (the caller only sees 401), and only failed lookups count against the 20-a-minute budget.

## Limits

- Sandbox only; no sweeping, no withdrawals. Circle holds the keys, which is the custody answer for later, but treasury movement is not built.
- Only BASE-SEPOLIA wallets are created; ETH-SEPOLIA deposits are credited if the same address receives them, which is unconfirmed.
- The catch-up pass (once a minute) reads the last 2 hours, up to 10 pages of 50, newest first (`pageAfter`). A longer outage or a busier window needs a longer lookback or a manual run. Transfers to our addresses that it will not credit (wrong token, odd shape, under a cent) are logged once each.
- Address creation is serialised per card within one process and prefers the lowest `derivation_index`; two processes racing on one card could still leave an unused extra Circle wallet, which is harmless.
