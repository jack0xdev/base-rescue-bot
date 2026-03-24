// watcher.js
// ============================================================
//  FeeWatcher — monitors hacked wallet ETH balance each block.
//  Resolves when balance >= MIN_ETH_TRIGGER, signaling the bot
//  to fire the rescue bundle in the next block.
//
//  Works with both ethers.JsonRpcProvider (HTTP polling) and
//  ethers.WebSocketProvider (eth_subscribe) — same .on("block")
//  API in ethers v6.
// ============================================================

import { ethers } from "ethers";
import { config } from "./config.js";
import { log } from "./logger.js";

export class FeeWatcher {
  /**
   * @param {ethers.JsonRpcProvider | ethers.WebSocketProvider} provider
   * @param {string} hackedAddress - Address to monitor for incoming ETH
   */
  constructor(provider, hackedAddress) {
    this.provider     = provider;
    this.hackedAddress = hackedAddress;
    this.minTrigger   = ethers.parseEther(config.minEthTrigger);
    this._handler     = null;
  }

  /**
   * Watches for ETH balance >= MIN_ETH_TRIGGER on every new block.
   * Resolves once with { triggerBlock, ethBalance } when threshold is met.
   * Single-fire — cleans up the block listener automatically on trigger.
   *
   * @returns {Promise<{ triggerBlock: number, ethBalance: bigint }>}
   */
  watchForFees() {
    log.info(
      `Watching hacked wallet ${this.hackedAddress} for ETH >= ` +
      `${ethers.formatEther(this.minTrigger)} ETH (every new block) …`
    );

    return new Promise((resolve, reject) => {
      const handler = async (blockNumber) => {
        try {
          const bal = await this._getBalance();
          log.info(
            `Block #${blockNumber} — hacked wallet ETH: ${ethers.formatEther(bal)} ` +
            `(need ${ethers.formatEther(this.minTrigger)})`
          );

          if (bal >= this.minTrigger) {
            this._cleanup();
            log.success(
              `Fee trigger! Block #${blockNumber} — ` +
              `${ethers.formatEther(bal)} ETH detected in hacked wallet`
            );
            resolve({ triggerBlock: blockNumber, ethBalance: bal });
          }
        } catch (err) {
          this._cleanup();
          reject(err);
        }
      };

      this._handler = handler;
      this.provider.on("block", handler);
    });
  }

  // ── Private helpers ──────────────────────────────────────────────────────────

  async _getBalance() {
    return this.provider.getBalance(this.hackedAddress);
  }

  _cleanup() {
    if (this._handler) {
      this.provider.off("block", this._handler);
      this._handler = null;
    }
  }
}
