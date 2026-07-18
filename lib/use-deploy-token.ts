// useDeployToken — orchestrate the multi-tx flow that deploys a fresh
// SPL mint + ERC20-SPL wrapper from the user's EVM wallet, all the way
// through to having minted balance + a registered wrapper that the
// Cardo /pool/new picker can use.
//
// Five sequential txs (MetaMask popups), each through the canonical
// rome-solidity ERC20SPLFactory at 0x266c…574d:
//
//   1. create_user()             — registers the user in the factory's
//                                   shared ERC20Users registry. Skipped
//                                   when the caller already shows
//                                   `factoryRegistered=true`.
//   2. create_token_mint()       — creates the SPL mint account on
//                                   Solana (deterministic PDA via
//                                   creator+nonce). Returns the mint
//                                   pubkey; we predict it client-side
//                                   via get_current_mint() to wire
//                                   subsequent steps.
//   3. init_token_mint(mint)     — initializes the mint with
//                                   DEFAULT_DECIMALS=9 and the user's
//                                   PDA as authority.
//   4. add_spl_token_no_metadata — deploys the SPL_ERC20 wrapper.
//        (mint, name, symbol)      Symbol must be unique across the
//                                   factory (it reverts if taken).
//   5. wrapper.mint_to(user, n)  — mints `n` tokens to the user's PDA's
//                                   ATA. Requires the wrapper's
//                                   `_accounts[user]` to be set, which
//                                   happens when wrapper.ensure_token_account
//                                   is called for that user. Step 4
//                                   leaves it unset — so we squeeze in
//                                   a 5a step here:
//   5a. wrapper.ensure_token_account(user) — bind user's ATA to wrapper.
//
// Total wallet popups: 5 (or 6 for first-time users + ensure_token_account).
// Total gas: ~300M @ 11 gwei = ~3.3 mETH on Rome.
//
// On success, the new wrapper is persisted to localStorage so it
// appears in the picker across reloads (until the user clears storage
// or the factory enumeration eventually surfaces it on its own).

import { useCallback, useState } from 'react';
import { useRomeWrite } from './use-rome-write';
import {
  type Address,
  type Hex,
  decodeEventLog,
  parseAbi,
} from 'viem';
import { ROME_ADDRESSES } from '@/lib/addresses';

const FACTORY_ABI = parseAbi([
  'function create_user()',
  'function create_token_mint() returns (bytes32)',
  'function init_token_mint(bytes32 mint)',
  'function add_spl_token_no_metadata(bytes32 mint, string name, string symbol) returns (address)',
  'function get_current_mint(address user) view returns (bytes32, bytes32)',
  'function token_by_mint(bytes32) view returns (address)',
  'event TokenCreated(address indexed creator, bytes32 indexed mint, address indexed wrapper, string name, string symbol, uint64 nonce)',
]);

const WRAPPER_ABI = parseAbi([
  'function ensure_token_account(address user) returns (bytes32)',
  'function mint_to(address to, uint256 value) returns (bool)',
]);

export type DeployTokenPhase =
  | 'idle'
  | 'creating-user'
  | 'confirming-user'
  | 'creating-mint'
  | 'confirming-mint'
  | 'init-mint'
  | 'confirming-init'
  | 'deploying-wrapper'
  | 'confirming-wrapper'
  | 'binding-account'
  | 'confirming-binding'
  | 'minting-supply'
  | 'confirming-supply'
  | 'success'
  | 'failed';

export type DeployTokenState = {
  phase: DeployTokenPhase;
  symbol?: string;
  name?: string;
  mint?: string;
  wrapper?: string;
  hashes: Record<string, `0x${string}`>;
  error?: string;
};

const POLL_TIMEOUT_MS = 90_000;
const POLL_INTERVAL_MS = 2_000;

