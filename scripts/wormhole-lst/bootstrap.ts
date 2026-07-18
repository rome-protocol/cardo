// Bootstrap driver for Wormhole-wrapped LST assets (mSOL / JitoSOL) on a
// Rome devnet chain: prepare the treasury's Rome-PDA ATAs, wrap gas USDC
// into SPL USDC, init Meteora dynamic vaults, create + seed the USDC↔LST
// DAMM v1 pools, and deploy ERC20SPL wrappers — all through the same
// precompile rails Cardo's UI uses, signed by the e2e treasury EOA.
//
// The Solana-side Wormhole legs (attestToken / createWrapped /
// completeTransferWrapped) are separate one-time operations; see the PR
// description for the full runbook. This script covers every Rome-side
// stage and the Solana-side account prep.
//
// Run (from the cardo repo root):
//   node --import tsx scripts/wormhole-lst/bootstrap.ts status
//   node --import tsx scripts/wormhole-lst/bootstrap.ts ensure-atas
//   node --import tsx scripts/wormhole-lst/bootstrap.ts wrap-usdc 60
//   node --import tsx scripts/wormhole-lst/bootstrap.ts init-vault <mintB58>
//   node --import tsx scripts/wormhole-lst/bootstrap.ts create-pool <mintB58> <usdcUi> <lstUi> [feeBps]
//   node --import tsx scripts/wormhole-lst/bootstrap.ts deploy-wrapper <mintB58> <name> <symbol>
//
// Env:
//   E2E_TREASURY_PRIVATE_KEY_FILE  (default <your-treasury-key-path>)
//   TREASURY_SOLANA_KEYPAIR        (default <your-secrets-dir>/e2e/treasury-solana.json)
//   ROME_RPC_URL                   (default https://hadrian.testnet.romeprotocol.xyz)
//   SOLANA_RPC                     (default internal devnet node1)

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  Connection,
  Keypair,
  PublicKey,
  SystemProgram,
  Transaction,
} from '@solana/web3.js';
import {
  createAssociatedTokenAccountIdempotentInstruction,
  getAssociatedTokenAddressSync,
} from '@solana/spl-token';
import { encodeFunctionData, parseAbi, type Address, type Hex } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';

import { CPI_INVOKE_ABI, CPI_PRECOMPILE } from '../../lib/cpi-precompile.ts';
import { buildMarinadeDepositInvoke } from '../../lib/marinade-instructions.ts';
import { fetchMarinadeState } from '../../lib/marinade-state.ts';
import { MARINADE_STATE_BS58 } from '../../lib/marinade-program.ts';
import {
  buildChainMeteoraPoolInitInvoke,
  deriveMeteoraVault,
  pubkeyBs58ToBytes32,
  type VaultStateOverrides,
} from '../../lib/meteora-pool-create.ts';
import { buildChainMeteoraVaultInitInvoke } from '../../lib/meteora-vault-init.ts';
import { buildChainMeteoraSwapInvoke, type SwapDirection } from '../../lib/meteora-swap.ts';
import {
  ROME_METEORA_POOL_USDC_MSOL,
  ROME_METEORA_POOL_USDC_WJITOSOL,
} from '../../lib/meteora-pool.ts';
import {
  WITHDRAW_PRECOMPILE_ADDR,
  WRAP_UNWRAP_ABI,
} from '../../lib/wrap-unwrap-fabric.ts';
import { ROME_ADDRESSES } from '../../lib/addresses.ts';
import { bytes32ToPublicKey, deriveRomeUserPda } from '../../lib/solana-pda.ts';

const ROME_RPC = process.env.ROME_RPC_URL ?? 'https://hadrian.testnet.romeprotocol.xyz';
const SOL_RPC = process.env.SOLANA_RPC ?? 'https://api.devnet.solana.com';
const USDC_MINT = '4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU';

function treasuryEvmKey(): Hex {
  const p = process.env.E2E_TREASURY_PRIVATE_KEY_FILE
    ?? path.join(os.homedir(), 'rome/.secrets/e2e/treasury-evm.key');
  const raw = fs.readFileSync(p, 'utf8').trim();
  return (raw.startsWith('0x') ? raw : `0x${raw}`) as Hex;
}

