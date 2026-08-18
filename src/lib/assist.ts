import { fold } from "./search";

export type TransitIntent = {
  city: "quebec" | "montreal" | null;
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
export function parseTransitQuery(text: string): TransitIntent {
  if (typeof text !== "string") {
    return { city: null, query: "", kind: "schedule" };
  }
  const f = fold(text);
  let city: TransitIntent["city"] = null;
  if (/\b(montreal|montreal|mtl)\b/.test(f) || f.includes("montreal")) city = "montreal";
  if (/\b(quebec|quebec city|ville de quebec)\b/.test(f) || f.includes("quebec")) {
    city = "quebec";
  }
  const kind: TransitIntent["kind"] = /\b(vers|to |from |itineraire|itinerary|trajet)\b/.test(f)
    ? "plan"
    : "schedule";
  return { city, query: text.trim(), kind };
}

export async function understandQuery(text: string): Promise<TransitIntent> {
  if (typeof window !== "undefined" && window.riveFoundationAssist) {
    try {
      return await window.riveFoundationAssist(text);
    } catch {
      /* fall through to local parse */
    }
  }
  return parseTransitQuery(text);
}
