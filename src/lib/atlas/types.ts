/** City slugs are generated from public/data/index.json as feeds are added. */
export type CityId = string;

export type RouteDir = {
  id: 0 | 1;
  headsign: string;
  line: string;
  stops: string[];
  hops: number[];
};

export type AtlasRoute = {
  id: string;
  shortName: string;
  longName: string;
  type: number;
  color: string;
  textColor: string;
  agencyId: string;
  agencyName: string;
  dirs: RouteDir[];
  aliases?: string[];
  importance?: number;
};

export type AtlasStop = {
  id: string;
  code?: string;
  name: string;
  lat: number;
  lon: number;
  parent?: string;
  kind: number;
  wheel: number;
  agencyId?: string;
  routes: string[];
  children?: string[];
  aliases?: string[];
  importance?: number;
  popularity?: number;
};

export type AgencyMeta = {
  id: string;
  name: string;
  url: string;
  attribution: string;
  licenseUrl: string;
  sourceUrl: string;
};

export type CalendarService = {
  id: string;
  days: number[];
  start: string;
  end: string;
};

export type CalendarException = {
  id: string;
  date: string;
  type: number;
};

export type Transfer = {
  from: string;
  to: string;
  type: number;
  sec: number;
};

export type CityMeta = {
  city: CityId;
  name: string;
  agencyId: string;
  agencyName: string;
  agencyUrl: string;
  timezone: string;
  lang: string;
  phone: string;
  updated: string;
  start: string;
  end: string;
  version: string;
  attribution: string;
  licenseUrl: string;
  sourceUrl: string;
  agencies?: AgencyMeta[];
  center: [number, number];
  zoom: number;
  counts: {
    routes: number;
    stops: number;
    trips: number;
    services: number;
    timetableStops: number;
  };
};

export type Atlas = {
  meta: CityMeta;
  routes: AtlasRoute[];
  stops: AtlasStop[];
  calendar: CalendarService[];
  exceptions: CalendarException[];
  transfers: Transfer[];
  services: string[];
};

export type TimetableEntry = {
  r: string;
  h: string;
  d: number;
  s: number[];
  t: number[];
};

export type Timetable = Record<string, TimetableEntry[]>;

export type Place = {
  label: string;
  lon: number;
  lat: number;
  stopId?: string;
};

export type TripLeg =
  | {
      kind: "walk";
      minutes: number;
      meters: number;
      from: Place;
      to: Place;
    }
  | {
      kind: "bike";
      minutes: number;
      meters: number;
      system: "avelo" | "bixi";
      from: Place;
      to: Place;
    }
  | {
      kind: "road";
      minutes: number;
      meters: number;
      from: Place;
      to: Place;
    }
  | {
      kind: "transit";
      minutes: number;
      routeId: string;
      shortName: string;
      color: string;
      textColor: string;
      headsign: string;
      type: number;
      agencyId?: string;
      from: Place;
      to: Place;
      depart: number;
      arrive: number;
      stopIds: string[];
      line: string;
    };

export type Itinerary = {
  id: string;
  minutes: number;
  walkMeters: number;
  transfers: number;
  depart: number;
  arrive: number;
  legs: TripLeg[];
};
