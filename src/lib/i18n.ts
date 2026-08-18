import catalog from "./l10n.json" with { type: "json" };

export type MessageId = keyof (typeof catalog)["en"];

const TABLES = catalog as Record<string, Record<string, string>>;

/** Locales TranslateKit / Apple system UIs ship. Prefer the device list. */
export const APPLE_LOCALES = Object.keys(TABLES);

export function pickLocale(wanted: readonly string[], available = APPLE_LOCALES): string {
  const set = new Set(available.map((id) => id.toLowerCase()));
  for (const raw of wanted) {
    const tag = raw.toLowerCase().replace("_", "-");
    if (set.has(tag)) return available.find((id) => id.toLowerCase() === tag) ?? tag;
    const base = tag.split("-")[0];
    const exact = available.find((id) => id.toLowerCase() === base);
    if (exact) return exact;
    const regional = available.find((id) => id.toLowerCase().startsWith(`${base}-`));
    if (regional) return regional;
  }
  return "en";
}

export function deviceLocales(): string[] {
  if (typeof navigator === "undefined") return ["en"];
  const list = navigator.languages?.length ? [...navigator.languages] : [];
  if (navigator.language) list.unshift(navigator.language);
  return list;
}

export function t(id: MessageId, locale = pickLocale(deviceLocales())): string {
  return TABLES[locale]?.[id] ?? TABLES.en[id] ?? id;
}
