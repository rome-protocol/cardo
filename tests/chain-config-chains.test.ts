// L1 (hermetic) — the compiled chain set is GENERATED from the installed
// @rome-protocol/registry pin (scripts/build-chain-config.ts), not hand-listed.
// These assert the set's invariants: live devnet+testnet chains in, retired
// chains out, and the network-scoped view the header ChainSwitcher renders
// (a testnet deployment must not offer devnet chains, and vice versa).
import { describe, it, expect } from 'vitest';
import {
  CHAINS,
  HADRIAN_CHAIN_ID,
  activeChain,
  allChains,
  chainsForNetwork,
  getChainConfig,
} from '../lib/chain-config';

const MARTIUS = 121214;
const ADDR = /^0x[0-9a-fA-F]{40}$/;

describe('registry-generated chain set', () => {
  it('includes the published devnet chain (hadrian, the boot default)', () => {
    expect(CHAINS[200010]?.network).toBe('devnet');
  });

  it('includes the published testnet chain (martius)', () => {
    expect(CHAINS[MARTIUS]?.network).toBe('testnet');
  });

  it('excludes retired chains (marcus, trajan, capitoline, augustus, aurelius)', () => {
    for (const id of [121301, 121302, 200012, 200001, 30001]) {
      expect(CHAINS[id], `chain ${id} must not be compiled in`).toBeUndefined();
    }
  });

  it('martius resolves the full config: USDC gas, wrappers, factory, bridge', () => {
    const m = getChainConfig(MARTIUS);
    expect(m.name).toBe('Rome Martius');
    expect(m.rpcUrl).toBe('https://martius.testnet.romeprotocol.xyz/');
    expect(m.nativeCurrency.symbol).toBe('USDC');
    expect(m.romeEvmProgramId).toBe('RomeTaTNPJNBxtB3Wong9geVTtkEFJfUqgktQVq3iSX');
    expect(m.chainMintId).toBeTruthy();
    expect(m.wrappers.wUsdc).toMatch(ADDR);
    expect(m.wrappers.wEth).toMatch(ADDR);
    expect(m.wrappers.wWsol).toMatch(ADDR);
    expect(m.erc20SplFactory).toMatch(ADDR);
    expect(m.bridge).toBeDefined();
  });

  it('hadrian stays the boot default', () => {
    expect(activeChain().id).toBe(HADRIAN_CHAIN_ID);
  });
});

describe('chainsForNetwork — the ChainSwitcher scope', () => {
  it('testnet view lists only testnet chains, including martius', () => {
    const testnet = chainsForNetwork('testnet');
    expect(testnet.map((c) => c.id)).toContain(MARTIUS);
    for (const c of testnet) expect(c.network).toBe('testnet');
  });

  it('devnet view lists only devnet chains, including hadrian', () => {
    const devnet = chainsForNetwork('devnet');
    expect(devnet.map((c) => c.id)).toContain(HADRIAN_CHAIN_ID);
    for (const c of devnet) expect(c.network).toBe('devnet');
  });

  it('devnet + testnet partition allChains()', () => {
    expect(chainsForNetwork('devnet').length + chainsForNetwork('testnet').length).toBe(
      allChains().length,
    );
  });
});
