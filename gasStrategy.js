// src/gasStrategy.js
// Fetches current Base gas data and computes high-priority EIP-1559 fees

import { ethers } from "ethers";
import { config } from "./config.js";
import { log } from "./logger.js";

/**
 * Returns EIP-1559 gas params that aggressively target next-block inclusion.
 * @param {ethers.JsonRpcProvider} provider
 * @returns {{ maxFeePerGas: bigint, maxPriorityFeePerGas: bigint, gasBaseFee: bigint }}
 */
export async function getAggressiveGasParams(provider) {
  const block = await provider.getBlock("latest");
  if (!block?.baseFeePerGas) {
    throw new Error("Could not read baseFeePerGas from latest block — is this an EIP-1559 chain?");
  }

  const baseFee = block.baseFeePerGas; // bigint, in wei

  // Apply multiplier to base fee for buffer (e.g. 1.5x)
  const multiplierBps = BigInt(Math.round(config.baseFeeMultiplier * 100));
  const bufferedBase = (baseFee * multiplierBps) / 100n;

  // Priority fee (tip) — flat value from config
  const priorityFee = ethers.parseUnits(config.maxPriorityFeeGwei.toString(), "gwei");

  // maxFeePerGas = bufferedBase + priorityFee (EIP-1559 formula)
  const maxFee = bufferedBase + priorityFee;

  // Hard cap from config
  const maxFeeCap = ethers.parseUnits(config.maxFeeGwei.toString(), "gwei");
  const finalMaxFee = maxFee > maxFeeCap ? maxFeeCap : maxFee;

  log.info(
    `Gas params — baseFee: ${ethers.formatUnits(baseFee, "gwei")} gwei | ` +
    `priority: ${ethers.formatUnits(priorityFee, "gwei")} gwei | ` +
    `maxFee: ${ethers.formatUnits(finalMaxFee, "gwei")} gwei`
  );

  return {
    maxFeePerGas:         finalMaxFee,
    maxPriorityFeePerGas: priorityFee,
    gasBaseFee:           baseFee,
  };
}

/**
 * Estimate gas for a raw transaction object.
 * Adds a 20% safety buffer on top of the estimate.
 */
export async function estimateGasWithBuffer(provider, txRequest, bufferPct = 120n) {
  const estimate = await provider.estimateGas(txRequest);
  return (estimate * bufferPct) / 100n;
}
