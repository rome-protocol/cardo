// Lend-Mango route `/lend-mango` — Mango v4 Spot deposit/withdraw + account
// management + conditional swaps, all surfaced as act|see tabs on the MangoLend
// screen (no buried legacy subpanel).
//
// Per the integration roadmap at
//   the docs/active/technical/2026-04-25-cardo-solana-integration-roadmap.md
// (Family 4/5 — A21 Mango v4).

'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import { MangoLend } from '@/components/screens/MangoLend';
import { WrapperGate } from '@/components/WrapperGate';
import { useWallet } from '../wallet-context';
import { MANGO_SOL_BANK } from '@/lib/mango-config';
import { useSolanaTokenBalances } from '@/lib/use-solana-balances';
import { useMangoDeposited } from '@/lib/use-mango-deposited';
import {
  useMangoClose,
  useMangoCreate,
  useMangoDeposit,
  useMangoEdit,
  useMangoExpand,
  useMangoTcsCancel,
  useMangoTcsCreate,
  useMangoWithdraw,
} from '@/lib/use-mango';
import { useMangoAccountState } from '@/lib/use-mango-account-state';
import { useAtaExists } from '@/lib/use-ata-exists';
import { useAtaInit } from '@/lib/use-ata-init';
import { useEnsurePdaLamports } from '@/lib/use-ensure-pda-lamports';
import { pubkeyBs58ToBytes32 } from '@/lib/solana-pda';
import { TxError } from '@/components/design/Inline';
import s from '@/components/design/actsee.module.css';

type ActionArgs = { amount: number };

