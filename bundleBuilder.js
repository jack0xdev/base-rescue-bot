// src/bundleBuilder.js
// Constructs, signs, and formats the 3-transaction rescue bundle.
//
// Bundle order (all same block):
//   Tx 1 — Safe Wallet  → Hacked Wallet   : ETH for gas
//   Tx 2 — Hacked Wallet → Airdrop Contract: claim()
//   Tx 3 — Hacked Wallet → Safe Wallet    : transfer all tokens

import { ethers } from "ethers";
import { config } from "./config.js";
import { log } from "./logger.js";
import { getAggressiveGasParams, estimateGasWithBuffer } from "./gasStrategy.js";

const ERC20_ABI = [
  "function balanceOf(address owner) view returns (uint256)",
  "function transfer(address to, uint256 amount) returns (bool)",
  "function decimals() view returns (uint8)",
  "function symbol() view returns (string)",
];

export class BundleBuilder {
  /**
   * @param {ethers.JsonRpcProvider} provider
   * @param {ethers.Wallet}          safeWallet
   * @param {ethers.Wallet}          hackedWallet
   */
  constructor(provider, safeWallet, hackedWallet) {
    this.provider      = provider;
    this.safeWallet    = safeWallet;
    this.hackedWallet  = hackedWallet;
    this.tokenContract = new ethers.Contract(
      config.airdropTokenAddress,
      ERC20_ABI,
      provider
    );
  }

