// Stake route `/stake` — SPL stake-pool: stake SOL → LST (Stake tab) +
// unstake LST → SOL (Unstake tab), both act|see.
//
// Unstake uses plain WithdrawSol (tag 16), NOT WithdrawSolWithSlippage
// (tag 25): the spl-stake-pool deployment on Solana devnet (SPoo1Ku8…,
// last deployed slot 197328814) predates the slippage instruction
// variants, so tags 22-25 fail at dispatch with BorshIoError. Verified
// 2026-07-07 by simulating both tags against the live devnet program:
// tag 16 succeeds, tag 25 → "Error: BorshIoError".
//
// Per the integration roadmap at
//   the docs/active/technical/2026-04-25-cardo-solana-integration-roadmap.md

'use client';

import { useCallback, useMemo, useState } from 'react';
import type { Hex } from 'viem';
import { Stake } from '@/components/screens/Stake';
import { useWallet } from '../wallet-context';
import { ENABLED_STAKE_POOLS } from '@/lib/stake-pool-registry';
import { useStakePoolDeposit } from '@/lib/use-stake-pool-deposit';
import { useStakePoolWithdrawSol } from '@/lib/use-stake-pool-withdraw';
import { useStakePoolBalances } from '@/lib/use-stake-pool-balances';
import { useStakePoolStats } from '@/lib/use-stake-pool-stats';
import { useAtaExists } from '@/lib/use-ata-exists';
import { useAtaInit } from '@/lib/use-ata-init';
import { useEnsurePdaLamports } from '@/lib/use-ensure-pda-lamports';
import type { StakePoolRegistryEntry } from '@/lib/stake-pool-registry';
import { TxError, TxHash } from '@/components/design/Inline';
import s from '@/components/design/actsee.module.css';

type StakeArgs = { entry: StakePoolRegistryEntry; amountSol: number };
type SetupArgs = { entry: StakePoolRegistryEntry };

