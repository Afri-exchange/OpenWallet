# Checkout swap: agents paying hosted checkouts

An agent pays a third-party hosted checkout page (Stripe Checkout `checkout.stripe.com/c/pay/...`, or a Payment Link `buy.stripe.com/...`). The agent sends the URL and the exact price it agreed to. Our server opens the page and puts in the owner's real card, which it reads from the vault. The agent never sees the card.

```
agent ── pay_hosted_checkout(url, amount, merchant, key) ──► SwapService
  1. validate: swap on, host allowlisted (https), amount ≤ cap ($10), key present, card in vault
  2. AppService.pay under spend key checkout:swap:<swapId>: agent limits, balance, ledger debit
  3. charge (one at a time per process):
       vault.reveal(card, "checkout:<swapId>")   ← audited, after the debit, just before the page
       PlaywrightFiller: load → bot check? → read the total, must equal amount → type card → pay → watch
       scrub(details) in a finally
  4. outcome → spend: succeeded = approved · declined / not submitted = voided (debit undone)
                       submitted, no clear answer (3DS, captcha after submit, timeout) = processing (money held)
  5. reconcile (every 5 s tick, after 60 s): match the card's Miden Authorization by amount + time, unclaimed
       one approved → paid · declined → voided · several → needs_review · none after 30 min → needs_review
     and for pages that said "paid": confirm on the card and record the real MCC; mismatch or nothing → review
```

Code: `src/checkout-swap/` (`swap.ts` service, `playwright-filler.ts`, `filler.ts` types and scrub, `fixture.ts` local Stripe-like page), migration `009_checkout_swap.sql`. The vault and card capture are Kai's: `src/vault/vault.ts`, `src/cards/service.ts`.

## Statuses

| status | meaning | money |
| --- | --- | --- |
| `paid` | page confirmed (and later the card, see `underReview`) | debited |
| `failed` | declined, price mismatch, unsupported page, limits | returned |
| `challenge` | captcha or 3-D Secure. Never retried automatically. A new attempt needs a new key. | returned if stopped before submit, held if after |
| `processing` | submitted, answer unknown | held until reconcile |
| `needs_review` | ambiguous or silent card. A person decides. | held |

A failed attempt (declined, mismatch, unsupported page, limits, or a challenge stopped before submit) costs nothing: the debit is undone.

Rules kept from the device side: a challenge is its own failure state; the reveal happens as late as possible; nothing from the page is captured once the card is typed (no DOM, no screenshot, decline text matched but not stored); error text is stripped of card values.

## Config (env)

| var | default | |
| --- | --- | --- |
| `SWAP_ENABLED` | off | `1` turns it on. Needs `CARD_VAULT_KEY`. |
| `SWAP_MAX_CENTS` | `1000` | hard cap per swap |
| `SWAP_ALLOWED_HOSTS` | `checkout.stripe.com,buy.stripe.com` | exact https hosts |
| `SWAP_INSECURE_HOSTS` | none | http hosts, for the local fixture only |
| `SWAP_RECEIPT_EMAIL` | owner's email | fallback receipt email |

Agent surfaces: MCP `pay_hosted_checkout` / `get_hosted_checkout_payment`; REST `POST /agent/v1/hosted-checkouts/pay`, `GET /agent/v1/hosted-checkouts[/sw_...]`.

Matching: on a real checkout the card's `merchantMid` belongs to the merchant's acquirer and is the same for every payment to that merchant, and `transactionReference` is only known afterwards. That leaves amount + time as the only way to match (on the Miden sandbox mock path, `midFor(spendId)` makes `merchantMid` unique per spend, so it matches by MID instead). Two guards:

- **Busy**: while one swap of a given amount on a card is still unsettled (pending, filling, processing, a held challenge, or paid on the page but not yet seen on the card), a new swap of the same amount on that card gets a 409 saying "try again in a minute". Nothing is reserved. A retry under the same idempotency key is never refused.
- **Backstop**: if two unsettled swaps could still own one authorization (for example, one is left in `needs_review`), neither claims it. Both go to review and the money stays held.

Known limit: an agent paying the same amount twice in quick succession on one card waits for the first payment to show on the card, about a minute.

MCC: on a swap the agent declares the merchant category, and nothing verifies it at payment time. The real fence is the card's `whiteListedMccs`, set at issue (network enforcement is unconfirmed). Reconcile compares the declared MCC with `merchantMcc` on the card's Authorization and flags any mismatch.

## Proving it without real money

