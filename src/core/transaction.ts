import {
  Address,
  createTransactions,
  decryptXChaCha20Poly1305,
  IUtxoEntry,
  kaspaToSompi,
  PendingTransaction,
  PrivateKeyGenerator,
  RpcClient,
  ScriptBuilder,
  signTransaction,
  createInputSignature,
  Transaction,
  UtxoContext,
} from "kaspa-wasm";
import Addresses from "./addresses";
import EventEmitter from "eventemitter3";

export interface CustomInput {
  address: string;
  outpoint: string;
  index: number;
}

export interface CustomSignature {
  outpoint: string;
  index: number;
  signer: string;
  script?: string;
}

export default class Transactions extends EventEmitter {
  kaspa: RpcClient;
  context: UtxoContext;
  addresses: Addresses;
  encryptedKey: string | undefined;
  accountId: number | undefined;

  private transactions: Map<string, PendingTransaction> = new Map();

  constructor(kaspa: RpcClient, context: UtxoContext, addresses: Addresses) {
    super();

    this.kaspa = kaspa;
    this.context = context;
    this.addresses = addresses;
  }

  async import(encryptedKey: string, accountId: number) {
    this.encryptedKey = encryptedKey;
    this.accountId = accountId;
  }

  async create(
    outputs: [string, string][],
    fee: string,
    customs?: CustomInput[]
  ) {
    let priorityEntries: IUtxoEntry[] = [];

    if (customs && customs.length > 0) {
      const { entries } = await this.kaspa.getUtxosByAddresses({
        addresses: customs.map((custom) => custom.address),
      });
      for (const custom of customs) {
        const matchingEntry = entries.find(
          ({ outpoint }) =>
            outpoint.transactionId === custom.outpoint &&
            outpoint.index === custom.index
        );

        if (matchingEntry) {
          priorityEntries.push(matchingEntry);
        } else throw Error("Failed to resolve custom entry");
      }
    }

    const { transactions } = await createTransactions({
      priorityEntries,
      entries: this.context,
      outputs: outputs.map((output) => ({
        address: output[0],
        amount: kaspaToSompi(output[1])!,
      })),
      changeAddress:
        this.addresses.changeAddresses[
          this.addresses.changeAddresses.length - 1
        ],
      priorityFee: kaspaToSompi(fee)!,
    });

    await this.addresses.increment(0, 1);
    for (const transaction of transactions) {
      this.transactions.set(transaction.id, transaction);
    }

    return transactions.map((transaction) => transaction.serializeToSafeJSON());
  }

  async sign(
    transactions: string[],
    password: string,
    customs: CustomSignature[] = []
  ) {
    if (!this.encryptedKey) throw Error("No imported account");

    const keyGenerator = new PrivateKeyGenerator(
      decryptXChaCha20Poly1305(this.encryptedKey, password),
      false,
      BigInt(this.accountId!)
    );
    const signedTransactions: Transaction[] = [];

    for (const transaction of transactions) {
      const parsedTransaction =
        Transaction.deserializeFromSafeJSON(transaction);
      const privateKeys = [];

      for (let address of parsedTransaction.addresses(
        this.addresses.networkId
      )) {
        if (address.version === "ScriptHash") continue;

        const [isReceive, index] = this.addresses.findIndexes(
          address.toString()
        );
        privateKeys.push(
          isReceive
            ? keyGenerator.receiveKey(index)
            : keyGenerator.changeKey(index)
        );
      }

      const signedTransaction = signTransaction(
        parsedTransaction,
        privateKeys,
        false
      );

      for (const custom of customs) {
        const inputIndex = signedTransaction.inputs.findIndex(
          ({ previousOutpoint }) =>
            previousOutpoint.transactionId === custom.outpoint &&
            previousOutpoint.index === custom.index
        );

        if (Address.validate(custom.signer)) {
          if (!custom.script)
            throw Error("Script is required when signer address is supplied");

          const [isReceive, index] = this.addresses.findIndexes(custom.signer);
          const privateKey = isReceive
            ? keyGenerator.receiveKey(index)
            : keyGenerator.changeKey(index);

          signedTransaction.inputs[inputIndex].signatureScript =
            ScriptBuilder.fromScript(
              custom.script
            ).encodePayToScriptHashSignatureScript(
              createInputSignature(signedTransaction, inputIndex, privateKey)
            );
        } else {
          signedTransaction.inputs[inputIndex].signatureScript = custom.signer;
        }
      }

      signedTransactions.push(signedTransaction);
    }

    return signedTransactions.map((transaction) =>
      transaction.serializeToSafeJSON()
    );
  }

  async submitContextful(transactions: string[]) {
    const submittedIds: string[] = [];

    for (const transaction of transactions) {
      const parsedTransaction =
        Transaction.deserializeFromSafeJSON(transaction);
      const cachedTransaction = this.transactions.get(parsedTransaction.id);

      if (!cachedTransaction)
        throw Error(
          "Transaction is not generated by wallet, use Node.submit()."
        );

      for (let i = 0; i < parsedTransaction.inputs.length; i++) {
        const input = parsedTransaction.inputs[i];

        if (!input.signatureScript) {
          throw new Error("Input signature script isn't defined");
        }
        cachedTransaction.fillInput(i, input.signatureScript);
      }

      submittedIds.push(await cachedTransaction.submit(this.kaspa));
    }

    this.emit("transaction", transactions[transactions.length - 1]);
    return submittedIds;
  }

  reset() {
    delete this.encryptedKey;
    delete this.accountId;
  }
}
