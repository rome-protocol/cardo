// Pure registry-JSON → RomeChainConfig resolution. Shared by
// `lib/chain-config.ts` (builds the app's CHAINS map from the committed
// `chain-config.generated.json`) and `scripts/build-chain-config.ts` (the
// generator, which uses `resolve` to validate every chain it emits).
//
// Leaf module — types + functions only, no JSON imports, so the generator can
// import it without pulling in the generated file it is about to write.

import type { Address } from 'viem';

// ─── Registry JSON shapes (subset Cardo consumes) ───────────────────────

export type RegistryChain = {
  chainId: number;
  name: string;
  network: string; // 'devnet' | 'testnet'
  status: string; // 'live' | 'preparing' | 'retired' | ...
  rpcUrl: string;
  explorerUrl: string;
  nativeCurrency: { name: string; symbol: string; decimals: number };
  romeEvmProgramId: string;
};

export type RegistryToken = {
  address: string;
  mintId: string;
  symbol: string;
  name: string;
  decimals: number;
  kind: string; // 'gas' | 'spl_wrapper'
  track?: string; // 'cached' on chains that record it
  gasPool?: string;
};

export type ContractVersion = { address: string; version: string; status: string };
export type RegistryContract = { name: string; versions: ContractVersion[] };
export type OracleFeed = { address: string; source: string; underlyingAccount?: string };
export type RegistryOracle = { factory: string; feeds: Record<string, OracleFeed> };

// Registry bridge.json shape (subset). Two inbound assets, two protocols:
// USDC via CCTP, ETH via Wormhole. The `solana` block carries only
// `cctpDomain`; the SPL mints live per-asset (assets[].solanaMint).
export type RegistryBridge = {
  sourceEvm: {
    chainId: number;
    name: string;
    rpcUrl: string;
    explorerUrl: string;
    cctpTokenMessenger: string;
    cctpMessageTransmitter: string;
    wormholeTokenBridge: string;
    wormholeCoreBridge?: string;
    wormholeChainId?: number;
  };
  cctpIrisApiBase: string;
  wormholescanBaseUrl?: string;
  solana: { cctpDomain: number };
  assets: {
    id: string;
    symbol: string;
    name: string;
    decimals: number;
    solanaMint: string;
    sourceEvm: { address: string; protocol: string };
  }[];
};

// ─── Generated projection (lib/chain-config.generated.json) ─────────────

/// One chain's verbatim registry inputs, as emitted by
/// scripts/build-chain-config.ts. `bridge` is null on chains without a
/// bridge.json (JSON has no undefined).
export type GeneratedChainEntry = {
  slug: string;
  chain: RegistryChain;
  tokens: RegistryToken[];
  contracts: RegistryContract[];
  oracle: RegistryOracle;
  bridge: RegistryBridge | null;
};

// ─── Resolved per-chain config ──────────────────────────────────────────

/// One inbound bridge asset (a picker entry). `protocol` decides the flow:
/// 'cctp' → useInboundCctpSend (2 sigs), 'wormhole' → useInboundWhSend (1 sig).
export type BridgeAsset = {
  id: string;
  symbol: string;
  name: string;
  decimals: number;
  protocol: 'cctp' | 'wormhole';
  /// SPL mint on Solana the bridged asset lands as (drives recipient-ATA derivation).
  solanaMint: string;
  /// Token contract on the source EVM chain (Sepolia).
  sourceEvmAddress: Address;
};

/// Flat inbound-bridge config the client hooks read. Synthesized from the
/// registry bridge.json per-asset list (mirrors the Rome web app's normalizeBridge):
/// sourceEvm.usdc + solana.{usdcMint,wethMint} come from `assets[]`;
/// `solana.wormholeChainId` is the Wormhole-Solana constant (not in registry).
export type BridgeConfig = {
  sourceEvm: {
    chainId: number;
    name: string;
    rpcUrl: string;
    explorerUrl: string;
    cctpTokenMessenger: Address;
    wormholeTokenBridge: Address;
    usdc: Address;
  };
  solana: {
    cctpDomain: number;
    usdcMint: string;
    wethMint: string;
    wormholeChainId: number;
  };
  cctpIrisApiBase: string;
  wormholescanBaseUrl?: string;
  /// Rome-side outbound burn contract (Rome → Sepolia): burnUSDC (CCTP) +
  /// approveBurnETH/burnETH (Wormhole). From registry contracts.json.
  romeBridgeWithdraw: Address;
  assets: BridgeAsset[];
};

export type RomeChainConfig = {
  id: number;
  name: string;
  network: string;
  rpcUrl: string;
  explorerUrl: string;
  nativeCurrency: { name: string; symbol: string; decimals: number };
  romeEvmProgramId: string;
  tokens: RegistryToken[];
  /// chain_mint_id — the SPL mint backing native gas (gas token's mintId).
  chainMintId: string;
  /// canonical SPL wrappers keyed by Cardo's legacy field names.
  wrappers: { wUsdc: Address; wEth: Address; wWsol: Address };
  /// ERC20-SPL factory (live version).
  erc20SplFactory: Address;
  /// Oracle Gateway V2 per-feed adapter addresses (Chainlink-compat).
  oracles: {
    solUsd: Address;
    ethUsd: Address;
    usdcUsd: Address;
    btcUsd: Address;
    usdtUsd: Address;
  };
  /// Inbound bridge wiring from registry bridge.json: USDC→CCTP +
  /// ETH→Wormhole. Undefined on chains without a bridge config.
  bridge?: BridgeConfig;
};

