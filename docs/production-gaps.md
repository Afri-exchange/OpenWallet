# Production gaps and open items

The sandbox is verified (auth, signing, KYC, card issuance, top-ups, simulated purchases; 2026-10-19, see [miden-api.md](miden-api.md)). This is what production still needs. Merchant and payout gaps are in [checkout-payouts.md](checkout-payouts.md#before-mainnet).

## Not production-ready, by design

- **Custody:** the deposit mnemonic is a local file. Production needs HSM/KMS or a custody provider, plus sweeping to treasury.
- **Agent payments:** agents pay only through the sandbox simulator. Real merchants would need card details handed to the agent, which bypasses our limits unless Miden's authorization is customer-managed (item 3).
- **Auth:** owner tokens do not expire and signup does not verify email. Production needs email verification or magic-link login.
- **Finality:** deposits credit after 5 blocks on testnet. Base mainnet must use `finality: "finalized"` (wired in `main.ts` for `chain = base`).
- **RPC:** the free public RPC has no SLA and returns 429 on `eth_getLogs` for mainnet. Use a paid one.

## Open items

1. **Sandbox verification: done.** Amounts are dollars. `clientReference` is not unique on Miden's side, so idempotency rests on the `Reference` header (derived from it); our reference shows in Miden's transaction lists. Webhooks still unverified (item 7).
2. **Card KYC / cardholder (decided 2026-10-19):** every user does their own quick Card KYC at signup (`src/adapters/onboarding/onboarding.ts`) and gets ONE real card under their own Miden customer (`src/lib/services/tiers.ts`; amounts are placeholders). Agents are ledger sub-balances with their own policy (`src/lib/services/AgentWallets.ts`), so they need no KYC. Why: Miden caps a customer at 3 cards (sandbox), and retail cards cannot be issued under a KYB customer. Agent limits bind only spends through `AgentWallets.spend()`; card details used directly bypass them unless authorization is customer-managed (item 3).
3. **Authorization model, not decided:** Miden-managed (our `authorize()` is advisory; limits must be pushed to Miden) vs customer-managed (Miden calls us per transaction). This is the top production gap (2026-10-19): with real merchants, purchases arrive through Miden's authorization, not `/agent/v1/pay`, so the authorization callback must enforce agent policy and sub-balances (signature-checked with `MIDEN_WEBHOOK_HASH`), and agents must never see card details. Blocked on the decision and on item 7.
4. **Chain watching (USDC on Base):** built and running on Base Sepolia with our own HD wallet and a free public RPC. Before production: real key custody and sweeping, and a paid RPC.
5. **Funding the USD wallet:** how received stablecoins become dollars in the Miden USD wallet (bank wire vs Miden stablecoin collection) is open.
6. `CardService.authorize()` keeps spend in memory per process. The sandbox service does not use it: spends persist in `app_spend` and daily limits are enforced in Postgres.
7. **Webhooks:** the signature scheme is documented (HMAC-SHA256 over `eventId&eventTime`, `src/lib/clients/cardIssuing/miden/webhookSignature.ts`) but not seen on a live delivery, and subscribing is blocked by Miden rejecting an "authorization URL" we never send. `scripts/webhook-receiver.ts` and `scripts/webhook-subscribe.ts` are ready. The signature does not cover the body, and Miden sends the hash itself in a `webhook-hash` header, so never trust webhook amounts without re-reading them from the API.
8. **Splitting `CardholderInteractor` (layering, step 3):** the data access is done (Drizzle repositories, no SQL in interactors; see architecture.md "Data access"). What remains is splitting the large `CardholderInteractor` into user, agent and spend interactors.
