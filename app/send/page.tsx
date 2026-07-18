// Send route `/send` — SPL TransferChecked from user's PDA-owned ATA
// to a recipient's wallet (their derived ATA must exist).
// Family 8, Phase A — Tier A0 finisher.
//
// Per the integration roadmap at
//   the docs/active/technical/2026-04-25-cardo-solana-integration-roadmap.md

'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import { type Hex } from 'viem';
import { PublicKey } from '@solana/web3.js';
import { Send } from '@/components/screens/Send';
import { useWallet } from '../wallet-context';
import { romeStaticTokens } from '@/lib/addresses';
import { useActiveChainId } from '@/lib/env-context';
import { resolveRecipient } from '@/lib/recipient-resolve';
import { useSolanaTokenBalances } from '@/lib/use-solana-balances';
import { useSplTransfer } from '@/lib/use-spl-transfer';
import { useEnsureRecipientAta } from '@/lib/use-ensure-recipient-ata';
import {
  useSplApprove,
  useSplBurn,
  useSplCloseAccount,
  useSplRevoke,
  useSplSyncNative,
} from '@/lib/use-spl-token-actions';
import {
  bytes32ToPublicKey,
  deriveAta,
  pubkeyBs58ToBytes32,
} from '@/lib/solana-pda';

type SendArgs = {
  recipient: string;
  mintBs58: string;
  amountHuman: number;
  decimals: number;
  symbol: string;
};

// Must match the registry's spl_wrapper symbols verbatim (lowercase `w`
// prefix per Rome token nomenclature: wUSDC/wSOL). The old ['WUSDC','WWSOL']
// matched nothing → empty token list → /send could never load a balance.
const SUPPORTED_SYMBOLS = ['wUSDC', 'wSOL'];
const RPC = '/api/rpc/solana-devnet';
const ATA_POLL_MS = 8_000;

type TokenInfo = {
  symbol: string;
  decimals: number;
  mintAddress: string;
};

