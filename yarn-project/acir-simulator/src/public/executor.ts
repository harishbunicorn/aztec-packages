import { AztecAddress, CallContext, EthAddress, Fr, FunctionData, PrivateHistoricTreeRoots } from '@aztec/circuits.js';
import { padArrayEnd } from '@aztec/foundation/collection';
import { createDebugLogger } from '@aztec/foundation/log';
import { FunctionL2Logs } from '@aztec/types';
import {
  ACVMField,
  ZERO_ACVM_FIELD,
  acvm,
  convertACVMFieldToBuffer,
  extractReturnWitness,
  frToAztecAddress,
  frToSelector,
  fromACVMField,
  toACVMField,
  toACVMWitness,
  toAcvmCommitmentLoadOracleInputs,
  toAcvmL1ToL2MessageLoadOracleInputs,
} from '../acvm/index.js';
import { CommitmentsDB, PublicContractsDB, PublicStateDB } from './db.js';
import { PublicExecution, PublicExecutionResult } from './execution.js';
import { ContractStorageActionsCollector } from './state_actions.js';
import { fieldsToFormattedStr } from '../client/debug.js';

// Copied from crate::abi at noir-contracts/src/contracts/noir-aztec3/src/abi.nr
const NOIR_MAX_RETURN_VALUES = 4;

/**
 * Handles execution of public functions.
 */
export class PublicExecutor {
  private treeRoots: PrivateHistoricTreeRoots;
  constructor(
    private readonly stateDb: PublicStateDB,
    private readonly contractsDb: PublicContractsDB,
    private readonly commitmentsDb: CommitmentsDB,

    private log = createDebugLogger('aztec:simulator:public-executor'),
  ) {
    // Store the tree roots on instantiation.
    this.treeRoots = this.commitmentsDb.getTreeRoots();
  }

  /**
   * Executes a public execution request.
   * @param execution - The execution to run.
   * @returns The result of the run plus all nested runs.
   */
  public async execute(execution: PublicExecution): Promise<PublicExecutionResult> {
    const selectorHex = execution.functionData.functionSelectorBuffer.toString('hex');
    this.log(`Executing public external function ${execution.contractAddress.toString()}:${selectorHex}`);

    const selector = execution.functionData.functionSelectorBuffer;
    const acir = await this.contractsDb.getBytecode(execution.contractAddress, selector);
    if (!acir) throw new Error(`Bytecode not found for ${execution.contractAddress.toString()}:${selectorHex}`);

    const initialWitness = getInitialWitness(execution.args, execution.callContext, this.treeRoots);
    const storageActions = new ContractStorageActionsCollector(this.stateDb, execution.contractAddress);
    const newCommitments: Fr[] = [];
    const newL2ToL1Messages: Fr[] = [];
    const newNullifiers: Fr[] = [];
    const nestedExecutions: PublicExecutionResult[] = [];
    const unencryptedLogs = new FunctionL2Logs([]);

    const notAvailable = () => Promise.reject(`Built-in not available for public execution simulation`);

    const { partialWitness } = await acvm(acir, initialWitness, {
      getSecretKey: notAvailable,
      getNotes2: notAvailable,
      getRandomField: notAvailable,
      notifyCreatedNote: notAvailable,
      notifyNullifiedNote: notAvailable,
      callPrivateFunction: notAvailable,
      enqueuePublicFunctionCall: notAvailable,
      emitEncryptedLog: notAvailable,
      viewNotesPage: notAvailable,

      debugLog: (fields: ACVMField[]) => {
        this.log(fieldsToFormattedStr(fields));
        return Promise.resolve([ZERO_ACVM_FIELD]);
      },
      getL1ToL2Message: async ([msgKey]: ACVMField[]) => {
        const messageInputs = await this.commitmentsDb.getL1ToL2Message(fromACVMField(msgKey));
        return toAcvmL1ToL2MessageLoadOracleInputs(messageInputs, this.treeRoots.l1ToL2MessagesTreeRoot);
      }, // l1 to l2 messages in public contexts TODO: https://github.com/AztecProtocol/aztec-packages/issues/616
      getCommitment: async ([commitment]: ACVMField[]) => {
        const commitmentInputs = await this.commitmentsDb.getCommitmentOracle(
          execution.contractAddress,
          fromACVMField(commitment),
        );
        return toAcvmCommitmentLoadOracleInputs(commitmentInputs, this.treeRoots.privateDataTreeRoot);
      },
      storageRead: async ([slot]) => {
        const storageSlot = fromACVMField(slot);
        const value = await storageActions.read(storageSlot);
        this.log(`Oracle storage read: slot=${storageSlot.toShortString()} value=${value.toString()}`);
        return [toACVMField(value)];
      },
      storageWrite: async ([slot, value]) => {
        const storageSlot = fromACVMField(slot);
        const newValue = fromACVMField(value);
        await storageActions.write(storageSlot, newValue);
        await this.stateDb.storageWrite(execution.contractAddress, storageSlot, newValue);
        this.log(`Oracle storage write: slot=${storageSlot.toShortString()} value=${value.toString()}`);
        return [toACVMField(newValue)];
      },
      createCommitment: async ([commitment]) => {
        this.log('Creating commitment: ' + commitment.toString());
        newCommitments.push(fromACVMField(commitment));
        return await Promise.resolve([ZERO_ACVM_FIELD]);
      },
      createL2ToL1Message: async ([message]) => {
        this.log('Creating L2 to L1 message: ' + message.toString());
        newL2ToL1Messages.push(fromACVMField(message));
        return await Promise.resolve([ZERO_ACVM_FIELD]);
      },
      createNullifier: async ([nullifier]) => {
        this.log('Creating nullifier: ' + nullifier.toString());
        newNullifiers.push(fromACVMField(nullifier));
        return await Promise.resolve([ZERO_ACVM_FIELD]);
      },
      callPublicFunction: async ([address, functionSelector, ...args]) => {
        this.log(`Public function call: addr=${address} selector=${functionSelector} args=${args.join(',')}`);
        const childExecutionResult = await this.callPublicFunction(
          frToAztecAddress(fromACVMField(address)),
          frToSelector(fromACVMField(functionSelector)),
          args.map(f => fromACVMField(f)),
          execution.callContext,
        );

        nestedExecutions.push(childExecutionResult);
        this.log(`Returning from nested call: ret=${childExecutionResult.returnValues.join(', ')}`);
        return padArrayEnd(childExecutionResult.returnValues, Fr.ZERO, NOIR_MAX_RETURN_VALUES).map(toACVMField);
      },
      emitUnencryptedLog: ([...args]: ACVMField[]) => {
        // https://github.com/AztecProtocol/aztec-packages/issues/885
        const log = Buffer.concat(args.map(charBuffer => convertACVMFieldToBuffer(charBuffer).subarray(-1)));
        unencryptedLogs.logs.push(log);
        this.log(`Emitted unencrypted log: "${log.toString('ascii')}"`);
        return Promise.resolve([ZERO_ACVM_FIELD]);
      },
    });

    const returnValues = extractReturnWitness(acir, partialWitness).map(fromACVMField);

    const [contractStorageReads, contractStorageUpdateRequests] = storageActions.collect();

    return {
      execution,
      newCommitments,
      newL2ToL1Messages,
      newNullifiers,
      contractStorageReads,
      contractStorageUpdateRequests,
      returnValues,
      nestedExecutions,
      unencryptedLogs,
    };
  }