export default function Page() {
  const { wallet, connect } = useWallet();
  const { state: depositState, deposit } = useStakePoolDeposit();
  const { ensure: ensureLamports } = useEnsurePdaLamports();
  const { state: withdrawState, withdraw } = useStakePoolWithdrawSol();
  const { state: ataInitState, init: ataInit } = useAtaInit();
  const [withdrawAmount, setWithdrawAmount] = useState('');
  const [tab, setTab] = useState<'main' | 'unstake'>('main');

  const pools = useMemo(() => ENABLED_STAKE_POOLS, []);
  const poolMintHexes = useMemo(() => pools.map((p) => p.pool.poolMint), [pools]);

  const { pdaLamports, lstAmountsByMint } = useStakePoolBalances(
    poolMintHexes,
    wallet?.address as `0x${string}` | undefined,
  );

  // Real pool stats (exchange rate + TVL) from each StakePool account.
  const statPools = useMemo(
    () => pools.map((p) => ({ stakePool: p.pool.stakePool, poolMint: p.pool.poolMint })),
    [pools],
  );
  const { byMint: poolStats } = useStakePoolStats(statPools);

  // Track which LST mint the user is actively viewing so we only pre-flight the
  // relevant ATA. Sprint 1 has one LST so this is mostly cosmetic.
  const [selectedMintHex, setSelectedMintHex] = useState<Hex | undefined>(
    pools[0]?.pool.poolMint,
  );

  const ataState = useAtaExists({
    userEvmAddress: wallet?.address as `0x${string}` | undefined,
    mintHex: selectedMintHex,
  });

  const ataStatusByMint: Record<string, 'exists' | 'missing' | 'unknown'> = useMemo(
    () => (selectedMintHex ? { [selectedMintHex]: ataState.status } : {}),
    [selectedMintHex, ataState.status],
  );

  // PDA SOL balance on Solana devnet — what DepositSol consumes. NOT the user's
  // Rome EVM balance.
  const solBalance = Number(pdaLamports) / 1_000_000_000;

  // Per-mint LST display amounts. LST mints are 9 decimals.
  const lstBalances: Record<string, number> = useMemo(() => {
    const out: Record<string, number> = {};
    for (const [mintHex, raw] of Object.entries(lstAmountsByMint)) {
      out[mintHex] = Number(raw) / 1_000_000_000;
    }
    return out;
  }, [lstAmountsByMint]);

  const onSelectPool = useCallback((entry: StakePoolRegistryEntry) => {
    setSelectedMintHex(entry.pool.poolMint);
  }, []);

  const onSetup = useCallback(
    async ({ entry }: SetupArgs) => {
      if (!wallet?.address) {
        connect?.();
        return;
      }
      // The stake-token ATA create + the subsequent deposit_sol both spend SOL
      // from the user's Rome PDA. Fund a reserve first (separate persisting tx —
      // no multi-write-CPI), then create the ATA.
      const funded = await ensureLamports(wallet.address as `0x${string}`, {
        minLamports: 50_000_000n,
        reserveLamports: 50_000_000n,
      });
      if (funded !== 'ready') return;
      const landed = await ataInit({
        userEvmAddress: wallet.address as `0x${string}`,
        mintHex: entry.pool.poolMint,
      });
      // Flip "Create account" → "Stake" right away instead of waiting for
      // the next 8s poll (playbook §4b.5 refresh-on-success).
      if (landed) ataState.refresh();
    },
    [wallet?.address, connect, ataInit, ensureLamports, ataState.refresh],
  );

  const onDeposit = useCallback(
    ({ entry, amountSol }: StakeArgs) => {
      if (!wallet?.address) {
        connect?.();
        return;
      }
      const lamports = BigInt(Math.round(amountSol * 1_000_000_000));
      if (lamports <= 0n) return;
      void deposit({
        userEvmAddress: wallet.address as `0x${string}`,
        entry,
        lamports,
      });
    },
    [wallet?.address, connect, deposit],
  );

  const onWithdraw = useCallback(
    (entry: StakePoolRegistryEntry, amountLst: number) => {
      if (!wallet?.address) {
        connect?.();
        return;
      }
      // LST mints are 9 decimals.
      const poolTokensIn = BigInt(Math.round(amountLst * 1_000_000_000));
      if (poolTokensIn <= 0n) return;
      void withdraw({
        userEvmAddress: wallet.address as `0x${string}`,
        pool: entry,
        poolTokensIn,
      });
    },
    [wallet?.address, connect, withdraw],
  );

  // ── Unstake tab (act|see rig) ──
  const connected = !!wallet?.connected;
  const pool0 = pools[0];
  const lstAvail = pool0 ? (lstBalances[pool0.pool.poolMint] ?? 0) : 0;
  const stat0 = pool0 ? poolStats[pool0.pool.poolMint] : undefined;
  const solPerLst0 = stat0?.rate?.solPerLst ?? null;
  const wAmt = parseFloat(withdrawAmount) || 0;
  const wEstSolOut = wAmt * (solPerLst0 ?? 1);
  const wPhase = withdrawState.phase;
  const wBusy = wPhase === 'signing' || wPhase === 'confirming';

  let uLabel = 'Unstake';
  let uCaption = '1 signature · SOL to your Rome account';
  let uDisabled = false;
  let uClick: (() => void) | undefined;
  if (!connected) {
    uLabel = 'Connect wallet';
    uCaption = 'one wallet — no bridge, no Phantom';
    uClick = connect;
  } else {
    uDisabled = wBusy || wAmt <= 0 || wAmt > lstAvail;
    uLabel = wBusy
      ? wPhase === 'signing' ? 'Awaiting signature…' : 'Confirming on Solana…'
      : wAmt > lstAvail ? `Insufficient ${pool0?.symbol ?? ''}` : 'Unstake';
    uClick = () => pool0 && onWithdraw(pool0, wAmt);
  }
  let uStatus: React.ReactNode = <>Preview · this is exactly what your wallet will sign</>;
  if (wPhase === 'success') {
    uStatus = (
      <>
        <span className={s.ok}>✓ SOL credited to your Rome account</span>
        {withdrawState.hash ? <> · <TxHash hash={withdrawState.hash} /></> : null}
      </>
    );
  } else if (wPhase === 'failed') uStatus = <TxError error={withdrawState.error} />;
  else if (wBusy) uStatus = <>Confirm in MetaMask…</>;

  const unstakePanel = pool0 ? (
    <div className={s.rig}>
      <form className={`${s.col} ${s.act}`} autoComplete="off" onSubmit={(e) => { e.preventDefault(); if (uClick) uClick(); }}>
        <div className={s.colhd}><span className={s.sd} /> You do this</div>
        <div className={s.leg}>
          <div className={s.r1}>
            <label>You unstake</label>
            <span className={s.bal}>balance <b>{lstAvail.toFixed(4)}</b> {pool0.symbol}</span>
          </div>
          <div className={s.r2}>
            <div style={{ flex: 1, minWidth: 0 }}>
              <input className={s.amt} inputMode="decimal" aria-label="Unstake amount" placeholder="0.00" value={withdrawAmount} onChange={(e) => setWithdrawAmount(e.target.value)} />
              <div className={s.usd}>{pool0.symbol} → SOL · pool rate at execution</div>
            </div>
            <div className={s.tokchip}>
              <span className={`${s.ic} ${s.sol}`}>{(pool0.symbol[0] || 'l').toLowerCase()}</span>
              <span className={s.sym}>{pool0.symbol}</span>
            </div>
          </div>
        </div>
        <div className={s['cta-wrap']}>
          <button className={s.cta} type="submit" disabled={uDisabled}>
            <span>{uLabel}</span>
            <span className={s.sig}>{uCaption}</span>
          </button>
        </div>
      </form>
      <section className={`${s.col} ${s.see}`}>
        <div className={s.colhd}><span className={s.sd} /> What will happen <span className={s.pool}>spl-stake-pool · withdraw</span></div>
        <div className={s.body}>
          <div className={s.outcome}>
            <div className={`${s.ln} ${s.get}`}>
              <span className={s.k}>You receive</span>
              <span className={s.v}>≈ {wEstSolOut.toFixed(4)} SOL</span>
            </div>
            <div className={s.note}>
              Burns your {pool0.symbol} for SOL via <span className={s.mono}>WithdrawSol</span> at the pool&apos;s live
              exchange rate{solPerLst0 != null ? <> (1 {pool0.symbol} = {solPerLst0.toFixed(4)} SOL)</> : null}, minus the
              pool&apos;s withdrawal fee. Credited to your Rome account in one signature.
            </div>
            {!connected && <div className={s.note} style={{ marginTop: 10 }}>Connect your wallet (Stake tab) to unstake.</div>}
          </div>
        </div>
        <div className={s.status}>{uStatus}</div>
      </section>
    </div>
  ) : null;

  return (
    <Stake
      wallet={wallet}
      onConnect={connect}
      pools={pools}
      solBalance={solBalance}
      lstBalances={lstBalances}
      ataStatusByMint={ataStatusByMint}
      ataInitState={ataInitState}
      onSelectPool={onSelectPool}
      onSetup={onSetup}
      onDeposit={onDeposit}
      depositState={depositState}
      poolStats={poolStats}
      tab={tab}
      onTab={setTab}
    >
      {unstakePanel}
    </Stake>
  );
}
