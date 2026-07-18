// Minimal 404 screen. V3 designer delivery does not include a NotFound
// component (V1 shipped one via OtherScreens.jsx, since removed). This
// wrapper renders a simple fallback that borrows designer tokens
// (.container / .h1 / .lede / .btn) so it visually fits the rest of
// the portal. Lives in `app/` rather than `components/screens/` because
// it's not authored by the designer — if they deliver a NotFound in a
// later drop, this moves into `components/screens/` like the others.

'use client';

import { useRouter } from 'next/navigation';
import { Eyebrow } from '@/components/primitives';

export default function NotFoundClient() {
  const router = useRouter();
  return (
    <main className="container" style={{ padding: '80px 32px 120px', maxWidth: 720 }}>
      <Eyebrow>404 · not found</Eyebrow>
      <h1 className="h1" style={{ marginTop: 14 }}>
        Nothing lives at <em>this path.</em>
      </h1>
      <p className="lede" style={{ marginTop: 18, maxWidth: 520 }}>
        Cardo v1 ships four routes: <span className="mono">/swap</span>,{' '}
        <span className="mono">/lend</span>, <span className="mono">/perps</span>, and{' '}
        <span className="mono">/compose</span>. Head home to pick one.
      </p>
      <div className="row" style={{ gap: 10, marginTop: 28 }}>
        <button className="btn btn-primary btn-lg" onClick={() => router.push('/')}>
          Go home
        </button>
        <button className="btn btn-ghost btn-lg" onClick={() => router.push('/compose')}>
          Try Compose
        </button>
      </div>
    </main>
  );
}
