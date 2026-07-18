// Pay route `/pay` — Streamflow create_v2 (vesting/payroll streams).
// Family 8, Phase A — Sprint 1 continued.
//
// Per the integration roadmap at
//   the docs/active/technical/2026-04-25-cardo-solana-integration-roadmap.md

'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { type Hex } from 'viem';
import { PublicKey } from '@solana/web3.js';
import { Pay } from '@/components/screens/Pay';
import { useWallet } from '../wallet-context';
import { romeStaticTokens } from '@/lib/addresses';
import { useActiveChainId } from '@/lib/env-context';
import { resolveRecipient } from '@/lib/recipient-resolve';
import { useStreamflowCreate } from '@/lib/use-streamflow-create';
import { useEnsurePdaLamports } from '@/lib/use-ensure-pda-lamports';
import {
  useStreamflowCancel,
  useStreamflowTopup,
  useStreamflowTransferRecipient,
  useStreamflowUpdate,
} from '@/lib/use-streamflow-actions';
import { useSolanaTokenBalances } from '@/lib/use-solana-balances';
import { useAtaExists } from '@/lib/use-ata-exists';
import {
  pubkeyBs58ToBytes32,
  bytes32ToPublicKey,
  deriveRomeUserPda,
} from '@/lib/solana-pda';
import { deriveStreamMetadata } from '@/lib/streamflow-pdas';
import { AUTO_WITHDRAW_FREQUENCY_SECONDS } from '@/lib/streamflow-program';
import {
  listStreams,
  recordStream,
  forgetStream,
  type StoredStream,
} from '@/lib/stream-store';
import { TxError, Address } from '@/components/design/Inline';
import s from '@/components/design/actsee.module.css';

type CreateArgs = {
  recipient: string;
  mintBs58: string;
  amountHuman: number;
  durationSeconds: number;
  name: string;
  cancelable: boolean;
  decimals: number;
};

const PERIOD_SECONDS = 60n;

// v1 ships wUSDC + wSOL. Symbols must match staticTokens verbatim
// (registry uses the lowercase-w nomenclature) — the old ['WUSDC','WWSOL']
// matched nothing → empty token list → /pay could never load a balance.
const SUPPORTED_SYMBOLS = ['wUSDC', 'wSOL'];

