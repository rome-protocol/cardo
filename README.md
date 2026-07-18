# cardo

The **Rome App Distribution Portal** — a functional DeFi UI where EVM users execute real transactions against Solana protocols, atomically settled via Rome's CPI layer. The same Cardo adapters that today serve EVM-side flows are also the surface that Solana programs invoke into via Rome's MetaHook callback (and any future Solana → EVM call mechanism); bidirectional interop is part of the design intent, not a future addition. EVM users → Solana protocols is today's primary direction; Solana programs → Cardo adapters is equally first-class. See [`/rome/CLAUDE.md` §"What Rome is for"](https://github.com/rome-protocol/rome/blob/main/CLAUDE.md#what-rome-is-for) for the open-ended interop framing.

Live at **https://cardo.devnet.romeprotocol.xyz** — one chain-agnostic image (chain chosen at runtime), served on devnet like the Rome web app. Built with Next.js 15, TypeScript, RainbowKit 2 + wagmi 2 (EVM wallet), Solana wallet adapter (Solana wallet on `/orchestrator`), Anthropic Claude Haiku 4.5 (orchestrator AI router).

> **Status:** the **act|see** dark UI is the shipping design across the main dapp surfaces — see [`components/design/README.md`](./components/design/README.md) (the old light "V3" design is retired). Deployed as one chain-agnostic image (chain via runtime `ROME_CHAIN_ID`, header chain switcher over the devnet chains). 29+ adapter families, 40+ instruction builders, 18 unhappy-path test files. The `/orchestrator` surface accepts plain-English Solana intents, ranks routes via Claude, and executes atomically on Solana mainnet with a take-rate fee model that pays only when the swap lands.

## What's in the repo

```
cardo/
├── app/                              # Next.js App Router
│   ├── orchestrator/                 # /orchestrator — Claude-powered NL intents
│   ├── api/orchestrate/              # /api/orchestrate/* — analyze, build, build-yield,
│   │                                 # build-compose-step, relay, submit, activity
│   ├── swap/, swap-dlmm/, …          # per-protocol swap routes (10+)
│   ├── lend/, lend-drift/, lend-mango/
│   ├── perps/                        # Drift perps
│   ├── compose/                      # multi-dapp atomic intent flow
│   ├── pool/, pay/, name/, vote/, squads-propose/, stake/, stake-marinade/
│   └── for-agents/                   # MCP + JSON-RPC integration guide
│
├── lib/                              # one file family per Solana protocol
│   ├── <protocol>-program.ts         # program ID (from registry) + ix discriminators
│   ├── <protocol>-pdas.ts            # PDA derivations
│   ├── <protocol>-instructions.ts    # Solidity calldata builders for Rome CPI
│   ├── solana-programs.ts            # registry consumption shim — single source of truth
│   ├── orchestration/                # orchestrator subsystem (analyze, route, build)
│   │   ├── ai-router.ts              # parseIntent + rankRoutes (Claude SDK)
│   │   ├── route-analysis.ts         # analyzeSwapIntent / Stake / Yield
│   │   ├── arb-scanner.ts            # SOL/USDC roundtrip scanner
│   │   ├── jupiter.ts                # Jupiter aggregator integration
│   │   ├── kamino-v2-deposit.ts      # Kamino setup + deposit ix builders
│   │   └── config.ts                 # MAINNET_RPCS, treasury, fee bps
│   └── …
│
├── components/
│   ├── design/                       # act|see design system (THE design) — see design/README.md
│   │   ├── actsee.module.css         # scoped dark design system (all tokens + rig classes)
│   │   ├── DesignShell.tsx           # dark chrome: 2-level nav + header chain switcher
│   │   └── Ledger.tsx, ViaLink.tsx   # signature ledger + Via explorer link
│   ├── screens/                      # act|see screens (the two-column "rig")
│   ├── SignatureLedger.tsx           # live signature-count ledger (right column of the rig)
│   └── primitives.jsx                # fmtNum/fmtUSD helpers (+ LEGACY light atoms — do not reuse)
│
├── tests/                            # unhappy-path harness — every adapter has ≥1 case
│   ├── runner.ts                     # `npm run test:integrations`
│   ├── lib/                          # emulate.ts, treasury.ts, case.ts
│   └── cases/                        # per-protocol revert assertions (54 cases, all green)
│
├── scripts/                          # smoke probes, bootstrap, deploy helpers
└── package.json                      # `@rome-protocol/registry` is the canonical dep
```

## Run locally

```bash
npm install --legacy-peer-deps     # next@15 peer-deps
npm run dev                        # → http://localhost:3000
npm run typecheck                  # tsc --noEmit
npm run test:integrations          # tsx tests/runner.ts (54 cases)
npm run build                      # production build (standalone Next.js output)
```

