/** Minutes until the next published depart. Empty / garbage → null, never throws. */

export function remainMinutes(departs: unknown, now: number): number | null {
  if (!Number.isFinite(now)) return null;
  const list = Array.isArray(departs) ? departs : [];
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

export function watchPulseFromPayload(payload: unknown): WatchPulse | null {
  if (payload == null) return null;
  if (typeof payload === "string") {
    const trimmed = payload.trim();
    if (!trimmed) return null;
    try {
      return watchPulseFromPayload(JSON.parse(trimmed));
    } catch {
      return null;
    }
  }
  if (typeof payload !== "object") return null;
  const row = payload as Record<string, unknown>;
  const stop = typeof row.stop === "string" ? row.stop : typeof row.s === "string" ? row.s : "";
  const route = typeof row.route === "string" ? row.route : typeof row.r === "string" ? row.r : "";
  const color = typeof row.color === "string" ? row.color : typeof row.k === "string" ? row.k : "";
  const clocksRaw = row.clocks ?? row.t;
  const departsRaw = row.departs ?? row.m;
  const clocks = Array.isArray(clocksRaw)
    ? clocksRaw.filter((item): item is string => typeof item === "string")
    : typeof clocksRaw === "string"
      ? clocksRaw.split(",").filter(Boolean)
      : [];
  const departs = Array.isArray(departsRaw)
    ? departsRaw
    : typeof departsRaw === "string"
      ? departsRaw.split(",").filter(Boolean)
      : [];
  if (!stop && !route && clocks.length === 0 && departs.length === 0) return null;
  return { stop, route, color, clocks, departs };
}
