# TraceFault

**Why did my transaction fail?**

Paste an Ethereum contract address. TraceFault pulls its recent failed transactions and tells you, in plain language, why each one broke — the actual revert reason, the custom error and its arguments, or (when the chain won't say) an educated guess based on gas usage.

## What it shows you

- **Decoded reverts** — instead of `0x7939f424`, you see `SafeTransferFromFailed()` with named arguments.
- **Silent failures** — when a transaction ran out of gas or reverted without a message, it says so.
- **Protocol tags** — recognizes Uniswap, Aave, 1inch, Seaport, and other common contracts so you know what you're looking at.
- **Verification badge** — shows whether the contract's source is public on Etherscan.

## Try it

You need a free [Etherscan API key](https://etherscan.io/myapikey).

**Backend** (in `/backend`):

```bash
npm install
cp .env.example .env      # then paste your API key into .env
npm run dev
```

**Frontend** (in the project root):

```bash
npm install
npm run dev
```

Open http://localhost:5173, drop in any contract address (or hit one of the quick-fill buttons), and click Analyze.

## Deploying it

- Put your production Etherscan key in the backend's environment.
- Set `FRONTEND_ORIGIN` on the backend to your live frontend URL.
- Replace the hardcoded `http://localhost:5000` in `src/App.jsx` with your production API URL before running `npm run build`.

## How it works (in one paragraph)

The frontend asks the Express backend for a contract's recent transactions. The backend proxies Etherscan calls (throttled and cached) and, for verified contracts, hands back a map of custom-error selectors. For each failed transaction, the frontend replays the call at its original block via `eth_call` to pull the revert data, then decodes it against the ABI selectors. Transactions that don't return a revert reason are classified by how much of their gas they burned.
