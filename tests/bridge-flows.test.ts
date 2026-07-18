// L1 (hermetic) — pure bridge-flow logic the hooks are thin wagmi glue over:
// quote-request builders (one per flow), the user-signed-tx extraction rule
// (sign the QUOTE's txs verbatim — §7.4), the step-1 binding-hash rule
// (step1TxHash = the LAST unsignedTx of step 1: pod verifies against it), and
// the TransferRecord → screen status mapping (emits the exact strings
// components/screens/Bridge.jsx humanPhase/humanOutcome expect).
import { describe, it, expect } from 'vitest';
import {
  BridgeFlowError,
  inboundCctpQuoteRequest,
  inboundWhQuoteRequest,
  outboundCctpQuoteRequest,
  outboundWhQuoteRequest,
  userSignedTxs,
  step1BindingTxIndex,
  transferFlowStatus,
} from '../lib/bridge-flows';
import type { Quote, TransferRecord } from '../lib/bridge-api-client';

const EVM = '0x3403e0De09Bc76Ca7d74762F264e4F6B649A0562';
const DEST = '0xC777615450b91C6dCf1532645C2d809C9fae2DAc';

describe('quote-request builders', () => {
  it('inbound CCTP: gas intent, ethereum sender, recipient = the user', () => {
    expect(inboundCctpQuoteRequest({ sourceChainId: 11155111, romeChainId: 200010, amount: 1_000_000n, evmAddress: EVM, speed: 'fast' })).toEqual({
      asset: 'USDC', direction: 'to-rome', sourceChain: 'ethereum', sourceChainId: 11155111,
      romeChainId: '200010', intent: 'gas', speed: 'fast', amount: '1000000',
      sender: { ethereum: EVM }, recipient: EVM,
    });
  });

  it('inbound Wormhole: EVM-only sender (pod accepts since sender.solana relax)', () => {
    const req = inboundWhQuoteRequest({ sourceChainId: 11155111, romeChainId: 200010, amount: 10n ** 15n, evmAddress: EVM });
    expect(req).toEqual({
      asset: 'ETH', direction: 'to-rome', sourceChain: 'ethereum', sourceChainId: 11155111,
      romeChainId: '200010', amount: '1000000000000000',
      sender: { ethereum: EVM }, recipient: EVM,
    });
    expect('solana' in req.sender).toBe(false);
  });

  it('outbound CCTP: rome sender, destinationChainId, EVM recipient', () => {
    expect(outboundCctpQuoteRequest({ destinationChainId: 11155111, romeChainId: 200010, amount: 200_000n, evmAddress: EVM, recipient: DEST })).toEqual({
      asset: 'USDC', direction: 'from-rome', sourceChain: 'ethereum', destinationChainId: 11155111,
      romeChainId: '200010', amount: '200000',
      sender: { rome: EVM }, recipient: DEST,
    });
  });

  it('outbound Wormhole: rome sender, EVM recipient', () => {
    expect(outboundWhQuoteRequest({ romeChainId: 200010, amount: 10n ** 15n, evmAddress: EVM, recipient: DEST })).toEqual({
      asset: 'ETH', direction: 'from-rome', sourceChain: 'ethereum',
      romeChainId: '200010', amount: '1000000000000000',
      sender: { rome: EVM }, recipient: DEST,
    });
  });
});

describe('userSignedTxs', () => {
  const cctpInQuote = {
    route: 'usdc-cctp-to-rome',
    steps: [
      { n: 1, chain: 'ethereum', kind: 'cctp-deposit-for-burn', unsignedTxs: [
        { to: '0xa', data: '0x1' }, { to: '0xb', data: '0x2' },
      ] },
      { n: 2, chain: 'solana', kind: 'cctp-receive-message', unsignedTx: null, blockedBy: ['step-1', 'circle-attestation'] },
    ],
  } as unknown as Quote;

  it('flattens the quote steps carrying unsignedTxs, in step order, tagged with stepN', () => {
    expect(userSignedTxs(cctpInQuote, 'usdc-cctp-to-rome')).toEqual([
      { stepN: 1, tx: { to: '0xa', data: '0x1' } },
      { stepN: 1, tx: { to: '0xb', data: '0x2' } },
    ]);
  });

  it('collects across MULTIPLE user-signed steps (wormhole-out: approve step 1, burn step 2)', () => {
    const whOut = {
      route: 'eth-wormhole-from-rome',
      steps: [
        { n: 2, chain: 'rome-200010', kind: 'wormhole-burn-eth', unsignedTxs: [{ to: '0xw', data: '0xburn' }], blockedBy: ['step-1'] },
        { n: 1, chain: 'rome-200010', kind: 'wormhole-approve-burn-eth', unsignedTxs: [{ to: '0xw', data: '0xapprove' }] },
        { n: 3, chain: 'ethereum', kind: 'wormhole-claim-on-ethereum', unsignedTx: null, blockedBy: ['step-2', 'wormhole-vaa'] },
      ],
    } as unknown as Quote;
    expect(userSignedTxs(whOut, 'eth-wormhole-from-rome')).toEqual([
      { stepN: 1, tx: { to: '0xw', data: '0xapprove' } },
      { stepN: 2, tx: { to: '0xw', data: '0xburn' } },
    ]);
  });

  it('throws BridgeFlowError on a route mismatch (never sign txs for a route we did not ask for)', () => {
    expect(() => userSignedTxs(cctpInQuote, 'eth-wormhole-to-rome')).toThrow(BridgeFlowError);
  });

  it('throws BridgeFlowError when the quote has no user-signed txs', () => {
    const q = { route: 'usdc-cctp-to-rome', steps: [{ n: 2, unsignedTx: null }] } as unknown as Quote;
    expect(() => userSignedTxs(q, 'usdc-cctp-to-rome')).toThrow(BridgeFlowError);
  });
});

