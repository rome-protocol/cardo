// useKaminoAction — submit a Kamino write action (deposit / withdraw /
// borrow / repay) via direct-precompile.
//
// Single popup per action: Kamino's v2 instructions take a
// `deposit_reserves_iter` slot at the end of the account list, and the
// on-chain handler refreshes those reserves inline as part of the
// action. So we don't need separate refresh_reserve / refresh_obligation
// txs ahead of the action — one Rome tx covers refresh + action.
//
// Pre-conditions (caller must verify before calling `execute`):
//   - User EVM wallet connected (msg.sender at the precompile becomes
//     the user's Rome PDA via auto-sign).
//   - User's Kamino UserMetadata + Vanilla obligation exist (via
//     useKaminoSetup if missing).
//   - User has the source-liquidity ATA on Solana for the reserve mint
//     (covered today: USDC + WSOL ATAs land via the WUSDC/WWSOL
//     wrapper-registration setup button on /swap).
//   - User's destination-collateral ATA exists for the cToken mint —
//     **not yet pre-flighted in Cardo**; if missing the deposit will
//     revert with AccountNotInitialized. Surfacing this is a follow-up.

import { useCallback, useState } from 'react';
import { useRomeWrite } from './use-rome-write';
import type { Address, Hex } from 'viem';
import { CPI_PRECOMPILE, CPI_INVOKE_ABI } from './cpi-precompile';
import {
  buildBorrowInvoke,
  buildDepositInvoke,
  buildRepayInvoke,
  buildWithdrawInvoke,
  deriveUserReserveAtas,
  type KaminoObligationAccounts,
  type KaminoReserveAccounts,
} from './kamino-instructions';
import { deriveVanillaObligation } from './kamino-pdas';
import { deriveRomeUserPda } from './solana-pda';
import type { KaminoMarket, KaminoReserve } from './kamino-markets';

export type KaminoActionKind = 'deposit' | 'withdraw' | 'borrow' | 'repay';

export type KaminoActionPhase =
  | 'idle'
  | 'signing'
  | 'confirming'
  | 'success'
  | 'failed';

export type KaminoActionState = {
  phase: KaminoActionPhase;
  kind?: KaminoActionKind;
  hash?: `0x${string}`;
  error?: string;
};

const POLL_TIMEOUT_MS = 90_000;
const POLL_INTERVAL_MS = 2_000;

async function waitForReceipt(hash: `0x${string}`) {
  const start = Date.now();
  while (Date.now() - start < POLL_TIMEOUT_MS) {
    try {
      const res = await fetch('/api/rpc/rome', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          jsonrpc: '2.0',
          id: 1,
          method: 'eth_getTransactionReceipt',
          params: [hash],
        }),
      });
      const json = await res.json();
      if (json.result?.blockNumber) {
        return {
          status: json.result.status === '0x1' ? 'success' : 'reverted',
          transactionHash: json.result.transactionHash,
        };
      }
    } catch (e) {
      // eslint-disable-next-line no-console
      console.warn('[cardo kamino-action] receipt poll error', e);
    }
    await new Promise((r) => setTimeout(r, POLL_INTERVAL_MS));
  }
  throw new Error(`receipt poll timed out for ${hash}`);
}

/// Build the KaminoReserveAccounts struct from a registry KaminoReserve.
function reserveAccountsFromRegistry(
  market: KaminoMarket,
  res: KaminoReserve,
): KaminoReserveAccounts {
  return {
    lendingMarket: market.lendingMarket,
    reserve: res.reserve,
    reserveLiquidityMint: res.liquidityMint,
    reserveLiquiditySupply: res.liquiditySupply,
    reserveCollateralMint: res.collateralMint,
    reserveDestinationDepositCollateral: res.collateralSupply,
    feeReceiver: res.feeReceiver,
    // pythPriceOracle isn't needed for v2 deposit/withdraw/borrow/repay
    // (the on-chain handler reads it from the reserve via the
    // deposit_reserves_iter refresh path). Leave a zero pubkey; only
    // explicit refresh_reserve calls would need it.
    pythPriceOracle:
      '0x0000000000000000000000000000000000000000000000000000000000000000' as Hex,
  };
}

