// Input-boundary guard for the natural-language intent endpoints.
//
// The keyless heuristic parser (parseIntentHeuristic) runs several regexes
// over this free text; an unbounded body could drive polynomial backtracking
// (ReDoS) and stall the Node event loop. Capping the length up front bounds
// every downstream regex to constant work. 2 KB is well past the longest
// realistic intent (a chained "swap … then stake … then yield …").

export const MAX_INTENT_TEXT_LENGTH = 2000;

export type IntentTextCheck =
  | { ok: true; text: string }
  | { ok: false; status: number; error: string };

/// Normalize + bound the free-text intent from a request body.
/// - non-string / empty / whitespace-only  → 400 "missing text"
/// - longer than MAX_INTENT_TEXT_LENGTH     → 413 "text too long"
/// - otherwise                              → { ok, text: trimmed }
export function checkIntentText(raw: unknown): IntentTextCheck {
  const text = (typeof raw === 'string' ? raw : '').trim();
  if (!text) {
    return { ok: false, status: 400, error: 'missing text' };
  }
  if (text.length > MAX_INTENT_TEXT_LENGTH) {
    return {
      ok: false,
      status: 413,
      error: `text too long (max ${MAX_INTENT_TEXT_LENGTH} characters)`,
    };
  }
  return { ok: true, text };
}