export default function Page() {
  const { wallet, connect } = useWallet();
  const bank = MANGO_SOL_BANK;
  const accountFlags = useMangoAccountState(
    wallet?.address as `0x${string}` | undefined,
    bank.groupHex,
    0,
  );
  const { state: createState, create: doCreate } = useMangoCreate();
  const { state: depositState, deposit: doDeposit } = useMangoDeposit();
  const { state: withdrawState, withdraw: doWithdraw } = useMangoWithdraw();
  const { state: closeState, close: doClose } = useMangoClose();
  const { state: editState, edit: doEdit } = useMangoEdit();
  const { state: expandState, expand: doExpand } = useMangoExpand();
  const { state: tcsCreateState, createTcs: doTcsCreate } = useMangoTcsCreate();
  const { state: tcsCancelState, cancelTcs: doTcsCancel } = useMangoTcsCancel();
  const { ensure: ensureLamports } = useEnsurePdaLamports();
  // Withdraw destination = the user's own ATA for the bank mint. It can be
  // MISSING even for a user with a Mango deposit (unwrap flows close the
  // wSOL ATA to reclaim rent) — Mango then reverts token_withdraw with
  // Anchor 3012 AccountNotInitialized (reproduced live 2026-07-07).
  // Pre-flight it and recreate before withdrawing.
  const destAta = useAtaExists({
    userEvmAddress: wallet?.address as `0x${string}` | undefined,
    mintHex: bank.mintHex,
  });
  const { init: ataInit } = useAtaInit();
  const [tab, setTab] = useState<'main' | 'account' | 'tcs'>('main');

  // SOL ATA balance via the existing wrapper-keyed Solana balances hook.
  const tokenSpecs = useMemo(
    () => [{ wrapper: bank.wrapper, mintAddress: bank.mintBs58 }],
    [bank],
  );
  const balances = useSolanaTokenBalances(
    tokenSpecs,
    wallet?.address as `0x${string}` | undefined,
  );
  const ataBalancesByMint: Record<string, number> = useMemo(() => {
    const raw = balances[bank.wrapper.toLowerCase()] ?? 0n;
    return {
      [bank.mintBs58]: Number(raw) / 10 ** bank.decimals,
    };
  }, [balances, bank]);

  // What's actually inside Mango (drives the Withdraw view — the wallet ATA
  // balance is what Deposit consumes, not what Withdraw can pull).
  const mangoDeposited = useMangoDeposited({
    userEvmAddress: wallet?.address as `0x${string}` | undefined,
    groupHex: bank.groupHex,
    bankHex: bank.bankHex,
    bankMintHex: bank.mintHex,
    accountNum: 0,
  });
  const depositedAmount =
    mangoDeposited.depositedNative === null
      ? null
      : Number(mangoDeposited.depositedNative) / 10 ** bank.decimals;

  // Flip create→deposit (and back on close) as soon as the tx lands instead
  // of waiting for the next 8s poll; also re-read the deposited amount after
  // a deposit/withdraw settles.
  useEffect(() => {
    if (createState.phase === 'success' || closeState.phase === 'success') {
      accountFlags.refresh();
    }
  }, [createState.phase, closeState.phase, accountFlags.refresh]);
  useEffect(() => {
    if (depositState.phase === 'success' || withdrawState.phase === 'success') {
      mangoDeposited.refresh();
    }
  }, [depositState.phase, withdrawState.phase, mangoDeposited.refresh]);

  const onCreate = useCallback(async () => {
    if (!wallet?.address) {
      connect?.();
      return;
    }
    // Defensive: if the MangoAccount already exists (e.g. a prior
    // session created it and the poll hasn't flipped the screen yet),
    // skip the dispatch. Mango's `account_create` reverts with
    // `Custom(0)` when called against an already-initialized PDA;
    // re-clicking burns gas for nothing.
    if (accountFlags.accountExists) {
      return;
    }
    // The MangoAccount allocation rent (~0.06 SOL) is paid by the SIGNER —
    // the user's Rome PDA. A fresh PDA holds 0 lamports, so account_create
    // reverts Custom(1) (verified via rome_emulateTx). Fund a reserve first
    // as a SEPARATE persisting tx (the same generic helper /pay + /stake use),
    // then run account_create as its own single CPI — no multi-write-CPI.
    const funded = await ensureLamports(wallet.address as `0x${string}`, {
      minLamports: 80_000_000n,
      reserveLamports: 80_000_000n,
    });
    if (funded !== 'ready') return;
    void doCreate({
      userEvmAddress: wallet.address as `0x${string}`,
      groupHex: bank.groupHex,
      accountNum: 0,
      name: 'Cardo',
    });
  }, [wallet?.address, connect, bank, doCreate, accountFlags.accountExists, ensureLamports]);

  const onDeposit = useCallback(
    (args: ActionArgs) => {
      if (!wallet?.address) {
        connect?.();
        return;
      }
      const raw = BigInt(Math.floor(args.amount * 10 ** bank.decimals));
      if (raw <= 0n) return;
      void doDeposit({
        userEvmAddress: wallet.address as `0x${string}`,
        groupHex: bank.groupHex,
        mintHex: bank.mintHex,
        bank: {
          pubkey: bank.bankHex,
          vault: bank.vaultHex,
          oracle: bank.oracleHex,
        },
        amount: raw,
        reduceOnly: false,
        accountNum: 0,
      });
    },
    [wallet?.address, connect, bank, doDeposit],
  );

  const onWithdraw = useCallback(
    async (args: ActionArgs) => {
      if (!wallet?.address) {
        connect?.();
        return;
      }
      const raw = BigInt(Math.floor(args.amount * 10 ** bank.decimals));
      if (raw <= 0n) return;
      // Self-heal a closed/never-created destination ATA (see destAta above):
      // fund rent headroom, recreate the ATA (separate persisting txs — the
      // multi-write-CPI rule), then withdraw as its own single CPI.
      if (destAta.status === 'missing') {
        const funded = await ensureLamports(wallet.address as `0x${string}`, {
          minLamports: 15_000_000n,
          reserveLamports: 15_000_000n,
        });
        if (funded !== 'ready') return;
        const landed = await ataInit({
          userEvmAddress: wallet.address as `0x${string}`,
          mintHex: bank.mintHex,
        });
        if (!landed) return;
        destAta.refresh();
      }
      void doWithdraw({
        userEvmAddress: wallet.address as `0x${string}`,
        groupHex: bank.groupHex,
        mintHex: bank.mintHex,
        bank: {
          pubkey: bank.bankHex,
          vault: bank.vaultHex,
          oracle: bank.oracleHex,
        },
        amount: raw,
        allowBorrow: false,
        accountNum: 0,
      });
    },
    [wallet?.address, connect, bank, doWithdraw, destAta.status, destAta.refresh, ensureLamports, ataInit],
  );

  const onClose = useCallback(() => {
    if (!wallet?.address) {
      connect?.();
      return;
    }
    void doClose({
      userEvmAddress: wallet.address as `0x${string}`,
      groupHex: bank.groupHex,
      accountNum: 0,
    });
  }, [wallet?.address, connect, bank, doClose]);

  const needAccount = !accountFlags.loading && !accountFlags.accountExists;
  const connected = !!wallet?.connected;

  const accountPanel = (
    <div className={s.rig}>
      <div className={`${s.col} ${s.act}`}>
        <div className={s.colhd}><span className={s.sd} /> Manage account</div>
        <AccountActions wallet={wallet} needAccount={needAccount} onCreate={onCreate} onClose={onClose} createState={createState} closeState={closeState} />
        <EditFields wallet={wallet} groupHex={bank.groupHex} state={editState} onEdit={doEdit} />
        <ExpandFields wallet={wallet} groupHex={bank.groupHex} state={expandState} onExpand={doExpand} />
      </div>
      <ManageLedger pool="Mango v4 · account" connected={connected}
        note={<>Your MangoAccount is created once (then reused). Closing refunds ~0.06 SOL of rent. Rename, set a delegate, or expand slot capacity — each is a single signature, signed by your Rome account.</>} />
    </div>
  );

  const tcsPanel = (
    <div className={s.rig}>
      <div className={`${s.col} ${s.act}`}>
        <div className={s.colhd}><span className={s.sd} /> Conditional swaps</div>
        <TcsCreateFields wallet={wallet} groupHex={bank.groupHex} state={tcsCreateState} onCreate={doTcsCreate} />
        <TcsCancelFields wallet={wallet} groupHex={bank.groupHex} state={tcsCancelState} onCancel={doTcsCancel} />
      </div>
      <ManageLedger pool="Mango v4 · conditional swap" connected={connected}
        note={<>Schedules a Mango keeper to swap when the oracle price enters your [lower, upper] band — a stop-loss / take-profit. One signature to arm it.</>} />
    </div>
  );

  return (
    <WrapperGate
      mintBs58={bank.mintBs58}
      userAddress={wallet?.address as `0x${string}` | undefined}
      sourceSymbolHint={bank.symbol}
    >
      <MangoLend
        wallet={wallet}
        onConnect={connect}
        bank={bank}
        ataBalancesByMint={ataBalancesByMint}
        depositedAmount={depositedAmount}
        accountFlags={accountFlags}
        createState={createState}
        depositState={depositState}
        withdrawState={withdrawState}
        onCreate={onCreate}
        onDeposit={onDeposit}
        onWithdraw={onWithdraw}
        tab={tab}
        onTab={setTab}
        panels={{ account: accountPanel, tcs: tcsPanel }}
      />
    </WrapperGate>
  );
}

