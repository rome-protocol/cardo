'use client';
// Orchestrator screen — natural-language intent → AI-ranked Solana routes.
//
// User flow:
//   1. type intent ("swap 0.05 SOL to USDC, cheapest")
//   2. click Analyze → POST /api/orchestrate
//   3. UI shows parsed intent + ranked Route cards with reasoning
//   4. "Pick this route" stub — wires into bundle submission later
//
// All heavy lifting (parseIntent + analyze*Intent + rankRoutes) happens
// server-side in /api/orchestrate. This component is purely presentation.

import React, { useEffect, useState } from 'react';
import { CARDO_FEE_BPS } from '@/lib/orchestration/config';
import s from '@/components/design/actsee.module.css';
import { useWallet } from '@solana/wallet-adapter-react';
import {
  Transaction,
  VersionedTransaction,
} from '@solana/web3.js';


type RankedRouteWire = {
  rank: number;
  label: string;
  hops: string[];
  txCount: number;
  inputMint?: string;
  outputMint?: string;
  amountOut: string;
  amountOutPretty: string;
  costLamports: number;
  costPretty: string;
  tipLamports: number;
  landingProb: number;
  feeBps: number;
  feeAmount: string;
  feePretty: string;
  userReceives: string;
  userReceivesPretty: string;
  notes: string[];
  reasoning: string;
};

type ParsedIntentWire = {
  kind: 'swap' | 'stake' | 'yield' | 'arb' | 'compose' | 'unknown';
  raw: string;
  params: Record<string, unknown>;
  preference: string;
  confidence: number;
  summary: string;
};

type ApiResponse = {
  intent: ParsedIntentWire;
  ranked: RankedRouteWire[];
  fee?: { bps: number; treasury: string };
  note?: string;
  error?: string;
};

type BuildPreview = {
  txSize: number;
  simUnitsConsumed: number | null;
  quote: {
    inAmount: string;
    outAmount: string;
    otherAmountThreshold: string;
    route: string;
  };
  fee: { bps: number; lamports: string; treasury: string };
  // Cached signed-ready tx so Execute can reuse without re-fetching.
  tx: { kind: 'legacy' | 'v0'; b64: string };
};

type PreviewState =
  | { phase: 'idle' }
  | { phase: 'loading' }
  | { phase: 'ready'; preview: BuildPreview }
  | { phase: 'failed'; error: string };

type ActivityEntry = {
  sig: string;
  blockTime: number | null;
  slot: number;
  status: 'Confirmed' | 'Failed' | 'Processed';
  cardoMemo: string;
  txUrl: string;
};

type SavedIntent = {
  text: string;
  slippageBps: number;
  savedAt: number; // unix ms — also used as id
};

type SubmitState =
  | { phase: 'idle' }
  | { phase: 'submitting' }
  | { phase: 'success'; result: SubmitResult }
  | { phase: 'failed'; error: string };

type SubmitResult = {
  status: string;
  atomic?: boolean;
  // Single-tx flow:
  txSig?: string;
  txUrl?: string;
  // Demo-mode (server-signed) still returns the multi-tx shape:
  bundleId?: string;
  bundleUrl?: string | null;
  txSigs?: string[];
  txUrls?: string[];
  quote?: {
    inAmount: string;
    outAmount: string;
    otherAmountThreshold: string;
    route: string;
  };
  fee?: { bps: number; lamports: string; treasury: string };
  tip?: { lamports: number; account: string };
  elapsedMs?: number;
  err?: unknown;
  error?: string;
};

const EXAMPLES = [
  'swap 0.05 SOL to USDC, cheapest route',
  'stake 0.01 SOL into the safest LST',
  'park $10 USDC for yield, max APY',
  'I have 0.05 SOL and want best output USDC',
];

