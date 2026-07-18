import { createPublicClient, defineChain, http } from 'viem';
import { Connection, PublicKey } from '@solana/web3.js';

const rome = defineChain({
  id: 999999,
  name: 'Rome chain',
  nativeCurrency: { name: 'mETH', symbol: 'mETH', decimals: 18 },
  rpcUrls: { default: { http: ['https://rome.devnet.romeprotocol.xyz/'] } },
});

const ERC20_ABI = [{
  name: 'balanceOf', type: 'function', stateMutability: 'view',
  inputs: [{ name: 'a', type: 'address' }],
  outputs: [{ name: '', type: 'uint256' }],
}];

const USER = '0x2A26DA21e06e0b521d98E9879192E9F3a40C9a37';
const USER_PDA_BS58 = 'HLhkxwuoxDLEJ4cnKW3G9Z4TgvNtGSQTwj2DsmxGtjU5';
const USDC_ATA_BS58 = 'ApPTaxVEVPiw6EW9QrkHYJrJCcGTCuRv43QscNQyDqCE';

const TOKENS = [
  { name: 'WUSDC', addr: '0x1F7DfAf9444D46fC10b4B4736D906dA5cAf46195', dec: 6 },
  { name: 'WWSOL', addr: '0xb7c77397143adea219ac03a4005d304af1bfebe3', dec: 9 },
];

async function safeBalance(pc, t) {
  try {
    const v = await pc.readContract({ address: t.addr, abi: ERC20_ABI, functionName: 'balanceOf', args: [USER] });
    return `${(Number(v) / 10 ** t.dec).toFixed(t.dec)} (raw ${v})`;
  } catch (e) {
    const msg = e?.shortMessage ?? e?.message ?? String(e);
    return `REVERTED: ${msg.split('\n')[0]}`;
  }
}

async function main() {
  const pc = createPublicClient({ chain: rome, transport: http() });

  console.log('=== Rome L2 (chainId 999999) ===');
  const ethBal = await pc.getBalance({ address: USER });
  console.log(`mETH balance:    ${(Number(ethBal) / 1e18).toFixed(6)} mETH (raw ${ethBal})`);
  for (const t of TOKENS) {
    console.log(`${t.name} balance:   ${await safeBalance(pc, t)}`);
  }

  console.log('\n=== Solana devnet ===');
  const conn = new Connection('https://api.devnet.solana.com', 'confirmed');

  const pda = new PublicKey(USER_PDA_BS58);
  const pdaInfo = await conn.getAccountInfo(pda);
  console.log(`User PDA (${USER_PDA_BS58}):`);
  console.log(pdaInfo
    ? `  EXISTS - ${pdaInfo.lamports} lamports, owner=${pdaInfo.owner.toBase58()}, data=${pdaInfo.data.length}B`
    : '  NOT YET CREATED');

  const ata = new PublicKey(USDC_ATA_BS58);
  const ataInfo = await conn.getAccountInfo(ata);
  console.log(`USDC ATA (${USDC_ATA_BS58}):`);
  console.log(ataInfo
    ? `  EXISTS - ${ataInfo.lamports} lamports, owner=${ataInfo.owner.toBase58()}`
    : '  NOT YET CREATED');
}

main().catch(e => { console.error(e); process.exit(1); });
