/** GTFS route_type → mix family. Unknown types stay bus; nothing is invented. */

export const MIX_FAMILIES = [
  "marche",
  "velo",
  "auto",
  "traversier",
  "tram",
  "trolleybus",
  "funiculaire",
  "câble",
  "monorail",
  "métro",
  "train",
  "bus",
] as const;

export type MixFamily = (typeof MIX_FAMILIES)[number];

const TRANSIT_PRIORITY: MixFamily[] = [
  "traversier",
  "funiculaire",
  "câble",
  "monorail",
  "tram",
  "trolleybus",
  "métro",
  "train",
  "bus",
];

export function transitMixName(type: unknown): MixFamily {
  if (type == null || type === "" || (typeof type !== "number" && typeof type !== "string")) return "bus";
  const t = Number(type);
  if (!Number.isFinite(t)) return "bus";
  if (t === 4 || t === 1200 || (t >= 1000 && t < 1100)) return "traversier";
  if (t === 0 || t === 5 || (t >= 900 && t < 1000)) return "tram";
  if (t === 11 || (t >= 800 && t < 900)) return "trolleybus";
  if (t === 7 || t === 1400) return "funiculaire";
  if (t === 6 || t === 1300) return "câble";
  if (t === 12 || t === 405) return "monorail";
  if (t === 1 || (t >= 400 && t < 500)) return "métro";
  if (t === 2 || (t >= 100 && t < 200)) return "train";
  return "bus";
}

export function mixFamily(item: { legs?: Array<{ kind?: unknown; type?: unknown }> | null } | null | undefined): MixFamily {
  const legs = Array.isArray(item?.legs) ? item.legs : [];
  if (legs.length === 0 || legs.every((leg) => !leg || leg.kind === "walk")) return "marche";
  if (legs.some((leg) => leg.kind === "bike") && !legs.some((leg) => leg.kind === "transit")) return "velo";
  if (legs.some((leg) => leg.kind === "road")) return "auto";
  const names = legs.filter((leg) => leg && leg.kind === "transit").map((leg) => transitMixName(leg.type));
  if (!names.length) return "bus";
  for (const name of TRANSIT_PRIORITY) {
    if (names.includes(name)) return name;
  }
  return "bus";
}
