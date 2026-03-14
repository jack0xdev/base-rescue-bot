// src/utils/checkBalances.js
// ─────────────────────────────────────────────────────────────────────────────
//  Pre-flight Balance Checker
//  Run BEFORE executing the rescue bundle to verify all wallets,
//  estimate total gas cost, and confirm safe wallet has enough ETH.
//
//  Usage:
//    node src/utils/checkBalances.js
// ─────────────────────────────────────────────────────────────────────────────

import "dotenv/config";
import { ethers } from "ethers";
import { config } from "../config.js";

const ERC20_ABI = [
  "function balanceOf(address owner) view returns (uint256)",
  "function decimals() view returns (uint8)",
  "function symbol() view returns (string)",
  "function name() view returns (string)",
];

const AIRDROP_ABI = [
  "function hasClaimed(address account) view returns (bool)",
];

const sep = "─".repeat(62);

async function main() {
  console.log("\n╔══════════════════════════════════════════════════════════╗");
  console.log("║           Pre-Flight Check — Base Rescue Bot             ║");
  console.log("╚══════════════════════════════════════════════════════════╝\n");

  const provider = new ethers.JsonRpcProvider(config.baseRpcUrl, config.chainId);

  // ── Network ───────────────────────────────────────────────────────────────
  const network  = await provider.getNetwork();
  const block    = await provider.getBlock("latest");
  const baseFee  = block.baseFeePerGas;

  console.log(`Network        : Base (chainId ${network.chainId})`);
  console.log(`Latest block   : #${block.number}`);
  console.log(`Base fee       : ${ethers.formatUnits(baseFee, "gwei")} gwei`);
  console.log(sep);

  // ── Wallets ───────────────────────────────────────────────────────────────
  const safeAddr   = new ethers.Wallet(config.safeWalletKey).address;
  const hackedAddr = new ethers.Wallet(config.hackedWalletKey).address;

  const [safeBal, hackedBal] = await Promise.all([
    provider.getBalance(safeAddr),
    provider.getBalance(hackedAddr),
  ]);

  console.log("WALLETS");
  console.log(`  Safe   : ${safeAddr}`);
  console.log(`           ${ethers.formatEther(safeBal)} ETH`);
  console.log(`  Hacked : ${hackedAddr}`);
  console.log(`           ${ethers.formatEther(hackedBal)} ETH`);
  console.log(sep);

  // ── Token ─────────────────────────────────────────────────────────────────
  let tokenSymbol  = "TOKEN";
  let tokenName    = "Unknown";
  let tokenDecimals = 18n;
  let hackedTokenBal = 0n;
  let safeTokenBal   = 0n;

  try {
    const token = new ethers.Contract(config.airdropTokenAddress, ERC20_ABI, provider);
    [tokenSymbol, tokenName, tokenDecimals, hackedTokenBal, safeTokenBal] = await Promise.all([
      token.symbol(),
      token.name(),
      token.decimals(),
      token.balanceOf(hackedAddr),
      token.balanceOf(safeAddr),
    ]);
    console.log("TOKEN");
    console.log(`  Contract : ${config.airdropTokenAddress}`);
    console.log(`  Name     : ${tokenName} (${tokenSymbol})`);
    console.log(`  Hacked wallet balance : ${ethers.formatUnits(hackedTokenBal, tokenDecimals)} ${tokenSymbol}`);
    console.log(`  Safe wallet balance   : ${ethers.formatUnits(safeTokenBal, tokenDecimals)} ${tokenSymbol}`);
  } catch (e) {
    console.log(`TOKEN      : Could not read (${e.message})`);
  }
  console.log(sep);

  // ── Airdrop contract ──────────────────────────────────────────────────────
  console.log("AIRDROP CONTRACT");
  console.log(`  Address : ${config.airdropContract}`);
  try {
    const airdrop = new ethers.Contract(config.airdropContract, AIRDROP_ABI, provider);
    const claimed = await airdrop.hasClaimed(hackedAddr);
    console.log(`  hasClaimed(hackedWallet) : ${claimed ? "⚠ ALREADY CLAIMED" : "✅ NOT YET CLAIMED — claimable!"}`);
  } catch {
    console.log(`  hasClaimed() : Function not found — check ABI / contract type`);
  }
  console.log(sep);

  // ── Gas estimate ──────────────────────────────────────────────────────────
  const priorityFee   = ethers.parseUnits(config.maxPriorityFeeGwei.toString(), "gwei");
  const bufferedBase  = (baseFee * BigInt(Math.round(config.baseFeeMultiplier * 100))) / 100n;
  const maxFee        = bufferedBase + priorityFee;

  const tx1Gas = 21000n;
  const tx2Gas = 250000n; // typical claim
  const tx3Gas = 80000n;  // typical ERC-20 transfer
  const totalGasUnits = tx1Gas + tx2Gas + tx3Gas;
  const estimatedCost = totalGasUnits * maxFee;
  const ethBuffer     = ethers.parseEther(config.ethGasBuffer);

  console.log("GAS ESTIMATE (approximate)");
  console.log(`  Effective maxFeePerGas : ${ethers.formatUnits(maxFee, "gwei")} gwei`);
  console.log(`  Tx1 (ETH send)         : ${tx1Gas.toLocaleString()} gas`);
  console.log(`  Tx2 (airdrop claim)    : ${tx2Gas.toLocaleString()} gas`);
  console.log(`  Tx3 (token transfer)   : ${tx3Gas.toLocaleString()} gas`);
  console.log(`  Total gas units        : ${totalGasUnits.toLocaleString()}`);
  console.log(`  Estimated total cost   : ${ethers.formatEther(estimatedCost)} ETH`);
  console.log(`  ETH_GAS_BUFFER config  : ${ethers.formatEther(ethBuffer)} ETH`);
  if (ethBuffer < estimatedCost) {
    console.log(`  ⚠ WARNING: ETH_GAS_BUFFER too low! Increase to at least ${ethers.formatEther(estimatedCost)} ETH`);
  } else {
    console.log(`  ✅ ETH_GAS_BUFFER sufficient`);
  }
  console.log(sep);

  // ── Safe wallet checks ────────────────────────────────────────────────────
  const totalNeeded = ethBuffer + (tx1Gas * maxFee); // Tx1 itself paid by safe wallet
  console.log("SAFE WALLET READINESS");
  if (safeBal >= totalNeeded) {
    console.log(`  ✅ Safe wallet has enough ETH for Tx1 + buffer`);
  } else {
    console.log(`  ✖ Safe wallet needs at least ${ethers.formatEther(totalNeeded)} ETH`);
    console.log(`    Current: ${ethers.formatEther(safeBal)} ETH — short by ${ethers.formatEther(totalNeeded - safeBal)} ETH`);
  }
  console.log(sep);

  // ── Relay ─────────────────────────────────────────────────────────────────
  console.log("RELAY");
  console.log(`  Endpoint : ${config.bundleRelayUrl}`);
  console.log(`  Chain ID : ${config.chainId}`);
  console.log(sep);
  console.log("\n✅ Pre-flight check complete. Run 'npm run simulate' next.\n");
}

main().catch((e) => { console.error("Error:", e.message); process.exit(1); });