// ── act|see field-block helpers for the Account / Conditional-swaps tabs ──
const phaseBusy = (p: string) => p === 'signing' || p === 'confirming';
const btnTxt = (p: string, idle: string, done: string, fail: string) =>
  p === 'signing'
    ? 'Awaiting signature…'
    : p === 'confirming'
      ? 'Confirming on Solana…'
      : p === 'success'
        ? done
        : p === 'failed'
          ? fail
          : idle;
function ErrLine({ state }: any) {
  if (!(state?.phase === 'failed' && state?.error)) return null;
  return <TxError error={state?.error} />;
}

function ManageLedger({ pool, note, connected }: any) {
  return (
    <section className={`${s.col} ${s.see}`}>
      <div className={s.colhd}>
        <span className={s.sd} /> What will happen <span className={s.pool}>{pool}</span>
      </div>
      <div className={s.body}>
        <div className={s.outcome}>
          <div className={s.note}>{note}</div>
          {!connected && (
            <div className={s.note} style={{ marginTop: 10 }}>Connect your wallet (Deposit · Withdraw tab) to enable these actions.</div>
          )}
        </div>
      </div>
    </section>
  );
}

function AccountActions({ wallet, needAccount, onCreate, onClose, createState, closeState }: any) {
  return (
    <div className={s.field}>
      <label>Account</label>
      {needAccount ? (
        <>
          <button type="button" className={s.btn2} style={{ marginTop: 8 }} disabled={!wallet?.connected || phaseBusy(createState.phase)} onClick={onCreate}>
            {btnTxt(createState.phase, 'Create MangoAccount', 'Account created ✓', 'Create failed — try again')}
          </button>
          <ErrLine state={createState} />
        </>
      ) : (
        <>
          <button type="button" className={s.btn2} style={{ marginTop: 8 }} disabled={!wallet?.connected || phaseBusy(closeState.phase)} onClick={onClose}>
            {btnTxt(closeState.phase, 'Close MangoAccount #0 — refund ~0.06 SOL', 'Account closed ✓', 'Close failed — try again')}
          </button>
          <ErrLine state={closeState} />
        </>
      )}
    </div>
  );
}

