// AI router for Cardo orchestration.
//
// Two LLM-driven layers on top of the algorithmic quote/route engine:
//
//   parseIntent(text)          natural language → structured Intent
//   rankRoutes(intent, routes) Route[] → ranked Route[] with reasoning
//
// Both fall back to deterministic heuristics when no API key is set so the
// code remains runnable without secrets. With ANTHROPIC_API_KEY in env, we
// route through Claude with prompt-cached system prompts so repeated calls
// stay cheap (each subsequent call hits the cache and pays ~10% of the
// usual prompt cost).
//
// Production design notes:
//   - Use Haiku 4.5 for routing/parsing — sub-second, ~$0.001 per call.
//   - System prompt is cache-eligible (>1024 tokens) and reused across calls.
//   - Output is structured (tool-style JSON) so the orchestrator can act on it
//     deterministically instead of parsing prose.
//   - Latency budget: ~1-2s per LLM call. Add to overall orchestration time.

import Anthropic from '@anthropic-ai/sdk';
import type { Route } from './route-analysis';

const HAIKU = 'claude-haiku-4-5';

// Re-exported so consumers can import without depending on the SDK's types.
export type Preference =
  | 'cheapest'      // minimize total cost (fees + tip + slippage)
  | 'best_output'   // maximize amountOut (least slippage)
  | 'fastest'       // minimize landing time (highest tip / fewest hops)
  | 'safest'        // highest landing prob, lowest cost variance
  | 'auto';         // let the AI decide

export type ParsedIntent = {
  /// SwapIntent / StakeIntent / YieldIntent / ArbIntent / ComposeIntent
  /// (perp is not an orchestrator intent — see the first-class /perps surface)
  kind: 'swap' | 'stake' | 'yield' | 'arb' | 'compose' | 'unknown';
  /// Original text the user typed.
  raw: string;
  /// Parsed parameters, varies by kind. For compose: { steps: SubIntent[] }
  /// where SubIntent = { kind, params } (no nested compose, no recursion).
  params: Record<string, unknown>;
  /// User's stated preference if any.
  preference: Preference;
  /// Confidence 0-1 in this parse.
  confidence: number;
  /// One-line summary (for UI confirmation).
  summary: string;
};

/// A leaf intent inside a compose. Same shape as ParsedIntent but
/// guaranteed-not-compose to keep the recursion bounded.
export type SubIntent = {
  kind: 'swap' | 'stake' | 'yield' | 'arb';
  params: Record<string, unknown>;
  /// Human description for the chain UI.
  summary: string;
};

export type RankedRoute = Route & {
  /// 0-indexed rank from this AI call.
  rank: number;
  /// Why the AI picked this rank — short prose for the UI.
  reasoning: string;
};

// ─────────────────────────────────────────────────────────────────────
// System prompt (cache-eligible — must be >1024 tokens to be cached).
// ─────────────────────────────────────────────────────────────────────

