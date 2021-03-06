import * as Web3 from 'web3';
import BigNumber from 'bignumber.js';
import { typedSignatureHash, recoverTypedSignature } from 'eth-sig-util';

declare const localStorage; // possibly missing


// helper types

/**
 * [[MicroRaiden.channel.proof]] data type
 */
export interface MicroProof {
  /**
   * Balance value, shifted by token decimals
   */
  balance: BigNumber;
  /**
   * Balance signature
   */
  sign?: string;
}

/**
 * [[MicroRaiden.channel]] state data blueprint
 */
export interface MicroChannel {
  /**
   * Sender/client's account address
   */
  account: string;
  /**
   * Receiver/server's account address
   */
  receiver: string;
  /**
   * Open channel block number
   */
  block: number;
  /**
   * Current balance proof
   */
  proof: MicroProof;
  /**
   * Next balance proof, persisted with [[MicroRaiden.confirmPayment]]
   */
  next_proof?: MicroProof;
  /**
   * Cooperative close signature from receiver
   */
  close_sign?: string;
}

/**
 * [[MicroRaiden.getChannelInfo]] result
 */
export interface MicroChannelInfo {
  /**
   * Current channel state, one of 'opened', 'closed' or 'settled'
   */
  state: string;
  /**
   * Block of current state (opened=open block number,
   * closed=channel close requested block number, settled=settlement block number)
   */
  block: number;
  /**
   * Current channel deposited sum
   */
  deposit: BigNumber;
}

/**
 * [[MicroRaiden.getTokenInfo]] result
 */
export interface MicroTokenInfo {
  name: string;
  symbol: string;
  decimals: number;
  balance: BigNumber;
}

/**
 * Array member type to be sent to eth_signTypedData
 */
interface MsgParam {
  type: string;
  name: string;
  value: string;
}


// utils

/**
 * Convert a callback-based func to return a promise
 *
 * It'll return a function which, when called, will pass all received
 * parameters to the wrapped method, and return a promise which will be
 * resolved which callback data passed as last parameter
 *
 * @param obj  A object containing the method to be called
 * @param method  A method name of obj to be promisified
 * @returns  A method wrapper which returns a promise
 */
function promisify<T>(obj: any, method: string): (...args: any[]) => Promise<T> {
  return (...params) =>
    new Promise((resolve, reject) =>
      obj[method](...params, (err, res) => err ? reject(err) : resolve(res)));
}

/**
 * Promise-based deferred class
 */
class Deferred<T> {
  resolve: (res: T) => void;
  reject: (err: Error) => void;
  promise = new Promise<T>((resolve, reject) => {
    this.resolve = resolve;
    this.reject = reject;
  });
}

/**
 * Encode strings and numbers as hex, left-padded, if required.
 *
 * 0x prefix not added,
 *
 * @param val  Value to be hex-encoded
 * @param zPadLength  Left-pad with zeroes to this number of characters
 * @returns  hex-encoded value
 */
function encodeHex(val: string|number|BigNumber, zPadLength?: number): string {
  /* Encode a string or number as hexadecimal, without '0x' prefix */
  if (typeof val === 'number' || val instanceof BigNumber ) {
    val = val.toString(16);
  } else {
    val = Array.from(<string>val).map((char: string) =>
        char.charCodeAt(0).toString(16).padStart(2, '0'))
      .join('');
  }
  return val.padStart(zPadLength || 0, '0');
}


/**
 * Main MicroRaiden client class
 *
 * Contains all methods to interact with a MicroRaiden channel through a web3
 * instance.
 */
export class MicroRaiden {
  /**
   * Web3 instance
   */
  web3: Web3;
  /**
   * Currently set channel info. May be loaded through [[loadStoredChannel]],
   * [[loadChannelFromBlockchain]], or stored and set manually with [[setChannel]]
   */
  channel: MicroChannel;
  /**
   * Token contract instance
   */
  token: Web3.ContractInstance;
  /**
   * Channel manager contract instance
   */
  contract: Web3.ContractInstance;
  /**
   * Token decimals
   */
  decimals: number = 0;
  /**
   * Challenge period for uncooperative close, setup in channel manager
   */
  challenge: number;