function EditFields({ wallet, groupHex, state, onEdit }: any) {
  const [name, setName] = useState('');
  const [delegate, setDelegate] = useState('');
  return (
    <div className={s.field}>
      <label>Rename / set delegate</label>
      <input className={s.txt} value={name} onChange={(e) => setName(e.target.value.slice(0, 32))} placeholder="New name (max 32 chars)" />
      <input className={s.txt} value={delegate} onChange={(e) => setDelegate(e.target.value.trim())} placeholder="New delegate pubkey (bs58)" />
      <button
        type="button"
        className={s.btn2}
        style={{ marginTop: 10 }}
        disabled={!wallet?.address || phaseBusy(state.phase) || (!name && !delegate)}
        onClick={() => {
          if (!wallet?.address) return;
          const opts: Record<string, unknown> = { userEvmAddress: wallet.address, groupHex };
          if (name) opts.name = name;
          if (delegate) {
            try { opts.delegateHex = pubkeyBs58ToBytes32(delegate); } catch { return; }
          }
          onEdit(opts);
        }}
      >
        {btnTxt(state.phase, 'Edit account', 'Edited ✓', 'Edit failed — try again')}
      </button>
      <ErrLine state={state} />
    </div>
  );
}

function ExpandFields({ wallet, groupHex, state, onExpand }: any) {
  const [tokenCount, setTokenCount] = useState('16');
  const [serum3Count, setSerum3Count] = useState('4');
  const [perpCount, setPerpCount] = useState('4');
  const [perpOoCount, setPerpOoCount] = useState('8');
  return (
    <div className={s.field}>
      <label>Expand slot capacity (≥ current)</label>
      <input className={s.txt} value={tokenCount} onChange={(e) => setTokenCount(e.target.value)} placeholder="token slots (e.g. 16)" />
      <input className={s.txt} value={serum3Count} onChange={(e) => setSerum3Count(e.target.value)} placeholder="serum3 slots (e.g. 4)" />
      <input className={s.txt} value={perpCount} onChange={(e) => setPerpCount(e.target.value)} placeholder="perp slots (e.g. 4)" />
      <input className={s.txt} value={perpOoCount} onChange={(e) => setPerpOoCount(e.target.value)} placeholder="perp open-order slots (e.g. 8)" />
      <button
        type="button"
        className={s.btn2}
        style={{ marginTop: 10 }}
        disabled={!wallet?.address || phaseBusy(state.phase)}
        onClick={() => {
          if (!wallet?.address) return;
          onExpand({
            userEvmAddress: wallet.address,
            groupHex,
            tokenCount: parseInt(tokenCount) || 0,
            serum3Count: parseInt(serum3Count) || 0,
            perpCount: parseInt(perpCount) || 0,
            perpOoCount: parseInt(perpOoCount) || 0,
          });
        }}
      >
        {btnTxt(state.phase, 'Expand account', 'Expanded ✓', 'Expand failed — try again')}
      </button>
      <ErrLine state={state} />
    </div>
  );
}