export default function OrchestratorClient() {
  const [text, setText] = useState('');
  const [loading, setLoading] = useState(false);
  const [resp, setResp] = useState<ApiResponse | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [picked, setPicked] = useState<number | null>(null);
  const [submitState, setSubmitState] = useState<SubmitState>({ phase: 'idle' });
  // Per-route preview cache: rank → simulation result + cached unsigned tx.
  const [previews, setPreviews] = useState<Record<number, PreviewState>>({});
  // User-selected slippage in basis points. 0.1% / 0.5% / 1% / 2% are the
  // useful presets — anything outside that range is unusual.
  const [slippageBps, setSlippageBps] = useState<number>(50);
  const [savedIntents, setSavedIntents] = useState<SavedIntent[]>([]);
  const wallet = useWallet();

  // Hydrate saved intents from localStorage on mount.
  useEffect(() => {
    try {
      const raw = localStorage.getItem('cardo:savedIntents');
      if (raw) setSavedIntents(JSON.parse(raw) as SavedIntent[]);
    } catch {
      // localStorage unavailable (SSR, sandboxed) — start empty.
    }
  }, []);

  const persistSavedIntents = (next: SavedIntent[]) => {
    setSavedIntents(next);
    try {
      localStorage.setItem('cardo:savedIntents', JSON.stringify(next));
    } catch {}
  };

  const onSaveCurrentIntent = () => {
    const trimmed = text.trim();
    if (!trimmed) return;
    const exists = savedIntents.some((s) => s.text === trimmed);
    if (exists) return;
    const next: SavedIntent[] = [
      { text: trimmed, slippageBps, savedAt: Date.now() },
      ...savedIntents.slice(0, 19), // cap at 20 saved
    ];
    persistSavedIntents(next);
  };

  const onDeleteSaved = (savedAt: number) => {
    persistSavedIntents(savedIntents.filter((s) => s.savedAt !== savedAt));
  };

  const onLoadSaved = (s: SavedIntent) => {
    setText(s.text);
    setSlippageBps(s.slippageBps);
  };
  const [activity, setActivity] = useState<ActivityEntry[]>([]);
  const [activityLoading, setActivityLoading] = useState(false);

  // Auto-load recent Cardo activity for the connected wallet. Refreshes
  // when wallet connects/disconnects or after a successful submit.
  useEffect(() => {
    if (!wallet.publicKey) {
      setActivity([]);
      return;
    }
    let cancelled = false;
    setActivityLoading(true);
    fetch(`/api/orchestrate/activity?wallet=${wallet.publicKey.toBase58()}&limit=10`)
      .then((r) => r.json())
      .then((j) => {
        if (cancelled) return;
        setActivity(j.activity ?? []);
      })
      .catch(() => {
        if (!cancelled) setActivity([]);
      })
      .finally(() => {
        if (!cancelled) setActivityLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [wallet.publicKey, submitState.phase === 'success' ? submitState.result.txSig : null]);

  const onAnalyze = async () => {
    if (!text.trim() || loading) return;
    setLoading(true);
    setErr(null);
    setResp(null);
    setPicked(null);
    setSubmitState({ phase: 'idle' });
    setPreviews({});
    try {
      const r = await fetch('/api/orchestrate', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ text }),
      });
      const j = (await r.json()) as ApiResponse;
      if (!r.ok) {
        setErr(j.error ?? `request failed with ${r.status}`);
      } else {
        setResp(j);
        // Auto-select the AI's #1 pick so the Execute panel shows up
        // immediately. User can still click any other route to switch.
        if (j.ranked && j.ranked.length > 0) {
          setPicked(0);
          // Pre-build the top route in the background so the Execute card
          // can show "will receive X / will pay Y / sim ✓" without
          // requiring a click. Other routes build on Execute click.
          if (wallet.publicKey) prefetchPreview(j.intent, 0, j.ranked[0]);
        }
      }
    } catch (e) {
      setErr((e as Error).message ?? String(e));
    } finally {
      setLoading(false);
    }
  };

  /// Pre-fetch the build endpoint for a specific route so we can show
  /// inline simulation results (cost, output, sim verdict) on the card
  /// before the user clicks Execute. Caches the unsigned tx for reuse.
  ///
  /// Only single-tx intents (swap, stake) get preview — yield is
  /// multi-step (Kamino setup + deposit) and compose is iterative
  /// (each step builds at execute time using on-chain balance), so
  /// preview doesn't fit their shapes.
  const prefetchPreview = async (
    intent: ParsedIntentWire,
    rank: number,
    route: RankedRouteWire,
  ) => {
    if (!wallet.publicKey) return;
    if (intent.kind !== 'swap' && intent.kind !== 'stake') return;
    if (previews[rank]?.phase === 'loading' || previews[rank]?.phase === 'ready') return;
    setPreviews((p) => ({ ...p, [rank]: { phase: 'loading' } }));
    try {
      const buildEndpoint = '/api/orchestrate/build';
      const buildRes = await fetch(buildEndpoint, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          intent,
          routeIndex: rank,
          userPubkey: wallet.publicKey.toBase58(),
          inputMint: route.inputMint,
          outputMint: route.outputMint,
          slippageBps,
        }),
      });
      const built = await buildRes.json();
      if (!buildRes.ok) {
        setPreviews((p) => ({
          ...p,
          [rank]: { phase: 'failed', error: built.error ?? 'build failed' },
        }));
        return;
      }
      setPreviews((p) => ({
        ...p,
        [rank]: {
          phase: 'ready',
          preview: {
            txSize: built.txSize,
            simUnitsConsumed: built.simUnitsConsumed ?? null,
            quote: built.quote,
            fee: built.fee,
            tx: built.tx,
          },
        },
      }));
    } catch (e) {
      setPreviews((p) => ({
        ...p,
        [rank]: { phase: 'failed', error: (e as Error).message ?? String(e) },
      }));
    }
  };

  const onExecute = async (rank?: number) => {
    if (!resp || submitState.phase === 'submitting') return;
    // Caller passes rank explicitly when clicking Execute on a row;
    // fall back to currently-picked otherwise.
    const targetRank = rank ?? picked;
    if (targetRank === null) return;
    if (rank !== undefined) setPicked(rank);
    const useUserWallet = wallet.connected && wallet.publicKey;
    // User-custody only: the user connects their own Solana wallet and signs
    // client-side. There is no server-signed "demo" fallback — Cardo holds no
    // key on the pod (that path ENOENT'd on `orchestrator-v1.key`, which is
    // never deployed). No wallet → ask them to connect, don't server-sign.
    if (!useUserWallet) {
      setSubmitState({ phase: 'failed', error: 'Connect a Solana wallet to execute.' });
      return;
    }

    setSubmitState({ phase: 'submitting' });

    try {
      await executeWithUserWallet(resp.intent, targetRank);
    } catch (e) {
      setSubmitState({
        phase: 'failed',
        error: (e as Error).message ?? String(e),
      });
    }
  };

  /// User-wallet flow: server builds ONE combined-swap-fee tx → wallet
  /// signs (one popup) → server relays via Solana RPC.
  ///
  /// **Invariant**: user pays only if the swap landed. Solana tx-level
  /// atomicity guarantees this — if the swap reverts, the fee transfer
  /// also doesn't execute (single tx, all-or-nothing).
  const executeWithUserWallet = async (
    intent: ParsedIntentWire,
    routeIndex: number,
  ) => {
    if (!wallet.publicKey || !wallet.signTransaction) {
      throw new Error('wallet missing signTransaction capability');
    }

    // Yield uses a different build endpoint that returns 1 or 2 steps
    // depending on whether the user already has Kamino setup. Each
    // step is signed and submitted sequentially.
    if (intent.kind === 'yield') {
      return executeYieldFlow(intent);
    }

    // Compose chains multiple sub-intents (swap then yield, etc.). Each
    // step is signed in its own popup; between steps, the server reads
    // the user's actual on-chain balance to size the next step's input.
    if (intent.kind === 'compose') {
      return executeComposeFlow(intent);
    }

    // Step 1: build the single combined tx. If we already pre-fetched
    // this route's preview after analyze, reuse the cached unsigned tx
    // — saves a round-trip + a Jupiter quote (the preview's blockhash
    // is still fresh enough for signing within ~60s).
    const cached = previews[routeIndex];
    let built: {
      tx: { kind: 'legacy' | 'v0'; b64: string };
      quote: BuildPreview['quote'];
      fee: BuildPreview['fee'];
    };
    if (cached?.phase === 'ready') {
      built = {
        tx: cached.preview.tx,
        quote: cached.preview.quote,
        fee: cached.preview.fee,
      };
    } else {
      const pickedRoute = resp?.ranked[routeIndex];
      const buildEndpoint = '/api/orchestrate/build';
      const buildRes = await fetch(buildEndpoint, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          intent,
          routeIndex,
          userPubkey: wallet.publicKey.toBase58(),
          inputMint: pickedRoute?.inputMint,
          outputMint: pickedRoute?.outputMint,
          slippageBps,
        }),
      });
      const j = await buildRes.json();
      if (!buildRes.ok) {
        throw new Error(j.error ?? `build failed with ${buildRes.status}`);
      }
      built = j;
    }

    // Step 2: deserialize, sign, re-serialize
    const buf = Buffer.from(built.tx.b64, 'base64');
    const txObj =
      built.tx.kind === 'v0'
        ? VersionedTransaction.deserialize(buf)
        : Transaction.from(buf);
    const signed = (await wallet.signTransaction(txObj)) as
      | Transaction
      | VersionedTransaction;
    const signedBuf =
      signed instanceof VersionedTransaction
        ? Buffer.from(signed.serialize())
        : (signed as Transaction).serialize();

    // Step 3: send to relay (sendRawTransaction + confirm)
    const relayRes = await fetch('/api/orchestrate/relay', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        tx: { kind: built.tx.kind, b64: signedBuf.toString('base64') },
      }),
    });
    const relayed = (await relayRes.json()) as SubmitResult;
    if (!relayRes.ok && relayed.status !== 'Failed') {
      throw new Error(relayed.error ?? `relay failed with ${relayRes.status}`);
    }
    if (relayed.status === 'Failed') {
      // Tx landed but reverted on-chain (slippage, etc.). Per the
      // invariant: user paid network fee (~$0.001) but no swap, no
      // Cardo fee — atomic rollback within the tx.
      throw new Error(
        relayed.error ?? 'tx reverted on-chain (no swap, no Cardo fee charged)',
      );
    }

    setSubmitState({
      phase: 'success',
      result: {
        ...relayed,
        quote: built.quote,
        fee: built.fee,
      },
    });
  };

  /// Yield flow — Kamino USDC supply. Returns 1-2 steps (setup +
  /// deposit). Each step is signed + relayed sequentially. If step 1
  /// (setup) fails, step 2 doesn't fire. If step 1 succeeds and step 2
  /// fails, the user has paid setup rent (~0.003 SOL, recoverable on
  /// close); no Cardo fee since deposit didn't land.
  const executeYieldFlow = async (intent: ParsedIntentWire) => {
    if (!wallet.publicKey || !wallet.signTransaction) {
      throw new Error('wallet missing signTransaction capability');
    }
    const buildRes = await fetch('/api/orchestrate/build-yield', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        intent,
        userPubkey: wallet.publicKey.toBase58(),
        amountInUsdc: intent.params.amountInUsdc,
      }),
    });
    const built = await buildRes.json();
    if (!buildRes.ok) {
      throw new Error(built.error ?? `build-yield failed with ${buildRes.status}`);
    }
    const steps = built.steps as Array<{
      label: string;
      description: string;
      kind: 'legacy' | 'v0';
      b64: string;
    }>;
    if (!steps.length) throw new Error('no steps returned');

    const allSigs: { label: string; sig: string; url: string }[] = [];
    for (const step of steps) {
      const buf = Buffer.from(step.b64, 'base64');
      const txObj =
        step.kind === 'v0'
          ? VersionedTransaction.deserialize(buf)
          : Transaction.from(buf);
      const signed = (await wallet.signTransaction(txObj)) as
        | Transaction
        | VersionedTransaction;
      const signedBuf =
        signed instanceof VersionedTransaction
          ? Buffer.from(signed.serialize())
          : (signed as Transaction).serialize();

      const relayRes = await fetch('/api/orchestrate/relay', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          tx: { kind: step.kind, b64: signedBuf.toString('base64') },
        }),
      });
      const relayed = (await relayRes.json()) as SubmitResult & { error?: string };
      if (!relayRes.ok && relayed.status !== 'Failed') {
        throw new Error(
          `${step.label} relay failed: ${relayed.error ?? relayRes.status}`,
        );
      }
      if (relayed.status === 'Failed') {
        throw new Error(
          `${step.label} reverted on-chain: ${relayed.error ?? 'unknown'}`,
        );
      }
      if (relayed.txSig && relayed.txUrl) {
        allSigs.push({
          label: step.label,
          sig: relayed.txSig,
          url: relayed.txUrl,
        });
      }
    }

    setSubmitState({
      phase: 'success',
      result: {
        status: 'Confirmed',
        atomic: false, // multi-step
        bundleId: '',
        bundleUrl: null,
        txSig: allSigs[allSigs.length - 1]?.sig,
        txUrl: allSigs[allSigs.length - 1]?.url,
        // Repurpose txSigs/txUrls for the per-step list
        txSigs: allSigs.map((s) => s.sig),
        txUrls: allSigs.map((s) => s.url),
        fee: built.fee,
      },
    });
  };

  /// Compose flow — sequential single-popup-per-step execution.
  ///
  /// For each step in intent.params.steps:
  ///   1. POST /api/orchestrate/build-compose-step (server reads user's
  ///      actual on-chain balance for steps > 0 → builds tx with real
  ///      input amount, not the AI's estimate)
  ///   2. signTransaction (one Phantom popup)
  ///   3. POST /api/orchestrate/relay → wait for confirm
  ///   4. Move to step N+1 (now reading the chain reflects step N output)
  ///
  /// Invariant per step: each step is its own atomic-by-tx. If step N
  /// reverts, no Cardo fee for step N. If step N succeeds and step
  /// N+1 reverts, user has the intermediate token (e.g., USDC after a
  /// swap before yield) and only paid the Cardo fee for step N.
  const executeComposeFlow = async (intent: ParsedIntentWire) => {
    if (!wallet.publicKey || !wallet.signTransaction) {
      throw new Error('wallet missing signTransaction capability');
    }
    const steps = (intent.params.steps as Array<unknown>) ?? [];
    if (!steps.length) throw new Error('compose intent has no steps');

    const allSigs: { label: string; sig: string; url: string }[] = [];

    for (let i = 0; i < steps.length; i++) {
      // Build this compose step. Server reads on-chain balance for i > 0
      // and returns 1 OR 2 sub-txs (yield can return setup + deposit
      // when the user has no Kamino obligation yet).
      const buildRes = await fetch('/api/orchestrate/build-compose-step', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          intent,
          stepIndex: i,
          userPubkey: wallet.publicKey.toBase58(),
          slippageBps,
        }),
      });
      const built = await buildRes.json();
      if (!buildRes.ok) {
        throw new Error(
          built.error ?? `step ${i + 1} build failed (${buildRes.status})`,
        );
      }
      const { txs, label } = built as {
        txs: Array<{ kind: 'legacy' | 'v0'; b64: string; subLabel?: string }>;
        label: string;
      };

      // Sign + submit each sub-tx in sequence. Most steps have 1 sub-tx;
      // a yield-with-first-time-Kamino-setup has 2 (setup + deposit).
      for (let j = 0; j < txs.length; j++) {
        const sub = txs[j];
        const subLabel = txs.length > 1
          ? `${label} (${j + 1}/${txs.length}${sub.subLabel ? ': ' + sub.subLabel.replace(/^Step \d+ of \d+ · /, '') : ''})`
          : label;
        const buf = Buffer.from(sub.b64, 'base64');
        const txObj =
          sub.kind === 'v0'
            ? VersionedTransaction.deserialize(buf)
            : Transaction.from(buf);
        const signed = (await wallet.signTransaction(txObj)) as
          | Transaction
          | VersionedTransaction;
        const signedBuf =
          signed instanceof VersionedTransaction
            ? Buffer.from(signed.serialize())
            : (signed as Transaction).serialize();
        const relayRes = await fetch('/api/orchestrate/relay', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            tx: { kind: sub.kind, b64: signedBuf.toString('base64') },
          }),
        });
        const relayed = (await relayRes.json()) as SubmitResult & { error?: string };
        if (!relayRes.ok && relayed.status !== 'Failed') {
          throw new Error(
            `${subLabel} relay failed: ${relayed.error ?? relayRes.status}`,
          );
        }
        if (relayed.status === 'Failed') {
          throw new Error(
            `${subLabel} reverted on-chain: ${relayed.error ?? 'unknown'}`,
          );
        }
        if (relayed.txSig && relayed.txUrl) {
          allSigs.push({ label: subLabel, sig: relayed.txSig, url: relayed.txUrl });
        }
      }
    }

    setSubmitState({
      phase: 'success',
      result: {
        status: 'Confirmed',
        atomic: false, // multi-step, but each step is atomic
        bundleId: '',
        bundleUrl: null,
        txSig: allSigs[allSigs.length - 1]?.sig,
        txUrl: allSigs[allSigs.length - 1]?.url,
        txSigs: allSigs.map((s) => s.sig),
        txUrls: allSigs.map((s) => s.url),
      },
    });
  };

  return (
    <main className={s.orchwrap}>
      <div className={s.strip}>
        <div className={s.lead}>
          <span className={s.eyebrow}>Cardo Orchestrator · natural language → ranked routes</span>
          <h1>
            Tell Cardo what you want. <em>It picks the route.</em>
          </h1>
        </div>
        <span className={s.routepill}>
          <span className={`${s.dot} ${s.sol}`} /> Solana <span className={s.ar}>·</span> Mainnet
        </span>
      </div>
      <p className={s.usd} style={{ marginTop: 4, maxWidth: 720 }}>
        Plain English → AI ranks Solana routes → atomic execute. Cardo charges{' '}
        {(CARDO_FEE_BPS / 100).toFixed(2)}% only if your trade lands. Reverts cost ~$0.001 network fee.
      </p>

      {/* Saved intents — quick re-run chips */}
      {savedIntents.length > 0 && (
        <div className={s.orchsaved}>
          <span className="lbl">Saved</span>
          {savedIntents.map((si) => (
            <span key={si.savedAt} className={s.orchchip}>
              <button type="button" onClick={() => onLoadSaved(si)} title={si.text}>
                {si.text}
              </button>
              <span className="pct">{(si.slippageBps / 100).toFixed(1)}%</span>
              <button type="button" className="del" onClick={() => onDeleteSaved(si.savedAt)} title="Delete saved intent">
                ×
              </button>
            </span>
          ))}
        </div>
      )}

      {/* Intent composer */}
      <div className={s.orchcard}>
        <span className={s.eyebrow}>Your intent</span>
        <textarea
          className={s.orchta}
          value={text}
          onChange={(e) => setText(e.target.value)}
          placeholder="e.g. swap 0.05 SOL to USDC, cheapest route"
          rows={3}
        />

        <div className={s.orchpills}>
          {EXAMPLES.map((ex) => (
            <button key={ex} type="button" className={s.orchpill} onClick={() => setText(ex)} disabled={loading}>
              {ex}
            </button>
          ))}
        </div>

        <div className={s.orchslip}>
          <span className="lbl">Max slippage</span>
          {[10, 50, 100, 200].map((bps) => (
            <button
              key={bps}
              type="button"
              className={`${s.orchpill} ${slippageBps === bps ? s.pon : ''}`}
              onClick={() => setSlippageBps(bps)}
            >
              {(bps / 100).toFixed(bps < 100 ? 1 : 0)}%
            </button>
          ))}
          <span className="hint">slippage = max output deviation; outputs below get rejected on chain.</span>
        </div>

        <div className={s.orchactions}>
          <button type="button" className={s.cta} disabled={!text.trim() || loading} onClick={onAnalyze} style={{ minWidth: 180 }}>
            <span>{loading ? 'Analyzing…' : 'Analyze intent'}</span>
          </button>
          <button
            type="button"
            className={`${s.btn} ${s.ghost}`}
            disabled={!text.trim() || loading}
            onClick={onSaveCurrentIntent}
            title="Save this intent + slippage locally to re-run later"
          >
            ★ Save
          </button>
          {wallet.connected && (
            <a
              href="https://phantom.com/learn/blog/auto-approve"
              target="_blank"
              rel="noreferrer"
              className={s.orchaa}
              title="Phantom's Auto-Approve setting lets you skip per-tx popups for trusted dApps"
            >
              skip Phantom popups (auto-approve)
            </a>
          )}
        </div>

        {err && <div className={s.orcherr}>{err}</div>}
      </div>

      {/* Parsed intent — single line, inline with the routes */}
      {resp?.intent && (
        <div className={s.orchparsed}>
          <b>{resp.intent.summary}</b>
          <span className="meta">
            ({resp.intent.kind} · {resp.intent.preference} · {(resp.intent.confidence * 100).toFixed(0)}% conf)
          </span>
        </div>
      )}

      {/* Ranked routes */}
      {resp?.ranked && resp.ranked.length > 0 && (
        <>
          <div className={s.orchhead}>
            <span className={s.eyebrow}>{resp.ranked.length} ranked option{resp.ranked.length === 1 ? '' : 's'}</span>
            <span className="sub">#1 is the AI&apos;s pick. Hit Execute on whichever route you want.</span>
          </div>

          <div className={s.orchroutes}>
            {resp.ranked.map((r) => {
              const isExecuting =
                submitState.phase === 'submitting' && picked === r.rank;
              const isExecuted =
                submitState.phase === 'success' && picked === r.rank;
              const isFailed =
                submitState.phase === 'failed' && picked === r.rank;
              return (
                <RouteCard
                  key={`${r.rank}-${r.label}`}
                  route={r}
                  isTop={r.rank === 0}
                  intentKind={resp.intent.kind}
                  walletConnected={wallet.connected}
                  walletAddress={wallet.publicKey?.toBase58()}
                  isExecuting={isExecuting}
                  isExecuted={isExecuted}
                  isFailed={isFailed}
                  // Disable all other buttons while one is mid-flight
                  disabled={
                    submitState.phase === 'submitting' && picked !== r.rank
                  }
                  result={isExecuted ? submitState.result : null}
                  errorMsg={isFailed ? submitState.error : null}
                  preview={previews[r.rank] ?? { phase: 'idle' }}
                  onPrefetchPreview={() =>
                    prefetchPreview(resp.intent, r.rank, r)
                  }
                  onExecute={() => onExecute(r.rank)}
                />
              );
            })}
          </div>
        </>
      )}

      {/* No-routes / unknown / note states */}
      {resp && resp.ranked.length === 0 && (
        <div className={s.orchcard}>
          <span className={s.eyebrow}>No routes</span>
          <p className={s.usd} style={{ marginTop: 10 }}>
            {resp.note ?? 'Could not produce routes for this intent.'}
          </p>
        </div>
      )}

      {/* Recent activity at bottom — collapsed by default, expand on demand */}
      {wallet.connected && activity.length > 0 && (
        <RecentActivityPanel entries={activity} loading={activityLoading} />
      )}
    </main>
  );
}