  /**
   * MicroRaiden constructor
   *
   * @param web3  Web3 http url, or object with currentProvider property
   * @param contractAddr  Channel manager contract address
   * @param contractABI  Channel manager ABI
   * @param tokenAddr  Token address, must be the same setup in channel manager
   * @param tokenABI  Token ABI
   */
  constructor(
    web3: string | { currentProvider: any },
    contractAddr: string,
    contractABI: any[],
    tokenAddr: string,
    tokenABI: any[],
  ) {
    if (!web3) {
      web3 = 'http://localhost:8545';
    }
    if (typeof web3 === 'string') {
      this.web3 = new Web3(new Web3.providers.HttpProvider(web3));
    } else if (web3['currentProvider']) {
      this.web3 = new Web3(web3.currentProvider);
    } else {
      throw new Error('Invalid web3 provider');
    }

    this.contract = this.web3.eth.contract(contractABI).at(contractAddr);
    this.token = this.web3.eth.contract(tokenABI).at(tokenAddr);
  }

  // utils

  /**
   * Convert number to BigNumber
   *
   * Takes into account configured token, taking in account the token decimals
   *
   * @param value  Number or numeric-string to be converted
   * @returns  BigNumber representation of value * 10^decimals
   */
  num2tkn(value?: number|string): BigNumber {
    return new BigNumber(value || 0).shift(this.decimals);
  }

  /**
   * Convert BigNumber to number
   *
   * Takes into account configured token, taking in account the token decimals
   * Caution: it may add imprecisions due to javascript's native number limitations
   *
   * @param bal  Value to be converted
   * @returns  JS's native number representation of bal
   */
  tkn2num(bal: BigNumber): number {
    return (new BigNumber(bal)).shift(-this.decimals).toNumber();
  }

  /**
   * Watch for a particular transaction hash to have given confirmations
   *
   * @param txHash  Transaction hash to wait for
   * @param confirmations  Number of confirmations to wait after tx is mined
   * @returns  Promise to mined receipt of transaction */
  private async waitTx(txHash: string, confirmations?: number): Promise<Web3.TransactionReceipt> {
    confirmations = +confirmations || 0;

    const defer = new Deferred<Web3.TransactionReceipt>();
    const blockStart = await promisify<number>(this.web3.eth, 'getBlockNumber')();

    const intervalId = setInterval(async () => {
      const [ receipt, block ] = await Promise.all([
        await promisify<Web3.TransactionReceipt>(this.web3.eth, 'getTransactionReceipt')(txHash),
        await promisify<number>(this.web3.eth, 'getBlockNumber')(),
      ]);
      if (!receipt || !receipt.blockNumber) {
        console.log('Waiting tx..', block - blockStart);
        return;
      } else if (block - receipt.blockNumber < confirmations) {
        console.log('Waiting confirmations...', block - receipt.blockNumber);
        return;
      }

      // Tx is finished
      clearInterval(intervalId);
      return defer.resolve(receipt);
    }, 2e3); // poll every 2secs

    return defer.promise;
  }

  /**
   * Get contract's configured challenge's period
   *
   * As it calls the contract method, can be used for validating that
   * contract's address has code in current network
   *
   * @returns  Promise to challenge period number, in blocks
   */
  async getChallengePeriod(): Promise<number> {
    this.challenge = (await promisify<BigNumber>(
      this.contract.challenge_period,
      'call'
    )()).toNumber();
    return this.challenge;
  }

  // instance methods

  /**
   * If localStorage is available, try to load a channel from it
   *
   * Indexed by given account and receiver
   *
   * @param account  Sender/client's account address
   * @param receiver  Receiver/server's account address
   * @returns  True if a channel data was found, false otherwise
   */
  loadStoredChannel(account: string, receiver: string): boolean {
    if (!localStorage) {
      delete this.channel;
      return false;
    }
    const key = [account, receiver].join('|');
    const value = localStorage.getItem(key);
    if (value) {
      const channel = JSON.parse(value);
      if (!channel || !channel.proof || !channel.proof.balance) {
        return false;
      }
      channel.proof.balance = new BigNumber(channel.proof.balance);
      if (channel.next_proof)
        channel.next_proof.balance = new BigNumber(channel.next_proof.balance);
      this.channel = channel;
      return true;
    } else {
      delete this.channel;
      return false;
    }
  }

