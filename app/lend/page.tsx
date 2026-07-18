// Lend route `/lend` — designer's Lend screen + live quoteCost wiring
// against the deployed KaminoLendAdapter on Rome.
//
// Screen exposes (capability, reserveSym, amount) via onQuoteInputsChange
// when the per-reserve drawer is open. Wrapper encodes capability +
// reserve payload and pulls a CostEstimate tuple from the adapter, which
// it maps to the screen's displayed fields via `costEstimate`.
//
// Expected no-op today: Kamino.quoteCost reverts ReserveNotRegistered for every
// call because no reserves are registered on the Rome adapter. `useQuoteCost`
// returns `data: undefined` on revert → we pass `costEstimate={undefined}` → the
// drawer falls back to the designer's preview values. Wiring a reserve into
// SYMBOL_TO_RESERVE takes the same path live with zero screen changes.
//
// Why supply/borrow stays gated (verified on devnet 2026-06-30, NOT "no devnet
// market" — that earlier note was wrong): the klend market HqCoqWT… + both
// reserves DO exist on the devnet follower, but (1) the reserves carry no oracle
// config (refresh_reserve reverts Custom(6029) InvalidOracleConfig — null Pyth/
// Switchboard sentinels, lastUpdate.slot=1), and (2) Kamino's is_forbidden_cpi
// _call() rejects a non-Kamino outermost instruction, so even a refreshed
// reserve can't be driven through Rome's CPI precompile. Unblocking needs Kamino
// to whitelist Rome's CPI (out of our hands) or re-pointing /lend at an
// oracle-configured, CPI-permitted market. Setup (init_user_metadata +
// init_obligation) is the only live write today.

'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import { parseUnits, type Address, type Hex } from 'viem';
import { Lend } from '@/components/screens/Lend';
import { useWallet } from '../wallet-context';
import { kaminoMainMarket, findReserveBySymbol } from '@/lib/kamino-markets';
import { useActiveChainId } from '@/lib/env-context';
import { useKaminoSetup } from '@/lib/use-kamino-setup';
import {
  useKaminoUserMetadataExists,
  useKaminoObligationExists,
} from '@/lib/use-kamino-account-exists';
import {
  useKaminoAction,
  type KaminoActionKind,
} from '@/lib/use-kamino-action';
import { useAtaExists } from '@/lib/use-ata-exists';
import { useAtaInit } from '@/lib/use-ata-init';
import { useKaminoObligationState } from '@/lib/use-kamino-obligation-state';
import { useSignaturePlan } from '@/lib/use-signature-plan';

type Capability = 'supply' | 'borrow' | 'withdraw' | 'repay';

type QuoteInputs = {
  capability: Capability;
  reserveSym: string;
  amount: number;
} | null;

