/**
 * Coordinate handling. Our wire strings are "lat,lng"; OSRM URLs are "lng,lat".
 * Parse once into a LatLng and only ever build OSRM coordinates via toOsrmCoord().
 * A swap usually still returns "Ok" from OSRM, but routes somewhere absurd.
 */

export interface LatLng {
  readonly lat: number;
  readonly lng: number;
}

/**
 * A recorded rider point, as used by /match. `unixSeconds` is optional: ONDC /on_track breadcrumbs
 * (via ondc-logistics-api) carry no per-point time, and /match then works on geometry alone.
 */
export interface TimedPoint {
  readonly point: LatLng;
  readonly sequence: number;
  readonly unixSeconds?: number | undefined;
}

/**
 * Breadcrumb sequence: a finite number, or a numeric string as ONDC tags carry it ("3").
 * Returns null for anything else (empty string, "abc", NaN).
 */
export function parseSequence(value: unknown): number | null {
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  if (typeof value === "string" && /^\s*-?\d+(\.\d+)?\s*$/.test(value)) return Number(value);
  return null;
}

/** Parse our "lat,lng" format. Returns null for anything malformed or out of range. */
export function parseLatLng(value: unknown): LatLng | null {
  if (typeof value !== "string") return null;
  const parts = value.split(",");
  if (parts.length !== 2) return null;
  const [latRaw, lngRaw] = parts as [string, string];
  if (latRaw.trim() === "" || lngRaw.trim() === "") return null;
  const lat = Number(latRaw);
  const lng = Number(lngRaw);
  if (!Number.isFinite(lat) || !Number.isFinite(lng)) return null;
  if (lat < -90 || lat > 90 || lng < -180 || lng > 180) return null;
  return { lat, lng };
}

/** Back to our "lat,lng" wire format. */
export function formatLatLng(p: LatLng): string {
  return `${p.lat},${p.lng}`;
}

/** OSRM URL coordinate: lng FIRST. */
export function toOsrmCoord(p: LatLng): string {
  return `${p.lng},${p.lat}`;
}

/** Coverage box: the area our OSRM map covers. Same order as osmium/OSRM_BBOX: minLng,minLat,maxLng,maxLat. */
export interface Bbox {
  readonly minLng: number;
  readonly minLat: number;
  readonly maxLng: number;
  readonly maxLat: number;
}

/** Parse "minLng,minLat,maxLng,maxLat". Returns null for anything malformed or inverted. */
export function parseBbox(value: unknown): Bbox | null {
  if (typeof value !== "string") return null;
  const parts = value.split(",");
  if (parts.length !== 4 || parts.some((p) => p.trim() === "")) return null;
  const [minLng, minLat, maxLng, maxLat] = parts.map(Number) as [number, number, number, number];
  if (![minLng, minLat, maxLng, maxLat].every(Number.isFinite)) return null;
  if (minLng >= maxLng || minLat >= maxLat) return null;
  if (minLat < -90 || maxLat > 90 || minLng < -180 || maxLng > 180) return null;
  return { minLng, minLat, maxLng, maxLat };
}

/**
 * Is the point inside the box? Also catches most lat/lng swaps for NCR: a swapped
 * "77.04,28.43" parses as lat 77, far outside the box.
 */
export function isInBbox(p: LatLng, b: Bbox): boolean {
  return p.lat >= b.minLat && p.lat <= b.maxLat && p.lng >= b.minLng && p.lng <= b.maxLng;
}

/** The covered area: one box per region (NCR, Bengaluru, …). Separate road networks in one map. */
export type Coverage = readonly Bbox[];

/**
 * Parse "box;box;…" (each "minLng,minLat,maxLng,maxLat"), same syntax as OSRM_BBOX in
 * ops/osrm/prep.Dockerfile. A single box is still valid. Returns null if any box is malformed.
 */
export function parseCoverage(value: unknown): Coverage | null {
  if (typeof value !== "string" || value.trim() === "") return null;
  const boxes = value.split(";").map((s) => parseBbox(s.trim()));
  return boxes.every((b): b is Bbox => b !== null) ? boxes : null;
}

/** Inside any of the boxes? Lat/lng swaps still fall outside every Indian-city box. */
export function isCovered(p: LatLng, coverage: Coverage): boolean {
  return coverage.some((b) => isInBbox(p, b));
}

const EARTH_RADIUS_M = 6_371_008.8;

export function haversineMeters(a: LatLng, b: LatLng): number {
  const rad = Math.PI / 180;
  const dLat = (b.lat - a.lat) * rad;
  const dLng = (b.lng - a.lng) * rad;
  const h =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(a.lat * rad) * Math.cos(b.lat * rad) * Math.sin(dLng / 2) ** 2;
  return 2 * EARTH_RADIUS_M * Math.asin(Math.min(1, Math.sqrt(h)));
}
