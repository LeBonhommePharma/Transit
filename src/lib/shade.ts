/** Map-space light from a celestial body + device heading, and Lambert shade. */

export type Vec3 = { x: number; y: number; z: number };

export const SHADE_AMBIENT = 0.22;

function finiteVec(v: unknown): Vec3 | null {
  if (!v || typeof v !== "object") return null;
  const row = v as { x?: unknown; y?: unknown; z?: unknown };
  const x = Number(row.x);
  const y = Number(row.y);
  const z = Number(row.z);
  if (!Number.isFinite(x) || !Number.isFinite(y) || !Number.isFinite(z)) return null;
  return { x, y, z };
}

function finiteHeading(heading: unknown): number | null {
  if (typeof heading !== "number" || !Number.isFinite(heading) || heading < 0) return null;
  return ((heading % 360) + 360) % 360;
}

function unitFromAzAlt(azimuth: number, altitude: number): Vec3 | null {
  if (!Number.isFinite(azimuth) || !Number.isFinite(altitude)) return null;
  const alt = (altitude * Math.PI) / 180;
  const az = (azimuth * Math.PI) / 180;
  const c = Math.cos(alt);
  return { x: Math.sin(az) * c, y: Math.cos(az) * c, z: Math.sin(alt) };
}

/** ENU unit vector toward the body: +x east, +y north, +z up. */
export function worldLightVector(azimuth: unknown, altitude: unknown): Vec3 | null {
  if (typeof azimuth !== "number" || typeof altitude !== "number") return null;
  return unitFromAzAlt(azimuth, altitude);
}

/**
 * Screen-space light on a north-up map (no compass sample).
 * +x right (east), +y down (south), +z up. Does not invent a heading.
 */
export function screenLightVector(azimuth: unknown, altitude: unknown): Vec3 | null {
  const world = worldLightVector(azimuth, altitude);
  if (!world) return null;
  return { x: world.x, y: -world.y, z: world.z };
}

/**
 * Screen-space light rotated by compass heading (degrees, 0=N).
 * Missing/junk heading → null (does not invent north).
 * Heading 0 vs 180 reverses the x component for a side light.
 */
export function mapLightDirection(azimuth: unknown, altitude: unknown, heading: unknown): Vec3 | null {
  if (typeof azimuth !== "number" || typeof altitude !== "number") return null;
  const h = finiteHeading(heading);
  if (h == null) return null;
  const v = unitFromAzAlt(azimuth - h, altitude);
  if (!v) return null;
  return { x: v.x, y: -v.y, z: v.z };
}

/** Lambert term in [ambient, 1]. Away-facing walls stay darker. Junk → 0. */
export function shadeFactor(light: unknown, normal: unknown): number {
  const L = finiteVec(light);
  const N = finiteVec(normal);
  if (!L || !N) return 0;
  const ln = Math.hypot(L.x, L.y, L.z);
  const nn = Math.hypot(N.x, N.y, N.z);
  if (!(ln > 0) || !(nn > 0)) return 0;
  const d = (L.x * N.x + L.y * N.y + L.z * N.z) / (ln * nn);
  return SHADE_AMBIENT + (1 - SHADE_AMBIENT) * Math.max(0, d);
}

export function shadeMany(light: unknown, normals: Array<unknown>): number[] {
  if (!Array.isArray(normals)) return [];
  return normals.map((n) => shadeFactor(light, n));
}

/** Outward 2D wall normal in the same frame as the points (screen or map). */
export function wallOutwardNormal(
  a: unknown,
  b: unknown,
  cx: unknown,
  cy: unknown,
): Vec3 | null {
  if (!Array.isArray(a) || !Array.isArray(b) || a.length < 2 || b.length < 2) return null;
  const ax = Number(a[0]);
  const ay = Number(a[1]);
  const bx = Number(b[0]);
  const by = Number(b[1]);
  const ox = Number(cx);
  const oy = Number(cy);
  if (![ax, ay, bx, by, ox, oy].every(Number.isFinite)) return null;
  const dx = bx - ax;
  const dy = by - ay;
  if (dx === 0 && dy === 0) return null;
  let nx = dy;
  let ny = -dx;
  const mx = (ax + bx) / 2;
  const my = (ay + by) / 2;
  if (nx * (ox - mx) + ny * (oy - my) > 0) {
    nx = -nx;
    ny = -ny;
  }
  const len = Math.hypot(nx, ny);
  if (!(len > 0)) return null;
  return { x: nx / len, y: ny / len, z: 0 };
}

export function mixHex(dark: unknown, lit: unknown, t: unknown): string {
  const parse = (h: unknown): [number, number, number] | null => {
    if (typeof h !== "string") return null;
    const m = /^#?([0-9a-fA-F]{6})$/.exec(h.trim());
    if (!m) return null;
    const n = parseInt(m[1], 16);
    return [n >> 16, (n >> 8) & 255, n & 255];
  };
  const a = parse(dark);
  const b = parse(lit);
  if (!a || !b) return typeof lit === "string" ? lit : "#000000";
  const u = typeof t === "number" && Number.isFinite(t) ? Math.min(1, Math.max(0, t)) : 0;
  const ch = (i: number) => Math.round(a[i] + (b[i] - a[i]) * u);
  return `#${[ch(0), ch(1), ch(2)].map((n) => n.toString(16).padStart(2, "0")).join("")}`;
}

/** Prefer heading-rotated map light; otherwise north-up screen light from the body. */
export function lightVectorForMap(
  azimuth: unknown,
  altitude: unknown,
  heading: unknown,
): Vec3 | null {
  const mapped = mapLightDirection(azimuth, altitude, heading);
  if (mapped) return mapped;
  return screenLightVector(azimuth, altitude);
}
