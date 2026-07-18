// 500 / runtime error boundary. V3 designer delivery does not include a
// ServerError component (V1 shipped one via OtherScreens.jsx, since
// removed). Fallback uses designer tokens so it fits visually; designer
// can replace in a later drop.

'use client';

import * as Sentry from '@sentry/nextjs';
import { useEffect } from 'react';
import { Eyebrow } from '@/components/primitives';

export default function GlobalError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  useEffect(() => {
    Sentry.captureException(error);
    console.error(error);
  }, [error]);

  return (
    <main className="container" style={{ padding: '80px 32px 120px', maxWidth: 720 }}>
      <Eyebrow>500 · something broke</Eyebrow>
      <h1 className="h1" style={{ marginTop: 14 }}>
        Cardo <em>hit an error.</em>
      </h1>
      <p className="lede" style={{ marginTop: 18, maxWidth: 520 }}>
        The portal caught a runtime exception on this route. You can retry the render —
        nothing was signed or settled.
      </p>
      {error?.digest && (
        <p className="mono" style={{ marginTop: 18, fontSize: 12, color: 'var(--fg3)' }}>
          digest: {error.digest}
        </p>
      )}
      <div className="row" style={{ gap: 10, marginTop: 28 }}>
        <button className="btn btn-primary btn-lg" onClick={reset}>
          Retry
        </button>
      </div>
    </main>
  );
}
