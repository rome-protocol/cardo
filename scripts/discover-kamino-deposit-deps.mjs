// Discover Kamino USDC reserve's deposit dependencies by inspecting a
// recent SUCCESSFUL deposit/refresh tx on mainnet. Copy the working
// account list directly rather than guessing offsets in the reserve struct.

import { Connection, PublicKey } from '@solana/web3.js';

const RPC = process.env.MAINNET_RPC ?? 'https://api.mainnet-beta.solana.com';
const KLEND = 'KLend2g3cP87fffoy8q1mQqGKjrxjC8boSyAYavgmjD';
const USDC_RESERVE = 'D6q6wuQSrifJKZYpR1M8R4YawnLDtDsMmWM1NbBmgJ59';

async function rpc(method, params, retries = 6) {
  for (let i = 0; i < retries; i++) {
    if (i > 0) await new Promise(r => setTimeout(r, 1500 * i));
    try {
      const res = await fetch(RPC, {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
      });
      if (res.status === 429) continue;
      const j = await res.json();
      if (j.error) {
        if (j.error.code === 429 || (j.error.message ?? '').toLowerCase().includes('too many')) continue;
        throw new Error(`${method}: ${j.error.message}`);
      }
      return j.result;
    } catch (e) { if (i === retries - 1) throw e; }
  }
}

async function main() {
  console.log(`Probing recent activity on Kamino USDC reserve ${USDC_RESERVE}...\n`);

  const sigs = await rpc('getSignaturesForAddress', [USDC_RESERVE, { limit: 10 }]);
  console.log(`Recent sigs:`);
  for (const s of sigs.slice(0, 5)) console.log(`  ${s.signature.slice(0, 30)}…  slot=${s.slot}  err=${s.err ?? 'ok'}`);
  console.log('');

  // Fetch the most recent SUCCESSFUL one + look at its outer ix accounts
  for (const s of sigs.slice(0, 5)) {
    if (s.err) continue;
    await new Promise(r => setTimeout(r, 500));
    const tx = await rpc('getTransaction', [s.signature, { maxSupportedTransactionVersion: 0, encoding: 'json' }]);
    if (!tx) continue;
    const allKeys = tx.transaction.message.accountKeys;

    // Look for the refresh_reserve ix targeting USDC_RESERVE
    for (const ix of tx.transaction.message.instructions) {
      const programId = allKeys[ix.programIdIndex];
      if (programId !== KLEND) continue;
      const accountIdxs = ix.accounts;
      const accountKeys = accountIdxs.map(i => allKeys[i]);
      // refresh_reserve: 6 accounts; deposit: 13+
      // Show ix discriminator (first 8 bytes of data) + account list
      const dataB58 = ix.data;
      // bs58 decode
      const bs58 = (await import('bs58')).default;
      const dataBytes = bs58.decode(dataB58);
      const disc = Buffer.from(dataBytes.subarray(0, 8)).toString('hex');
      console.log(`  tx ${s.signature.slice(0, 16)}…  ix disc 0x${disc}  ${accountKeys.length} accts:`);
      for (let i = 0; i < accountKeys.length; i++) {
        // Mark the reserve account specifically
        const flag = accountKeys[i] === USDC_RESERVE ? '*RESERVE*' : '';
        console.log(`    [${i}] ${accountKeys[i]}  ${flag}`);
      }
      console.log('');
    }
  }
}

main().catch(e => { console.error('threw:', e); process.exit(1); });
