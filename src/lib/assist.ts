import { fold } from "./search";
import type { CityId } from "./atlas/types";

export type CityHint = {
  id: CityId;
  name?: string;
  aliases?: string[];
};

export type TransitIntent = {
  city: CityId | null;
  query: string;
  kind: "schedule" | "plan";
};

declare global {
  interface Window {
    riveFoundationAssist?: (text: string) => Promise<TransitIntent>;
    webkit?: {
      messageHandlers?: {
        riveAssist?: { postMessage: (payload: unknown) => void };
      };
    };
  }
}

/**
 * Deterministic parse used on the web and as fallback.
 * Apple Foundation Models (on-device) replace this when the iPhone shell
 * injects `window.riveFoundationAssist`. Shortest-path math stays GTFS.
 */
const DEFAULT_CITY_HINTS: CityHint[] = [
  { id: "montreal", name: "Montréal", aliases: ["mtl", "stlaval", "stl laval", "longueuil", "rtl longueuil"] },
  { id: "quebec", name: "Québec", aliases: ["quebec city", "ville de quebec", "levis", "stlevis"] },
  { id: "sherbrooke", name: "Sherbrooke", aliases: ["sts sherbrooke"] },
  { id: "trois-rivieres", name: "Trois-Rivières", aliases: ["trois rivieres", "sttr"] },
];

export function parseTransitQuery(text: string, cities: CityHint[] = DEFAULT_CITY_HINTS): TransitIntent {
  if (typeof text !== "string") {
    return { city: null, query: "", kind: "schedule" };
  }
  const f = fold(text);
  let city: TransitIntent["city"] = null;
  const ordered = [...cities].sort((a, b) => {
    const aLength = Math.max(fold(a.name).length, ...(a.aliases || []).map((alias) => fold(alias).length), fold(a.id).length);
    const bLength = Math.max(fold(b.name).length, ...(b.aliases || []).map((alias) => fold(alias).length), fold(b.id).length);
    return bLength - aLength;
  });
  for (const candidate of ordered) {
    const names = [candidate.id, candidate.name, ...(candidate.aliases || [])].map(fold).filter(Boolean);
    if (names.some((name) => f === name || f.includes(` ${name} `) || f.startsWith(`${name} `) || f.endsWith(` ${name}`))) {
      city = candidate.id;
      break;
    }
  }
  const kind: TransitIntent["kind"] = /\b(vers|to |from |itineraire|itinerary|trajet)\b/.test(f)
    ? "plan"
    : "schedule";
  return { city, query: text.trim(), kind };
}

export async function understandQuery(text: string, cities?: CityHint[]): Promise<TransitIntent> {
  if (typeof window !== "undefined" && window.riveFoundationAssist) {
    try {
      return await window.riveFoundationAssist(text);
    } catch {
      /* fall through to local parse */
    }
  }
  return parseTransitQuery(text, cities);
}