The live $10 test is parked: no live payments for now. It is covered in two halves instead:

1. **Card side, Miden sandbox**: `tsx scripts/swap-sandbox-e2e.ts --card <sandbox cardId> --amount 1.00`. A real sandbox card's details go through the vault and real Chromium onto the fixture page. Pressing pay fires Miden's mock authorization, and the script matches it on the card's transactions.
2. **Page side, Stripe test mode**: `tsx scripts/swap-rehearsal.ts --url <Stripe TEST Checkout or Payment Link> --amount <exact total>` pays with Stripe's 4242 test card. It refuses non-test URLs. With no `--url` it runs every fixture scenario.
3. **Logic**: `test/checkout-swap.test.ts` covers the filler on the fixture and the service against Postgres: idempotency, cap, limits, scrub, audit, challenge, reconcile, MCC review, and same-amount busy/rival handling.

Result of step 2 against a real Stripe test-mode Checkout ($1.00, 2026-10-19): **passed**, and Stripe's API confirmed the session `complete / paid`. Getting there needed four fixes to the filler, and each one is now mirrored in the fixture:

- The page is client-rendered, and the total's container appears before its text. The filler now polls for a readable total, and reloads once (before anything is typed) if the page never renders. That happens intermittently in headless Chromium.
- Every Stripe page loads an invisible hCaptcha in a hidden 1px frame. Only a captcha frame that is actually visible counts as a bot check.
- The card accordion button is 0x0 and takes clicks through a pseudo-element, so the filler clicks the row.
- The pay button goes `--clickable` → `--complete` (form complete, ready) → `--processing` → `--success` → redirect. `--complete` is **not** paid: treating it as paid gave a false "succeeded" on an unpaid session. The filler waits for ready before pressing, and counts only `--success` or the redirect as paid.

Sessions with tax on (Managed Payments) or `billing_address_collection=required` demand a full street address. `CardDetails.billingAddress` holds it. Without one on file, the filler stops **before** pressing pay (`unsupported_page`, nothing charged). The address comes from Miden's full-PAN `billingDetails` (the KYC address submitted at onboarding), mapped by `toBillingAddress()` only when line 1, city and country are all set. Country is alpha-2 (`NG`); state is a name (`Lagos`), so a state dropdown is matched on value or label. The filler also stops before paying if the page cannot select the card's country or has no matching state option, so it never types one country's address into another country's form. Already-vaulted cards pick up the address with `scripts/card-capture-check.ts --capture <id> --persist --refresh`.

Rehearse the address path with `tsx scripts/swap-rehearsal.ts --url <cs_test url> --amount 10.00 --miden-address` (a synthetic Lagos address on the 4242 test card). Passed on 2026-10-19: Stripe recorded the session as paid with the full NG address. Test sessions created through the API on this account need `managed_payments[enabled]=false` unless the product has a tax code.

What these cannot prove: a real card accepted on a live Stripe page, a real issuer's 3DS behaviour, our live Stripe account's MCC. `scripts/swap-live-test.ts` stays ready for that. It runs a preflight checklist, refuses anything over $10, needs `--confirm-live`, keeps a journal per URL so it can never pay twice, and writes its report to `.live-test/`.

## Shopify checkouts

`ShopifyFiller` (`shopify-filler.ts`) pays `https://<shop>/checkouts/...` pages; `RoutingFiller` picks it (or the Stripe filler) from the URL. Each shop's host must be added to `SWAP_ALLOWED_HOSTS` (for example `yourshop.myshopify.com`); there is no `*.myshopify.com` wildcard, because anyone can open a Shopify store.

It checks the total at load, again after the contact/shipping steps (shipping and tax change it), and once more just before pressing pay; the card is typed only after the second check. A total not in USD, a missing delivery address, or an unmatched country/state stops the run before the card is typed. Card fields live in separate iframes and are typed key by key.

**Tested** against a local mock (`shopify-fixture.ts`, `test/shopify-filler.test.ts`, 9 tests passing): logic, price checks, multi-step flow, outcome classification, Bogus Gateway rules (card `1` pays, `2` declines, `3` raises).

**Not tested**: that Shopify's real markup matches our selectors (input names, card-frame titles, `#checkout-pay-button`, total markup are from published knowledge, not a live page), Shopify's bot checks, real 3-D Secure.

**To test on a real page for free**: create a Shopify development store (free Partner account), enable the Bogus Gateway under Payments, open a checkout, and run the filler with a card whose number is `1`.
