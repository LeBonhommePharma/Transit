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

export function openMeteoForecastUrl(lat: unknown, lon: unknown): string {
  const y = Number(lat);
  const x = Number(lon);
  if (!Number.isFinite(y) || !Number.isFinite(x) || y < -90 || y > 90 || x < -180 || x > 180) return "";
  return `https://api.open-meteo.com/v1/forecast?latitude=${y}&longitude=${x}&current=temperature_2m,precipitation,rain,snowfall,weather_code,wind_speed_10m,wind_direction_10m,visibility,uv_index&hourly=precipitation,uv_index&forecast_hours=3&timezone=America%2FMontreal`;
}

export function openMeteoAirUrl(lat: unknown, lon: unknown): string {
  const y = Number(lat);
  const x = Number(lon);
  if (!Number.isFinite(y) || !Number.isFinite(x) || y < -90 || y > 90 || x < -180 || x > 180) return "";
  return `https://air-quality-api.open-meteo.com/v1/air-quality?latitude=${y}&longitude=${x}&current=european_aqi`;
}

export async function loadTuiWeather(opts: {
  envJson?: string | null;
  lat?: unknown;
  lon?: unknown;
  fetchJson?: (url: string) => Promise<unknown>;
}): Promise<unknown> {
  if (opts.envJson) {
    try {
      return JSON.parse(opts.envJson);
    } catch {
      return null;
    }
  }
  const forecast = openMeteoForecastUrl(opts.lat, opts.lon);
  const air = openMeteoAirUrl(opts.lat, opts.lon);
  if (!forecast || !air || !opts.fetchJson) return null;
  const grab = async (url: string) => {
    try {
      return await opts.fetchJson!(url);
    } catch {
      return null;
    }
  };
  const [wx, aqi] = await Promise.all([grab(forecast), grab(air)]);
  const wxObj = wx && typeof wx === "object" ? (wx as Record<string, unknown>) : null;
  const aqiObj = aqi && typeof aqi === "object" ? (aqi as Record<string, unknown>) : null;
  if (!wxObj && !aqiObj) return null;
  const current = {
    ...((wxObj?.current && typeof wxObj.current === "object" ? wxObj.current : {}) as object),
    ...((aqiObj?.current && typeof aqiObj.current === "object" ? aqiObj.current : {}) as object),
  };
  return { ...(wxObj || {}), current, hourly: wxObj?.hourly };
}

async function liveFetchJson(url: string): Promise<unknown> {
  const res = await fetch(url, { signal: AbortSignal.timeout(1800) });
  if (!res.ok) return null;
  return res.json();
}

export async function runTui(
  argv: string[],
  io: { log: (s: string) => void; error: (s: string) => void } = console,
  hooks: { fetchJson?: (url: string) => Promise<unknown>; now?: Date } = {},
): Promise<number> {
  const city = argv[0];
  const query = argv.slice(1).join(" ").trim();
  const pack = typeof city === "string" ? loadCity(city.trim().toLowerCase()) : null;
  const center = pack?.atlas.meta.center;
  const liveOff = process.env.RIVE_WEATHER_OFF === "1";
  const weather = await loadTuiWeather({
    envJson: process.env.RIVE_WEATHER_JSON,
    lat: center?.[1],
    lon: center?.[0],
    fetchJson: liveOff ? undefined : (hooks.fetchJson ?? liveFetchJson),
  });
  const text = renderTransitSnapshot({ city, query, weather, now: hooks.now ?? new Date() });
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
