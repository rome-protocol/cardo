import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, it, expect } from 'vitest';

// Parse the act|see palette straight from the CSS module and assert the
// secondary-text tokens clear WCAG AA (4.5:1) on the surfaces they're used on.
// The operator reported dark-on-dark text; --faint was 2.5:1 (the offender).
const css = readFileSync(
  fileURLToPath(new URL('../components/design/actsee.module.css', import.meta.url)),
  'utf8',
);

function tokenHex(name: string): string {
  const m = css.match(new RegExp(`--${name}:\\s*(#[0-9a-fA-F]{6})`));
  if (!m) throw new Error(`palette token --${name} not found`);
  return m[1];
}
function relLum(hex: string): number {
  const ch = [1, 3, 5]
    .map((i) => parseInt(hex.slice(i, i + 2), 16) / 255)
    .map((x) => (x <= 0.03928 ? x / 12.92 : ((x + 0.055) / 1.055) ** 2.4));
  return 0.2126 * ch[0] + 0.7152 * ch[1] + 0.0722 * ch[2];
}
function contrast(a: string, b: string): number {
  const la = relLum(a);
  const lb = relLum(b);
  return (Math.max(la, lb) + 0.05) / (Math.min(la, lb) + 0.05);
}

describe('act|see palette — secondary text meets WCAG AA (4.5:1)', () => {
  const surfaces = ['ground-2', 'ground-3'] as const; // cards, and chips/inputs
  for (const tok of ['muted', 'faint'] as const) {
    for (const surf of surfaces) {
      it(`--${tok} on --${surf} >= 4.5:1`, () => {
        expect(contrast(tokenHex(tok), tokenHex(surf))).toBeGreaterThanOrEqual(4.5);
      });
    }
  }

  it('token picker does not dim its selected row into illegibility (no opacity:0.4 on :disabled rows)', () => {
    expect(/\.row:disabled[^}]*opacity:\s*0?\.4\b/.test(css)).toBe(false);
  });

  it('form controls reset color to inherit so the token chip is not UA-black on dark', () => {
    // <button>/<select> get color:buttontext (~black) from the UA sheet, which
    // does not inherit the shell's light --text → black-on-dark token chips.
    expect(/:where\([^)]*button[^)]*\)\s*\{[^}]*color:\s*inherit/.test(css)).toBe(true);
  });
});
