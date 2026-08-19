/**
 * Pure GTFS city catalog: parse registry.json, map ingest regions, select --city.
 * Import-safe: no network, no writes, no ingest.
 */
import { readFileSync } from "node:fs";

function fail(message) {
  throw new Error(message);
}

function isPlainObject(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function requiredString(value, label, { allowEmpty = false } = {}) {
  if (typeof value !== "string") fail(`${label} must be a string`);
  if (!allowEmpty && value.length === 0) fail(`${label} must be non-empty`);
  return value;
}

function finiteNumber(value, label) {
  if (typeof value !== "number" || !Number.isFinite(value)) fail(`${label} must be a finite number`);
  return value;
}

function validateFeed(feed, cityId, index) {
  if (!isPlainObject(feed)) fail(`City ${cityId} feed ${index} must be an object`);
  const label = `City ${cityId} feed ${index}`;
  const agency = requiredString(feed.agency, `${label} agency`);
  const url = requiredString(feed.url, `${label} url`);
  if (!url.startsWith("https://")) fail(`${label} url must be https`);
  const slug = requiredString(feed.slug, `${label} slug`);
  const zip = requiredString(feed.zip, `${label} zip`);
  if (zip.includes("/") || zip.includes("\\") || zip.includes("..")) {
    fail(`${label} zip must be a file name`);
  }
  const prefix = requiredString(feed.prefix, `${label} prefix`, { allowEmpty: true });
  const licenseUrl = requiredString(feed.licenseUrl, `${label} licenseUrl`);
  if (!licenseUrl.startsWith("https://")) fail(`${label} licenseUrl must be https`);
  const attribution = requiredString(feed.attribution ?? "", `${label} attribution`, { allowEmpty: true });
  return {
    agency,
    url,
    slug,
    zip,
    prefix,
    licenseUrl,
    attribution,
  };
}

function validateCity(city, index) {
  if (!isPlainObject(city)) fail(`Catalog city ${index} must be an object`);
  const id = requiredString(city.id, `City ${index} id`);
  const name = requiredString(city.name, `City ${id} name`);
  if (!Array.isArray(city.center) || city.center.length !== 2) {
    fail(`City ${id} center must be [lon, lat]`);
  }
  const center = [finiteNumber(city.center[0], `City ${id} center lon`), finiteNumber(city.center[1], `City ${id} center lat`)];
  const zoom = finiteNumber(city.zoom, `City ${id} zoom`);
  if (!Array.isArray(city.gtfs) || city.gtfs.length === 0) fail(`City ${id} must list at least one gtfs feed`);
  const gtfs = city.gtfs.map((feed, feedIndex) => validateFeed(feed, id, feedIndex));
  const slugs = new Set();
  for (const feed of gtfs) {
    if (slugs.has(feed.slug)) fail(`City ${id} has duplicate feed slug ${feed.slug}`);
    slugs.add(feed.slug);
  }
  return { ...city, id, name, center, zoom, gtfs };
}

export function loadCatalog(registryJson) {
  if (!isPlainObject(registryJson)) fail("Catalog must be an object");
  if (!Array.isArray(registryJson.cities) || registryJson.cities.length === 0) {
    fail("Catalog must list cities");
  }
  const cities = registryJson.cities.map((city, index) => validateCity(city, index));
  const ids = new Set();
  for (const city of cities) {
    if (ids.has(city.id)) fail(`Duplicate city id ${city.id}`);
    ids.add(city.id);
  }
  return { ...registryJson, cities };
}

export function loadCatalogFromFile(path) {
  const file = requiredString(path, "Catalog path");
  let parsed;
  try {
    parsed = JSON.parse(readFileSync(file, "utf8"));
  } catch (error) {
    fail(`Cannot read catalog ${file}: ${error instanceof Error ? error.message : error}`);
  }
  return loadCatalog(parsed);
}

export function regionsFromCatalog(catalog) {
  const loaded = loadCatalog(catalog);
  return loaded.cities.map((city) => ({
    city: city.id,
    name: city.name,
    center: city.center,
    zoom: city.zoom,
    feeds: city.gtfs.map((feed) => ({
      slug: feed.slug,
      zip: feed.zip,
      url: feed.url,
      attribution: feed.attribution,
      licenseUrl: feed.licenseUrl,
      agencyHint: feed.agency,
      prefix: feed.prefix,
    })),
  }));
}

export function selectRegions(regions, cityId) {
  if (!Array.isArray(regions)) fail("Regions must be an array");
  const wanted = cityId == null ? "" : String(cityId).trim();
  if (!wanted) return regions.slice();
  const matched = regions.filter((region) => region && region.city === wanted);
  if (matched.length === 0) {
    const known = regions.map((region) => region?.city).filter(Boolean).join(", ");
    fail(`Unknown city: ${wanted}${known ? ` (known: ${known})` : ""}`);
  }
  return matched;
}

export function parseIngestArgs(argv, env = process.env) {
  const list = Array.isArray(argv) ? argv : [];
  let city = "";
  let force = false;
  for (let i = 0; i < list.length; i++) {
    const arg = list[i];
    if (arg === "--force") {
      force = true;
      continue;
    }
    if (arg === "--city") {
      const next = list[i + 1];
      if (!next || String(next).startsWith("-")) fail("Missing value for --city");
      city = String(next);
      i += 1;
      continue;
    }
    if (typeof arg === "string" && arg.startsWith("--city=")) {
      city = arg.slice("--city=".length);
    }
  }
  if (!city && typeof env?.RIVE_INGEST_CITY === "string") city = env.RIVE_INGEST_CITY;
  if (!force && env?.RIVE_FORCE_INGEST === "1") force = true;
  city = city.trim();
  return { city: city || undefined, force };
}