  /**
   * Forget current channel and remove it from localStorage, if available
   */
  forgetStoredChannel(): void {
    if (!this.channel) {
      return;
    }
    if (localStorage) {
      const key = [this.channel.account, this.channel.receiver].join('|');
      localStorage.removeItem(key);
    }
    delete this.channel;
  }

  /**
   * Scan the blockchain for an open channel, and load it with 0 balance
   *
   * The 0 balance may be overwritten with [[setBalance]] if
   * server replies with a updated balance on first request.
   * It should ask user for signing the zero-balance proof
   * Throws/reject if no open channel was found
   *
   * @param account  Sender/client's account address
   * @param receiver  Receiver/server's account address
   * @returns  Promise to channel info, if a channel was found
   */
  async loadChannelFromBlockchain(account: string, receiver: string): Promise<MicroChannel> {
    const openEvents = await promisify<{ blockNumber: number }[]>(this.contract.ChannelCreated({
      _sender: account,
      _receiver: receiver,
    }, {
      fromBlock: 0,
      toBlock: 'latest'
    }), 'get')();
    if (!openEvents || openEvents.length === 0) {
      throw new Error('No channel found for this account');
    }

    const minBlock = openEvents[0].blockNumber;
    const [ closeEvents, settleEvents ] = await Promise.all([
      promisify<{ blockNumber: number }[]>(this.contract.ChannelCloseRequested({
        _sender: account,
        _receiver: receiver,
      }, {
        fromBlock: minBlock,
        toBlock: 'latest'
      }), 'get')(),
      promisify<{ blockNumber: number }[]>(this.contract.ChannelSettled({
        _sender: account,
        _receiver: receiver,
      }, {
        fromBlock: minBlock,
        toBlock: 'latest'
      }), 'get')(),
    ]);

    const closedBlocks = closeEvents.concat(settleEvents).map((ev) => ev.blockNumber),
          stillOpen = openEvents.filter((ev) => closedBlocks.indexOf(ev.blockNumber) < 0);
    if (stillOpen.length === 0) {
      throw new Error('No open channels found');
    }
    this.setChannel({
      account,
      receiver,
      block: stillOpen[0].blockNumber,
      proof: { balance: new BigNumber(0) },
    });
    return this.channel;
  }

  /**
   * Set [[channel]] info
   *
   * Can be used to externally [re]store an externally persisted channel info
   *
   * @param channel  Channel info to be set
   */
  setChannel(channel: MicroChannel): void {
    this.channel = channel;
    if (localStorage) {
      const key = [this.channel.account, this.channel.receiver].join('|');
      localStorage.setItem(key, JSON.stringify(this.channel));
    }
  }

  /**
   * Health check for currently configured channel info
   *
   * @returns  True if channel is valid, false otherwise
   */
  isChannelValid(): boolean {
    if (!this.channel || !this.channel.receiver || !this.channel.block
      || !this.channel.proof || !this.channel.account) {
      return false;
    }
    return true;
  }


  /**
   * Get available accounts from web3 providers
   *
   * @returns Promise to accounts addresses array
   */
  async getAccounts(): Promise<string[]> {
    return await promisify<string[]>(this.web3.eth, 'getAccounts')();
  }

  /**
   * Get token details such as name, symbol and decimals.
   *
   * If account is provided, returns also account balance for this token.
   *
   * @param account  Address to be queried for current token balance
   * @returns  Promise to [[MicroTokenInfo]] data
   */
  async getTokenInfo(account?: string): Promise<MicroTokenInfo> {
    const [name, symbol, decimals, balance] = await Promise.all([
      promisify<string>(this.token.name, 'call')(),
      promisify<string>(this.token.symbol, 'call')(),
      promisify<BigNumber>(this.token.decimals, 'call')().then((d) => d.toNumber()),
      account ? promisify<BigNumber>(this.token.balanceOf, 'call')(account) : null
    ]);
    this.decimals = decimals;
    return { name, symbol, decimals, balance };
  }

