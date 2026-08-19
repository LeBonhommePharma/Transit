import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, it } from "node:test";
import { GET as departuresGet } from "@/app/api/departures/route";
import { POST as planPost } from "@/app/api/plan/route";
import { POST as probePost, PUT as probePut } from "@/app/api/probe/route";
import { GET as searchGet } from "@/app/api/search/route";
import type { Atlas } from "./atlas/types";
import { daytimeClock } from "./clock";
import { decodePolyline } from "./geo";
import { firstStopFromQuery, placeFromStop, searchAtlas } from "./search";

function loadAtlas(city: string): Atlas {
  return JSON.parse(
    readFileSync(join(process.cwd(), "public", "data", city, "atlas.json"), "utf8"),
  ) as Atlas;
}

async function readJson(res: Response): Promise<{ status: number; body: Record<string, unknown> }> {
  return { status: res.status, body: (await res.json()) as Record<string, unknown> };
}

describe("HTTP search / departures / plan handlers", () => {
  const at = daytimeClock().toISOString();

  it("rejects an unknown city on search with 400 error JSON", async () => {
    const res = await searchGet(new Request("http://rive.test/api/search?city=ottawa&q=Youville"));
    const { status, body } = await readJson(res);
    assert.equal(status, 400);
    assert.equal(typeof body.error, "string");
    assert.ok(String(body.error).length > 0);
  });

  it("accepts every shipped index city on search", async () => {
    const index = JSON.parse(readFileSync(join(process.cwd(), "public", "data", "index.json"), "utf8")) as {
      cities?: Array<{ city?: unknown }>;
    };
    const cities = Array.isArray(index.cities)
      ? index.cities.map((row) => row.city).filter((city): city is string => typeof city === "string")
      : [];
    assert.ok(cities.length > 0, "public/data/index.json cities[] is empty");
    for (const city of cities) {
      const res = await searchGet(new Request(`http://rive.test/api/search?city=${encodeURIComponent(city)}&q=a`));
      const { status, body } = await readJson(res);
      assert.equal(status, 200, `${city} search must not be an unknown city`);
      assert.ok(Array.isArray(body.hits), `${city} search hits`);
    }
  });

  it("rejects departures with missing stop and query", async () => {
    const res = await departuresGet(new Request("http://rive.test/api/departures?city=quebec"));
    const { status, body } = await readJson(res);
    assert.equal(status, 400);
    assert.equal(typeof body.error, "string");
  });

  it("rejects departures with an invalid clock", async () => {
    const res = await departuresGet(
      new Request("http://rive.test/api/departures?city=quebec&stop=1-1190&at=not-a-date"),
    );
    const { status, body } = await readJson(res);
    assert.equal(status, 400);
    assert.equal(typeof body.error, "string");
  });

  it("returns 404 for a departures stop id that is not on the atlas", async () => {
    const res = await departuresGet(
      new Request(`http://rive.test/api/departures?city=quebec&stop=no-such-stop&at=${encodeURIComponent(at)}`),
    );
    const { status, body } = await readJson(res);
    assert.equal(status, 404);
    assert.equal(typeof body.error, "string");
  });

  it("rejects a plan body that is not JSON", async () => {
    const res = await planPost(
      new Request("http://rive.test/api/plan", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: "not-json{{",
      }),
    );
    const { status, body } = await readJson(res);
    assert.equal(status, 400);
    assert.equal(typeof body.error, "string");
  });

  it("rejects an oversized plan body before JSON parsing", async () => {
    const res = await planPost(
      new Request("http://rive.test/api/plan", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: "{" + "x".repeat(70_000),
      }),
    );
    const { status, body } = await readJson(res);
    assert.equal(status, 400);
    assert.equal(typeof body.error, "string");
  });

  it("rejects a plan body missing from, to, or city", async () => {
    const res = await planPost(
      new Request("http://rive.test/api/plan", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ city: "quebec" }),
      }),
    );
    const { status, body } = await readJson(res);
    assert.equal(status, 400);
    assert.equal(typeof body.error, "string");
  });

  it("returns no Montréal search hits for garbage that is not a stop", async () => {
    const res = await searchGet(
      new Request("http://rive.test/api/search?city=montreal&q=zzzz-not-a-stop"),
    );
    const { status, body } = await readJson(res);
    assert.equal(status, 200);
    assert.deepEqual(body.hits, []);
  });

  it("returns 404 when Montréal departures are asked for a garbage stop name", async () => {
    const res = await departuresGet(
      new Request(
        `http://rive.test/api/departures?city=montreal&q=zzzz-not-a-stop&at=${encodeURIComponent(at)}`,
      ),
    );
    const { status, body } = await readJson(res);
    assert.equal(status, 404);
    assert.equal(typeof body.error, "string");
  });

  it("rejects a plan body with non-finite coordinates", async () => {
    const res = await planPost(
      new Request("http://rive.test/api/plan", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          city: "montreal",
          from: { label: "x", lon: Number.NaN, lat: 45.5 },
          to: { label: "y", lon: -73.5, lat: 45.5 },
          at,
        }),
      }),
    );
    const { status, body } = await readJson(res);
    assert.equal(status, 400);
    assert.equal(typeof body.error, "string");
  });

  it("returns Québec search hits for Youville", async () => {
    const res = await searchGet(new Request("http://rive.test/api/search?city=quebec&q=Youville"));
    const { status, body } = await readJson(res);
    assert.equal(status, 200);
    assert.ok(Array.isArray(body.hits));
    assert.ok((body.hits as unknown[]).length > 0);
  });

  it("returns Québec departures for a real stop at the pinned daytime clock", async () => {
    const atlas = loadAtlas("quebec");
    const stop = firstStopFromQuery(atlas, "Youville");
    assert.ok(stop);
    const res = await departuresGet(
      new Request(
        `http://rive.test/api/departures?city=quebec&stop=${encodeURIComponent(stop.id)}&at=${encodeURIComponent(at)}`,
      ),
    );
    const { status, body } = await readJson(res);
    assert.equal(status, 200);
    assert.ok(Array.isArray(body.departures));
    assert.ok((body.departures as unknown[]).length > 0);
  });

  it("returns a Youville to Université Laval plan with itineraries", async () => {
    const atlas = loadAtlas("quebec");
    const fromHit = searchAtlas(atlas, "Youville", 12).find((hit) => hit.kind === "stop");
    const toHit = searchAtlas(atlas, "Universite Laval", 12).find((hit) => hit.kind === "stop");
    assert.ok(fromHit && fromHit.kind === "stop");
    assert.ok(toHit && toHit.kind === "stop");
    const res = await planPost(
      new Request("http://rive.test/api/plan", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          city: "quebec",
          from: placeFromStop(fromHit.stop),
          to: placeFromStop(toHit.stop),
          at,
        }),
      }),
    );
    const { status, body } = await readJson(res);
    assert.equal(status, 200);
    assert.ok(Array.isArray(body.itineraries));
    assert.ok((body.itineraries as unknown[]).length > 0);
    const first = (body.itineraries as Array<{ minutes?: unknown; legs?: unknown }>)[0];
    assert.equal(typeof first.minutes, "number");
    assert.ok(Array.isArray(first.legs));
  });

  it("fuses three agreeing probes and sets wait from clock-minutes, not officialDepart", async () => {
    const atlas = loadAtlas("montreal");
    const route = atlas.routes.find((item) => decodePolyline(item.dirs[0]?.line || "").length >= 8);
    assert.ok(route);
    const shape = decodePolyline(route.dirs[0].line);
    const [lon, lat] = shape[1];
    const at = Date.now();
    let cookie = "";
    for (const jitter of [0, 0.00004, -0.00004]) {
      const headers: Record<string, string> = { "content-type": "application/json" };
      if (cookie) headers.cookie = cookie;
      const res = await probePost(
        new Request("http://rive.test/api/probe", {
          method: "POST",
          headers,
          body: JSON.stringify({ lon: lon + jitter, lat, at, routeId: route.id }),
        }),
      );
      const { status, body } = await readJson(res);
      assert.equal(status, 200);
      assert.equal(body.accepted, true);
      cookie = res.headers.get("set-cookie")?.split(";", 1)[0] || cookie;
    }
    const put = await probePut(
      new Request("http://rive.test/api/probe", {
        method: "PUT",
        headers: { "content-type": "application/json", cookie },
        body: JSON.stringify({
          city: "montreal",
          routeId: route.id,
          shape,
        }),
      }),
    );
    const fusedBody = await readJson(put);
    assert.equal(fusedBody.status, 200);
    const fused = fusedBody.body.fused as { etaShiftMinutes?: number } | null;
    assert.ok(fused);
    assert.equal(fused.etaShiftMinutes, 0);
    assert.equal(fusedBody.body.due, null);
    assert.equal(fusedBody.body.officialUnchanged, true);
  });

  it("does not expose probe fusion across anonymous sessions", async () => {
    const res = await probePut(
      new Request("http://rive.test/api/probe", {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ city: "montreal", routeId: "1" }),
      }),
    );
    const { status } = await readJson(res);
    assert.equal(status, 401);
  });
});