export default function Page() {
  const activeChainId = useActiveChainId();
  const staticTokens = romeStaticTokens(activeChainId);
  const { wallet, connect } = useWallet();
  const { state: sendState, send } = useSplTransfer();
  // Recipient-ATA creation: the transfer is a single TransferChecked and
  // won't create the recipient's token account, so when it's missing we
  // create it first via HelperProgram.create_ata_for_key (precompile,
  // operator-fronted rent — works without the sender holding SOL; the raw
  // ATA-program create reverts Custom(1), and the wrapper's egress
  // ensureRecipientAta selector is absent on older deploys).
  const { ensure: ensureRecipientAta } = useEnsureRecipientAta();
  const { state: approveState, submit: approveSubmit } = useSplApprove();
  const { state: revokeState, submit: revokeSubmit } = useSplRevoke();
  const { state: burnState, submit: burnSubmit } = useSplBurn();
  const { state: closeState, submit: closeSubmit } = useSplCloseAccount();
  const { state: syncState, submit: syncSubmit } = useSplSyncNative();
  const [tab, setTab] = useState<'main' | 'actions'>('main');

  const tokens = useMemo(
    () => staticTokens.filter((t) => SUPPORTED_SYMBOLS.includes(t.symbol)),
    [staticTokens],
  );

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

  const ataBalancesByMint: Record<string, number> = useMemo(() => {
    const out: Record<string, number> = {};
    for (const t of tokens) {
      const raw = balances[t.address.toLowerCase()] ?? 0n;
      out[t.mintAddress] = Number(raw) / 10 ** t.decimals;
    }
    return out;
  }, [balances, tokens]);

  // Recipient-ATA pre-flight: re-derives the ATA whenever the
  // (recipient bs58, selected mint) tuple changes. The screen surfaces
  // those values via the `onRecipientChange` and `onTokenChange`
  // callbacks (same pattern Lend uses for `onQuoteInputsChange`).
  const [recipient, setRecipient] = useState('');
  const [selectedMintBs58, setSelectedMintBs58] = useState<string | undefined>(
    tokens[0]?.mintAddress,
  );
  const [recipientAtaStatus, setRecipientAtaStatus] = useState<
    'unknown' | 'exists' | 'missing'
  >('unknown');

  useEffect(() => {
    if (!recipient || !selectedMintBs58) {
      setRecipientAtaStatus('unknown');
      return;
    }
    // Solana pubkey or EVM 0x (→ their Rome PDA on the active chain) — the
    // ATA pre-flight probes whichever wallet the transfer will target.
    const resolved = resolveRecipient(recipient, activeChainId);
    if (resolved.kind === 'invalid') {
      setRecipientAtaStatus('unknown');
      return;
    }
    let cancelled = false;
    const recipientHex = resolved.recipientHex;
    const mintHex = pubkeyBs58ToBytes32(selectedMintBs58);
    const ata = bytes32ToPublicKey(deriveAta(recipientHex, mintHex)).toBase58();

    const run = async () => {
      try {
        const res = await fetch(RPC, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            jsonrpc: '2.0',
            id: 1,
            method: 'getAccountInfo',
            // 'confirmed' so the badge flips right after an ensure/create
            // lands (finalized lags the Rome receipt by ~13s+).
            params: [ata, { encoding: 'base64', commitment: 'confirmed' }],
          }),
        });
        const json = await res.json();
        if (cancelled) return;
        setRecipientAtaStatus(json.result?.value ? 'exists' : 'missing');
      } catch {
        if (!cancelled) setRecipientAtaStatus('unknown');
      }
    };
    void run();
    const id = setInterval(run, ATA_POLL_MS);
    return () => {
      cancelled = true;
      clearInterval(id);
    };
  }, [recipient, selectedMintBs58, activeChainId]);

  const onSend = useCallback(
    async (args: SendArgs) => {
      if (!wallet?.address) {
        connect?.();
        return;
      }
      const resolved = resolveRecipient(args.recipient, activeChainId);
      if (resolved.kind === 'invalid') return;
      const recipientHex: Hex = resolved.recipientHex;
      const mintHex = pubkeyBs58ToBytes32(args.mintBs58);
      const decimalMul = 10n ** BigInt(args.decimals);
      const amount = BigInt(Math.floor(args.amountHuman * Number(decimalMul)));
      if (amount <= 0n) return;
      // First send to a wallet that's never held this token: create the
      // recipient's ATA (idempotent) so the TransferChecked lands instead of
      // reverting. Skip when we've confirmed it already exists (1-sig path).
      if (recipientAtaStatus !== 'exists') {
        const r = await ensureRecipientAta({ recipientWalletHex: recipientHex, mintHex });
        if (r !== 'success') return;
      }
      void send({
        userEvmAddress: wallet.address as `0x${string}`,
        recipientWalletHex: recipientHex,
        mintHex,
        decimals: args.decimals,
        amount,
        symbol: args.symbol,
      });
    },
    [wallet?.address, connect, send, ensureRecipientAta, recipientAtaStatus, activeChainId],
  );

  const onApprove = useCallback(
    ({ token, delegate, amount }: { token: TokenInfo; delegate: string; amount: number }) => {
      if (!wallet?.address) return;
      let delegateHex: Hex;
      try {
        new PublicKey(delegate);
        delegateHex = pubkeyBs58ToBytes32(delegate);
      } catch {
        return;
      }
      const decimalMul = 10n ** BigInt(token.decimals);
      const raw = BigInt(Math.floor(amount * Number(decimalMul)));
      if (raw <= 0n) return;
      void approveSubmit({
        userEvmAddress: wallet.address as `0x${string}`,
        mintHex: pubkeyBs58ToBytes32(token.mintAddress),
        delegateHex,
        amount: raw,
        decimals: token.decimals,
      });
    },
    [wallet?.address, approveSubmit],
  );

  const onRevoke = useCallback(
    ({ token }: { token: TokenInfo }) => {
      if (!wallet?.address) return;
      void revokeSubmit({
        userEvmAddress: wallet.address as `0x${string}`,
        mintHex: pubkeyBs58ToBytes32(token.mintAddress),
      });
    },
    [wallet?.address, revokeSubmit],
  );

  const onBurn = useCallback(
    ({ token, amount }: { token: TokenInfo; amount: number }) => {
      if (!wallet?.address) return;
      const decimalMul = 10n ** BigInt(token.decimals);
      const raw = BigInt(Math.floor(amount * Number(decimalMul)));
      if (raw <= 0n) return;
      void burnSubmit({
        userEvmAddress: wallet.address as `0x${string}`,
        mintHex: pubkeyBs58ToBytes32(token.mintAddress),
        amount: raw,
        decimals: token.decimals,
      });
    },
    [wallet?.address, burnSubmit],
  );

  const onClose = useCallback(
    ({ token }: { token: TokenInfo }) => {
      if (!wallet?.address) return;
      void closeSubmit({
        userEvmAddress: wallet.address as `0x${string}`,
        mintHex: pubkeyBs58ToBytes32(token.mintAddress),
      });
    },
    [wallet?.address, closeSubmit],
  );

  const onSyncNative = useCallback(() => {
    if (!wallet?.address) return;
    const wsol = staticTokens.find((t) => t.symbol === 'wSOL');
    if (!wsol) return;
    void syncSubmit({
      userEvmAddress: wallet.address as `0x${string}`,
      wsolMintHex: pubkeyBs58ToBytes32(wsol.mintAddress),
    });
  }, [wallet?.address, syncSubmit, staticTokens]);

  const resolveRecipientForChain = useCallback(
    (input: string) => resolveRecipient(input, activeChainId),
    [activeChainId],
  );

  return (
    <Send
      wallet={wallet}
      onConnect={connect}
      tokens={tokens}
      ataBalancesByMint={ataBalancesByMint}
      resolveRecipient={resolveRecipientForChain}
      recipientAtaStatus={recipientAtaStatus}
      onRecipientChange={setRecipient}
      onTokenChange={(symbol: string) => {
        const t = tokens.find((x) => x.symbol === symbol);
        setSelectedMintBs58(t?.mintAddress);
      }}
      onSend={onSend}
      sendState={sendState}
      tab={tab}
      onTab={setTab}
      onApprove={onApprove}
      approveState={approveState}
      onRevoke={onRevoke}
      revokeState={revokeState}
      onBurn={onBurn}
      burnState={burnState}
      onClose={onClose}
      closeState={closeState}
      onSyncNative={onSyncNative}
      syncState={syncState}
    />
  );
}