export function useKaminoAction() {
  const [state, setState] = useState<KaminoActionState>({ phase: 'idle' });
  const { writeContractAsync } = useRomeWrite();

  const execute = useCallback(
    async (opts: {
      kind: KaminoActionKind;
      userEvmAddress: Address;
      market: KaminoMarket;
      reserve: KaminoReserve;
      /// Action amount in reserve.decimals raw units (parseUnits before
      /// passing). For deposit/repay this is the liquidity amount; for
      /// withdraw it's the collateral amount; for borrow it's the
      /// liquidity amount to borrow.
      amount: bigint;
    }) => {
      setState({ phase: 'idle', kind: opts.kind, error: undefined });
      try {
        const owner = deriveRomeUserPda(opts.userEvmAddress);
        const obligation = deriveVanillaObligation(owner, opts.market.lendingMarket);
        const { userSourceLiquidity, userDestinationCollateral } =
          deriveUserReserveAtas(
            opts.userEvmAddress,
            opts.reserve.liquidityMint,
            opts.reserve.collateralMint,
          );

        // Pre-flight gating is the UI's responsibility (per playbook
        // §4b.8 + §4b.11). Caller MUST verify, before invoking this:
        //
        //   - userMetadata exists (useKaminoUserMetadataExists)
        //   - obligation exists (useKaminoObligationExists)
        //   - source-liquidity ATA exists (useAtaExists)
        //   - destination-collateral ATA exists (useAtaExists)
        //   - sufficient EVM balance for gas (per §1.4)
        //   - sufficient PDA SOL for any rent (per §1.7)
        //
        // The action hook is a pure single-tx execute. No silent
        // setup. No band-aids.
        const obligationAccounts: KaminoObligationAccounts = {
          owner,
          obligation,
          userSourceLiquidity,
          userDestinationCollateral,
        };
        const reserveAccounts = reserveAccountsFromRegistry(
          opts.market,
          opts.reserve,
        );

        // refresh_reserves iter: pass the reserve being acted on so
        // Kamino's handler refreshes it inline. Multi-reserve obligations
        // would also pass other touched reserves; out of MVP scope.
        const refreshReserves = [opts.reserve.reserve];

        let invoke;
        switch (opts.kind) {
          case 'deposit':
            invoke = buildDepositInvoke({
              reserve: reserveAccounts,
              obligation: obligationAccounts,
              liquidityAmount: opts.amount,
              refreshReserves,
            });
            break;
          case 'withdraw':
            invoke = buildWithdrawInvoke({
              reserve: reserveAccounts,
              obligation: obligationAccounts,
              collateralAmount: opts.amount,
              refreshReserves,
            });
            break;
          case 'borrow':
            invoke = buildBorrowInvoke({
              reserve: reserveAccounts,
              obligation: obligationAccounts,
              liquidityAmount: opts.amount,
              refreshReserves,
            });
            break;
          case 'repay':
            invoke = buildRepayInvoke({
              reserve: reserveAccounts,
              obligation: obligationAccounts,
              liquidityAmount: opts.amount,
              refreshReserves,
            });
            break;
        }

        setState({ phase: 'signing', kind: opts.kind });
        const hash = await writeContractAsync({
          address: CPI_PRECOMPILE,
          abi: CPI_INVOKE_ABI,
          functionName: 'invoke',
          args: [invoke.program, invoke.accounts, invoke.data],
        });
        setState({ phase: 'confirming', kind: opts.kind, hash });

        const r = await waitForReceipt(hash);
        if (r.status === 'reverted') {
          setState({
            phase: 'failed',
            kind: opts.kind,
            hash,
            error: `${opts.kind} reverted on-chain`,
          });
          return;
        }
        setState({ phase: 'success', kind: opts.kind, hash });
      } catch (e) {
        const msg = (e as Error).message ?? String(e);
        setState((prev) => ({ ...prev, phase: 'failed', error: msg }));
      }
    },
    [writeContractAsync],
  );

  const reset = useCallback(() => setState({ phase: 'idle' }), []);

  return { state, execute, reset };
}