export default function Page() {
  const activeChainId = useActiveChainId();
  const staticTokens = romeStaticTokens(activeChainId);
  const { wallet, connect } = useWallet();
  const { state: createState, create } = useStreamflowCreate();
  const { ensure: ensureLamports } = useEnsurePdaLamports();
  const { state: cancelState, cancel } = useStreamflowCancel();
  const { state: topupState, topup } = useStreamflowTopup();
  const { state: updateState, submit: updateSubmit } = useStreamflowUpdate();
  const { state: transferState, submit: transferSubmit } =
    useStreamflowTransferRecipient();
  const [manageMetadataBs58, setManageMetadataBs58] = useState('');
  const [manageSenderBs58, setManageSenderBs58] = useState('');
  const [manageRecipientBs58, setManageRecipientBs58] = useState('');
  const [manageMint, setManageMint] = useState('wUSDC');
  const [topupAmount, setTopupAmount] = useState('');
  const [autoWithdraw, setAutoWithdraw] = useState(false);

  // "Your streams" — locally-recorded streams this wallet created (so Manage can
  // pick instead of pasting a PDA looked up on Solana). See lib/stream-store.
  const [myStreams, setMyStreams] = useState<StoredStream[]>([]);
  const pendingStream = useRef<StoredStream | null>(null);
  const addr = wallet?.address;
  useEffect(() => {
    setMyStreams(addr ? listStreams(addr) : []);
  }, [addr]);
  // Persist a stream once its create actually lands (not on a reverted attempt).
  useEffect(() => {
    if (createState?.phase === 'success' && pendingStream.current && addr) {
      recordStream(addr, pendingStream.current);
      setMyStreams(listStreams(addr));
      pendingStream.current = null;
    }
  }, [createState?.phase, addr]);
  const selectStream = useCallback((str: StoredStream) => {
    setManageMetadataBs58(str.metadataPda);
    setManageRecipientBs58(str.recipient);
    if (addr) setManageSenderBs58(bytes32ToPublicKey(deriveRomeUserPda(addr)).toBase58());
    const tok = staticTokens.find((t) => t.mintAddress === str.mint);
    if (tok) setManageMint(tok.symbol);
  }, [addr, staticTokens]);
  const onForgetStream = useCallback((pda: string) => {
    if (!addr) return;
    forgetStream(addr, pda);
    setMyStreams(listStreams(addr));
    if (manageMetadataBs58 === pda) {
      setManageMetadataBs58('');
      setManageRecipientBs58('');
    }
  }, [addr, manageMetadataBs58]);
  const [newRecipientBs58, setNewRecipientBs58] = useState('');
  const [tab, setTab] = useState<'create' | 'manage'>('create');

  const tokens = useMemo(
    () => staticTokens.filter((t) => SUPPORTED_SYMBOLS.includes(t.symbol)),
    [staticTokens],
  );

  // Read SPL ATA balances on Solana devnet for each supported mint.
  const tokenSpecs = useMemo(
    () =>
      tokens.map((t) => ({
        wrapper: t.address as `0x${string}`,
        mintAddress: t.mintAddress,
      })),
    [tokens],
  );
  const balances = useSolanaTokenBalances(
    tokenSpecs,
    wallet?.address as `0x${string}` | undefined,
  );

  // Re-key balances by mint bs58 (the screen needs this; useSolanaTokenBalances
  // returns by EVM wrapper for /swap consumption).
  const ataBalancesByMint: Record<string, number> = useMemo(() => {
    const out: Record<string, number> = {};
    for (const t of tokens) {
      const raw = balances[t.address.toLowerCase()] ?? 0n;
      out[t.mintAddress] = Number(raw) / 10 ** t.decimals;
    }
    return out;
  }, [balances, tokens]);

  // ATA existence pre-flight for the user's selected token. Cardo's
  // useAtaExists takes a mintHex — we need to scope it per-mint.
  // Sprint 1 simplification: only check the first (default) token's
  // ATA. UI treats the ATA-missing case the same regardless of which
  // token the user selects (asks them to bridge first).
  const firstMintHex = tokens[0]
    ? pubkeyBs58ToBytes32(tokens[0].mintAddress)
    : undefined;
  const firstAta = useAtaExists({
    userEvmAddress: wallet?.address as `0x${string}` | undefined,
    mintHex: firstMintHex,
  });
  const secondMintHex = tokens[1]
    ? pubkeyBs58ToBytes32(tokens[1].mintAddress)
    : undefined;
  const secondAta = useAtaExists({
    userEvmAddress: wallet?.address as `0x${string}` | undefined,
    mintHex: secondMintHex,
  });
  const ataStatusByMint: Record<string, 'exists' | 'missing' | 'unknown'> = useMemo(() => {
    const out: Record<string, 'exists' | 'missing' | 'unknown'> = {};
    if (tokens[0]) out[tokens[0].mintAddress] = firstAta.status;
    if (tokens[1]) out[tokens[1].mintAddress] = secondAta.status;
    return out;
  }, [tokens, firstAta.status, secondAta.status]);

  const onCreate = useCallback(
    async (args: CreateArgs) => {
      if (!wallet?.address) {
        connect?.();
        return;
      }
      // Recipient is a Solana bs58 pubkey (used as-is) or an EVM 0x address
      // (another cardo user → their Rome PDA on the active chain). The screen
      // gates submit on the same resolver, so 'invalid' can't reach here.
      const resolved = resolveRecipient(args.recipient, activeChainId);
      if (resolved.kind === 'invalid') return;
      const recipientHex: Hex = resolved.recipientHex;

      const mintHex = pubkeyBs58ToBytes32(args.mintBs58);
      const decimalMul = 10n ** BigInt(args.decimals);
      const netAmountDeposited = BigInt(
        Math.floor(args.amountHuman * Number(decimalMul)),
      );
      // Period math: amountPerPeriod = floor(net / numPeriods).
      // Re-anchor net to amountPerPeriod * numPeriods so the math is
      // exact and the program doesn't need to handle remainder.
      const durationBn = BigInt(args.durationSeconds);
      const numPeriods = durationBn / PERIOD_SECONDS;
      if (numPeriods <= 0n) return;
      const amountPerPeriod = netAmountDeposited / numPeriods;
      const reanchoredNet = amountPerPeriod * numPeriods;
      if (amountPerPeriod <= 0n || reanchoredNet <= 0n) return;

      // create_v2 creates ~5 accounts (metadata + escrow + init_if_needed
      // ATAs); their rent is paid by the user's Rome PDA. Ensure it holds
      // enough SOL first (funds via swap_gas_to_lamports if low; persists, so
      // this is amortized across streams). Separate persisting tx — not stacked
      // with create_v2 — to avoid the multi-write-CPI atomicity trap.
      const funded = await ensureLamports(wallet.address as `0x${string}`);
      if (funded !== 'ready') return;

      // Unique nonce per stream: the metadata PDA is derived from
      // (sender, nonce), so a fixed nonce collides on the user's 2nd+ stream.
      const nonce = Math.floor(Math.random() * 0xffffffff);

      // The metadata PDA is deterministic from (mint, sender=Rome PDA, nonce),
      // so we know it now — stash it; the success effect records it for Manage.
      try {
        const senderHex = deriveRomeUserPda(wallet.address as `0x${string}`);
        const metaHex = deriveStreamMetadata({ mint: mintHex, sender: senderHex, nonce });
        pendingStream.current = {
          metadataPda: bytes32ToPublicKey(metaHex).toBase58(),
          // Store the RESOLVED on-chain recipient (bs58) — Manage's cancel
          // needs the pubkey that's actually in the stream metadata, not the
          // 0x form the user may have typed.
          recipient: resolved.recipientBs58,
          mint: args.mintBs58,
          name: args.name,
          amount: String(args.amountHuman),
          cancelable: args.cancelable,
          canTopup: true, // must match the create args below
          createdAt: Date.now(),
        };
      } catch {
        pendingStream.current = null;
      }

      void create({
        userEvmAddress: wallet.address as `0x${string}`,
        recipientHex,
        mintHex,
        stream: {
          startTime: 0n, // 0 = use current
          netAmountDeposited: reanchoredNet,
          period: PERIOD_SECONDS,
          amountPerPeriod,
          cliff: 0n,
          cliffAmount: 0n,
          cancelableBySender: args.cancelable,
          cancelableByRecipient: false,
          automaticWithdrawal: false,
          transferableBySender: true,
          transferableByRecipient: false,
          // Topup must be opted into at create and is immutable afterwards —
          // the Manage tab offers "Topup stream", so streams have to be born
          // topup-able. (canTopup:false here made every Cardo stream reject
          // topup with Streamflow Custom(97), permanently.)
          canTopup: true,
          streamName: args.name,
          withdrawFrequency: PERIOD_SECONDS,
          pausable: false,
          canUpdateRate: false,
          nonce,
        },
      });
    },
    [wallet?.address, connect, create, ensureLamports, activeChainId],
  );

  // Helpers for the manage-stream extension panel.
  const onCancel = useCallback(() => {
    if (!wallet?.address) {
      connect?.();
      return;
    }
    let mintBs58: string | undefined;
    try {
      new PublicKey(manageMetadataBs58);
      new PublicKey(manageSenderBs58);
      new PublicKey(manageRecipientBs58);
      const tok = staticTokens.find((t) => t.symbol === manageMint);
      mintBs58 = tok?.mintAddress;
    } catch {
      return;
    }
    if (!mintBs58) return;
    void cancel({
      userEvmAddress: wallet.address as `0x${string}`,
      metadataHex: pubkeyBs58ToBytes32(manageMetadataBs58),
      mintHex: pubkeyBs58ToBytes32(mintBs58),
      senderHex: pubkeyBs58ToBytes32(manageSenderBs58),
      recipientHex: pubkeyBs58ToBytes32(manageRecipientBs58),
    });
  }, [wallet?.address, connect, cancel, manageMetadataBs58, manageSenderBs58, manageRecipientBs58, manageMint, staticTokens]);

  const onTopup = useCallback(() => {
    if (!wallet?.address) {
      connect?.();
      return;
    }
    let mintBs58: string | undefined;
    let decimals: number | undefined;
    try {
      new PublicKey(manageMetadataBs58);
      const tok = staticTokens.find((t) => t.symbol === manageMint);
      mintBs58 = tok?.mintAddress;
      decimals = tok?.decimals;
    } catch {
      return;
    }
    if (!mintBs58 || decimals === undefined) return;
    const amt = parseFloat(topupAmount);
    if (!Number.isFinite(amt) || amt <= 0) return;
    const decimalMul = 10n ** BigInt(decimals);
    const raw = BigInt(Math.floor(amt * Number(decimalMul)));
    if (raw <= 0n) return;
    void topup({
      userEvmAddress: wallet.address as `0x${string}`,
      metadataHex: pubkeyBs58ToBytes32(manageMetadataBs58),
      mintHex: pubkeyBs58ToBytes32(mintBs58),
      amount: raw,
    });
  }, [wallet?.address, connect, topup, manageMetadataBs58, manageMint, topupAmount, staticTokens]);

  const onUpdate = useCallback(() => {
    if (!wallet?.address || !manageMetadataBs58) return;
    void updateSubmit({
      userEvmAddress: wallet.address as `0x${string}`,
      metadataHex: pubkeyBs58ToBytes32(manageMetadataBs58),
      enableAutomaticWithdrawal: autoWithdraw,
      // Auto-withdrawal CADENCE — how often Streamflow's crank sweeps vested
      // tokens to the recipient — is NOT the vesting period. Enabling schedules
      // ~(duration / withdrawFrequency) withdrawals; at the 60s vesting period
      // a long stream schedules a prohibitive number (a 3-month stream = 129,600)
      // and the enable tx reverts InsufficientFunds. A coarse daily cadence
      // caps it (3-month → 90; well within the proven-safe range). Only sent
      // when enabling; left unchanged when disabling.
      withdrawFrequency: autoWithdraw ? AUTO_WITHDRAW_FREQUENCY_SECONDS : undefined,
    });
  }, [wallet?.address, updateSubmit, manageMetadataBs58, autoWithdraw]);

  const onTransfer = useCallback(() => {
    if (!wallet?.address || !manageMetadataBs58 || !newRecipientBs58) return;
    let newRecipientHex: Hex;
    try {
      new PublicKey(newRecipientBs58);
      newRecipientHex = pubkeyBs58ToBytes32(newRecipientBs58);
    } catch {
      return;
    }
    const tok = staticTokens.find((t) => t.symbol === manageMint);
    if (!tok) return;
    void transferSubmit({
      userEvmAddress: wallet.address as `0x${string}`,
      metadataHex: pubkeyBs58ToBytes32(manageMetadataBs58),
      mintHex: pubkeyBs58ToBytes32(tok.mintAddress),
      newRecipientHex,
    });
  }, [wallet?.address, transferSubmit, manageMetadataBs58, newRecipientBs58, manageMint, staticTokens]);

  const noMeta = !manageMetadataBs58;
  const notConnected = !wallet?.connected;
  // Streams recorded before topup-able creates shipped were created with
  // can_topup=false — immutable on-chain, so topup can never succeed on
  // them (Streamflow rejects with Custom(97)). Gate the button instead of
  // letting the user sign a guaranteed revert. Pasted PDAs we know nothing
  // about stay attemptable.
  const selectedStored = myStreams.find((str) => str.metadataPda === manageMetadataBs58);
  const topupBlocked = !!selectedStored && selectedStored.canTopup !== true;
  // True while any manage action is mid-flight (signing / confirming).
  const phaseBusy = (p: string) => p === 'signing' || p === 'confirming';
  const btnLabel = (
    phase: string,
    idle: string,
    done: string,
    fail: string,
  ) =>
    phase === 'signing'
      ? 'Awaiting signature…'
      : phase === 'confirming'
        ? 'Confirming on Solana…'
        : phase === 'success'
          ? done
          : phase === 'failed'
            ? fail
            : idle;

  const resolveRecipientForChain = useCallback(
    (input: string) => resolveRecipient(input, activeChainId),
    [activeChainId],
  );

  return (
    <Pay
      wallet={wallet}
      onConnect={connect}
      tokens={tokens}
      ataBalancesByMint={ataBalancesByMint}
      ataStatusByMint={ataStatusByMint}
      resolveRecipient={resolveRecipientForChain}
      onCreate={onCreate}
      createState={createState}
      tab={tab}
      onTab={setTab}
    >
      {/* Manage tab — act|see rig. (Was a legacy card buried ~870px below the
          fold with no signal it existed; now it's a first-class tab.) */}
      <div className={s.rig}>
        <div className={`${s.col} ${s.act}`}>
          <div className={s.colhd}>
            <span className={s.sd} /> Manage a stream
          </div>

          <div className={s.field}>
            <label>Your streams</label>
            {myStreams.length === 0 ? (
              <div className={s.usd} style={{ marginTop: 8 }}>
                Streams you open in the Create tab appear here to manage — no need to look anything up.
              </div>
            ) : (
              <div style={{ marginTop: 8, display: 'flex', flexDirection: 'column', gap: 6 }}>
                {myStreams.map((str) => {
                  const sym = staticTokens.find((t) => t.mintAddress === str.mint)?.symbol ?? '';
                  const active = manageMetadataBs58 === str.metadataPda;
                  return (
                    <div
                      key={str.metadataPda}
                      role="button"
                      tabIndex={0}
                      onClick={() => selectStream(str)}
                      onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') selectStream(str); }}
                      className={s.btn2}
                      style={{ textAlign: 'left', borderColor: active ? 'var(--accent)' : undefined, cursor: 'pointer' }}
                    >
                      <div style={{ display: 'flex', justifyContent: 'space-between', gap: 10 }}>
                        <span className={s.sym}>{str.name || 'Stream'}</span>
                        <span className={s.bal}>{str.amount} {sym}</span>
                      </div>
                      <div style={{ marginTop: 4, display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 10 }}>
                        <span className={s.usd}>→ <Address value={str.recipient} /></span>
                        <span
                          role="button"
                          tabIndex={0}
                          onClick={(e) => { e.stopPropagation(); onForgetStream(str.metadataPda); }}
                          onKeyDown={(e) => { if (e.key === 'Enter') { e.stopPropagation(); onForgetStream(str.metadataPda); } }}
                          className={s.usd}
                          style={{ cursor: 'pointer' }}
                          title="Remove from this list"
                        >
                          forget
                        </span>
                      </div>
                    </div>
                  );
                })}
              </div>
            )}
            {manageMetadataBs58 && (
              <div className={s.usd} style={{ marginTop: 8 }}>
                Managing <Address value={manageMetadataBs58} /> · {manageMint}
              </div>
            )}
          </div>

          <div className={s.field}>
            <button
              type="button"
              className={s.btn2}
              disabled={notConnected || noMeta || !manageSenderBs58 || !manageRecipientBs58 || phaseBusy(cancelState.phase)}
              onClick={onCancel}
            >
              {btnLabel(cancelState.phase, 'Cancel stream', 'Stream cancelled ✓', 'Cancel failed — try again')}
            </button>
            {cancelState.phase === 'failed' && cancelState.error && (
              <TxError error={cancelState.error} />
            )}
          </div>

          <div className={s.field}>
            <label htmlFor="mng-topup">Topup amount · {manageMint}</label>
            <input
              id="mng-topup"
              className={s.txt}
              inputMode="decimal"
              placeholder="0.00"
              value={topupAmount}
              onChange={(e) => setTopupAmount(e.target.value)}
            />
            <button
              type="button"
              className={s.btn2}
              style={{ marginTop: 10 }}
              disabled={notConnected || noMeta || !topupAmount || topupBlocked || phaseBusy(topupState.phase)}
              onClick={onTopup}
            >
              {btnLabel(topupState.phase, 'Topup stream', 'Topup ✓', 'Topup failed — try again')}
            </button>
            {topupBlocked && (
              <div className={s.usd} style={{ marginTop: 8 }}>
                This stream was created before topup was enabled (its on-chain{' '}
                <span className={s.mono}>can_topup</span> flag is permanently off). Create a new
                stream to add funds.
              </div>
            )}
            {topupState.phase === 'failed' && topupState.error && (
              <TxError error={topupState.error} />
            )}
          </div>

          <div className={s.field}>
            <label style={{ display: 'flex', alignItems: 'center', gap: 8, cursor: 'pointer', textTransform: 'none', letterSpacing: 0, color: 'var(--text)' }}>
              <input type="checkbox" checked={autoWithdraw} onChange={(e) => setAutoWithdraw(e.target.checked)} />
              Enable automatic withdrawal
            </label>
            <button
              type="button"
              className={s.btn2}
              style={{ marginTop: 10 }}
              disabled={notConnected || noMeta || phaseBusy(updateState.phase)}
              onClick={onUpdate}
            >
              {btnLabel(updateState.phase, 'Update stream (set auto-withdraw)', 'Stream updated ✓', 'Update failed — try again')}
            </button>
            {updateState.phase === 'failed' && updateState.error && (
              <TxError error={updateState.error} />
            )}
          </div>

          <div className={s.field}>
            <label htmlFor="mng-newrecip">New recipient pubkey</label>
            <input
              id="mng-newrecip"
              className={s.txt}
              value={newRecipientBs58}
              onChange={(e) => setNewRecipientBs58(e.target.value.trim())}
              placeholder="bs58 pubkey of new recipient"
            />
            <button
              type="button"
              className={s.btn2}
              style={{ marginTop: 10 }}
              disabled={notConnected || noMeta || !newRecipientBs58 || phaseBusy(transferState.phase)}
              onClick={onTransfer}
            >
              {btnLabel(transferState.phase, 'Transfer recipient', 'Recipient transferred ✓', 'Transfer failed — try again')}
            </button>
            {transferState.phase === 'failed' && transferState.error && (
              <TxError error={transferState.error} />
            )}
          </div>
        </div>

        <section className={`${s.col} ${s.see}`}>
          <div className={s.colhd}>
            <span className={s.sd} /> What will happen
            <span className={s.pool}>Streamflow · manage</span>
          </div>
          <div className={s.body}>
            <div className={s.outcome}>
              <div className={s.note}>
                Paste the stream&apos;s metadata PDA, then act on it. <b>Cancel</b> terminates and
                refunds (needs the original sender + recipient). <b>Topup</b> adds tokens (only if the
                stream&apos;s <span className={s.mono}>can_topup</span> flag was set at create).
                <b> Transfer</b> hands the stream to a new recipient. Each is one signature, signed by
                your Rome account.
              </div>
              {notConnected && (
                <div className={s.note} style={{ marginTop: 10 }}>
                  Connect your wallet (Create tab) to enable these actions.
                </div>
              )}
            </div>
          </div>
        </section>
      </div>
    </Pay>
  );
}
