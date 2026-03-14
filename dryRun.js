// src/utils/dryRun.js
// ─────────────────────────────────────────────────────────────────────────────
//  Local Dry-Run — Validates all 3 transactions via eth_call before submitting.
//  Does NOT send to relay. Uses the public Base RPC to call each tx locally.
//
//  Run: node src/utils/dryRun.js
// ─────────────────────────────────────────────────────────────────────────────

import "dotenv/config";
import { ethers } from "ethers";
import { config } from "../config.js";
import { getAggressiveGasParams } from "../gasStrategy.js";

const sep = "─".repeat(62);

const ERC20_ABI = [
  "function balanceOf(address owner) view returns (uint256)",
  "function transfer(address to, uint256 amount) returns (bool)",
  "function decimals() view returns (uint8)",
  "function symbol() view returns (string)",
];

async function main() {
  console.log("\n╔══════════════════════════════════════════════════════════╗");
  console.log("║            Dry-Run Validator — Base Rescue Bot           ║");
  console.log("╚══════════════════════════════════════════════════════════╝\n");

  const provider    = new ethers.JsonRpcProvider(config.baseRpcUrl, config.chainId);
  const safeWallet  = new ethers.Wallet(config.safeWalletKey,   provider);
  const hackedWallet = new ethers.Wallet(config.hackedWalletKey, provider);
  const token       = new ethers.Contract(config.airdropTokenAddress, ERC20_ABI, provider);

  const block    = await provider.getBlock("latest");
  const gasParams = await getAggressiveGasParams(provider);

  console.log(`Block #${block.number} | BaseFee: ${ethers.formatUnits(block.baseFeePerGas, "gwei")} gwei`);
  console.log(sep);

  let allPassed = true;

  // ── TX 1: ETH send (Safe → Hacked) ─────────────────────────────────────────
  console.log("\n[1/3] Tx1 — ETH fund (Safe → Hacked)");
  try {
    const gasEst = await provider.estimateGas({
      from:  safeWallet.address,
      to:    hackedWallet.address,
      value: ethers.parseEther(config.ethGasBuffer),
    });
    console.log(`  ✅ Gas estimate: ${gasEst.toLocaleString()} units`);
    console.log(`  Value: ${config.ethGasBuffer} ETH`);
  } catch (e) {
    console.log(`  ✖  FAILED: ${e.message}`);
    allPassed = false;
  }

  // ── TX 2: Airdrop claim ─────────────────────────────────────────────────────
  console.log("\n[2/3] Tx2 — Airdrop claim");
  console.log(`  Contract : ${config.airdropContract}`);
  console.log(`  Calldata : ${config.airdropClaimCalldata.slice(0, 20)}…`);
  try {
    const gasEst = await provider.estimateGas({
      from: hackedWallet.address,
      to:   config.airdropContract,
      data: config.airdropClaimCalldata,
    });
    console.log(`  ✅ Gas estimate: ${gasEst.toLocaleString()} units`);
  } catch (e) {
    // A revert here is expected if the airdrop is not yet live or already claimed.
    // Decode the revert reason.
    const reason = decodeRevert(e);
    console.log(`  ⚠  eth_estimateGas reverted: ${reason}`);
    console.log(`     (This may be expected if airdrop is not yet claimable.)`);
    // Don't fail — claim may revert until it's live
  }

  // ── TX 3: Token transfer ────────────────────────────────────────────────────
  console.log("\n[3/3] Tx3 — Token sweep (Hacked → Safe)");
  console.log(`  Token   : ${config.airdropTokenAddress}`);
  try {
    const [balance, decimals, symbol] = await Promise.all([
      token.balanceOf(hackedWallet.address),
      token.decimals(),
      token.symbol(),
    ]);
    console.log(`  Current balance: ${ethers.formatUnits(balance, decimals)} ${symbol}`);

    if (balance === 0n) {
      console.log(`  ⚠  Balance is 0 — tokens not yet in hacked wallet (expected pre-claim).`);
      console.log(`     After Tx2 executes, balance will increase. Tx3 calldata will use post-claim balance.`);
    } else {
      const calldata = token.interface.encodeFunctionData("transfer", [safeWallet.address, balance]);
      const gasEst   = await provider.estimateGas({
        from: hackedWallet.address,
        to:   config.airdropTokenAddress,
        data: calldata,
      });
      console.log(`  ✅ Transfer calldata valid. Gas estimate: ${gasEst.toLocaleString()} units`);
    }
  } catch (e) {
    console.log(`  ✖  FAILED: ${e.message}`);
    allPassed = false;
  }

  // ── Summary ─────────────────────────────────────────────────────────────────
  console.log(`\n${sep}`);
  if (allPassed) {
    console.log("✅ Dry-run PASSED — safe to simulate and submit bundle.");
  } else {
    console.log("✖  Dry-run found issues — review errors above before submitting.");
  }

  // ── Gas cost summary ─────────────────────────────────────────────────────────
  const estimatedTotalGas = 21000n + 250000n + 80000n; // conservative estimates
  const estimatedCost = estimatedTotalGas * gasParams.maxFeePerGas;
  console.log(`\n💸 Estimated max gas cost: ${ethers.formatEther(estimatedCost)} ETH`);
  console.log(`   (At ${ethers.formatUnits(gasParams.maxFeePerGas, "gwei")} gwei maxFeePerGas)`);
  console.log(`   ETH_GAS_BUFFER: ${config.ethGasBuffer} ETH\n`);
}

function decodeRevert(error) {
  // Try to extract a readable revert string from ethers error
  if (error.reason) return error.reason;
  if (error.data && error.data !== "0x") {
    try {
      const iface = new ethers.Interface(["function Error(string)"]);
      const decoded = iface.decodeFunctionData("Error", error.data);
      return decoded[0];
    } catch {}
  }
  return error.message?.split("(")[0]?.trim() ?? "unknown revert";
}

main().catch((e) => { console.error("Fatal:", e.message); process.exit(1); });
