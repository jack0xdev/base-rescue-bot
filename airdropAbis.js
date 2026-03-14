// src/utils/airdropAbis.js
// ─────────────────────────────────────────────────────────────────────────────
//  Reference library of common airdrop contract ABIs and their claim calldata.
//  Import and use in monitor.js or bundleBuilder.js as needed.
// ─────────────────────────────────────────────────────────────────────────────

import { ethers } from "ethers";

// ══════════════════════════════════════════════════════════════════════════════
//  ABI DEFINITIONS
// ══════════════════════════════════════════════════════════════════════════════

/** Uniswap / standard MerkleDistributor */
export const MERKLE_DISTRIBUTOR_ABI = [
  "function claim(uint256 index, address account, uint256 amount, bytes32[] calldata merkleProof)",
  "function isClaimed(uint256 index) view returns (bool)",
  "function token() view returns (address)",
  "function merkleRoot() view returns (bytes32)",
];

/** LayerZero / Optimism style (account + amount + proof, no index) */
export const LAYERZERO_STYLE_ABI = [
  "function claim(address account, uint256 amount, bytes32[] calldata merkleProof)",
  "function hasClaimed(address account) view returns (bool)",
];

/** Argent / simple claim — no args */
export const SIMPLE_CLAIM_ABI = [
  "function claim()",
  "function hasClaimed(address account) view returns (bool)",
];

/** Arbitrum style — claimTokens */
export const ARBITRUM_STYLE_ABI = [
  "function claimTokens(uint256 amount, bytes32[] calldata merkleProof)",
  "function hasClaimed(address account) view returns (bool)",
];

/** Pendle / epoch-gated */
export const EPOCH_CLAIM_ABI = [
  "function claim(uint256 epoch, uint256 amount, bytes32[] calldata proof)",
  "function claimed(address account, uint256 epoch) view returns (bool)",
];

// ══════════════════════════════════════════════════════════════════════════════
//  CALLDATA ENCODERS
// ══════════════════════════════════════════════════════════════════════════════

/**
 * Encode calldata for standard Uniswap MerkleDistributor
 */
export function encodeMerkleDistributorClaim({ index, account, amount, proof }) {
  const iface = new ethers.Interface(MERKLE_DISTRIBUTOR_ABI);
  return iface.encodeFunctionData("claim", [index, account, amount, proof]);
}

/**
 * Encode calldata for LayerZero-style airdrop (no index)
 */
export function encodeLayerZeroClaim({ account, amount, proof }) {
  const iface = new ethers.Interface(LAYERZERO_STYLE_ABI);
  return iface.encodeFunctionData("claim", [account, amount, proof]);
}

/**
 * Encode calldata for simple no-arg claim()
 */
export function encodeSimpleClaim() {
  const iface = new ethers.Interface(SIMPLE_CLAIM_ABI);
  return iface.encodeFunctionData("claim", []);
}

/**
 * Encode calldata for Arbitrum-style claimTokens
 */
export function encodeArbitrumClaim({ amount, proof }) {
  const iface = new ethers.Interface(ARBITRUM_STYLE_ABI);
  return iface.encodeFunctionData("claimTokens", [amount, proof]);
}

/**
 * Encode calldata for epoch-gated claim
 */
export function encodeEpochClaim({ epoch, amount, proof }) {
  const iface = new ethers.Interface(EPOCH_CLAIM_ABI);
  return iface.encodeFunctionData("claim", [epoch, amount, proof]);
}

// ══════════════════════════════════════════════════════════════════════════════
//  CLAIM STATUS CHECKERS
// ══════════════════════════════════════════════════════════════════════════════

/**
 * Universal claim checker — tries multiple hasClaimed patterns.
 * @param {ethers.Provider} provider
 * @param {string} contractAddress
 * @param {string} accountAddress
 * @param {number|null} index  — required for isClaimed(uint256) pattern
 * @returns {Promise<boolean>} true = already claimed
 */
export async function checkIfClaimed(provider, contractAddress, accountAddress, index = null) {
  // Try pattern 1: hasClaimed(address)
  try {
    const c = new ethers.Contract(contractAddress, ["function hasClaimed(address) view returns (bool)"], provider);
    return await c.hasClaimed(accountAddress);
  } catch {}

  // Try pattern 2: isClaimed(uint256)
  if (index !== null) {
    try {
      const c = new ethers.Contract(contractAddress, ["function isClaimed(uint256) view returns (bool)"], provider);
      return await c.isClaimed(index);
    } catch {}
  }

  // Try pattern 3: claimed(address, ...) — e.g. Pendle
  try {
    const c = new ethers.Contract(contractAddress, ["function claimed(address) view returns (bool)"], provider);
    return await c.claimed(accountAddress);
  } catch {}

  // Cannot determine — assume not yet claimed
  console.warn("⚠ Could not determine claim status — assuming NOT claimed.");
  return false;
}

// ══════════════════════════════════════════════════════════════════════════════
//  USAGE EXAMPLES (for reference)
// ══════════════════════════════════════════════════════════════════════════════

/*
// ── Example: Standard Merkle Distributor (Uniswap / most common) ─────────────
import { encodeMerkleDistributorClaim } from "./src/utils/airdropAbis.js";

const calldata = encodeMerkleDistributorClaim({
  index:   42,                          // your index from the merkle tree JSON
  account: "0xYOUR_HACKED_WALLET",
  amount:  ethers.parseUnits("500", 18), // 500 tokens
  proof:   [                             // from the airdrop's merkle proof API
    "0xabc123...",
    "0xdef456...",
  ],
});
// → Set AIRDROP_CLAIM_CALLDATA=<calldata output> in .env


// ── Example: LayerZero / no-index style ───────────────────────────────────────
import { encodeLayerZeroClaim } from "./src/utils/airdropAbis.js";

const calldata = encodeLayerZeroClaim({
  account: "0xYOUR_HACKED_WALLET",
  amount:  ethers.parseUnits("1000", 18),
  proof:   ["0xaaa...", "0xbbb..."],
});


// ── Example: Simple no-args claim() ──────────────────────────────────────────
import { encodeSimpleClaim } from "./src/utils/airdropAbis.js";

const calldata = encodeSimpleClaim(); // → "0x4e71d92d"
*/
