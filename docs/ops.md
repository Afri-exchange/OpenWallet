# Ops runbooks

Manual steps for things the code deliberately will not decide on its own. Sandbox service, Postgres.

## A checkout held for review

A checkout with `needs_review` set stays `processing` and nobody can pay it until a person decides.

1. Find them:

   ```sql
   SELECT checkout_id, attempt, spend_id, needs_review FROM app_checkout WHERE needs_review IS NOT NULL;
   ```

2. Check the spend behind it in `app_spend`. It is an ordinary spend, settled (or held) by reconcile.
3. Decide:
   - Merchant paid in full by that spend: leave the checkout alone. For "approved after the checkout moved on", refund one of the two charges.
   - Spend does not belong to this checkout (wrong amount or merchant): reopen it. The next claim takes a new attempt, so a new spend key.
4. Pin the reopen to the attempt you reviewed. A stale note can sit on a checkout whose newer attempt is still in flight, and reopening that would charge it twice:

   ```sql
   UPDATE app_checkout
   SET status = 'open', card_id = NULL, agent_id = NULL, spend_id = NULL, claimed_at = NULL,
       needs_review = NULL, last_error = 'reopened by ops after review', updated_at = now()
   WHERE checkout_id = 'cs_…' AND attempt = <attempt you reviewed> AND status = 'processing' AND needs_review IS NOT NULL;
   ```

   If it updates 0 rows, someone claimed the checkout meanwhile. Re-check.

`/pay` and `/v1/checkouts` are reachable only from this machine while the server binds 127.0.0.1. Rate limiting becomes mandatory the moment that changes.

## A payout flagged `needs_review` (nonce replaced)

The payout queue is stopped behind it and the money stays reserved.

1. Find it:

   ```sql
   SELECT payout_id, rail_reference, nonce, needs_review FROM app_payout WHERE needs_review IS NOT NULL AND status = 'sending';
   ```

2. A person, not code, checks a Base Sepolia block explorer: `rail_reference` must not be on chain at any depth, and find which transaction used that nonce from the payout account. A lagging public RPC can report "replaced" wrongly, and releasing then would pay the merchant twice.
3. Only then settle it:

   ```ts
   // money back to the merchant
   checkout.settlePayout(id, { sent: false, failure: "…" }, { afterReview: true });
   // or, if our transfer landed under another hash
   checkout.settlePayout(id, { sent: true, railReference: "<the hash that did go out>" }, { afterReview: true });
   ```

   `afterReview` works only while `needs_review` is set.

**Crash between the row update and the ledger step:** money sits in `payout_pending` until the next `CheckoutInteractor.sync()`, which re-runs `settlePayout` with the row's own outcome for every sent/failed payout that has a reservation and no complete/release entry. Calling `settlePayout` again by hand does the same. The same applies to a `failed` payout that still shows pending money: call `settlePayout` again with the same failure.

## Tokens and POSTs

- Owner tokens are replaced with `POST /api/me/token`; the old one stops working.
- Every POST must be `content-type: application/json`. A browser `Origin` other than ours gets a 403.