const SYSTEM_PROMPT = `You are Cardo's orchestration AI. Cardo is a Solana orchestration layer that turns user intents into atomic Jito bundles. Your job is to (a) parse natural-language user intents into structured form, and (b) rank algorithmically-computed Route options for a user with optional preferences.

## Architecture context

Cardo's orchestrator has these intent types:
- swap: A→B exchange
- stake: SOL → liquid staking token (JitoSOL, bSOL, mSOL, JupSOL)
- yield: park a token as supply on a lending protocol (Kamino, Mango v4, Drift)
- arb: round-trip a token through multiple DEXes for net positive

(Perpetual futures are NOT an orchestrator intent — they live on Cardo's dedicated /perps surface. Do not emit a perp intent.)

Each user intent eventually becomes a 3-5-tx Jito bundle on Solana mainnet. Bundle costs include:
- Jito tip (~$0.30-$1.00 depending on tip floor)
- 3-5 tx fees (~$0.005)
- Non-recoverable ATA rents (~$0.40 per kept ATA, recoverable for closed-on-cleanup ATAs)

The orchestrator's algorithmic layer (analyzeSwapIntent / analyzeStakeIntent / analyzeYieldIntent / scanArbs) computes Route options with: hops, output amount, total cost, tip, landing probability. Your job for ranking is to apply user preferences across these dimensions.

## Common token mints (Solana mainnet)

- USDC: EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v (6 dec)
- USDT: Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB (6 dec)
- SOL/WSOL: So11111111111111111111111111111111111111112 (9 dec)
- JitoSOL: J1toso1uCk3RLmjorhTtrVwY9HJ7X8V9yYac6Y7kGCPn (9 dec)
- bSOL: bSo13r4TkiE4KumL71LsHTPpL2euBYLFx6h9HP3piy1 (9 dec)
- mSOL: mSoLzYCxHdYgdzU16g5QSh3i5K3z3KZK7ytfqcJm7So (9 dec)
- JupSOL: jupSoLaHXQiZZTSfEWMTRRgpnyFm8f6sZdosWBjx93v (9 dec)

If the user mentions "$10" they likely mean USD-denominated and the orchestrator will convert to lamports based on current SOL price. If they say "0.05 SOL" use it directly.

**Important — do not compute lamport conversions yourself.** When the user denominates in USD, return \`principalUsd\` (a number, e.g. 1000). When in SOL, return \`amountInSol\` (a number, e.g. 0.05). The orchestrator does the lamport math against the live SOL price. Returning a hardcoded \`principalLamports\` will use stale prices and mis-size the trade.

## Preference semantics

When the user says preference like "cheapest" / "fastest" / "safest" / "max yield", here is how to weigh routes:
- cheapest: minimize total cost (tip + fees + non-recoverable rent + slippage). Output amount is secondary.
- best_output: maximize amountOut. Cost is secondary.
- fastest: minimize hop count + use highest landing-probability tip.
- safest: highest landing probability AND lowest cost variance. Avoid unverified pools.
- auto: balance cost and output proportional to principal — for small principals favor cheapest, for large favor best_output.

When the user provides no preference, default to auto.

## Compose / chained intents

When the user describes a sequence ("swap 0.005 SOL to USDC, then
deposit on Kamino"; "swap to USDC and yield it"; "stake then send"),
return \`kind: compose\` with \`params: { steps: [...] }\` where each step
has \`{ kind, params, summary }\`.

Each step's \`params\` follows the same shape as the corresponding
single-intent (swap → amountInSol/inputMint/outputMint/slippageBps,
stake → amountInSol, yield → amountInUsdc, etc.).

For the second+ step, \`params\` should reference the OUTPUT of the
previous step. E.g., for "swap 0.01 SOL to USDC then yield", step 1
swap produces ~0.84 USDC and step 2 yield params becomes
{ amountInUsdc: 0.84 }. Use a reasonable estimate based on current
prices — the orchestrator re-quotes at execute time.

Only output compose for explicit chains. Single intents stay as their
respective kinds.

## Handling open-ended / "what should I do" intents

Users often ask things like "best thing to do with 0.01 SOL", "I'm
holding SOL — recommendations?", "what should I do with my USDC?". These
are NOT unknown — they're requests for Cardo to recommend. Default rules:

- Holding SOL with no specified action → \`kind: stake\` (the canonical
  "earn yield while keeping liquidity" answer for idle SOL). Set
  \`preference: safest\` since they didn't specify.
- Holding USDC with no specified action → \`kind: yield\` (supply on a
  lending market). Set \`preference: best_output\` (max APY).
- Holding any other token → \`kind: swap\` to a stable they likely want
  (USDC).
- Set confidence to ~0.7 for these inferred-defaults, not 0.4 — your
  default is the right answer for >80% of users.

Only return \`kind: unknown\` if the request is truly off-topic (not
about Solana / DeFi / their wallet). Don't return unknown just because
the user was vague — they're asking us to recommend.

## Output format

Every response must use the provided tool. Do not respond with prose or markdown.`;

// Note: even with the architecture context above, this prompt is well under
// 1024 tokens so cache_control wouldn't kick in. We still set it to encourage
// caching once the prompt grows. Anthropic's caching is opt-in and idempotent.

