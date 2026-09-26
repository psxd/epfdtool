// Camera framing from the HIGHLIGHTED countries' real GeoJSON polygons.
// Single country: fit main landmass + close neighbours only.
// Multi-country (USA sat filter): fit across each country's largest polygon so
// one far-flung territory cannot stretch the view across the planet.
import { store } from './state.js';
import { normalizeCountryName } from './countryNorm.js';

export const DEG = Math.PI / 180;

function eachPolygon(geometry) {
  if (!geometry) return [];
  if (geometry.type === 'Polygon') return [geometry.coordinates];
  if (geometry.type === 'MultiPolygon') return geometry.coordinates;
  return [];
}

function ringCenter(ring) {
  let sinSum = 0, cosSum = 0, latSum = 0;
  const n = ring.length || 1;
  for (const [lon, lat] of ring) {
    const r = lon * DEG;
    sinSum += Math.sin(r); cosSum += Math.cos(r); latSum += lat;
  }
  const lng = ((Math.atan2(sinSum / n, cosSum / n) / DEG + 540) % 360) - 180;
  return { lat: latSum / n, lng };
}
function ringRadius(ring, center) {
  let max = 0;
  for (const [lon, lat] of ring) {
    let dLon = Math.abs(lon - center.lng);
    if (dLon > 180) dLon = 360 - dLon;
    const d = Math.hypot(lat - center.lat, dLon * Math.cos(center.lat * DEG));
    if (d > max) max = d;
  }
  return max;
}

// Circular (antimeridian-safe) mean longitude.
function circularMeanLon(lons) {
  let sinSum = 0, cosSum = 0;
  for (const lon of lons) { const r = lon * DEG; sinSum += Math.sin(r); cosSum += Math.cos(r); }
  const n = lons.length || 1;
  return ((Math.atan2(sinSum / n, cosSum / n) / DEG + 540) % 360) - 180;
}

// Bounding-box fit of a lon/lat cloud: centre = box centre (not the vertex
// average - that lets Alaska/Hawaii drag the USA view north-west), radius =
// half-diagonal of the box.
function fitLonLat(lons, lats) {
  if (!lons.length) return null;
  const ref = circularMeanLon(lons);
  let minLon = Infinity, maxLon = -Infinity, minLat = Infinity, maxLat = -Infinity;
  for (let i = 0; i < lons.length; i++) {
    let lon = lons[i];
    while (lon - ref > 180) lon -= 360;
    while (lon - ref < -180) lon += 360;
    if (lon < minLon) minLon = lon;
    if (lon > maxLon) maxLon = lon;
    const lat = lats[i];
    if (lat < minLat) minLat = lat;
    if (lat > maxLat) maxLat = lat;
  }
  const lat = (minLat + maxLat) / 2;
  const lng = ((minLon + maxLon) / 2 + 540) % 360 - 180;
  const theta = Math.max(Math.hypot((maxLat - minLat) / 2, ((maxLon - minLon) / 2) * Math.cos(lat * DEG)), 2.5);
  return { lat, lng, thetaDeg: theta };
}

