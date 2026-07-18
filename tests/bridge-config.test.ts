// L1 (hermetic) — the inbound bridge config resolves from registry bridge.json
// for BOTH protocols (USDC→CCTP, ETH→Wormhole), and the recipient-ATA
// derivation the inbound hooks rely on produces valid pubkeys for each mint.
import { describe, it, expect } from 'vitest';
import { getChainConfig, HADRIAN_CHAIN_ID } from '../lib/chain-config';
import { deriveUserAta, bytes32ToPublicKey, pubkeyBs58ToBytes32 } from '../lib/solana-pda';

describe('inbound bridge config (Hadrian)', () => {
  const cfg = getChainConfig(HADRIAN_CHAIN_ID);

  it('resolves the bridge block', () => {
    expect(cfg.bridge).toBeDefined();
  });

  it('has the Sepolia source-EVM CCTP + Wormhole contracts', () => {
    const b = cfg.bridge!;
    expect(b.sourceEvm.chainId).toBe(11155111);
    expect(b.sourceEvm.usdc).toMatch(/^0x[0-9a-fA-F]{40}$/);
    expect(b.sourceEvm.cctpTokenMessenger).toMatch(/^0x[0-9a-fA-F]{40}$/);
    expect(b.sourceEvm.wormholeTokenBridge).toMatch(/^0x[0-9a-fA-F]{40}$/);
  });

  it('has the Rome-side outbound burn contract (RomeBridgeWithdraw)', () => {
    expect(cfg.bridge!.romeBridgeWithdraw).toMatch(/^0x[0-9a-fA-F]{40}$/);
  });

  it('has the Solana side: cctpDomain=5, the Wormhole-Solana chain id=1, and both mints', () => {
    const b = cfg.bridge!;
    expect(b.solana.cctpDomain).toBe(5);
    expect(b.solana.wormholeChainId).toBe(1); // Wormhole's canonical Solana chain id
    expect(b.solana.usdcMint.length).toBeGreaterThan(0);
    expect(b.solana.wethMint.length).toBeGreaterThan(0);
  });

  it('exposes a CCTP asset (USDC) and a Wormhole asset (ETH), kept distinct', () => {
    const b = cfg.bridge!;
    const cctp = b.assets.filter((a) => a.protocol === 'cctp');
    const wh = b.assets.filter((a) => a.protocol === 'wormhole');
    expect(cctp.length).toBeGreaterThanOrEqual(1);
    expect(wh.length).toBeGreaterThanOrEqual(1);
    expect(cctp.some((a) => a.symbol.toUpperCase().includes('USDC'))).toBe(true);
    expect(wh.some((a) => a.symbol.toUpperCase().includes('ETH'))).toBe(true);
  });

  it('derives a valid recipient ATA for each bridged mint (both protocols)', () => {
    const b = cfg.bridge!;
    const evm = '0xC777615450b91C6dCf1532645C2d809C9fae2DAc';
    for (const mint of [b.solana.usdcMint, b.solana.wethMint]) {
      const ataHex = deriveUserAta(evm, pubkeyBs58ToBytes32(mint));
      expect(ataHex).toMatch(/^0x[0-9a-fA-F]{64}$/); // 32-byte pubkey
      expect(bytes32ToPublicKey(ataHex).toBase58().length).toBeGreaterThan(0); // round-trips
    }
  });
});
