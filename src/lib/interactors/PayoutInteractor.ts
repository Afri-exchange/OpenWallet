import type { Database } from "../../db/client.js";
import { AdvisoryLock, withTryAdvisoryLock } from "../../db/locks.js";
import type { PayoutRepository } from "../../domain/repositories/PayoutRepository.js";
import type { Ledger } from "../services/Ledger.js";
import type { SignedTransfer, TransferState } from "../../adapters/payouts/UsdcPayoutRail.js";
import { PAYOUT_CHAIN, type CheckoutInteractor } from "./CheckoutInteractor.js";

/** What PayoutInteractor needs from a rail; UsdcPayoutRail implements it. */
export interface PayoutRail {
  sign(args: { to: string; amountCents: number }): Promise<SignedTransfer>;
  broadcast(rawTx: string): Promise<void>;
  state(t: { txHash: string; nonce: number }): Promise<TransferState>;
  /** Whether the payout account holds enough USDC for `amountCents` and enough gas to send. False if unsure. */
  funded(amountCents: number): Promise<boolean>;
}

export interface PayoutContext {
  /** Only for the cross-process sender lock. */
  db: Database;
  payouts: PayoutRepository;
  ledger: Pick<Ledger, "findByKey">;
  checkout: Pick<CheckoutInteractor, "settlePayout">;
  rail: PayoutRail;
  log?: (msg: string) => void;
}

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
export class PayoutInteractor {
  private running: Promise<void> | undefined;
  private readonly log: (msg: string) => void;

  constructor(private readonly d: PayoutContext) {
    this.log = d.log ?? (() => undefined);
  }

  tick(): Promise<void> {
    this.running ??= this.locked().finally(() => (this.running = undefined));
    return this.running;
  }

  /** One sender across processes: the advisory lock is held on one connection for the whole tick. */
  private async locked(): Promise<void> {
    await withTryAdvisoryLock(this.d.db, AdvisoryLock.payoutSender, async () => {
      if (await this.settleInFlight()) await this.sendNext();
    });
  }

  /** Settles the transfer in flight, if any. True when nothing is in flight any more. */
  private async settleInFlight(): Promise<boolean> {
    const p = await this.d.payouts.findSending();
    if (!p) return true;
    const t = { txHash: p.railReference!, nonce: p.nonce! };
    const s = await this.d.rail.state(t);
    if (s.state === "confirmed") {
      await this.d.checkout.settlePayout(p.payoutId, { sent: true, railReference: t.txHash }, { fromRail: true });
      this.log(`payout ${p.payoutId}: sent, ${t.txHash}`);
      return true;
    }
    if (s.state === "reverted") {
      await this.d.checkout.settlePayout(p.payoutId, { sent: false, failure: "the USDC transfer reverted on chain; the amount is back in your balance" }, { fromRail: true });
      this.log(`payout ${p.payoutId}: transfer ${t.txHash} reverted; released`);
      return true;
    }
    if (s.state === "replaced") {
      const note = `needs review: nonce ${t.nonce} was used by another transaction, so ${t.txHash} can never be mined. The money is still reserved. Check the payout account's history, then settle this payout by hand.`;
      if (await this.d.payouts.flagForReview(p.payoutId, note)) this.log(`payout ${p.payoutId}: ${note}`);
      return false;
    }
    await this.d.rail.broadcast(p.rawTx!).catch((e) => this.log(`payout ${p.payoutId}: rebroadcast: ${errText(e)}`));
    return false;
  }

  private async sendNext(): Promise<void> {
    const queue = await this.d.payouts.requestedQueue(PAYOUT_CHAIN, 20);
    for (const p of queue) {
      // A requested row can lack a reservation (both the reserve and its check failed, or it is being reserved
      // right now). It must never be sent; leave it for ops or the next tick.
      if (!(await this.d.ledger.findByKey(`payout-reserve:${p.payoutId}`))) continue;
      // Already closed in the ledger (released or completed by ops): never send it.
      if ((await this.d.ledger.findByKey(`payout-release:${p.payoutId}`)) || (await this.d.ledger.findByKey(`payout-complete:${p.payoutId}`))) continue;
      if (!p.destination) continue;
      let signed: SignedTransfer;
      try {
        signed = await this.d.rail.sign({ to: p.destination, amountCents: p.amountCents });
      } catch (e) {
        // Nothing was signed. If our account is short of USDC or gas, every payout would fail: stop the queue, it
        // stays requested. If we are funded, the cause is this payout (say, a blacklisted destination): skip it so
        // it cannot block other merchants, and after a few tries fail it and release the money (safe: never signed).
        const funded = await this.d.rail.funded(p.amountCents).catch(() => false);
        const failures = await this.d.payouts.recordSignFailure(p.payoutId, errText(e).slice(0, 300), funded);
        this.log(`payout ${p.payoutId}: not sent yet: ${errText(e)}`);
        if (!funded) return;
        if ((failures ?? 0) >= MAX_SIGN_FAILURES) {
          await this.d.checkout
            .settlePayout(p.payoutId, { sent: false, failure: "the transfer to your payout address could not be made; the amount is back in your balance" })
            .catch((err) => this.log(`payout ${p.payoutId}: fail after ${MAX_SIGN_FAILURES} tries: ${errText(err)}`));
        }
        continue;
      }
      // Stored BEFORE broadcast: a crash after it leaves bytes to rebroadcast, never a second transfer.
      if (!(await this.d.payouts.markSending(p.payoutId, signed))) continue; // settled by someone else meanwhile; the signed bytes are dropped unsent
      this.log(`payout ${p.payoutId}: ${p.amountCents}c to ${p.destination}, ${signed.txHash}`);
      await this.d.rail.broadcast(signed.rawTx).catch((e) => this.log(`payout ${p.payoutId}: broadcast: ${errText(e)} (retried next tick)`));
      return;
    }
  }
}
