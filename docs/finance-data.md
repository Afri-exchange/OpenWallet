# Finance data storage

Everything that is money or evidence of money lives in Postgres. Code: `src/lib/services/Ledger.ts`, `src/db/repositories/PgLedgerStore.ts`, `src/db/repositories/PgChainRepositories.ts`, `src/lib/interactors/CardholderInteractor.ts`. Migrations: `src/db/migrations/001_ledger.sql`, `002_chain.sql`, `003_app.sql`, applied in order at boot by `PgLedgerStore.migrate()` (recorded in `ledger_migrations`; guarded by a Postgres advisory lock, so only one process migrates at a time). Tests use an in-memory store (`MemoryLedgerStore`) with the same rules.

## Principles

1. **Amounts are integer USD cents** (`BIGINT`). No floats, no decimals. Dollars appear only at the Miden boundary (Miden takes and returns dollars with decimals; we convert with `cents / 100`), and stablecoin base units are converted with bigint arithmetic (`src/lib/utils/units.ts`), flooring to cents.
2. **Double entry.** Every transaction has at least two postings summing to exactly zero.
3. **Append-only.** Rows are never updated or deleted; corrections are new, compensating transactions.
4. **Balances are derived and checked**, never edited.
5. **Idempotency keys everywhere money moves**, so a retry cannot double-count.
6. **We do not store identity or card data.** KYC documents go straight to Miden; we keep a reference and a status. Card numbers and CVV are never read. Tokens are stored only as SHA-256 hashes.

## The ledger (`001_ledger.sql`)

### Tables

| Table | Purpose |
| --- | --- |
| `ledger_tx` | One row per transaction: `seq` (serial), `idempotency_key` (unique, non-empty), `kind`, optional `reference` (e.g. tx hash, funding id), `reverses_seq` (unique, so at most one reversal per original), `created_at`. |
| `ledger_posting` | One row per leg: `tx_seq`, `account`, `amount_cents` (signed, non-zero). Account names must match `^[a-z][a-z_]*:\S+$`. |
| `ledger_balance` | Running balance per account, updated in the same DB transaction as the postings. |

### Guarantees enforced by the database, not just by code

- **Immutability:** triggers on `ledger_tx` and `ledger_posting` raise `ledger is append-only` on UPDATE, DELETE and TRUNCATE.
- **No overdraft:** `CHECK (balance_cents >= 0 OR account ~ '^(external|fees):')`. Only `external:*` (money outside the system) and `fees:*` may be negative.
- **Serialised writers:** each transaction locks the balance rows of every account it touches (`SELECT … FOR UPDATE`, ordered by account to avoid deadlocks) before checking balances, so two concurrent spends on one account queue and the second sees the first's committed balance.
- **Integrity probe:** `ledger_check_balances()` returns any account whose stored balance differs from the sum of its postings, plus a row with an empty account name if the grand total is non-zero. `PgLedgerStore.checkIntegrity()` wraps it. An empty result means healthy. Run it on a schedule (**OPEN:** nothing schedules it yet).

### Accounts

| Account | Meaning | Can go negative? |
| --- | --- | --- |
| `external:USDC`, `external:USDT` | The outside world as a source of stablecoin | yes |
| `external:merchant` | Where card spends go | yes |
| `holding:<cardId>` | Deposited and credited, not yet on the card | no |
| `pending:<cardId>` | Reserved for an in-flight Miden top-up | no |
| `card:<cardId>` | Owner's unallocated money on the card | no |
| `agent:<cardId>:<agentId>` | An agent's sub-balance | no |
| `fees:fees` | Fees taken during funding | yes |

### Money flow and the transaction kinds

```
external:USDC ──deposit──► holding ──funding_reserve──► pending ──funding──► card ──agent_allocate──► agent ──spend──► external:merchant
                              ▲                            │                  ▲                         │
                              └────funding_release─────────┘                  └──────agent_return───────┘
                                                                              (reversal undoes spend/allocate legs)
```

| Kind | Idempotency key | Written by |
| --- | --- | --- |
| `deposit` | `deposit:<chain>:<txhash>:<logIndex>` | `confirmDeposit` (watcher, or simulated deposit with chain `sandbox-sim`) |
| `funding_reserve` | `funding-reserve:<fundingId>` | `reserveFunding`, **before** any Miden call |
| `funding` | `funding-complete:<fundingId>` | `completeFunding` (optional fee to `fees:fees`) |
| `funding_release` | `funding-release:<fundingId>` | `releaseFunding` |
| `agent_allocate` | `agent-allocate:<allocationId>` | `allocateToAgent` |
| `agent_return` | `agent-return:<returnId>` | `returnFromAgent` |
| `spend` | `spend:<spendId>` | `recordAgentSpend` (agent) or `recordSpend` (card) |
| `reversal` | `reversal:<seq>` | `reverse` |

Rules the code enforces:

- Replaying a key with **identical** content returns the original transaction; with **different** content it is an error.
- `completeFunding` and `releaseFunding` need an open matching reservation and are mutually exclusive.
- Funding transactions and reversals cannot themselves be reversed.
- A reversal fails (insufficient funds) if the money has already moved on.
- The raw `post()` is restricted to `external:<asset|merchant>` and `fees:*` accounts and cannot write the reserved kinds, so application code cannot hand-craft a balance on a card or holding account.
- Account ids for agents are restricted to letters, digits, `_`, `.`, `-` so `agent:<card>:<agent>` cannot be confused with another pair.

## Chain tables (`002_chain.sql`)

| Table | Purpose |
| --- | --- |
| `deposit_address(chain, address, card_id, created_at, derivation_index)` | Our issued deposit addresses. PK `(chain, address)`, lower-case `0x`+40 hex enforced by CHECK; `derivation_index` is unique (added in `003`) and re-derives the key. |
| `chain_cursor(name, block, updated_at)` | Last fully credited block per watcher, e.g. `base-sepolia:usdc`. Forward-only. |

