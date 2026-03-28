// src/bot.js
// ============================================================
//  BASE RESCUE BOT — Main Entry Point
//  Rescues airdropped tokens from a compromised wallet using
//  a private Flashbots-style bundle on Base chain.
// ============================================================

import { ethers } from "ethers";
import { config } from "./config.js";
import { log } from "./logger.js";
import { AirdropMonitor } from "./monitor.js";
import { BundleBuilder } from "./bundleBuilder.js";
import { RelaySubmitter } from "./relaySubmitter.js";

// ── CLI flags ──────────────────────────────────────────────────────────────────
const SIMULATE_ONLY  = process.argv.includes("--simulate");
const MONITOR_ONLY   = process.argv.includes("--monitor-only");

// ══════════════════════════════════════════════════════════════════════════════
//  Main
// ══════════════════════════════════════════════════════════════════════════════
async function main() {
  printBanner();

  // ── Setup provider & wallets ───────────────────────────────────────────────
  log.info(`Connecting to Base RPC: ${config.baseRpcUrl}`);
  const provider = new ethers.JsonRpcProvider(config.baseRpcUrl, config.chainId);

  const network = await provider.getNetwork();
  log.success(`Connected — chainId: ${network.chainId}`);

  const safeWallet   = new ethers.Wallet(config.safeWalletKey,   provider);
  const hackedWallet = new ethers.Wallet(config.hackedWalletKey, provider);

  // Sponsor fees wallet: dedicated wallet that funds gas for the hacked wallet (Tx1).
  // Using a separate wallet means the safe (token destination) wallet is never the gas payer,
  // limiting blast radius if any key is exposed.
  const sponsorWallet = config.sponsorFeesWalletKey
    ? new ethers.Wallet(config.sponsorFeesWalletKey, provider)
    : safeWallet;

  // The auth signer is used to sign relay payloads (can be the safe wallet or a separate key)
  const authSigner = safeWallet;

  log.info(`Safe   wallet : ${safeWallet.address}`);
  log.info(`Hacked wallet : ${hackedWallet.address}`);
  if (sponsorWallet.address !== safeWallet.address) {
    log.info(`Sponsor wallet: ${sponsorWallet.address} [dedicated gas sponsor]`);
  } else {
    log.info(`Sponsor wallet: ${safeWallet.address} [same as safe wallet — set SPONSOR_FEES_WALLET_PRIVATE_KEY to separate]`);
  }
  log.info(`Relay         : ${config.bundleRelayUrl}`);
  log.info(`Chain ID      : ${config.chainId}`);

  // ── Print balances ─────────────────────────────────────────────────────────
  await printBalances(provider, safeWallet.address, hackedWallet.address, sponsorWallet.address);

  // ── Monitor-only mode ──────────────────────────────────────────────────────
  if (MONITOR_ONLY) {
    log.info("Running in MONITOR-ONLY mode. No transactions will be sent.");
    const monitor = new AirdropMonitor(provider, hackedWallet.address);
    await monitor.waitUntilClaimable();
    log.success("Airdrop is claimable! Re-run without --monitor-only to execute rescue.");
    return;
  }

  // ── Setup modules ──────────────────────────────────────────────────────────
  const monitor   = new AirdropMonitor(provider, hackedWallet.address);
  const builder   = new BundleBuilder(provider, safeWallet, hackedWallet, sponsorWallet);
  const submitter = new RelaySubmitter(provider, authSigner);

  // ── Wait for claimable ─────────────────────────────────────────────────────
  log.info("Starting monitoring loop …");
  await monitor.waitUntilClaimable();
  log.success("✅ Airdrop is CLAIMABLE — initiating rescue sequence!");

  // ── Build bundle ───────────────────────────────────────────────────────────
  const currentBlock = await provider.getBlockNumber();
  const targetBlock  = currentBlock + config.blocksAheadTarget;

  log.bundle(`Current block: #${currentBlock} | Target block: #${targetBlock}`);

  const { signedTxs, bundle } = await builder.build(targetBlock);

  // ── Simulate first ─────────────────────────────────────────────────────────
  log.bundle("Simulating bundle before submission …");
  try {
    const simResult = await submitter.simulate(signedTxs, targetBlock);
    log.success("Simulation passed!");
    logSimulationResult(simResult);
  } catch (err) {
    log.error(`Simulation FAILED: ${err.message}`);
    log.warn("Bundle simulation failed — this bundle may revert on-chain.");
    log.warn("Inspect your airdrop contract ABI and claim calldata.");

    if (!SIMULATE_ONLY) {
      log.warn("Proceeding with live submission anyway (check your config carefully!) …");
    }
  }

  if (SIMULATE_ONLY) {
    log.info("--simulate flag set. Stopping after simulation. No bundle submitted.");
    return;
  }

  // ── Submit bundle ──────────────────────────────────────────────────────────
  log.bundle("Submitting rescue bundle to private relay …");
  const result = await submitter.submitAndWait(signedTxs, targetBlock);

  if (result.success) {
    log.success("🎉 RESCUE COMPLETE!");
    log.success("Transaction hashes:");
    result.txHashes.forEach((h, i) => log.success(`  Tx${i + 1}: ${h}`));

    // Final balance check
    await printBalances(provider, safeWallet.address, hackedWallet.address, sponsorWallet.address);
  } else {
    log.error("Rescue bundle failed after all attempts.");
    log.error("Possible causes:");
    log.error("  • Relay rejected the bundle (gas too low, invalid calldata)");
    log.error("  • Airdrop claim calldata incorrect for your wallet/index/proof");
    log.error("  • Hacked wallet was front-run (mempool exposure elsewhere)");
    log.error("  • Relay endpoint not supporting Base chain");
    process.exit(1);
  }
}

