# act|see — Cardo's design system

**This is Cardo's design. There is no other.** Every dapp surface uses it. The old
light "V3 / Rome-brand" design (light `primitives.jsx` atoms, the legacy `Nav`/`Footer`,
`tx-flow.jsx` light modals) is **retired** — see the guardrail at the bottom before you
add or change any screen.

## The idea

Cross-VM execution is confusing: a user signs an EVM transaction and *something
happens on Solana*. act|see makes that legible by splitting every screen in two:

```
┌────────────────────────────┬────────────────────────────┐
│  You do this               │  What will happen           │
│  (the form — amount,       │  (the LIVE signature ledger │
│   token, side, slippage)   │   + the honest outcome)     │
└────────────────────────────┴────────────────────────────┘
```

The right column shows the **true number of MetaMask signatures** the action takes
(computed from real on-chain account state, not a guess) and the honest result —
including when devnet liquidity/wiring is thin (no fake fills, no invented APYs).

## What's in this folder

| File | Role |
|---|---|
| `actsee.module.css` | The scoped dark design system — all tokens + every rig/header/ledger class. The **only** stylesheet act\|see screens import. |
| `DesignShell.tsx` | The dark chrome: two-level nav (action categories + per-category venue sub-bar), header **chain switcher** (`ChainSwitcher`), wallet button, network banner. Wraps every redesigned route. |
| `Ledger.tsx` | Presentational signature ledger (count + ordered steps) used inside the rig's right column. |
| `ViaLink.tsx` | Settled-tx link → the chain's Via explorer (`explorerTxUrl`, registry-driven). |

(The richer, probe-driven ledger is `components/SignatureLedger.tsx`, driven by
`lib/signature-plan.ts` + `lib/signature-plan-live.ts`.)

## Palette (tokens live on `.shell` in `actsee.module.css`)

| Token | Hex | Use |
|---|---|---|
| `--ground` | `#16181E` | basalt — page ground |
| `--ground-2` / `--ground-3` | `#1C1F27` / `#232733` | raised surfaces, menus, inputs |
| `--accent` | `#C79A4B` | aureus — primary action, active nav |
| `--verd` / `--verd-bright` | `#4E8C84` / `#6FB8AE` | verdigris — success / confirmations |
| `--line` | `#2C303A` | hairlines, borders |
| `--text` / `--muted` / `--faint` | — / `#9A968B` / `#5C5A52` | text hierarchy |
| `--mono` | SF Mono / JetBrains Mono | all labels, numbers, addresses |

Spend boldness in one place (the accent on the primary action + the signature count);
keep everything else quiet. Serif display for headlines, mono for everything functional.

## Building a screen

1. `components/screens/<Page>.jsx`, `'use client'`, `import s from '../design/actsee.module.css'`.
2. Lay out the rig: `<main className={s.work}>` → `s.strip` (eyebrow + headline + route pill)
   → `s.rig` containing two `s.col`s: `s.act` (the form) and `s.see` (the ledger + outcome).
3. Right column: render the signature ledger (`<Ledger>` or the `SignatureLedger` +
   `signaturePlan(flow, accountState)`), then the `s.outcome` block, then `s.status`.
4. Register the route in `app/Shell.tsx`'s `REDESIGNED` set so it renders inside `DesignShell`.
5. Read the active chain with `useActiveChainId()` (runtime), never the build-default.

Mirror an existing screen (`Swap.jsx`, `MangoLend.jsx`, `Perps.jsx`) — match its rig
structure, class names, and honesty (gate the CTA when a flow isn't wired; no fake state).

## CSS rules

- **Scoped CSS Module, always.** The dark palette must not leak into the app's light
  surfaces and global CSS must not leak in. Never move act\|see styles to a global sheet.
- Tokens are defined once on `.shell` (the ancestor `DesignShell` renders). Derive every
  color from the tokens above — don't hardcode hexes in screens.
- Watch selector specificity vs. globally-loaded `.rome-type` styles (e.g. `.shell .lead h1`
  exists specifically to beat a global `h1` rule). Lay groups out with flex/grid + `gap`.

## ⛔ Guardrail — do not let the old design back in

The light "V3" design is gone on purpose. When adding or editing a dapp surface:

- **Do** build it as an act\|see rig styled from `actsee.module.css`, inside `DesignShell`.
- **Don't** import the light atoms (`Roman`, `Eyebrow`, `Button`, `Modal`) or `Nav`/`Footer`
  from `primitives.jsx`, add light-theme cards, or use `tx-flow.jsx` light modals.
- `primitives.jsx` stays **only** for shared `fmtNum`/`fmtUSD` helpers and the handful of
  not-yet-migrated legacy routes (`/pool`, `/vote`, `/swap-orca`,
  `/for-agents`, `/test-index`, `/tx/[hash]`). Those are a **migration
  backlog to convert to act\|see** — never a template to copy.
- A route is act\|see iff it's in `app/Shell.tsx`'s `REDESIGNED` set. New surface →
  add it there.
