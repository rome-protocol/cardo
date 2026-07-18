// Re-probe smoke user state with corrected understanding:
//   - native gas token on Rome = USDC (NOT mETH; the "mETH" label is just
//     viem's default for the native unit)
//   - the ERC20 wrapper at 0x6ed2 is wUSDC on chain (codebase calls it
//     "rUSDC" — stale naming). Wrapper exposes symbol()/name() via ERC20.
//   - bridge depositing native USDC delivers gas balance only;
//     external-authority PDA on Solana devnet is NOT auto-allocated
//     (project_native_deposit_pda_gap.md).

import { createPublicClient, defineChain, http } from 'viem';
import { Connection, PublicKey } from '@solana/web3.js';

const rome = defineChain({
  id: 999999,
  name: 'Rome chain',
  nativeCurrency: { name: 'USDC', symbol: 'USDC', decimals: 18 },
  rpcUrls: { default: { http: ['https://rome.devnet.romeprotocol.xyz/'] } },
});

const USER = '0x2A26DA21e06e0b521d98E9879192E9F3a40C9a37';
const USER_PDA_BS58 = 'HLhkxwuoxDLEJ4cnKW3G9Z4TgvNtGSQTwj2DsmxGtjU5';

const ERC20_ABI = [
  { name: 'symbol',   type: 'function', stateMutability: 'view', inputs: [], outputs: [{ type: 'string' }] },
  { name: 'name',     type: 'function', stateMutability: 'view', inputs: [], outputs: [{ type: 'string' }] },
  { name: 'decimals', type: 'function', stateMutability: 'view', inputs: [], outputs: [{ type: 'uint8' }] },
];

const TOKENS = [
  { addr: '0x6ed2944bba4cb5b1cb295541f315c648658dd67c', codebaseLabel: 'rUSDC (codebase)' },
  { addr: '0xb7c77397143adea219ac03a4005d304af1bfebe3', codebaseLabel: 'rWSOL (codebase)' },
];

async function symbolOf(pc, t) {
  const out = {};
  for (const fn of ['symbol', 'name', 'decimals']) {
    try {
      out[fn] = await pc.readContract({ address: t.addr, abi: ERC20_ABI, functionName: fn });
    } catch (e) { out[fn] = 'REVERT'; }
  }
  return out;
}

async function main() {
  const pc = createPublicClient({ chain: rome, transport: http() });

  console.log('=== Rome L2 (chainId 999999) ===');
  const ethBal = await pc.getBalance({ address: USER });
  // Per user: USDC is the gas token; native units use 18 decimals like ETH
  // — so display both interpretations.
  console.log(`Native gas balance: ${ethBal} wei`);
  console.log(`  → ${(Number(ethBal) / 1e18).toFixed(6)} USDC (gas, 18-dec scaling)`);
  console.log(`  → ${(Number(ethBal) / 1e6).toFixed(6)} if 6-dec scaled (unlikely)`);

  console.log('\n=== ERC20 wrappers — actual symbol/name on chain ===');
  for (const t of TOKENS) {
    const meta = await symbolOf(pc, t);
    console.log(`  ${t.codebaseLabel} @ ${t.addr}`);
    console.log(`    symbol():   ${meta.symbol}`);
    console.log(`    name():     ${meta.name}`);
    console.log(`    decimals(): ${meta.decimals}`);
  }

  console.log('\n=== Solana devnet — PDA + USDC ATA ===');
  const conn = new Connection('https://api.devnet.solana.com', 'confirmed');
  const pda = new PublicKey(USER_PDA_BS58);
  const pdaInfo = await conn.getAccountInfo(pda);
  console.log(`PDA ${USER_PDA_BS58}: ${pdaInfo
    ? `EXISTS (${pdaInfo.lamports} lamports, owner=${pdaInfo.owner.toBase58()})`
    : 'NOT YET CREATED — known gap, bridge native deposit does not allocate it'}`);
}

main().catch(e => { console.error(e); process.exit(1); });
