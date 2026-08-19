/** No-browser Transit snapshot. Reads shipped public/data. No extra install. */

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { Atlas, Timetable } from "./atlas/types";
import { formatShownLine, shownConditions } from "./conditions";
import { firstStopFromQuery } from "./search";
import { departuresAtStop } from "./planner";
import { activeServiceIndexes } from "./services";
import { formatClock, minutesOfDay } from "./time";

function dataRoot(): string {
  return join(dirname(fileURLToPath(import.meta.url)), "..", "..", "public", "data");
}

function knownCities(): Set<string> {
  try {
    const table = JSON.parse(readFileSync(join(dataRoot(), "index.json"), "utf8")) as {
      cities?: Array<{ city?: unknown }>;
    };
    const ids = (table.cities || [])
      .map((row) => (typeof row.city === "string" ? row.city.trim().toLowerCase() : ""))
      .filter((id) => /^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(id) && id.length <= 64);
    if (ids.length) return new Set(ids);
  } catch {
    /* fall through */
  }
  return new Set(["quebec", "montreal", "sherbrooke", "trois-rivieres"]);
}

const CITIES = knownCities();

function loadCity(city: string): { atlas: Atlas; timetable: Timetable } | null {
  if (!CITIES.has(city)) return null;
  try {
    const root = join(dataRoot(), city);
    return {
      atlas: JSON.parse(readFileSync(join(root, "atlas.json"), "utf8")) as Atlas,
      timetable: JSON.parse(readFileSync(join(root, "timetable.json"), "utf8")) as Timetable,
    };
  } catch {
    return null;
  }
}

export function renderTransitSnapshot(opts: {
  city?: unknown;
  query?: unknown;
  weather?: unknown;
  now?: Date;
}): string {
  const city = typeof opts.city === "string" ? opts.city.trim().toLowerCase() : "";
  const query = typeof opts.query === "string" ? opts.query.trim() : "";
  const lines: string[] = ["Rive"];
  if (!city || !CITIES.has(city)) {
    lines.push(`Ville inconnue. Choisis ${[...CITIES].join(", ")}.`);
    return lines.join("\n");
  }
  const pack = loadCity(city);
  if (!pack) {
    lines.push(`${city}: atlas introuvable.`);
    return lines.join("\n");
  }
  lines[0] = `Rive  ${pack.atlas.meta.name || city}`;
  const shown = shownConditions(opts.weather ?? null);
  const wx = formatShownLine(shown);
  if (wx) lines.push(wx);
  if (!query) {
    lines.push("Donne un arrêt. Exemple: rive quebec Youville");
    return lines.join("\n");
  }
  const stop = firstStopFromQuery(pack.atlas, query);
  if (!stop) {
    lines.push(`Arrêt introuvable: ${query}`);
    return lines.join("\n");
  }
  const now = opts.now instanceof Date && Number.isFinite(opts.now.getTime()) ? opts.now : new Date();
  const at = minutesOfDay(now);
  const rows = departuresAtStop(pack.atlas, pack.timetable, stop, at, activeServiceIndexes(pack.atlas, now), 6);
  lines.push(stop.name);
  if (!rows.length) {
    lines.push("Aucun passage restant.");
    return lines.join("\n");
  }
  for (const row of rows) {
    const wait = Math.max(0, row.wait);
    lines.push(`  ${row.shortName}  ${row.headsign}  ${wait} min  ${formatClock(row.depart)}`);
  }
  return lines.join("\n");
}

export async function runTui(
  argv: string[],
  io: { log: (s: string) => void; error: (s: string) => void } = console,
): Promise<number> {
  const city = argv[0];
  const query = argv.slice(1).join(" ").trim();
  let weather: unknown = null;
  if (process.env.RIVE_WEATHER_JSON) {
    try {
      weather = JSON.parse(process.env.RIVE_WEATHER_JSON);
    } catch {
      weather = null;
    }
  }
  const text = renderTransitSnapshot({ city, query, weather, now: new Date() });
  io.log(text);
  if (!city || !CITIES.has(String(city).toLowerCase()) || !query || text.includes("introuvable")) {
    io.error("usage: rive <city> <stop>");
    return 1;
  }
  return 0;
}

const here = fileURLToPath(import.meta.url);
if (process.argv[1] && (process.argv[1] === here || process.argv[1].endsWith("tui.ts") || process.argv[1].endsWith("tui.js"))) {
  runTui(process.argv.slice(2)).then((code) => {
    if (code) process.exitCode = code;
  });
}
