// Agent integration guide route `/for-agents` — renders designer's ForAgents.
//
// The designer's ForAgents screen is purely static (no data fetches), so
// the server component just hands control to a client wrapper that wires
// up router-based onNavigate.

import ForAgentsClient from './ForAgentsClient';

export const metadata = {
  title: 'For agents — Cardo',
  description: 'MCP + REST integration guide for agent developers.',
};

export default function ForAgentsPage() {
  return <ForAgentsClient />;
}