// ─────────────────────────────────────────────────────────────────────
// Tool schemas — structured outputs
// ─────────────────────────────────────────────────────────────────────

const PARSE_INTENT_TOOL = {
  name: 'submit_parsed_intent',
  description: 'Submit the structured intent parsed from the user\'s natural-language request.',
  input_schema: {
    type: 'object' as const,
    properties: {
      kind: {
        type: 'string',
        enum: ['swap', 'stake', 'yield', 'arb', 'compose', 'unknown'],
        description: 'The intent type. Use "unknown" only for truly off-topic requests. Use "compose" for chained sequences ("X then Y"). Perpetual futures are NOT handled here — never emit a perp intent.',
      },
      params: {
        type: 'object',
        description: 'Parsed params. For swap: { amountIn (lamports/raw), inputMint, outputMint, slippageBps }. For stake: { amountInLamports, lst? }. For yield: { amountIn, mint, protocol? }. For arb: { principalLamports, targetTokens? }. For compose: { steps: [{ kind, params, summary }, ...] }.',
      },
      preference: {
        type: 'string',
        enum: ['cheapest', 'best_output', 'fastest', 'safest', 'auto'],
        description: 'User\'s stated preference, or "auto" if none.',
      },
      confidence: { type: 'number', description: 'Your confidence 0-1 in this parse.' },
      summary: { type: 'string', description: 'One-line plain-English summary for UI confirmation.' },
    },
    required: ['kind', 'params', 'preference', 'confidence', 'summary'],
  },
};

const RANK_ROUTES_TOOL = {
  name: 'submit_ranked_routes',
  description: 'Submit a ranking of the provided routes with reasoning per route.',
  input_schema: {
    type: 'object' as const,
    properties: {
      ranking: {
        type: 'array',
        description: 'Array indexed by RANK (0=best). Each entry references the route by its original input index.',
        items: {
          type: 'object',
          properties: {
            originalIndex: { type: 'number', description: 'Index of the route in the input array.' },
            reasoning: { type: 'string', description: 'One-line plain-English reason this rank.' },
          },
          required: ['originalIndex', 'reasoning'],
        },
      },
    },
    required: ['ranking'],
  },
};

// ─────────────────────────────────────────────────────────────────────
// Anthropic client (lazy-init; no key → null → fall back to heuristics)
// ─────────────────────────────────────────────────────────────────────

let _client: Anthropic | null | undefined;
function client(): Anthropic | null {
  if (_client !== undefined) return _client;
  const key = process.env.ANTHROPIC_API_KEY;
  if (!key) {
    _client = null;
    return null;
  }
  _client = new Anthropic({ apiKey: key });
  return _client;
}

// ─────────────────────────────────────────────────────────────────────
// parseIntent — natural language → structured Intent
// ─────────────────────────────────────────────────────────────────────

export async function parseIntent(text: string): Promise<ParsedIntent> {
  const c = client();
  if (!c) return parseIntentHeuristic(text);

  const res = await c.messages.create({
    model: HAIKU,
    max_tokens: 512,
    system: [
      // cache_control on the system prompt — Anthropic only caches blocks >=1024 tokens
      // so this currently behaves as un-cached, but the wire format is correct.
      { type: 'text', text: SYSTEM_PROMPT, cache_control: { type: 'ephemeral' } },
    ],
    tools: [PARSE_INTENT_TOOL],
    tool_choice: { type: 'tool', name: PARSE_INTENT_TOOL.name },
    messages: [{ role: 'user', content: `Parse this user intent into structured form:\n\n${text}` }],
  });
  const toolUse = res.content.find(b => b.type === 'tool_use');
  if (!toolUse || toolUse.type !== 'tool_use') {
    return parseIntentHeuristic(text); // fallback if model didn't call the tool
  }
  const out = toolUse.input as Omit<ParsedIntent, 'raw'>;
  return { ...out, raw: text };
}