// ══════════════════════════════════════════════════════════════════════════════
//  Helpers
// ══════════════════════════════════════════════════════════════════════════════

async function printBalances(provider, safeAddr, hackedAddr, sponsorAddr) {
  const isSponsorSafe = sponsorAddr === safeAddr;
  const addresses = isSponsorSafe
    ? [safeAddr, hackedAddr]
    : [safeAddr, hackedAddr, sponsorAddr];

  const bals = await Promise.all(addresses.map((a) => provider.getBalance(a)));

  if (isSponsorSafe) {
    log.info(`Balances — Safe: ${ethers.formatEther(bals[0])} ETH | Hacked: ${ethers.formatEther(bals[1])} ETH`);
  } else {
    log.info(
      `Balances — Safe: ${ethers.formatEther(bals[0])} ETH | ` +
      `Hacked: ${ethers.formatEther(bals[1])} ETH | ` +
      `Sponsor: ${ethers.formatEther(bals[2])} ETH`
    );
  }
}

function logSimulationResult(simResult) {
  if (!simResult) return;
  try {
    if (Array.isArray(simResult.results)) {
      simResult.results.forEach((r, i) => {
        if (r.error) {
          log.error(`  Tx${i + 1} sim error: ${r.error} | reason: ${r.revert ?? "unknown"}`);
        } else {
          log.success(`  Tx${i + 1} sim OK — gasUsed: ${r.gasUsed}`);
        }
      });
    }
    if (simResult.bundleGasPrice) {
      log.info(`  Effective bundle gas price: ${ethers.formatUnits(simResult.bundleGasPrice, "gwei")} gwei`);
    }
  } catch {
    log.info(`  Sim result: ${JSON.stringify(simResult)}`);
  }
}

function printBanner() {
  console.log(`
╔══════════════════════════════════════════════════════════╗
║           BASE CHAIN RESCUE BOT  ⚡ Flashbots           ║
║   Private bundle — atomic — no mempool — anti front-run  ║
╚══════════════════════════════════════════════════════════╝
`);
}

// ── Run ────────────────────────────────────────────────────────────────────────
main().catch((err) => {
  log.error("Fatal error:", err.message);
  if (process.env.DEBUG) console.error(err);
  process.exit(1);
});