describe('step1BindingTxIndex', () => {
  it('is the LAST tx of step 1 (CCTP-in [approve, burn] → the burn)', () => {
    expect(step1BindingTxIndex([
      { stepN: 1, tx: { to: '0xa', data: '0x1' } },
      { stepN: 1, tx: { to: '0xb', data: '0x2' } },
    ] as never)).toBe(1);
  });
  it('single-tx step 1 → 0', () => {
    expect(step1BindingTxIndex([{ stepN: 1, tx: { to: '0xa', data: '0x1' } }] as never)).toBe(0);
  });
  it('ignores later steps (wormhole-out approve is the step-1 binding tx)', () => {
    expect(step1BindingTxIndex([
      { stepN: 1, tx: { to: '0xw', data: '0xapprove' } },
      { stepN: 2, tx: { to: '0xw', data: '0xburn' } },
    ] as never)).toBe(0);
  });
});

describe('transferFlowStatus', () => {
  const rec = (over: Partial<TransferRecord>): TransferRecord => ({
    id: 't', route: 'usdc-cctp-to-rome', direction: 'to-rome', amountIn: '1', amountOut: '1',
    sender: {}, recipient: EVM, steps: [], outcome: 'pending', ...over,
  } as TransferRecord);

  it('any failed step → failed', () => {
    const s = transferFlowStatus(rec({ steps: [{ n: 1, kind: 'x', chain: 'ethereum', status: 'failed' }] as never }));
    expect(s.phase).toBe('failed');
  });

  it('outcome complete + settle confirmed (not skipped) → complete / all-gas', () => {
    const s = transferFlowStatus(rec({
      outcome: 'complete',
      steps: [
        { n: 1, kind: 'cctp-deposit-for-burn', chain: 'ethereum', status: 'confirmed' },
        { n: 3, kind: 'settle-inbound-bridge-sponsored', chain: 'solana', status: 'confirmed' },
      ] as never,
    }));
    expect(s).toEqual({ phase: 'complete', outcome: 'all-gas' });
  });

  it('outcome complete + degradation settle-skipped → complete / settle-skipped', () => {
    const s = transferFlowStatus(rec({
      outcome: 'complete', degradation: 'settle-skipped',
      steps: [{ n: 3, kind: 'settle-inbound-bridge-sponsored', chain: 'solana', status: 'confirmed', skipped: true }] as never,
    }));
    expect(s).toEqual({ phase: 'complete', outcome: 'settle-skipped' });
  });

  it('outcome complete with no settle step (wormhole-in / outbound) → complete / wrapper-only', () => {
    const s = transferFlowStatus(rec({
      route: 'eth-wormhole-to-rome', outcome: 'complete',
      steps: [{ n: 2, kind: 'wormhole-complete-transfer-wrapped', chain: 'solana', status: 'confirmed' }] as never,
    }));
    expect(s).toEqual({ phase: 'complete', outcome: 'wrapper-only' });
  });

  it('pending on a circle-attestation blocker → awaiting-attestation', () => {
    const s = transferFlowStatus(rec({
      steps: [
        { n: 1, kind: 'cctp-deposit-for-burn', chain: 'ethereum', status: 'submitted' },
        { n: 2, kind: 'cctp-receive-message', chain: 'solana', status: 'blocked', blockedBy: ['step-1', 'circle-attestation'] },
      ] as never,
    }));
    expect(s.phase).toBe('awaiting-attestation');
  });

  it('pending on a wormhole-vaa blocker → awaiting-vaa', () => {
    const s = transferFlowStatus(rec({
      route: 'eth-wormhole-to-rome',
      steps: [
        { n: 1, kind: 'wormhole-wrap-and-transfer-eth', chain: 'ethereum', status: 'submitted' },
        { n: 2, kind: 'wormhole-complete-transfer-wrapped', chain: 'solana', status: 'blocked', blockedBy: ['step-1', 'wormhole-vaa'] },
      ] as never,
    }));
    expect(s.phase).toBe('awaiting-vaa');
  });

  it('a sponsor step ready/submitted (attestation landed) → submitting', () => {
    const s = transferFlowStatus(rec({
      steps: [
        { n: 1, kind: 'cctp-deposit-for-burn', chain: 'ethereum', status: 'confirmed' },
        { n: 2, kind: 'cctp-receive-message', chain: 'solana', status: 'ready', blockedBy: ['step-1', 'circle-attestation'] },
      ] as never,
    }));
    expect(s.phase).toBe('submitting');
  });

  it('freshly registered (nothing attested, no attestation-class blockers ready) → registered', () => {
    const s = transferFlowStatus(rec({
      steps: [{ n: 1, kind: 'cctp-deposit-for-burn', chain: 'ethereum', status: 'submitted' }] as never,
    }));
    expect(s.phase).toBe('registered');
  });
});