  /**
   * Get channel details such as current state (one of opened, closed or
   * settled), block in which it was set and current deposited amount
   *
   * @returns Promise to [[MicroChannelInfo]] data
   */
  async getChannelInfo(): Promise<MicroChannelInfo> {
    if (!this.isChannelValid()) {
      throw new Error('No valid channelInfo');
    }

    const closeEvents = await promisify<{ blockNumber: number }[]>(this.contract.ChannelCloseRequested({
      _sender: this.channel.account,
      _receiver: this.channel.receiver,
      _open_block_number: this.channel.block,
    }, {
      fromBlock: this.channel.block,
      toBlock: 'latest'
    }), 'get')();

    let closed: number;
    if (!closeEvents || closeEvents.length === 0) {
      closed = 0;
    } else {
      closed = closeEvents[0].blockNumber;
    }

    const settleEvents = await promisify<{ blockNumber: number }[]>(this.contract.ChannelSettled({
      _sender: this.channel.account,
      _receiver: this.channel.receiver,
      _open_block_number: this.channel.block,
    }, {
      fromBlock: closed || this.channel.block,
      toBlock: 'latest'
    }), 'get')();

    let settled: number;
    if (!settleEvents || settleEvents.length === 0) {
      settled = 0;
    } else {
      settled = settleEvents[0].blockNumber;
    }
    // for settled channel, getChannelInfo call will fail, so we return before
    if (settled) {
      return {'state': 'settled', 'block': settled, 'deposit': new BigNumber(0)};
    }

    const info = await promisify<BigNumber[]>(this.contract.getChannelInfo, 'call')(
      this.channel.account,
      this.channel.receiver,
      this.channel.block,
      { from: this.channel.account });

    if (!(info[1].gt(0))) {
      throw new Error('Invalid channel deposit: '+JSON.stringify(info));
    }
    return {
      'state': closed ? 'closed' : 'opened',
      'block': closed || this.channel.block,
      'deposit': info[1],
    };
  }

  /**
   * Open a channel for account to receiver, depositing some tokens on it
   *
   * Should work with both ERC20/ERC223 tokens.
   * Replaces current [[channel]] data
   *
   * @param account  Sender/client's account address
   * @param receiver  Receiver/server's account address
   * @param deposit  Tokens to be initially deposited in the channel
   * @returns  Promise to [[MicroChannel]] info object
   */
  async openChannel(account: string, receiver: string, deposit: BigNumber): Promise<MicroChannel> {
    if (this.isChannelValid()) {
      console.warn('Already valid channel will be forgotten:', this.channel);
    }

    // first, check if there's enough balance
    const balance = await promisify<BigNumber>(this.token.balanceOf, 'call')(account, { from: account });
    if (!(balance.gte(deposit))) {
      throw new Error(`Not enough tokens.
        Token balance = ${balance}, required = ${deposit}`);
    }
    console.log('Token balance', this.token.address, balance);

    // call transfer to make the deposit, automatic support for ERC20/223 token
    let transferTxHash: string;
    if (typeof this.token.transfer['address,uint256,bytes'] === 'function') {
      // ERC223
      // transfer tokens directly to the channel manager contract
      transferTxHash = await promisify<string>(this.token.transfer['address,uint256,bytes'], 'sendTransaction')(
        this.contract.address,
        deposit,
        receiver, // bytes _data (3rd param) is the receiver
        { from: account });
    } else {
      // ERC20
      // send 'approve' transaction to token contract
      await promisify<string>(this.token.approve, 'sendTransaction')(
        this.contract.address,
        deposit,
        { from: account });
      // send 'createChannel' transaction to channel manager contract
      transferTxHash = await promisify<string>(this.contract.createChannelERC20, 'sendTransaction')(
        receiver,
        deposit,
        { from: account });
    }
    console.log('transferTxHash', transferTxHash);

    // wait for 'transfer' transaction to be mined
    const receipt = await this.waitTx(transferTxHash, 1);

    // call getChannelInfo to be sure channel was created
    const info = await promisify<BigNumber[]>(this.contract.getChannelInfo, 'call')(
      account,
      receiver,
      receipt.blockNumber,
      { from: account });
    if (!(info[1].gt(0))) {
      throw new Error('No deposit found!');
    }
    this.setChannel({
      account,
      receiver,
      block: receipt.blockNumber,
      proof: { balance: new BigNumber(0) },
    });

    // return channel
    return this.channel;
  }

