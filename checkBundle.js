// src/utils/checkBundle.js
// ─────────────────────────────────────────────────────────────────────────────
//  Bundle Status Checker
//  After a rescue attempt, use this to verify all 3 transactions were included.
//
//  Usage:
//    node src/utils/checkBundle.js <tx1hash> <tx2hash> <tx3hash>
//    node src/utils/checkBundle.js 0xaaa... 0xbbb... 0xccc...
// ─────────────────────────────────────────────────────────────────────────────

import "dotenv/config";
import { ethers } from "ethers";
import { config } from "../config.js";

const ERC20_ABI = [
  "function balanceOf(address owner) view returns (uint256)",
  "function decimals() view returns (uint8)",
  "function symbol() view returns (string)",
];

async function main() {
  const [tx1, tx2, tx3] = process.argv.slice(2);

  if (!tx1) {
    console.log("Usage: node src/utils/checkBundle.js <tx1hash> [tx2hash] [tx3hash]");
    process.exit(1);
  }

  console.log("\n╔══════════════════════════════════════════════════════════╗");
  console.log("║         Bundle Status Checker — Base Rescue Bot          ║");
  console.log("╚══════════════════════════════════════════════════════════╝\n");

  const provider = new ethers.JsonRpcProvider(config.baseRpcUrl, config.chainId);
  const token    = new ethers.Contract(config.airdropTokenAddress, ERC20_ABI, provider);
  const safeAddr = new ethers.Wallet(config.safeWalletKey).address;
  const hackedAddr = new ethers.Wallet(config.hackedWalletKey).address;

  const hashes = [tx1, tx2, tx3].filter(Boolean);
  const labels = ["Tx1 (ETH fund)", "Tx2 (claim)", "Tx3 (token sweep)"];

  let allIncluded = true;
  let includedBlock = null;

  for (let i = 0; i < hashes.length; i++) {
    const hash    = hashes[i];
    const label   = labels[i];
    process.stdout.write(`Checking ${label} (${hash.slice(0, 10)}…) … `);

    try {
      const receipt = await provider.getTransactionReceipt(hash);
      if (!receipt) {
        console.log("⏳ Pending / not found");
        allIncluded = false;
      } else if (receipt.status === 1) {
        console.log(`✅ Confirmed in block #${receipt.blockNumber} | Gas used: ${receipt.gasUsed.toLocaleString()}`);
        if (!includedBlock) includedBlock = receipt.blockNumber;
        if (includedBlock !== receipt.blockNumber) {
          console.log(`   ⚠ WARNING: Different block! (${includedBlock} vs ${receipt.blockNumber}) — bundle may have been split.`);
        }
      } else {
        console.log(`✖  REVERTED in block #${receipt.blockNumber}`);
        allIncluded = false;
      }
    } catch (e) {
      console.log(`Error: ${e.message}`);
      allIncluded = false;
    }
  }

  console.log();

  // ── Final balances ─────────────────────────────────────────────────────────
  console.log("Current balances:");
  try {
    const [safeBal, hackedBal, safeTokenBal, hackedTokenBal, decimals, symbol] = await Promise.all([
      provider.getBalance(safeAddr),
      provider.getBalance(hackedAddr),
      token.balanceOf(safeAddr),
      token.balanceOf(hackedAddr),
      token.decimals(),
      token.symbol(),
    ]);
    console.log(`  Safe wallet   : ${ethers.formatEther(safeBal)} ETH | ${ethers.formatUnits(safeTokenBal, decimals)} ${symbol}`);
    console.log(`  Hacked wallet : ${ethers.formatEther(hackedBal)} ETH | ${ethers.formatUnits(hackedTokenBal, decimals)} ${symbol}`);

    if (hackedTokenBal > 0n) {
      console.log(`\n  ⚠  Hacked wallet still holds ${ethers.formatUnits(hackedTokenBal, decimals)} ${symbol} — sweep may not have completed!`);
    } else if (allIncluded) {
      console.log(`\n  🎉 Rescue complete! All tokens are in the safe wallet.`);
    }
  } catch (e) {
    console.log(`  Could not read token balances: ${e.message}`);
  }
}

main().catch((e) => { console.error("Fatal:", e.message); process.exit(1); });
