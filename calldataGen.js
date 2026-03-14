// src/utils/calldataGen.js
// ─────────────────────────────────────────────────────────────────────────────
//  Claim Calldata Generator
//  Run standalone to encode the correct calldata for your airdrop contract.
//
//  Usage:
//    node src/utils/calldataGen.js
//
//  This tool interactively encodes the most common airdrop claim patterns.
//  Copy the output into AIRDROP_CLAIM_CALLDATA in your .env file.
// ─────────────────────────────────────────────────────────────────────────────

import { ethers } from "ethers";
import readline from "readline";

// ── Common airdrop ABI patterns ───────────────────────────────────────────────
const PATTERNS = {
  "1": {
    name: "Simple claim()  — no arguments",
    abi:  ["function claim()"],
    fn:   "claim",
    args: [],
  },
  "2": {
    name: "Merkle: claim(uint256 index, address account, uint256 amount, bytes32[] merkleProof)",
    abi:  ["function claim(uint256 index, address account, uint256 amount, bytes32[] merkleProof)"],
    fn:   "claim",
    args: ["index (uint256)", "account (address)", "amount (uint256, in token wei)", "proof (bytes32[], comma-separated hex)"],
  },
  "3": {
    name: "Merkle: claim(address account, uint256 amount, bytes32[] merkleProof)",
    abi:  ["function claim(address account, uint256 amount, bytes32[] merkleProof)"],
    fn:   "claim",
    args: ["account (address)", "amount (uint256, in token wei)", "proof (bytes32[], comma-separated hex)"],
  },
  "4": {
    name: "claimTokens(uint256 amount, bytes32[] merkleProof)",
    abi:  ["function claimTokens(uint256 amount, bytes32[] merkleProof)"],
    fn:   "claimTokens",
    args: ["amount (uint256, in token wei)", "proof (bytes32[], comma-separated hex)"],
  },
  "5": {
    name: "Custom — enter ABI + function name manually",
    abi:  null,
    fn:   null,
    args: null,
  },
};

const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
const ask = (q) => new Promise((r) => rl.question(q, r));

async function main() {
  console.log("\n╔══════════════════════════════════════════════════╗");
  console.log("║      Claim Calldata Generator — Rescue Bot       ║");
  console.log("╚══════════════════════════════════════════════════╝\n");

  console.log("Select your airdrop claim pattern:\n");
  for (const [k, v] of Object.entries(PATTERNS)) {
    console.log(`  [${k}] ${v.name}`);
  }

  const choice = (await ask("\nEnter number [1-5]: ")).trim();
  const pattern = PATTERNS[choice];
  if (!pattern) {
    console.error("Invalid choice.");
    rl.close();
    process.exit(1);
  }

  let iface, fnName, values;

  if (choice === "5") {
    // Custom ABI input
    const abiStr = await ask("Enter ABI function signature (e.g. claim(uint256,address,uint256,bytes32[])): ");
    fnName       = abiStr.split("(")[0].trim();
    iface        = new ethers.Interface([`function ${abiStr}`]);
    const paramStr = await ask("Enter parameter values (JSON array, e.g. [0, \"0xABC...\", \"1000000000000000000\", [\"0xAAA...\",\"0xBBB...\"]]): ");
    values = JSON.parse(paramStr);
  } else {
    iface  = new ethers.Interface(pattern.abi);
    fnName = pattern.fn;
    values = [];

    for (const argDef of pattern.args) {
      const raw = await ask(`  Enter ${argDef}: `);
      if (argDef.includes("bytes32[]")) {
        // Parse comma-separated proof hex values
        values.push(raw.split(",").map((s) => s.trim()));
      } else if (argDef.includes("uint256")) {
        values.push(BigInt(raw.trim()));
      } else {
        values.push(raw.trim());
      }
    }
  }

  const calldata = iface.encodeFunctionData(fnName, values);

  console.log("\n✅ Encoded calldata:");
  console.log("─".repeat(60));
  console.log(calldata);
  console.log("─".repeat(60));
  console.log("\nAdd this to your .env:");
  console.log(`AIRDROP_CLAIM_CALLDATA=${calldata}`);

  // Decode back to verify
  try {
    const decoded = iface.decodeFunctionData(fnName, calldata);
    console.log("\n🔍 Decoded (verification):", decoded);
  } catch {}

  rl.close();
}

main().catch((e) => { console.error(e.message); rl.close(); process.exit(1); });
