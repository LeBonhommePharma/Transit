"use client";

import { FormEvent, useEffect, useMemo, useState } from "react";
import dynamic from "next/dynamic";
import { AnimatePresence, motion, useReducedMotion } from "motion/react";
import {
  ArrowRight,
  Bus,
  Crosshair,
  MagnifyingGlass,
  MapPin,
  PersonSimpleWalk,
  Subway,
  X,
} from "@phosphor-icons/react";
const MapView = dynamic(
  () => import("@/components/map-view").then((mod) => mod.MapView),
  { ssr: false },
);
import type {
  Atlas,
  AtlasRoute,
  AtlasStop,
  CityId,
  Itinerary,
  Place,
} from "@/lib/atlas/types";
import type { Poi } from "@/lib/poi";
import { understandQuery, type CityHint } from "@/lib/assist";
import { t, type MessageId } from "@/lib/i18n";
import { chipsForCities, placeFromStop, searchAtlas, type CityVisit } from "@/lib/search";
import { resolveSearchAction } from "@/lib/search-submit";
import { formatClock, formatRelative } from "@/lib/time";
import { fetchJson, readJsonResponse } from "@/lib/client-http";

type Field = "from" | "to";
type Departure = {
  routeId: string;
  shortName: string;
  color: string;
  textColor: string;
  headsign: string;
  type: number;
  agencyId?: string;
  depart: number;
  wait: number;
  times?: number[];
};

const FALLBACK_CITIES: Array<{ id: CityId; label: string; hints: [string, string] }> = [
  { id: "quebec", label: "Québec", hints: ["Place D'Youville", "Terminus de la Traverse"] },
  { id: "montreal", label: "Montréal", hints: ["Berri-UQAM", "Terminus Montmorency"] },
  { id: "sherbrooke", label: "Sherbrooke", hints: ["Université de Sherbrooke", "Station du Cégep"] },
  { id: "trois-rivieres", label: "Trois-Rivières", hints: ["Terminus Centre-ville", "Terminus UQTR"] },
];

function modeIcon(type: number, className: string) {
  if (type === 1) return <Subway className={className} weight="regular" />;
  return <Bus className={className} weight="regular" />;
}

