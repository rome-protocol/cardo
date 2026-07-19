# cardo/e2e/funded — funded UI e2e (L4)

The acceptance bar: drive the **real act|see UI** with a funded wallet —
connect → fill the form → sign → **tx lands on the target Rome chain** →
on-chain state verified. A route isn't "✅ proven" until its funded spec
is green (see `BUILDOUT_PLAN.md` Part C).

Chain-agnostic, like the Rome web app: target chain via `E2E_CHAIN_ID`, RPC + native
symbol resolved from the registry through `lib/chain-config`. Nothing
chain-specific is hardcoded.

## How it signs (no MetaMask popup)

A viem-injected `window.ethereum` shim (`lib/wallet-shim.ts`, lifted from
the Rome web app) signs locally with the treasury key and proxies reads to the chain
RPC. It announces via EIP-6963 so RainbowKit discovers it.
`connectShimWallet()` drives the "Connect wallet" → modal flow.

## Run

```bash
# default: target Hadrian (200010), app = live devnet
npm run test:e2e-funded

# against a local dev server / another chain
E2E_BASE_URL=http://localhost:3000 E2E_CHAIN_ID=200010 npm run test:e2e-funded
```

## Env contract

| Var | Default | Purpose |
|---|---|---|
| `E2E_TREASURY_PRIVATE_KEY_FILE` | `<your-treasury-key-path>` | EVM key the shim signs with (shared with the integration runner). chmod 600. |
| `E2E_CHAIN_ID` | `200010` | Target Rome chain; RPC/native resolved from registry via `lib/chain-config`. |
| `E2E_BASE_URL` | `https://cardo.devnet.romeprotocol.xyz` | App under test (set to `http://localhost:3000` for local). |
| `HEADED` | unset | `HEADED=1` to watch the browser. |

## Funding the treasury

One persistent wallet (reuse a single funded test key rather than
provisioning a separate payer). Per-route specs need it funded for that flow:

- **gas**: ≥ 0.005 native (mETH on Hadrian) — Rome gates `gas_price *
  gas_limit ≤ balance` even though emulation doesn't spend.
- **swap/send specs**: the relevant wrapper balances (wUSDC/wETH/wSOL). A
  spec that needs tokens must assert its precondition and skip-with-reason
  if unfunded (don't silently pass).

## Specs

- `connect.funded.spec.ts` — foundation: shim connects to the act|see UI.
  No token balances required. Every tx-landing spec builds on this.
- _(next)_ per-route tx-landing specs (swap, send, …) — connect → fill →
  sign → assert the tx hash lands + on-chain state changed.