function RouteCard({
  route,
  isTop,
  intentKind,
  walletConnected,
  walletAddress,
  isExecuting,
  isExecuted,
  isFailed,
  disabled,
  result,
  errorMsg,
  preview,
  onPrefetchPreview,
  onExecute,
}: {
  route: RankedRouteWire;
  isTop: boolean;
  intentKind: string;
  walletConnected: boolean;
  walletAddress?: string;
  isExecuting: boolean;
  isExecuted: boolean;
  isFailed: boolean;
  disabled: boolean;
  result: SubmitResult | null;
  errorMsg: string | null;
  preview: PreviewState;
  onPrefetchPreview: () => void;
  onExecute: () => void;
}) {
  const supported =
    intentKind === 'swap' ||
    intentKind === 'stake' ||
    intentKind === 'yield' ||
    intentKind === 'compose';
  const cardCls = `${s.orchroute} ${isExecuted || isExecuting ? s.orchon : isTop ? s.orchtop : ''}`;
  return (
    <div className={cardCls}>
      <div className="rtop">
        <div>
          <div style={{ display: 'flex', gap: 10, alignItems: 'center', flexWrap: 'wrap' }}>
            <span className={`rank ${isTop ? 'aipick' : ''}`}>
              {isTop ? 'AI PICK · ' : ''}#{route.rank + 1}
            </span>
            <span className="rlabel">{route.label}</span>
          </div>
          <div className="rstats">
            <Stat k="You receive" v={route.userReceivesPretty} highlight />
            <Stat k="Cardo fee" v={`${route.feePretty}`} />
            <Stat k="Net cost" v={route.costPretty} />
          </div>
        </div>
        <button
          type="button"
          className={s.cta}
          disabled={!supported || disabled || isExecuting || isExecuted}
          onClick={onExecute}
          style={{ minWidth: 132, whiteSpace: 'nowrap' }}
        >
          <span>
            {isExecuted
              ? '✓ Executed'
              : isExecuting
                ? walletConnected
                  ? 'Sign in wallet…'
                  : 'Submitting…'
                : !supported
                  ? 'Coming soon'
                  : walletConnected
                    ? 'Execute'
                    : 'Connect wallet'}
          </span>
        </button>
      </div>

      <p className="rreason">{route.reasoning}</p>

      {/* Per-card execution status */}
      {isExecuted && result && (
        <div className={s.orchok}>
          <div className="lead">✓ Landed in {((result.elapsedMs ?? 0) / 1000).toFixed(1)}s</div>
          {result.txUrl && (
            <a href={result.txUrl} target="_blank" rel="noreferrer">
              tx {result.txSig?.slice(0, 12)}… on Solscan →
            </a>
          )}
        </div>
      )}

      {isFailed && errorMsg && <div className={s.orchfail}>{errorMsg}</div>}

      {!supported && (
        <p className={s.orchnote} style={{ color: 'var(--bad)' }}>
          Execute for {intentKind} intents not wired yet — AI ranking runs but on-chain builder is pending.
        </p>
      )}

      {/* Inline simulation preview — only for single-tx intents.
          Compose/yield don't fit the single-tx preview model (compose
          builds each step at execute time using on-chain balance;
          yield is multi-step Kamino setup+deposit). */}
      {walletConnected &&
        supported &&
        !isExecuted &&
        !isExecuting &&
        (intentKind === 'swap' || intentKind === 'stake') && (
          <PreviewLine
            state={preview}
            onLoad={onPrefetchPreview}
          />
        )}

      {walletConnected && walletAddress && supported && !isExecuting && !isExecuted && !isFailed && (
        <p className={s.orchnote} style={{ fontFamily: 'var(--mono)', color: 'var(--faint)' }}>
          will sign with {walletAddress.slice(0, 6)}…{walletAddress.slice(-4)}
        </p>
      )}
    </div>
  );
}

