// src/relaySubmitter.js
// Submits signed transaction bundles to the private relay (Flashbots / Titanium / etc.)
// Uses eth_sendBundle RPC method standard.

import { ethers } from "ethers";
import { config } from "./config.js";
import { log } from "./logger.js";

/**
 * Computes the keccak256 hash of a raw signed transaction (the bundle tx hash).
 */
function txHash(signedTx) {
  return ethers.keccak256(signedTx);
}

export class RelaySubmitter {
  /**
   * @param {ethers.JsonRpcProvider} provider  - Standard Base RPC (for block watching)
   * @param {ethers.Wallet}          authSigner - Used to sign Flashbots payloads
   */
  constructor(provider, authSigner) {
    this.provider    = provider;
    this.authSigner  = authSigner;
    this.relayUrl    = config.bundleRelayUrl;
  }

  /**
   * Submit a bundle to the private relay.
   * Retries across multiple blocks until included or max attempts reached.
   *
   * @param {string[]} signedTxs        - Array of signed raw transactions
   * @param {number}   targetBlockNumber - First block to target
   * @returns {Promise<{ success: boolean, txHashes: string[] }>}
   */
  async submitAndWait(signedTxs, targetBlockNumber) {
    const txHashes = signedTxs.map(txHash);
    log.bundle(`Bundle tx hashes:`);
    txHashes.forEach((h, i) => log.info(`  Tx${i + 1}: ${h}`));

    for (let attempt = 1; attempt <= config.maxBundleAttempts; attempt++) {
      const blockTarget = targetBlockNumber + attempt - 1;
      log.bundle(`Attempt ${attempt}/${config.maxBundleAttempts} — targeting block #${blockTarget}`);

      try {
        await this._sendBundle(signedTxs, blockTarget);
        log.success(`Bundle submitted to relay for block #${blockTarget}`);
      } catch (err) {
        log.error(`Relay submission failed: ${err.message}`);
        continue;
      }

      // Wait for the target block to be mined, then check inclusion
      const included = await this._waitForInclusion(txHashes[0], blockTarget);
      if (included) {
        log.success(`🎉 Bundle INCLUDED in block #${blockTarget}!`);
        return { success: true, txHashes };
      }

      log.warn(`Bundle not included in block #${blockTarget} — retrying …`);
    }

    log.error(`Bundle failed after ${config.maxBundleAttempts} attempts.`);
    return { success: false, txHashes };
  }

  // ── Private methods ──────────────────────────────────────────────────────────

  /**
   * Send eth_sendBundle to the relay.
   * Signs the payload with the Flashbots auth key (X-Flashbots-Signature header).
   */
  async _sendBundle(signedTxs, blockNumber) {
    const body = {
      jsonrpc: "2.0",
      id:      1,
      method:  "eth_sendBundle",
      params:  [
        {
          txs:         signedTxs,
          blockNumber: ethers.toBeHex(blockNumber),
          // minTimestamp / maxTimestamp optional for time-gating
        },
      ],
    };

    const bodyStr    = JSON.stringify(body);
    const bodyHash   = ethers.id(bodyStr); // keccak256 of the body
    const signature  = await this.authSigner.signMessage(
      ethers.getBytes(bodyHash)
    );
    const authHeader = `${this.authSigner.address}:${signature}`;

    const headers = {
      "Content-Type":         "application/json",
      "X-Flashbots-Signature": authHeader,
    };

    // Add BloXroute API key if configured
    if (config.bloxrouteApiKey) {
      headers["Authorization"] = config.bloxrouteApiKey;
    }

    const res = await fetch(this.relayUrl, {
      method:  "POST",
      headers,
      body:    bodyStr,
    });

    const json = await res.json();

    if (json.error) {
      throw new Error(`Relay error: ${json.error.message ?? JSON.stringify(json.error)}`);
    }

    log.info(`Relay response: ${JSON.stringify(json.result ?? json)}`);
    return json;
  }

  /**
   * Wait for the target block to be mined, then check if Tx1 was included.
   */
  async _waitForInclusion(firstTxHash, targetBlock) {
    // Poll until we reach or pass the target block
    while (true) {
      const currentBlock = await this.provider.getBlockNumber();
      if (currentBlock >= targetBlock) break;
      log.info(`Current block: #${currentBlock} — waiting for #${targetBlock} …`);
      await sleep(2000);
    }

    // Check if the first tx landed on-chain
    try {
      const receipt = await this.provider.getTransactionReceipt(firstTxHash);
      if (receipt && receipt.blockNumber !== null) {
        log.success(`Tx confirmed in block #${receipt.blockNumber}`);
        return true;
      }
    } catch {
      // tx not found = not included
    }

    return false;
  }

  /**
   * Simulate the bundle locally using eth_callBundle (supported by some relays).
   * Useful for dry-run testing before live submission.
   */
  async simulate(signedTxs, blockNumber) {
    log.bundle("Running bundle simulation via eth_callBundle …");

    const body = {
      jsonrpc: "2.0",
      id:      1,
      method:  "eth_callBundle",
      params:  [
        {
          txs:          signedTxs,
          blockNumber:  ethers.toBeHex(blockNumber),
          stateBlockNumber: "latest",
        },
      ],
    };

    const bodyStr   = JSON.stringify(body);
    const bodyHash  = ethers.id(bodyStr);
    const signature = await this.authSigner.signMessage(ethers.getBytes(bodyHash));
    const authHeader = `${this.authSigner.address}:${signature}`;

    const res = await fetch(this.relayUrl, {
      method:  "POST",
      headers: {
        "Content-Type":          "application/json",
        "X-Flashbots-Signature": authHeader,
      },
      body: bodyStr,
    });

    const json = await res.json();

    if (json.error) {
      throw new Error(`Simulation error: ${json.error.message}`);
    }

    return json.result;
  }
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}