  /**
   * Top up current channel, by depositing some [more] tokens to it
   *
   * Should work with both ERC20/ERC223 tokens
   *
   * @param deposit  Tokens to be deposited in the channel
   * @returns  Promise to tx block number
   */
  async topUpChannel(deposit: BigNumber): Promise<number> {
    if (!this.isChannelValid()) {
      throw new Error('No valid channelInfo');
    }

    const account = this.channel.account;

    // first, check if there's enough balance
    const balance = await promisify<BigNumber>(this.token.balanceOf, 'call')(account, { from: account });
    if (!(balance.gte(deposit))) {
      throw new Error(`Not enough tokens.
        Token balance = ${balance}, required = ${deposit}`);
    }
    console.log('Token balance', this.token.address, balance);

    // automatically support both ERC20 and ERC223 tokens
    let transferTxHash: string;
    if (typeof this.token.transfer['address,uint256,bytes'] === 'function') {
      // ERC223, just send token.transfer transaction
      // transfer tokens directly to the channel manager contract
      transferTxHash = await promisify<string>(this.token.transfer['address,uint256,bytes'], 'sendTransaction')(
        this.contract.address,
        deposit,
        // receiver goes as 3rd param, 20 bytes, plus blocknumber, 4bytes
        this.channel.receiver + encodeHex(this.channel.block, 8),
        { from: account });
    } else {
      // ERC20, approve channel manager contract to handle our tokens, then topUp
      // send 'approve' transaction to token contract
      await promisify<string>(this.token.approve, 'sendTransaction')(
        this.contract.address,
        deposit,
        { from: account });
      // send 'topUp' transaction to channel manager contract
      transferTxHash = await promisify<string>(this.contract.topUpERC20, 'sendTransaction')(
        this.channel.receiver,
        this.channel.block,
        deposit,
        { from: account });
    }
    console.log('transferTxHash', transferTxHash);

    // wait for 'transfer' transaction to be mined
    const receipt = await this.waitTx(transferTxHash, 1);

    return receipt.blockNumber;
  }

  /**
   * Close current channel
   *
   * Optional parameter is signed cooperative close from receiver, if available.
   * If cooperative close was successful, channel is already settled after this
   * method is resolved.
   * Else, it enters 'closed' state, and should be settled after settlement
   * period, configured in contract.
   *
   * @param receiverSign  Cooperative-close signature from receiver
   * @returns  Promise to block number in which channel was closed
   */
  async closeChannel(receiverSign?: string): Promise<number> {
    if (!this.isChannelValid()) {
      throw new Error('No valid channelInfo');
    }
    const info = await this.getChannelInfo();
    if (info.state !== 'opened') {
      throw new Error('Tried closing already closed channel');
    }

    if (this.channel.close_sign) {
      receiverSign = this.channel.close_sign;
    } else if (receiverSign) {
      this.setChannel(Object.assign(
        {},
        this.channel,
        { close_sign: receiverSign },
      ));
    }
    console.log(`Closing channel. Cooperative = ${receiverSign}`);


    let proof: MicroProof;
    if (!this.channel.proof.sign) {
      proof = await this.signNewProof(this.channel.proof);
    } else {
      proof = this.channel.proof;
    }

    const txHash = receiverSign ?
      await promisify<string>(this.contract.cooperativeClose, 'sendTransaction')(
        this.channel.receiver,
        this.channel.block,
        proof.balance,
        proof.sign,
        receiverSign,
        { from: this.channel.account }) :
      await promisify<string>(this.contract.uncooperativeClose, 'sendTransaction')(
        this.channel.receiver,
        this.channel.block,
        proof.balance,
        proof.sign,
        { from: this.channel.account });

    console.log('closeTxHash', txHash);
    const receipt = await this.waitTx(txHash, 0);
    return receipt.blockNumber;
  }

