import { defineConfig, devices } from '@playwright/test';

// Cardo E2E (chain-agnostic — like the Rome web app). Two projects:
//   smoke  : L3 — no wallet, drives every route, asserts act|see render.
//            Hermetic against an already-running app (live or local).
//   funded : L4 — drives a funded wallet through the REAL UI (connect →
//            fill → sign → tx lands → state verified). Signs via a
//            viem-injected window.ethereum shim keyed by the treasury
//            key (no faucet, no MetaMask popup). See e2e/funded/README.md.
//
// Target app via E2E_BASE_URL (default: live devnet). Target chain via
// E2E_CHAIN_ID (default 200010-Hadrian); RPC + native symbol resolve from
// the registry through lib/chain-config — nothing chain-specific hardcoded.
//
//   E2E_BASE_URL=http://localhost:3000 npm run test:ui
//   npm run test:e2e-funded            # needs E2E_TREASURY_PRIVATE_KEY_FILE
export default defineConfig({
  testDir: './e2e',
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 2 : 1,
  workers: process.env.CI ? 1 : 3,
  reporter: [['list'], ['html', { open: 'never' }]],
  use: {
    baseURL: process.env.E2E_BASE_URL ?? 'https://cardo.devnet.romeprotocol.xyz',
    trace: 'on-first-retry',
    screenshot: 'only-on-failure',
    headless: process.env.HEADED !== '1',
  },
  projects: [
    { name: 'smoke', testMatch: /smoke\/.*\.spec\.ts$/, use: { ...devices['Desktop Chrome'] } },
    // Funded specs land real on-chain txs — give them room past the 30s default.
    // /pay may do TWO txs (swap_gas_to_lamports funding + create_v2), each with
    // its own receipt poll, so allow generous headroom.
    { name: 'funded', testMatch: /funded\/.*\.spec\.ts$/, timeout: 300_000, use: { ...devices['Desktop Chrome'] } },
  ],
});