function TcsCreateFields({ wallet, groupHex, state, onCreate }: any) {
  const [buyBank, setBuyBank] = useState('');
  const [sellBank, setSellBank] = useState('');
  const [maxBuy, setMaxBuy] = useState('1000');
  const [maxSell, setMaxSell] = useState('1000');
  const [priceLower, setPriceLower] = useState('0.95');
  const [priceUpper, setPriceUpper] = useState('1.05');
  const [premium, setPremium] = useState('0.005');
  return (
    <div className={s.field}>
      <label>Create conditional swap</label>
      <input className={s.txt} value={buyBank} onChange={(e) => setBuyBank(e.target.value.trim())} placeholder="Buy bank pubkey (bs58)" />
      <input className={s.txt} value={sellBank} onChange={(e) => setSellBank(e.target.value.trim())} placeholder="Sell bank pubkey (bs58)" />
      <input className={s.txt} value={maxBuy} onChange={(e) => setMaxBuy(e.target.value.trim())} placeholder="max buy (raw)" />
      <input className={s.txt} value={maxSell} onChange={(e) => setMaxSell(e.target.value.trim())} placeholder="max sell (raw)" />
      <input className={s.txt} value={priceLower} onChange={(e) => setPriceLower(e.target.value)} placeholder="trigger price ≥ (lower)" />
      <input className={s.txt} value={priceUpper} onChange={(e) => setPriceUpper(e.target.value)} placeholder="trigger price ≤ (upper)" />
      <input className={s.txt} value={premium} onChange={(e) => setPremium(e.target.value)} placeholder="premium rate (e.g. 0.005)" />
      <button
        type="button"
        className={s.btn2}
        style={{ marginTop: 10 }}
        disabled={!wallet?.address || phaseBusy(state.phase) || !buyBank || !sellBank}
        onClick={() => {
          if (!wallet?.address) return;
          try {
            onCreate({
              userEvmAddress: wallet.address,
              groupHex,
              buyBankHex: pubkeyBs58ToBytes32(buyBank),
              sellBankHex: pubkeyBs58ToBytes32(sellBank),
              maxBuy: BigInt(maxBuy || '0'),
              maxSell: BigInt(maxSell || '0'),
              expiryTimestamp: 0n,
              priceLowerLimit: parseFloat(priceLower) || 0,
              priceUpperLimit: parseFloat(priceUpper) || 0,
              pricePremiumRate: parseFloat(premium) || 0,
              allowCreatingDeposits: true,
            });
          } catch { return; }
        }}
      >
        {btnTxt(state.phase, 'Create conditional swap', 'Created ✓', 'Create failed — try again')}
      </button>
      <ErrLine state={state} />
    </div>
  );
}

function TcsCancelFields({ wallet, groupHex, state, onCancel }: any) {
  const [buyBank, setBuyBank] = useState('');
  const [sellBank, setSellBank] = useState('');
  const [tcsIndex, setTcsIndex] = useState('0');
  const [tcsId, setTcsId] = useState('');
  return (
    <div className={s.field}>
      <label>Cancel conditional swap</label>
      <input className={s.txt} value={buyBank} onChange={(e) => setBuyBank(e.target.value.trim())} placeholder="Buy bank pubkey (bs58)" />
      <input className={s.txt} value={sellBank} onChange={(e) => setSellBank(e.target.value.trim())} placeholder="Sell bank pubkey (bs58)" />
      <input className={s.txt} value={tcsIndex} onChange={(e) => setTcsIndex(e.target.value)} placeholder="tcs index (u8)" />
      <input className={s.txt} value={tcsId} onChange={(e) => setTcsId(e.target.value.trim())} placeholder="tcs id (u64)" />
      <button
        type="button"
        className={s.btn2}
        style={{ marginTop: 10 }}
        disabled={!wallet?.address || phaseBusy(state.phase) || !buyBank || !sellBank || !tcsId}
        onClick={() => {
          if (!wallet?.address) return;
          try {
            onCancel({
              userEvmAddress: wallet.address,
              groupHex,
              buyBankHex: pubkeyBs58ToBytes32(buyBank),
              sellBankHex: pubkeyBs58ToBytes32(sellBank),
              tcsIndex: parseInt(tcsIndex) || 0,
              tcsId: BigInt(tcsId || '0'),
            });
          } catch { return; }
        }}
      >
        {btnTxt(state.phase, 'Cancel conditional swap', 'Cancelled ✓', 'Cancel failed — try again')}
      </button>
      <ErrLine state={state} />
    </div>
  );
}
