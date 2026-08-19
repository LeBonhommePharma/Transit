/** Minutes until the next published depart. Empty / garbage → null, never throws. */

export function remainMinutes(departs: unknown, now: number): number | null {
  if (!Number.isFinite(now)) return null;
  const list = Array.isArray(departs) ? departs.slice(0, 16) : [];
  let best: number | null = null;
  for (const raw of list) {
    let t = typeof raw === "number" ? raw : Number(raw);
    if (!Number.isFinite(t)) continue;
    if (t < now - 90) t += 1440;
    const wait = t - now;
    if (wait < 0) continue;
    if (best == null || wait < best) best = wait;
  }
  return best;
}

export type WatchPulse = {
  stop?: string;
  route?: string;
  color?: string;
  clocks?: string[];
  departs?: unknown[];
};

const MAX_WATCH_PAYLOAD_CHARS = 16 * 1024;
const MAX_WATCH_TEXT_LENGTH = 160;
const MAX_WATCH_ITEMS = 8;

function watchText(value: unknown): string {
  return typeof value === "string" ? value.slice(0, MAX_WATCH_TEXT_LENGTH) : "";
}

function watchColor(value: unknown): string {
  const color = watchText(value);
  return /^#[0-9a-f]{3,8}$/i.test(color) ? color : "#ffffff";
}

export function watchPulseFromPayload(payload: unknown): WatchPulse | null {
  if (payload == null) return null;
  if (typeof payload === "string") {
    const trimmed = payload.trim();
    if (!trimmed || trimmed.length > MAX_WATCH_PAYLOAD_CHARS) return null;
    try {
      return watchPulseFromPayload(JSON.parse(trimmed));
    } catch {
      return null;
    }
  }
  if (typeof payload !== "object") return null;
  const row = payload as Record<string, unknown>;
  const stop = watchText(typeof row.stop === "string" ? row.stop : row.s);
  const route = watchText(typeof row.route === "string" ? row.route : row.r);
  const color = watchColor(typeof row.color === "string" ? row.color : row.k);
  const clocksRaw = row.clocks ?? row.t;
  const departsRaw = row.departs ?? row.m;
  const clocks = Array.isArray(clocksRaw)
    ? clocksRaw.filter((item): item is string => typeof item === "string").slice(0, MAX_WATCH_ITEMS).map(watchText)
    : typeof clocksRaw === "string"
      ? clocksRaw.slice(0, 1024).split(",").filter(Boolean).slice(0, MAX_WATCH_ITEMS).map(watchText)
      : [];
  const departs = Array.isArray(departsRaw)
    ? departsRaw.slice(0, MAX_WATCH_ITEMS)
    : typeof departsRaw === "string"
      ? departsRaw.slice(0, 1024).split(",").filter(Boolean).slice(0, MAX_WATCH_ITEMS)
      : [];
  if (!stop && !route && clocks.length === 0 && departs.length === 0) return null;
  return { stop, route, color, clocks, departs };
}
