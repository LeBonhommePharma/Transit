export function haversineMeters(
  a: { lon: number; lat: number },
  b: { lon: number; lat: number },
): number {
  const R = 6371000;
  const dLat = ((b.lat - a.lat) * Math.PI) / 180;
  const dLon = ((b.lon - a.lon) * Math.PI) / 180;
  const la1 = (a.lat * Math.PI) / 180;
  const la2 = (b.lat * Math.PI) / 180;
  const s =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(la1) * Math.cos(la2) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.min(1, Math.sqrt(s)));
}

/** Apple-style pitch: 0 is nadir, 1 is ~55°. */
export function applyPitch(
  px: number,
  py: number,
  w: number,
  h: number,
  pitch: number,
): { x: number; y: number; scale: number } {
  if (!Number.isFinite(pitch) || pitch <= 0) return { x: px, y: py, scale: 1 };
  const p = Math.min(1, Math.max(0, pitch));
  const horizon = h * (0.16 + (1 - p) * 0.1);
  const ground = h * 0.94;
  const t = (py - horizon) / Math.max(1, ground - horizon);
  const persp = 0.52 + Math.max(0, Math.min(1.4, t)) * (0.48 + p * 0.4);
  return {
    x: w / 2 + (px - w / 2) * persp,
    y: horizon + (py - horizon) * (1 - p * 0.44),
    scale: persp,
  };
}

export function walkMinutes(meters: number): number {
  return Math.max(1, Math.round(meters / 75));
}

/** Display meters to the tenth. Non-finite → empty. */
export function formatMeters(meters: number): string {
  if (!Number.isFinite(meters)) return "";
  return `${(Math.round(meters * 10) / 10).toFixed(1)} m`;
}

export function decodePolyline(encoded: string, precision = 5): [number, number][] {
  if (!encoded) return [];
  const factor = 10 ** precision;
  const coords: [number, number][] = [];
  let index = 0;
  let lat = 0;
  let lng = 0;
  while (index < encoded.length) {
    let result = 0;
    let shift = 0;
    let b: number;
    do {
      b = encoded.charCodeAt(index++) - 63;
      result |= (b & 0x1f) << shift;
      shift += 5;
    } while (b >= 0x20);
    lat += result & 1 ? ~(result >> 1) : result >> 1;
    result = 0;
    shift = 0;
    do {
      b = encoded.charCodeAt(index++) - 63;
      result |= (b & 0x1f) << shift;
      shift += 5;
    } while (b >= 0x20);
    lng += result & 1 ? ~(result >> 1) : result >> 1;
    coords.push([lng / factor, lat / factor]);
  }
  return coords;
}

export function lineSlice(
  coords: [number, number][],
  from: { lon: number; lat: number },
  to: { lon: number; lat: number },
): [number, number][] {
  if (coords.length < 2) return coords;
  let i0 = 0;
  let i1 = coords.length - 1;
  let d0 = Infinity;
  let d1 = Infinity;
  for (let i = 0; i < coords.length; i++) {
    const [lon, lat] = coords[i];
    const a = haversineMeters({ lon, lat }, from);
    const b = haversineMeters({ lon, lat }, to);
    if (a < d0) {
      d0 = a;
      i0 = i;
    }
    if (b < d1) {
      d1 = b;
      i1 = i;
    }
  }
  if (i0 === i1) return [coords[i0], [to.lon, to.lat]];
  if (i0 < i1) return coords.slice(i0, i1 + 1);
  return coords.slice(i1, i0 + 1).reverse();
}
