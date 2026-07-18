import { createWalletClient, createPublicClient, http, parseAbi, defineChain } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import fs from 'node:fs';

const rome = defineChain({
  id: 999999,
  name: 'Rome chain',
  nativeCurrency: { decimals: 18, name: 'WUSDC', symbol: 'WUSDC' },
  rpcUrls: { default: { http: ['https://rome.devnet.romeprotocol.xyz/'] } },
});

const FACTORY = '0x266c57c28fd55ad6b7e3a503ba29eb1510c1574d';
const ABI = parseAbi([
  'function create_user()',
  'function add_spl_token_no_metadata(bytes32 mint, string name, string symbol) returns (address)',
  'function token_by_mint(bytes32) view returns (address)',
  'event TokenCreated(address indexed creator, bytes32 indexed mint, address indexed wrapper, string name, string symbol, uint64 nonce)',
]);

// Drift devnet USDC mint 8zGuJQqwhZafTah7Uc7Z4tXRnguqkn5KLFAP8oV6PHe2 → bytes32 hex
function bs58Decode(s) {
  const a = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
  let n = 0n;
  for (const c of s) n = n * 58n + BigInt(a.indexOf(c));
  return '0x' + n.toString(16).padStart(64, '0');
}
const mintBs58 = '8zGuJQqwhZafTah7Uc7Z4tXRnguqkn5KLFAP8oV6PHe2';
const mintHex = bs58Decode(mintBs58);
console.log('mintHex:', mintHex);

const pk = fs.readFileSync(process.env.HOME + '/.rome-rome-deployer.key', 'utf8').trim();
const account = privateKeyToAccount(pk.startsWith('0x') ? pk : ('0x' + pk));
console.log('deployer:', account.address);

const pub = createPublicClient({ chain: rome, transport: http() });
const wallet = createWalletClient({ chain: rome, transport: http(), account });

// Check existing wrapper
const existing = await pub.readContract({ address: FACTORY, abi: ABI, functionName: 'token_by_mint', args: [mintHex] });
console.log('existing wrapper:', existing);
if (existing && existing !== '0x0000000000000000000000000000000000000000') {
  console.log('ALREADY DEPLOYED → exit');
  process.exit(0);
}

const balance = await pub.getBalance({ address: account.address });
console.log('deployer balance (wei):', balance.toString());

console.log('Calling add_spl_token_no_metadata...');
const hash = await wallet.writeContract({
  address: FACTORY, abi: ABI, functionName: 'add_spl_token_no_metadata',
  args: [mintHex, 'Drift Devnet USDC', 'WUSDCdrift'],
  type: 'legacy', gasPrice: 11_000_000_000n, gas: 200_000_000n,
});
console.log('tx:', hash);
const receipt = await pub.waitForTransactionReceipt({ hash });
console.log('status:', receipt.status, 'block:', receipt.blockNumber);
const wrapper = await pub.readContract({ address: FACTORY, abi: ABI, functionName: 'token_by_mint', args: [mintHex] });
console.log('NEW wrapper:', wrapper);
