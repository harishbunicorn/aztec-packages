import { KernelCircuitPublicInputs, Proof, PublicCallRequest } from '@aztec/circuits.js';

import { arrayNonEmptyLength } from '@aztec/foundation/collection';
import { EncodedContractFunction } from './contract_data.js';
import { TxL2Logs } from './logs/tx_l2_logs.js';
import { TxHash } from './tx_hash.js';

/**
 * The interface of an L2 transaction.
 */
export class Tx {
  protected constructor(
    /**
     * Output of the private kernel circuit for this tx.
     */
    public readonly data: KernelCircuitPublicInputs,
    /**
     * Proof from the private kernel circuit.
     */
    public readonly proof: Proof,
    /**
     * Encrypted logs generated by the tx.
     */
    public readonly encryptedLogs: TxL2Logs,
    /**
     * Unencrypted logs generated by the tx.
     */
    public readonly unencryptedLogs: TxL2Logs,
    /**
     * New public functions made available by this tx.
     */
    public readonly newContractPublicFunctions: EncodedContractFunction[],
    /**
     * Enqueued public functions from the private circuit to be run by the sequencer.
     * Preimages of the public call stack entries from the private kernel circuit output.
     */
    public readonly enqueuedPublicFunctionCalls: PublicCallRequest[],
  ) {
    if (this.unencryptedLogs.functionLogs.length < this.encryptedLogs.functionLogs.length) {
      // This check is present because each private function invocation creates encrypted FunctionL2Logs object and
      // both public and private function invocations create unencrypted FunctionL2Logs object. Hence "num unencrypted"
      // >= "num encrypted".
      throw new Error(
        `Number of function logs in unencrypted logs (${this.unencryptedLogs.functionLogs.length}) has to be equal 
        or larger than number function logs in encrypted logs (${this.encryptedLogs.functionLogs.length})`,
      );
    }

    const kernelPublicCallStackSize =
      data?.end.publicCallStack && arrayNonEmptyLength(data.end.publicCallStack, item => item.isZero());
    if (kernelPublicCallStackSize && kernelPublicCallStackSize > (enqueuedPublicFunctionCalls?.length ?? 0)) {
      throw new Error(
        `Missing preimages for enqueued public function calls in kernel circuit public inputs (expected 
          ${kernelPublicCallStackSize}, got ${enqueuedPublicFunctionCalls?.length})`,
      );
    }
  }

  /**
   * Creates a new private transaction.
   * @param data - Public inputs of the private kernel circuit.
   * @param proof - Proof from the private kernel circuit.
   * @param encryptedLogs - Encrypted logs created by this tx.
   * @param unencryptedLogs - Unencrypted logs created by this tx.
   * @param newContractPublicFunctions - Public functions made available by this tx.
   * @param enqueuedPublicFunctionCalls - Preimages of the public call stack of the kernel output.
   * @returns A new private tx instance.
   */
  public static createTx(
    data: KernelCircuitPublicInputs,
    proof: Proof,
    encryptedLogs: TxL2Logs,
    unencryptedLogs: TxL2Logs,
    newContractPublicFunctions: EncodedContractFunction[],
    enqueuedPublicFunctionCalls: PublicCallRequest[],
  ): Tx {
    return new this(
      data,
      proof,
      encryptedLogs,
      unencryptedLogs,
      newContractPublicFunctions,
      enqueuedPublicFunctionCalls,
    );
  }

  /**
   * Construct & return transaction hash.
   * @returns The transaction's hash.
   */
  getTxHash(): Promise<TxHash> {
    // Private kernel functions are executed client side and for this reason tx hash is already set as first nullifier
    const firstNullifier = this.data?.end.newNullifiers[0];
    if (!firstNullifier) throw new Error(`Cannot get tx hash since first nullifier is missing`);
    return Promise.resolve(new TxHash(firstNullifier.toBuffer()));
  }

  /**
   * Convenience function to get array of hashes for an array of txs.
   * @param txs - The txs to get the hashes from.
   * @returns The corresponding array of hashes.
   */
  static async getHashes(txs: Tx[]): Promise<TxHash[]> {
    return await Promise.all(txs.map(tx => tx.getTxHash()));
  }

  /**
   * Clones a tx, making a deep copy of all fields.
   * @param tx - The transaction to be cloned.
   * @returns The cloned transaction.
   */
  static clone(tx: Tx): Tx {
    const publicInputs = KernelCircuitPublicInputs.fromBuffer(tx.data.toBuffer());
    const proof = Proof.fromBuffer(tx.proof.toBuffer());
    const encryptedLogs = TxL2Logs.fromBuffer(tx.encryptedLogs.toBuffer());
    const unencryptedLogs = TxL2Logs.fromBuffer(tx.unencryptedLogs.toBuffer());
    const publicFunctions = tx.newContractPublicFunctions.map(x => {
      return EncodedContractFunction.fromBuffer(x.toBuffer());
    });
    const enqueuedPublicFunctions = tx.enqueuedPublicFunctionCalls.map(x => {
      return PublicCallRequest.fromBuffer(x.toBuffer());
    });
    return new Tx(publicInputs, proof, encryptedLogs, unencryptedLogs, publicFunctions, enqueuedPublicFunctions);
  }
}
