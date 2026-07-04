# Tracefault (React + Express)

Tracefault is a full-stack Failed Transaction Analyzer. It features a Vite/React frontend and a Node.js/Express backend that securely proxies Etherscan API requests.

## Architecture

```
React Frontend (localhost:5173)
        │
        ▼ (REST API)
Express Backend (localhost:5000)
        │
        ▼
Etherscan API
```

## Running Locally

### Backend Setup

1. Navigate to the `backend` directory:
   ```bash
   cd backend
   ```
2. Install dependencies:
   ```bash
   npm install
   ```
3. Copy the environment variables template and add your Etherscan API key:
   ```bash
   cp .env.example .env
   ```
4. Start the backend server:
   ```bash
   npm run dev
   # or npm start
   ```

### Frontend Setup

1. From the project root, install dependencies:
   ```bash
   npm install
   ```
2. Start the Vite dev server:
   ```bash
   npm run dev
   ```

The application frontend will be available at `http://localhost:5173` and will communicate with the backend running on `http://localhost:5000`.

## Features

- **Standard revert decoding**: `Error(string)` and `Panic(uint256)` are decoded client-side.
- **Custom error decoding**: For verified contracts, the backend fetches the ABI and decodes custom Solidity errors into human-readable `ErrorName(param: value, ...)` format including full argument names and types.
- **Fallback to raw selector**: Unverified contracts still show the 4-byte selector.
- **Verification badge**: Each decoded failure shows whether the contract ABI was available.
- **Silent failure classification**: Out-of-gas and bare reverts are detected from gas ratio.
- **Protocol recognition**: Identifies known DeFi protocols (Uniswap, Aave, 1inch, Seaport, etc.) by address.

## Production Deployment

When deploying to production, ensure that:
1. The backend is configured with the production `ETHERSCAN_API_KEY`.
2. The backend `FRONTEND_ORIGIN` environment variable is updated to match your live frontend URL.
3. The frontend is built using `npm run build` and the `http://localhost:5000` URLs in `App.jsx` are replaced with your production API URL (or use environment variables for this).

## Expanding the ESLint configuration

If you are developing a production application, we recommend using TypeScript with type-aware lint rules enabled. Check out the [TS template](https://github.com/vitejs/vite/tree/main/packages/create-vite/template-react-ts) for information on how to integrate TypeScript and [`typescript-eslint`](https://typescript-eslint.io) in your project.

