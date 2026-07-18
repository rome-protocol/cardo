// /orchestrator — natural-language intent → ranked Solana routes.
//
// Cardo's orchestration surface: the user types what they want
// ("swap 0.05 SOL to USDC, cheapest route") and the page returns
// AI-ranked Route options with one-line reasoning per row. Live RPC +
// LLM ranking happen server-side in /api/orchestrate; this page is a
// thin React shell around that.

import OrchestratorClient from './OrchestratorClient';

export const metadata = {
  title: 'Orchestrator — Cardo',
  description:
    'Natural-language Solana orchestration: type an intent, get AI-ranked routes.',
};

// The Solana wallet providers now wrap the whole orchestrator chrome (see
// app/Shell.tsx → SolanaOrchestratorChrome) so the wallet button lives in the
// shared header. This page is just the content.
export default function OrchestratorPage() {
  return <OrchestratorClient />;
}
