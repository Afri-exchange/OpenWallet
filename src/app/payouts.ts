import type pg from "pg";
import type { Ledger } from "../ledger/ledger.js";
import type { SignedTransfer, TransferState } from "../chain/usdc-payout.js";
import { PAYOUT_CHAIN, type CheckoutService } from "./checkout.js";

/** What PayoutSender needs from a rail; UsdcPayoutRail implements it. */
export interface PayoutRail {
  sign(args: { to: string; amountCents: number }): Promise<SignedTransfer>;
  broadcast(rawTx: string): Promise<void>;
  state(t: { txHash: string; nonce: number }): Promise<TransferState>;
  /** Whether the payout account holds enough USDC for `amountCents` and enough gas to send. False if unsure. */
  funded(amountCents: number): Promise<boolean>;
}

export interface PayoutSenderDeps {
  pool: pg.Pool;
  ledger: Pick<Ledger, "findByKey">;
  checkout: Pick<CheckoutService, "settlePayout">;
  rail: PayoutRail;
  log?: (msg: string) => void;
}

/** Any number; only needs to differ from the other advisory locks (the migrator uses 727401). */
const SENDER_LOCK = 727402;
const errText = (e: unknown) => (e instanceof Error ? e.message : String(e));
/** Failed signing attempts, with the payout account funded, before a payout is failed and released. */
export const MAX_SIGN_FAILURES = 3;

/**
 * Moves requested payouts onto the chain, one transfer in flight at a time (so nonces stay in order), and
 * settles them from the chain's answer:
 *
 *   requested --signed, stored, then broadcast--> sending --confirmed--> sent
 *                                                    | reverted on chain: failed, money back to the balance
 *                                                    | no answer: rebroadcast the same bytes; never failed on absence
 *                                                    | nonce taken by another tx: needs review, queue stops
 *
 * Only payouts with a ledger reservation (payout-reserve:<id>) are ever signed.
 */
export class PayoutSender {
  private running: Promise<void> | undefined;
  private readonly log: (msg: string) => void;

  constructor(private readonly d: PayoutSenderDeps) {
    this.log = d.log ?? (() => undefined);
  }

  tick(): Promise<void> {
    this.running ??= this.locked().finally(() => (this.running = undefined));
    return this.running;
  }

  /** One sender across processes: the advisory lock is held on one connection for the whole tick. */
  private async locked(): Promise<void> {
    const c = await this.d.pool.connect();
    try {
      if (!(await c.query("SELECT pg_try_advisory_lock($1) AS ok", [SENDER_LOCK])).rows[0].ok) return;
      try {
        if (await this.settleInFlight()) await this.sendNext();
      } finally {
        await c.query("SELECT pg_advisory_unlock($1)", [SENDER_LOCK]);
      }
    } finally {
      c.release();
    }
  }

  /** Settles the transfer in flight, if any. True when nothing is in flight any more. */
  private async settleInFlight(): Promise<boolean> {
    const p = (await this.d.pool.query("SELECT * FROM app_payout WHERE status = 'sending'")).rows[0];
    if (!p) return true;
    const t = { txHash: p.rail_reference as string, nonce: Number(p.nonce) };
    const s = await this.d.rail.state(t);
    if (s.state === "confirmed") {
      await this.d.checkout.settlePayout(p.payout_id, { sent: true, railReference: t.txHash }, { fromRail: true });
      this.log(`payout ${p.payout_id}: sent, ${t.txHash}`);
      return true;
    }
    if (s.state === "reverted") {
      await this.d.checkout.settlePayout(p.payout_id, { sent: false, failure: "the USDC transfer reverted on chain; the amount is back in your balance" }, { fromRail: true });
      this.log(`payout ${p.payout_id}: transfer ${t.txHash} reverted; released`);
      return true;
    }
    if (s.state === "replaced") {
      const note = `needs review: nonce ${t.nonce} was used by another transaction, so ${t.txHash} can never be mined. The money is still reserved. Check the payout account's history, then settle this payout by hand.`;
      const r = await this.d.pool.query("UPDATE app_payout SET needs_review = $2, updated_at = now() WHERE payout_id = $1 AND needs_review IS NULL", [p.payout_id, note]);
      if (r.rowCount) this.log(`payout ${p.payout_id}: ${note}`);
      return false;
    }
    await this.d.rail.broadcast(p.raw_tx).catch((e) => this.log(`payout ${p.payout_id}: rebroadcast: ${errText(e)}`));
    return false;
  }

  private async sendNext(): Promise<void> {
    const queue = (await this.d.pool.query("SELECT * FROM app_payout WHERE status = 'requested' AND chain = $1 ORDER BY created_at LIMIT 20", [PAYOUT_CHAIN])).rows;
    for (const p of queue) {
      // A requested row can lack a reservation (both the reserve and its check failed, or it is being reserved
      // right now). It must never be sent; leave it for ops or the next tick.
      if (!(await this.d.ledger.findByKey(`payout-reserve:${p.payout_id}`))) continue;
      // Already closed in the ledger (released or completed by ops): never send it.
      if ((await this.d.ledger.findByKey(`payout-release:${p.payout_id}`)) || (await this.d.ledger.findByKey(`payout-complete:${p.payout_id}`))) continue;
      if (!p.destination) continue;
      let signed: SignedTransfer;
      try {
        signed = await this.d.rail.sign({ to: p.destination, amountCents: Number(p.amount_cents) });
      } catch (e) {
        // Nothing was signed. If our account is short of USDC or gas, every payout would fail: stop the queue, it
        // stays requested. If we are funded, the cause is this payout (say, a blacklisted destination): skip it so
        // it cannot block other merchants, and after a few tries fail it and release the money (safe: never signed).
        const funded = await this.d.rail.funded(Number(p.amount_cents)).catch(() => false);
        const r = await this.d.pool.query(
          "UPDATE app_payout SET last_error = $2, sign_failures = sign_failures + $3, updated_at = now() WHERE payout_id = $1 AND status = 'requested' RETURNING sign_failures",
          [p.payout_id, errText(e).slice(0, 300), funded ? 1 : 0],
        );
        this.log(`payout ${p.payout_id}: not sent yet: ${errText(e)}`);
        if (!funded) return;
        if (Number(r.rows[0]?.sign_failures ?? 0) >= MAX_SIGN_FAILURES) {
          await this.d.checkout
            .settlePayout(p.payout_id, { sent: false, failure: "the transfer to your payout address could not be made; the amount is back in your balance" })
            .catch((err) => this.log(`payout ${p.payout_id}: fail after ${MAX_SIGN_FAILURES} tries: ${errText(err)}`));
        }
        continue;
      }
      // Stored BEFORE broadcast: a crash after it leaves bytes to rebroadcast, never a second transfer.
      const r = await this.d.pool.query(
        "UPDATE app_payout SET status = 'sending', rail_reference = $2, raw_tx = $3, nonce = $4, last_error = NULL, updated_at = now() WHERE payout_id = $1 AND status = 'requested'",
        [p.payout_id, signed.txHash, signed.rawTx, signed.nonce],
      );
      if (!r.rowCount) continue; // settled by someone else meanwhile; the signed bytes are dropped unsent
      this.log(`payout ${p.payout_id}: ${p.amount_cents}c to ${p.destination}, ${signed.txHash}`);
      await this.d.rail.broadcast(signed.rawTx).catch((e) => this.log(`payout ${p.payout_id}: broadcast: ${errText(e)} (retried next tick)`));
      return;
    }
  }
}
