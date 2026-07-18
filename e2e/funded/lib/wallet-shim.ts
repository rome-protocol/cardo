// EIP-1193 wallet shim — synthetic `window.ethereum` for headless E2E.
// Lifted from the Rome web app's e2e/funded harness (same shape, kept in sync).
// Routes signing to a Node-side viem WalletClient via Playwright's
// exposeBinding; routes RPC reads to the chain HTTP endpoint from Node.
//
// Why a shim (vs Synpress / real MetaMask): sub-second signing, no
// extension state leak, no MM-version drift. It does NOT exercise the
// real MM connector code paths — that's a known, accepted gap.
//
// Inject via Playwright `context.addInitScript` + `exposeBinding` — see
// fixtures.ts. Chain-agnostic: the shim only knows the ShimChain[] it's
// handed; fixtures build those from lib/chain-config (registry-driven).

import {
  createWalletClient,
  http,
  createPublicClient,
  type Hex,
  type Address,
  type Chain,
} from 'viem';
import { privateKeyToAccount } from 'viem/accounts';

export type ShimChain = {
  id: number;
  name: string;
  rpcUrl: string;
  nativeCurrency: { name: string; symbol: string; decimals: number };
};

export type ShimState = {
  privateKey: Hex;
  address: Address;
  chains: ShimChain[];
  currentChainId: number;
};

export function makeShimHandler(state: ShimState) {
  const account = privateKeyToAccount(state.privateKey);

  function chainById(id: number): ShimChain {
    const c = state.chains.find((x) => x.id === id);
    if (!c) {
      throw new Error(
        `shim: unknown chain ${id}; configured: ${state.chains.map((x) => x.id).join(',')}`,
      );
    }
    return c;
  }

  function viemChain(id: number): Chain {
    const sc = chainById(id);
    return {
      id: sc.id,
      name: sc.name,
      nativeCurrency: sc.nativeCurrency,
      rpcUrls: { default: { http: [sc.rpcUrl] } },
    } as const;
  }

  function rpcFor(id: number) {
    const sc = chainById(id);
    return createPublicClient({ chain: viemChain(id), transport: http(sc.rpcUrl) });
  }

  function walletFor(id: number) {
    const sc = chainById(id);
    return createWalletClient({ account, chain: viemChain(id), transport: http(sc.rpcUrl) });
  }

  return async function dispatch(args: { method: string; params?: any }): Promise<unknown> {
    const { method, params } = args;
    const cid = state.currentChainId;

    switch (method) {
      case 'eth_chainId':
        return `0x${cid.toString(16)}`;

      case 'eth_accounts':
      case 'eth_requestAccounts':
        return [state.address];

      case 'net_version':
        return cid.toString();

      case 'wallet_switchEthereumChain': {
        const target = parseInt(params?.[0]?.chainId ?? '0x0', 16);
        chainById(target);
        state.currentChainId = target;
        return null;
      }

      case 'wallet_addEthereumChain':
        return null;

      case 'wallet_watchAsset':
        return true;

      case 'eth_sendTransaction': {
        const tx = params?.[0] ?? {};
        const wallet = walletFor(cid);
        // Forward the dapp's explicit fee fields verbatim so the funded path
        // signs EXACTLY what rome-fee.ts set (legacy gasPrice floored to the
        // Rome min + estimateGas×factor). Without this, viem would re-derive
        // gasPrice from eth_gasPrice and the test wouldn't exercise the real
        // production fee path — the whole point of validating the gas model.
        const hash = await wallet.sendTransaction({
          to: tx.to as Address | undefined,
          data: tx.data as Hex | undefined,
          value: tx.value ? BigInt(tx.value) : undefined,
          gas: tx.gas ? BigInt(tx.gas) : undefined,
          gasPrice: tx.gasPrice ? BigInt(tx.gasPrice) : undefined,
          nonce: tx.nonce != null ? Number(tx.nonce) : undefined,
        });
        return hash;
      }

      case 'eth_signTypedData_v4': {
        const typed = JSON.parse(params?.[1]);
        return await account.signTypedData({
          domain: typed.domain,
          types: typed.types,
          primaryType: typed.primaryType,
          message: typed.message,
        });
      }

      case 'personal_sign': {
        const msg = params?.[0] as Hex;
        return await account.signMessage({ message: { raw: msg } });
      }

      case 'eth_blockNumber':
      case 'eth_getBalance':
      case 'eth_getCode':
      case 'eth_call':
      case 'eth_estimateGas':
      case 'eth_getTransactionByHash':
      case 'eth_getTransactionReceipt':
      case 'eth_getTransactionCount':
      case 'eth_gasPrice':
      case 'eth_feeHistory':
      case 'eth_maxPriorityFeePerGas':
      case 'eth_getBlockByNumber':
      case 'eth_getBlockByHash':
      case 'eth_getLogs': {
        const client = rpcFor(cid);
        return await client.request({ method: method as any, params: params as any });
      }

      default:
        throw new Error(`shim: unsupported method ${method}`);
    }
  };
}

export const SHIM_INIT_SCRIPT = `
(() => {
  if (window.ethereum && window.ethereum.__romeE2EShim) return;

  const listeners = { chainChanged: [], accountsChanged: [], connect: [], disconnect: [] };

  const provider = {
    isMetaMask: true,
    isRomeE2EShim: true,
    __romeE2EShim: true,
    chainId: '0x1',
    networkVersion: '1',
    selectedAddress: null,
    request: async (args) => {
      const result = await window.__romeE2ESign(args);
      if (args.method === 'eth_requestAccounts' || args.method === 'eth_accounts') {
        provider.selectedAddress = Array.isArray(result) ? result[0] : null;
      }
      if (args.method === 'eth_chainId') {
        provider.chainId = result;
        provider.networkVersion = String(parseInt(result, 16));
      }
      return result;
    },
    on: (event, listener) => { if (listeners[event]) listeners[event].push(listener); },
    removeListener: (event, listener) => {
      if (listeners[event]) listeners[event] = listeners[event].filter((l) => l !== listener);
    },
    enable: async () => provider.request({ method: 'eth_requestAccounts' }),
  };

  window.__romeE2EEmit = (event, payload) => {
    if (!listeners[event]) return;
    for (const l of listeners[event]) { try { l(payload); } catch (e) { console.warn('shim listener threw', e); } }
  };

  const announce = () => {
    const detail = Object.freeze({
      info: { uuid: 'rome-e2e-shim', name: 'Rome E2E Shim', icon: 'data:image/svg+xml;base64,', rdns: 'xyz.rome.e2e-shim' },
      provider,
    });
    window.dispatchEvent(new CustomEvent('eip6963:announceProvider', { detail }));
  };
  window.addEventListener('eip6963:requestProvider', announce);
  announce();

  Object.defineProperty(window, 'ethereum', { value: provider, writable: false, configurable: false });
})();
`;
