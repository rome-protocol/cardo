// POST /api/orchestrate/build-yield — Kamino USDC supply.
//
// Returns a list of steps. Each step is one Solana tx the user signs:
//
//   step 1 (only when needed): Kamino setup
//     init_user_metadata + init_obligation + init_obligation_farms_for_reserve
//     One-time per user, costs ~0.003 SOL in rent (recoverable on close).
//
//   step 2: Kamino deposit
//     refresh_reserve + refresh_obligation + deposit_v2 + Cardo fee
//
// Invariant honesty: if step 1 lands and step 2 fails, the user paid
// ~0.003 SOL in rent for nothing this session — but those accounts are
// reusable for any future Kamino deposit, so it's not lost forever.
// Surfaced in UI before user signs.
//
// Atomic-by-tx: each step is one Solana tx. Solana guarantees per-tx
// atomicity. The user pays the Cardo fee ONLY in step 2, ONLY if the
// deposit lands.

import { NextRequest, NextResponse } from 'next/server';
import {
  PublicKey,
  SystemProgram,
  Transaction,
  TransactionInstruction,
  TransactionMessage,
  VersionedTransaction,
} from '@solana/web3.js';
import {
  buildInitUserMetadataIx,
  buildInitObligationIx,
  buildInitObligationFarmsIx,
  buildRefreshReserveIx,
  buildRefreshObligationIx,
  buildKaminoV2DepositIx,
  deriveUserMetadata,
  deriveVanillaObligation,
  deriveObligationFarmUserState,
} from '@/lib/orchestration/kamino-v2-deposit';
import {
  CARDO_FEE_BPS,
  CARDO_TREASURY_PUBKEY,
  withRpcFailover,
} from '@/lib/orchestration/config';

export const runtime = 'nodejs';

// Kamino mainnet — USDC reserve in the Main market (verified on-chain).
const KAMINO_MAIN_MARKET = new PublicKey('7u3HeHxYDLhnCoErrtycNokbQYbWGzLs6JSDqGAv5PfF');
const KAMINO_USDC_RESERVE = new PublicKey('D6q6wuQSrifJKZYpR1M8R4YawnLDtDsMmWM1NbBmgJ59');
const KAMINO_USDC_LIQUIDITY_SUPPLY = new PublicKey('Bgq7trRgVMeq33yt235zM2onQ4bRDBsY5EWiTetF4qw6');
const KAMINO_USDC_COLLATERAL_MINT = new PublicKey('B8V6WVjPxW1UGwVDfxH2d2r8SyT4cqn7dQRK6XneVa7D');
const KAMINO_USDC_DESTINATION_COLLATERAL = new PublicKey('3DzjXRfxRm6iejfyyMynR4tScddaanrePJ1NJU2XnPPL');
const KAMINO_SCOPE_PRICES = new PublicKey('3t4JZcueEzTbVP6kLxXrL3VpWx45jDer4eqysweBchNH');
const USDC_MINT = new PublicKey('EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v');
const TOKEN_PROGRAM = new PublicKey('TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA');
const ATA_PROGRAM = new PublicKey('ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL');

const MEMO_PROGRAM = new PublicKey('MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr');
function memoIx(memo: string): TransactionInstruction {
  return new TransactionInstruction({
    keys: [],
    programId: MEMO_PROGRAM,
    data: Buffer.from(memo, 'utf8'),
  });
}

/// Read offset 64..96 from a Kamino reserve account to get its farm state.
async function fetchReserveFarmState(reserve: PublicKey): Promise<PublicKey> {
  const acct = await withRpcFailover((conn) => conn.getAccountInfo(reserve));
  if (!acct) throw new Error(`reserve ${reserve.toBase58()} not found`);
  return new PublicKey(acct.data.subarray(64, 96));
}

function getAssociatedTokenAddress(mint: PublicKey, owner: PublicKey): PublicKey {
  const [ata] = PublicKey.findProgramAddressSync(
    [owner.toBuffer(), TOKEN_PROGRAM.toBuffer(), mint.toBuffer()],
    ATA_PROGRAM,
  );
  return ata;
}

type BuildYieldBody = {
  intent: { kind: string; params: Record<string, unknown> };
  amountInUsdc?: number;
  userPubkey: string;
};

