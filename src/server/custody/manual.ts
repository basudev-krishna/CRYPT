/**
 * MANUAL custody: the administrator signs payouts themselves.
 *
 * The app never holds the group wallet's keys. For each payout attempt the
 * worker creates (key wd:<id>:<n>), the administrator sends the net amount from
 * the group wallet with their own wallet software and records the transaction
 * hash, or cancels the attempt. Until then the attempt stays `submitted`.
 *
 * A recorded hash is not trusted: the withdrawal monitor settles only after the
 * chain shows that exact token transfer, from the group wallet to the requested
 * destination for the net amount, at the required depth. Each hash can be
 * recorded once (unique), so one transfer can never settle two withdrawals.
 */
import { maybeOne, type Db } from '../db-core';
import { CustodyUnavailableError, type CustodyProvider, type DepositAddressResult, type TransferRequest, type TransferResult } from './types';

export class ManualCustodyProvider implements CustodyProvider {
  readonly name = 'manual';
  readonly isSimulated = false;

  constructor(private readonly db: Db) {}

  supportsNetwork(): boolean {
    return true;
  }

  async createDepositAddress(): Promise<DepositAddressResult> {
    // Group-wallet mode needs no per-member addresses.
    throw new CustodyUnavailableError('Manual custody does not issue deposit addresses; configure a group wallet');
  }

  private async lookup(key: string): Promise<TransferResult> {
    const row = await maybeOne<{ tx_hash: string | null; cancelled: boolean }>(
      this.db,
      'select tx_hash, cancelled from public.manual_payouts where custody_request_id = $1',
      [key],
    );
    if (!row) return { custodyTxId: key, status: 'submitted', txHash: null, feeNative: null };
    if (row.cancelled) return { custodyTxId: key, status: 'failed', txHash: null, feeNative: null, error: 'cancelled by administrator' };
    return { custodyTxId: key, status: 'broadcast', txHash: row.tx_hash, feeNative: null };
  }

  /** Nothing is sent from here: report what the administrator has recorded for this key. */
  async submitTransfer(req: TransferRequest): Promise<TransferResult> {
    return this.lookup(req.idempotencyKey);
  }

  async getTransfer(custodyTxId: string): Promise<TransferResult | null> {
    return this.lookup(custodyTxId);
  }
}
