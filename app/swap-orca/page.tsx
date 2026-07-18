import { redirect } from 'next/navigation';

// `/swap-orca` was the legacy (light-design) Orca Whirlpool screen — retired.
// The act|see `/orca` route is the canonical Orca Whirlpool swap (same WSOL/USDC
// devnet pool) and is funded-test-verified. Redirect here so the one Orca
// surface is the migrated one; no duplicate light-design screen.
export default function Page() {
  redirect('/orca');
}