function inferPreference(t: string, fallback: Preference): Preference {
  if (t.includes('cheapest') || t.includes('cheap') || t.includes('lowest cost')) return 'cheapest';
  if (t.includes('safest') || t.includes('safe')) return 'safest';
  if (t.includes('fastest') || t.includes('fast')) return 'fastest';
  if (t.includes('best output') || t.includes('most output') || t.includes('max yield') || t.includes('highest yield') || t.includes('best')) return 'best_output';
  return fallback;
}

/// Parse ONE leaf intent (no compose) from a text fragment. Reuses the full
/// single-intent heuristic; the compose splitter calls this per step.
function parseLeafHeuristic(fragment: string): SubIntent | null {
  const parsed = parseIntentHeuristic(fragment, /* allowCompose */ false);
  if (parsed.kind === 'unknown' || parsed.kind === 'compose') return null;
  return {
    kind: parsed.kind as SubIntent['kind'],
    params: parsed.params,
    summary: parsed.summary,
  };
}

function parseIntentHeuristic(text: string, allowCompose = true): ParsedIntent {
  const t = text.toLowerCase();
  // very rough heuristics — the LLM does the heavy lifting.
  // Compose FIRST: "X then Y", "X and then Y", "X, then Y". Without this the
  // keyless path matches whichever single-intent keyword appears first and
  // silently drops the chain (e.g. "swap … then yield" → kind=yield → the
  // build-compose-step endpoint 400s). The deployed pod runs keyless, so this
  // is the production parse for chained intents.
  if (allowCompose) {
    const parts = text
      .split(/\s*(?:,?\s*and\s+then|,?\s*then|;)\s+/i)
      .map((p) => p.trim())
      .filter(Boolean);
    if (parts.length >= 2) {
      const steps = parts
        .map((p) => parseLeafHeuristic(p))
        .filter((s): s is SubIntent => s !== null);
      if (steps.length >= 2) {
        return {
          kind: 'compose', raw: text,
          params: { steps },
          preference: inferPreference(t, 'auto'),
          confidence: 0.6,
          summary: steps.map((s) => s.kind).join(' then '),
        };
      }
    }
  }
  // (Perp is not an orchestrator intent — it lives on the first-class /perps
  // Solana-wallet surface, Jupiter Perps. Deliberately not parsed here.)
  if (t.includes('arb') || t.includes('arbitrage')) {
    const matchUsd = t.match(/\$\s*([\d.,]+)/);
    const principalUsd = matchUsd ? parseFloat(matchUsd[1].replace(/,/g, '')) : 10;
    return {
      kind: 'arb', raw: text,
      params: { principalUsd },
      preference: inferPreference(t, 'auto'),
      confidence: 0.6,
      summary: `arb opportunity, $${principalUsd}`,
    };
  }
  if (t.includes('stake') || t.includes('jitosol') || t.includes('msol') || t.includes('lst')) {
    const solMatch = text.match(/([\d.]+)\s*sol/i);
    const amountInSol = solMatch ? parseFloat(solMatch[1]) : 0.01;
    const preference = inferPreference(t, 'auto');
    return {
      kind: 'stake', raw: text,
      params: { amountInSol },
      preference, confidence: 0.6,
      summary: `stake ${amountInSol} SOL → LST (${preference})`,
    };
  }
  if (t.includes('yield') || t.includes('lend') || t.includes('supply') || t.includes('kamino') || t.includes('mango')) {
    const usdMatch = text.match(/\$\s*([\d.]+)/);
    const usdcMatch = text.match(/([\d.]+)\s*usdc/i);
    const amountInUsdc = usdMatch ? parseFloat(usdMatch[1]) : usdcMatch ? parseFloat(usdcMatch[1]) : 1;
    const preference = inferPreference(t, 'best_output');
    return {
      kind: 'yield', raw: text,
      params: { amountInUsdc },
      preference, confidence: 0.6,
      summary: `park ${amountInUsdc} USDC for yield (${preference})`,
    };
  }
  // Swap is the catch-all if mentions of token names appear, since most
  // intents like "I have X want Y" are swaps.
  const tokenMentioned = /usdc|usdt|sol|wsol/i.test(text);
  const wantSwap = t.includes('swap') || t.includes('exchange') || t.includes('trade')
    || (tokenMentioned && (t.includes('want') || t.includes('to ')));
  if (wantSwap) {
    // Try to extract amount in SOL or USD
    const solMatch = text.match(/([\d.]+)\s*sol/i);
    const usdMatch = text.match(/\$\s*([\d.]+)/);
    const amountInSol = solMatch ? parseFloat(solMatch[1]) : (usdMatch ? parseFloat(usdMatch[1]) / 200 : 0.005);
    const pref = inferPreference(t, 'auto');
    return {
      kind: 'swap', raw: text,
      params: { amountInSol, outputMint: 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v' },
      preference: pref, confidence: 0.6,
      summary: `swap ${amountInSol} SOL → USDC (${pref})`,
    };
  }
  return { kind: 'unknown', raw: text, params: {}, preference: 'auto', confidence: 0.0, summary: 'could not parse' };
}

// ─────────────────────────────────────────────────────────────────────
// rankRoutes — apply preference, return ranked routes with reasoning
// ─────────────────────────────────────────────────────────────────────

export async function rankRoutes(args: {
  intent: ParsedIntent;
  routes: Route[];
  preferenceOverride?: Preference;
}): Promise<RankedRoute[]> {
  const c = client();
  const pref = args.preferenceOverride ?? args.intent.preference;
  if (!c || args.routes.length === 0) {
    return rankRoutesHeuristic(args.routes, pref);
  }

  const summary = args.routes.map((r, i) => ({
    index: i,
    label: r.label,
    hops: r.hops,
    amountOut: r.amountOut.toString(),
    amountOutPretty: r.amountOutPretty,
    costLamports: r.costLamports,
    costPretty: r.costPretty,
    tipLamports: r.tipLamports,
    landingProb: r.landingProb,
    txCount: r.txCount,
    notes: r.notes,
  }));

  const res = await c.messages.create({
    model: HAIKU,
    max_tokens: 1024,
    system: [{ type: 'text', text: SYSTEM_PROMPT, cache_control: { type: 'ephemeral' } }],
    tools: [RANK_ROUTES_TOOL],
    tool_choice: { type: 'tool', name: RANK_ROUTES_TOOL.name },
    messages: [{
      role: 'user',
      content: `User intent:\n${JSON.stringify(args.intent, null, 2)}\n\nUser preference: ${pref}\n\nAlgorithmically-computed routes (${args.routes.length}):\n\n${JSON.stringify(summary, null, 2)}\n\nRank these routes per the user's preference. The top-ranked route is what we'll execute. Give a one-line reason per route explaining its rank relative to the user's preference.`,
    }],
  });

  const toolUse = res.content.find(b => b.type === 'tool_use');
  if (!toolUse || toolUse.type !== 'tool_use') {
    return rankRoutesHeuristic(args.routes, pref);
  }
  const out = toolUse.input as { ranking: { originalIndex: number; reasoning: string }[] };
  return out.ranking.map((r, rank) => ({
    ...args.routes[r.originalIndex],
    rank,
    reasoning: r.reasoning,
  }));
}

function rankRoutesHeuristic(routes: Route[], pref: Preference): RankedRoute[] {
  const sorted = [...routes].sort((a, b) => {
    if (pref === 'cheapest') return a.costLamports - b.costLamports;
    if (pref === 'best_output') return Number(b.amountOut - a.amountOut);
    if (pref === 'fastest') return b.landingProb - a.landingProb;
    if (pref === 'safest') return b.landingProb - a.landingProb;
    // auto: balance — pick highest amountOut/cost ratio
    const ra = Number(a.amountOut) / Math.max(a.costLamports, 1);
    const rb = Number(b.amountOut) / Math.max(b.costLamports, 1);
    return rb - ra;
  });
  return sorted.map((r, rank) => ({
    ...r,
    rank,
    reasoning:
      pref === 'cheapest' ? `${r.costPretty} total cost`
      : pref === 'best_output' ? `${r.amountOutPretty} output`
      : pref === 'fastest' || pref === 'safest' ? `${(r.landingProb * 100).toFixed(0)}% landing prob`
      : `balanced cost/output ratio (heuristic)`,
  }));
}
