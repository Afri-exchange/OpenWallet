# Miden Workspace API: what the docs actually say

## Sandbox verification, 2026-10-19

Run from IP 102.90.125.46 (whitelisted) with the account's sandbox keys. Read-only calls only.

- **Token: CONFIRMED.** `POST <tokenUrl>` with Basic auth returns 200 `{ access_token, expires_in: 3600, token_type: "Bearer", scope: "CardAPIs" }`. The token is a JWT (claims include `client_id`, `client_UniqueKey`, `client_TenantId`; lifetime 3600 s).
- **Signature: CONFIRMED `base64-of-hex`.** `GET /api/v1/wallet/balances`: base64-of-hex → 200; base64-of-digest → 403 `{"isSuccessful":false,"message":"Invalid Signature"}`; garbage → 403 same; no header → 403 "Signature Cannot be empty". Bad signatures are **403, not 401**. The mode switch has been removed.
- **Signed URL includes the query string: CONFIRMED** (`/api/v1/wallet/transactions?TransactionType=CardTopUp&pageNumber=1&pageSize=3` → 200).
- **Wallet balances shape: CONFIRMED** as documented, plus `thirdPartyWalletNumber` and `thirdPartyBankName`. Two wallets (USD, NGN). Balances are major units with decimals (e.g. USD `walletBalance` 2784.37).
- **Amount units for top-up/issue/limits: still UNCONFIRMED.** The wallet reads in dollars, which supports the dollars assumption, but the request side was not exercised: wallet and card transaction histories are empty, and proving it needs a top-up (a write).
- **Webhook signature: DOCUMENTED, not yet seen live.** The 2026-10-13 research missed `get-started/generate-webhook-signature-hash.md`: `x-signature` = lowercase hex HMAC-SHA256(key = webhook hash, msg = `${eventId}&${eventTime}`), consistent across the C#, JS and Java samples. **The page's own sample output (`97b24d88…`) does not match that algorithm** (openssl gives `4ece7095…`; separator, timestamp format, key/message order and hash variants were tried, none reproduce it). Implemented in `src/lib/clients/cardIssuing/miden/webhookSignature.ts`, tested against openssl, and not yet enforced anywhere until a real delivery verifies.
- **Webhook security weaknesses (for the write-up and Miden):**
  1. Every webhook request carries a `webhook-hash` header that is **base64 of the webhook hash itself**, i.e. the HMAC key in transit. Anyone who sees one request (proxy, tunnel, access log) can forge signatures. Receivers must never log that header; `scripts/webhook-receiver.ts` redacts it.
  2. The signature covers only `eventId` and `eventTime`, **not the body**. Amounts and balances in a webhook are unauthenticated; re-read them from the API (card balance / `transactions-status`) before acting on money.
  3. No stated replay window; dedupe on `eventId` and reject stale `eventTime`.
- **Webhook subscribe: BLOCKED.** `PATCH /api/v1/webhook/subscribe` with both URLs at a reachable HTTPS tunnel: Miden probed each URL (empty-body POST, `accept: application/json`, `webhook-hash` header, from 98.95.144.67 / AWS), got 200 both times, then returned 400 `responseCode 119` "Invalid Card Transaction Authorization Url, ensure the url is reachable over the internet". We sent no such URL. Most likely the account has a customer-managed authorization URL configured (dashboard or onboarding) that is unreachable, and subscribe validates it too. That field is not in the subscribe docs; not guessed, because setting it may change the authorization model. Ask Miden / check the dashboard Developer page.
- Docs now say `Reference` may be up to 30 chars; we send 20, which works.

Researched 2026-10-13 from docs.miden.co (every page has a raw `.md` twin, e.g. `https://docs.miden.co/cards/miden-managed-authorizations/card-transactions/transactions/card-top-up.md`; the full index is `https://docs.miden.co/llms.txt`). No sandbox credentials were used; **nothing here was verified against a live server**. Anything the docs do not state is marked **UNCONFIRMED**.

- Base URL (sandbox): `https://sandbox-api.midencards.io/miden`, so full URLs are `…/miden/api/v1/…`. Production: UNCONFIRMED ("contact your account manager").
- Token URL (sandbox): `https://sandbox-identityserver.midencards.io/connect/token` (separate host, by design).