export function RiveApp() {
  const reduce = useReducedMotion();
  const [locale] = useState("fr");
  const [cities, setCities] = useState(FALLBACK_CITIES);
  const [city, setCity] = useState<CityId>("quebec");
  const [visit, setVisit] = useState<CityVisit | null>(null);
  const [atlas, setAtlas] = useState<Atlas | null>(null);
  const [pois, setPois] = useState<Poi[]>([]);
  const [loadError, setLoadError] = useState("");
  const [fromQuery, setFromQuery] = useState("");
  const [toQuery, setToQuery] = useState("");
  const [from, setFrom] = useState<Place | null>(null);
  const [to, setTo] = useState<Place | null>(null);
  const [activeField, setActiveField] = useState<Field>("to");
  const [itineraries, setItineraries] = useState<Itinerary[]>([]);
  const [chosen, setChosen] = useState<string | null>(null);
  const [planning, setPlanning] = useState(false);
  const [planError, setPlanError] = useState("");
  const [selectedStop, setSelectedStop] = useState<AtlasStop | null>(null);
  const [departures, setDepartures] = useState<Departure[]>([]);
  const [selectedRouteId, setSelectedRouteId] = useState<string | null>(null);
  const [gpuLabel] = useState(() =>
    typeof navigator !== "undefined" && "gpu" in navigator ? "WebGPU prêt" : "WebGL",
  );

  const tr = (id: MessageId) => t(id, locale);
  const chips = useMemo(
    () => chipsForCities(cities.map((item) => ({ city: item.id, name: item.label }))),
    [cities],
  );

  useEffect(() => {
    fetchJson<{ cities?: Array<{ city?: unknown; name?: unknown }> }>("/data/index.json", 2 * 1024 * 1024)
      .then((data: { cities?: Array<{ city?: unknown; name?: unknown }> } | null) => {
        const loaded = (data?.cities || [])
          .filter(
            (item): item is { city: string; name: string } =>
              typeof item.city === "string" &&
              item.city.length <= 64 &&
              /^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(item.city) &&
              typeof item.name === "string",
          )
          .map((item) => ({
            id: item.city,
            label: item.name,
            hints: [item.name, "Arrêts près d'ici"] as [string, string],
          }));
        if (loaded.length) setCities(loaded);
      })
      .catch(() => {});
  }, []);

  useEffect(() => {
    let alive = true;
    async function load() {
      if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(city) || city.length > 64) throw new Error("Ville invalide.");
      const data = await fetchJson<Atlas>(`/data/${encodeURIComponent(city)}/atlas.json`);
      let places: Poi[] = [];
      for (const path of [`/data/${encodeURIComponent(city)}/pois.json`, "/data/pois.json"]) {
        let parsed: { places?: Poi[] };
        try {
          parsed = await fetchJson<{ places?: Poi[] }>(path, 2 * 1024 * 1024);
        } catch {
          continue;
        }
        places = (parsed.places || []).filter((place) => !place.city || place.city === city);
        break;
      }
      if (alive) {
        setAtlas(data);
        setPois(places);
      }
    }
    load().catch((err: Error) => {
      if (alive) setLoadError(err.message);
    });
    return () => {
      alive = false;
    };
  }, [city]);

  const hits = useMemo(() => {
    if (!atlas) return [];
    const q = activeField === "from" ? fromQuery : toQuery;
    return searchAtlas(atlas, q, 7, undefined, { pois });
  }, [atlas, activeField, fromQuery, toQuery, pois]);

  const selectedRoute = atlas?.routes.find((r) => r.id === selectedRouteId) ?? null;
  const activeItinerary = itineraries.find((item) => item.id === chosen) ?? itineraries[0] ?? null;

  function pickStopAs(field: Field, stop: AtlasStop) {
    const place: Place = {
      label: stop.name,
      lon: stop.lon,
      lat: stop.lat,
      stopId: stop.id,
    };
    if (field === "from") {
      setFrom(place);
      setFromQuery(stop.name);
    } else {
      setTo(place);
      setToQuery(stop.name);
    }
  }

  async function openStop(stop: AtlasStop) {
    setSelectedStop(stop);
    setSelectedRouteId(null);
    pickStopAs(activeField, stop);
    const res = await fetch(`/api/departures?city=${encodeURIComponent(city)}&stop=${encodeURIComponent(stop.id)}`);
    if (!res.ok) {
      setDepartures([]);
      return;
    }
    const data = await readJsonResponse<{ departures: Departure[] }>(res, 512 * 1024);
    setDepartures(data.departures);
  }

  function pickPoiAs(field: Field, poi: Poi) {
    const place: Place = { label: poi.name, lon: poi.lon, lat: poi.lat };
    if (field === "from") {
      setFrom(place);
      setFromQuery(poi.name);
    } else {
      setTo(place);
      setToQuery(poi.name);
    }
    const nextFrom = field === "from" ? place : from;
    const nextTo = field === "to" ? place : to;
    if (nextFrom && nextTo) void plan(nextFrom, nextTo);
  }

  async function plan(nextFrom = from, nextTo = to) {
    if (!nextFrom || !nextTo) return;
    setPlanning(true);
    setPlanError("");
    try {
      const res = await fetch("/api/plan", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ city, from: nextFrom, to: nextTo }),
      });
      const data = await readJsonResponse<{ itineraries?: Itinerary[]; error?: string }>(res, 4 * 1024 * 1024);
      if (!res.ok) throw new Error(data.error || "Planification impossible.");
      const list = data.itineraries ?? [];
      setItineraries(list);
      setChosen(list[0]?.id ?? null);
      if (list.length === 0) {
        setPlanError("Aucun trajet trouvé sur les horaires du jour.");
      }
    } catch (err) {
      setPlanError(err instanceof Error ? err.message : "Planification impossible.");
    } finally {
      setPlanning(false);
    }
  }

  async function onSearch(event: FormEvent) {
    event.preventDefault();
    const raw = (toQuery || fromQuery).trim();
    const action = resolveSearchAction({ from, to, query: raw });
    if (action === "plan" && from && to) {
      void plan();
      return;
    }
    if (action === "schedule" && atlas && raw) {
       const intent = await understandQuery(raw, cities as CityHint[]);
      if (intent.city && intent.city !== city) setCity(intent.city);
       const hit = searchAtlas(atlas, intent.query, 1, undefined, { pois })[0];
       if (hit?.kind === "stop") void openStop(hit.stop);
       else if (hit?.kind === "poi") pickPoiAs(activeField, hit.poi);
       else if (hit?.kind === "route") setSelectedRouteId(hit.route.id);
    }
  }

  function locate() {
    if (!navigator.geolocation) return;
    navigator.geolocation.getCurrentPosition((pos) => {
      const place: Place = {
        label: tr("myPosition"),
        lon: pos.coords.longitude,
        lat: pos.coords.latitude,
      };
      setFrom(place);
      setFromQuery(tr("myPosition"));
      setActiveField("to");
    });
  }

  async function applyHint(name: string, field: Field) {
    if (!atlas) return;
    const hit = searchAtlas(atlas, name, 1)[0];
    if (hit?.kind === "stop") {
      pickStopAs(field, hit.stop);
      if (field === "from" && to) void plan({
        label: hit.stop.name,
        lon: hit.stop.lon,
        lat: hit.stop.lat,
        stopId: hit.stop.id,
      }, to);
      if (field === "to" && from) {
        void plan(from, {
          label: hit.stop.name,
          lon: hit.stop.lon,
          lat: hit.stop.lat,
          stopId: hit.stop.id,
        });
      }
    } else {
      if (field === "from") setFromQuery(name);
      else setToQuery(name);
    }
  }

  return (
    <div className="relative min-h-[100dvh] overflow-hidden bg-[#f5f5f7] text-[#1d1d1f]">
      <MapView
        city={city}
        atlas={atlas}
        focus={visit}
        selectedStop={selectedStop}
        selectedRouteId={selectedRouteId}
        itinerary={activeItinerary}
        onStop={(stop) => void openStop(stop)}
        onRoute={(id) => {
          setSelectedRouteId(id);
          setSelectedStop(null);
        }}
      />

      <div className="pointer-events-none absolute inset-0 z-[2]">
        <div className="pointer-events-auto absolute left-[max(0.75rem,env(safe-area-inset-left))] right-[max(7.5rem,calc(env(safe-area-inset-right)+7.25rem))] top-[max(0.65rem,env(safe-area-inset-top))]">
          <div className="glass flex max-w-full flex-wrap justify-start rounded-[22px] p-1 backdrop-blur-xl">
            {chips.map((item) => {
              const on = item.kind === "visit" ? visit?.id === item.id : item.city === city && !visit;
              return (
                <button
                  key={item.id}
                  type="button"
                  onClick={() => {
                    setCity(item.city);
                    setVisit(item.visit || null);
                    setAtlas(null);
                    setLoadError("");
                    setItineraries([]);
                    setChosen(null);
                    setSelectedStop(null);
                    setSelectedRouteId(null);
                    setFrom(null);
                    setTo(null);
                    setFromQuery("");
                    setToQuery("");
                    setDepartures([]);
                    setPlanError("");
                  }}
                  className={`shrink-0 rounded-full px-3 py-2 text-sm tracking-tight min-h-11 transition-colors duration-200 ease-[cubic-bezier(0.16,1,0.3,1)] focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[#0e7490] ${
                    on
                      ? "bg-[#0e7490] text-[#f0fdff]"
                      : "text-[#3f4d5c] hover:bg-black/5 hover:text-[#1a2430]"
                  }`}
                >
                  {item.label}
                </button>
              );
            })}
          </div>
        </div>

        <form
          onSubmit={onSearch}
          className="pointer-events-auto absolute left-4 top-36 w-[min(100%-2rem,380px)] md:left-6"
        >
          <div className="glass rounded-[28px] p-3 backdrop-blur-xl">
            <div className="flex items-center justify-between px-2 pb-2">
              <p className="text-[15px] font-medium tracking-tight">{tr("whereTo")}</p>
              <button
                type="button"
                onClick={locate}
                className="flex h-8 w-8 items-center justify-center rounded-full bg-white/8 text-[#1d1d1f]/80"
                aria-label="Utiliser ma position"
              >
                <Crosshair size={16} />
              </button>
            </div>
            <label className="mb-2 flex items-center gap-2 rounded-2xl bg-black/25 px-3 py-2.5">
              <PersonSimpleWalk size={16} className="text-[#7dcec3]" />
              <span className="sr-only">Départ</span>
              <input
                value={fromQuery}
                onChange={(e) => {
                  setFromQuery(e.target.value);
                  setFrom(null);
                  setActiveField("from");
                }}
                onFocus={() => setActiveField("from")}
                placeholder="De"
                className="w-full bg-transparent text-sm text-[#1d1d1f] outline-none placeholder:text-black/35"
              />
            </label>
            <label className="flex items-center gap-2 rounded-2xl bg-black/25 px-3 py-2.5">
              <MapPin size={16} className="text-sodium" />
              <span className="sr-only">Destination</span>
              <input
                value={toQuery}
                onChange={(e) => {
                  setToQuery(e.target.value);
                  setTo(null);
                  setActiveField("to");
                }}
                onFocus={() => setActiveField("to")}
                placeholder="Vers"
                className="w-full bg-transparent text-sm text-[#1d1d1f] outline-none placeholder:text-black/35"
              />
              <button
                type="submit"
                disabled={!from || !to || planning}
                className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-paper text-ink disabled:opacity-40"
                aria-label={tr("searchTrip")}
              >
                <MagnifyingGlass size={15} weight="bold" />
              </button>
            </label>

            {hits.length > 0 && (
              <ul className="mt-2 divide-y divide-white/8">
                {hits.map((hit) =>
                  hit.kind === "stop" ? (
                    <li key={`s-${hit.stop.id}`}>
                      <button
                        type="button"
                        onClick={() => {
                          const place = placeFromStop(hit.stop);
                          pickStopAs(activeField, hit.stop);
                          const nextFrom = activeField === "from" ? place : from;
                          const nextTo = activeField === "to" ? place : to;
                          if (nextFrom && nextTo) void plan(nextFrom, nextTo);
                          else void openStop(hit.stop);
                        }}
                        className="flex w-full items-center gap-3 px-2 py-2.5 text-left"
                      >
                        <MapPin size={16} className="text-[#1d1d1f]/50" />
                        <span className="min-w-0 flex-1">
                          <span className="block truncate text-sm">{hit.stop.name}</span>
                          {hit.stop.agencyId && (
                            <span className="block text-[11px] text-black/40">{hit.stop.agencyId}</span>
                          )}
                        </span>
                      </button>
                    </li>
                  ) : hit.kind === "poi" ? (
                    <li key={`p-${hit.poi.id}`}>
                      <button
                        type="button"
                        onClick={() => pickPoiAs(activeField, hit.poi)}
                        className="flex w-full items-center gap-3 px-2 py-2.5 text-left"
                      >
                        <MapPin size={16} className="text-[#d97706]" />
                        <span className="min-w-0 flex-1">
                          <span className="block truncate text-sm">{hit.poi.name}</span>
                          <span className="block text-[11px] text-black/40">
                            {hit.poi.category || "Point important"} · popularité {Math.round(hit.poi.popularity)}
                          </span>
                        </span>
                      </button>
                    </li>
                  ) : (
                    <li key={`r-${hit.route.id}`}>
                      <button
                        type="button"
                        onClick={() => setSelectedRouteId(hit.route.id)}
                        className="flex w-full items-center gap-3 px-2 py-2.5 text-left"
                      >
                        <RouteBadge route={hit.route} />
                        <span className="min-w-0 flex-1">
                          <span className="block truncate text-sm text-[#1d1d1f]/80">
                            {hit.route.longName || hit.route.shortName}
                          </span>
                          {hit.route.agencyId && (
                            <span className="block text-[11px] text-black/40">{hit.route.agencyId}</span>
                          )}
                        </span>
                      </button>
                    </li>
                  ),
                )}
              </ul>
            )}

            {!fromQuery && !toQuery && (
              <div className="mt-3 flex flex-wrap gap-2 px-1">
                {(cities.find((item) => item.id === city)?.hints || ["Ici", "Arrêts près d'ici"]).map((hint, index) => (
                  <button
                    key={hint}
                    type="button"
                    onClick={() => void applyHint(hint, index === 0 ? "from" : "to")}
                    className="rounded-full bg-white/8 px-3 py-1 text-xs text-[#1d1d1f]/75"
                  >
                    {hint}
                  </button>
                ))}
              </div>
            )}
          </div>
        </form>

        <div className="pointer-events-auto absolute bottom-4 left-4 right-4 md:right-auto md:w-[min(100%-2rem,400px)]">
          <AnimatePresence mode="wait">
            {selectedStop && (
              <motion.section
                key={selectedStop.id}
                initial={reduce ? false : { opacity: 0, y: 20 }}
                animate={{ opacity: 1, y: 0 }}
                exit={reduce ? undefined : { opacity: 0, y: 16 }}
                transition={{ duration: 0.45, ease: [0.32, 0.72, 0, 1] }}
                className="glass mb-3 rounded-[28px] p-5 backdrop-blur-xl"
              >
                <div className="flex items-start justify-between gap-3">
                  <div>
                    <h2 className="text-xl font-medium tracking-tight">{selectedStop.name}</h2>
                    <p className="mt-1 text-sm text-black/55">{tr("remoteHint")}</p>
                  </div>
                  <button
                    type="button"
                    onClick={() => setSelectedStop(null)}
                    className="flex h-8 w-8 items-center justify-center rounded-full bg-white/8"
                    aria-label={tr("close")}
                  >
                    <X size={14} />
                  </button>
                </div>
                <ul className="mt-4 space-y-3">
                  {departures.length === 0 && (
                    <li className="text-sm text-black/55">{tr("noPassages")}</li>
                  )}
                  {departures.map((row) => (
                    <li key={`${row.routeId}-${row.headsign}`} className="flex items-center gap-3">
                      <span
                        className="inline-flex min-w-12 items-center justify-center rounded-full px-2 py-1 text-xs font-semibold"
                        style={{ background: row.color, color: row.textColor }}
                      >
                        {row.shortName}
                      </span>
                      <div className="min-w-0 flex-1">
                        <p className="truncate text-sm">{row.headsign}</p>
                        <p className="font-mono text-[11px] text-black/40">
                          {(row.times && row.times.length > 0 ? row.times : [row.depart])
                            .slice(0, 5)
                            .map((t) => formatClock(t))
                            .join("  ")}
                          {row.agencyId ? `  ${row.agencyId}` : ""}
                        </p>
                      </div>
                      <span
                        className="font-medium"
                        style={{ color: row.color }}
                      >
                        {row.wait > 90 ? formatClock(row.depart) : formatRelative(row.wait)}
                      </span>
                    </li>
                  ))}
                </ul>
              </motion.section>
            )}
          </AnimatePresence>

          <AnimatePresence>
            {(planning || itineraries.length > 0 || planError) && (
              <motion.section
                initial={reduce ? false : { opacity: 0, y: 24 }}
                animate={{ opacity: 1, y: 0 }}
                exit={reduce ? undefined : { opacity: 0, y: 18 }}
                transition={{ duration: 0.5, ease: [0.32, 0.72, 0, 1] }}
                className="glass rounded-[28px] p-5 backdrop-blur-xl"
              >
                {planning && (
                  <p className="text-sm text-black/60">Lecture des horaires…</p>
                )}
                {planError && <p className="text-sm text-[#1d1d1f]">{planError}</p>}
                {itineraries.map((item) => {
                  const on = item.id === (chosen ?? itineraries[0]?.id);
                  const transit = item.legs.find((leg) => leg.kind === "transit");
                  return (
                    <button
                      key={item.id}
                      type="button"
                      onClick={() => setChosen(item.id)}
                      className={`mb-3 w-full rounded-[22px] p-4 text-left last:mb-0 ${
                        on ? "bg-white/10" : "bg-transparent"
                      }`}
                    >
                      <div className="flex items-end justify-between">
                        <p className="text-3xl font-medium tracking-tight">
                          {item.minutes} min
                        </p>
                        <p className="text-xs text-black/50">
                          {item.transfers === 0
                            ? tr("direct")
                            : `${item.transfers} ${tr("transfer")}`}
                        </p>
                      </div>
                      <div className="mt-3 flex flex-wrap items-center gap-2 text-sm">
                        {item.legs.map((leg, i) =>
                          leg.kind === "walk" ? (
                            <span key={i} className="inline-flex items-center gap-1 text-black/70">
                              <PersonSimpleWalk size={14} />
                              {leg.minutes} min
                            </span>
                          ) : leg.kind === "bike" ? (
                            <span key={i} className="inline-flex items-center gap-1 text-black/70">
                              {leg.system === "avelo" ? "àVélo" : "BIXI"} {leg.minutes} min
                            </span>
                          ) : leg.kind === "road" ? (
                            <span key={i} className="inline-flex items-center gap-1 text-black/70">
                              Auto {leg.minutes} min
                            </span>
                          ) : (
                            <span key={i} className="inline-flex items-center gap-2">
                              {i > 0 && <ArrowRight size={12} className="text-black/35" />}
                              <span
                                className="rounded-full px-2 py-0.5 text-xs font-semibold"
                                style={{ background: leg.color, color: leg.textColor }}
                              >
                                {leg.shortName}
                              </span>
                              <span className="text-black/70">
                                {leg.headsign}
                                {leg.agencyId ? ` · ${leg.agencyId}` : ""}
                              </span>
                            </span>
                          ),
                        )}
                      </div>
                      {transit && on && (
                        <p className="mt-3 font-mono text-[11px] text-black/40">
                          {formatClock(transit.depart)} → {formatClock(transit.arrive)}
                          {atlas ? ` · ${atlas.meta.agencyId}` : ""}
                        </p>
                      )}
                    </button>
                  );
                })}
              </motion.section>
            )}
          </AnimatePresence>

          {selectedRoute && !selectedStop && itineraries.length === 0 && (
            <section className="glass rounded-[28px] p-5 backdrop-blur-xl">
              <div className="flex items-center gap-3">
                <RouteBadge route={selectedRoute} />
                <div>
                  <h2 className="text-lg font-medium">{selectedRoute.shortName}</h2>
                  <p className="text-sm text-black/60">{selectedRoute.longName}</p>
                </div>
              </div>
            </section>
          )}
        </div>

        <div className="pointer-events-none absolute bottom-4 right-4 hidden items-end gap-3 text-[10px] text-black/45 md:flex">
          <span className="rounded-full bg-black/35 px-2 py-1">{gpuLabel}</span>
          {atlas && (
            <p className="max-w-xs text-right leading-relaxed">
              {atlas.meta.attribution} Mise à jour {atlas.meta.start}.
            </p>
          )}
        </div>
      </div>

      {!atlas && !loadError && (
        <div className="absolute inset-0 z-[3] flex items-center justify-center bg-ink">
          <p className="text-sm text-black/55">{tr("loading")}</p>
        </div>
      )}
      {loadError && (
        <div className="absolute inset-0 z-[3] flex items-center justify-center bg-ink p-6 text-center">
          <p className="max-w-sm text-sm text-[#1d1d1f]">{loadError}</p>
        </div>
      )}
    </div>
  );
}

function RouteBadge({ route }: { route: AtlasRoute }) {
  return (
    <span
      className="inline-flex min-w-12 items-center justify-center gap-1 rounded-full px-2 py-1 text-xs font-semibold"
      style={{ background: route.color, color: route.textColor }}
    >
      {modeIcon(route.type, "h-3 w-3")}
      {route.shortName}
    </span>
  );
}