  private async callPublicFunction(
    targetContractAddress: AztecAddress,
    targetFunctionSelector: Buffer,
    targetArgs: Fr[],
    callerContext: CallContext,
  ) {
    const portalAddress = (await this.contractsDb.getPortalContractAddress(targetContractAddress)) ?? EthAddress.ZERO;
    const functionData = new FunctionData(targetFunctionSelector, false, false);

    const callContext = CallContext.from({
      msgSender: callerContext.storageContractAddress,
      portalContractAddress: portalAddress,
      storageContractAddress: targetContractAddress,
      isContractDeployment: false,
      isDelegateCall: false,
      isStaticCall: false,
    });

    const nestedExecution: PublicExecution = {
      args: targetArgs,
      contractAddress: targetContractAddress,
      functionData,
      callContext,
    };

    return this.execute(nestedExecution);
  }
}

/**
 * Generates the initial witness for a public function.
 * @param args - The arguments to the function.
 * @param callContext - The call context of the function.
 * @param witnessStartIndex - The index where to start inserting the parameters.
 * @returns The initial witness.
 */
function getInitialWitness(
  args: Fr[],
  callContext: CallContext,
  commitmentTreeRoots: PrivateHistoricTreeRoots,
  witnessStartIndex = 1,
) {
  return toACVMWitness(witnessStartIndex, [
    callContext.msgSender,
    callContext.storageContractAddress,
    callContext.portalContractAddress,
    callContext.isDelegateCall,
    callContext.isStaticCall,
    callContext.isContractDeployment,

    commitmentTreeRoots.privateDataTreeRoot,
    commitmentTreeRoots.nullifierTreeRoot,
    commitmentTreeRoots.contractTreeRoot,
    commitmentTreeRoots.l1ToL2MessagesTreeRoot,

    ...args,
  ]);
}
