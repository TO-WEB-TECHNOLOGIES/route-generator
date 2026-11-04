/**
 * Google encoded polyline, precision 5. This must match OSRM `geometries=polyline` and the app's
 * decoder. Do NOT switch to precision 6 (`polyline6`) without a versioned contract change.
 */
import type { LatLng } from "./point.js";

const FACTOR = 1e5;

function encodeValue(value: number): string {
  let v = value < 0 ? ~(value << 1) : value << 1;
  let out = "";
  while (v >= 0x20) {
    out += String.fromCharCode((0x20 | (v & 0x1f)) + 63);
    v >>= 5;
  }
  return out + String.fromCharCode(v + 63);
}

export function encodePolyline(points: readonly LatLng[]): string {
  let prevLat = 0;
  let prevLng = 0;
  let out = "";
  for (const p of points) {
    const lat = Math.round(p.lat * FACTOR);
    const lng = Math.round(p.lng * FACTOR);
    out += encodeValue(lat - prevLat) + encodeValue(lng - prevLng);
    prevLat = lat;
    prevLng = lng;
  }
  return out;
}

export function decodePolyline(encoded: string): LatLng[] {
  const points: LatLng[] = [];
  let index = 0;
  let lat = 0;
  let lng = 0;
  const next = (): number => {
    let result = 0;
    let shift = 0;
    let byte: number;
    do {
      if (index >= encoded.length) throw new Error("Truncated polyline");
      byte = encoded.charCodeAt(index++) - 63;
      result |= (byte & 0x1f) << shift;
      shift += 5;
    } while (byte >= 0x20);
    return result & 1 ? ~(result >> 1) : result >> 1;
  };
  while (index < encoded.length) {
    lat += next();
    lng += next();
    points.push({ lat: lat / FACTOR, lng: lng / FACTOR });
  }
  return points;
}

/** Append `tail` to `head`, dropping consecutive duplicates where the pieces join. */
export function joinPaths(head: readonly LatLng[], tail: readonly LatLng[]): LatLng[] {
  const out = [...head];
  for (const p of tail) {
    const last = out[out.length - 1];
    if (last && last.lat === p.lat && last.lng === p.lng) continue;
    out.push(p);
  }
  return out;
}
