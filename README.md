# ⚡ Base Chain Rescue Bot — Flashbots-style Bundle

Rescues airdropped tokens from a **compromised wallet** using a **private atomic bundle** on Base chain.  
No mempool exposure. No front-running. All 3 transactions execute in the same block or not at all.

---

## How It Works

```
┌─────────────────────────────────────────────────────────┐
│                 PRIVATE RELAY BUNDLE                     │
│                  (Single Block)                          │
│                                                          │
│  Tx 1: Safe Wallet ──ETH──► Hacked Wallet  (gas fund)  │
│  Tx 2: Hacked Wallet ──────► Airdrop Contract (claim)  │
│  Tx 3: Hacked Wallet ──Tokens─► Safe Wallet  (sweep)   │
│                                                          │
│  If ANY tx fails → entire bundle reverts (atomic)       │
└─────────────────────────────────────────────────────────┘
```

**Why this is safe:**
- Bundle is submitted directly to a private relay — never enters the public mempool
- Front-runners and bots cannot see or react to these transactions
- The atomicity guarantee means you never fund the hacked wallet without completing the rescue

---

## Setup

### 1. Install dependencies

```bash
npm install
```

### 2. Configure environment

```bash
cp .env.example .env
# Edit .env with your actual values
```

Key values to set in `.env`:

| Variable | Description |
|---|---|
| `SAFE_WALLET_PRIVATE_KEY` | Your secure wallet private key |
| `HACKED_WALLET_PRIVATE_KEY` | Compromised wallet key (you still have it) |
| `AIRDROP_CONTRACT_ADDRESS` | The contract to call `claim()` on |
| `AIRDROP_CLAIM_CALLDATA`   | Hex-encoded calldata for the claim function |
| `AIRDROP_TOKEN_ADDRESS`    | ERC-20 token address being claimed |
| `BUNDLE_RELAY_URL`         | Private relay endpoint (see below) |

### 3. Get your claim calldata

The `AIRDROP_CLAIM_CALLDATA` must match your specific airdrop contract.  
Common patterns:

```js
// Simple claim()
const calldata = "0x4e71d92d";

// Merkle airdrop: claim(uint256 index, address account, uint256 amount, bytes32[] proof)
const iface = new ethers.Interface(airdropABI);
const calldata = iface.encodeFunctionData("claim", [index, address, amount, proof]);
```

Use a tool like [ABI Encoder](https://abi.hashex.org/) or ethers.js to encode your specific parameters.

---

## Relay Options for Base Chain

| Relay | URL | Notes |
|---|---|---|
| Flashbots Protect | `https://rpc-base.flashbots.net` | Recommended starting point |
| Titanium Builder | `https://rpc.titanbuilder.xyz` | Base-native builder |
| BloXroute | `https://api.blxrbdn.com` | Requires API key |
| Base Builder | `https://base.blockbuidler.xyz` | Community builder |

> **Note:** Always verify relay URLs from official sources before use. Relay endpoints can change.

---

## Usage

### Simulate only (safe — no transactions sent)
```bash
npm run simulate
```

### Monitor only (watch for claim availability)
```bash
npm run monitor
```

### Full rescue (live)
```bash
npm start
```

---

## Gas Configuration

The bot uses **EIP-1559 aggressive gas pricing**:

```
maxFeePerGas = (currentBaseFee × BASE_FEE_MULTIPLIER) + MAX_PRIORITY_FEE_GWEI
```

Tune these in `.env`:
- `BASE_FEE_MULTIPLIER` — buffer over current base fee (default: 1.5 = 50% buffer)
- `MAX_PRIORITY_FEE_GWEI` — miner tip (default: 5 gwei)
- `ETH_GAS_BUFFER` — ETH to send for gas (default: 0.001 ETH)

---

## Optional: RescueHelper Contract

For maximum atomicity, deploy `contracts/RescueHelper.sol` on Base.  
This collapses Tx2 + Tx3 into a **single contract call** — the claim and sweep happen in one EVM transaction, eliminating any state gap.

**Deploy with Hardhat or Foundry:**
```bash
# Foundry example
forge create contracts/RescueHelper.sol:RescueHelper \
  --rpc-url https://mainnet.base.org \
  --private-key $SAFE_WALLET_PRIVATE_KEY
```

Then update `bundleBuilder.js` to call `rescueHelper.claimAndRescue(...)` as Tx2 (removing Tx3).

---

## Project Structure

```
base-rescue-bot/
├── src/
│   ├── bot.js           # Main entry point
│   ├── config.js        # Env config loader
│   ├── monitor.js       # Airdrop claim eligibility polling
│   ├── bundleBuilder.js # Tx construction & signing
│   ├── relaySubmitter.js # Private relay submission
│   ├── gasStrategy.js   # EIP-1559 gas pricing
│   └── logger.js        # Colored console output
├── contracts/
│   └── RescueHelper.sol # Optional atomic claim+sweep contract
├── .env.example
├── package.json
└── README.md
```

---

## Troubleshooting

| Problem | Likely Cause | Fix |
|---|---|---|
| Simulation fails | Wrong claim calldata | Re-encode with correct ABI + params |
| Bundle not included | Gas too low | Increase `MAX_FEE_GWEI` / `MAX_PRIORITY_FEE_GWEI` |
| Relay rejects bundle | Wrong relay for Base | Verify relay URL supports Base (chainId 8453) |
| Token transfer fails | Balance 0 after claim | Check if claim sends to hacked wallet or this contract |
| Tx3 sends wrong amount | Pre-claim balance unknown | Set exact expected airdrop amount in bundleBuilder.js |

---

## Security Notes

- **Never** expose your `.env` file or commit private keys to git
- Add `.env` to `.gitignore` immediately
- The hacked wallet key is required to sign Tx2 and Tx3 — keep this secure during the rescue operation
- Run `--simulate` first every time before live submission
- The relay submission is private, but ensure your RPC provider is also trusted

---

## Disclaimer

This tool is for recovering your own assets from a wallet you still control the private key of.  
Always verify contract addresses and calldata before submitting live transactions.
