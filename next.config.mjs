import { withSentryConfig } from "@sentry/nextjs";

/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  // Standalone output bundles only the files next needs to run, so the Docker
  // image can omit node_modules and the source tree.
  output: "standalone",
  env: {
    NEXT_PUBLIC_API_BASE_URL: process.env.NEXT_PUBLIC_API_BASE_URL ?? "http://localhost:8080",
    NEXT_PUBLIC_USE_FIXTURES: process.env.NEXT_PUBLIC_USE_FIXTURES ?? "true",
  },
  webpack: (config, { webpack }) => {
    // Wallet stack hygiene (mirrors the Rome web app's next.config). The WalletConnect
    // connector pulls Node-only modules (fs/net/tls) that don't exist in the
    // browser bundle, plus pino's OPTIONAL `pino-pretty` transport — webpack
    // warns "Can't resolve …" on all of them. They're never used client-side,
    // so stub them out: the build stays clean instead of spamming warnings.
    config.resolve = config.resolve || {};
    config.resolve.fallback = {
      ...(config.resolve.fallback || {}),
      fs: false,
      net: false,
      tls: false,
    };
    config.resolve.alias = {
      ...(config.resolve.alias || {}),
      "pino-pretty": false,
    };
    // `@coinbase/cdp-sdk` (pulled transitively: wagmi → @wagmi/connectors →
    // @base-org/account → @coinbase/cdp-sdk) lazily `import()`s `@x402/*`
    // payment packages that it does NOT declare as dependencies, so they're
    // never installed and webpack hard-fails resolving the dynamic imports
    // ("Module not found: @x402/evm/exact/client", …). Cardo never uses the
    // x402 pay-per-request flow, so ignore the whole namespace — same posture
    // as pino-pretty above. (Same lockfile built green on 2026-07-15; the
    // optional-dep resolution went bad registry-side, so this makes the build
    // deterministic rather than chasing the transitive version.)
    config.plugins.push(
      new webpack.IgnorePlugin({ resourceRegExp: /^@x402\// }),
    );
    return config;
  },
};

// Sentry sourcemap upload + client/server/edge init wiring. Auth token only
// required at build time (CI sets SENTRY_AUTH_TOKEN); local dev runs without
// it. Runtime DSN is NEXT_PUBLIC_SENTRY_DSN.
export default withSentryConfig(nextConfig, {
  silent: !process.env.SENTRY_AUTH_TOKEN,
  org: process.env.SENTRY_ORG,
  project: process.env.SENTRY_PROJECT,
  authToken: process.env.SENTRY_AUTH_TOKEN,
  disableLogger: true,
});
