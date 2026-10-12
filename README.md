# agent-cards

Virtual cards for AI agents, funded with stablecoins, built on the [Miden Workspace API](https://docs.miden.co/getting-started).

> Note: the Miden docs describe a card-issuance / wallet-as-a-service REST API (midencards.io), not the Miden blockchain.

## Layout
- `src/miden/`: signed API client (client-credentials token + `Reference`/`Signature`/`UniqueKey`/`MidenAuthorization` headers)
- `src/funding/`: `FundingSource` interface; `MidenWalletFunding` is a stub
- `src/cards/`: `CardService` (issue, top up) and `SpendPolicy` limits enforced locally

## Status
Scaffold only. Open items:
1. Confirm signature encoding in sandbox (docs prose and samples disagree), see `src/miden/signature.ts`.
2. Fill card-issuance and WaaS endpoint paths from the Miden API explorer.
3. Decide stablecoin rail (USDC/USDT, chain) and the funding flow.

## Dev
```
cp .env.example .env
pnpm install
pnpm test
pnpm typecheck
```
