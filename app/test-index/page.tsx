// Test-index route `/test-index` — single landing page that lists every
// integration on this branch, classified by app and per-functionality, so
// the smoke-tester can click straight to any flow without typing a URL.
// Updated whenever a new adapter or extension ix ships.
//
// Status legend per functionality:
//   on-chain      — real Solana sig recorded.
//   eth_call      — wire-complete through Rome emulator (rome_emulateTx
//                   returns 0x); not yet a signed-tx sig.
//   pending       — typecheck + harness pass; needs MetaMask click + sign.
//   blocked       — known external blocker (see note); don't smoke yet.
//   sibling       — exists in another PR's branch only; not on this dev
//                   server.
//
// To add a new functionality: append to its app's `functionalities[]`. To
// add a brand-new app: append a new object to `apps[]`.

import Link from 'next/link';

export const metadata = {
  title: 'Test index — Cardo',
  description: 'Every Cardo integration route, classified by app and functionality.',
};

type Status = 'on-chain' | 'eth_call' | 'pending' | 'blocked' | 'sibling';

type Functionality = {
  label: string;
  ix: string;
  status: Status;
  note?: string;
};

type App = {
  name: string;
  route: string | null; // null = sibling-branch (not reachable here)
  source: string; // PR / branch where this lives
  blurb: string;
  functionalities: Functionality[];
};

