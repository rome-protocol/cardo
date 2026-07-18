// Root layout. The designer owns all styling.
// Tokens + app styles live in public/assets and are referenced here as
// static stylesheets so rome-tokens.css keeps its relative font URLs
// intact (fonts/Georgia-Regular.otf resolves to /assets/fonts/...).
// Shell (client) wraps each route with the designer's Nav + Footer so
// the layout matches the shell their app.jsx produced.

import type { Metadata, Viewport } from "next";
import Shell from "./Shell";
import { Providers } from "./providers";

export const metadata: Metadata = {
  title: "Cardo",
  description: "Apps built on Rome. Use them, or build with them.",
};

export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" data-palette="purple">
      <head>
        <link rel="stylesheet" href="/assets/rome-tokens.css" />
        <link rel="stylesheet" href="/assets/app.css" />
        <link rel="stylesheet" href="/assets/token-types.css" />
      </head>
      <body className="rome-type">
        <Providers>
          <Shell>{children}</Shell>
        </Providers>
      </body>
    </html>
  );
}
