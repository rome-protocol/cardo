import { defineConfig } from 'vitest/config';

// L1 — hermetic unit tests (no network, no keys). Runs in the pre-push hook
// and CI. Integration cases (tests/cases/*, driven by tests/runner.ts against
// rome_emulateTx) and Playwright e2e (e2e/) are deliberately excluded — they
// need a live chain / funded wallet and run in CI / on-demand, not pre-push.
export default defineConfig({
  test: {
    environment: 'node',
    include: ['tests/**/*.test.ts'],
    exclude: ['node_modules/**', 'e2e/**', 'tests/cases/**', 'tests/lib/**'],
  },
});
