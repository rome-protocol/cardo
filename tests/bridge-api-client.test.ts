// L1 (hermetic) — the bridge-api client: typed wrapper over the pod's /v1
// surface (quote → register → poll → report). fetch is mocked; these tests pin
// the WIRE CONTRACT: URLs, methods, bodies, problem+json error mapping, and
// the settle-authorization fill rule (sign a filled COPY, submit the quote
// VERBATIM — the pod overlays sourceTxHash itself at verification).
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  DEFAULT_BRIDGE_API_BASE,
  BridgeApiError,
  requestQuote,
  registerTransfer,
  getTransfer,
  reportStep,
  settleTypedDataWithBurn,
  type Quote,
} from '../lib/bridge-api-client';

const okJson = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

const fetchMock = vi.fn();

beforeEach(() => {
  fetchMock.mockReset();
  vi.stubGlobal('fetch', fetchMock);
});
afterEach(() => {
  vi.unstubAllGlobals();
});

describe('base URL', () => {
  it('DEFAULT_BRIDGE_API_BASE is the live devnet pod', () => {
    expect(DEFAULT_BRIDGE_API_BASE).toBe('https://bridge-api.devnet.romeprotocol.xyz');
  });

  it('every call honors a runtime base override (chain-agnostic image: base comes from /api/env, never a build-time inline)', async () => {
    fetchMock.mockResolvedValue(okJson({ id: 't', outcome: 'pending', steps: [] }));
    await getTransfer('t', { base: 'https://bridge-api.testnet.romeprotocol.xyz' });
    expect(fetchMock.mock.calls[0]![0]).toBe('https://bridge-api.testnet.romeprotocol.xyz/v1/transfers/t');
  });
});

describe('requestQuote', () => {
  it('POSTs the request to /v1/quote and returns the parsed quote', async () => {
    const quote = { route: 'usdc-cctp-to-rome', direction: 'to-rome', amountIn: '1000000', amountOut: '999900', steps: [], signatureRequests: [] };
    fetchMock.mockResolvedValueOnce(okJson(quote));

    const req = {
      asset: 'USDC' as const,
      direction: 'to-rome' as const,
      sourceChain: 'ethereum',
      sourceChainId: 11155111,
      romeChainId: '200010',
      intent: 'gas' as const,
      amount: '1000000',
      sender: { ethereum: '0x3403e0De09Bc76Ca7d74762F264e4F6B649A0562' },
      recipient: '0x3403e0De09Bc76Ca7d74762F264e4F6B649A0562',
    };
    const got = await requestQuote(req);

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe(`${DEFAULT_BRIDGE_API_BASE}/v1/quote`);
    expect(init.method).toBe('POST');
    expect(init.headers['content-type']).toBe('application/json');
    expect(JSON.parse(init.body)).toEqual(req);
    expect(got).toEqual(quote);
  });

  it('maps a problem+json error body to BridgeApiError (code + detail + status)', async () => {
    fetchMock.mockResolvedValueOnce(okJson(
      { code: 'rome.bridge.sender-incomplete', title: 'Sender address incomplete', status: 400, detail: 'USDC CCTP inbound requires sender.ethereum' },
      400,
    ));
    const err = await requestQuote({
      asset: 'USDC', direction: 'to-rome', sourceChain: 'ethereum', romeChainId: '200010',
      amount: '1', sender: {}, recipient: '0x3403e0De09Bc76Ca7d74762F264e4F6B649A0562',
    }).then(() => null, (e: unknown) => e);
    expect(err).toBeInstanceOf(BridgeApiError);
    expect((err as BridgeApiError).code).toBe('rome.bridge.sender-incomplete');
    expect((err as BridgeApiError).status).toBe(400);
    expect((err as BridgeApiError).message).toMatch(/requires sender\.ethereum/);
  });

  it('throws BridgeApiError with a generic code on a non-JSON failure body', async () => {
    fetchMock.mockResolvedValueOnce(new Response('bad gateway', { status: 502 }));
    const err = await requestQuote({
      asset: 'ETH', direction: 'to-rome', sourceChain: 'ethereum', romeChainId: '200010',
      amount: '1', sender: { ethereum: '0x3403e0De09Bc76Ca7d74762F264e4F6B649A0562' }, recipient: '0x3403e0De09Bc76Ca7d74762F264e4F6B649A0562',
    }).then(() => null, (e: unknown) => e);
    expect(err).toBeInstanceOf(BridgeApiError);
    expect((err as BridgeApiError).status).toBe(502);
    expect((err as BridgeApiError).code).toBe('rome.bridge.http-error');
  });
});

