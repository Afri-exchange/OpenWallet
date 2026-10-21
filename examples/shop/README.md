# Bean & Brew: sample shop for `@agent-cards/checkout`

A small coffee shop that shows how a merchant takes payment from an AI agent: products, a cart, and checkout through the SDK. Sandbox only, like the SDK.

## Run it

From the repo root, with the agent-cards sandbox server running (default `http://127.0.0.1:8787`):

No keys yet? Run `node --import tsx scripts/dev-quickstart.ts` from the repo root; it writes `.env.sandbox-keys` with a merchant key and a funded demo agent token (see [getting started](../../docs/getting-started.md)).

```sh
cd examples/shop
node --env-file=../../.env.sandbox-keys --import tsx server.ts    # http://127.0.0.1:4100
```

(Without the keys file the shop signs up a merchant itself and the order page has no **Pay as demo agent** button.)

| Env var | Default | |
| --- | --- | --- |
| `AGENT_CARDS_URL` | `http://127.0.0.1:8787` | the agent-cards server |
| `PORT` | `4100` | the shop |
| `AGENT_CARDS_SECRET_KEY` | none | your `mk_…` key; if unset, the shop signs up once and saves the key to `.merchant-key` (gitignored) |
| `AGENT_CARDS_AGENT_TOKEN` | none | an `ak_…` token; if set, the order page shows **Pay as demo agent**, standing in for the shopper's agent |

## The flow, and where the SDK is used

1. **Cart** (browser, `localStorage`): only product ids and quantities. The browser never sends a price.
2. **`POST /api/checkout`**: the server prices the cart from `catalog.ts`, then calls `createCheckout({ amountCents, description, reference, idempotencyKey, expiresInSeconds, metadata })`. The order id is the idempotency key, so a retried request cannot make two checkouts.
3. **Order page** (`/order/:id`): server-rendered with `checkoutMetaTag()` in the head and `checkoutButton()` in the body, plus the `checkoutUrl` to hand to an agent.
4. **Status**: the page polls `/api/orders/:id`, which calls `retrieveCheckout()` every time. The order counts as fulfilled only when `status === "paid"` and `underReview` is empty, and only once.
5. **Cancel** calls `cancelCheckout()`; a 409 (already paid) is reported as paid, not as an error.

The demo agent button uses `AgentCardsAgent.payCheckout(id, { maxAmountCents })`, so a checkout whose price changed is refused without charging.

Orders are held in memory, so a restart forgets them. A real shop would store them.

## Test

```sh
node --import tsx --test shop.test.ts
```

Runs the shop through the real SDK against an in-memory stand-in for the agent-cards API.
