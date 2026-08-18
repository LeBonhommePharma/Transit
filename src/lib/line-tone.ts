/** Slight blue-family tone shift by line number / popularity. Official non-blue colors stay. */

export function parseHexColor(hex: unknown): { r: number; g: number; b: number } | null {
  if (typeof hex !== "string") return null;
  let raw = hex.trim().replace(/^#/, "");
  if (raw.length === 3) raw = raw.split("").map((c) => c + c).join("");
  if (!/^[0-9a-fA-F]{6}$/.test(raw)) return null;
  return {
    r: parseInt(raw.slice(0, 2), 16),
    g: parseInt(raw.slice(2, 4), 16),
    b: parseInt(raw.slice(4, 6), 16),
  };
}

function rgbToHsl(r: number, g: number, b: number): { h: number; s: number; l: number } {
  const R = r / 255;
  const G = g / 255;
  const B = b / 255;
  const max = Math.max(R, G, B);
  const min = Math.min(R, G, B);
  const l = (max + min) / 2;
  if (max === min) return { h: 0, s: 0, l };
  const d = max - min;
  const s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
  let h = 0;
  if (max === R) h = (G - B) / d + (G < B ? 6 : 0);
  else if (max === G) h = (B - R) / d + 2;
  else h = (R - G) / d + 4;
  return { h: h * 60, s, l };
}

function hslToHex(h: number, s: number, l: number): string {
  const hue = ((h % 360) + 360) % 360;
  const C = (1 - Math.abs(2 * l - 1)) * s;
  const X = C * (1 - Math.abs(((hue / 60) % 2) - 1));
  const m = l - C / 2;
  let r = 0;
  let g = 0;
  let b = 0;
  if (hue < 60) [r, g, b] = [C, X, 0];
  else if (hue < 120) [r, g, b] = [X, C, 0];
  else if (hue < 180) [r, g, b] = [0, C, X];
  else if (hue < 240) [r, g, b] = [0, X, C];
  else if (hue < 300) [r, g, b] = [X, 0, C];
  else [r, g, b] = [C, 0, X];
  const hex = (n: number) => Math.round((n + m) * 255).toString(16).padStart(2, "0");
  return `#${hex(r)}${hex(g)}${hex(b)}`;
}

function lineNumber(shortName: unknown): number {
  const n = parseInt(String(shortName ?? "").replace(/\D/g, ""), 10);
  return Number.isFinite(n) ? n : 0;
}

export function isBlueFamily(hex: string): boolean {
  const rgb = parseHexColor(hex);
  if (!rgb) return true;
  const { h, s } = rgbToHsl(rgb.r, rgb.g, rgb.b);
  if (s < 0.12) return true;
  return h >= 170 && h <= 265;
}

/** Official orange/green/etc. stay. Shared agency blues get a number-based teal tone. */
export function lineStrokeColor(route: { color?: string; shortName?: string; type?: number }): string {
  const official = typeof route.color === "string" && parseHexColor(route.color) ? route.color : "#0e7490";
  if (!isBlueFamily(official)) return official.startsWith("#") ? official : `#${official}`;
  const rgb = parseHexColor(official)!;
  const hsl = rgbToHsl(rgb.r, rgb.g, rgb.b);
  const num = lineNumber(route.shortName);
  const hueShift = ((num * 17) % 36) - 18;
  const popular = route.type === 1 || /^80/.test(String(route.shortName || "")) || (num > 0 && num < 20);
  const s = Math.min(0.72, Math.max(0.28, hsl.s + (popular ? 0.08 : -0.04)));
  const l = Math.min(0.58, Math.max(0.28, hsl.l + (popular ? -0.08 : 0.04) + ((num % 7) - 3) * 0.012));
  return hslToHex(hsl.h + hueShift, s, l);
}