## Corrections to our placeholders

| Placeholder | Reality |
|---|---|
| `POST /api/v1/cards` with `{ reference: agentId }` | Issuance is `POST /api/v2/cards/issue` and needs a **`customerId` + `kycToken` from Card KYC first** (see below). There is no `reference` field; the fields are `clientReference` (body) and the `Reference` header. |
| `MidenClient` generates a random `Reference` per request | `Reference` is Miden's **idempotency key**. A random one per call defeats idempotency. `request()` now takes `opts.reference`. |
| `MidenClient` throws a plain `Error` | Now throws `MidenApiError` (`status`, `body`) so callers can tell "already seen" from a 5xx. |

## Auth (every request)

Headers, per the Get Started page and each endpoint's header list:

| Header | Value |
|---|---|
| `Authorization` | `Bearer <access_token>` |
| `MidenAuthorization` | `MidenAuth ` + base64(clientId) |
| `Reference` | per-request nonce, also part of the signature, also the idempotency key |
| `Signature` | see below |
| `UniqueKey` | issued at onboarding (a GUID; also the AES key material for card-detail encryption) |
| `Content-Type` | `application/json` |

(`X-Requested-With: XMLHttpRequest` is listed on the top-up endpoint, marked not required.)

Token: `POST <tokenUrl>`, `Authorization: Basic base64(clientId:clientSecret)`, `Content-Type: application/x-www-form-urlencoded`, body `grant_type=client_credentials`. The docs call the token "short-lived" but give no `expires_in` value; the response field names are UNCONFIRMED (the C# sample has `token_type`, `scope`, `isSuccessful`; our client assumes `access_token` and `expires_in`).

### Signature: the docs do NOT settle it

String to sign: `METHOD&urlencode(fullUrl)&reference&clientId&clientSecret` (method upper-case). Then SHA-1, then "encoded in Base64".

- The prose only says "hashed using SHA-1, and the resulting hash is then encoded in Base64". That is compatible with either reading.
- PHP, C#, JavaScript and Python samples all call the **hex** digest (`sha1()`, `hexdigest()`, `digest('hex')`) and then base64 that string, so `base64-of-hex`.
- The Go sample returns the hex with no base64 step and no URL encoding. It is evidently broken (undefined variables too), so it is no evidence.
- There are no test vectors or sample outputs anywhere, and no sample shows the signature header being sent. Header name `Signature` comes from the endpoint header tables.

Verdict: the weight of evidence is `base64-of-hex` (four of four working samples), which is our current default. It is still **UNCONFIRMED** until a sandbox call succeeds. Keep `MIDEN_SIGNATURE_MODE`; the first 401 in the sandbox flips it.

Also UNCONFIRMED: whether the signed URL includes the query string (samples say "full URL"; we sign what we send), and whether the nonce must be exactly 20 chars (all samples use 20).

## Idempotency (the `Reference` header)

From "Idempotency in Miden APIs":
- Miden stores each `Reference` for **24 hours**.
- Retrying a request that **failed or timed out** with the same `Reference` and the **same body** processes it once.
- Retrying a request that **already succeeded** returns **HTTP 400** with `"The Reference value has already been seen in the last 24 hours."` It does *not* replay the original response. So after an ambiguous failure, a 400 "already seen" means the first attempt landed and you must look the result up.
- A fresh `Reference` is needed for each genuinely new operation.

`clientReference` (body) is a separate field: "Unique reference for tracking and idempotency of the request" on top-up; "Unique reference for the request" on issuance. **Whether a duplicate `clientReference` is rejected is UNCONFIRMED** (no page says so). Its max length and character set are UNCONFIRMED.

## Errors

Two layers: HTTP status and a body `responseCode`. **A 200 does not mean business success**: check `isSuccessful` and `responseCode` (`"000"` = success on the card/wallet endpoints; the KYC endpoint returned `"00"` in its example; `"119"` = "Invalid wallet parameters" on wallet balances).

HTTP: 200 ok; 400 invalid params (also the duplicate `Reference`); 401 auth; 403 forbidden; 404 not found; 422 business rule; 429 rate limit (retry); 500/502/503/504 indeterminate (retry or check status). Terminal vs indeterminate guidance: never retry a terminal failure unchanged.

Error body shape (seen on wallet balances 400): `{ "data": null, "isSuccessful": false, "responseMessage": "Invalid wallet parameters", "responseCode": "119" }`. The full responseCode catalogue is UNCONFIRMED (only "Card Authorization Response Codes" is documented, for the customer-managed callback). Rate limits: UNCONFIRMED.

## Card KYC (prerequisite to issuing)

"Every card, on either integration model, requires the cardholder to complete Card KYC first. There's no way around this step."

`POST /api/v1/cards/kyc-submit` has three shapes selected by body. Individual by ID document: `customerType: "Individual"`, `phone*`, `email`, `clientReference`, `individualKyc{ firstName*, lastName*, dateOfBirth*, idType*, idNumber*, idFrontImage* (base64/data URI), placeOfBirth, address{ address1*, address2, city*, state*, zipcode*, country* } }`. Business: `customerType: "Business"`, `phone*`, `clientReference*`, `businessKyc{ businessName*, registrationNumber*, businessAddress{…} }`. There are also BVN and NIN variants (Nigeria). Response: `{ isSuccessful, responseMessage, responseCode, customerId, kycToken, kycStatus: "Initiated"|…, rejectionReason, clientReference }`. Business KYB is asynchronous; poll `GET /api/v1/cards/kyc/client-reference/{clientReference}` or use the KYC webhook.

**Consequence for us:** a card needs a verified human or business behind it. An AI agent cannot be the KYC subject. We need one KYC'd customer (our company, via KYB, or one per end user) and many cards under it. Whether many cards per `customerId` is allowed, and any per-customer card cap, is UNCONFIRMED.

## Card issuance

`POST /api/v2/cards/issue` (retail USD virtual card). Also `POST /api/v2/cards/issue-lite` (single-purpose: not reloadable; ends at `swipeCount` or when the balance is exhausted) and `POST /api/v1/cards/issue-corporate`.

Body (all marked not-required in the spec, but KYC output is obviously needed): `kycToken`, `customerId`, `cardBrand` ("Visa"), `initialBalance` (number), `clientReference`, `walletCurrency` ("USD"), `cardCurrency` ("USD"), `email`, `contactlessPayment` (bool), `sharedBalance` (bool; links to another card's balance), `cardLimits{ dailyLimit, transactionLimit }` (strings in the example), `whiteListedMccs[]`, `blackListedMccs[]`.

Response **201**: `{ message, data{ cardCustomerId, cardId, cardBrand, cardClass, limitWindow, expirationDate, terminateDate, currencyCode, firstSix, lastFour, status: "Card - Active", availableBalance, isPhysical, secureCardDetails }, amountDebited, rate, transactionWallet, isSuccessful, responseMessage: "Card Issued Successfully!!!", responseCode: "000" }`. `secureCardDetails` is the encrypted PAN/CVV. **Never log it.**

**CONFIRMED 2026-10-19 (sandbox, card issued under user2):** `secureCardDetails` is base64 AES-128-CBC/PKCS7 keyed from **`ClientId`, not `UniqueKey`**: key = the **last** 16 characters, IV = the **first** 16 (UTF-8). The decrypt page's prose has these the other way round; its code samples and sample vector agree with us. Plaintext is `{"CardNumber","SecurityCode","Expiration":"MMYY"}`, with no name or billing address. (`UniqueKey`, first-16 key / last-16 IV, is for the *outgoing* `encryptedCardDetails` on card payments, a different page.) `src/lib/clients/cardIssuing/miden/cardDetails.ts` still tries both materials and orders and checks the PAN against the issued `firstSix`/`lastFour`, in case live differs.

`GET /api/v1/cards/details/{cardId}/full-pan` **works in the sandbox** after issue and returns the PAN, CVV and expiry in plain fields, plus `firstName`/`lastName` and `billingDetails{ firstName, lastName, addressLine1, addressLine2, city, state, zipCode, country }` (sandbox 2026-10-19: this is the KYC address; country is alpha-2, e.g. `NG`; state is a name, e.g. `Lagos`). It maps to `CardDetails.billingAddress` only when line1, city and country are all set. So "only once" does not hold in the sandbox; whether a live program has full-PAN access is UNCONFIRMED. `CardService` captures at issue and then adds the name, ZIP and street address from full-PAN when it can (`--capture <id> --persist --refresh` backfills cards captured earlier) (src/adapters/cardVault/CardVault.ts holds the details).

Is `reference`/`clientReference` required to be unique? **UNCONFIRMED.** The only stated uniqueness rule is the 24h `Reference` header. Treat `clientReference` as unique per issuance and derive it from something stable per card, not per agent, to be safe. This answers the README gap #5 only partially: the placeholder `reference: agentId` is moot because no such field exists.

Issuance charges the wallet (`amountDebited`, `rate`): FX is applied when wallet and card currencies differ. An issuance fee, if any: UNCONFIRMED. Issuing is instant (the "issued" webhook may not arrive).

## Wallet balance

`GET /api/v1/wallet/balances`, query `walletNumber?`, `walletCurrency?` (e.g. `USD`). Response 200: `{ data: [{ walletNumber, walletName, walletCurrency, walletBalance, walletAvailableBalance, walletUnclearBalance, walletReservedBalance, lienAmount, lastTransactionDate }], isSuccessful, responseMessage, responseCode }`. `walletAvailableBalance` is the spendable amount; reserved funds appear when a card goes negative.

Wallet structure: parent wallet per currency, plus sub-wallets (`POST /api/v1/sub-wallets/create`, `…/allocate-to-sub-wallet`, `…/allocate-to-main-wallet`, `…/transfer-between`). A sub-wallet can only spend its own balance. Which wallet a top-up debits when sub-wallets exist: UNCONFIRMED (the top-up body takes only `walletCurrency`, so presumably the parent).

Also: `GET /api/v1/wallet/transactions/running-balance`, `GET /api/v1/transactions/statement`, and currency swaps (`GET /api/v1/swap/get-rate`, `POST /api/v1/swap/initiate`, `POST /api/v1/swap/complete`).

## Wallet to card funding (Miden-managed model)

`PATCH /api/v1/cards/topup`, "debits the specified amount from your wallet, credits the same amount to the card".

Body: `{ cardId*, amount* (number), clientReference*, walletCurrency* }`.
- **Amount units: UNCONFIRMED.** The examples are consistent with major units (amount 10, `amountDebited` 14297 at `rate` 1429.7 for an NGN wallet to a USD card), so `MidenWalletFunding` sends dollars (`cents / 100`). Check against the sandbox.
- Currency conversion may occur if wallet and card currencies differ.
- Minimum/maximum top-up and per-card maximum balance: UNCONFIRMED (`amountLimit` appears in the card object).

Response 200: `{ data{ cardId, cardBrand, currencyCode, status, availableBalance, amountLimit, cardLimits{…}, firstSix, lastFour, … }, cardTransactionId (number), amountDebited, rate, transactionWallet, balanceBeforeTermination, blockedByAdmin, isSuccessful, responseMessage: "Card Top Up Successful", responseCode: "000" }`. It is synchronous: success means the card balance is already credited. **There is no pending state in this response.**

Related: `PATCH /api/v1/cards/withdrawal` (card to wallet; card must keep at least $1), `PATCH /api/v1/cards/card-to-card`, `PATCH /api/v1/cards/re-process-cross-border/{cardId}`. Their bodies were not read in detail (UNCONFIRMED).

Card balance: `GET /api/v1/cards/balance/{cardId}` returns `{ availableBalance, isSuccessful, responseMessage, responseCode }`.

## Transaction listing

- Cards: `GET /api/v1/cards/transactions`, query `CardId`, `CardGuid`, `TransactionType` (e.g. `Authorization`, `CrossBorderCharge`, `CardIssuance`, `CardFunding`), `transactionStatus` (`Pending`, `Declined`, `Successful`; response shows `Approved`), `Id`, `startDate`/`endDate` (YYYY-MM-DD), `pageNumber`, `pageSize`. Response: `{ isSuccessful, responseMessage, responseCode, transactions[{ id, cardId, uniqueKey, merchantName, merchantCity, merchantState, merchantMcc, merchantMid, merchantCountry, transactionType, transactionStatus, transactionReference, transactionAmount, currencyCode, … }], currentPage, pageSize, totalCount, totalPages }`.
- Single: `GET /api/v1/cards/transactions-status/{transactionReference}` returns `{ …, transaction{ same fields } }`.
- Wallet: `GET /api/v1/wallet/transactions`, query `StartDate`, `EndDate`, `WalletNumber`, `TransactionReference`, `TransactionType` (e.g. `CardTopUp`, `CardWithdrawal`) plus paging. Rows: `{ id, walletNumber, transactionDate, transactionId, transactionAmount, transactionCurrency, transactionType, runningBalance, transactionReference }`.
- **ANSWERED 2026-10-19 (sandbox):** our top-up `clientReference` comes back as `transactionReference` on the card's `CardFunding` transaction (`GET /api/v1/cards/transactions`), and on the wallet's `CardTopUp` row as `thirdPartyTransactionReference` (with `transactionReference` = `"UBND" + clientReference`). Issuance shows `card-<userId>` the same way. So a lost top-up can be found exactly by its reference. Also seen: `GET /api/v1/cards/balance/{cardId}` lags the transaction list by tens of seconds (balance still $1 after a successful $25 top-up and two purchases; correct about a minute later). Never treat the balance read as confirmation of a just-made top-up.
- *Original question:* which field in these listings carries our `clientReference`. `uniqueKey` and `transactionReference` are candidates; the docs do not say. UNCONFIRMED. Until then, find a lost top-up by `CardId` + type + amount + time window, or by the wallet `TransactionType=CardTopUp` list.

## Webhooks

Subscribe: `PATCH /api/v1/webhook/subscribe`, body `{ cardEventWebhookUrl, collectionEventWebhookUrl, webhookHash }`. HTTPS only, publicly reachable. `webhookHash` is alphanumeric only, and is "used later to validate incoming webhook payloads". Calling it again overwrites the config.

Events (all POST to our URL; JSON): `{ cardId, eventId, eventClass, eventTime, eventType, data{…} }`, with `eventId` as the dedupe key. Examples: `purchase.card.topup` (`CardTopUp`; `data{ cardId, amount, reason, oldBalance, newBalance, transactionReference }`), `purchase.card.issued`, approved/declined/settled/reversed/expired authorizations, refunds, card blocked/terminated, cross-border charges, card KYC status. Collections and USD-account webhooks (transfer, inflow, account-drain) are separate.

**Verification algorithm: UNCONFIRMED.** The sample requests show headers named `webhook-hash`, `webhook-Signature` and `X-Signature` (values templated), and the stablecoin webhook page says "verify the webhook signature before processing", but no page defines how the signature is computed from `webhookHash`. Do not build a verifier until this is answered by Miden or seen in a sandbox delivery. Retry/redelivery policy and the expected success response: UNCONFIRMED.

Miden-managed top-ups are synchronous, so we do not need the top-up webhook to fund; it is useful as a cross-check.

## Two authorization models (affects our spend policy)

- **Miden-managed:** Miden approves transactions and holds the card balance; we fund with top-up. Our `CardService.authorize()` is then advisory only: Miden does not ask us. Policy enforcement would have to be pushed into Miden's limits (`cardLimits`, MCC lists, `PATCH /api/v1/cards/set-limit/{cardId}`, `…/minimum-balance/{cardId}`).
- **Customer-managed:** Miden calls *our* authorization endpoint per transaction and we approve or decline, and we manage balance ourselves (top-up/withdrawal/balance endpoints do not apply). This is the model where `evaluate()` in `src/lib/services/spendPolicy.ts` actually gates spending. The callback contract (payload, response codes, latency budget) is in "Authorization Flow" and "Card Authorization Response Codes" and was **not** researched here. Mira should decide the model before more is built on `authorize()`.

## Stablecoins: the premise needs a second look

We assumed Miden does not accept stablecoins. The docs say otherwise in places: Collections has a stablecoin checkout method (webhook "Stablecoin Inflow"), Disbursements supports stablecoin payouts, and USD Business Accounts has a sandbox `stablecoin-inflow` simulation ("simulate stablecoin deposit events"; statuses `FundsReceived`, `PaymentSubmitted`, `PaymentProcessed`) and USDC coin transfers. None of this was read in depth, and whether it is available to our account or suits agent top-ups is UNCONFIRMED. It does not change `MidenWalletFunding`: we still credit our own ledger and top up the card from the USD wallet, which has to be funded from somewhere, and that funding path (bank wire vs Miden's stablecoin collection) is open.

## Sandbox write verification, 2026-10-19 (dummy KYC data; scripts/sandbox-*.ts)

- **Business KYB** (dummy company) returned `kycStatus: "Approved"` immediately with a `customerId`.
- **Individual KYC** works with `idType: "PASSPORT"` (uppercase enum: PASSPORT, NATIONAL_ID, DRIVERS_LICENSE, VOTERS_CARD, ...; "Passport" gives a 400). Dummy data was approved instantly.
- **Many cards per `customerId`: CONFIRMED** for an individual customer (2 cards, 3rd via the duplicate test). No cap seen.
- **Business (KYB) customer + `POST /api/v2/cards/issue` FAILS**: 400 `119 "Field: person.lastName, Message: Invalid lastName"`. Retail issue needs a person. A KYB customer probably needs `issue-corporate` (NOT tried). This affects the basic tier, which issues under our KYB'd platform customer.
- **Minimum initial balance is $1**: `initialBalance: 0` gives 400 `117 "Card Balance Less that Initial Minimum Card of 1"`.
- **Units are dollars: CONFIRMED.** $1 initial + $2 top-up = card balance 3.
- **Issuance cost**: USD wallet fell $6 for 2 cards plus a $2 top-up, so about $1 per card beyond the initial balance (inferred, not read from a fee line).
- **`clientReference` is NOT unique**: the same one with a fresh `Reference` header created a second card. Idempotency comes only from the `Reference` header, which our code derives from `clientReference`.
- **`issue-corporate` is NOT available to us**: 400 `114 "Corporate Spend Card is not enabled for this organization, contact sales team for this feature"`. The docs say Miden must enable it per organization, the RC number must be a valid real company number, and the business address is registered through Miden Support. It takes no `customerId`/`kycToken` (the org itself is the holder). So even once enabled it will not work with dummy data.
- **Workaround for the basic tier**: issue under one individual sponsor customer (a real director/officer, KYC'd as an individual), since many cards per individual `customerId` is proven. Compliance sits with that person's KYC, so confirm with Miden that this use is allowed.
- **CORRECTION: max 3 cards per customer** in the sandbox: 4th issue gives 400 `111 "Maximum Number of Cards Per customer Limit 3 Exceeded, Contact Support"`. Production limit unknown (Miden Support can presumably raise it). This undercuts the sponsor design: one sponsor holds at most 3 cards.
- Customers are de-duplicated by identity: a second KYC with the same dummy ID returned the same `customerId`. Use distinct `idNumber`/phone/email per dummy customer.
- **Card e2e passes in the sandbox** (`scripts/e2e.ts`): KYC lookup, issue, $5 top-up (card $7 incl. $2 initial), policy check, simulated $2 purchase approved, balance $5.

## Simulated authorization, 2026-10-19 (sandbox probe, $0.01 purchases)

- `POST /api/v1/mock/authorization` is **NOT idempotent**: replaying the same `Reference` header charged the card a second time. Never re-send it after a timeout.
- The `Reference` header does not come back: the card's `Authorization` transaction has `transactionReference: null`.
- The body's `mid` comes back verbatim as `merchantMid` (tried `900000123456789`), and `authCode` is the first 12 hex digits of `authorizationId` without dashes. `src/lib/interactors/CardholderInteractor.ts` sends a per-spend `mid` (`midFor`) so a payment whose answer was lost can be found exactly. Rows also carry `transactionTime` (UTC, no zone suffix) and `balanceAfterTransaction`.

## Request signing (quick reference)

`Signature` = base64 of the **hex** SHA-1 string over `METHOD&urlencode(fullUrl)&reference&clientId&clientSecret`. The signed URL includes the query string. Confirmed against the sandbox on 2026-10-19. Code: `src/lib/clients/cardIssuing/miden/signature.ts`.
