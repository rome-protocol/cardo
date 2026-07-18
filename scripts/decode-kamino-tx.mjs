// Decode a recent Kamino USDC tx to find the right oracle + dep accounts.

import bs58Mod from 'bs58';
const b58 = bs58Mod.default ?? bs58Mod;

const RPC = process.env.MAINNET_RPC ?? 'https://api.mainnet-beta.solana.com';
const SIG = 'XC3SdxwqHXczWnT7z6PFkHRQoypuE1' + 'W'; // truncated; need full
const USDC_RESERVE = 'D6q6wuQSrifJKZYpR1M8R4YawnLDtDsMmWM1NbBmgJ59';

async function rpc(method, params) {
  for (let i = 0; i < 6; i++) {
    if (i > 0) await new Promise(r => setTimeout(r, 1500 * i));
    const res = await fetch(RPC, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
    });
    if (res.status === 429) continue;
    const j = await res.json();
    if (j.error) {
      if (j.error.code === 429) continue;
      throw new Error(j.error.message);
    }
    return j.result;
  }
}

async function main() {
  // Get the most recent tx involving USDC reserve (no err); use the
  // exact one from prior probe output
  // Scan multiple recent txs to find a deposit (not flash-loan)
  const sigs = await rpc('getSignaturesForAddress', [USDC_RESERVE, { limit: 300 }]);
  const okSigs = sigs.filter(s => !s.err);
  console.log(`Scanning ${okSigs.length} recent successful txs...\n`);

  for (const ok of okSigs) {
    await new Promise(r => setTimeout(r, 250));
    const tx = await rpc('getTransaction', [ok.signature, { maxSupportedTransactionVersion: 0, encoding: 'json' }]);
    if (!tx) continue;
    const m = tx.transaction.message;
    const staticKeys = m.accountKeys ?? [];
    const loadedRO = tx.meta?.loadedAddresses?.readonly ?? [];
    const loadedRW = tx.meta?.loadedAddresses?.writable ?? [];
    const allKeys = [...staticKeys, ...loadedRW, ...loadedRO];
    for (const ix of m.instructions) {
      const programId = allKeys[ix.programIdIndex];
      if (programId !== 'KLend2g3cP87fffoy8q1mQqGKjrxjC8boSyAYavgmjD') continue;
      const dataBytes = b58.decode(ix.data);
      const disc = Buffer.from(dataBytes.subarray(0, 8)).toString('hex');
      // Skip flash loans
      if (disc === '87e734a70734d4c1' || disc === 'b97500cb60f5b4ba') continue;
      // Skip refresh & init flow as well — we want a deposit
      if (disc === '02da8aeb4fc91966' || disc === '218493e497c04859' || disc === '75a9b045c5170fa2' || disc === 'fb0ae74c1b0b9f60') continue;
      console.log(`Found! tx ${ok.signature.slice(0, 30)} ix disc 0x${disc} ${ix.accounts.length} accts:`);
      for (let i = 0; i < ix.accounts.length; i++) {
        const k = allKeys[ix.accounts[i]];
        const tag = k === USDC_RESERVE ? '*USDC_RESERVE*' : '';
        console.log(`    [${i}] ${k}  ${tag}`);
      }
      console.log('');
      return;
    }
  }
  console.log('No non-flash-loan ix found in 30 recent txs.');

  await new Promise(r => setTimeout(r, 500));
  const tx = await rpc('getTransaction', [ok.signature, { maxSupportedTransactionVersion: 0, encoding: 'json' }]);
  const m = tx.transaction.message;
  // Account keys including loaded from ALT (not just static)
  const staticKeys = m.accountKeys ?? [];
  const loadedRO = tx.meta?.loadedAddresses?.readonly ?? [];
  const loadedRW = tx.meta?.loadedAddresses?.writable ?? [];
  const allKeys = [...staticKeys, ...loadedRW, ...loadedRO];
  console.log(`Account keys: ${allKeys.length} total (${staticKeys.length} static + ${loadedRW.length} ALT-rw + ${loadedRO.length} ALT-ro)\n`);

  for (const ix of m.instructions) {
    const programId = allKeys[ix.programIdIndex];
    if (programId !== 'KLend2g3cP87fffoy8q1mQqGKjrxjC8boSyAYavgmjD') continue;
    const dataBytes = b58.decode(ix.data);
    const disc = Buffer.from(dataBytes.subarray(0, 8)).toString('hex');

    // Map disc to known method name
    const methodMap = {
      '02da8aeb4fc91966': 'refresh_reserve',
      '218493e497c04859': 'refresh_obligation',
      '81c70402de271a2e': 'deposit_reserve_liquidity_and_obligation_collateral',
      'a1808ff5abc7c206': 'borrow_obligation_liquidity_v2',
      '74aed54cb435d290': 'repay_obligation_liquidity_v2',
      '87202d4bef8d8aa5': 'withdraw_obligation_collateral_and_redeem_reserve_liquidity_v2',
      'fb0ae74c1b0b9f60': 'init_obligation',
      '75a9b045c5170fa2': 'init_user_metadata',
    };
    const method = methodMap[disc] ?? '<unknown>';
    console.log(`  KLend ix: ${method}  (disc 0x${disc})  ${ix.accounts.length} accts:`);
    for (let i = 0; i < ix.accounts.length; i++) {
      const k = allKeys[ix.accounts[i]];
      const tag = k === USDC_RESERVE ? '*USDC_RESERVE*' : '';
      console.log(`    [${i}] ${k}  ${tag}`);
    }
    console.log('');
  }

  // Also look at inner CPIs
  if (tx.meta?.innerInstructions?.length) {
    console.log('Inner instructions:');
    for (const inner of tx.meta.innerInstructions) {
      for (const ix of inner.instructions) {
        const programId = allKeys[ix.programIdIndex];
        if (programId !== 'KLend2g3cP87fffoy8q1mQqGKjrxjC8boSyAYavgmjD') continue;
        const dataBytes = b58.decode(ix.data);
        const disc = Buffer.from(dataBytes.subarray(0, 8)).toString('hex');
        console.log(`  inner KLend ix disc 0x${disc} ${ix.accounts.length} accts`);
      }
    }
  }
}

main().catch(e => { console.error('threw:', e); process.exit(1); });
