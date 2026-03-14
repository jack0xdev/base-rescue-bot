// src/monitor.js
// Polls the airdrop contract to detect when a claim becomes available.

import { ethers } from "ethers";
import { log } from "./logger.js";
import { config } from "./config.js";

// Minimal ABIs — extend these to match your specific airdrop contract
const AIRDROP_ABI = [
  // Standard Merkle airdrop — hasClaimed(address) → bool
  "function hasClaimed(address account) view returns (bool)",
  // Alternative: isClaimed(uint256 index) → bool
  "function isClaimed(uint256 index) view returns (bool)",
  // ERC-20 balanceOf for token balance check
];

const ERC20_ABI = [
  "function balanceOf(address owner) view returns (uint256)",
  "function decimals() view returns (uint8)",
  "function symbol() view returns (string)",
];

export class AirdropMonitor {
  /**
   * @param {ethers.JsonRpcProvider} provider
   * @param {string} hackedAddress  - The compromised wallet address
   */
  constructor(provider, hackedAddress) {
    this.provider     = provider;
    this.hackedAddress = hackedAddress;

    this.airdropContract = new ethers.Contract(
      config.airdropContract,
      AIRDROP_ABI,
      provider
    );

    this.tokenContract = new ethers.Contract(
      config.airdropTokenAddress,
      ERC20_ABI,
      provider
    );
  }

  /**
   * Check if the airdrop is currently claimable (not yet claimed).
   * Tries multiple common patterns — adapt to your contract as needed.
   *
   * @returns {Promise<boolean>}
   */
  async isClaimable() {
    try {
      // Pattern 1: hasClaimed(address) — returns true if ALREADY claimed
      const claimed = await this.airdropContract.hasClaimed(this.hackedAddress);
      if (claimed) {
        log.warn("hasClaimed() returned true — airdrop already claimed.");
        return false;
      }
      log.success("hasClaimed() = false — airdrop is available to claim!");
      return true;
    } catch {
      // Pattern 1 not found, try pattern 2 or assume claimable
      log.warn("hasClaimed() not found on contract — assuming claimable. Verify manually!");
      return true;
    }
  }

  /**
   * Get the current ETH balance of the hacked wallet.
   * @returns {Promise<bigint>}
   */
  async getHackedWalletEthBalance() {
    return this.provider.getBalance(this.hackedAddress);
  }

  /**
   * Get the current token balance of the hacked wallet.
   * @returns {Promise<{ raw: bigint, formatted: string, symbol: string }>}
   */
  async getHackedWalletTokenBalance() {
    const [raw, decimals, symbol] = await Promise.all([
      this.tokenContract.balanceOf(this.hackedAddress),
      this.tokenContract.decimals().catch(() => 18n),
      this.tokenContract.symbol().catch(() => "TOKEN"),
    ]);
    return {
      raw,
      formatted: ethers.formatUnits(raw, decimals),
      symbol,
    };
  }

  /**
   * Blocking poll loop — resolves when the airdrop becomes claimable.
   * @returns {Promise<void>}
   */
  async waitUntilClaimable() {
    log.info(`Monitoring airdrop at ${config.airdropContract}`);
    log.info(`Polling every ${config.pollIntervalMs / 1000}s …`);

    while (true) {
      try {
        const claimable = await this.isClaimable();
        if (claimable) return;
        log.info("Not yet claimable — waiting for next poll …");
      } catch (err) {
        log.error("Monitor poll error:", err.message);
      }
      await sleep(config.pollIntervalMs);
    }
  }
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}
