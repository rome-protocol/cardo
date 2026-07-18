// L1 (hermetic) — chain-aware client-side derivations.
//
// Regression for the Martius PrivilegeEscalation swap failure (2026-07-06):
// lib/solana-pda.ts froze ROME_EVM_PROGRAM_ID at module load from the BOOT
// default chain (Hadrian in the client bundle), so on any deployment whose
// active chain isn't the default, every user-PDA/ATA in a CPI was derived
// under the wrong rome-evm program — the active chain's program can't sign
// for a foreign program's PDA, and the Solana runtime rejects the claimed
// signer privilege (InstructionError PrivilegeEscalation).
//
// The fix: (a) derivations resolve the program id at CALL time and accept an
// explicit chainId; (b) EnvProvider publishes the runtime chain via
// setRuntimeChainId, so bare calls are correct once /api/env lands or the
// header switcher changes chain.
import { describe, it, expect, afterEach } from 'vitest';
import {
  getChainConfig,
  setRuntimeChainId,
  activeChain,
  HADRIAN_CHAIN_ID,
} from '../lib/chain-config';
import { deriveRomeUserPda, deriveUserAta } from '../lib/solana-pda';
import { ROME_ADDRESSES, romeStaticTokens, romeChainMintId } from '../lib/addresses';
import { kaminoMainMarket } from '../lib/kamino-markets';
import { pumpswapActivePool } from '../lib/pumpswap-pool-config';

const MARTIUS = 121214;
const SENDER = '0xc5dD0c5d2bD6814b9F0314Cf508C0930a7F03950';
// PDA([EXTERNAL_AUTHORITY, sender], <program>) — computed with
// @solana/web3.js findProgramAddressSync against the registry program ids.
const PDA_UNDER_HADRIAN =
  '0x7e525001cb650179c1c1bbf39ab2bfa2eb4dcf2be7e1de7fd28eef3a81764e7f';
const PDA_UNDER_MARTIUS =
  '0x84c8a274c51135a5dd9a7a57a11e819f802a8fdc6a0d9376832f9d6aa76ac1f9';

afterEach(() => setRuntimeChainId(null));

describe('deriveRomeUserPda — chain-aware signer derivation', () => {
  it('defaults to the boot chain (Hadrian)', () => {
    expect(deriveRomeUserPda(SENDER)).toBe(PDA_UNDER_HADRIAN);
  });

  it('derives under the requested chain via explicit chainId', () => {
    expect(deriveRomeUserPda(SENDER, MARTIUS)).toBe(PDA_UNDER_MARTIUS);
  });

  it('bare calls follow the runtime chain once set (the /api/env + switcher path)', () => {
    setRuntimeChainId(MARTIUS);
    expect(deriveRomeUserPda(SENDER)).toBe(PDA_UNDER_MARTIUS);
    setRuntimeChainId(null);
    expect(deriveRomeUserPda(SENDER)).toBe(PDA_UNDER_HADRIAN);
  });

  it('an unknown runtime chain id is ignored, not silently adopted', () => {
    setRuntimeChainId(999999);
    expect(deriveRomeUserPda(SENDER)).toBe(PDA_UNDER_HADRIAN);
  });

  it('user ATAs inherit the chain-correct owner PDA', () => {
    const mint = '0x' + '11'.repeat(32);
    const hadrianAta = deriveUserAta(SENDER, mint as `0x${string}`);
    const martiusAta = deriveUserAta(SENDER, mint as `0x${string}`, MARTIUS);
    expect(hadrianAta).not.toBe(martiusAta);
    setRuntimeChainId(MARTIUS);
    expect(deriveUserAta(SENDER, mint as `0x${string}`)).toBe(martiusAta);
  });
});

describe('addresses / market configs — no module-load freeze', () => {
  it('ROME_ADDRESSES reflects the runtime chain', () => {
    expect(ROME_ADDRESSES.tokens).toEqual(getChainConfig(HADRIAN_CHAIN_ID).wrappers);
    setRuntimeChainId(MARTIUS);
    expect(ROME_ADDRESSES.tokens).toEqual(getChainConfig(MARTIUS).wrappers);
    expect(ROME_ADDRESSES.erc20SplFactory).toBe(getChainConfig(MARTIUS).erc20SplFactory);
    expect(ROME_ADDRESSES.oracles).toEqual(getChainConfig(MARTIUS).oracles);
  });

  it('romeStaticTokens follows the chain and keeps stable identity per chain', () => {
    const hadrian = romeStaticTokens();
    expect(romeStaticTokens()).toBe(hadrian); // memoized — safe as a hook dep
    setRuntimeChainId(MARTIUS);
    const martius = romeStaticTokens();
    expect(martius).not.toBe(hadrian);
    const wUsdc = martius.find((t) => t.symbol.toLowerCase() === 'wusdc');
    expect(wUsdc?.address).toBe(getChainConfig(MARTIUS).wrappers.wUsdc);
  });

  it('romeChainMintId follows the chain', () => {
    setRuntimeChainId(MARTIUS);
    expect(romeChainMintId()).toBe(getChainConfig(MARTIUS).chainMintId);
  });

  it('kamino + pumpswap configs resolve wrappers at call time', () => {
    setRuntimeChainId(MARTIUS);
    const m = getChainConfig(MARTIUS).wrappers;
    const kamino = kaminoMainMarket();
    expect(kamino.reserves.find((r) => r.symbol === 'WUSDC')?.wrapper).toBe(m.wUsdc);
    expect(pumpswapActivePool().quote.wrapper).toBe(m.wWsol);
  });

  it('activeChain() itself honors the runtime override', () => {
    setRuntimeChainId(MARTIUS);
    expect(activeChain().id).toBe(MARTIUS);
    expect(activeChain(HADRIAN_CHAIN_ID).id).toBe(HADRIAN_CHAIN_ID); // explicit wins
  });
});