  /**
   * If channel was not cooperatively closed, and after settlement period,
   * this function settles the channel, distributing the tokens to sender and
   * receiver.
   *
   * @returns  Promise to block number of settlement tx
   */
  async settleChannel(): Promise<number> {
    if (!this.isChannelValid()) {
      throw new Error('No valid channelInfo');
    }
    const info = await this.getChannelInfo();
    if (info.state !== 'closed') {
      throw new Error('Tried settling opened or settled channel');
    }
    const txHash = await promisify<string>(this.contract.settle, 'sendTransaction')(
      this.channel.receiver,
      this.channel.block,
      { from: this.channel.account });

    console.log('settleTxHash', txHash);
    const receipt = await this.waitTx(txHash, 0);
    return receipt.blockNumber;
  }

  /**
   * Ask user for signing a string with (personal|eth)_sign
   *
   * @param msg  Data to be signed
   * @returns Promise to signature
   */
  async signMessage(msg: string): Promise<string> {
    if (!this.isChannelValid()) {
      throw new Error('No valid channelInfo');
    }
    const hex = msg.startsWith('0x') ? msg : ( '0x' + encodeHex(msg) );
    console.log(`Signing "${msg}" => ${hex}, account: ${this.channel.account}`);

    let sign: string;
    try {
      sign = await promisify<string>(this.web3.personal, 'sign')(hex, this.channel.account);
    } catch (err) {
      if (err.message &&
        (err.message.includes('Method not found') ||
          err.message.includes('is not a function'))) {
        sign = await promisify<string>(this.web3.eth, 'sign')(this.channel.account, hex);
      } else {
        throw err;
      }
    }
    return sign;
  }

  /**
   * Ask user for signing a channel balance
   *
   * Notice it's the final balance, not the increment, and that the new
   * balance is set in [[channel.next_proof]], requiring a
   * [[confirmPayment]] call to persist it, after successful
   * request.
   * Implementation can choose to call confirmPayment right after this call
   * resolves, assuming request will be successful after payment is signed.
   * Tries to use eth_signTypedData (from EIP712), tries to use personal sign
   * if it fails.
   *
   * @param proof  Balance proof to be signed
   * @returns  Promise to signature
   */
  async signNewProof(proof?: MicroProof): Promise<MicroProof> {
    if (!this.isChannelValid()) {
      throw new Error('No valid channelInfo');
    }
    console.log('signNewProof', proof);
    if (!proof) {
      proof = this.channel.proof;
    }
    if (proof.sign) {
      return proof;
    }

    const params: MsgParam[] = [
      {
        name: 'receiver',
        type: 'address',
        value: this.channel.receiver,
      },
      {
        name: 'block_created',
        type: 'uint32',
        value: '' + this.channel.block,
      },
      {
        name: 'balance',
        type: 'uint192',
        value: proof.balance.toString(),
      },
      {
        name: 'contract',
        type: 'address',
        value: this.contract.address,
      },
    ];
    let sign: string;
    try {
      const result = await promisify<{ result: string, error: Error }>(
        this.web3.currentProvider, 'sendAsync'
      )({
        method: 'eth_signTypedData',
        params: [params, this.channel.account],
        from: this.channel.account
      });
      if (result.error)
        throw result.error;
      sign = result.result;
    } catch (err) {
      if (err.message && err.message.includes('User denied')) {
        throw err;
      }
      console.log('Error on signTypedData', err);
      const hash = typedSignatureHash(params);
      // ask for signing of the hash
      sign = await this.signMessage(hash);
    }
    //debug
    const recovered = recoverTypedSignature({ data: params, sig: sign  });
    console.log('signTypedData =', sign, recovered);

    proof.sign = sign;

    // return signed message
    if (proof.balance.equals(this.channel.proof.balance)) {
      this.setChannel(Object.assign(
        {},
        this.channel,
        { proof, next_proof: proof }
      ));
    } else {
      this.setChannel(Object.assign(
        {},
        this.channel,
        { next_proof: proof }
      ));
    }
    return proof;
  }