async function waitForReceipt(hash: `0x${string}`) {
  const start = Date.now();
  while (Date.now() - start < POLL_TIMEOUT_MS) {
    try {
      const res = await fetch('/api/rpc/rome', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          jsonrpc: '2.0', id: 1,
          method: 'eth_getTransactionReceipt',
          params: [hash],
        }),
      });
      const json = await res.json();
      if (json.result?.blockNumber) {
        return {
          status: json.result.status === '0x1' ? 'success' : 'reverted',
          logs: json.result.logs ?? [],
          transactionHash: json.result.transactionHash,
        };
      }
    } catch (e) {
      // eslint-disable-next-line no-console
      console.warn('[cardo deploy-token] receipt poll error', e);
    }
    await new Promise((r) => setTimeout(r, POLL_INTERVAL_MS));
  }
  throw new Error(`receipt poll timed out for ${hash}`);
}

/// Read the next-mint pubkey for a user from the factory. The mint is
/// deterministic from creator + nonce, so we can look it up before
/// calling create_token_mint.
async function readPredictedMint(userAddress: Address): Promise<Hex> {
  const res = await fetch('/api/rpc/rome', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      jsonrpc: '2.0', id: 1,
      method: 'eth_call',
      params: [
        {
          to: ROME_ADDRESSES.erc20SplFactoryCanonical,
          // get_current_mint(address) selector — keccak256("get_current_mint(address)")[0..4]
          // = 0x89ff651d. Encoded with the user address (32-byte padded).
          data: ('0x89ff651d' +
            '000000000000000000000000' +
            userAddress.slice(2).toLowerCase()) as Hex,
        },
        'latest',
      ],
    }),
  });
  const json = await res.json();
  if (!json.result) throw new Error(`get_current_mint read failed: ${JSON.stringify(json)}`);
  // Returns (bytes32 mint, bytes32 mintSeed) — mint is in the first 32 bytes.
  return ('0x' + json.result.slice(2, 66)) as Hex;
}

