import data from "./world.json" with { type: "json" };
import { validateWorld } from "./validate.ts";

export interface Region {
  title: string;
  /** Fixed once tiles exist: moving this moves the whole map. */
  origin: { lat: number; lon: number; h: number };
  headingDeg: number;
  country: string;
  municipalities: string[];
  airport?: { lat: number; lon: number; runwayHeadingDeg: number };
  credits: string[];
}

export interface City {
  title: string;
  region: string;
  /** Latitude, longitude. */
  center: [number, number];
  widthM: number;
}

export interface Area {
  title: string;
  region: string;
  /** South, west, north, east (WGS84). */
  bbox: [number, number, number, number];
}

export interface World {
  regions: Record<string, Region>;
  cities: Record<string, City>;
  areas: Record<string, Area>;
  defaultCity: string;
}

validateWorld(data);
export const WORLD: World = data;
export const REGIONS = WORLD.regions;
export const CITIES = WORLD.cities;
export const AREAS = WORLD.areas;
export const DEFAULT_CITY = WORLD.defaultCity;
