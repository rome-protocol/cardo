// probe-kamino-deposit.mjs — emulate a Kamino deposit via Rome to see
// the actual revert reason. Three things at play here:
//
//   (a) Anchor 3012 / AccountNotInitialized — the canonical "you
//       didn't init the collateral ATA" or "obligation missing" path.
//       Already fixed in cardo via the pre-flight rows.
//
//   (b) Kamino's check_refresh_ixs! macro — the deposit handler
//       inspects Sysvar1nstructions for refresh_reserve +
//       refresh_obligation in the SAME tx, BEFORE the deposit. We
//       weren't sending those. Two-side fixable: pre-pend a
//       refresh_reserve(s) + refresh_obligation in the same Rome CPI
//       tx via Composed call types.
//
//   (c) Kamino's is_forbidden_cpi_call() under #[cfg(not(feature =
//       "staging"))] — the deposit handler rejects any tx whose
//       outermost Solana ix is not from Kamino itself, unless the
//       caller is on the CPI_WHITELISTED_ACCOUNTS list. Rome EVM
//       (DP1dshB…) is NOT on that list. **Hard architectural blocker
//       for the direct-precompile path.** Workarounds: (i) get Rome
//       whitelisted by Kamino; (ii) Rome's cross-chain-atomic tx
//       (RomulusTx) which submits a top-level Solana tx alongside the
//       EVM tx (out of scope today); (iii) read-only Cardo + link out
//       to app.kamino.finance for write actions.
//
// This script's job: send a synthetic deposit through rome_emulateTx
// and read the program logs back. If the logs say
// "Instruction was called via CPI!" we know we're in case (c) and
// no amount of refresh-chain wiring will fix it on a non-staging
// program. If the logs say something else, we have a path to fix.

import { ethers } from 'ethers';
import fs from 'node:fs';
import os from 'node:os';
import crypto from 'node:crypto';
import solw3 from '@solana/web3.js';

const { PublicKey } = solw3;

const RPC = 'https://rome.devnet.romeprotocol.xyz/';
const CHAIN_ID = 999999n;
const GAS_PRICE = 11_000_000_000n;
const CPI = '0xFF00000000000000000000000000000000000008';

const KLEND_PROGRAM_HEX =
  '0x04b2acb11258cce3682c418ba872ff3df91102712f15af12b6be69b3435b0008';

const DEPOSIT_DISC = Buffer.from('81c70402de271a2e', 'hex');

// Rome Kamino Main, USDC reserve (per cardo lib/kamino-markets.ts)
const POOL = {
  market:                'HqCoqWT42Qdg1fbsWFo6TNCkH6eSY2MtxHFEkPoBvCHm',
  reserve:               'DHP5csgS8ba2dFAqgM5dqNXoUw3x9EWaPwYXVACQ4Wxn',
  liquidityMint:         '4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU',
  liquiditySupply:       '7U7oFUGSNdYMmyKEUrw28P52Ld4Uw6Mr1s335fK3X6Rz',
  collateralMint:        'EK8T1MrJ5DVmjcJ7hg7pqejTP3fPSVYxKq9ykHLvkSQ4',
  collateralSupply:      'BRJRC1Uo6DfRgu4UdFMTzdVTXt2n3zG71aNRSVWLfqMo',
};

const KLEND = new PublicKey('KLend2g3cP87fffoy8q1mQqGKjrxjC8boSyAYavgmjD');
const ROME_EVM_PROGRAM = new PublicKey('DP1dshBzmXXVsRxH5kCKMemrDuptg1JvJ1j5AsFV4Hm3');
const SPL_TOKEN_PROGRAM = new PublicKey('TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA');
const ATA_PROGRAM = new PublicKey('ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL');
const SYSVAR_INSTRUCTIONS = new PublicKey('Sysvar1nstructions1111111111111111111111111');

function pubkeyHex(pk) { return '0x' + pk.toBuffer().toString('hex'); }
function pubkeyBs58Hex(bs58) { return pubkeyHex(new PublicKey(bs58)); }

