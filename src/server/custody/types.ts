/**
 * Custody / signing provider contract.
 *
 * The application never holds private keys. Address issuance, signing and
 * broadcasting are delegated to an isolated provider (institutional custodian
 * or audited MPC/HSM service). Every transfer request carries an idempotency
 * key; a provider MUST return the original transfer for a repeated key rather
 * than creating a second one. That property is what makes payout retries safe.
 */

export interface DepositAddressResult {
  address: string;
  custodyRef: string;
}

export interface TransferRequest {
  idempotencyKey: string;
  networkId: number;
  networkCode: string;
  tokenContract: string;
  fromAddress: string;
  toAddress: string;
  amount: bigint;
}

export type CustodyTransferStatus = 'submitted' | 'broadcast' | 'confirmed' | 'failed' | 'dropped';

export interface TransferResult {
  custodyTxId: string;
  status: CustodyTransferStatus;
  txHash: string | null;
  feeNative: bigint | null;
  error?: string;
}

export interface CustodyProvider {
  readonly name: string;
  readonly isSimulated: boolean;
  supportsNetwork(networkCode: string): boolean;
  createDepositAddress(args: { networkId: number; networkCode: string; userId: string }): Promise<DepositAddressResult>;
  submitTransfer(req: TransferRequest): Promise<TransferResult>;
  getTransfer(custodyTxId: string, networkId: number): Promise<TransferResult | null>;
}

export class CustodyUnavailableError extends Error {
  override name = 'CustodyUnavailableError';
}
