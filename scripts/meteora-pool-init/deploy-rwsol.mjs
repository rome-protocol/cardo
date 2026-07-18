// deploy-rwsol.mjs — deploy WWSOL ERC20-SPL wrapper on Rome.
//
// Calls the canonical rome-solidity ERC20SPLFactory at 0x266c…574d:
//   add_spl_token_no_metadata(bytes32 mint, string name, string symbol) → address
//
// mint = bytes32(So11111111111111111111111111111111111111112) (canonical WSOL).
// Returns the deployed wrapper address; we capture it from the TokenCreated event.

import { ethers } from 'ethers';
import fs from 'node:fs';
import os from 'node:os';

const RPC = 'https://rome.devnet.romeprotocol.xyz/';
const FACTORY = '0x266c57c28fd55ad6b7e3a503ba29eb1510c1574d';
const WSOL_MINT_BYTES32 = '0x069b8857feab8184fb687f634618c035dac439dc1aeb3b5598a0f00000000001';

const pk = '0x' + fs.readFileSync(os.homedir() + '/.rome-rome-deployer.key', 'utf8').trim().replace(/^0x/, '');
const provider = new ethers.JsonRpcProvider(RPC);
const wallet = new ethers.Wallet(pk, provider);
console.log('signer:', wallet.address);
console.log('balance:', ethers.formatEther(await provider.getBalance(wallet.address)));

const iface = new ethers.Interface([
  'function add_spl_token_no_metadata(bytes32 mint, string name, string symbol) returns (address)',
  'function token_by_mint(bytes32) view returns (address)',
  'event TokenCreated(address indexed creator, bytes32 indexed mint, address indexed wrapper, string name, string symbol, uint64 nonce)',
]);

// Pre-flight: confirm the wrapper doesn't exist yet.
const existing = await provider.call({
  to: FACTORY,
  data: iface.encodeFunctionData('token_by_mint', [WSOL_MINT_BYTES32]),
});
const existingAddr = '0x' + existing.slice(-40);
if (existingAddr !== '0x0000000000000000000000000000000000000000') {
  console.log(`WWSOL already deployed at ${existingAddr} — exiting.`);
  fs.writeFileSync('/tmp/meteora-pool-init/rwsol.json', JSON.stringify({
    address: existingAddr, alreadyDeployed: true,
  }, null, 2));
  process.exit(0);
}

const data = iface.encodeFunctionData('add_spl_token_no_metadata', [
  WSOL_MINT_BYTES32,
  'Rome-wrapped Wrapped SOL',
  'WWSOL',
]);

const nonce = await provider.getTransactionCount(wallet.address, 'pending');
const tx = {
  type: 0,
  chainId: 999999n,
  nonce,
  gasPrice: 1_000_000_000n,
  gasLimit: 200_000_000n,
  to: FACTORY,
  value: 0n,
  data,
};

console.log('\nsending tx...');
const sent = await wallet.sendTransaction(tx);
console.log('tx hash:', sent.hash);

console.log('waiting for receipt...');
const receipt = await sent.wait();
console.log('block:', receipt.blockNumber, 'status:', receipt.status, 'gasUsed:', receipt.gasUsed.toString());

let wrapperAddr = null;
for (const log of receipt.logs) {
  try {
    const parsed = iface.parseLog(log);
    if (parsed?.name === 'TokenCreated') {
      wrapperAddr = parsed.args.wrapper;
      console.log('TokenCreated event:');
      console.log('  creator:', parsed.args.creator);
      console.log('  mint:   ', parsed.args.mint);
      console.log('  wrapper:', wrapperAddr);
      console.log('  name:   ', parsed.args.name);
      console.log('  symbol: ', parsed.args.symbol);
      console.log('  nonce:  ', parsed.args.nonce.toString());
      break;
    }
  } catch (_) {}
}

if (!wrapperAddr) {
  // Fallback to mapping read
  const w = await provider.call({
    to: FACTORY,
    data: iface.encodeFunctionData('token_by_mint', [WSOL_MINT_BYTES32]),
  });
  wrapperAddr = '0x' + w.slice(-40);
  console.log('wrapper (fallback read):', wrapperAddr);
}

fs.writeFileSync('/tmp/meteora-pool-init/rwsol.json', JSON.stringify({
  address: wrapperAddr,
  txHash: sent.hash,
  block: receipt.blockNumber,
  gasUsed: receipt.gasUsed.toString(),
}, null, 2));
console.log('\nwrote /tmp/meteora-pool-init/rwsol.json');
