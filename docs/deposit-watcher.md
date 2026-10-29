# Base USDC deposit watcher

An alternative rail that needs no polling (Circle wallets plus webhooks) is in [circle-deposits.md](circle-deposits.md).

Code: `src/chain/base-usdc-watcher.ts` (watcher), `src/chain/pg.ts` (Postgres cursor and address book), `src/ledger/units.ts` (unit conversion), migration `src/ledger/migrations/002_chain.sql`. Wired up in `src/app/main.ts`. Status as of 2026-10-19: the watcher is unit-tested and was checked read-only against Base mainnet (three public RPCs; credited cents matched an independent sum of that block's transfers). The Postgres classes typecheck and have tests (`test/chain-pg.test.ts`, run only when `DATABASE_URL` is set); README item 4 records that they had not yet been run against Postgres. The sandbox service is configured to use them on **Base Sepolia**; I have not confirmed a real Sepolia deposit end to end.

## Second network: Ethereum Sepolia

faucet.circle.com opens on Ethereum Sepolia, so a faucet top-up sent without changing the network picker never reached the Base Sepolia watcher (found 2026-10-19: 20 USDC at card `032f0452`'s address, tx `0xb0c38d00…823b`). `main.ts` now runs a second watcher on Ethereum Sepolia (`ETHEREUM_SEPOLIA_USDC`, RPC `ETHEREUM_SEPOLIA_RPC_URL`, default publicnode, cursor `ethereum-sepolia:usdc`, ledger chain label `ethereum-sepolia`). The same HD address is valid on every EVM chain, so both watchers read the one address book. USDC sent on any other network is still not seen.

## What it does

It credits USDC that arrives at a deposit address we issued. One address funds exactly one card. A confirmed transfer becomes a ledger credit of whole cents, 1:1 USD, on `holding:<cardId>`. A separate step ([below](#after-the-credit-holding-to-card)) moves that onto the Miden card.

It is a poller over `eth_getLogs`, not a subscription: no provider webhooks, no websockets.

## Configuration

| Setting | Sandbox value (main.ts) | Library default | Notes |
| --- | --- | --- | --- |
| Chain label | `base-sepolia` | `base` | Part of the ledger idempotency key. Never reuse a label across networks. |
| Token | `BASE_SEPOLIA_USDC` `0x036cbd53…f7e` (Circle test USDC, chain 84532) | `BASE_USDC` `0x833589fc…2913` (native USDC, Base mainnet) | Both 6 decimals. Faucet: faucet.circle.com. |
| RPC | `BASE_RPC_URL`, default `https://base-sepolia-rpc.publicnode.com` | none | The URL often embeds a provider key: `jsonRpc` never logs it; keep it that way. |
| `confirmations` | 5 | 10 | Blocks behind head before a transfer counts (about 2 s blocks on Base). |
| `maxRange` | 500 | 2000 | Blocks per `eth_getLogs` call (providers cap this). |
| `maxAddresses` | 500 (default) | 500 | Addresses per topic filter; more are split into extra calls. |
| Poll interval | 4 s (when caught up) | 4 s | `run({ intervalMs })`. |
| Cursor name | `base-sepolia:usdc` | n/a | Row in `chain_cursor`. |

For real money, use `BASE_USDC`, the chain label `base`, `confirmations` ≥ 10, and a paid RPC (see OPEN items).

## How a tick works

`tick()` is one pass of at most `maxRange` blocks:

1. `head = eth_blockNumber`; `safe = head - confirmations`.
2. `from = cursor + 1` (or `startBlock` if the cursor is empty; with neither it **throws**: we never guess and never scan from block 0).
3. If `from > safe`, nothing is confirmed yet: return.
4. `to = min(safe, from + maxRange - 1)`. Fetch `Transfer(address,address,uint256)` logs on the token contract where the **recipient topic** is any of our addresses (`topics: [TRANSFER_TOPIC, null, [recipients…]]`).
5. Credit each log (below), **then** advance the cursor to `to`.

`run(signal)` loops `tick`, sleeping only when caught up, so a backlog drains at full speed. Errors go to `onError` and the loop retries; `main.ts` logs a given error message once, not every 4 s.

**First boot** (`main.ts`): if no cursor exists, it is set to `head - 20`. No address existed before the service started, so there is nothing older to find. This is a sandbox shortcut; a production start must choose the start block deliberately.

### Per-log checks (`credit`)

The provider's filter is not trusted. Each log is re-checked, and a log is **skipped** if it is `removed` (reorged), from the wrong contract, does not have exactly three topics with the Transfer signature, or goes to an address that is not ours. It **throws** (the tick fails and the cursor does not move) if the block number is outside the requested range, or if `data` is not a 32-byte word. A zero-value transfer is skipped.

### Units and dust

`baseUnitsToCents(base, 6)` (bigint all the way; no JS `number` touches the amount until it is whole cents):

- 1 USDC = 1,000,000 base units = 100 cents; one cent = 10,000 base units.
- Floors to whole cents. The remainder is **dust**: never credited, never rounded up. It is reported through `onDust` (the sandbox logs `dust <n> base units on <tx>:<logIndex> (not credited)`), and a replayed range reports it again, so key any dust record by `txHash + logIndex`.
- A transfer under one cent credits nothing.

### Idempotency and recovery

The ledger key for a deposit is `deposit:<chain>:<txHash lower-cased>:<logIndex>`. So:

- A crash mid-range leaves the cursor behind; the next tick re-reads the range and every already-credited log is a no-op. Nothing is credited twice, nothing is skipped.
- Two watchers on one cursor cannot rewind each other: `PgCursor.set` only moves **forward** (`GREATEST` in SQL).
- A *different* deposit with the same key content is impossible (one transfer = one chain + hash + log index); the same key with different content is rejected as an error.

`rescan(from, to)` re-reads a closed block range and credits anything missed without touching the cursor. It refuses a range that includes unconfirmed blocks. Use it when an address was issued late or an RPC dropped logs.

**Reorgs:** we only look at blocks `confirmations` deep, and skip `removed` logs. A reorg deeper than `confirmations` after we have credited is not handled; the ledger is append-only, so the fix would be a compensating reversal made by a person. **OPEN:** no alerting exists for this.

## Deposit addresses (`PgDepositAddresses`)

Table `deposit_address(chain, address, card_id, derivation_index)`, primary key `(chain, address)`.

- `add(address, cardId)` stores lower-case `0x` + 40 hex; adding the same pair twice is a no-op; **moving an address to a different card throws**. An empty `cardId` is refused: an address with no card behind it is useless.
- `all()` is read at the start of every scan, so an address added while the watcher runs is seen from the next tick, for blocks **after the cursor**. Add the address *before* showing it to the user.
- The service creates a user's address right after the card is issued (`ensureDepositAddress`), allocating `derivation_index` from the sequence `deposit_derivation_seq` and deriving the address from our own wallet (see [sandbox-wallets.md](sandbox-wallets.md)).

## After the credit: holding to card

The watcher only credits `holding:<cardId>`. Moving it onto the Miden card is `AppService.fundPending()`, run every 5 s (and immediately after a simulated deposit):

1. Unfinished `app_funding` rows (`reserved`) are settled first (crash recovery).
2. For each card with `holding >= $1.00` (`MIN_FUNDING_CENTS`), the amount is `min(holding, tier lifetime cap − already reserved/completed funding)`. Under $1 it waits for more deposits; over the cap it stays in holding.
3. Write an `app_funding` row (`reserved`), then `ledger.reserveFunding` (holding → `pending:<card>`), **before** any money moves.
4. `MidenWalletFunding.fund` calls `PATCH /api/v1/cards/topup` with `Reference` and `clientReference` both set to the funding id.
5. Outcomes:
   - Miden confirms → `completeFunding` (pending → `card:<card>`), row `completed`.
   - Miden says the `Reference` was "already seen" → the first attempt landed: treated as success.
   - A 4xx other than 429 → terminal: `releaseFunding` (pending → holding), row `released` with Miden's message.
   - Timeout, 5xx or 429 → indeterminate: the row stays `reserved` and the next run retries with the **same** `Reference`, so it lands at most once.

Note what this does and does not mean: the *stablecoin* is credited in our ledger, but the Miden top-up is paid from **our Miden USD wallet**, not from the USDC that arrived. The sandbox wallet is pre-funded. **OPEN (README item 5, and the item that matters most before real money):** how the USDC we receive turns into dollars in that Miden wallet (bank wire vs Miden's stablecoin collection) is undecided. The sweep of deposit addresses to treasury is not built either.

## Operating it

- Watch the log for `chain watcher: <error>` (deduplicated) and `dust …`.
- Lag: compare `chain_cursor.block` to the chain head; healthy lag is about `confirmations` blocks plus one poll interval.
- To test without chain access: `POST /api/me/simulate-deposit` credits through the same `ledger.confirmDeposit` with chain label `sandbox-sim`; the overview marks those `simulated: true`. For a real one, send Circle test USDC on Base Sepolia to the address on the dashboard and expect the credit roughly 10 to 20 s later (5 confirmations at about 2 s per block, plus the poll interval; an estimate, not measured).

## OPEN items (as of today)

1. **Paid RPC.** The public `mainnet.base.org` returns 429 on `eth_getLogs`; the sandbox uses `base-sepolia-rpc.publicnode.com`. A provider webhook may be added later as a *second signal only*, never as the source of truth.
2. **Funding the Miden USD wallet** from received stablecoin (above).
3. **Key custody and sweeping.** Addresses come from a mnemonic in a local file; there is no sweep and no production custody (HSM/KMS or a provider). See [sandbox-wallets.md](sandbox-wallets.md).
4. **Production start block** and a deliberate choice of confirmations.
5. **No USDT**, and only one chain (Base). The ledger accepts `USDC` and `USDT` as asset names, but only a USDC watcher exists.
6. Run `DATABASE_URL=… pnpm test` (it includes `test/chain-pg.test.ts`) before relying on the Postgres classes anywhere new.
