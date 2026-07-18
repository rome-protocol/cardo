// Derive Kamino's PDAs from a real on-chain example to confirm seeds.
// We have a known good deposit tx — extract the user, obligation,
// obligation_farm_user_state, and back-derive the seeds.

import { PublicKey } from '@solana/web3.js';

const KLEND = new PublicKey('KLend2g3cP87fffoy8q1mQqGKjrxjC8boSyAYavgmjD');
const FARMS = new PublicKey('FarmsPZpWu9i7Kky8tPN37rs2TpmMrAZrC7S7vJa91Hr');
const MAIN_MARKET = new PublicKey('7u3HeHxYDLhnCoErrtycNokbQYbWGzLs6JSDqGAv5PfF');

// Real deposit (USDT reserve) decoded earlier:
const TX = {
  owner:                  new PublicKey('FPUqspsUG5ZudHfi1dPhp8DSYjU5nZCGXzqw9EdzZEGV'),
  obligation:             new PublicKey('9x92uKzGk3XAqqPgaRbFuStsYrBCxozGzAHosBELk6fN'),
  obligationFarmUserState:new PublicKey('3cdzHkSpKRQUgNi4ptaJgMJCsRYwSbFt4KKMZ7Z4qD1p'),
  reserveFarmState:       new PublicKey('8qcg3HogEhVXXUxkgbgcC8wtZgVwRjQsaxiCMYRpkvKA'),
  reserve:                new PublicKey('H3t6qZ1JkguCNTi9uzVKqQ7dvt2cum4XiXWom6Gn5e5S'), // USDT
};

function tryDerive(label, seeds, programId) {
  try {
    const [pda, bump] = PublicKey.findProgramAddressSync(seeds, programId);
    return { label, pda: pda.toBase58(), bump };
  } catch (e) {
    return { label, error: e.message };
  }
}

async function main() {
  console.log('=== Reverse-engineering Kamino PDA seeds ===\n');
  console.log(`owner:                   ${TX.owner.toBase58()}`);
  console.log(`obligation (target):     ${TX.obligation.toBase58()}`);
  console.log(`obligationFarmUserState: ${TX.obligationFarmUserState.toBase58()}`);
  console.log(`reserveFarmState:        ${TX.reserveFarmState.toBase58()}`);
  console.log(`reserve:                 ${TX.reserve.toBase58()}`);
  console.log(`market:                  ${MAIN_MARKET.toBase58()}`);
  console.log('');

  // 1. Obligation derivation. Per Cardo's lib (deriveVanillaObligation):
  //    [0, 0, owner, market, 0_pubkey, 0_pubkey]
  console.log('--- Obligation candidates ---');
  const candidates = [
    [Buffer.from([0]), Buffer.from([0]), TX.owner.toBuffer(), MAIN_MARKET.toBuffer(), PublicKey.default.toBuffer(), PublicKey.default.toBuffer()],
    [Buffer.from([0,0]), TX.owner.toBuffer(), MAIN_MARKET.toBuffer(), PublicKey.default.toBuffer(), PublicKey.default.toBuffer()],
    [Buffer.from('vanilla'), TX.owner.toBuffer(), MAIN_MARKET.toBuffer()],
  ];
  for (const seeds of candidates) {
    const r = tryDerive('obligation', seeds, KLEND);
    const match = r.pda === TX.obligation.toBase58() ? '★ MATCH' : '';
    console.log(`  seeds=${seeds.map(s => `[${s.length}B]`).join(' ')}  => ${r.pda} ${match}`);
  }

  // 2. obligationFarmUserState derivation candidates.
  //    Common Anchor patterns: [farms_const, reserveFarmState, obligation]
  //                         or [b"user", reserveFarmState, owner]
  console.log('\n--- ObligationFarmUserState candidates (under FARMS program) ---');
  const farmCands = [
    ['user', TX.reserveFarmState.toBuffer(), TX.obligation.toBuffer()],
    ['user', TX.obligation.toBuffer(), TX.reserveFarmState.toBuffer()],
    ['user', TX.owner.toBuffer(), TX.reserveFarmState.toBuffer()],
    ['user_state', TX.reserveFarmState.toBuffer(), TX.obligation.toBuffer()],
  ];
  for (const seeds of farmCands) {
    const buffers = seeds.map(s => typeof s === 'string' ? Buffer.from(s) : s);
    const r = tryDerive('user_state', buffers, FARMS);
    const match = r.pda === TX.obligationFarmUserState.toBase58() ? '★ MATCH' : '';
    const label = seeds.map(s => typeof s === 'string' ? `"${s}"` : `[${s.length}B]`).join(' ');
    console.log(`  ${label.padEnd(60)} => ${r.pda} ${match}`);
  }
}

main().catch(e => { console.error('threw:', e); process.exit(1); });
