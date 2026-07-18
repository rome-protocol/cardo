// Swap route `/swap` — designer's Swap screen + live on-chain data path.
//
// Data sources (all live as of PR feat-swap-onchain-data):
//   - Tokens: `useChainTokens` enumerates ERC20SPLFactory, falls back
//     to {USDC-A, WSOL-B} when the factory is empty.
//   - Prices: `useOraclePrices` reads Oracle Gateway V2 adapters (SOL,
//     USDC, ETH, BTC, USDT) — WSOL shares the SOL feed.
//   - Balances: `useTokenBalances` reads ERC20 `balanceOf` per wrapper.
//   - Quote cost: `useQuoteCost` on the RomeCross adapter — provides
//     `output.expectedAmount`, `fees[0].feeBps`, and `oracleReads`.
//   - Gas: `useSwapGasEstimate` runs wagmi's `useEstimateGas` against
//     the same CPI precompile calldata the submit path uses. Combined
//     with the live ETH/USD oracle below we derive a USD figure.
//
// Write path: bypasses MeteoraCpiAdapter entirely. Builds the 15-account
// Meteora swap instruction, wraps it in `invoke(program, accounts, data)`,
// and submits via wagmi to the CPI precompile (0xFF…08). Because
// `msg.sender at precompile == userEoa`, Rome auto-signs for
// `PDA(EXTERNAL_AUTHORITY, userEoa)` — which also owns the user's SPL
// ATAs — so Meteora's signer check on account[11] lines up.
//
// This sidesteps the adapter/Backend signer-mismatch bug documented in
// the Rome EVM program. Option B (keep Adapter + remove Backend signer
// frame) is tracked separately as task #108.

'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import { parseUnits, type Address, type Hex } from 'viem';
import { useWaitForTransactionReceipt } from 'wagmi';
import { useRomeWrite } from '@/lib/use-rome-write';
import { Swap } from '@/components/screens/Swap';
import { useWallet } from '../wallet-context';
import { CPI_PRECOMPILE, CPI_INVOKE_ABI } from '@/lib/cpi-precompile';
import {
  buildChainMeteoraSwapInvoke,
  type SwapDirection,
} from '@/lib/meteora-swap';
import { ROME_METEORA_POOLS } from '@/lib/meteora-pool';
import { useTokenBalances } from '@/lib/use-token-balances';
import { useSolanaTokenBalances } from '@/lib/use-solana-balances';
import { bytes32ToPublicKey, deriveAta, deriveRomeUserPda, pubkeyBs58ToBytes32 } from '@/lib/solana-pda';
import { useAtaInit } from '@/lib/use-ata-init';
import { useUserDeployedTokens } from '@/lib/use-user-deployed-tokens';
import { useUserPools } from '@/lib/use-user-pools';
import { useChainTokens } from '@/lib/use-chain-tokens';
import { useOraclePrices } from '@/lib/use-oracle-prices';
import { useSwapGasEstimate } from '@/lib/use-gas-estimate';
import { useRegisterWrapper } from '@/lib/use-register-wrapper';
import { useSignaturePlan } from '@/lib/use-signature-plan';
import { usePoolReserves } from '@/lib/use-pool-reserves';
import { constantProductOut, applySlippage } from '@/lib/pool-quote';

type QuoteInputs = {
  fromSym: string;
  toSym: string;
  amount: number;
  slippagePct: number;
};

// Resolve swap direction from the *selected pool's* A/B mint order.
// The canonical 0.25% pool has A=WSOL, B=USDC; the user-created 4.0%
// pool flipped that to A=USDC, B=WSOL (caller's choice at init time).
// So we can't hardcode — check the pool's splMintA against the input
// token's mint to figure out which way to swap.
//
// Returns null for unroutable pairs — the cost panel falls back to
// oracle-only pricing and submit shows "no pool" copy.
function resolveDirection(
  pool: (typeof ROME_METEORA_POOLS)[number]['pool'],
  fromMintHex: string,
  toMintHex: string,
): SwapDirection | null {
  const a = pool.splMintA.toLowerCase();
  const b = pool.splMintB.toLowerCase();
  const f = fromMintHex.toLowerCase();
  const t = toMintHex.toLowerCase();
  if (f === a && t === b) return 'AToB';
  if (f === b && t === a) return 'BToA';
  return null;
}


