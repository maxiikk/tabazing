// The accent colour (Settings -> Accent colour). One CSS variable, --accent, that every accent in the
// stylesheets uses (tints and see-through versions come from it with color-mix()), plus the colour for
// text and icons drawn on it, chosen so they stay readable whatever the accent is.
export const DEFAULT_ACCENT = '#7DD3FC';
export const ACCENTS = ['#7DD3FC', '#5EEAD4', '#86EFAC', '#FCD34D', '#FDBA74', '#FCA5A5', '#F9A8D4', '#C4B5FD'];
export const isAccent = (v) => typeof v === 'string' && /^#[0-9a-f]{6}$/i.test(v);

// Relative luminance (WCAG) of a #rrggbb colour.
function luminance(hex) {
  const [r, g, b] = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255)
    .map((v) => (v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4));
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

export function applyAccent(hex, root = document.documentElement) {
  const c = isAccent(hex) ? hex.toUpperCase() : DEFAULT_ACCENT;
  // Dark ink or white on it, whichever has more contrast (the ink #1B2A4A has a luminance of about 0.022).
  const L = luminance(c);
  const light = (L + 0.05) / (0.022 + 0.05) >= 1.05 / (L + 0.05);
  root.style.setProperty('--accent', c);
  root.style.setProperty('--on-accent', light ? '#1B2A4A' : '#fff');
  root.style.setProperty('--on-accent-ink', light ? '#000' : '#fff');
  return c;
}
