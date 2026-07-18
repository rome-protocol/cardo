// /pool/new — Meteora DAMM v1 pool creation route.
//
// Wires the CreatePool screen to:
//   - the live token list + balances + Solana balances (same hooks as /swap)
//   - the vault-existence pre-flight (`useMeteoraVaultsExist`)
//   - the calldata builder in lib/meteora-pool-create.ts
//   - the CPI precompile via wagmi's writeContract
//
// Submission path mirrors /swap: bytes32 program, AccountMeta[], bytes
// data → `0xFF…08`. Manual receipt poll fallback for Rome' flaky
// useWaitForTransactionReceipt.

'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import { parseUnits, type Address } from 'viem';
import { useWaitForTransactionReceipt } from 'wagmi';
import { useRomeWrite } from '@/lib/use-rome-write';
import { CreatePool } from '@/components/screens/CreatePool';
import { useWallet } from '../../wallet-context';
import { useChainTokens } from '@/lib/use-chain-tokens';
import { useTokenBalances } from '@/lib/use-token-balances';
import { useSolanaTokenBalances } from '@/lib/use-solana-balances';
import { CPI_PRECOMPILE, CPI_INVOKE_ABI } from '@/lib/cpi-precompile';
import { useMeteoraVaultsExist } from '@/lib/use-pool-vault-check';
import { useMeteoraVaultStates } from '@/lib/use-meteora-vault-states';
import { usePoolExists } from '@/lib/use-pool-exists';
import {
  buildChainMeteoraPoolInitInvoke,
  derivePoolCreateAddresses,
  type PoolCreateAddresses,
  type VaultStateOverrides,
} from '@/lib/meteora-pool-create';
import { pubkeyBs58ToBytes32 } from '@/lib/solana-pda';
import { useVaultInit } from '@/lib/use-vault-init';
import { useDeployToken } from '@/lib/use-deploy-token';
import { useUserDeployedTokens } from '@/lib/use-user-deployed-tokens';
import { useUserPools, type UserPool } from '@/lib/use-user-pools';
import { pubkeyToBytes32 } from '@/lib/solana-pda';

type FormInputs = {
  fromSym: string;
  toSym: string;
  amountA: number;
  amountB: number;
  feeBps: bigint;
};