function treasurySolanaKeypair(): Keypair {
  const p = process.env.TREASURY_SOLANA_KEYPAIR
    ?? path.join(os.homedir(), 'rome/.secrets/e2e/treasury-solana.json');
  return Keypair.fromSecretKey(Buffer.from(JSON.parse(fs.readFileSync(p, 'utf8'))));
}

async function romeRpc<T = unknown>(method: string, params: unknown[]): Promise<T> {
  const res = await fetch(ROME_RPC, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
  });
  const j = (await res.json()) as { result?: unknown; error?: unknown };
  if (j.error) throw new Error(`${method}: ${JSON.stringify(j.error)}`);
  return j.result as T;
}

/// Sign + submit a Rome EVM tx (legacy type-0, fee from eth_gasPrice —
/// the submitRomeTx shape) and poll the receipt to `status: 0x1`.
async function sendRomeTx(to: Address, data: Hex): Promise<{ hash: string; logs: unknown[] }> {
  const account = privateKeyToAccount(treasuryEvmKey());
  const [nonceHex, gasPriceHex, chainIdHex] = await Promise.all([
    romeRpc('eth_getTransactionCount', [account.address, 'pending']),
    romeRpc('eth_gasPrice', []),
    romeRpc('eth_chainId', []),
  ]);
  const signed = await account.signTransaction({
    chainId: Number(chainIdHex),
    type: 'legacy',
    nonce: Number.parseInt(nonceHex as string, 16),
    gasPrice: BigInt(gasPriceHex as string),
    gas: 250_000_000n,
    to,
    value: 0n,
    data,
  });
  const hash = await romeRpc<string>('eth_sendRawTransaction', [signed]);
  process.stdout.write(`  tx ${hash} `);
  for (let i = 0; i < 90; i++) {
    const rec = await romeRpc<{ status?: string; logs?: unknown[] } | null>('eth_getTransactionReceipt', [hash]).catch(() => null);
    if (rec) {
      if (rec.status === '0x1') {
        console.log('✓');
        return { hash, logs: rec.logs ?? [] };
      }
      throw new Error(`tx ${hash} reverted (status=${rec.status})`);
    }
    process.stdout.write('.');
    await new Promise((r) => setTimeout(r, 2000));
  }
  throw new Error(`tx ${hash} not mined after 180s`);
}

async function solGetAccount(pubkey: string): Promise<boolean> {
  const res = await fetch(SOL_RPC, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      jsonrpc: '2.0', id: 1, method: 'getAccountInfo', params: [pubkey, { encoding: 'base64' }],
    }),
  });
  const j = await res.json();
  return !!j?.result?.value;
}

/// Read (token_vault, lp_mint) from a live Meteora vault account —
/// legacy vaults (e.g. devnet WSOL, mSOL) store non-PDA lp_mints, so
/// pool init must use the on-chain values (same trick as
/// use-meteora-vault-states.ts; offsets: token_vault @19, lp_mint @115).
async function vaultOverrideFor(mintB58: string): Promise<VaultStateOverrides[string] | null> {
  const vault = deriveMeteoraVault(new PublicKey(mintB58));
  const res = await fetch(SOL_RPC, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      jsonrpc: '2.0', id: 1, method: 'getAccountInfo',
      params: [vault.toBase58(), { encoding: 'base64' }],
    }),
  });
  const j = await res.json();
  if (!j?.result?.value) return null;
  const data = Buffer.from(j.result.value.data[0], 'base64');
  const tokenVault = new PublicKey(data.subarray(19, 51));
  const lpMint = new PublicKey(data.subarray(115, 147));
  return {
    tokenVault: `0x${tokenVault.toBuffer().toString('hex')}` as Hex,
    lpMint: `0x${lpMint.toBuffer().toString('hex')}` as Hex,
  };
}

async function solMintDecimals(mint: string): Promise<number> {
  const res = await fetch(SOL_RPC, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'getTokenSupply', params: [mint] }),
  });
  const j = await res.json();
  const d = j?.result?.value?.decimals;
  if (typeof d !== 'number') throw new Error(`cannot read decimals of mint ${mint}`);
  return d;
}

async function solTokenBalance(ata: string): Promise<string> {
  const res = await fetch(SOL_RPC, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      jsonrpc: '2.0', id: 1, method: 'getTokenAccountBalance', params: [ata],
    }),
  });
  const j = await res.json();
  return j?.result?.value?.uiAmountString ?? '<none>';
}