// ---- Apps available in feat-cardo-extensions (this dev server) ----
const apps: App[] = [
  {
    name: 'Raydium CPMM',
    route: '/swap-raydium',
    source: 'PR #43 (merged into #51) + #51 ext',
    blurb: 'Constant-product AMM (USDC ↔ WSOL).',
    functionalities: [
      {
        label: 'Swap (exact-input)',
        ix: 'swap_base_input',
        status: 'on-chain',
        note: 'sig 2zGqpVJ7…1uKrkti slot 458151442 (devnet) — only Cardo ix proven on-chain to date',
      },
      {
        label: 'Swap (exact-output)',
        ix: 'swap_base_output',
        status: 'pending',
      },
      {
        label: 'Add liquidity',
        ix: 'deposit',
        status: 'pending',
      },
      {
        label: 'Remove liquidity',
        ix: 'withdraw',
        status: 'pending',
      },
    ],
  },
  {
    name: 'Meteora DAMM v1',
    route: '/swap',
    source: 'main',
    blurb: 'Dynamic AMM v1 swap.',
    functionalities: [
      { label: 'Swap', ix: 'swap', status: 'pending' },
    ],
  },
  {
    name: 'Meteora DAMM v2',
    route: '/swap-meteora-v2',
    source: 'main + PR #51 ext',
    blurb: 'Dynamic AMM v2 swap + concentrated LP.',
    functionalities: [
      { label: 'Swap', ix: 'swap', status: 'pending' },
      { label: 'Add liquidity', ix: 'add_liquidity', status: 'pending' },
      {
        label: 'Remove liquidity',
        ix: 'remove_liquidity',
        status: 'pending',
        note: '13 accts incl. pool_authority',
      },
    ],
  },
  {
    name: 'Orca Whirlpool',
    route: '/swap-orca',
    source: 'main + PR #51 ext',
    blurb: 'Whirlpool concentrated-liquidity swap.',
    functionalities: [
      { label: 'Swap (classic)', ix: 'swap', status: 'pending' },
      {
        label: 'Swap v2 (Token-2022)',
        ix: 'swap_v2',
        status: 'pending',
        note: '15 accts; supports T22 mints',
      },
    ],
  },
  {
    name: 'PumpSwap (Token-2022)',
    route: '/swap-pumpswap',
    source: 'main + PR #51 ext',
    blurb: 'pump.fun follow-on AMM (T22 mints).',
    functionalities: [
      { label: 'Swap', ix: 'buy / sell', status: 'pending' },
      { label: 'Add liquidity', ix: 'deposit', status: 'pending' },
      {
        label: 'Remove liquidity',
        ix: 'withdraw',
        status: 'pending',
        note: 'Token-2022 program slot mandatory',
      },
    ],
  },
  {
    name: 'pump.fun (bonding curve)',
    route: '/swap-pumpfun',
    source: 'main',
    blurb: 'Bonding-curve buy/sell.',
    functionalities: [
      { label: 'Buy', ix: 'buy', status: 'pending' },
      { label: 'Sell', ix: 'sell', status: 'pending' },
    ],
  },
  {
    name: 'Mango v4',
    route: '/lend-mango',
    source: 'main + PR #51 ext (5 ix)',
    blurb: 'Mango v4 spot lend/borrow + token-conditional swaps.',
    functionalities: [
      { label: 'Create account', ix: 'account_create', status: 'pending' },
      { label: 'Deposit', ix: 'token_deposit', status: 'pending' },
      { label: 'Withdraw', ix: 'token_withdraw', status: 'pending' },
      {
        label: 'Close account',
        ix: 'account_close',
        status: 'pending',
        note: 'PR #51',
      },
      {
        label: 'Edit account (name / delegate)',
        ix: 'account_edit',
        status: 'pending',
        note: 'PR #51',
      },
      {
        label: 'Expand account (slot counts)',
        ix: 'account_expand',
        status: 'pending',
        note: 'PR #51',
      },
      {
        label: 'Create token-conditional swap',
        ix: 'token_conditional_swap_create',
        status: 'pending',
        note: 'PR #51',
      },
      {
        label: 'Cancel token-conditional swap',
        ix: 'token_conditional_swap_cancel',
        status: 'pending',
        note: 'PR #51',
      },
    ],
  },
  {
    name: 'Drift Spot',
    route: '/lend-drift',
    source: 'main',
    blurb: 'Drift v2 spot deposit/withdraw.',
    functionalities: [
      { label: 'Init user', ix: 'init_user', status: 'blocked', note: 'Mollusk Custom(6087) on funded ATA — owner/slot probe needed' },
      { label: 'Deposit', ix: 'deposit', status: 'blocked', note: 'gated on init_user' },
      { label: 'Withdraw', ix: 'withdraw', status: 'blocked', note: 'gated on init_user' },
    ],
  },
  {
    name: 'Kamino Lend (klend v2)',
    route: '/lend',
    source: 'main + this batch (test cases)',
    blurb: 'Kamino lend v2 — supply / borrow / repay against KLend reserves on Rome.',
    functionalities: [
      {
        label: 'Init user metadata',
        ix: 'init_user_metadata',
        status: 'pending',
        note: 'one-time per user; harness PASS',
      },
      {
        label: 'Init obligation',
        ix: 'init_obligation',
        status: 'pending',
        note: 'Vanilla obligation per (user, market); harness PASS',
      },
      {
        label: 'Deposit',
        ix: 'deposit_reserve_liquidity_and_obligation_collateral',
        status: 'pending',
        note: 'harness PASS',
      },
      {
        label: 'Withdraw',
        ix: 'withdraw_obligation_collateral_and_redeem_reserve_liquidity_v2',
        status: 'pending',
        note: 'harness PASS',
      },
      {
        label: 'Borrow',
        ix: 'borrow_obligation_liquidity_v2',
        status: 'pending',
        note: 'harness PASS',
      },
      {
        label: 'Repay',
        ix: 'repay_obligation_liquidity_v2',
        status: 'pending',
        note: 'harness PASS',
      },
    ],
  },
  {
    name: 'SPL stake-pool',
    route: '/stake',

    source: 'main + PR #51 ext (slippage variants)',
    blurb: 'Solana SPL stake-pool — JitoSOL / bSOL / etc.',
    functionalities: [
      { label: 'Deposit SOL', ix: 'DepositSol', status: 'pending' },
      { label: 'Withdraw SOL', ix: 'WithdrawSol', status: 'pending' },
      {
        label: 'Deposit SOL (slippage-protected)',
        ix: 'DepositSolWithSlippage',
        status: 'pending',
        note: 'PR #51',
      },
      {
        label: 'Withdraw SOL (slippage-protected)',
        ix: 'WithdrawSolWithSlippage',
        status: 'pending',
        note: 'PR #51',
      },
    ],
  },
  {
    name: 'Streamflow',
    route: '/pay',
    source: 'main + PR #51 ext (4 ix)',
    blurb: 'Token streaming, vesting, payments.',
    functionalities: [
      { label: 'Create stream', ix: 'create_v2', status: 'pending' },
      { label: 'Withdraw from stream', ix: 'withdraw', status: 'pending' },
      {
        label: 'Cancel stream',
        ix: 'cancel',
        status: 'pending',
        note: 'PR #51',
      },
      {
        label: 'Top up stream',
        ix: 'topup',
        status: 'pending',
        note: 'PR #51',
      },
      {
        label: 'Update stream metadata',
        ix: 'update',
        status: 'pending',
        note: 'PR #51',
      },
      {
        label: 'Transfer recipient',
        ix: 'transfer_recipient',
        status: 'pending',
        note: 'PR #51',
      },
    ],
  },
  {
    name: 'SPL Token',
    route: '/send',
    source: 'main + PR #51 ext (6 ix)',
    blurb: 'Token program — transfer + lifecycle ix.',
    functionalities: [
      { label: 'Transfer (checked)', ix: 'transfer_checked', status: 'pending' },
      { label: 'Approve delegate', ix: 'approve', status: 'pending', note: 'PR #51' },
      { label: 'Revoke delegate', ix: 'revoke', status: 'pending', note: 'PR #51' },
      { label: 'Burn', ix: 'burn', status: 'pending', note: 'PR #51' },
      { label: 'Close account', ix: 'close_account', status: 'pending', note: 'PR #51' },
      { label: 'Sync native (WSOL)', ix: 'sync_native', status: 'pending', note: 'PR #51' },
      { label: 'Set authority', ix: 'set_authority', status: 'pending', note: 'PR #51' },
    ],
  },
  // ---- Design-only / Cardo-internal routes ----
  {
    name: 'Drift Perps (design)',
    route: '/perps',
    source: 'main',
    blurb: 'UI scaffold — no live ix yet.',
    functionalities: [
      { label: 'Open position (design)', ix: 'n/a', status: 'pending' },
    ],
  },
  {
    name: 'Pool inventory (design)',
    route: '/pool',
    source: 'main',
    blurb: 'Cross-protocol LP overview — no live ix.',
    functionalities: [
      { label: 'View / route to LP screens', ix: 'n/a', status: 'pending' },
    ],
  },
  {
    name: 'Compose (multi-dapp atomic)',
    route: '/compose',
    source: 'main',
    blurb: 'Flagship — bundle ix from multiple dapps.',
    functionalities: [
      { label: 'Compose flow (design)', ix: 'n/a', status: 'pending' },
    ],
  },
  {
    name: 'Tx viewer',
    route: '/tx',
    source: 'main',
    blurb: 'Inspect a Cardo tx by hash.',
    functionalities: [
      { label: 'Tx detail UI', ix: 'n/a', status: 'pending' },
    ],
  },
];

