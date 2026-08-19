import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it } from "node:test";
import type { Atlas } from "./atlas/types";
import { activeServiceIndexes } from "./services";
import {
  assertCoverageIncludesToday,
  coverageEndYyyymmdd,
  montrealYyyymmdd,
} from "../../scripts/gtfs-coverage.mjs";

const root = join(dirname(fileURLToPath(import.meta.url)), "..", "..");

function shippedCities(): string[] {
  const index = JSON.parse(readFileSync(join(root, "public", "data", "index.json"), "utf8")) as {
    cities?: Array<{ city?: unknown }>;
  };
  return Array.isArray(index.cities)
    ? index.cities.map((row) => row.city).filter((city): city is string => typeof city === "string" && city.length > 0)
    : [];
}

describe("GTFS coverage helper", () => {
  it("throws when coverage ended yesterday and accepts a feed that still covers tomorrow", () => {
    const today = montrealYyyymmdd();
    const y = Number(today.slice(0, 4));
    const m = Number(today.slice(4, 6));
    const d = Number(today.slice(6, 8));
    const yesterday = montrealYyyymmdd(new Date(Date.UTC(y, m - 1, d - 1, 16, 0, 0)));
    const tomorrow = montrealYyyymmdd(new Date(Date.UTC(y, m - 1, d + 1, 16, 0, 0)));
    assert.notEqual(yesterday, today);
    assert.notEqual(tomorrow, today);
    assert.throws(() => assertCoverageIncludesToday(yesterday, today), /before today/);
    assert.doesNotThrow(() => assertCoverageIncludesToday(tomorrow, today));
    assert.equal(
      coverageEndYyyymmdd({
        calendar: [{ end: yesterday }],
        exceptions: [{ date: tomorrow }],
        meta: { end: yesterday },
      }),
      tomorrow,
    );
  });
});

describe("shipped city service for now", () => {
  const now = new Date();
  for (const city of shippedCities()) {
    it(`${city} has at least one active service today`, () => {
      const atlas = JSON.parse(readFileSync(join(root, "public", "data", city, "atlas.json"), "utf8")) as Atlas;
      assert.ok(
        activeServiceIndexes(atlas, now).size > 0,
        `${city} has no service on ${now.toISOString()} (coverage end ${coverageEndYyyymmdd(atlas)})`,
      );
    });
  }
});