  /**
   * Ask user for signing a payment, which is previous balance incremented of
   * amount.
   *
   * Warnings from [[signNewProof]] applies
   *
   * @param amount  Amount to increment in current balance
   * @returns  Promise to signature
   */
  async incrementBalanceAndSign(amount: BigNumber): Promise<MicroProof> {
    if (!this.isChannelValid()) {
      throw new Error('No valid channelInfo');
    }
    const proof: MicroProof = { balance: this.channel.proof.balance.plus(amount) };
    // get current deposit
    const info = await this.getChannelInfo();
    if (info.state !== 'opened') {
      throw new Error('Tried signing on closed channel');
    } else if (proof.balance.gt(info.deposit)) {
      const err = new Error(`Insuficient funds: current = ${info.deposit} , required = ${proof.balance}`);
      err['current'] = info.deposit;
      err['required'] = proof.balance;
      throw err;
    }
    // get hash for new balance proof
    return await this.signNewProof(proof);
  }

  /**
   * Persists [[channel.next_proof]] to [[channel.proof]]
   *
   * This method must be used after successful payment request,
   * or right after [[signNewProof]] is resolved,
   * if implementation don't care for request status
   */
  confirmPayment(proof: MicroProof): void {
    if (!this.channel.next_proof
      || !this.channel.next_proof.sign
      || this.channel.next_proof.sign !== proof.sign) {
      throw new Error('Invalid provided or stored next signature');
    }
    const channel = Object.assign(
      {},
      this.channel,
      { proof: this.channel.next_proof },
    );
    delete channel.next_proof;
    this.setChannel(channel);
  }

  /**
   * Reset the current channel balance.
   *
   * Used mainly when server replies a balance out-of-sync with current state
   * Caution: it sets the balance without verifying it. If possible, prefer
   * [[verifyProof]]
   *
   * @param value  Balance value to be set
   */
  setBalance(value: BigNumber): void {
    if (this.channel.proof.balance.eq(value)) {
      return;
    }
    const channel = Object.assign(
      {},
      this.channel,
      { proof: { balance: value }, next_proof: undefined },
    );
    delete channel.next_proof;
    this.setChannel(channel);
  }

  /**
   * Verify and set given proof as current, if valid
   *
   * Used mainly when server replies with an updated balance proof.
   *
   * @param proof  Balance proof, containing balance and sign
   * @returns  True if balance is valid and correct, false otherwise
   */
  verifyProof(proof: MicroProof): boolean {
    if (!proof.sign) {
      throw new Error('Proof must contain a signature and its respective balance');
    }
    const params: MsgParam[] = [
      {
        name: 'receiver',
        type: 'address',
        value: this.channel.receiver,
      },
      {
        name: 'block_created',
        type: 'uint32',
        value: '' + this.channel.block,
      },
      {
        name: 'balance',
        type: 'uint192',
        value: proof.balance.toString(),
      },
      {
        name: 'contract',
        type: 'address',
        value: this.contract.address,
      },
    ];
    let sign: string;
    const recovered = recoverTypedSignature({ data: params, sig: proof.sign });
    console.log('verify signTypedData =', params, sign, recovered);

    // recovered data from proof must be equal current account
    if (recovered !== this.channel.account) {
      return false;
    }

    const channel = Object.assign(
      {},
      this.channel,
      { proof, next_proof: undefined },
    );
    delete channel.next_proof;
    this.setChannel(channel);
    return true;
  }

  /**
   * For testing. Send 0.1 ETH to mint method of contract.
   * On TKN tests, it'll issue 50 TKNs to the sender's account.
   *
   * @param account  Sender's account address
   * @returns Promise to mint tx receipt
   */
  async buyToken(account: string): Promise<Web3.TransactionReceipt> {
    const txHash = await promisify<string>(this.token.mint, 'sendTransaction')({
      from: account,
      value: this.web3.toWei(0.1, 'ether')
    });
    console.log('mintTxHash', txHash);
    return await this.waitTx(txHash, 1);
  }

}