// ---- Sibling-branch apps (exist in another PR — check out the branch to smoke) ----
const siblingApps: App[] = [
  {
    name: 'Raydium CLMM',
    route: null,
    source: 'feat-cardo-raydium-clmm (PR #46)',
    blurb: 'Concentrated-liquidity AMM — eth_call 0x SUCCESS, awaits MetaMask smoke.',
    functionalities: [
      { label: 'Swap v2', ix: 'swap_v2', status: 'eth_call' },
    ],
  },
  {
    name: 'Phoenix CLOB',
    route: null,
    source: 'feat-cardo-phoenix (PR #50)',
    blurb: 'Order-book DEX (bootstrap-funded market) — eth_call 0x SUCCESS.',
    functionalities: [
      { label: 'Market swap', ix: 'Swap', status: 'eth_call' },
    ],
  },
  {
    name: 'SPL Governance (Realms)',
    route: null,
    source: 'feat-cardo-realms-vote (PR #44)',
    blurb: 'On-chain DAO governance — castVote.',
    functionalities: [
      {
        label: 'Cast vote',
        ix: 'castVote',
        status: 'blocked',
        note: 'TOR-creation gap; user needs an existing Token Owner Record',
      },
    ],
  },
  {
    name: 'Marinade',
    route: null,
    source: 'feat-cardo-marinade (PR #45)',
    blurb: 'Liquid staking — Deposit SOL → mSOL.',
    functionalities: [
      {
        label: 'Deposit',
        ix: 'Deposit',
        status: 'blocked',
        note: 'devnet mSOL mint-authority defect (3JLPCS1q…)',
      },
    ],
  },
  {
    name: 'Meteora DLMM',
    route: null,
    source: 'feat-cardo-dlmm (PR #47)',
    blurb: 'Dynamic LMM swap.',
    functionalities: [
      {
        label: 'Swap',
        ix: 'swap',
        status: 'blocked',
        note: '__event_authority strict-mode preflight (rolled back; redeploy pending)',
      },
    ],
  },
  {
    name: 'Raydium AMM v4',
    route: null,
    source: 'feat-cardo-raydium-amm (PR #49)',
    blurb: 'Legacy AMM — Serum-paired.',
    functionalities: [
      {
        label: 'Swap',
        ix: 'swap',
        status: 'blocked',
        note: 'serum_vault_signer strict-mode preflight (rolled back; redeploy pending)',
      },
    ],
  },
];