type Step = {
  label: string;
  description: string;
  kind: 'legacy' | 'v0';
  b64: string;
  costSolApprox: number; // human-readable lamport estimate
};

export async function POST(req: NextRequest) {
  let body: BuildYieldBody;
  try {
    body = (await req.json()) as BuildYieldBody;
  } catch {
    return NextResponse.json({ error: 'invalid json' }, { status: 400 });
  }

  if (body.intent?.kind !== 'yield') {
    return NextResponse.json(
      { error: `build-yield only handles yield intents; got "${body.intent?.kind}"` },
      { status: 400 },
    );
  }
  if (!body.userPubkey) {
    return NextResponse.json({ error: 'missing userPubkey' }, { status: 400 });
  }

  let user: PublicKey;
  try {
    user = new PublicKey(body.userPubkey);
  } catch {
    return NextResponse.json({ error: 'invalid userPubkey' }, { status: 400 });
  }

  const amountInUsdc =
    body.amountInUsdc ??
    (body.intent.params.amountInUsdc as number | undefined) ??
    0.1; // default 0.1 USDC if unspecified
  const amountInUsdcRaw = BigInt(Math.floor(amountInUsdc * 1e6));
  const treasury = new PublicKey(CARDO_TREASURY_PUBKEY);
  // Cardo fee is taken from the input USDC (transferred to treasury USDC ATA).
  // Treasury needs a USDC ATA — we use SOL fee instead for v0 simplicity
  // (consistent with swap/stake flows), at 30 bps of equivalent SOL value.
  // Approx: 1 USDC at ~$1, 1 SOL at ~$84 → fee_lamports ≈ amountInUsdc / 84 * 30bps * 1e9
  // For the deposit case, we'll just take fee in SOL from the user's wallet.
  // 30bps of $X notional / $84/SOL = lamports
  const SOL_PRICE_USD = 84;
  const feeLamports = BigInt(
    Math.floor((amountInUsdc * (CARDO_FEE_BPS / 10_000) / SOL_PRICE_USD) * 1e9),
  );

  // Detect Kamino setup state for this user.
  const userMetadataPda = deriveUserMetadata(user);
  const obligationPda = deriveVanillaObligation(user, KAMINO_MAIN_MARKET);

  let reserveFarmState: PublicKey;
  try {
    reserveFarmState = await fetchReserveFarmState(KAMINO_USDC_RESERVE);
  } catch (e) {
    return NextResponse.json(
      { error: `failed to fetch Kamino USDC reserve: ${(e as Error).message}` },
      { status: 502 },
    );
  }
  const obligationFarmPda = deriveObligationFarmUserState(reserveFarmState, obligationPda);

  // Parallel existence checks
  const [userMetaInfo, obligationInfo, farmInfo, usdcAtaInfo] = await Promise.all([
    withRpcFailover((conn) => conn.getAccountInfo(userMetadataPda)),
    withRpcFailover((conn) => conn.getAccountInfo(obligationPda)),
    withRpcFailover((conn) => conn.getAccountInfo(obligationFarmPda)),
    withRpcFailover((conn) => conn.getAccountInfo(getAssociatedTokenAddress(USDC_MINT, user))),
  ]);

  const needsUserMeta = !userMetaInfo;
  const needsObligation = !obligationInfo;
  const needsFarms = !farmInfo;
  const needsSetup = needsUserMeta || needsObligation || needsFarms;

  if (!usdcAtaInfo) {
    return NextResponse.json(
      {
        error:
          'No USDC token account found in your wallet. Acquire some USDC first (via swap, transfer in, etc.) — Kamino deposit requires existing USDC to supply.',
      },
      { status: 422 },
    );
  }

  const { blockhash } = await withRpcFailover((conn) =>
    conn.getLatestBlockhash('confirmed'),
  );

  const steps: Step[] = [];

  // STEP 1: Setup tx (only if needed). One-time, ~0.003 SOL rent.
  if (needsSetup) {
    const setupTx = new Transaction({ recentBlockhash: blockhash, feePayer: user });
    if (needsUserMeta) {
      setupTx.add(buildInitUserMetadataIx({ owner: user, feePayer: user }));
    }
    if (needsObligation) {
      setupTx.add(
        buildInitObligationIx({
          owner: user,
          feePayer: user,
          market: KAMINO_MAIN_MARKET,
        }),
      );
    }
    if (needsFarms) {
      setupTx.add(
        buildInitObligationFarmsIx({
          owner: user,
          feePayer: user,
          obligation: obligationPda,
          reserve: KAMINO_USDC_RESERVE,
          reserveFarmState,
          market: KAMINO_MAIN_MARKET,
          mode: 0,
        }),
      );
    }
    setupTx.add(memoIx(`cardo:yield-setup`));

    steps.push({
      label: 'Step 1 of 2 · Kamino setup',
      description: `One-time. Initializes ${
        [
          needsUserMeta && 'user metadata',
          needsObligation && 'obligation',
          needsFarms && 'farms link',
        ]
          .filter(Boolean)
          .join(' + ')
      }. ~0.003 SOL rent (recoverable on close).`,
      kind: 'legacy',
      b64: setupTx.serialize({ requireAllSignatures: false }).toString('base64'),
      costSolApprox: 0.003,
    });
  }

  // STEP 2: Deposit tx
  const userUsdcAta = getAssociatedTokenAddress(USDC_MINT, user);
  const refreshIx = buildRefreshReserveIx({
    reserve: KAMINO_USDC_RESERVE,
    market: KAMINO_MAIN_MARKET,
    scopePrices: KAMINO_SCOPE_PRICES,
  });
  const refreshObligIx = buildRefreshObligationIx({
    market: KAMINO_MAIN_MARKET,
    obligation: obligationPda,
    // Existing obligations track which reserves the user holds. Kamino's
    // refresh_obligation iterates those remaining accounts to refresh
    // each reserve linked to the obligation. For first-time deposits
    // the obligation only references the USDC reserve, so we pass it.
    // For subsequent deposits (or migrations across reserves) we'd need
    // to read the obligation's reserves[] array on chain — left as a
    // follow-up; v0 single-reserve flow works.
    reserves: [KAMINO_USDC_RESERVE],
  });
  const depositIx = buildKaminoV2DepositIx({
    owner: user,
    market: KAMINO_MAIN_MARKET,
    reserve: KAMINO_USDC_RESERVE,
    reserveLiquidityMint: USDC_MINT,
    reserveLiquiditySupply: KAMINO_USDC_LIQUIDITY_SUPPLY,
    reserveCollateralMint: KAMINO_USDC_COLLATERAL_MINT,
    reserveDestinationCollateral: KAMINO_USDC_DESTINATION_COLLATERAL,
    userSourceLiquidity: userUsdcAta,
    reserveFarmState,
    amountIn: amountInUsdcRaw,
  });

  // Use v0 tx for the deposit so we have headroom (Kamino's ix is large).
  const depositIxs: TransactionInstruction[] = [
    refreshIx,
    refreshObligIx,
    depositIx,
  ];
  if (feeLamports > 0n) {
    depositIxs.push(
      SystemProgram.transfer({
        fromPubkey: user,
        toPubkey: treasury,
        lamports: Number(feeLamports),
      }),
    );
  }
  depositIxs.push(memoIx(`cardo:yield-deposit ${amountInUsdc}usdc`));

  const depositMsg = new TransactionMessage({
    payerKey: user,
    recentBlockhash: blockhash,
    instructions: depositIxs,
  }).compileToV0Message();
  const depositTx = new VersionedTransaction(depositMsg);
  const depositB64 = Buffer.from(depositTx.serialize()).toString('base64');

  steps.push({
    label: needsSetup ? 'Step 2 of 2 · Deposit USDC' : 'Deposit USDC',
    description: `Supply ${amountInUsdc} USDC to Kamino Main USDC reserve at ~5.2% APY. Cardo fee = ${feeLamports} lamports (30 bps of notional). Atomic — fee transfers only if deposit lands.`,
    kind: 'v0',
    b64: depositB64,
    costSolApprox: Number(feeLamports) / 1e9 + 0.00001,
  });

  return NextResponse.json({
    steps,
    blockhash,
    setupRequired: needsSetup,
    fee: {
      bps: CARDO_FEE_BPS,
      lamports: feeLamports.toString(),
      treasury: CARDO_TREASURY_PUBKEY,
    },
  });
}