function deriveRomeUserPda(evmAddr) {
  const userBytes = Buffer.from(evmAddr.slice(2), 'hex');
  const [pda] = PublicKey.findProgramAddressSync(
    [Buffer.from('EXTERNAL_AUTHORITY'), userBytes],
    ROME_EVM_PROGRAM,
  );
  return pda;
}
function deriveAta(owner, mintBs58) {
  const [ata] = PublicKey.findProgramAddressSync(
    [owner.toBuffer(), SPL_TOKEN_PROGRAM.toBuffer(), new PublicKey(mintBs58).toBuffer()],
    ATA_PROGRAM,
  );
  return ata;
}
function deriveLma(marketBs58) {
  const [pda] = PublicKey.findProgramAddressSync(
    [Buffer.from('lma'), new PublicKey(marketBs58).toBuffer()],
    KLEND,
  );
  return pda;
}
function deriveObligation(owner, marketBs58) {
  const zero = Buffer.alloc(32);
  const [pda] = PublicKey.findProgramAddressSync(
    [Buffer.from([0]), Buffer.from([0]), owner.toBuffer(), new PublicKey(marketBs58).toBuffer(), zero, zero],
    KLEND,
  );
  return pda;
}

function toU64Le(v) {
  const b = Buffer.alloc(8);
  b.writeBigUInt64LE(BigInt(v));
  return b;
}

async function rpc(method, params) {
  const res = await fetch(RPC, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
  });
  return await res.json();
}

async function main() {
  const pk = '0x' + fs
    .readFileSync(os.homedir() + '/.rome-rome-deployer.key', 'utf8')
    .trim()
    .replace(/^0x/, '');
  const provider = new ethers.JsonRpcProvider(RPC);
  const wallet = new ethers.Wallet(pk, provider);
  console.log('Signer:', wallet.address);

  const userPda = deriveRomeUserPda(wallet.address);
  console.log('User Rome PDA:', userPda.toBase58());

  // The deployer hasn't gone through Cardo's setup, so they likely
  // don't have an obligation. We're not testing real success — we're
  // testing what error comes back from a CPI deposit attempt.
  const obligation = deriveObligation(userPda, POOL.market);
  console.log('Obligation (would-be):', obligation.toBase58());
  const lma = deriveLma(POOL.market);
  const userSourceLiquidity = deriveAta(userPda, POOL.liquidityMint);
  const userDestinationCollateral = deriveAta(userPda, POOL.collateralMint);

  // Account list per IDL — same as cardo's buildDepositInvoke
  const accounts = [
    [pubkeyHex(userPda), true, false],
    [pubkeyHex(obligation), false, true],
    [pubkeyBs58Hex(POOL.market), false, false],
    [pubkeyHex(lma), false, false],
    [pubkeyBs58Hex(POOL.reserve), false, true],
    [pubkeyBs58Hex(POOL.liquidityMint), false, false],
    [pubkeyBs58Hex(POOL.liquiditySupply), false, true],
    [pubkeyBs58Hex(POOL.collateralMint), false, true],
    [pubkeyBs58Hex(POOL.collateralSupply), false, true],
    [pubkeyHex(userSourceLiquidity), false, true],
    [pubkeyHex(userDestinationCollateral), false, true],
    [pubkeyHex(SPL_TOKEN_PROGRAM), false, false],
    [pubkeyHex(SYSVAR_INSTRUCTIONS), false, false],
  ];

  const ixData = '0x' + Buffer.concat([DEPOSIT_DISC, toU64Le(1000000n)]).toString('hex'); // 1 USDC
  console.log('ix data:', ixData);

  const iface = new ethers.Interface([
    'function invoke(bytes32 program, (bytes32,bool,bool)[] accounts, bytes data)',
  ]);
  const calldata = iface.encodeFunctionData('invoke', [KLEND_PROGRAM_HEX, accounts, ixData]);

  const nonce = await provider.getTransactionCount(wallet.address, 'pending');
  const tx = {
    type: 0, chainId: CHAIN_ID, nonce, gasPrice: GAS_PRICE, gasLimit: 50_000_000n,
    to: CPI, value: 0n, data: calldata,
  };
  const signed = await wallet.signTransaction(tx);

  console.log('\n--- rome_emulateTx ---');
  const emu = await rpc('rome_emulateTx', [signed]);
  if (emu.error) {
    console.log('  emu.error:', JSON.stringify(emu.error, null, 2));
  } else {
    // The emulator returns a structure with logs from the SBF execution.
    console.log(JSON.stringify(emu, null, 2).slice(0, 4000));
  }
}
main().catch(e => { console.error(e); process.exit(1); });