  /**
   * Build and sign the full rescue bundle.
   * Returns an array of signed raw transactions ready for relay submission.
   *
   * @param {number} targetBlockNumber - Block to target for inclusion
   * @returns {Promise<{ signedTxs: string[], bundle: object }>}
   */
  async build(targetBlockNumber) {
    log.bundle(`Building rescue bundle for target block #${targetBlockNumber}`);

    // ── Fetch shared gas params ───────────────────────────────────────────────
    const gasParams = await getAggressiveGasParams(this.provider);
    const { maxFeePerGas, maxPriorityFeePerGas } = gasParams;

    // ── Fetch nonces ──────────────────────────────────────────────────────────
    const [safeNonce, hackedNonce] = await Promise.all([
      this.provider.getTransactionCount(this.safeWallet.address, "latest"),
      this.provider.getTransactionCount(this.hackedWallet.address, "latest"),
    ]);

    log.info(`Safe nonce: ${safeNonce} | Hacked nonce: ${hackedNonce}`);

    // ── TX 1: ETH from Safe → Hacked (gas funding) ───────────────────────────
    log.step(1, 3, "Building Tx1: fund hacked wallet with ETH for gas …");

    const ethToSend = ethers.parseEther(config.ethGasBuffer);

    // Estimate gas cost for Tx2 + Tx3 to verify the ETH buffer is sufficient
    const tx2GasEstimate = await this._estimateTx2Gas(maxFeePerGas);
    const tx3GasEstimate = await this._estimateTx3Gas(maxFeePerGas);
    const totalGasCost   = (tx2GasEstimate + tx3GasEstimate) * maxFeePerGas;

    log.info(
      `Estimated gas cost (Tx2+Tx3): ${ethers.formatEther(totalGasCost)} ETH | ` +
      `Sending: ${ethers.formatEther(ethToSend)} ETH`
    );

    if (ethToSend < totalGasCost) {
      log.warn(
        `⚠ ETH_GAS_BUFFER (${ethers.formatEther(ethToSend)}) may be insufficient ` +
        `for estimated gas (${ethers.formatEther(totalGasCost)}). Consider increasing ETH_GAS_BUFFER.`
      );
    }

    // Tx1 gas limit (simple ETH transfer)
    const tx1GasLimit = 21000n;

    const tx1 = {
      type:                 2,
      chainId:              config.chainId,
      nonce:                safeNonce,
      to:                   this.hackedWallet.address,
      value:                ethToSend,
      gasLimit:             tx1GasLimit,
      maxFeePerGas,
      maxPriorityFeePerGas,
      data:                 "0x",
    };

    // ── TX 2: Claim airdrop from Hacked Wallet ────────────────────────────────
    log.step(2, 3, "Building Tx2: claim airdrop from hacked wallet …");

    const tx2 = {
      type:                 2,
      chainId:              config.chainId,
      nonce:                hackedNonce,
      to:                   config.airdropContract,
      value:                0n,
      gasLimit:             tx2GasEstimate,
      maxFeePerGas,
      maxPriorityFeePerGas,
      data:                 config.airdropClaimCalldata,
    };

    // ── TX 3: Transfer tokens from Hacked → Safe wallet ───────────────────────
    log.step(3, 3, "Building Tx3: sweep tokens to safe wallet …");

    // NOTE: balanceOf is checked BEFORE the bundle executes.
    // After Tx2 claims, the balance will be higher. We use type(uint256).max
    // pattern or re-estimate. For safety, we build a "transfer all" call
    // using the current known balance OR a large placeholder that fits.
    // If the contract supports transferring the exact post-claim amount,
    // consider using a custom rescue contract for atomicity.
    const currentBalance = await this.tokenContract.balanceOf(this.hackedWallet.address);

    // If tokens are already in the hacked wallet (unlikely pre-claim), use that.
    // Otherwise, we'll encode the transfer with a safe large value; the contract
    // will revert if insufficient — which is acceptable since the bundle is atomic.
    // BEST PRACTICE: use a helper smart contract for Tx2+Tx3 atomically.
    const tokenDecimals = await this.tokenContract.decimals().catch(() => 18n);
    const tokenSymbol   = await this.tokenContract.symbol().catch(() => "TOKEN");

    log.info(`Current hacked wallet ${tokenSymbol} balance: ${ethers.formatUnits(currentBalance, tokenDecimals)}`);

    // Encode transfer(safeWallet, balance)
    // If balance is 0 (pre-claim), use EXPECTED_AIRDROP_AMOUNT from config.
    const expectedAmount = config.expectedAirdropAmount
      ? ethers.parseUnits(config.expectedAirdropAmount, tokenDecimals)
      : null;

    if (currentBalance === 0n && !expectedAmount) {
      throw new Error(
        "Token balance is 0 and EXPECTED_AIRDROP_AMOUNT is not set. " +
        "Set EXPECTED_AIRDROP_AMOUNT in .env to the exact token amount you will claim."
      );
    }

    const transferAmount = currentBalance > 0n ? currentBalance : expectedAmount;

    const transferCalldata = this.tokenContract.interface.encodeFunctionData(
      "transfer",
      [this.safeWallet.address, transferAmount]
    );

    const tx3 = {
      type:                 2,
      chainId:              config.chainId,
      nonce:                hackedNonce + 1,   // Sequential after Tx2
      to:                   config.airdropTokenAddress,
      value:                0n,
      gasLimit:             tx3GasEstimate,
      maxFeePerGas,
      maxPriorityFeePerGas,
      data:                 transferCalldata,
    };

    // ── Sign all transactions ─────────────────────────────────────────────────
    log.bundle("Signing transactions …");
    const [signedTx1, signedTx2, signedTx3] = await Promise.all([
      this.safeWallet.signTransaction(tx1),
      this.hackedWallet.signTransaction(tx2),
      this.hackedWallet.signTransaction(tx3),
    ]);

    const signedTxs = [signedTx1, signedTx2, signedTx3];

    log.success("Bundle signed successfully:");
    log.info(`  Tx1 (ETH fund)    → from: ${this.safeWallet.address}`);
    log.info(`  Tx2 (claim)       → to:   ${config.airdropContract}`);
    log.info(`  Tx3 (token sweep) → to:   ${this.safeWallet.address}`);

    return {
      signedTxs,
      bundle: {
        txs: [tx1, tx2, tx3],
        targetBlockNumber,
        gasParams,
      },
    };
  }

