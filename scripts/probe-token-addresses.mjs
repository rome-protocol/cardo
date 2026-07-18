// Probe the 3 candidate USDC-related ERC20 wrappers on Rome to figure
// out which is the canonical SPL-backed WUSDC vs which were local ERC20
// mistakes.

import { createPublicClient, defineChain, http } from 'viem';

const rome = defineChain({
  id: 999999,
  name: 'Rome chain',
  nativeCurrency: { name: 'USDC', symbol: 'USDC', decimals: 18 },
  rpcUrls: { default: { http: ['https://rome.devnet.romeprotocol.xyz/'] } },
});

const ERC20_BASIC = [
  { name: 'symbol',      type: 'function', stateMutability: 'view', inputs: [], outputs: [{ type: 'string' }] },
  { name: 'name',        type: 'function', stateMutability: 'view', inputs: [], outputs: [{ type: 'string' }] },
  { name: 'decimals',    type: 'function', stateMutability: 'view', inputs: [], outputs: [{ type: 'uint8' }] },
  { name: 'totalSupply', type: 'function', stateMutability: 'view', inputs: [], outputs: [{ type: 'uint256' }] },
];

// SPL-wrapped (Rome ERC20-SPL) wrappers expose extra methods that
// reveal the underlying SPL mint. Two common names from rome-solidity:
const SPL_HINTS = [
  { name: 'mint',          type: 'function', stateMutability: 'view', inputs: [], outputs: [{ type: 'bytes32' }] },
  { name: 'mintId',        type: 'function', stateMutability: 'view', inputs: [], outputs: [{ type: 'bytes32' }] },
  { name: 'splMint',       type: 'function', stateMutability: 'view', inputs: [], outputs: [{ type: 'bytes32' }] },
  { name: 'tokenId',       type: 'function', stateMutability: 'view', inputs: [], outputs: [{ type: 'bytes32' }] },
];

const ADDRS = [
  { addr: '0x1F7DfAf9444D46fC10b4B4736D906dA5cAf46195', label: 'NEW canonical (per user)' },
  { addr: '0x6ed2944bba4cb5b1cb295541f315c648658dd67c', label: 'codebase rUSDC (chain_mint_id wrapper)' },
  { addr: '0x1be9d9c70cccd2697e07b5e3a7d59ed9d9e63533', label: 'codebase test USDC (=user said wrongly local-minted)' },
  { addr: '0xb7c77397143adea219ac03a4005d304af1bfebe3', label: 'codebase rWSOL' },
];

async function safe(pc, addr, fn, args = []) {
  try {
    return await pc.readContract({ address: addr, abi: [...ERC20_BASIC, ...SPL_HINTS], functionName: fn.name, args });
  } catch (e) {
    return null;
  }
}

function bytes32ToBs58(b32) {
  if (!b32) return null;
  // Convert 0x... 32-byte hex to base58 — for SPL mint pubkey display
  const buf = Buffer.from(b32.slice(2), 'hex');
  // dynamic import bs58
  const bs58 = require('bs58').default ?? require('bs58');
  return bs58.encode(buf);
}

async function main() {
  const pc = createPublicClient({ chain: rome, transport: http() });

  for (const a of ADDRS) {
    console.log(`\n=== ${a.label}`);
    console.log(`    ${a.addr}`);
    const sym = await safe(pc, a.addr, { name: 'symbol' });
    const nm  = await safe(pc, a.addr, { name: 'name' });
    const dec = await safe(pc, a.addr, { name: 'decimals' });
    const sup = await safe(pc, a.addr, { name: 'totalSupply' });
    console.log(`    symbol():      ${sym ?? '<no method>'}`);
    console.log(`    name():        ${nm ?? '<no method>'}`);
    console.log(`    decimals():    ${dec ?? '<no method>'}`);
    console.log(`    totalSupply(): ${sup ?? '<no method>'}`);
    // try SPL hint methods
    let foundMint = null;
    for (const fn of SPL_HINTS) {
      const v = await safe(pc, a.addr, fn);
      if (v) {
        foundMint = { fn: fn.name, value: v };
        break;
      }
    }
    if (foundMint) {
      console.log(`    SPL-mint-getter via ${foundMint.fn}(): ${foundMint.value}`);
      try {
        const bs58 = await import('bs58');
        const buf = Buffer.from(foundMint.value.slice(2), 'hex');
        const enc = (bs58.default ?? bs58).encode(buf);
        console.log(`    → bs58: ${enc}`);
      } catch (e) {
        // bs58 may not be installed; skip
      }
    } else {
      console.log(`    SPL-mint-getter: NONE — likely a local ERC20 (not SPL-backed)`);
    }
  }
}

main().catch(e => { console.error(e); process.exit(1); });