/// Resolve the `live` version of a named contract; falls back to the
/// first entry if none is explicitly marked live (registry invariant is
/// exactly one live, but don't hard-crash a read if the flag is missing).
function liveContract(contracts: RegistryContract[], name: string): Address {
  const c = contracts.find((x) => x.name === name);
  if (!c || c.versions.length === 0) {
    throw new Error(`chain-config: contract ${name} not found in registry`);
  }
  const live = c.versions.find((v) => v.status === 'live') ?? c.versions[0];
  return live.address as Address;
}

function wrapperBySymbol(tokens: RegistryToken[], symbol: string): Address {
  const t = tokens.find(
    (x) => x.kind === 'spl_wrapper' && x.symbol.toLowerCase() === symbol.toLowerCase(),
  );
  if (!t) throw new Error(`chain-config: wrapper ${symbol} not in registry tokens`);
  return t.address as Address;
}

function gasMintId(tokens: RegistryToken[]): string {
  const gas = tokens.find((x) => x.kind === 'gas');
  if (!gas) throw new Error('chain-config: no gas token in registry tokens');
  return gas.mintId;
}

function oracleFeed(o: RegistryOracle, key: string): Address {
  return (o.feeds[key]?.address ?? '0x0000000000000000000000000000000000000000') as Address;
}

/// Wormhole's canonical chain id for the Solana destination — a protocol
/// constant (Solana = 1), NOT chain-specific. The registry bridge.json carries
/// cctpDomain but not this; we set it here (mirrors the Rome web app's bridge-overlay).
/// Used as `recipientChain` in wrapAndTransferETH.
const SOLANA_WORMHOLE_CHAIN_ID = 1;

/// Resolve registry bridge.json → Cardo's flat BridgeConfig (the shape the
/// inbound hooks read). Synthesizes the flat fields the Rome web app's normalizeBridge
/// builds: sourceEvm.usdc + solana.{usdcMint,wethMint} from the per-asset list,
/// wormholeChainId from the constant above. Client needs only source-EVM
/// contracts + mints + domains; the Solana-side CCTP/WH program ids are the
/// backend's concern (Option B reuses the Rome web app's relayer).
function resolveBridge(b: RegistryBridge, romeBridgeWithdraw: Address): BridgeConfig {
  const usdcAsset =
    b.assets.find((a) => a.id === 'usdc') ??
    b.assets.find((a) => a.sourceEvm.protocol === 'cctp');
  if (!usdcAsset) throw new Error('chain-config: bridge.json has no CCTP/usdc asset');
  const ethAsset =
    b.assets.find((a) => a.id === 'eth') ??
    b.assets.find((a) => a.sourceEvm.protocol === 'wormhole');
  return {
    sourceEvm: {
      chainId: b.sourceEvm.chainId,
      name: b.sourceEvm.name,
      rpcUrl: b.sourceEvm.rpcUrl,
      explorerUrl: b.sourceEvm.explorerUrl,
      cctpTokenMessenger: b.sourceEvm.cctpTokenMessenger as Address,
      wormholeTokenBridge: b.sourceEvm.wormholeTokenBridge as Address,
      usdc: usdcAsset.sourceEvm.address as Address,
    },
    solana: {
      cctpDomain: b.solana.cctpDomain,
      usdcMint: usdcAsset.solanaMint,
      wethMint: ethAsset?.solanaMint ?? '',
      wormholeChainId: SOLANA_WORMHOLE_CHAIN_ID,
    },
    cctpIrisApiBase: b.cctpIrisApiBase,
    wormholescanBaseUrl: b.wormholescanBaseUrl,
    romeBridgeWithdraw,
    assets: b.assets.map((a) => ({
      id: a.id,
      symbol: a.symbol,
      name: a.name,
      decimals: a.decimals,
      protocol: a.sourceEvm.protocol === 'wormhole' ? 'wormhole' : 'cctp',
      solanaMint: a.solanaMint,
      sourceEvmAddress: a.sourceEvm.address as Address,
    })),
  };
}

export function resolve(
  chain: RegistryChain,
  tokens: RegistryToken[],
  contracts: RegistryContract[],
  oracle: RegistryOracle,
  bridge?: RegistryBridge,
): RomeChainConfig {
  return {
    id: chain.chainId,
    name: chain.name,
    network: chain.network,
    rpcUrl: chain.rpcUrl,
    explorerUrl: chain.explorerUrl,
    nativeCurrency: chain.nativeCurrency,
    romeEvmProgramId: chain.romeEvmProgramId,
    tokens,
    chainMintId: gasMintId(tokens),
    wrappers: {
      wUsdc: wrapperBySymbol(tokens, 'wUSDC'),
      wEth: wrapperBySymbol(tokens, 'wETH'),
      wWsol: wrapperBySymbol(tokens, 'wSOL'),
    },
    erc20SplFactory: liveContract(contracts, 'ERC20SPLFactory'),
    oracles: {
      solUsd: oracleFeed(oracle, 'SOL/USD'),
      ethUsd: oracleFeed(oracle, 'ETH/USD'),
      usdcUsd: oracleFeed(oracle, 'USDC/USD'),
      btcUsd: oracleFeed(oracle, 'BTC/USD'),
      usdtUsd: oracleFeed(oracle, 'USDT/USD'),
    },
    bridge: bridge ? resolveBridge(bridge, liveContract(contracts, 'RomeBridgeWithdraw')) : undefined,
  };
}
