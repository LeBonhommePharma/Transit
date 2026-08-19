import { randomBytes } from "node:crypto";
import { isCityId, loadAtlas } from "@/lib/atlas/store";
import { allowRateLimit, isFiniteCoordinate, readJsonBody, requestRateLimitKey } from "@/lib/http";
import { decodePolyline } from "@/lib/geo";
import { emptyProbeStore, fuseRouteProbes, ingestProbe, type ProbeStore } from "@/lib/probe";
import type { CityId } from "@/lib/atlas/types";

export const runtime = "nodejs";

const SESSION_COOKIE = "rive_probe";
const SESSION_TTL_MS = 10 * 60 * 1000;
const MAX_SESSIONS = 512;

type ProbeSession = {
  store: ProbeStore;
  touchedAt: number;
};

const sessions = new Map<string, ProbeSession>();

function response(body: unknown, status = 200, token?: string): Response {
  const headers = new Headers({ "Cache-Control": "no-store" });
  if (token) {
    headers.set(
      "Set-Cookie",
      `${SESSION_COOKIE}=${token}; Path=/api/probe; Max-Age=${Math.floor(SESSION_TTL_MS / 1000)}; HttpOnly; Secure; SameSite=Lax`,
    );
  }
  return Response.json(body, { status, headers });
}

function cookieToken(request: Request): string | null {
  const cookie = request.headers.get("cookie") || "";
  const match = cookie.match(new RegExp(`(?:^|;\\s*)${SESSION_COOKIE}=([^;]+)`));
  const token = match?.[1] || "";
  return /^[A-Za-z0-9_-]{32,80}$/.test(token) ? token : null;
}

function pruneSessions(now: number): void {
  for (const [token, session] of sessions) {
    if (now - session.touchedAt > SESSION_TTL_MS) sessions.delete(token);
  }
  while (sessions.size >= MAX_SESSIONS) {
    const oldest = [...sessions.entries()].sort((a, b) => a[1].touchedAt - b[1].touchedAt)[0]?.[0];
    if (!oldest) break;
    sessions.delete(oldest);
  }
}

function getSession(request: Request, create: boolean, now: number): { token: string; session: ProbeSession } | null {
  pruneSessions(now);
  const existingToken = cookieToken(request);
  if (existingToken) {
    const existing = sessions.get(existingToken);
    if (existing) {
      existing.touchedAt = now;
      return { token: existingToken, session: existing };
    }
  }
  if (!create) return null;
  const token = randomBytes(32).toString("base64url");
  const session = { store: emptyProbeStore(), touchedAt: now };
  sessions.set(token, session);
  return { token, session };
}

async function routeShape(city: CityId, routeId: string): Promise<[number, number][] | null> {
  const atlas = await loadAtlas(city);
  const route = atlas.routes.find((item) => item.id === routeId);
  if (!route) return null;
  for (const dir of route.dirs) {
    const shape = decodePolyline(dir.line);
    if (shape.length >= 2 && shape.every(([lon, lat]) => isFiniteCoordinate(lon, -180, 180) && isFiniteCoordinate(lat, -90, 90))) {
      return shape;
    }
  }
  return null;
}

export async function POST(request: Request) {
  const now = Date.now();
  if (!allowRateLimit(requestRateLimitKey(request, "probe"), 120, 60_000, now)) return response({ error: "Trop de requêtes.", accepted: false }, 429);
  const parsed = await readJsonBody<Record<string, unknown>>(request);
  if (!parsed.ok || !parsed.value || typeof parsed.value !== "object") {
    return response({ error: "Corps JSON invalide.", accepted: false }, 400);
  }
  const identity = getSession(request, true, now);
  if (!identity) return response({ error: "Session invalide.", accepted: false }, 401);
  const before = identity.session.store.samples.length;
  const next = ingestProbe(identity.session.store, { ...parsed.value, at: parsed.value.at ?? now }, now);
  const accepted = next.samples.length > before;
  identity.session.store.samples = next.samples;
  return response(
    {
      accepted,
      count: identity.session.store.samples.length,
    },
    200,
    identity.token,
  );
}

export async function PUT(request: Request) {
  const now = Date.now();
  if (!allowRateLimit(requestRateLimitKey(request, "probe"), 120, 60_000, now)) return response({ error: "Trop de requêtes." }, 429);
  const identity = getSession(request, false, now);
  if (!identity) return response({ error: "Session de sondage absente." }, 401);
  const parsed = await readJsonBody<Record<string, unknown>>(request);
  if (!parsed.ok || !parsed.value || typeof parsed.value !== "object") {
    return response({ error: "Corps JSON invalide." }, 400);
  }
  const city = parsed.value.city;
  const routeId = parsed.value.routeId;
  if (typeof city !== "string" || !isCityId(city) || typeof routeId !== "string" || routeId.length > 128 || !routeId) {
    return response({ error: "Fusion incomplète." }, 400);
  }
  const shape = await routeShape(city, routeId);
  if (!shape) return response({ error: "Parcours introuvable." }, 404);
  const fused = fuseRouteProbes({
    store: identity.session.store,
    routeId,
    shape,
    now,
    // Expected position and due rows are server-owned, not client authority.
    officialDepart: 0,
  });
  return response({ fused, due: null, officialUnchanged: !fused || fused.etaShiftMinutes === 0 });
}
