import { remainMinutes, watchPulseFromPayload } from "./watch-remain";

export type LivePulseStart = {
  action: "start" | "update";
  city: string;
  stop: string;
  route: string;
  color: string;
  headsign: string;
  clocks: string[];
  departs: number[];
  remain: number;
};

export type LivePulseEnd = {
  action: "end";
};

export type LivePulseCommand = LivePulseStart | LivePulseEnd;

export type LivePulseInput = {
  city?: unknown;
  stop?: unknown;
  route?: unknown;
  color?: unknown;
  headsign?: unknown;
  clocks?: unknown;
  departs?: unknown;
};

function asText(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function asDeparts(value: unknown): number[] {
  const list = Array.isArray(value) ? value : [];
  const out: number[] = [];
  for (const raw of list) {
    const n = typeof raw === "number" ? raw : Number(raw);
    if (Number.isFinite(n)) out.push(n);
  }
  return out;
}

function asClocks(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.filter((item): item is string => typeof item === "string" && item.length > 0);
}

/** Boarding pole only. Never the destination name. */
export function boardingStopName(
  trip:
    | {
        legs?: Array<{
          kind?: string;
          from?: { name?: string; label?: string; lon?: number; lat?: number };
        }>;
      }
    | null
    | undefined,
): string {
  const transit = (trip?.legs || []).find((leg) => leg.kind === "transit");
  const from = transit?.from;
  if (!from || typeof from !== "object") return "";
  return (typeof from.name === "string" && from.name) || (typeof from.label === "string" && from.label) || "";
}

/** Empty, walk-only, or past departs → end. Never invents a route. */
export function livePulseFromTransit(input: LivePulseInput | null | undefined, now: number): LivePulseCommand {
  if (!input || typeof input !== "object") return { action: "end" };
  const route = asText(input.route);
  const stop = asText(input.stop);
  const departs = asDeparts(input.departs);
  if (!route || departs.length === 0) return { action: "end" };
  const remain = remainMinutes(departs, now);
  if (remain == null) return { action: "end" };
  return {
    action: "start",
    city: asText(input.city) || "quebec",
    stop,
    route,
    color: asText(input.color) || "#0071e3",
    headsign: asText(input.headsign),
    clocks: asClocks(input.clocks),
    departs,
    remain,
  };
}

export function livePulseEnd(): LivePulseEnd {
  return { action: "end" };
}

export type PulseStore = {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
};

export function applyLivePulse(
  command: LivePulseCommand,
  store: PulseStore | null | undefined,
  key = "rive.live",
): { href: string; live: Record<string, unknown> | null } {
  if (!command || command.action === "end") {
    try {
      store?.removeItem(key);
    } catch {
      /* private */
    }
    return { href: "./watch.html", live: null };
  }
  const live = {
    city: command.city,
    stop: command.stop,
    route: command.route,
    color: command.color,
    headsign: command.headsign,
    clocks: command.clocks,
    departs: command.departs,
    remain: command.remain,
  };
  try {
    store?.setItem(key, JSON.stringify(live));
  } catch {
    /* private */
  }
  const q = new URLSearchParams({
    c: command.city,
    s: command.stop,
    r: command.route,
    k: command.color,
    t: command.clocks.slice(0, 4).join(","),
    m: command.departs.slice(0, 4).join(","),
  });
  return { href: `./watch.html?${q.toString()}`, live };
}

export function livePulseIsIdle(payload: unknown): boolean {
  return watchPulseFromPayload(payload) == null;
}
