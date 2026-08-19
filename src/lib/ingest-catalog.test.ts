import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it } from "node:test";
import {
  loadCatalog,
  loadCatalogFromFile,
  parseIngestArgs,
  regionsFromCatalog,
  selectRegions,
} from "../../scripts/gtfs-catalog.mjs";

const root = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const registryPath = join(root, "src", "lib", "registry.json");
const ingestPath = join(root, "scripts", "ingest-gtfs.mjs");

const FOREIGN_FEED_IDS = ["stm", "rtl", "stl", "rtc", "stlevis", "sttr"];

function feedHaystack(region: { feeds: Array<{ slug: string; url: string }> }): string {
  return region.feeds
    .flatMap((feed) => [feed.slug, feed.url])
    .join("\n")
    .toLowerCase();
}

describe("ingest catalog", () => {
  const registry = JSON.parse(readFileSync(registryPath, "utf8"));
  const catalog = loadCatalog(registry);
  const regions = regionsFromCatalog(catalog);
  const registryIds = catalog.cities.map((city: { id: string }) => city.id);

  it("loads the real registry from disk", () => {
    const fromFile = loadCatalogFromFile(registryPath);
    assert.deepEqual(
      fromFile.cities.map((city: { id: string }) => city.id),
      registryIds,
    );
  });

  it("selects only sherbrooke and none of the other agency feeds", () => {
    const selected = selectRegions(regions, "sherbrooke");
    assert.equal(selected.length, 1);
    assert.equal(selected[0].city, "sherbrooke");
    const hay = feedHaystack(selected[0]);
    for (const id of FOREIGN_FEED_IDS) {
      assert.equal(hay.includes(id), false, `sherbrooke catalog leaked ${id}`);
    }
    const sherbrooke = catalog.cities.find((city: { id: string }) => city.id === "sherbrooke");
    assert.ok(sherbrooke);
    assert.equal(selected[0].feeds.length, sherbrooke.gtfs.length);
  });

  it("selects montreal STM + STL + RTL with the rtl prefix", () => {
    const selected = selectRegions(regions, "montreal");
    assert.equal(selected.length, 1);
    const slugs = selected[0].feeds.map((feed: { slug: string }) => feed.slug);
    assert.ok(slugs.includes("stm"));
    assert.ok(slugs.includes("stl"));
    assert.ok(slugs.includes("rtl"));
    const montreal = catalog.cities.find((city: { id: string }) => city.id === "montreal");
    assert.ok(montreal);
    assert.equal(selected[0].feeds.length, montreal.gtfs.length);
    const rtl = selected[0].feeds.find((feed: { slug: string }) => feed.slug === "rtl");
    assert.ok(rtl);
    assert.equal(rtl.prefix, "rtl:");
  });

  it("returns every registry city when no city is given", () => {
    const all = selectRegions(regions);
    const empty = selectRegions(regions, "");
    assert.deepEqual(
      all.map((region: { city: string }) => region.city),
      registryIds,
    );
    assert.deepEqual(
      empty.map((region: { city: string }) => region.city),
      registryIds,
    );
    assert.equal(all.length, registryIds.length);
  });

  it("throws on an unknown city", () => {
    assert.throws(() => selectRegions(regions, "ottawa"), /unknown city/i);
  });

  it("parses --city trois-rivieres from argv", () => {
    const parsed = parseIngestArgs(["node", "ingest-gtfs.mjs", "--city", "trois-rivieres"], {});
    assert.equal(parsed.city, "trois-rivieres");
    const equals = parseIngestArgs(["node", "ingest-gtfs.mjs", "--city=quebec"], {});
    assert.equal(equals.city, "quebec");
    const fromEnv = parseIngestArgs(["node", "ingest-gtfs.mjs"], { RIVE_INGEST_CITY: "sherbrooke" });
    assert.equal(fromEnv.city, "sherbrooke");
  });

  it("removes the hardcoded ingest REGIONS table", () => {
    const source = readFileSync(ingestPath, "utf8");
    assert.doesNotMatch(source, /const REGIONS\b/);
  });
});