function PreviewLine({
  state,
  onLoad,
}: {
  state: PreviewState;
  onLoad: () => void;
}) {
  // Auto-trigger prefetch on mount if idle (avoids requiring a hover/click).
  useEffect(() => {
    if (state.phase === 'idle') onLoad();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  if (state.phase === 'idle' || state.phase === 'loading') {
    return <p className={s.orchnote} style={{ color: 'var(--faint)' }}>Simulating…</p>;
  }
  if (state.phase === 'failed') {
    return <p className={s.orchnote} style={{ color: 'var(--bad)', wordBreak: 'break-word' }}>Sim failed: {state.error.slice(0, 200)}</p>;
  }
  const { preview } = state;
  return (
    <div className={s.orchsim}>
      <span>sim ✓ <span className="mono">{preview.simUnitsConsumed ?? '?'}</span> CU</span>
      <span>route <span className="mono">{preview.quote.route}</span></span>
      <span>
        out <span className="mono">{preview.quote.outAmount}</span>
        {' (≥ '}<span className="mono">{preview.quote.otherAmountThreshold}</span>{')'}
      </span>
    </div>
  );
}

function RecentActivityPanel({
  entries,
  loading,
}: {
  entries: ActivityEntry[];
  loading: boolean;
}) {
  if (!loading && entries.length === 0) return null;
  return (
    <div className={s.orchcard} style={{ marginTop: 24 }}>
      <span className={s.eyebrow}>Your recent Cardo activity</span>
      {loading && <p className={s.usd} style={{ marginTop: 10 }}>Loading…</p>}
      {!loading && entries.length > 0 && (
        <div className={s.orchact}>
          {entries.map((e) => (
            <ActivityRow key={e.sig} entry={e} />
          ))}
        </div>
      )}
    </div>
  );
}

function ActivityRow({ entry }: { entry: ActivityEntry }) {
  const ago = entry.blockTime ? relativeTime(entry.blockTime) : '—';
  // Pretty memo: strip "cardo:" prefix, clean up arrows
  const memoPretty = entry.cardoMemo
    .replace(/^cardo:/, '')
    .replace(/orchestrator swap /, '')
    .replace(/swap done/, 'done')
    .replace(/fee \d+bps/, 'fee');
  return (
    <a className={s.orchrow} href={entry.txUrl} target="_blank" rel="noreferrer">
      <span className={`st ${entry.status === 'Confirmed' ? 'good' : 'bad'}`}>
        {entry.status === 'Confirmed' ? '✓' : '✗'}
      </span>
      <span className="memo">{memoPretty}</span>
      <span className="meta">{ago}</span>
      <span className="meta">{entry.sig.slice(0, 6)}…</span>
    </a>
  );
}

function relativeTime(unixSec: number): string {
  const diffMs = Date.now() - unixSec * 1000;
  const sec = Math.floor(diffMs / 1000);
  if (sec < 60) return `${sec}s ago`;
  const min = Math.floor(sec / 60);
  if (min < 60) return `${min}m ago`;
  const hr = Math.floor(min / 60);
  if (hr < 24) return `${hr}h ago`;
  const day = Math.floor(hr / 24);
  return `${day}d ago`;
}

function Stat({ k, v, highlight }: { k: string; v: string; highlight?: boolean }) {
  return (
    <div className={`${s.orchstat} ${highlight ? s.hi : ''}`}>
      <div className="k">{k}</div>
      <div className="v">{v}</div>
    </div>
  );
}