function treasuryPda(): { evm: Address; pdaHex: Hex; pda: PublicKey } {
  const evm = privateKeyToAccount(treasuryEvmKey()).address;
  const pdaHex = deriveRomeUserPda(evm);
  return { evm, pdaHex, pda: bytes32ToPublicKey(pdaHex) };
}

async function sendSolanaTx(conn: Connection, payer: Keypair, tx: Transaction): Promise<string> {
  const { blockhash } = await conn.getLatestBlockhash('confirmed');
  tx.recentBlockhash = blockhash;
  tx.feePayer = payer.publicKey;
  tx.sign(payer);
  const sig = await conn.sendRawTransaction(tx.serialize());
  for (let i = 0; i < 60; i++) {
    const st = await conn.getSignatureStatuses([sig]);
    const s = st.value[0];
    if (s?.err) throw new Error(`solana tx ${sig} failed: ${JSON.stringify(s.err)}`);
    if (s && (s.confirmationStatus === 'confirmed' || s.confirmationStatus === 'finalized')) return sig;
    await new Promise((r) => setTimeout(r, 2000));
  }
  throw new Error(`solana tx ${sig} unconfirmed after 120s`);
}

const [cmd, ...args] = process.argv.slice(2);

async function main() {
  const { evm, pda } = treasuryPda();
  console.log(`treasury EVM ${evm}`);
  console.log(`treasury Rome PDA ${pda.toBase58()}`);

  switch (cmd) {
    case 'status': {
      const mints = [USDC_MINT, ...args];
      for (const m of mints) {
        const ata = getAssociatedTokenAddressSync(new PublicKey(m), pda, true);
        console.log(`  mint ${m}\n    ATA ${ata.toBase58()} balance=${await solTokenBalance(ata.toBase58())}`);
      }
      break;
    }

    case 'ensure-atas': {
      // Create the PDA-owned ATAs (idempotent) + top the PDA up with
      // lamports so it can pay Anchor `init` rent inside CPI flows.
      const payer = treasurySolanaKeypair();
      const conn = new Connection(SOL_RPC, 'confirmed');
      const tx = new Transaction();
      for (const m of [USDC_MINT, ...args]) {
        const mint = new PublicKey(m);
        const ata = getAssociatedTokenAddressSync(mint, pda, true);
        tx.add(createAssociatedTokenAccountIdempotentInstruction(payer.publicKey, ata, pda, mint));
        console.log(`  ensure ATA ${ata.toBase58()} (mint ${m})`);
      }
      const pdaBal = await conn.getBalance(pda);
      const target = 200_000_000; // 0.2 SOL covers pool-init rent comfortably
      if (pdaBal < target) {
        tx.add(SystemProgram.transfer({
          fromPubkey: payer.publicKey, toPubkey: pda, lamports: target - pdaBal,
        }));
        console.log(`  fund PDA ${((target - pdaBal) / 1e9).toFixed(3)} SOL (had ${(pdaBal / 1e9).toFixed(3)})`);
      }
      console.log(`  sig ${await sendSolanaTx(conn, payer, tx)}`);
      break;
    }

    case 'stake-marinade': {
      // Acquire real devnet mSOL the same way a Cardo user does: fund the
      // PDA with lamports, then Marinade `deposit` via the CPI precompile.
      const solUi = Number(args[0]);
      if (!Number.isFinite(solUi) || solUi <= 0) throw new Error('usage: stake-marinade <solAmount>');
      const lamports = BigInt(Math.round(solUi * 1e9));
      const state = await fetchMarinadeState(SOL_RPC, MARINADE_STATE_BS58);
      const msolMintB58 = bytes32ToPublicKey(state.msolMint).toBase58();
      console.log(`marinade state ok — msol mint ${msolMintB58}`);

      const payer = treasurySolanaKeypair();
      const conn = new Connection(SOL_RPC, 'confirmed');
      const prep = new Transaction();
      const msolAta = getAssociatedTokenAddressSync(new PublicKey(msolMintB58), pda, true);
      prep.add(createAssociatedTokenAccountIdempotentInstruction(payer.publicKey, msolAta, pda, new PublicKey(msolMintB58)));
      const pdaBal = BigInt(await conn.getBalance(pda));
      const need = lamports + 50_000_000n; // deposit + rent buffer
      if (pdaBal < need) {
        prep.add(SystemProgram.transfer({ fromPubkey: payer.publicKey, toPubkey: pda, lamports: Number(need - pdaBal) }));
        console.log(`  topping PDA up ${(Number(need - pdaBal) / 1e9).toFixed(3)} SOL`);
      }
      console.log(`  prep sig ${await sendSolanaTx(conn, payer, prep)}`);

      const invoke = buildMarinadeDepositInvoke({
        userEvmAddress: evm,
        msolMint: state.msolMint,
        msolLeg: state.msolLeg,
        lamports,
      });
      const data = encodeFunctionData({
        abi: CPI_INVOKE_ABI, functionName: 'invoke',
        args: [invoke.program, invoke.accounts, invoke.data],
      });
      console.log(`deposit ${solUi} SOL into Marinade`);
      await sendRomeTx(CPI_PRECOMPILE, data);
      console.log(`  mSOL ATA ${msolAta.toBase58()} balance = ${await solTokenBalance(msolAta.toBase58())}`);
      break;
    }

    case 'wrap-usdc': {
      const ui = Number(args[0]);
      if (!Number.isFinite(ui) || ui <= 0) throw new Error('usage: wrap-usdc <uiAmount>');
      const wei = BigInt(Math.round(ui * 1e6)) * 10n ** 12n; // 18dp gas → 6dp SPL
      const data = encodeFunctionData({
        abi: WRAP_UNWRAP_ABI, functionName: 'withdraw_to_ata', args: [wei],
      });
      console.log(`wrap ${ui} gas USDC → SPL USDC`);
      await sendRomeTx(WITHDRAW_PRECOMPILE_ADDR, data);
      const ata = getAssociatedTokenAddressSync(new PublicKey(USDC_MINT), pda, true);
      console.log(`  USDC ATA balance now ${await solTokenBalance(ata.toBase58())}`);
      break;
    }

    case 'init-vault': {
      const mintB58 = args[0];
      if (!mintB58) throw new Error('usage: init-vault <mintB58>');
      const invoke = buildChainMeteoraVaultInitInvoke({
        userEvmAddress: evm,
        mintHex: pubkeyBs58ToBytes32(mintB58),
      });
      if (await solGetAccount(invoke.addresses.vault.toBase58())) {
        console.log(`vault ${invoke.addresses.vault.toBase58()} already exists — skipping`);
        break;
      }
      console.log(`init vault ${invoke.addresses.vault.toBase58()} for mint ${mintB58}`);
      const data = encodeFunctionData({
        abi: CPI_INVOKE_ABI, functionName: 'invoke',
        args: [invoke.program, invoke.accounts, invoke.data],
      });
      await sendRomeTx(CPI_PRECOMPILE, data);
      break;
    }

    case 'create-pool': {
      const [mintB58, usdcUiStr, lstUiStr, feeBpsStr] = args;
      const usdcUi = Number(usdcUiStr);
      const lstUi = Number(lstUiStr);
      if (!mintB58 || !Number.isFinite(usdcUi) || !Number.isFinite(lstUi)) {
        throw new Error('usage: create-pool <mintB58> <usdcUi> <lstUi> [feeBps]');
      }
      const feeBps = BigInt(feeBpsStr ?? '25');
      const lstDecimals = await solMintDecimals(mintB58);
      const vaultOverrides: VaultStateOverrides = {};
      for (const m of [USDC_MINT, mintB58]) {
        const over = await vaultOverrideFor(m);
        if (over) {
          vaultOverrides[pubkeyBs58ToBytes32(m).toLowerCase()] = over;
          console.log(`  vault override ${m}: tokenVault+lpMint read from chain`);
        }
      }
      const invoke = buildChainMeteoraPoolInitInvoke({
        userEvmAddress: evm,
        mintAHex: pubkeyBs58ToBytes32(USDC_MINT),
        mintBHex: pubkeyBs58ToBytes32(mintB58),
        tradeFeeBps: feeBps,
        tokenAAmount: BigInt(Math.round(usdcUi * 1e6)), // USDC 6dp
        tokenBAmount: BigInt(Math.round(lstUi * 10 ** lstDecimals)),
        vaultOverrides,
      });
      console.log(`create pool ${invoke.addresses.pool.toBase58()} (A=USDC ${usdcUi}, B=${mintB58} ${lstUi}, fee ${feeBps}bps)`);
      if (await solGetAccount(invoke.addresses.pool.toBase58())) {
        console.log('pool already exists — skipping');
        break;
      }
      const data = encodeFunctionData({
        abi: CPI_INVOKE_ABI, functionName: 'invoke',
        args: [invoke.program, invoke.accounts, invoke.data],
      });
      await sendRomeTx(CPI_PRECOMPILE, data);
      console.log(`pool ${invoke.addresses.pool.toBase58()} created`);
      break;
    }

    case 'swap': {
      // Live swap on a seeded LST pool via the exact builder /swap uses.
      //   swap msol|jitosol AToB|BToA <amountUi>
      // AToB = USDC in → LST out; amount in UI units of the input token.
      const [poolKey, dirRaw, amountUiStr] = args;
      const pools = {
        msol: { pool: ROME_METEORA_POOL_USDC_MSOL, lstDecimals: 9 },
        jitosol: { pool: ROME_METEORA_POOL_USDC_WJITOSOL, lstDecimals: 8 },
      } as const;
      const sel = pools[poolKey as keyof typeof pools];
      const direction = dirRaw as SwapDirection;
      const amountUi = Number(amountUiStr);
      if (!sel || !['AToB', 'BToA'].includes(direction) || !Number.isFinite(amountUi)) {
        throw new Error('usage: swap msol|jitosol AToB|BToA <amountUi>');
      }
      const inDecimals = direction === 'AToB' ? 6 : sel.lstDecimals;
      const invoke = buildChainMeteoraSwapInvoke({
        userEvmAddress: evm,
        direction,
        amountIn: BigInt(Math.round(amountUi * 10 ** inDecimals)),
        minimumOut: 1n,
        pool: sel.pool,
      });
      const outMintHex = direction === 'AToB' ? sel.pool.splMintB : sel.pool.splMintA;
      const outAta = getAssociatedTokenAddressSync(bytes32ToPublicKey(outMintHex), pda, true);
      const before = await solTokenBalance(outAta.toBase58());
      console.log(`swap ${poolKey} ${direction} ${amountUi} (out ATA ${outAta.toBase58()} before=${before})`);
      const data = encodeFunctionData({
        abi: CPI_INVOKE_ABI, functionName: 'invoke',
        args: [invoke.program, invoke.accounts, invoke.data],
      });
      await sendRomeTx(CPI_PRECOMPILE, data);
      console.log(`  out ATA after = ${await solTokenBalance(outAta.toBase58())}`);
      break;
    }

    case 'deploy-wrapper': {
      const [mintB58, name, symbol] = args;
      if (!mintB58 || !name || !symbol) throw new Error('usage: deploy-wrapper <mintB58> <name> <symbol>');
      const factory = ROME_ADDRESSES.erc20SplFactoryCanonical as Address;
      const factoryAbi = parseAbi([
        'function add_spl_token_no_metadata(bytes32 mint, string name, string symbol) returns (address)',
        'function token_by_mint(bytes32) view returns (address)',
      ]);
      const mintHex = pubkeyBs58ToBytes32(mintB58);
      const existing = await romeRpc<string>('eth_call', [{
        to: factory,
        data: encodeFunctionData({ abi: factoryAbi, functionName: 'token_by_mint', args: [mintHex] }),
      }, 'latest']);
      if (existing && existing !== '0x' && BigInt(existing) !== 0n) {
        console.log(`wrapper already exists: 0x${existing.slice(-40)}`);
        break;
      }
      console.log(`deploy wrapper for ${mintB58} (${name} / ${symbol}) via factory ${factory}`);
      await sendRomeTx(factory, encodeFunctionData({
        abi: factoryAbi, functionName: 'add_spl_token_no_metadata', args: [mintHex, name, symbol],
      }));
      const after = await romeRpc<string>('eth_call', [{
        to: factory,
        data: encodeFunctionData({ abi: factoryAbi, functionName: 'token_by_mint', args: [mintHex] }),
      }, 'latest']);
      console.log(`wrapper: 0x${after.slice(-40)}`);
      break;
    }

    default:
      console.error('usage: bootstrap.ts status|ensure-atas|wrap-usdc|init-vault|create-pool|deploy-wrapper …');
      process.exit(1);
  }
}

main().catch((e) => { console.error(e); process.exit(1); });