  /**
   * Build a rescue-only bundle for watch mode.
   * Does NOT include Tx1 (ETH fund) — ETH is assumed to already be in hacked wallet.
   *
   * Bundle order (all same block):
   *   [Optional] Tx A — Hacked Wallet → Airdrop Contract : claim()
   *              Tx B — Hacked Wallet → Safe Wallet       : transfer all tokens
   *
   * @param {number}  targetBlockNumber
   * @param {object}  [opts]
   * @param {boolean} [opts.includeAirdropClaim=true] - Set false to skip claim tx
   * @returns {Promise<{ signedTxs: string[], bundle: object }>}
   */
  async buildRescueOnly(targetBlockNumber, opts = { includeAirdropClaim: true }) {
    const includeAirdropClaim = opts.includeAirdropClaim !== false;
    log.bundle(
      `Building rescue-only bundle for block #${targetBlockNumber} ` +
      `(airdropClaim: ${includeAirdropClaim})`
    );

    // ── Gas params ────────────────────────────────────────────────────────────
    const gasParams = await getAggressiveGasParams(this.provider);
    const { maxFeePerGas, maxPriorityFeePerGas } = gasParams;

    // ── Nonce — only hacked wallet needed ─────────────────────────────────────
    const hackedNonce = await this.provider.getTransactionCount(
      this.hackedWallet.address,
      "latest"
    );
    log.info(`Hacked nonce: ${hackedNonce}`);

    // ── Check token balance (guard against false trigger) ─────────────────────
    const tokenDecimals = await this.tokenContract.decimals().catch(() => 18n);
    const tokenSymbol   = await this.tokenContract.symbol().catch(() => "TOKEN");
    const currentBalance = await this.tokenContract.balanceOf(this.hackedWallet.address);

    log.info(
      `Hacked wallet ${tokenSymbol} balance: ` +
      `${ethers.formatUnits(currentBalance, tokenDecimals)}`
    );

    const signedTxs = [];
    const txObjects  = [];
    let   nextNonce  = hackedNonce;

    // ── TX A (optional): Claim airdrop ────────────────────────────────────────
    if (includeAirdropClaim) {
      log.step(1, 2, "Building claim tx (Hacked → Airdrop contract) …");
      const claimGas = await this._estimateTx2Gas(maxFeePerGas);

      const txClaim = {
        type:                 2,
        chainId:              config.chainId,
        nonce:                nextNonce,
        to:                   config.airdropContract,
        value:                0n,
        gasLimit:             claimGas,
        maxFeePerGas,
        maxPriorityFeePerGas,
        data:                 config.airdropClaimCalldata,
      };

      const signedClaim = await this.hackedWallet.signTransaction(txClaim);
      signedTxs.push(signedClaim);
      txObjects.push(txClaim);
      nextNonce += 1;
    }

    // ── TX B: Sweep tokens to safe wallet ─────────────────────────────────────
    log.step(includeAirdropClaim ? 2 : 1, includeAirdropClaim ? 2 : 1, "Building sweep tx (Hacked → Safe wallet) …");

    const sweepGas = await this._estimateTx3Gas(maxFeePerGas);

    // If tokens are already in wallet use that; else use EXPECTED_AIRDROP_AMOUNT
    const expectedAmount = config.expectedAirdropAmount
      ? ethers.parseUnits(config.expectedAirdropAmount, tokenDecimals)
      : null;

    if (currentBalance === 0n && !expectedAmount) {
      throw new Error(
        "Token balance is 0 and EXPECTED_AIRDROP_AMOUNT is not set. " +
        "Set EXPECTED_AIRDROP_AMOUNT in .env to the exact token amount you will claim."
      );
    }

    const transferAmount = currentBalance > 0n ? currentBalance : expectedAmount;

    if (currentBalance === 0n) {
      log.info(
        `Token balance is 0 — using EXPECTED_AIRDROP_AMOUNT: ${config.expectedAirdropAmount} ${tokenSymbol}`
      );
    }

    const transferCalldata = this.tokenContract.interface.encodeFunctionData(
      "transfer",
      [this.safeWallet.address, transferAmount]
    );

    const txSweep = {
      type:                 2,
      chainId:              config.chainId,
      nonce:                nextNonce,
      to:                   config.airdropTokenAddress,
      value:                0n,
      gasLimit:             sweepGas,
      maxFeePerGas,
      maxPriorityFeePerGas,
      data:                 transferCalldata,
    };

    const signedSweep = await this.hackedWallet.signTransaction(txSweep);
    signedTxs.push(signedSweep);
    txObjects.push(txSweep);

    log.success("Rescue-only bundle signed:");
    if (includeAirdropClaim) {
      log.info(`  TxA (claim) → to: ${config.airdropContract}`);
    }
    log.info(`  TxB (sweep) → to: ${this.safeWallet.address}`);

    return {
      signedTxs,
      bundle: {
        txs: txObjects,
        targetBlockNumber,
        gasParams,
      },
    };
  }

  // ── Private helpers ──────────────────────────────────────────────────────────

  async _estimateTx2Gas(maxFeePerGas) {
    try {
      const est = await estimateGasWithBuffer(this.provider, {
        from: this.hackedWallet.address,
        to:   config.airdropContract,
        data: config.airdropClaimCalldata,
      });
      return est;
    } catch {
      log.warn("Could not estimate Tx2 gas — using fallback 250,000");
      return 250000n;
    }
  }

  async _estimateTx3Gas(maxFeePerGas) {
    try {
      const est = await estimateGasWithBuffer(this.provider, {
        from: this.hackedWallet.address,
        to:   config.airdropTokenAddress,
        data: this.tokenContract.interface.encodeFunctionData("transfer", [
          this.safeWallet.address,
          1n, // dummy amount for estimation
        ]),
      });
      return est;
    } catch {
      log.warn("Could not estimate Tx3 gas — using fallback 80,000");
      return 80000n;
    }
  }
}