const STATUS_LABEL: Record<Status, string> = {
  'on-chain': 'on-chain proven',
  eth_call: 'eth_call 0x',
  pending: 'smoke pending',
  blocked: 'blocked',
  sibling: 'sibling branch',
};

const STATUS_COLOR: Record<Status, string> = {
  'on-chain': '#1f7a3a',
  eth_call: '#1f7a3a',
  pending: '#7a5a1f',
  blocked: '#cf522e',
  sibling: '#5a5a5a',
};

function StatusPill({ status }: { status: Status }) {
  return (
    <span
      className="tiny mono"
      style={{
        textTransform: 'uppercase',
        letterSpacing: '0.08em',
        color: STATUS_COLOR[status],
        border: `1px solid ${STATUS_COLOR[status]}`,
        padding: '2px 8px',
        borderRadius: 4,
        whiteSpace: 'nowrap',
      }}
    >
      {STATUS_LABEL[status]}
    </span>
  );
}

function AppCard({ app }: { app: App }) {
  const reachable = app.route !== null;
  return (
    <div
      className="card"
      style={{
        padding: 20,
        marginBottom: 16,
      }}
    >
      <div
        style={{
          display: 'flex',
          alignItems: 'baseline',
          justifyContent: 'space-between',
          gap: 16,
          flexWrap: 'wrap',
          marginBottom: 8,
        }}
      >
        <div>
          <h3 style={{ margin: 0, fontSize: 18 }}>{app.name}</h3>
          <div
            className="tiny mono"
            style={{ color: 'var(--fg2)', marginTop: 2 }}
          >
            {app.source}
          </div>
        </div>
        <div style={{ textAlign: 'right' }}>
          {reachable ? (
            <Link
              href={app.route as string}
              className="mono"
              style={{
                fontSize: 13,
                color: 'var(--fg)',
                textDecoration: 'underline',
              }}
            >
              open {app.route}
            </Link>
          ) : (
            <span
              className="tiny mono"
              style={{ color: 'var(--fg2)', fontStyle: 'italic' }}
            >
              not on this branch
            </span>
          )}
        </div>
      </div>
      <p
        className="small"
        style={{ color: 'var(--fg2)', margin: '0 0 14px' }}
      >
        {app.blurb}
      </p>
      <div
        style={{
          borderTop: '1px solid rgba(0,0,0,0.08)',
          paddingTop: 12,
          display: 'grid',
          gap: 6,
        }}
      >
        {app.functionalities.map((f) => (
          <FunctionalityRow
            key={f.label + f.ix}
            functionality={f}
            route={app.route}
          />
        ))}
      </div>
    </div>
  );
}

function FunctionalityRow({
  functionality: f,
  route,
}: {
  functionality: Functionality;
  route: string | null;
}) {
  const clickable = route !== null;
  return (
    <div
      style={{
        display: 'grid',
        gridTemplateColumns: '1fr auto',
        alignItems: 'center',
        gap: 16,
        padding: '8px 0',
      }}
    >
      <div>
        {clickable ? (
          <Link
            href={route as string}
            style={{
              fontSize: 14,
              color: 'var(--fg)',
              textDecoration: 'none',
            }}
          >
            <span style={{ fontWeight: 500 }}>{f.label}</span>
            <span
              className="mono"
              style={{ color: 'var(--fg2)', marginLeft: 10, fontSize: 12 }}
            >
              {f.ix}
            </span>
          </Link>
        ) : (
          <span style={{ fontSize: 14, color: 'var(--fg2)' }}>
            <span style={{ fontWeight: 500 }}>{f.label}</span>
            <span
              className="mono"
              style={{ marginLeft: 10, fontSize: 12 }}
            >
              {f.ix}
            </span>
          </span>
        )}
        {f.note && (
          <div
            className="tiny"
            style={{
              color: 'var(--fg2)',
              marginTop: 2,
              fontStyle: 'italic',
            }}
          >
            {f.note}
          </div>
        )}
      </div>
      <StatusPill status={f.status} />
    </div>
  );
}