export default function PoolNewPage() {
  const { wallet, connect } = useWallet();
  const { tokens: factoryTokens } = useChainTokens();

  // User-deployed tokens persist across reloads via localStorage.
  // Merging them onto the factory/static list lets a freshly-deployed
  // wrapper appear in the picker without us redeploying Cardo.
  const { tokens: userTokens, add: addUserToken } = useUserDeployedTokens();
  const chainTokens = useMemo(() => {
    const seen = new Set(factoryTokens.map((t) => t.address.toLowerCase()));
    return [
      ...factoryTokens,
      ...userTokens.filter((t) => !seen.has(t.address.toLowerCase())),
    ];
  }, [factoryTokens, userTokens]);

  const tokenAddresses = useMemo<Address[]>(
    () => chainTokens.map((t) => t.address),
    [chainTokens],
  );
  const { balances: evmBalances, registration } = useTokenBalances(
    tokenAddresses,
    wallet.connected && wallet.address ? (wallet.address as Address) : undefined,
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
      if (sol !== undefined) merged[key] = sol;
      else if (evm !== undefined) merged[key] = evm;
    }
    return merged;
  }, [chainTokens, evmBalances, solBalances]);

  // Vault pre-flight for every token in the discovered list — keeps the
  // hook order stable regardless of which pair is selected, and the read
  // is cheap (single getMultipleAccounts).
  const mintHexList = useMemo(
    () =>
      chainTokens
        .filter((t) => !!t.mintAddress)
        .map((t) => pubkeyBs58ToBytes32(t.mintAddress)),
    [chainTokens],
  );
  const vaultsExist = useMeteoraVaultsExist(mintHexList);
  const refreshVaultsExist = vaultsExist.refresh;

  // Read each vault's actual on-chain state (token_vault, lp_mint).
  // Needed because some vaults — Rome' WSOL is one — store a non-PDA
  // lp_mint, so deriving by `["lp_mint", vault]` produces the wrong
  // address. The pool init's Anchor constraints fail with 3012
  // (AccountNotInitialized) when we pass a derived-but-wrong pubkey.
  const vaultStates = useMeteoraVaultStates(mintHexList);
  const refreshVaultStates = vaultStates.refresh;
  const vaultOverrides: VaultStateOverrides = useMemo(() => {
    const out: VaultStateOverrides = {};
    for (const [mintHex, info] of Object.entries(vaultStates.byMint)) {
      if (info) {
        out[mintHex] = {
          tokenVault: info.tokenVaultBytes32,
          lpMint: info.lpMintBytes32,
        };
      }
    }
    return out;
  }, [vaultStates.byMint]);

  // Map mint hex (lowercased) — same key shape useMeteoraVaultsExist returns.
  const vaultsExistByMintHex = useMemo(() => {
    const remapped: Record<string, 'exists' | 'missing' | 'unknown'> = {};
    for (const t of chainTokens) {
      if (!t.mintAddress) continue;
      const hex = pubkeyBs58ToBytes32(t.mintAddress).toLowerCase();
      // Re-key by mint base58 lowercased so the screen can look up by
      // `t.mintAddress.toLowerCase()` directly without recomputing hex.
      remapped[t.mintAddress.toLowerCase()] = vaultsExist.byMint[hex] ?? 'unknown';
    }
    return remapped;
  }, [chainTokens, vaultsExist.byMint]);

  // Form state lifted from CreatePool so we can derive PDAs in the
  // wrapper. The screen pushes its inputs up via onPreviewChange.
  const [form, setForm] = useState<FormInputs | null>(null);

  const preview = useMemo(() => {
    if (!form || !wallet.connected || !wallet.address) return undefined;
    const fromTok = chainTokens.find((t) => t.symbol === form.fromSym);
    const toTok = chainTokens.find((t) => t.symbol === form.toSym);
    if (!fromTok || !toTok || !fromTok.mintAddress || !toTok.mintAddress) return undefined;
    if (fromTok.mintAddress === toTok.mintAddress) return undefined;
    try {
      const addresses: PoolCreateAddresses = derivePoolCreateAddresses({
        userEvmAddress: wallet.address as Address,
        mintAHex: pubkeyBs58ToBytes32(fromTok.mintAddress),
        mintBHex: pubkeyBs58ToBytes32(toTok.mintAddress),
        tradeFeeBps: form.feeBps,
        vaultOverrides,
      });
      return { addresses };
    } catch {
      return undefined;
    }
  }, [form, chainTokens, wallet, vaultOverrides]);

  // Pool-already-exists pre-flight. The pool PDA is deterministic for
  // (mintA, mintB, feeBps); if Meteora has previously initialized it
  // we surface the existing address and disable submit.
  const fromTokForExists = form
    ? chainTokens.find((t) => t.symbol === form.fromSym)
    : undefined;
  const toTokForExists = form
    ? chainTokens.find((t) => t.symbol === form.toSym)
    : undefined;
  const poolExists = usePoolExists({
    userEvmAddress:
      wallet.connected && wallet.address ? (wallet.address as Address) : undefined,
    mintAHex: fromTokForExists?.mintAddress
      ? pubkeyBs58ToBytes32(fromTokForExists.mintAddress)
      : undefined,
    mintBHex: toTokForExists?.mintAddress
      ? pubkeyBs58ToBytes32(toTokForExists.mintAddress)
      : undefined,
    tradeFeeBps: form?.feeBps,
  });

  // ── Submit path ────────────────────────────────────────────────────
  const {
    writeContract,
    data: submittedHash,
    isPending: isSigning,
    error: writeError,
    reset: resetWrite,
  } = useRomeWrite();
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
    if (wagmiReceipt) return;
    if (pollReceipt?.transactionHash === submittedHash) return;
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
          setPollReceipt({
            status: json.result.status === '0x1' ? 'success' : 'reverted',
            transactionHash: json.result.transactionHash,
          });
          return;
        }
      } catch {
        // keep polling
      }
      if (Date.now() - start > 90_000) return;
      setTimeout(tick, 2_000);
    };
    setTimeout(tick, 1_500);
    return () => {
      cancelled = true;
    };
  }, [submittedHash, wagmiReceipt, pollReceipt?.transactionHash]);

  const receipt = wagmiReceipt ?? pollReceipt;
  const [submitError, setSubmitError] = useState<string | null>(null);
  useEffect(() => {
    const err = writeError || receiptError;
    if (err) {
      const msg = (err as Error).message ?? String(err);
      setSubmitError(msg);
      // eslint-disable-next-line no-console
      console.error('[cardo pool-create] submit failed', err);
    }
  }, [writeError, receiptError]);

  const txState = useMemo(() => {
    if (submitError) return { status: 'failed' as const, error: submitError, hash: submittedHash };
    if (receipt) {
      if (receipt.status === 'reverted') {
        return { status: 'failed' as const, hash: submittedHash, error: 'Pool init reverted on-chain' };
      }
      return { status: 'confirmed' as const, hash: submittedHash };
    }
    if (isConfirming) return { status: 'confirming' as const, hash: submittedHash };
    if (submittedHash) return { status: 'submitting' as const, hash: submittedHash };
    if (isSigning) return { status: 'signing' as const };
    return { status: 'idle' as const };
  }, [submitError, receipt, isConfirming, submittedHash, isSigning]);

  const onSubmit = useCallback(
    (s: FormInputs) => {
      setSubmitError(null);
      resetWrite();
      if (!wallet.connected || !wallet.address) {
        connect();
        return;
      }
      const fromTok = chainTokens.find((t) => t.symbol === s.fromSym);
      const toTok = chainTokens.find((t) => t.symbol === s.toSym);
      if (!fromTok || !toTok || !fromTok.mintAddress || !toTok.mintAddress) {
        setSubmitError('Selected tokens have no SPL mint metadata.');
        return;
      }
      try {
        // Caller's A/B labeling is preserved end-to-end. Meteora's pool
        // PDA seed sorts the mints internally (collision-free across
        // A/B-flipped inputs) but the *stored* token_a_mint vs
        // token_b_mint come straight from the caller's order, so
        // `tokenAAmount` matches the user's "from" side.
        const tokenAAmount = parseUnits(String(s.amountA), fromTok.decimals);
        const tokenBAmount = parseUnits(String(s.amountB), toTok.decimals);
        const fromMintHex = pubkeyBs58ToBytes32(fromTok.mintAddress);
        const toMintHex = pubkeyBs58ToBytes32(toTok.mintAddress);

        // eslint-disable-next-line no-console
        console.log('[cardo pool-create] submit', {
          fromSym: s.fromSym,
          toSym: s.toSym,
          amountA_typed: s.amountA,
          amountB_typed: s.amountB,
          fromTok_decimals: fromTok.decimals,
          toTok_decimals: toTok.decimals,
          tokenAAmount_raw: tokenAAmount.toString(),
          tokenBAmount_raw: tokenBAmount.toString(),
          tokenAAmount_human: Number(tokenAAmount) / 10 ** fromTok.decimals,
          tokenBAmount_human: Number(tokenBAmount) / 10 ** toTok.decimals,
          feeBps: s.feeBps.toString(),
        });

        const { program, accounts, data } = buildChainMeteoraPoolInitInvoke({
          userEvmAddress: wallet.address as Address,
          mintAHex: fromMintHex,
          mintBHex: toMintHex,
          tradeFeeBps: s.feeBps,
          tokenAAmount,
          tokenBAmount,
          vaultOverrides,
        });
        writeContract({
          address: CPI_PRECOMPILE,
          abi: CPI_INVOKE_ABI,
          functionName: 'invoke',
          args: [program, accounts, data],
          // Pool init creates many accounts and has no measured charge yet —
          // keep the old explicit 50M ceiling (useRomeWrite fills gasPrice).
          gas: 50_000_000n,
        });
      } catch (e) {
        const msg = (e as Error).message ?? String(e);
        setSubmitError(msg);
        // eslint-disable-next-line no-console
        console.error('[cardo pool-create] calldata build failed', e);
      }
    },
    [wallet, connect, chainTokens, resetWrite, writeContract, vaultOverrides],
  );

  // Token deploy flow — fresh SPL mint + ERC20-SPL wrapper from the
  // user's wallet. Triggered from the "Deploy new token" modal in
  // CreatePool. Uses the user's existing factory registration to skip
  // create_user when we already have evidence of it.
  const { state: deployTokenState, deploy: deployToken, reset: resetDeployToken } =
    useDeployToken();
  const factoryRegistered = useMemo(
    () => Object.values(registration).some((r) => r === 'registered'),
    [registration],
  );
  const onDeployToken = useCallback(
    (form: { symbol: string; name: string; mintAmountHuman: number }) => {
      if (!wallet.connected || !wallet.address) {
        connect();
        return;
      }
      deployToken({
        userAddress: wallet.address as Address,
        symbol: form.symbol,
        name: form.name,
        mintAmountHuman: form.mintAmountHuman,
        factoryRegistered,
      });
    },
    [wallet, connect, deployToken, factoryRegistered],
  );

  // When a deploy succeeds, persist the new wrapper to localStorage
  // so it appears in the picker on subsequent renders.
  useEffect(() => {
    if (
      deployTokenState.phase === 'success' &&
      deployTokenState.wrapper &&
      deployTokenState.symbol &&
      deployTokenState.mint
    ) {
      // bytes32 mint hex → base58
      const mintHex = deployTokenState.mint.toLowerCase().replace(/^0x/, '');
      // We need bs58 here; use viem's helper through an inline import
      // path. Lib already pulls bs58 elsewhere.
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const bs58 = require('bs58').default ?? require('bs58');
      const mintBs58 = bs58.encode(Buffer.from(mintHex, 'hex'));
      addUserToken({
        address: deployTokenState.wrapper.toLowerCase() as Address,
        symbol: deployTokenState.symbol,
        name: deployTokenState.name ?? deployTokenState.symbol,
        decimals: 9, // factory's DEFAULT_DECIMALS
        mintAddress: mintBs58,
        tokenType: 'erc20spl',
        swappable: false,
      });
    }
  }, [
    deployTokenState.phase,
    deployTokenState.wrapper,
    deployTokenState.symbol,
    deployTokenState.name,
    deployTokenState.mint,
    addUserToken,
  ]);

  // Vault-init flow: when a token doesn't have a Meteora vault yet,
  // surface a "Create vault" button next to the missing-vault row.
  // One signed tx per missing mint via the same CPI precompile path.
  const { state: vaultInitState, initVault } = useVaultInit();

  // Persist freshly-created Meteora pools so /swap can route through
  // them. Keyed by pool PDA in localStorage; survives reloads.
  const { add: addUserPool } = useUserPools();
  useEffect(() => {
    if (txState.status !== 'confirmed' || !preview?.addresses || !form) return;
    const fromTok = chainTokens.find((t) => t.symbol === form.fromSym);
    const toTok = chainTokens.find((t) => t.symbol === form.toSym);
    if (!fromTok || !toTok) return;
    const aMintInfo = vaultStates.byMint[
      pubkeyBs58ToBytes32(fromTok.mintAddress).toLowerCase()
    ];
    const bMintInfo = vaultStates.byMint[
      pubkeyBs58ToBytes32(toTok.mintAddress).toLowerCase()
    ];
    if (!aMintInfo || !bMintInfo) return;
    const a = preview.addresses;
    const userPool: UserPool = {
      label: `${fromTok.symbol} / ${toTok.symbol} @ ${(Number(form.feeBps) / 100).toFixed(2)}%`,
      feeBps: Number(form.feeBps),
      pool: {
        pool: pubkeyToBytes32(a.pool),
        aVault: pubkeyToBytes32(a.aVault),
        bVault: pubkeyToBytes32(a.bVault),
        aVaultLp: pubkeyToBytes32(a.aVaultLp),
        bVaultLp: pubkeyToBytes32(a.bVaultLp),
        aTokenVault: aMintInfo.tokenVaultBytes32,
        bTokenVault: bMintInfo.tokenVaultBytes32,
        aVaultLpMint: aMintInfo.lpMintBytes32,
        bVaultLpMint: bMintInfo.lpMintBytes32,
        vaultProgram: pubkeyBs58ToBytes32('24Uqj9JCLxUeoC3hGfh5W3s9FM9uCHDS2SG3LYwBpyTi'),
        tokenProgram: pubkeyBs58ToBytes32('TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA'),
        protocolTokenAFee: pubkeyToBytes32(a.protocolTokenAFee),
        protocolTokenBFee: pubkeyToBytes32(a.protocolTokenBFee),
        splMintA: pubkeyBs58ToBytes32(fromTok.mintAddress),
        splMintB: pubkeyBs58ToBytes32(toTok.mintAddress),
      },
      wrapperA: fromTok.address.toLowerCase(),
      wrapperB: toTok.address.toLowerCase(),
      symbolA: fromTok.symbol,
      symbolB: toTok.symbol,
    };
    addUserPool(userPool);
  }, [txState.status, preview?.addresses, form, chainTokens, vaultStates.byMint, addUserPool]);

  // When vault init succeeds, kick the existence + state polls right
  // away instead of waiting up to 8s for the next periodic refresh.
  // Fixes the &quot;vault said done but the Create pool button stayed dim&quot;
  // window where state was stale until a manual page reload.
  useEffect(() => {
    if (vaultInitState?.phase === 'success') {
      refreshVaultsExist();
      refreshVaultStates();
    }
  }, [vaultInitState?.phase, refreshVaultsExist, refreshVaultStates]);
  const onInitVault = useCallback(
    (mintBs58: string) => {
      if (!wallet.connected || !wallet.address) {
        connect();
        return;
      }
      initVault({
        userEvmAddress: wallet.address as Address,
        mintHex: pubkeyBs58ToBytes32(mintBs58),
      });
    },
    [wallet, connect, initVault],
  );

  return (
    <CreatePool
      wallet={wallet}
      onConnect={connect}
      tokens={chainTokens}
      balances={wallet.connected ? balances : undefined}
      vaultsExist={{
        byMint: vaultsExistByMintHex,
        allExist: vaultsExist.allExist,
        loading: vaultsExist.loading,
      }}
      poolExists={poolExists}
      onPreviewChange={setForm}
      preview={preview}
      txState={txState}
      onSubmit={onSubmit}
      onInitVault={onInitVault}
      vaultInitState={vaultInitState}
      onDeployToken={onDeployToken}
      onResetDeployToken={resetDeployToken}
      deployTokenState={deployTokenState}
    />
  );
}