The dev server serves Cardo's swap/lend/perps surfaces against the active Rome devnet chain (default Hadrian 200010; page reads proxy through `/api/rpc/rome`) and `/orchestrator` against Solana mainnet via Helius. Set `ROME_CHAIN_ID` to point the same build at another devnet chain — no rebuild (runtime config via `/api/env`).

### Environment

`.env.local` (gitignored):

```bash
# /orchestrator surface
ANTHROPIC_API_KEY=sk-ant-…
MAINNET_RPCS=https://api.mainnet-beta.solana.com/<token>,\
             https://mainnet.helius-rpc.com/?api-key=<key>,\
             https://api.mainnet-beta.solana.com   # comma-separated, primary first
CARDO_TREASURY_PUBKEY=<your-cardo-treasury-pubkey>
CARDO_FEE_BPS=30

# Sentry (optional)
NEXT_PUBLIC_SENTRY_DSN=…

# Test harness treasury (<your-secrets-dir>/e2e/ if you have it)
E2E_TREASURY_PRIVATE_KEY_FILE=<your-treasury-key-path>
```

## How it fits

EVM-side requests fan into Solana via Rome's CPI precompile (`0xff…0008`). Every page terminates in **one signed EVM tx** that calls the precompile — Rome auto-signs as the user's external-authority PDA, and the underlying Solana program (Kamino, Drift, Meteora, …) runs as if a Solana keypair signed.

```
user / Phantom / MetaMask
    │
    ▼
ethers.sendTransaction (signed tx → Rome)
    │
    ▼
Rome CPI precompile 0xff…0008
    │
    ▼
Solana program execution → settlement on Rome
```

The orchestrator (`/orchestrator`) speaks directly to Solana mainnet (no Rome CPI), with the user's Phantom signing each tx. Different surface, same Cardo product family.

## The product invariant for `/orchestrator`

**The user pays the Cardo fee if and only if their swap actually executed on-chain.**

Enforced by Solana's tx-level atomicity: the Jupiter swap + Cardo fee transfer ride in a single signed `VersionedTransaction`. The runtime guarantees all-or-nothing. If the swap reverts (slippage, missing liquidity), the fee transfer also doesn't run. The user's only cost on failure is the ~5,000 lamport network fee.

Pre-flight `simulateTransaction` runs server-side before returning the unsigned tx, so users see the actual on-chain error (rent, slippage, missing accounts) on the page rather than a confusing wallet popup.

## Registry consumption

Cardo imports canonical Solana program IDs from `@rome-protocol/registry`. One shim file (`lib/solana-programs.ts`) wraps everything:

```ts
import { solanaProgramId, lstMint } from '@/lib/solana-programs';

const KLEND      = solanaProgramId('kaminoLend');             // mainnet default
const RAY_AMM_V4 = solanaProgramId('raydiumAmmV4', 'devnet'); // explicit network
const jupSol     = lstMint('JupSOL');                         // { mint, stakePool, … }
```

Pinned per-deployment addresses (Cardo's bootstrap multisig, Sprint 3 Phoenix market, Realms council/community mints) stay inline since they're cardo-owned artifacts, not canonical protocol IDs. See [`CLAUDE.md`](./CLAUDE.md) for the full list of registry keys.

## Testing

Two harnesses:

1. **Unhappy-path (every adapter)** — `npm run test:integrations`. Each protocol ships a `tests/cases/<protocol>.ts` file asserting on revert reasons. 54/54 cases green against Rome running git_hash `6c38d3d` (May 2026).
2. **Orchestrator E2E (against Solana mainnet)** — `scripts/cardo-e2e.mjs`. Exercises `/api/orchestrate/*` against a real keypair (no Phantom in the loop). Tests slippage flow-through, stake live, yield live, compose live.

Manual UI smoke against `http://localhost:3000/orchestrator` with a real Phantom wallet for end-to-end validation.

## Documentation

- [`CLAUDE.md`](./CLAUDE.md) — agent guide (architecture, the **act|see design rule**, one-image runtime config, conventions, pitfalls)
- [`components/design/README.md`](./components/design/README.md) — **the act|see design system** (the only design): the rig, palette tokens, how to build a screen, and the guardrail against reintroducing the old light design
- [`tests/CLAUDE.md`](./tests/CLAUDE.md) — unhappy-path harness conventions
- [`lib/orchestration/PLAYBOOK.md`](./lib/orchestration/PLAYBOOK.md) — orchestrator session notes (historical)
- ~~`DESIGN_BRIEF_V3.md`, `DESIGN_SPEC.md`~~ — **RETIRED** light-design briefs (V3 / V1). Superseded by act|see; kept only as history — **do not build from them.**