describe('registerTransfer', () => {
  it('POSTs {quote, step1TxHash, userSettleSig} to /v1/transfers', async () => {
    const record = { id: 'txf_1', outcome: 'pending', steps: [] };
    fetchMock.mockResolvedValueOnce(okJson(record));
    const quote = { route: 'usdc-cctp-to-rome', direction: 'to-rome', steps: [{ n: 1 }] } as unknown as Quote;

    const got = await registerTransfer({ quote, step1TxHash: '0xabc', userSettleSig: '0xsig' });

    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe(`${DEFAULT_BRIDGE_API_BASE}/v1/transfers`);
    expect(init.method).toBe('POST');
    expect(JSON.parse(init.body)).toEqual({ quote, step1TxHash: '0xabc', userSettleSig: '0xsig' });
    expect(got).toEqual(record);
  });

  it('omits the userSettleSig key entirely when not provided (legacy/wormhole path)', async () => {
    fetchMock.mockResolvedValueOnce(okJson({ id: 'txf_2', outcome: 'pending', steps: [] }));
    const quote = { route: 'eth-wormhole-to-rome', direction: 'to-rome', steps: [{ n: 1 }] } as unknown as Quote;
    await registerTransfer({ quote, step1TxHash: '0xdef' });
    const body = JSON.parse(fetchMock.mock.calls[0]![1].body);
    expect(body).toEqual({ quote, step1TxHash: '0xdef' });
    expect('userSettleSig' in body).toBe(false);
  });
});

describe('getTransfer', () => {
  it('GETs /v1/transfers/:id (uri-encoded) and returns the record', async () => {
    const record = { id: 'txf 3', outcome: 'complete', steps: [{ n: 1, status: 'confirmed' }] };
    fetchMock.mockResolvedValueOnce(okJson(record));
    const got = await getTransfer('txf 3');
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe(`${DEFAULT_BRIDGE_API_BASE}/v1/transfers/txf%203`);
    expect(init?.method ?? 'GET').toBe('GET');
    expect(got).toEqual(record);
  });

  it('maps 404 to BridgeApiError source-tx-not-found', async () => {
    fetchMock.mockResolvedValueOnce(okJson(
      { code: 'rome.bridge.source-tx-not-found', title: 'not found', status: 404, detail: 'transfer nope not found' },
      404,
    ));
    const err = await getTransfer('nope').then(() => null, (e: unknown) => e);
    expect((err as BridgeApiError).code).toBe('rome.bridge.source-tx-not-found');
  });
});

describe('reportStep', () => {
  it('POSTs {txHash} to /v1/transfers/:id/steps/:n', async () => {
    const record = { id: 'txf_4', outcome: 'pending', steps: [{ n: 3, status: 'submitted' }] };
    fetchMock.mockResolvedValueOnce(okJson(record));
    const got = await reportStep('txf_4', 3, '0xclaim');
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe(`${DEFAULT_BRIDGE_API_BASE}/v1/transfers/txf_4/steps/3`);
    expect(init.method).toBe('POST');
    expect(JSON.parse(init.body)).toEqual({ txHash: '0xclaim' });
    expect(got).toEqual(record);
  });
});

describe('settleTypedDataWithBurn', () => {
  const quoteWithAuth = {
    route: 'usdc-cctp-to-rome', direction: 'to-rome', amountIn: '1', amountOut: '1', steps: [],
    signatureRequests: [{
      kind: 'settle-authorization-eip712',
      fillFromBurn: 'sourceTxHash',
      typedData: {
        domain: { name: 'RomeBridge', version: '1', chainId: 200010 },
        types: { SettleAuthorization: [{ name: 'sourceTxHash', type: 'bytes32' }] },
        primaryType: 'SettleAuthorization',
        message: {
          destinationChainId: '200010', mint: 'So11111111111111111111111111111111111111112',
          amount: '1', sourceChain: '11155111',
          sourceTxHash: '0x0000000000000000000000000000000000000000000000000000000000000000',
          deadline: '1790000000',
        },
      },
    }],
  } as unknown as Quote;

  it('returns a filled COPY (burn hash in message.sourceTxHash) and leaves the quote pristine', () => {
    const burn = '0x4d112a2c7382b637f1e1964619b4a70e27a2fd38ebb3d4a18514be2b63fcff25';
    const td = settleTypedDataWithBurn(quoteWithAuth, burn);
    expect(td).not.toBeNull();
    expect(td!.message.sourceTxHash).toBe(burn);
    // domain.chainId must stay NUMERIC over JSON (string → different viem
    // domain separator → on-chain SignerNotUser).
    expect(typeof td!.domain.chainId).toBe('number');
    // The quote object the caller will POST verbatim must NOT be mutated.
    expect(quoteWithAuth.signatureRequests![0]!.typedData.message.sourceTxHash)
      .toBe('0x0000000000000000000000000000000000000000000000000000000000000000');
  });

  it('returns null when the quote carries no settle authorization (wormhole / wrapper intent)', () => {
    const q = { route: 'eth-wormhole-to-rome', direction: 'to-rome', steps: [], signatureRequests: [] } as unknown as Quote;
    expect(settleTypedDataWithBurn(q, '0xabc')).toBeNull();
  });
});
