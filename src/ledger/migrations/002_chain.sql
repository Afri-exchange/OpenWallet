-- Chain watching: deposit addresses we issued (each funds exactly one card) and per-watcher cursors.

CREATE TABLE deposit_address (
  chain      TEXT NOT NULL CHECK (chain <> ''),
  -- Lower-case 0x-prefixed hex, 20 bytes.
  address    TEXT NOT NULL CHECK (address ~ '^0x[0-9a-f]{40}$'),
  card_id    TEXT NOT NULL CHECK (card_id <> ''),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (chain, address)
);
CREATE INDEX deposit_address_card ON deposit_address (card_id);

-- Last block fully credited, per watcher (e.g. 'base:usdc').
CREATE TABLE chain_cursor (
  name       TEXT PRIMARY KEY CHECK (name <> ''),
  block      BIGINT NOT NULL CHECK (block >= 0),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
