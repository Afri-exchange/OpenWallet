# Checkout, settlement and payouts

How merchants get paid by agents. SDK reference: [sdk/checkout/README.md](../sdk/checkout/README.md). Tests: `test/checkout.test.ts`. Sandbox only.

## Checkout

A merchant signs up for a secret key (`mk_…`) and creates a fixed-price checkout (`cs_…`, with a `/pay/cs_…` page). The agent pays it with the MCP tool `pay_checkout` or `POST /agent/v1/checkouts/<id>/pay`. The merchant fulfils the order once the checkout reads `paid`.

The payment is an ordinary agent payment (`CardholderInteractor.pay`), so agent and card limits, the MCC allowlist, idempotency and reconcile all apply. `src/lib/interactors/CheckoutInteractor.ts` guarantees a checkout is paid at most once:

- an atomic claim, plus a spend key per attempt (`checkout:<id>:<n>`), so a declined attempt can be retried and one attempt is never charged twice
- spend keys starting `checkout:` are reserved: an agent cannot pre-spend under one
- a checkout is marked paid only by a spend for its exact price and merchant

The card is charged through Miden's simulator under the merchant's name.

## Settlement

Decision (2026-10-19): we are merchant of record, so card details reach neither agents nor merchants.

- A checkout that moves to `paid` credits `merchant:<id>` (`external:merchant → merchant:<id>`, key `checkout-settle:<checkout id>`), at most once. A crash before the credit is healed by `sync()` via `app_checkout.settled_seq`.
- A charge approved after its checkout moved on is not credited; it goes to review ([ops](ops.md)).
- Merchants read `GET /merchant/v1/balance` and request payouts with `POST /merchant/v1/payouts`.
- Merchant balances cannot go negative (ledger and database CHECK).
- `Ledger.refundCheckout` takes back at most what a checkout settled, once, and fails rather than overdraw a merchant who has been paid out.

## Payouts

Rail: **USDC on Base Sepolia, testnet only** (decided 2026-10-19; bank transfers later). `UsdcPayoutRail` refuses mainnet.

- The merchant sets an address with `POST /merchant/v1/payout-address` (never one of our deposit addresses or the payout account). A new address can be paid only after `PAYOUT_ADDRESS_DELAY_S` (10 min in the sandbox, 24 h default in code). Each payout records the address it was requested to, so a stolen key cannot redirect money at once.
- A payout is reserved (`merchant → payout_pending`, key `payout-reserve:<id>`) before anything is sent. It is completed or released only on the rail's definite answer (`CheckoutInteractor.settlePayout`). A missing answer never releases. The rail sends only payouts whose reservation exists.
- `PayoutInteractor` (`src/lib/interactors/PayoutInteractor.ts`) runs in the background loop, one sender across processes by advisory lock. It signs from our payout account (`m/44'/60'/1'/0/0`, logged at startup; fund it with test USDC and Base Sepolia ETH) at an explicit nonce, stores the signed bytes, then broadcasts. One transfer in flight at a time.
- A lost answer is rebroadcast with the same bytes, so it mines at most once. After 5 confirmations it is `sent`. A revert on chain is `failed`, money back in the balance.
- If our nonce is used by another transaction, the payout is flagged `needs_review`, the money stays reserved and the queue stops. Ops runbook: [ops.md](ops.md).
- `settlePayout` claims the payout row before moving money, so ops and the sender never both settle one payout. Ops can settle only a `requested` payout; the rail only a `sending` one (the review case above is the one exception).
- If a transfer fails to sign while the payout account has enough USDC and gas, that payout is the cause (say, a blacklisted address). It is skipped so it cannot block others, and after 3 tries it fails and its money is released (safe: nothing was signed). If the account is short of USDC or gas, the queue stops.

## Before mainnet

Testnet USDC has no value, so these are accepted in the sandbox. Each blocks production. Also listed in [production-gaps.md](production-gaps.md).

- Real key custody for the payout account.
- Email re-authentication for a payout-address change, plus a notification to the merchant with a way to cancel pending payouts during the delay.
- Re-authentication or a notification for `POST /merchant/v1/key` (a stolen `mk_` key can rotate the real merchant out).
- Fee bumping for a transfer stuck on low gas (`maxFeePerGas` is 3× base fee plus tip). A bump must replace the transfer at the same nonce, stored and rebroadcast the same way, never send a new one.
- A settlement hold, built on Miden's capture webhook, not a timer (review, 2026-10-19). Today a merchant is credited on card authorization and can request a payout at once, but an authorization can be reversed or charged back and no money reaches us yet. Credit `merchant_unsettled:<id>` first, move it to `merchant:<id>` on capture or after a hold window, and let payouts draw only on `merchant:<id>`.
- Merchant KYB before the first payout. Signup is open, so a stolen agent token plus a self-made merchant could pay itself out.
- A refund API. The agent's credit must hang off the same `checkout-refund:<id>` key so the two cannot drift.
- MCC and merchant names are self-declared, so an agent's MCC allowlist is only as good as the merchant's word. The MCC must come from the acquirer or network. Merchant signup is unverified.
- Rate limiting on the public `/pay` and `/v1/checkouts`.
