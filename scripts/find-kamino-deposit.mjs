// Aggressive Kamino USDC deposit discovery.
// 1. Pull MANY recent sigs touching the USDC reserve.
// 2. Filter by ix data length (deposit ≠ flash loan disc).
// 3. For each candidate, decode + report.
// 4. Stop on the first real deposit/refresh chain found.

import bs58Mod from 'bs58';
const b58 = bs58Mod.default ?? bs58Mod;

const RPC = process.env.MAINNET_RPC ?? 'https://api.mainnet-beta.solana.com';
const KLEND = 'KLend2g3cP87fffoy8q1mQqGKjrxjC8boSyAYavgmjD';
// User can override via env to scan a different reserve
const USDC_RESERVE = process.env.RESERVE ?? 'D6q6wuQSrifJKZYpR1M8R4YawnLDtDsMmWM1NbBmgJ59';

const FLASH_BORROW = '87e734a70734d4c1';
const FLASH_REPAY  = 'b97500cb60f5b4ba';
const REFRESH_RESERVE = '02da8aeb4fc91966';
const DEPOSIT_LEGACY = '81c70402de271a2e';

// Try generating discs for v2 variants with crypto
const KNOWN_DISCS_BY_NAME = {
  '02da8aeb4fc91966': 'refresh_reserve',
  '218493e497c04859': 'refresh_obligation',
  '81c70402de271a2e': 'deposit_reserve_liquidity_and_obligation_collateral',
  'd8e0bf1bcc9766af': 'deposit_reserve_liquidity_and_obligation_collateral_v2',
  '08a00691d8d31efa': 'deposit_reserve_liquidity_v2',
  '6cd1044815167685': 'deposit_obligation_collateral',
  '8991975ea7710491': 'deposit_obligation_collateral_v2',
  'a9c91e7e06cd6644': 'deposit_reserve_liquidity',
  '87e734a70734d4c1': 'flash_borrow_reserve_liquidity',
  'b97500cb60f5b4ba': 'flash_repay_reserve_liquidity',
  '75a9b045c5170fa2': 'init_user_metadata',
  'fb0ae74c1b0b9f60': 'init_obligation',
  'a1808ff5abc7c206': 'borrow_obligation_liquidity_v2',
  '74aed54cb435d290': 'repay_obligation_liquidity_v2',
  '87202d4bef8d8aa5': 'withdraw_obligation_collateral_and_redeem_reserve_liquidity_v2',
  'fa37b6f8e87fc8b5': 'init_obligation_farms_for_reserve',
  '8895a04ed3a32d11': 'refresh_obligation_farms_for_reserve',
};

const SKIP_DISCS = new Set([FLASH_BORROW, FLASH_REPAY]);

async function rpc(method, params, retries = 5) {
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
  console.log(`Scanning Kamino USDC reserve ${USDC_RESERVE}...\n`);

  // Pull a manageable batch
  const sigs = await rpc('getSignaturesForAddress', [USDC_RESERVE, { limit: 100 }]);
  const okSigs = sigs.filter(s => !s.err);
  console.log(`  ${okSigs.length}/${sigs.length} non-err\n`);
  const allSigs = okSigs;

  const ixCounts = {};
  let depositTxFound = null;
  let refreshTxFound = null;

  for (let i = 0; i < okSigs.length; i++) {
    const ok = okSigs[i];
    if (i > 0) await new Promise(r => setTimeout(r, 200));
    let tx;
    try {
      tx = await rpc('getTransaction', [ok.signature, { maxSupportedTransactionVersion: 0, encoding: 'json' }]);
    } catch (_e) { continue; }
    if (!tx) continue;

    const m = tx.transaction.message;
    const staticKeys = m.accountKeys ?? [];
    const loadedRO = tx.meta?.loadedAddresses?.readonly ?? [];
    const loadedRW = tx.meta?.loadedAddresses?.writable ?? [];
    const allKeys = [...staticKeys, ...loadedRW, ...loadedRO];

    for (const ix of m.instructions) {
      const programId = allKeys[ix.programIdIndex];
      if (programId !== KLEND) continue;
      const dataBytes = b58.decode(ix.data);
      const disc = Buffer.from(dataBytes.subarray(0, 8)).toString('hex');
      ixCounts[disc] = (ixCounts[disc] || 0) + 1;

      if (SKIP_DISCS.has(disc)) continue;

      const method = KNOWN_DISCS_BY_NAME[disc] ?? '<unknown>';

      if (!refreshTxFound && disc === REFRESH_RESERVE) {
        // Only accept a refresh that's specifically for OUR reserve
        const reserveSlot = allKeys[ix.accounts[0]];
        if (reserveSlot === USDC_RESERVE) {
          refreshTxFound = { ok, ix, allKeys };
        }
      }
      // Detect any deposit variant
      if (!depositTxFound && (
        disc === DEPOSIT_LEGACY ||
        disc === 'd8e0bf1bcc9766af' ||
        disc === '08a00691d8d31efa' ||
        method.includes('deposit')
      )) {
        depositTxFound = { ok, ix, allKeys, disc, method };
      }
    }

    if (depositTxFound && refreshTxFound) break;
  }

  console.log(`\n=== Ix discriminator counts ===`);
  for (const [disc, n] of Object.entries(ixCounts).sort((a,b) => b[1] - a[1])) {
    const name = KNOWN_DISCS_BY_NAME[disc] ?? '<unknown>';
    console.log(`  ${disc}  count=${n}  ${name}`);
  }

  if (refreshTxFound) {
    console.log(`\n=== refresh_reserve found ===`);
    console.log(`  tx: ${refreshTxFound.ok.signature}`);
    console.log(`  accounts:`);
    for (let j = 0; j < refreshTxFound.ix.accounts.length; j++) {
      const k = refreshTxFound.allKeys[refreshTxFound.ix.accounts[j]];
      console.log(`    [${j}] ${k}`);
    }
  }

  if (depositTxFound) {
    console.log(`\n=== deposit found ===`);
    console.log(`  method: ${depositTxFound.method} (disc ${depositTxFound.disc})`);
    console.log(`  tx: ${depositTxFound.ok.signature}`);
    console.log(`  accounts:`);
    for (let j = 0; j < depositTxFound.ix.accounts.length; j++) {
      const k = depositTxFound.allKeys[depositTxFound.ix.accounts[j]];
      console.log(`    [${j}] ${k}`);
    }
  } else {
    console.log(`\n  NO DEPOSIT IX FOUND in ${okSigs.length} txs.`);
  }
}

main().catch(e => { console.error('threw:', e); process.exit(1); });
