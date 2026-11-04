-- Privacy mode: a user whose payments each use a fresh one-time (Miden Lite) card instead of their own card.
-- Fixed per user when the user is created (from the developer's default or an explicit choice); never flipped later,
-- because money already on the user's own card could not pay a one-time card.
ALTER TABLE app_user ADD COLUMN privacy_mode BOOLEAN NOT NULL DEFAULT false;

-- The card a payment was actually charged to, when it is not the user's own card.
ALTER TABLE app_spend ADD COLUMN charge_card_id TEXT;
ALTER TABLE app_checkout_swap ADD COLUMN charge_card_id TEXT;

-- One row per one-time card, written BEFORE the issue call so a crash mid-issue is visible.
-- 'issuing': request may be in flight or lost (the card may exist); 'ready': issued; 'failed': Miden refused it
-- (nothing exists); 'needs_review': we cannot tell whether a card exists, a person must look.
CREATE TABLE app_one_time_card (
  one_time_id  TEXT PRIMARY KEY,
  user_id      TEXT NOT NULL REFERENCES app_user(id),
  spend_id     TEXT NOT NULL UNIQUE,
  card_id      TEXT UNIQUE,
  amount_cents BIGINT NOT NULL CHECK (amount_cents > 0),
  status       TEXT NOT NULL CHECK (status IN ('issuing', 'ready', 'failed', 'needs_review')),
  detail       TEXT,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- The vault forgets a one-time card's details as soon as its checkout has been filled.
ALTER TABLE card_vault_audit DROP CONSTRAINT card_vault_audit_action_check;
ALTER TABLE card_vault_audit ADD CONSTRAINT card_vault_audit_action_check CHECK (action IN ('put', 'overwrite', 'reveal', 'reveal_miss', 'discard'));