Details in [deposit-watcher.md](deposit-watcher.md).

## App tables (`003_app.sql`)

| Table | Holds | Notes |
| --- | --- | --- |
| `app_user` | `id`, `email` (unique), `token_hash` (unique), `tier` (`quick`/`full`), `kyc_reference` (unique), `kyc_status`, `created_at` | **No name, DOB, ID number, address or image.** |
| `app_card` | `card_id`, `user_id` (unique: one card per user), `customer_id` (Miden), `last_four` (unused so far), `per_txn_cents`, `daily_cents` | Card limits at the user's tier. No PAN, no CVV, no `kycToken`. |
| `app_agent` | PK `(card_id, agent_id)`, `name`, `token_hash` (unique), `per_txn_cents`, `daily_cents`, `allowed_mccs TEXT[]`, `revoked_at` | The agent's policy. Its balance is **not here**; it is the ledger account. |
| `app_spend` | `spend_id`, `card_id`, `agent_id`, `idempotency_key`, `amount_cents` (>0), `merchant`, `mcc`, `status` (`processing`/`approved`/`declined`/`voided`), `reason`, `ledger_seq`, `miden_auth_id`, `created_at` | `UNIQUE (card_id, agent_id, idempotency_key)`; FK to `app_agent`. Every attempt is recorded, including declines. |
| `app_funding` | `funding_id`, `card_id`, `amount_cents`, `status` (`reserved`/`completed`/`released`), `detail`, timestamps | The funding state machine behind the Miden top-up. `detail` holds the Miden transaction id or the failure message. |

### Two sources of truth, and how they agree

- **Balances come from the ledger.** An agent's spendable money is `ledger_balance` for `agent:<card>:<agent>`; the owner's unallocated money is `card:<card>`.
- **Operational state comes from `app_*`.** `app_spend` and `app_funding` explain *why* a ledger entry exists and carry the status. `app_spend.ledger_seq` and `app_funding.funding_id` (also the ledger `reference`) tie each row to its ledger transaction.
- **Reconciling the two:** a `completed` funding should have both a `funding_reserve` and a `funding` ledger transaction; an `approved` spend has a `spend` transaction and no `reversal`; a `voided` spend has a `reversal` of its `ledger_seq`. **OPEN:** there is no automated job that checks this, or that compares `card:<card>` totals against Miden's real card balance (the overview shows both side by side, `midenCardBalanceDollars`). Build one before relying on the numbers.

### Write ordering (what makes a crash safe)

- **Funding:** insert `app_funding` (`reserved`) → ledger reserve → Miden top-up → ledger complete/release → update row. A crash at any step is finished by the next `fundPending` run, and the shared `Reference` makes a repeated Miden call land at most once.
- **Pay:** insert `app_spend` (`processing`) → policy and sub-balance debit (`ledger_seq` stored) → card charge → `approved`, or reverse the debit and `voided`. At boot, any `processing` row is reversed and voided, with a reason saying to check the card statement.
- **Daily totals** (`spentTodayCents`) are computed from `app_spend` (approved rows, UTC day). The in-memory per-day totals in `AgentWallets` are rebuilt from the last 2 days at boot.

## Secrets and sensitive data

| Item | Stored? | How |
| --- | --- | --- |
| Miden client id/secret/unique key | No (environment only) | Read at boot; never logged. |
| User and agent tokens | Hash only | SHA-256 in `token_hash`; the plaintext is returned once at creation. |
| KYC identity data and ID image | **No** | Forwarded to Miden; never persisted or logged. |
| `kycToken` | No | Used once at issuance. |
| Card PAN/CVV (`secureCardDetails`) | **No** | Never read. |
| Deposit wallet mnemonic | File, mode 0600, git-ignored | See [sandbox-wallets.md](sandbox-wallets.md). Not in Postgres. |
| Email | Yes (`app_user.email`) | Personal data; plan retention if this goes beyond the sandbox. |
| RPC URL | No | May embed a provider key; do not log it. |

Webhook payloads, if ever used, are unauthenticated for amounts (the signature covers only `eventId` and `eventTime`). Re-read amounts from Miden's API before acting; see `docs/miden-api.md`.

## Operations notes

- **Backups:** Postgres must be backed up together with `.sandbox-wallet.json` (see the wallet doc). For the sandbox, losing both is only an inconvenience; for anything else it is not.
- **Never "fix" a balance by editing rows.** The triggers will refuse for ledger tables. Write a compensating transaction through the typed ledger methods and note why.
- **Pool:** `main.ts` uses a pool of 10 connections for the app and the ledger store. Migrations take an advisory lock; do not run two migrators against one database by other means.
- **Large ledgers:** `history(account)` returns all transactions for an account; fine for the sandbox, paginate before this grows.
- **Retention:** nothing is pruned. The ledger is append-only by design.

## OPEN items

1. No scheduled `ledger_check_balances()` run and no ledger-vs-Miden reconciliation job.
2. `app_card.last_four` is never filled.
3. Tier (`app_user.tier`) has no write path; limits and lifetime caps are placeholders.
4. Fee handling exists in `completeFunding` (`feeCents`), but the app passes none; Miden's issuance cost (about $1 per card, inferred in `docs/miden-api.md`) is not booked as a fee anywhere.
5. Single-instance assumptions in the app layer (in-process locks); the ledger itself is safe under concurrency.
6. Money paid from the Miden USD wallet is not tied back to the USDC that funded it (see deposit-watcher.md, OPEN item 2), so there is no end-to-end treasury view yet.
