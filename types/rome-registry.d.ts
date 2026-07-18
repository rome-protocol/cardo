// Ambient types for the public @rome-protocol/registry package, which ships as
// plain ESM + JSON (no bundled .d.ts). Covers the API surface cardo uses.
declare module '@rome-protocol/registry' {
  export function getChain(chainId: number | string): any;
  export function listChains(): any[];
  export function getTokens(chainId: number | string): any;
  export function getContracts(chainId: number | string): any;
  export function getOracle(chainId: number | string): any;
  export function getBridge(chainId: number | string): any;
  export function getAlts(chainId: number | string): any;
  export function getPrograms(network: string): Record<string, string>;
  export function getLstMints(): Record<
    string,
    { mint: string; decimals: number; symbol?: string; [k: string]: unknown }
  >;
  export function getCompoundDeployment(chainId: number | string): any;
  export function getAaveDeployment(chainId: number | string): any;
}
