// Dataset loading + click-details panels + lookup indexes.
// Indexes (built once) make every hover/filter O(1)-ish instead of O(N^2).
import { store } from './state.js';
import { populateCountryFilters, applyFilters } from './gsoFilters.js';
import { startBootAnimation } from './globe.js';
import { resetCountryNameCache } from './countryNorm.js';
import { clearHoverCaches } from './hoverText.js';

export function showSatelliteDetails(sat) {
  const isPlanned = sat.planned === true || sat.planned === 1 || sat.planned === '1' || sat.planned === 'true';
  const status = isPlanned ? 'Planned' : 'Non-Planned';
  const links = store.gsBySatName.get(sat.name) || [];
  const countries = [...new Set(links.map(l => l.country).filter(Boolean))];
  const detailsBox = document.getElementById('detailsBox');
  if (detailsBox) {
    detailsBox.innerHTML =
      `<strong>${sat.name} (${status})</strong><br>` +
      `Operator Country: ${sat.operator || sat.satcountry || 'Unknown'}<br>` +
      `Nominal Longitude: ${sat.lon}°<br>` +
      `Active Ground Station Links: ${links.length}` +
      (countries.length ? ` (${countries.join(', ')})` : '');
  }
}

export function showStationDetails(stn) {
  const links = store.satsByGsName.get(stn.name) || [];
  const countries = [...new Set(links.map(l => l.country).filter(Boolean))];
  const detailsBox = document.getElementById('detailsBox');
  if (detailsBox) {
    detailsBox.innerHTML =
      `<strong>${stn.name}</strong> (${stn.operator || 'Unknown'})<br>` +
      `Country: ${stn.country || stn.gscountry || 'Unknown'}<br>` +
      `Lat/Lon: ${stn.lat.toFixed(2)}°, ${stn.lon.toFixed(2)}°<br>` +
      `Connected Satellites: ${links.length}` +
      (countries.length ? ` (${countries.join(', ')})` : '');
  }
}

export async function loadData() {
  try {
    const [stationsRes, satellitesRes, connectionsRes, exceptionsRes] = await Promise.all([
      fetch('./data/stations.json'),
      fetch('./data/satellites.json'),
      fetch('./data/connections.json'),
      fetch('./data/exceptions.json').catch(() => ({ json: () => ({}) })),
    ]);
    store.rawData.stations = await stationsRes.json();
    store.rawData.satellites = await satellitesRes.json();
    store.rawData.connections = await connectionsRes.json();
    store.countryExceptions = await exceptionsRes.json().catch(() => ({}));
    resetCountryNameCache();
    clearHoverCaches();

    const satConnectionMap = new Map();
    const stnConnectionMap = new Map();
    for (const c of store.rawData.connections) {
      if (!satConnectionMap.has(c.sat_name)) satConnectionMap.set(c.sat_name, []);
      satConnectionMap.get(c.sat_name).push(c.gs_name);
      if (!stnConnectionMap.has(c.gs_name)) stnConnectionMap.set(c.gs_name, []);
      stnConnectionMap.get(c.gs_name).push(c.sat_name);
    }
    for (const s of store.rawData.satellites) {
      s.ground_stations = [...new Set(satConnectionMap.get(s.name) || [])];
      s.lat = 0;
      s.lon = s.long_nom !== undefined && s.long_nom !== null ? s.long_nom : (s.lon ?? 0);
    }
    for (const stn of store.rawData.stations) {
      stn.satellites = [...new Set(stnConnectionMap.get(stn.name) || [])];
    }

    // Build lookup indexes once.
    store.satByName.clear();
    store.stationByName.clear();
    store.satsByGsName.clear();
    store.gsBySatName.clear();
    store.satLonByName.clear();
    for (const s of store.rawData.satellites) {
      store.satByName.set(s.name, s);
      store.satLonByName.set(s.name, s.lon);
    }
    for (const stn of store.rawData.stations) {
      store.stationByName.set(stn.name, stn);
    }
    for (const [gsName, satNames] of stnConnectionMap) {
      store.satsByGsName.set(gsName, [...new Set(satNames)].map(nm => {
        const s = store.satByName.get(nm);
        return { name: nm, country: s ? (s.operator || s.satcountry || 'Unknown') : 'Unknown' };
      }));
    }
    for (const [satName, gsNames] of satConnectionMap) {
      store.gsBySatName.set(satName, [...new Set(gsNames)].map(nm => {
        const g = store.stationByName.get(nm);
        return { name: nm, country: g ? (g.country || g.gscountry || 'Unknown') : 'Unknown' };
      }));
    }
    store.searchIndex = [
      ...store.rawData.satellites.map(s => ({ kind: 'sat', name: s.name, lcName: s.name.toLowerCase(), country: s.operator || s.satcountry || '' })),
      ...store.rawData.stations.map(s => ({ kind: 'stn', name: s.name, lcName: s.name.toLowerCase(), country: s.country || s.gscountry || '' })),
    ];

    populateCountryFilters(store.rawData.satellites, store.rawData.stations);
    applyFilters(false);
    // Scene is fully populated (stations + satellites + links + country
    // polygons) - NOW let the intro flight play, so nothing pops in mid-move.
    startBootAnimation();
  } catch (err) {
    console.error('Dataset loading error:', err);
    const detailsBox = document.getElementById('detailsBox');
    if (detailsBox) detailsBox.innerHTML = '<p style="color: #d9534f; margin:0;">Error loading dataset from ./data/ folder.</p>';
    // Never leave the camera parked at the intro altitude because the data
    // failed - release the flight anyway (it is a no-op if already played).
    startBootAnimation();
  }
}