// Conservative gas-cost assumptions for Rome, mirrored from the submit
// path below. 11 gwei is what we put on the wire in writeContract; 50M
// gas is the upper-bound ceiling so estimateGas can't get wedged by a
// too-tight limit.
const ROME_GAS_PRICE_GWEI = 11n;
const ROME_GAS_PRICE_WEI = ROME_GAS_PRICE_GWEI * 1_000_000_000n;

export default function Page() {
  const { wallet, connect } = useWallet();
  const [quoteInputs, setQuoteInputs] = useState<QuoteInputs | null>(null);

  // Selected fee-tier pool. Defaults to the canonical 25-bps pool
  // (deepest liquidity). Set lazily below once we know which pools
  // route the current pair.
  const [selectedFeeBps, setSelectedFeeBps] = useState<number>(25);

  // Live token list (factory enumeration + fallback for empty factory)
  // merged with any tokens the user has deployed via /pool/new. The
  // user-deployed entries persist via localStorage so they show up
  // here without us redeploying Cardo.
  const { tokens: factoryTokens, fromFallback: tokensFromFallback } =
    useChainTokens();
  const { tokens: userTokens } = useUserDeployedTokens();
  // User-created Meteora pools — join the static fee-tier registry
  // so /swap can route through them.
  const { pools: userPools } = useUserPools();
  const chainTokens = useMemo(() => {
    const seen = new Set(factoryTokens.map((t) => t.address.toLowerCase()));
    // A wrapper is swappable if any user-created pool routes it.
    // (Static pools' wrappers are already marked swappable in
    // ROME_STATIC_TOKENS.)
    const userPooledWrappers = new Set<string>();
    for (const p of userPools) {
      userPooledWrappers.add(p.wrapperA);
      userPooledWrappers.add(p.wrapperB);
    }
    const merged = [
      ...factoryTokens,
      ...userTokens.filter((t) => !seen.has(t.address.toLowerCase())),
    ];
    return merged.map((t) =>
      userPooledWrappers.has(t.address.toLowerCase())
        ? { ...t, swappable: true }
        : t,
    );
  }, [factoryTokens, userTokens, userPools]);

  // Live balanceOf reads per wrapper. Two sources we merge:
  //
  //   evmBalances — from wagmi useReadContract; reads the ERC20 wrapper.
  //     Reverts with "Token account does not exist" until the user has
  //     called create_user on each wrapper. Returns nothing for those.
  //
  //   solBalances — direct Solana RPC read of the user's PDA-owned ATA.
  //     Always works whether or not the wrapper has been initialized for
  //     this user, because the SPL ATA is the source of truth.
  //
  // We merge with EVM-first preference: when wrapper.balanceOf returns a
  // value, trust it (it's the canonical ERC20 view). Otherwise fall back
  // to Solana-direct so the UI never lies that the user has 0 tokens
  // when they actually hold SPL on the Solana side.
  const tokenAddresses = useMemo<Address[]>(
    () => chainTokens.map((t) => t.address),
    [chainTokens],
  );
  const { balances: evmBalances, registration } = useTokenBalances(
    tokenAddresses,
    wallet.connected && wallet.address ? (wallet.address as Address) : undefined,
  );

  // factoryRegistered: true when at least one wrapper.balanceOf has
  // returned for this user. The factory's `_users` registry is shared
  // across all wrappers, so a single success means the user is already
  // registered with the factory and we can skip create_user — that's one
  // fewer wallet popup when adding additional wrappers.
  const factoryRegistered = useMemo(
    () => Object.values(registration).some((r) => r === 'registered'),
    [registration],
  );

  const splTokenSpecs = useMemo(
    () =>
      chainTokens.map((t) => ({
        wrapper: t.address,
        mintAddress: t.mintAddress,
      })),
    [chainTokens],
  );
  const solBalances = useSolanaTokenBalances(
    splTokenSpecs,
    wallet.connected && wallet.address ? (wallet.address as Address) : undefined,
  );

  const balances = useMemo(() => {
    const merged: Record<string, bigint> = {};
    for (const t of chainTokens) {
      const key = t.address.toLowerCase();
      const evm = evmBalances[key];
      const sol = solBalances[key];
      // Prefer Solana-direct since the wrapper may not be initialized for
      // this user — it gives the truthful balance regardless. If both are
      // present and disagree, that signals a bridge desync (worth a log).
      if (sol !== undefined) {
        merged[key] = sol;
        if (evm !== undefined && evm !== sol) {
          // eslint-disable-next-line no-console
          console.warn(
            `[cardo] EVM/Solana balance mismatch for ${t.symbol}: evm=${evm} sol=${sol}`,
          );
        }
      } else if (evm !== undefined) {
        merged[key] = evm;
      }
    }
    return merged;
  }, [chainTokens, evmBalances, solBalances]);

  // Live oracle prices for SOL/USDC/WSOL/ETH/BTC/USDT.
  const { prices, loading: pricesLoading } = useOraclePrices();

  // Helper: per-symbol on-chain decimals + SPL mint, sourced from the
  // live token list so the UI doesn't drift from the deployed wrapper's
  // config. mintHex is the 0x-prefixed bytes32 form of the SPL mint —
  // we need it to resolve swap direction against the selected pool's
  // A/B labels (which are mints, not symbols).
  const symbolToTok = useMemo<
    Record<
      string,
      { addr: Address; decimals: number; mintHex: Hex } | undefined
    >
  >(() => {
    const m: Record<string, { addr: Address; decimals: number; mintHex: Hex }> = {};
    for (const t of chainTokens) {
      const mintHex = pubkeyBs58ToBytes32(t.mintAddress);
      m[t.symbol] = { addr: t.address, decimals: t.decimals, mintHex };
    }
    // SOL alias row — picker + encoder both treat SOL/WSOL as WWSOL on Rome.
    if (m['WSOL'] && !m['SOL']) m['SOL'] = m['WSOL'];
    if (m['WWSOL']) {
      if (!m['WSOL']) m['WSOL'] = m['WWSOL'];
      if (!m['SOL']) m['SOL'] = m['WWSOL'];
    }
    if (m['WUSDC'] && !m['USDC']) m['USDC'] = m['WUSDC'];
    return m;
  }, [chainTokens]);

  // Pools available for the *current pair*. Combines the canonical
  // static pools (USDC↔WSOL @ 25/400 bps) with any user-created pools
  // whose token A/B matches the chosen pair.
  const activePoolOptions = useMemo(() => {
    if (!quoteInputs) return [] as Array<{ feeBps: number; label: string; pool: typeof ROME_METEORA_POOLS[number]['pool'] }>;
    const fromTok = symbolToTok[quoteInputs.fromSym];
    const toTok = symbolToTok[quoteInputs.toSym];
    if (!fromTok || !toTok) return [];
    const fromMint = fromTok.mintHex.toLowerCase();
    const toMint = toTok.mintHex.toLowerCase();
    const out: Array<{ feeBps: number; label: string; pool: typeof ROME_METEORA_POOLS[number]['pool'] }> = [];
    for (const p of ROME_METEORA_POOLS) {
      const a = p.pool.splMintA.toLowerCase();
      const b = p.pool.splMintB.toLowerCase();
      if ((a === fromMint && b === toMint) || (a === toMint && b === fromMint)) {
        out.push(p);
      }
    }
    for (const up of userPools) {
      const a = up.pool.splMintA.toLowerCase();
      const b = up.pool.splMintB.toLowerCase();
      if ((a === fromMint && b === toMint) || (a === toMint && b === fromMint)) {
        out.push({ feeBps: up.feeBps, label: up.label, pool: up.pool });
      }
    }
    const seen = new Set<string>();
    return out.filter((p) => {
      const k = p.pool.pool.toLowerCase();
      if (seen.has(k)) return false;
      seen.add(k);
      return true;
    });
  }, [quoteInputs, symbolToTok, userPools]);

  const selectedPool = useMemo(() => {
    if (activePoolOptions.length === 0) {
      return ROME_METEORA_POOLS[0].pool;
    }
    const match = activePoolOptions.find((p) => p.feeBps === selectedFeeBps);
    return (match ?? activePoolOptions[0]).pool;
  }, [activePoolOptions, selectedFeeBps]);

  // Real per-pair routability: does a Meteora pool actually route the CURRENT
  // pair? undefined until the screen emits its first quote (don't flash "no
  // pool" before we know). This is the truth the submit gate needs — the
  // per-token "swappable" flag let unroutable pairs through to a revert.
  const pairRoutable = quoteInputs ? activePoolOptions.length > 0 : undefined;

  // Canonical routable default pair, mapped from the first live pool's mints so
  // /swap opens on a pair that actually routes (e.g. wUSDC→wSOL).
  const defaultPair = useMemo(() => {
    const pool = ROME_METEORA_POOLS[0]?.pool;
    if (!pool) return undefined;
    const a = pool.splMintA.toLowerCase();
    const b = pool.splMintB.toLowerCase();
    let aSym: string | undefined;
    let bSym: string | undefined;
    for (const [sym, tok] of Object.entries(symbolToTok)) {
      if (!tok) continue;
      const m = tok.mintHex.toLowerCase();
      if (m === a) aSym = sym;
      if (m === b) bSym = sym;
    }
    // Canonical pool is A=WSOL, B=USDC → default to USDC→WSOL.
    return aSym && bSym ? { fromSym: bSym, toSym: aSym } : undefined;
  }, [symbolToTok]);

  const onQuoteInputsChange = useCallback((q: QuoteInputs) => {
    setQuoteInputs(q);
  }, []);

  const { amountInBI, direction } = useMemo<{
    amountInBI: bigint;
    direction: SwapDirection | null;
  }>(() => {
    if (!quoteInputs || quoteInputs.amount <= 0) {
      return { amountInBI: 0n, direction: null };
    }
    const fromTok = symbolToTok[quoteInputs.fromSym];
    const toTok = symbolToTok[quoteInputs.toSym];
    if (!fromTok || !toTok) {
      return { amountInBI: 0n, direction: null };
    }
    try {
      const amountIn = parseUnits(String(quoteInputs.amount), fromTok.decimals);
      // Resolve direction against the *selected* pool's A/B labels. Each
      // pool may store A/B in different orders (canonical: A=WSOL;
      // user-created 4%: A=USDC), so look up by mint not symbol.
      const dir = resolveDirection(
        selectedPool,
        fromTok.mintHex,
        toTok.mintHex,
      );
      return { amountInBI: amountIn, direction: dir };
    } catch {
      return { amountInBI: 0n, direction: null };
    }
  }, [quoteInputs, symbolToTok, selectedPool]);

  // Live gas estimate against the actual CPI precompile calldata. We
  // pass 0 for minimumOut here — estimateGas is a view, the pool's own
  // swap succeeds either way, and this keeps the hook hermetic from the
  // client-side slippage math done at submit time.
  const { gas: gasEstimate } = useSwapGasEstimate({
    userEvmAddress:
      wallet.connected && wallet.address ? (wallet.address as Address) : undefined,
    direction,
    amountIn: amountInBI,
    minimumOut: 0n,
  });

  // Cost estimate — gas via wagmi estimateGas + oracle ETH price; rent
  // is conservative-static (we know Meteora swap creates 0 new accounts
  // when ATAs already exist, which the user-flow gate enforces).
  // Previously this routed through rome-showcase's RomeCross adapter
  // for a `quoteCost` read — that dependency was removed because the
  // adapter only repackaged values we can compute directly here.
  // Live reserves of the selected pool's two token vaults. The pool's reserve
  // ratio IS the price — quote + minimumOut come from here, never the oracle.
  const reserves = usePoolReserves(selectedPool);

  // Expected output from the POOL (constant product), in raw output-token units.
  // direction 'AToB' spends token A (reserveA) for B (reserveB), and vice versa.
  const expectedOutRaw = useMemo(() => {
    if (!direction || amountInBI <= 0n) return undefined;
    if (reserves.reserveA == null || reserves.reserveB == null) return undefined;
    const [rIn, rOut] =
      direction === 'AToB'
        ? [reserves.reserveA, reserves.reserveB]
        : [reserves.reserveB, reserves.reserveA];
    return constantProductOut(rIn, rOut, amountInBI, selectedFeeBps);
  }, [direction, amountInBI, reserves.reserveA, reserves.reserveB, selectedFeeBps]);

  const costEstimate = useMemo(() => {
    const ethPrice = prices['ETH']?.usd;
    const gasUSD =
      gasEstimate && ethPrice
        ? (Number(gasEstimate) *
            Number(ROME_GAS_PRICE_WEI) *
            ethPrice) /
          1e18
        : undefined;
    return {
      totalUSD: undefined,        // computed in the screen from fee + gas + rent
      rentUSD: undefined,         // 0 once user has both ATAs (gated)
      gasUSD,
      feeUSD: undefined,
      feeBps: selectedFeeBps,     // the selected pool's real trade fee
      // Real pool-derived output (raw units). The screen divides by the output
      // token's decimals. Undefined → screen falls back to oracle (no pool yet).
      expectedOutput: expectedOutRaw != null ? Number(expectedOutRaw) : undefined,
      oracleReads: undefined,
    };
  }, [gasEstimate, prices, selectedFeeBps, expectedOutRaw]);

  // ── Write path: direct-precompile submit ────────────────────────────
  //
  // wagmi drives the tx lifecycle. We project it onto the designer's
  // tx-flow `status` enum so the TxModal renders without visual change.
  //
  // **Receipt polling note:** wagmi's `useWaitForTransactionReceipt` did
  // not reliably resolve on Rome during smoke tests — the underlying
  // viem watcher was leaving the modal stuck in `confirming` even after
  // the tx had landed. We add an explicit polling loop that hits the
  // same /api/rpc/rome proxy via JSON-RPC `eth_getTransactionReceipt`.
  // Whichever resolves first (wagmi's watcher or this loop) wins; both
  // produce the same `receipt` shape so the existing logic below is
  // unchanged.
  const {
    writeContract,
    data: submittedHash,
    isPending: isSigning,
    error: writeError,
    reset: resetWrite,
  } = useRomeWrite();
  // Cold-path pre-flight: creates the output-token ATA before the swap
  // when the user has never held that token (see onSubmitSwap).
  const { init: ataInit } = useAtaInit();
  const {
    data: wagmiReceipt,
    isLoading: isConfirming,
    error: receiptError,
  } = useWaitForTransactionReceipt({ hash: submittedHash });

  const [pollReceipt, setPollReceipt] = useState<
    { status: 'success' | 'reverted'; transactionHash: `0x${string}` } | null
  >(null);

  useEffect(() => {
    if (!submittedHash) {
      setPollReceipt(null);
      return;
    }
    if (wagmiReceipt) return; // wagmi got there first
    if (pollReceipt?.transactionHash === submittedHash) return; // already polled

    let cancelled = false;
    const start = Date.now();
    const tick = async () => {
      if (cancelled) return;
      try {
        const res = await fetch('/api/rpc/rome', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            jsonrpc: '2.0',
            id: 1,
            method: 'eth_getTransactionReceipt',
            params: [submittedHash],
          }),
        });
        const json = await res.json();
        if (cancelled) return;
        if (json.result?.blockNumber) {
          // status is 0x1 success / 0x0 reverted, per Ethereum convention.
          setPollReceipt({
            status: json.result.status === '0x1' ? 'success' : 'reverted',
            transactionHash: json.result.transactionHash,
          });
          return;
        }
      } catch (e) {
        // eslint-disable-next-line no-console
        console.warn('[cardo swap] receipt poll error', e);
      }
      // Stop polling after 90 seconds — the tx is either dropped or stuck.
      if (Date.now() - start > 90_000) {
        // eslint-disable-next-line no-console
        console.warn('[cardo swap] receipt poll timed out for', submittedHash);
        return;
      }
      setTimeout(tick, 2_000);
    };
    setTimeout(tick, 1_500);
    return () => {
      cancelled = true;
    };
  }, [submittedHash, wagmiReceipt, pollReceipt?.transactionHash]);

  // Unify wagmi's watcher with our manual poll. The poll catches the
  // case where wagmi's `useWaitForTransactionReceipt` stalls.
  const receipt = wagmiReceipt ?? pollReceipt;

  const [submitError, setSubmitError] = useState<string | null>(null);

  useEffect(() => {
    const err = writeError || receiptError;
    if (err) {
      const msg = (err as Error).message ?? String(err);
      setSubmitError(msg);
      // eslint-disable-next-line no-console
      console.error('[cardo swap] direct-precompile submit failed', err);
    }
  }, [writeError, receiptError]);

  const txState = useMemo(() => {
    if (submitError) {
      return { status: 'failed' as const, error: submitError, hash: submittedHash };
    }
    if (receipt) {
      if (receipt.status === 'reverted') {
        return {
          status: 'failed' as const,
          hash: submittedHash,
          error: 'Transaction reverted on-chain',
        };
      }
      return { status: 'confirmed' as const, hash: submittedHash };
    }
    if (isConfirming) return { status: 'confirming' as const, hash: submittedHash };
    if (submittedHash) return { status: 'submitting' as const, hash: submittedHash };
    if (isSigning) return { status: 'signing' as const };
    return { status: 'idle' as const };
  }, [submitError, receipt, isConfirming, submittedHash, isSigning]);

  const onSubmitSwap = useCallback(
    async (s: QuoteInputs) => {
      setSubmitError(null);
      resetWrite();
      if (!wallet.connected || !wallet.address) {
        connect();
        return;
      }
      const fromTok = symbolToTok[s.fromSym];
      const toTok = symbolToTok[s.toSym];
      if (!fromTok || !toTok) {
        setSubmitError(`Unknown token ${!fromTok ? s.fromSym : s.toSym}.`);
        return;
      }
      const dir = resolveDirection(selectedPool, fromTok.mintHex, toTok.mintHex);
      if (!dir) {
        setSubmitError(
          `No Meteora pool wired for ${s.fromSym}→${s.toSym} on Rome.`,
        );
        return;
      }
      // Cold path: the swap mints into the user's output-token ATA but does
      // NOT create it — a first trade into a new token reverts on-chain
      // without this. The ledger already advertises the extra signature
      // ("Create your receiving account"); actually send it when the ATA is
      // missing, then fall through to the swap. Existence is read live so a
      // stale plan can't skip the step (create is idempotent anyway).
      try {
        const outAta = bytes32ToPublicKey(
          deriveAta(deriveRomeUserPda(wallet.address as Address), toTok.mintHex),
        ).toBase58();
        const probe = await fetch('/api/rpc/solana-devnet', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            jsonrpc: '2.0', id: 1, method: 'getAccountInfo',
            params: [outAta, { encoding: 'base64', dataSlice: { offset: 0, length: 0 } }],
          }),
        }).then((r) => r.json());
        if (!probe?.result?.value) {
          const ok = await ataInit({
            userEvmAddress: wallet.address as Address,
            mintHex: toTok.mintHex as Hex,
          });
          if (!ok) {
            setSubmitError(`Couldn't create your ${s.toSym} receiving account — swap not sent.`);
            return;
          }
        }
      } catch (e) {
        // Probe transport hiccup: proceed — the swap itself will surface a
        // real missing-ATA revert, same as before this pre-flight existed.
        // eslint-disable-next-line no-console
        console.warn('[cardo swap] out-ATA pre-flight skipped', e);
      }
      try {
        const amountIn = parseUnits(String(s.amount), fromTok.decimals);
        const slippageBps = Math.max(
          0,
          Math.min(10_000, Math.floor(s.slippagePct * 100)),
        );
        // Enforce a real minimumOut from the pool's live reserves shaved by the
        // user's slippage — so the swap executes at the rate the user SAW, or
        // reverts. (Previously hardcoded 0n: the UI showed a floor it never
        // submitted, so swaps dumped tokens at any pool price.)
        let minimumOut = 0n;
        if (reserves.reserveA != null && reserves.reserveB != null) {
          const [rIn, rOut] =
            dir === 'AToB'
              ? [reserves.reserveA, reserves.reserveB]
              : [reserves.reserveB, reserves.reserveA];
          const expOut = constantProductOut(rIn, rOut, amountIn, selectedFeeBps);
          minimumOut = applySlippage(expOut, slippageBps);
        }
        if (minimumOut <= 0n) {
          setSubmitError('Quote unavailable — pool reserves still loading. Try again in a moment.');
          return;
        }

        const { program, accounts, data } = buildChainMeteoraSwapInvoke({
          userEvmAddress: wallet.address as Address,
          direction: dir,
          amountIn,
          minimumOut,
          pool: selectedPool,
        });

        writeContract({
          address: CPI_PRECOMPILE,
          abi: CPI_INVOKE_ABI,
          functionName: 'invoke',
          args: [program, accounts, data],
          // Fees come from useRomeWrite (estimate-first legacy envelope).
        });
      } catch (e) {
        const msg = (e as Error).message ?? String(e);
        setSubmitError(msg);
        // eslint-disable-next-line no-console
        console.error('[cardo swap] calldata build failed', e);
      }
    },
    [
      wallet, connect, resetWrite, writeContract, ataInit, symbolToTok, selectedPool,
      reserves.reserveA, reserves.reserveB, selectedFeeBps,
    ],
  );

  // Wrapper-registration flow: turns an unregistered ERC20-SPL wrapper
  // into one that returns balanceOf for this user. Two-tx (or one-tx if
  // the user is already factory-registered).
  const {
    state: registerState,
    register: registerWrapper,
    reset: resetRegister,
  } = useRegisterWrapper();

  const onRegisterWrapper = useCallback(
    (wrapperAddress: Address) => {
      if (!wallet.connected || !wallet.address) {
        connect();
        return;
      }
      registerWrapper({
        wrapperAddress,
        userAddress: wallet.address as Address,
        skipCreateUser: factoryRegistered,
      });
    },
    [wallet, connect, registerWrapper, factoryRegistered],
  );

  // Visual-hint flag: when the factory was empty and we fell back, the
  // Swap screen keeps rendering but we could surface a tiny dev-note
  // banner. For now the prop is available but not displayed.
  void tokensFromFallback;
  void pricesLoading;
  void resetRegister;

  // Show the fee-tier picker whenever the pair has at least one
  // routable pool (static or user-created). Replaces the old
  // USDC↔WSOL-only gating.
  const showFeeTierPicker = activePoolOptions.length > 0;

  // Live "what will happen" plan for the SignatureLedger. The output token's
  // SPL mint gates whether the user needs a one-time ATA-create signature
  // before the swap; symbolToTok already carries each token's mintHex.
  const userEvm =
    wallet.connected && wallet.address ? (wallet.address as Address) : undefined;
  const outMintHex = quoteInputs
    ? symbolToTok[quoteInputs.toSym]?.mintHex
    : undefined;
  const swapPlan = useSignaturePlan({
    flow: 'swap',
    userEvmAddress: userEvm,
    outMintHex,
  });

  return (
    <Swap
      wallet={wallet}
      onConnect={connect}
      signaturePlan={swapPlan}
      onQuoteInputsChange={onQuoteInputsChange}
      costEstimate={costEstimate}
      onSubmitSwap={onSubmitSwap}
      txState={txState}
      balances={wallet.connected ? balances : undefined}
      tokens={chainTokens}
      prices={prices}
      registration={wallet.connected ? registration : undefined}
      onRegisterWrapper={onRegisterWrapper}
      registerState={registerState}
      feeTierPools={showFeeTierPicker ? activePoolOptions : undefined}
      selectedFeeBps={selectedFeeBps}
      onSelectFeeBps={setSelectedFeeBps}
      pairRoutable={pairRoutable}
      defaultPair={defaultPair}
    />
  );
}
