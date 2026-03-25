// src/config.js
// Loads, validates, and exports all configuration from .env

import "dotenv/config";

function requireEnv(key) {
  const val = process.env[key];
  if (!val || val.startsWith("0xYOUR") || val.startsWith("0xAIRDROP") || val.startsWith("0xTOKEN")) {
    throw new Error(`Missing or unconfigured environment variable: ${key}`);
  }
  return val;
}

function optionalEnv(key, defaultVal) {
  return process.env[key] ?? defaultVal;
}

export const config = {
  // Wallets
  safeWalletKey:   requireEnv("SAFE_WALLET_PRIVATE_KEY"),
  hackedWalletKey: requireEnv("HACKED_WALLET_PRIVATE_KEY"),

  // Contracts
  airdropContract:      requireEnv("AIRDROP_CONTRACT_ADDRESS"),
  airdropClaimCalldata: requireEnv("AIRDROP_CLAIM_CALLDATA"),
  airdropTokenAddress:  requireEnv("AIRDROP_TOKEN_ADDRESS"),

  // Network
  baseRpcUrl:     requireEnv("BASE_RPC_URL"),
  bundleRelayUrl: requireEnv("BUNDLE_RELAY_URL"),
  chainId:        parseInt(optionalEnv("CHAIN_ID", "8453")),

  // Gas
  maxPriorityFeeGwei: parseFloat(optionalEnv("MAX_PRIORITY_FEE_GWEI", "5")),
  maxFeeGwei:         parseFloat(optionalEnv("MAX_FEE_GWEI", "20")),
  baseFeeMultiplier:  parseFloat(optionalEnv("BASE_FEE_MULTIPLIER", "1.5")),
  ethGasBuffer:       optionalEnv("ETH_GAS_BUFFER", "0.001"),

  // Monitoring
  pollIntervalMs:    parseInt(optionalEnv("POLL_INTERVAL_MS", "15000")),
  maxBundleAttempts: parseInt(optionalEnv("MAX_BUNDLE_ATTEMPTS", "10")),
  blocksAheadTarget: parseInt(optionalEnv("BLOCKS_AHEAD_TARGET", "2")),

  // Optional
  bloxrouteApiKey: optionalEnv("BLOXROUTE_API_KEY", null),

  // Watch mode
  wsRpcUrl:      optionalEnv("WS_RPC_URL", null),
  minEthTrigger: optionalEnv("MIN_ETH_TRIGGER", "0.0003"),

  // Expected airdrop token amount (set this to avoid placeholder transfer)
  expectedAirdropAmount: optionalEnv("EXPECTED_AIRDROP_AMOUNT", null),
};