// Fit a view around the given canonical country keys. Used for the current
// highlight set and (for wide satellite footprints) for a single country.
export function viewForKeys(keys) {
  if (!keys || keys.size === 0 || store.cachedGeoJsonFeatures.length === 0) return null;
  const boxes = [];
  for (const key of keys) {
    const feature = store.cachedGeoJsonFeatures.find(
      f => f.properties && normalizeCountryName(f.properties.name) === key
    );
    if (!feature) continue;
    const polys = eachPolygon(feature.geometry).filter(p => p[0] && p[0].length > 0);
    if (polys.length === 0) continue;
    if (keys.size === 1) {
      let main = polys[0];
      let mainR = -1;
      const info = polys.map(poly => {
        const c = ringCenter(poly[0]);
        const r = ringRadius(poly[0], c);
        if (r > mainR) { mainR = r; main = poly; }
        return { poly, c };
      });
      const mainC = ringCenter(main[0]);
      const reach = Math.max(18, mainR * 3.2);
      const lons = [];
      const lats = [];
      for (const { poly, c } of info) {
        let dLon = Math.abs(c.lng - mainC.lng);
        if (dLon > 180) dLon = 360 - dLon;
        const dist = Math.hypot(c.lat - mainC.lat, dLon * Math.cos(mainC.lat * DEG));
        if (dist > reach) continue;
        for (const [lon, lat] of poly[0]) { lons.push(lon); lats.push(lat); }
      }
      if (lons.length > 0) boxes.push(fitLonLat(lons, lats));
    } else {
      let best = null;
      let bestR = -1;
      for (const poly of polys) {
        const c = ringCenter(poly[0]);
        const r = ringRadius(poly[0], c);
        if (r > bestR) { bestR = r; best = { c, r }; }
      }
      if (best) boxes.push({ lat: best.c.lat, lng: best.c.lng, thetaDeg: best.r });
    }
  }
  if (boxes.length === 0) return null;
  if (boxes.length === 1) return boxes[0];
  let sinSum = 0, cosSum = 0, latSum = 0;
  for (const b of boxes) {
    const r = b.lng * DEG;
    sinSum += Math.sin(r); cosSum += Math.cos(r); latSum += b.lat;
  }
  const n = boxes.length;
  const lng = ((Math.atan2(sinSum / n, cosSum / n) / DEG + 540) % 360) - 180;
  const lat = latSum / n;
  let theta = 0;
  for (const b of boxes) {
    let dLon = Math.abs(b.lng - lng);
    if (dLon > 180) dLon = 360 - dLon;
    const d = Math.hypot(b.lat - lat, dLon * Math.cos(lat * DEG)) + (b.thetaDeg || 0);
    if (d > theta) theta = d;
  }
  return { lat, lng, thetaDeg: theta };
}

export function highlightView() {
  return viewForKeys(store.currentHighlightedSet);
}

// A footprint wider than this cannot be framed as "a country view" - the
// camera then frames the country the user actually picked instead.
const SPREAD_LIMIT_DEG = 55;

function asCameraTarget(view) {
  return view ? { lat: view.lat, lng: view.lng, altitude: altitudeForTheta(view.thetaDeg) } : null;
}

// ver1 rule for a GS-country filter with no polygon for that name: frame the
// filtered ground stations themselves (ver1 used the mean of their lat/lon).
function stationFallback(stations) {
  if (!stations || stations.length === 0) return null;
  let latSum = 0;
  const lons = [];
  for (const s of stations) { latSum += s.lat; lons.push(s.lon); }
  return {
    lat: latSum / stations.length,
    lng: circularMeanLon(lons),
    altitude: stations.length === 1 ? 1.25 : 1.55,
  };
}

// ver1 rule for a sat-country filter: GSO belt (lat 0) at the fleet's mean
// longitude. Circular mean, so fleets straddling the antimeridian are framed
// correctly (ver1's arithmetic mean sent those to longitude 0).
function satelliteFallback(satellites) {
  if (!satellites || satellites.length === 0) return null;
  return { lat: 0, lng: circularMeanLon(satellites.map(s => s.lon || 0)), altitude: 1.9 };
}

// Camera target for the active country filters.
//  * GS country filtered  -> that country's polygon(s); if the dataset has no
//    polygon for it, fall back to its ground stations (ver1).
//  * sat country filtered -> the whole highlighted footprint when it is
//    compact; otherwise the picked country's own polygon; otherwise ver1's
//    GSO-belt view.
export function filterView({ hasGs, hasSat, targetSat, stations = [], satellites = [] }) {
  const footprint = highlightView();
  if (hasGs) return asCameraTarget(footprint) || stationFallback(stations);
  if (hasSat) {
    if (footprint && (footprint.thetaDeg || 0) <= SPREAD_LIMIT_DEG) return asCameraTarget(footprint);
    const own = targetSat ? viewForKeys(new Set([targetSat])) : null;
    return asCameraTarget(own) || satelliteFallback(satellites);
  }
  return null;
}

export function altitudeForTheta(thetaDeg) {
  const theta = Math.max(thetaDeg || 0, 2.5);
  const padded = Math.min(70, theta * 1.3 + 0.8);
  const alt = Math.sin((padded + 25) * DEG) / Math.sin(25 * DEG) - 1;
  return Math.min(2.6, Math.max(0.3, alt));
}
