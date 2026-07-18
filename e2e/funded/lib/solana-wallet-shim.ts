// Headless Solana wallet shim — a synthetic Wallet-Standard wallet for the
// Solana-wallet lane (/perps → Jupiter Perps mainnet), the counterpart to the
// EVM `wallet-shim.ts`. Registers a wallet via the Wallet Standard events the
// adapter listens for (`wallet-standard:register-wallet` / `app-ready`), so
// `@solana/wallet-adapter-react` picks it up and shows it in the modal — no
// real extension, no popup. Signing routes to a Node-side keypair via
// Playwright `exposeBinding`; the browser only shuttles base64 tx bytes.
//
// Why a shim (vs a real extension): sub-second signing, no extension state,
// no version drift. It does NOT exercise Phantom/Solflare connector code —
// same accepted gap as the EVM shim.

import { Keypair, Transaction, VersionedTransaction } from '@solana/web3.js';

export type SolanaShimState = { secretKey: Uint8Array };

/// Node-side dispatch: connect returns the pubkey; signTransaction signs the
/// serialized tx bytes with the keypair (v0 or legacy) and returns them.
export function makeSolanaShimHandler(state: SolanaShimState) {
  const kp = Keypair.fromSecretKey(state.secretKey);
  return async function dispatch(args: { method: string; params?: any }): Promise<unknown> {
    switch (args.method) {
      case 'connect':
        return {
          address: kp.publicKey.toBase58(),
          publicKeyB64: Buffer.from(kp.publicKey.toBytes()).toString('base64'),
        };

      case 'signTransaction': {
        const bytes = Buffer.from(String(args.params?.txB64 ?? ''), 'base64');
        // v0 first (perp txs are v0); fall back to legacy.
        try {
          const tx = VersionedTransaction.deserialize(bytes);
          tx.sign([kp]);
          return { signedB64: Buffer.from(tx.serialize()).toString('base64') };
        } catch {
          const tx = Transaction.from(bytes);
          tx.partialSign(kp);
          return { signedB64: tx.serialize({ requireAllSignatures: false }).toString('base64') };
        }
      }

      default:
        throw new Error(`solana shim: unsupported method ${args.method}`);
    }
  };
}

// A 1×1 transparent SVG data URI — the Wallet Standard requires a data: icon.
const SHIM_ICON =
  'data:image/svg+xml;base64,PHN2ZyB4bWxucz0iaHR0cDovL3d3dy53My5vcmcvMjAwMC9zdmciIHdpZHRoPSIxIiBoZWlnaHQ9IjEiLz4=';

/// Browser init script: define a Wallet-Standard wallet whose features call
/// back into Node (`window.__romeSolSign`), and register it the way the
/// adapter expects. Injected via `context.addInitScript`.
export const SOLANA_SHIM_INIT_SCRIPT = `
(() => {
  if (window.__romeSolShimRegistered) return;
  window.__romeSolShimRegistered = true;

  const CHAIN = 'solana:mainnet';
  const b64ToBytes = (b64) => Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
  const bytesToB64 = (bytes) => {
    let s = '';
    const arr = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
    for (let i = 0; i < arr.length; i++) s += String.fromCharCode(arr[i]);
    return btoa(s);
  };

  const listeners = { change: [] };
  const emit = (event, payload) => {
    for (const l of (listeners[event] || [])) { try { l(payload); } catch (e) { /* noop */ } };
  };

  const wallet = {
    version: '1.0.0',
    name: 'Rome E2E Solana',
    icon: '${SHIM_ICON}',
    chains: [CHAIN],
    accounts: [],
    features: {
      'standard:connect': {
        version: '1.0.0',
        connect: async () => {
          const res = await window.__romeSolSign({ method: 'connect' });
          const account = {
            address: res.address,
            publicKey: b64ToBytes(res.publicKeyB64),
            chains: [CHAIN],
            features: ['solana:signTransaction'],
            label: 'Rome E2E Solana',
          };
          wallet.accounts = [account];
          emit('change', { accounts: wallet.accounts });
          return { accounts: wallet.accounts };
        },
      },
      'standard:disconnect': {
        version: '1.0.0',
        disconnect: async () => {
          wallet.accounts = [];
          emit('change', { accounts: wallet.accounts });
        },
      },
      'standard:events': {
        version: '1.0.0',
        on: (event, listener) => {
          (listeners[event] = listeners[event] || []).push(listener);
          return () => { listeners[event] = (listeners[event] || []).filter((l) => l !== listener); };
        },
      },
      'solana:signTransaction': {
        version: '1.0.0',
        supportedTransactionVersions: ['legacy', 0],
        signTransaction: async (...inputs) => {
          const out = [];
          for (const input of inputs) {
            const res = await window.__romeSolSign({ method: 'signTransaction', params: { txB64: bytesToB64(input.transaction) } });
            out.push({ signedTransaction: b64ToBytes(res.signedB64) });
          }
          return out;
        },
      },
    },
  };

  // Wallet Standard registration handshake (mirrors @wallet-standard/wallet).
  const callback = (api) => { try { api.register(wallet); } catch (e) { /* noop */ } };
  try {
    window.dispatchEvent(new CustomEvent('wallet-standard:register-wallet', { detail: callback }));
  } catch (e) { /* noop */ }
  try {
    window.addEventListener('wallet-standard:app-ready', (e) => callback(e.detail));
  } catch (e) { /* noop */ }
})();
`;