export default function Page() {
  const activeChainId = useActiveChainId();
  const kaminoMain = kaminoMainMarket(activeChainId);
  const { wallet, connect } = useWallet();
  const [quoteInputs, setQuoteInputs] = useState<QuoteInputs>(null);

  const onQuoteInputsChange = useCallback((q: QuoteInputs) => {
    setQuoteInputs(q);
  }, []);

  // Cost estimate is undefined for now — Cardo previously routed this
  // through rome-showcase's KaminoLendAdapter.quoteCost, which only
  // repackaged values we can compute directly. The drawer falls back
  // to the conservative static estimates already wired in Lend.jsx.
  // Re-enable a real estimate when the action path comes off disable
  // and we have a verified Reserve-state polling hook.
  const costEstimate = undefined;

  // Kamino setup flow — required once per (user, market) before any
  // deposit/withdraw/borrow/repay can submit. See triage doc §1.6.
  // The screen renders a banner with "Open lending account" when the
  // obligation is missing; clicking calls into useKaminoSetup which
  // chains init_user_metadata (skipped if already exists) +
  // init_obligation. On success, the existence hooks refresh and the
  // banner flips automatically.
  const userEvm =
    wallet.connected && wallet.address ? (wallet.address as Address) : undefined;
  const userMetadataExists = useKaminoUserMetadataExists(userEvm);
  const obligationExists = useKaminoObligationExists({
    userEvmAddress: userEvm,
    lendingMarket: kaminoMain.lendingMarket,
  });
  const { state: kaminoSetupState, setup: kaminoSetup } = useKaminoSetup();

  const onKaminoSetup = useCallback(() => {
    if (!userEvm) {
      connect();
      return;
    }
    kaminoSetup({
      userEvmAddress: userEvm,
      lendingMarket: kaminoMain.lendingMarket,
      skipUserMetadata: userMetadataExists.status === 'exists',
    });
  }, [userEvm, connect, kaminoSetup, userMetadataExists.status, kaminoMain.lendingMarket]);

  // After setup confirms, kick the existence polls so the UI flips
  // immediately rather than waiting up to 8s for the next periodic
  // refresh. Same pattern as /pool/new's vault-init refresh.
  //
  // Must run as an effect, NOT inline during render — `refresh()` is
  // a state setter (bumps an internal tick counter), and calling it
  // during render throws &quot;Cannot update a component while rendering&quot;.
  // Caused the &quot;Cardo hit an error&quot; runtime exception on /lend before
  // this fix.
  const umRefresh = userMetadataExists.refresh;
  const obRefresh = obligationExists.refresh;
  useEffect(() => {
    if (kaminoSetupState.phase === 'success') {
      umRefresh();
      obRefresh();
    }
  }, [kaminoSetupState.phase, umRefresh, obRefresh]);

  // Action submit — wires the drawer's "Supply / Borrow / Withdraw /
  // Repay" button to the real Kamino write CPI. Single popup per
  // action (Kamino v2 refresh inline via deposit_reserves_iter).
  // Symbol → reserve lookup tolerates the drawer's hardcoded
  // RESERVES list (USDC, SOL, BTC, JTO) — only USDC/SOL map to the
  // wired Rome market today; BTC/JTO will surface "no reserve" copy.
  const { state: actionState, execute: executeAction } = useKaminoAction();
  const onExecAction = useCallback(
    (args: { capability: Capability; reserveSym: string; amountHuman: number }) => {
      if (!userEvm) {
        connect();
        return;
      }
      const found = findReserveBySymbol(args.reserveSym);
      if (!found) {
        // eslint-disable-next-line no-console
        console.warn('[cardo lend] no Kamino reserve registered for symbol', args.reserveSym);
        return;
      }
      const amountRaw = parseUnits(String(args.amountHuman), found.reserve.decimals);
      executeAction({
        kind: args.capability as KaminoActionKind,
        userEvmAddress: userEvm,
        market: found.market,
        reserve: found.reserve,
        amount: amountRaw,
      });
    },
    [userEvm, connect, executeAction],
  );

  // Per-reserve ATA pre-flight. The drawer surfaces these as visible
  // rows so the user knows exactly which accounts are missing and
  // signs each setup tx with informed consent. Per playbook §4b.8.
  //
  // Two ATAs per reserve:
  //   - liquidityAta (the underlying SPL — already covered by /swap's
  //     wrapper-registration setup; usually exists once the user has
  //     bridged or interacted with the wrapper).
  //   - collateralAta (Kamino's cToken; only needed for supply +
  //     withdraw which mint/burn cTokens through user_destination_collateral).
  //
  // Today we wire two reserves (WUSDC + WWSOL). Drift / multi-market
  // expansions add their own pre-flight rows the same way.
  const usdcReserve = kaminoMain.reserves.find((r) => r.symbol === 'WUSDC');
  const wsolReserve = kaminoMain.reserves.find((r) => r.symbol === 'WWSOL');

  const usdcLiquidityAta = useAtaExists({
    userEvmAddress: userEvm,
    mintHex: usdcReserve?.liquidityMint,
  });
  const usdcCollateralAta = useAtaExists({
    userEvmAddress: userEvm,
    mintHex: usdcReserve?.collateralMint,
  });
  const wsolLiquidityAta = useAtaExists({
    userEvmAddress: userEvm,
    mintHex: wsolReserve?.liquidityMint,
  });
  const wsolCollateralAta = useAtaExists({
    userEvmAddress: userEvm,
    mintHex: wsolReserve?.collateralMint,
  });

  // Per-reserve pre-flight bundle the screen consumes. Symbol keys
  // match the drawer's RESERVES list (USDC, SOL, BTC, JTO). Today
  // only USDC and SOL are wired.
  const preflightFor = useMemo(() => ({
    USDC: {
      obligation: { status: obligationExists.status },
      liquidityAta: { status: usdcLiquidityAta.status },
      collateralAta: { status: usdcCollateralAta.status },
    },
    SOL: {
      obligation: { status: obligationExists.status },
      liquidityAta: { status: wsolLiquidityAta.status },
      collateralAta: { status: wsolCollateralAta.status },
    },
  }), [
    obligationExists.status,
    usdcLiquidityAta.status,
    usdcCollateralAta.status,
    wsolLiquidityAta.status,
    wsolCollateralAta.status,
  ]);

  // ATA-init handler — user-triggered from a pre-flight row.
  // Single popup; the user knows they're creating a specific account
  // because the row that fired this action says so explicitly.
  const { state: ataInitState, init: ataInit } = useAtaInit();
  const onInitCollateralAta = useCallback(
    (reserveSym: string) => {
      if (!userEvm) {
        connect();
        return;
      }
      const found = findReserveBySymbol(reserveSym);
      if (!found) return;
      ataInit({ userEvmAddress: userEvm, mintHex: found.reserve.collateralMint });
    },
    [userEvm, connect, ataInit],
  );

  // After ATA-init succeeds, kick the per-reserve ATA-existence
  // refresh so the corresponding row flips to ✓ without the 8s wait.
  useEffect(() => {
    if (ataInitState.phase !== 'success' || !ataInitState.mintHex) return;
    const lc = ataInitState.mintHex.toLowerCase();
    if (lc === usdcReserve?.collateralMint.toLowerCase()) usdcCollateralAta.refresh();
    if (lc === wsolReserve?.collateralMint.toLowerCase()) wsolCollateralAta.refresh();
  }, [
    ataInitState.phase,
    ataInitState.mintHex,
    usdcReserve?.collateralMint,
    wsolReserve?.collateralMint,
    usdcCollateralAta,
    wsolCollateralAta,
  ]);

  // Real obligation state — replaces the hardcoded mock position
  // that was rendering &quot;Net worth $2,186.64 / Supplied 2,500 USDC /
  // Borrowed 2.1 SOL&quot; whenever the wallet was connected. Per
  // playbook §4b.11: never show fake numbers in place of truth.
  const obligationState = useKaminoObligationState({
    userEvmAddress: userEvm,
    lendingMarket: kaminoMain.lendingMarket,
  });

  // Map raw obligation positions back to the screen's display shape
  // (RESERVES list keys: USDC, SOL, BTC, JTO). Symbol resolved by
  // looking up the reserve pubkey in the wired market.
  const livePosition = useMemo(() => {
    if (!obligationState.exists) return null;
    if (obligationState.deposits.length === 0 && obligationState.borrows.length === 0) {
      return null; // empty obligation — show &quot;no position yet&quot; copy
    }
    const reserveBySymbol: Record<string, string> = {
      WUSDC: 'USDC',
      WWSOL: 'SOL',
    };
    const reserveByHex = new Map<string, string>();
    for (const r of kaminoMain.reserves) {
      const sym = reserveBySymbol[r.symbol] ?? r.symbol;
      reserveByHex.set(r.reserve.toLowerCase(), sym);
    }
    const supplied = obligationState.deposits.flatMap((d) => {
      const sym = reserveByHex.get(d.reserveHex.toLowerCase());
      if (!sym) return [];
      const reserve = kaminoMain.reserves.find((r) => {
        const rSym = reserveBySymbol[r.symbol] ?? r.symbol;
        return rSym === sym;
      });
      const decimals = reserve?.decimals ?? 6;
      return [{
        sym,
        amt: Number(d.depositedAmount) / 10 ** decimals,
        earned: 0, // TODO: derive from cumulative borrow rate vs initial deposit
      }];
    });
    const borrowed = obligationState.borrows.flatMap((b) => {
      const sym = reserveByHex.get(b.reserveHex.toLowerCase());
      if (!sym) return [];
      const reserve = kaminoMain.reserves.find((r) => {
        const rSym = reserveBySymbol[r.symbol] ?? r.symbol;
        return rSym === sym;
      });
      const decimals = reserve?.decimals ?? 6;
      return [{
        sym,
        amt: Number(b.borrowedAmountLow) / 10 ** decimals,
        interest: 0, // TODO
      }];
    });
    return { supplied, borrowed };
  }, [obligationState.exists, obligationState.deposits, obligationState.borrows, kaminoMain.reserves]);

  // Refresh obligation state right after a successful action so the
  // position panel updates without waiting for the 8s poll tick.
  useEffect(() => {
    if (actionState.phase === 'success') {
      obligationState.refresh();
    }
  }, [actionState.phase, obligationState]);

  // Live signature ledger for the act|see "what will happen" panel.
  const lendPlan = useSignaturePlan({
    flow: 'lend-kamino',
    userEvmAddress: userEvm,
    kaminoLendingMarket: kaminoMain.lendingMarket,
  });

  return (
    <Lend
      wallet={wallet}
      onConnect={connect}
      onQuoteInputsChange={onQuoteInputsChange}
      costEstimate={costEstimate}
      signaturePlan={lendPlan}
      setupRequired={
        wallet.connected && obligationExists.status === 'missing'
      }
      setupState={kaminoSetupState}
      onSetup={onKaminoSetup}
      onExecAction={onExecAction}
      actionState={actionState}
      preflightFor={preflightFor}
      onInitCollateralAta={onInitCollateralAta}
      ataInitState={ataInitState}
      livePosition={livePosition}
      obligationLoading={obligationState.loading}
    />
  );
}
