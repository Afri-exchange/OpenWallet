/** One card's details as sealed by the vault (AES-256-GCM); the repository never sees plaintext or the key. */
export interface SealedBox {
  keyId: string;
  iv: Buffer;
  ciphertext: Buffer;
  tag: Buffer;
}

export type VaultAuditAction = "put" | "overwrite" | "reveal" | "reveal_miss" | "discard";

/** Storage for the card vault (tables card_vault, card_vault_audit). Every write that matters is audited. */
export interface CardVaultRepository {
  /** Stores (or replaces) a card's sealed details and writes its put/overwrite audit row, atomically. */
  store(cardId: string, box: SealedBox, meta: { last4: string; source: "issue" | "full-pan" }): Promise<void>;
  find(cardId: string): Promise<SealedBox | undefined>;
  exists(cardId: string): Promise<boolean>;
  /** Deletes a card's sealed details. True if there were any. */
  remove(cardId: string): Promise<boolean>;
  audit(cardId: string, action: VaultAuditAction, purpose: string): Promise<void>;
}
