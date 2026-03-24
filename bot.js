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
import { FeeWatcher } from "./watcher.js";

// ── CLI flags ──────────────────────────────────────────────────────────────────
const SIMULATE_ONLY  = process.argv.includes("--simulate");
const MONITOR_ONLY   = process.argv.includes("--monitor-only");
const WATCH_MODE     = process.argv.includes("--watch");

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

  // The auth signer is used to sign relay payloads (can be the safe wallet or a separate key)
  const authSigner = safeWallet;

  log.info(`Safe   wallet : ${safeWallet.address}`);
  log.info(`Hacked wallet : ${hackedWallet.address}`);
  log.info(`Relay         : ${config.bundleRelayUrl}`);
  log.info(`Chain ID      : ${config.chainId}`);

  // ── Print balances ─────────────────────────────────────────────────────────
  await printBalances(provider, safeWallet.address, hackedWallet.address);

  // ── Watch mode ─────────────────────────────────────────────────────────────
  if (WATCH_MODE) {
    await runWatchMode(provider, safeWallet, hackedWallet, authSigner);
    return;
  }

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
  const builder   = new BundleBuilder(provider, safeWallet, hackedWallet);
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
    await printBalances(provider, safeWallet.address, hackedWallet.address);
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
//  Watch Mode
// ══════════════════════════════════════════════════════════════════════════════

/**
 * Watch mode flow:
 *   1. Monitor hacked wallet ETH balance every new block
 *   2. When ETH >= MIN_ETH_TRIGGER → build rescue-only bundle (no ETH fund tx)
 *   3. Target triggerBlock + 1 (next block) for atomic inclusion
 *   4. Simulate → submit to private relay
 */
async function runWatchMode(provider, safeWallet, hackedWallet, authSigner) {
  log.info("Running in WATCH mode — waiting for ETH fees to arrive in hacked wallet …");
  log.info(`Min ETH trigger: ${config.minEthTrigger} ETH`);

  // ── Setup watch provider (WS if available, HTTP fallback) ──────────────────
  let watchProvider = provider;
  if (config.wsRpcUrl) {
    log.info(`Connecting WebSocket provider: ${config.wsRpcUrl}`);
    try {
      watchProvider = new ethers.WebSocketProvider(config.wsRpcUrl, config.chainId);
      // Surface WS errors without crashing — fall back to HTTP on failure
      watchProvider.websocket.on?.("error", (err) => {
        log.warn(`WebSocket error: ${err.message} — falling back to HTTP polling`);
        watchProvider = provider;
      });
    } catch (err) {
      log.warn(`WebSocket init failed (${err.message}) — using HTTP polling`);
      watchProvider = provider;
    }
  } else {
    log.warn("WS_RPC_URL not set — using HTTP polling for block events (~2s per block)");
  }

  // ── Start watching ─────────────────────────────────────────────────────────
  const watcher = new FeeWatcher(watchProvider, hackedWallet.address);
  const { triggerBlock, ethBalance } = await watcher.watchForFees();

  log.bundle(
    `Trigger detected at block #${triggerBlock} — ` +
    `ETH balance: ${ethers.formatEther(ethBalance)}`
  );

  // ── Build rescue-only bundle (no Tx1 ETH fund) ────────────────────────────
  const targetBlock = triggerBlock + 1;
  log.bundle(`Target block for rescue: #${targetBlock} (next block)`);

  const builder   = new BundleBuilder(provider, safeWallet, hackedWallet);
  const submitter = new RelaySubmitter(provider, authSigner);

  const { signedTxs, bundle } = await builder.buildRescueOnly(targetBlock);

  // ── Simulate ──────────────────────────────────────────────────────────────
  log.bundle("Simulating rescue bundle …");
  try {
    const simResult = await submitter.simulate(signedTxs, targetBlock);
    log.success("Simulation passed!");
    logSimulationResult(simResult);
  } catch (err) {
    log.warn(`Simulation failed: ${err.message}`);
    log.warn("Proceeding with live submission (timing is critical in watch mode) …");
  }

  // ── Submit ────────────────────────────────────────────────────────────────
  log.bundle("Submitting rescue bundle to private relay …");
  const result = await submitter.submitAndWait(signedTxs, targetBlock);

  if (result.success) {
    log.success("🎉 RESCUE COMPLETE!");
    result.txHashes.forEach((h, i) => log.success(`  Tx${i + 1}: ${h}`));
    await printBalances(provider, safeWallet.address, hackedWallet.address);
  } else {
    log.error("Rescue bundle failed after all attempts.");
    process.exit(1);
  }
}

// ══════════════════════════════════════════════════════════════════════════════
//  Helpers
// ══════════════════════════════════════════════════════════════════════════════

async function printBalances(provider, safeAddr, hackedAddr) {
  const [safeBal, hackedBal] = await Promise.all([
    provider.getBalance(safeAddr),
    provider.getBalance(hackedAddr),
  ]);
  log.info(`Balances — Safe: ${ethers.formatEther(safeBal)} ETH | Hacked: ${ethers.formatEther(hackedBal)} ETH`);
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