export default function TestIndexPage() {
  const totalIx = apps.reduce((n, a) => n + a.functionalities.length, 0);
  const proven = apps
    .flatMap((a) => a.functionalities)
    .filter((f) => f.status === 'on-chain').length;
  const ethCallSuccess = [...apps, ...siblingApps]
    .flatMap((a) => a.functionalities)
    .filter((f) => f.status === 'eth_call').length;

  return (
    <main
      className="container"
      style={{ padding: '32px 32px 96px', maxWidth: 1100 }}
    >
      <div
        className="tiny"
        style={{
          textTransform: 'uppercase',
          letterSpacing: '0.12em',
          color: 'var(--fg2)',
          marginBottom: 8,
        }}
      >
        cardo / test index
      </div>
      <h1 style={{ fontSize: 32, margin: '0 0 8px' }}>
        Integration smoke test routes
      </h1>
      <p
        className="small"
        style={{ color: 'var(--fg2)', maxWidth: 720, marginTop: 0 }}
      >
        Every Cardo integration on this branch (
        <span className="mono">feat-cardo-extensions</span>), grouped by app.
        Each functionality below is a single instruction you can fire from
        the route&rsquo;s UI cards. Click an app or a row to open the route.
      </p>
      <p
        className="tiny"
        style={{ color: 'var(--fg2)', marginBottom: 24 }}
      >
        Source of truth: <span className="mono">app/test-index/page.tsx</span>.
        Append to <span className="mono">apps[].functionalities</span> when a
        new ix ships.
      </p>

      <div
        className="card"
        style={{
          padding: 16,
          marginBottom: 32,
          display: 'grid',
          gridTemplateColumns: 'repeat(4, 1fr)',
          gap: 16,
        }}
      >
        <Stat label="Apps on this branch" value={apps.length.toString()} />
        <Stat label="Total functionalities" value={totalIx.toString()} />
        <Stat
          label="On-chain proven"
          value={proven.toString()}
          accent="#1f7a3a"
        />
        <Stat
          label="eth_call 0x success"
          value={ethCallSuccess.toString()}
          accent="#1f7a3a"
        />
      </div>

      <h2
        className="mono"
        style={{
          fontSize: 14,
          textTransform: 'uppercase',
          letterSpacing: '0.12em',
          color: 'var(--fg2)',
          margin: '0 0 12px',
        }}
      >
        Apps on this branch
      </h2>
      {apps.map((app) => (
        <AppCard key={app.name} app={app} />
      ))}

      <h2
        className="mono"
        style={{
          fontSize: 14,
          textTransform: 'uppercase',
          letterSpacing: '0.12em',
          color: 'var(--fg2)',
          margin: '36px 0 4px',
        }}
      >
        Sibling-branch apps
      </h2>
      <p
        className="small"
        style={{ color: 'var(--fg2)', margin: '0 0 12px' }}
      >
        These exist in another PR&rsquo;s branch only — the dev server here
        won&rsquo;t serve them. Check out the named branch to smoke.
      </p>
      {siblingApps.map((app) => (
        <AppCard key={app.name} app={app} />
      ))}
    </main>
  );
}

function Stat({
  label,
  value,
  accent,
}: {
  label: string;
  value: string;
  accent?: string;
}) {
  return (
    <div>
      <div
        className="tiny"
        style={{
          textTransform: 'uppercase',
          letterSpacing: '0.12em',
          color: 'var(--fg2)',
        }}
      >
        {label}
      </div>
      <div
        style={{
          fontSize: 28,
          fontWeight: 600,
          marginTop: 4,
          color: accent || 'var(--fg)',
        }}
      >
        {value}
      </div>
    </div>
  );
}
