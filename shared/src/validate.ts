import type { World } from "./index.ts";

function requireValue(ok: unknown, message: string): asserts ok {
  if (!ok) throw new Error(message);
}

function object(value: unknown, path: string): Record<string, unknown> {
  requireValue(value !== null && typeof value === "object" && !Array.isArray(value), `${path} must be an object`);
  return value as Record<string, unknown>;
}

function shape(value: unknown, path: string, required: string[], optional: string[] = []) {
  const result = object(value, path);
  requireValue(required.every(key => Object.hasOwn(result, key)), `${path} is missing required fields`);
  requireValue(Object.keys(result).every(key => required.includes(key) || optional.includes(key)), `${path} has unknown fields`);
  return result;
}

function text(value: unknown, path: string): asserts value is string {
  requireValue(typeof value === "string" && value.trim().length > 0 && value.length <= 2000, `${path} must be nonempty text (up to 2000 characters)`);
}

function number(value: unknown, path: string, min: number, max: number) {
  requireValue(typeof value === "number" && Number.isFinite(value) && value >= min && value <= max, `${path} must be a number from ${min} to ${max}`);
}

function strings(value: unknown, path: string) {
  requireValue(Array.isArray(value) && value.length <= 200, `${path} must be a list of up to 200 strings`);
  value.forEach((v, i) => text(v, `${path}[${i}]`));
  return value as string[];
}

function entries(value: unknown, path: string) {
  const result = object(value, path);
  requireValue(Object.keys(result).length <= 2000, `${path} has too many entries`);
  for (const key of Object.keys(result)) {
    requireValue(/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(key) && key.length <= 100 && !["constructor", "prototype"].includes(key), `${path}: invalid identifier ${key}`);
  }
  return Object.entries(result);
}

export function validateBbox(value: unknown): asserts value is [number, number, number, number] {
  requireValue(Array.isArray(value) && value.length === 4, "bbox must contain south, west, north, east");
  number(value[0], "bbox south", -90, 90);
  number(value[1], "bbox west", -180, 180);
  number(value[2], "bbox north", -90, 90);
  number(value[3], "bbox east", -180, 180);
  requireValue(value[0] < value[2] && value[1] < value[3], "bbox must have south < north and west < east");
}

export function validateWorld(value: unknown): asserts value is World {
  const world = shape(value, "world", ["regions", "cities", "areas", "defaultCity"]);
  const regions = object(world.regions, "regions");
  for (const [id, value] of entries(regions, "regions")) {
    const path = `regions.${id}`;
    const r = shape(value, path, ["title", "origin", "headingDeg", "country", "municipalities", "credits"], ["airport"]);
    text(r.title, `${path}.title`);
    text(r.country, `${path}.country`);
    const o = shape(r.origin, `${path}.origin`, ["lat", "lon", "h"]);
    number(o.lat, `${path}.origin.lat`, -90, 90);
    number(o.lon, `${path}.origin.lon`, -180, 180);
    number(o.h, `${path}.origin.h`, -12000, 10000);
    number(r.headingDeg, `${path}.headingDeg`, 0, 359.999999);
    strings(r.municipalities, `${path}.municipalities`);
    const credits = strings(r.credits, `${path}.credits`).join("\n");
    requireValue(credits.includes("© OpenStreetMap contributors"), `${path}.credits must credit © OpenStreetMap contributors`);
    requireValue(credits.includes("Copernicus DEM") && credits.includes("DLR") && credits.includes("Airbus"), `${path}.credits must retain the Copernicus DEM, DLR and Airbus credit`);
    requireValue(credits.includes("Painted with AI"), `${path}.credits must include Painted with AI`);
    if (r.airport !== undefined) {
      const a = shape(r.airport, `${path}.airport`, ["lat", "lon", "runwayHeadingDeg"]);
      number(a.lat, `${path}.airport.lat`, -90, 90);
      number(a.lon, `${path}.airport.lon`, -180, 180);
      number(a.runwayHeadingDeg, `${path}.airport.runwayHeadingDeg`, 0, 359.999999);
    }
  }
  for (const [id, value] of entries(world.cities, "cities")) {
    const path = `cities.${id}`;
    const c = shape(value, path, ["title", "region", "center", "widthM"]);
    text(c.title, `${path}.title`);
    text(c.region, `${path}.region`);
    requireValue(Object.hasOwn(regions, c.region), `${path}.region does not exist`);
    requireValue(Array.isArray(c.center) && c.center.length === 2, `${path}.center must be [latitude, longitude]`);
    number(c.center[0], `${path}.center latitude`, -90, 90);
    number(c.center[1], `${path}.center longitude`, -180, 180);
    number(c.widthM, `${path}.widthM`, 0.01, 300000);
  }
  for (const [id, value] of entries(world.areas, "areas")) {
    const path = `areas.${id}`;
    const a = shape(value, path, ["title", "region", "bbox"]);
    text(a.title, `${path}.title`);
    text(a.region, `${path}.region`);
    requireValue(Object.hasOwn(regions, a.region), `${path}.region does not exist`);
    validateBbox(a.bbox);
  }
  text(world.defaultCity, "defaultCity");
  requireValue(Object.hasOwn(object(world.cities, "cities"), world.defaultCity), "defaultCity does not exist");
}