export function useDeployToken() {
  const [state, setState] = useState<DeployTokenState>({ phase: 'idle', hashes: {} });
  const { writeContractAsync } = useRomeWrite();

  const deploy = useCallback(
    async (opts: {
      userAddress: Address;
      symbol: string;
      name: string;
      mintAmountHuman: number;
      /// True when the user has already registered with the factory
      /// (any wrapper.balanceOf returned for them). Skips step 1.
      factoryRegistered: boolean;
    }) => {
      const factory = ROME_ADDRESSES.erc20SplFactoryCanonical as Address;
      const gasPrice = 11_000_000_000n;
      // Generous per-step gas — observed actuals: create_token_mint ~30M,
      // init_token_mint ~25M, add_spl_token_no_metadata ~134M,
      // ensure_token_account ~50M, mint_to ~30M. 200M gives headroom.
      const gas = 200_000_000n;

      const hashes: Record<string, `0x${string}`> = {};
      const update = (patch: Partial<DeployTokenState>) =>
        setState((prev) => ({ ...prev, ...patch, hashes: { ...prev.hashes, ...(patch.hashes ?? {}) } }));

      try {
        update({ phase: 'idle', symbol: opts.symbol, name: opts.name, error: undefined });

        // Step 1: create_user (skip when already registered)
        if (!opts.factoryRegistered) {
          update({ phase: 'creating-user' });
          const h1 = await writeContractAsync({
            address: factory, abi: FACTORY_ABI, functionName: 'create_user',
            type: 'legacy', gasPrice, gas: 10_000_000n,
          });
          update({ phase: 'confirming-user', hashes: { ...hashes, createUser: h1 } });
          const r1 = await waitForReceipt(h1);
          if (r1.status === 'reverted') throw new Error('create_user reverted');
        }

        // Step 2: create_token_mint
        update({ phase: 'creating-mint' });
        const predictedMint = await readPredictedMint(opts.userAddress);
        const h2 = await writeContractAsync({
          address: factory, abi: FACTORY_ABI, functionName: 'create_token_mint',
          type: 'legacy', gasPrice, gas,
        });
        update({ phase: 'confirming-mint', mint: predictedMint, hashes: { ...hashes, createMint: h2 } });
        const r2 = await waitForReceipt(h2);
        if (r2.status === 'reverted') throw new Error('create_token_mint reverted');

        // Step 3: init_token_mint
        update({ phase: 'init-mint' });
        const h3 = await writeContractAsync({
          address: factory, abi: FACTORY_ABI, functionName: 'init_token_mint',
          args: [predictedMint],
          type: 'legacy', gasPrice, gas,
        });
        update({ phase: 'confirming-init', hashes: { ...hashes, initMint: h3 } });
        const r3 = await waitForReceipt(h3);
        if (r3.status === 'reverted') throw new Error('init_token_mint reverted');

        // Step 4: add_spl_token_no_metadata
        update({ phase: 'deploying-wrapper' });
        const h4 = await writeContractAsync({
          address: factory, abi: FACTORY_ABI, functionName: 'add_spl_token_no_metadata',
          args: [predictedMint, opts.name, opts.symbol],
          type: 'legacy', gasPrice, gas,
        });
        update({ phase: 'confirming-wrapper', hashes: { ...hashes, deployWrapper: h4 } });
        const r4 = await waitForReceipt(h4);
        if (r4.status === 'reverted') throw new Error('add_spl_token_no_metadata reverted');

        // Read wrapper address from factory (TokenCreated event also
        // available in receipt logs but the mapping read is simplest).
        const wrapperRes = await fetch('/api/rpc/rome', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            jsonrpc: '2.0', id: 1, method: 'eth_call',
            params: [{
              to: factory,
              // token_by_mint(bytes32) selector = 0x2ef05768
              data: ('0x2ef05768' + predictedMint.slice(2)) as Hex,
            }, 'latest'],
          }),
        });
        const wrapperJson = await wrapperRes.json();
        const wrapper = ('0x' + (wrapperJson.result ?? '').slice(-40)) as Address;
        if (!/^0x[0-9a-fA-F]{40}$/.test(wrapper) || wrapper === '0x0000000000000000000000000000000000000000') {
          // Fall back to parsing TokenCreated from receipt logs
          const log = (r4.logs as Array<{ topics: string[]; data: string }>).find((l) => {
            try {
              const dec = decodeEventLog({ abi: FACTORY_ABI, topics: l.topics as [`0x${string}`, ...`0x${string}`[]], data: l.data as Hex });
              return dec.eventName === 'TokenCreated';
            } catch { return false; }
          });
          if (log) {
            const dec = decodeEventLog({ abi: FACTORY_ABI, topics: log.topics as [`0x${string}`, ...`0x${string}`[]], data: log.data as Hex });
            update({ wrapper: (dec.args as { wrapper: Address }).wrapper });
          } else {
            throw new Error('wrapper address not found via mapping or event');
          }
        } else {
          update({ wrapper });
        }

        // Step 5a: ensure_token_account on the new wrapper for the user
        const finalWrapper = ((wrapper && wrapper !== '0x0000000000000000000000000000000000000000') ? wrapper : (state.wrapper as Address)) as Address;
        update({ phase: 'binding-account' });
        const h5a = await writeContractAsync({
          address: finalWrapper, abi: WRAPPER_ABI, functionName: 'ensure_token_account',
          args: [opts.userAddress],
          type: 'legacy', gasPrice, gas,
        });
        update({ phase: 'confirming-binding', hashes: { ...hashes, ensureTokenAccount: h5a } });
        const r5a = await waitForReceipt(h5a);
        if (r5a.status === 'reverted') throw new Error('ensure_token_account reverted');

        // Step 5b: mint_to(user, amount)
        const decimals = 9; // factory's DEFAULT_DECIMALS
        const rawAmount =
          BigInt(Math.floor(opts.mintAmountHuman)) * 10n ** BigInt(decimals);
        update({ phase: 'minting-supply' });
        const h5 = await writeContractAsync({
          address: finalWrapper, abi: WRAPPER_ABI, functionName: 'mint_to',
          args: [opts.userAddress, rawAmount],
          type: 'legacy', gasPrice, gas,
        });
        update({ phase: 'confirming-supply', hashes: { ...hashes, mintTo: h5 } });
        const r5 = await waitForReceipt(h5);
        if (r5.status === 'reverted') throw new Error('mint_to reverted');

        update({ phase: 'success' });
      } catch (e) {
        const msg = (e as Error).message ?? String(e);
        update({ phase: 'failed', error: msg });
      }
    },
    [writeContractAsync, state.wrapper],
  );

  const reset = useCallback(() => setState({ phase: 'idle', hashes: {} }), []);

  return { state, deploy, reset };
}
