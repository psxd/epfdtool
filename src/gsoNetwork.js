// Dataset loading + click-details panels + lookup indexes.
// Indexes (built once) make every hover/filter O(1)-ish instead of O(N^2).
import { store } from './state.js';
import { populateCountryFilters, applyFilters } from './gsoFilters.js';
import { startBootAnimation } from './globe.js';
import { resetCountryNameCache } from './countryNorm.js';
import { clearHoverCaches, stationClickHtml, satelliteClickHtml } from './hoverText.js';

// Click on a node -> pin the SAME hover-box content into the left panel under
// the filters (detailsBox), with the satellite / ground-station list rows as
// clickable ITU dashboard links. Hover tooltips stay plain text (globe.gl
// tooltips are not clickable), so this left-panel card is where the custom
// URLs live.
export function showSatelliteDetails(sat) {
  const detailsBox = document.getElementById('detailsBox');
  if (detailsBox) detailsBox.innerHTML = satelliteClickHtml(sat);
}

export function showStationDetails(stn) {
  const detailsBox = document.getElementById('detailsBox');
  if (detailsBox) detailsBox.innerHTML = stationClickHtml(stn);
}

// Renders the grey dataset-version line under the filters
// ("<BR IFIC text>" + linked Source: ITU Space Explorer).
export function updateDataSourceLabel() {
  const versionEl = document.getElementById('dataVersion');
  if (versionEl) {
    const v = store.dataMeta && store.dataMeta.br_ific;
    versionEl.textContent = v ? String(v) : '';
  }
}

export async function loadData() {
  try {
    const [stationsRes, satellitesRes, connectionsRes, metaRes] = await Promise.all([
      fetch('./data/stations.json'),
      fetch('./data/satellites.json'),
      fetch('./data/connections.json'),
      fetch('./data/meta.json').catch(() => ({ json: () => ({}) })),
    ]);
    store.rawData.stations = await stationsRes.json();
    store.rawData.satellites = await satellitesRes.json();
    store.rawData.connections = await connectionsRes.json();
    store.dataMeta = await metaRes.json().catch(() => ({}));
    // Guarantee drawn beams == hover entries == real nodes: a connection row
    // whose endpoints don't resolve to an actual satellite / ground-station
    // node would draw a beam to a place with no dot and no hover entry (a
    // "line to nowhere"). Drop such rows up-front. The current dataset drops
    // 0 rows - this is the structural invariant for future datasets.
    const satOk = new Set(store.rawData.satellites.map(s => s.name));
    const gsOk = new Set(store.rawData.stations.map(s => s.name));
    store.rawData.connections = store.rawData.connections.filter(c => satOk.has(c.sat_name) && gsOk.has(c.gs_name));
    updateDataSourceLabel();
    resetCountryNameCache();
    clearHoverCaches();

    const satConnectionMap = new Map();
    const stnConnectionMap = new Map();
    // ntc id per (ground-station, satellite) pair: connections.json rows may
    // carry `ntc_id` (string or array from the new pipeline) or nothing at
    // all (old files). First id wins; deterministic for a given triple.
    const ntcMap = new Map();
    // The pair key is a JSON pair, NOT two names joined by a separator: names
    // come from the ITU export and can contain any printable character, so
    // any single separator (including a NUL escape) risks a collision
    // ("A B" + "C" vs "A" + "B C").
    const pairKey = (gs, sat) => JSON.stringify([gs, sat]);
    const pickNtc = (c) => {
      const v = c.ntc_id;
      const list = Array.isArray(v) ? v : (v === undefined || v === null ? [] : [v]);
      for (const x of list) {
        const s = String(x ?? '').trim();
        if (s && s.toLowerCase() !== 'nan') return s;
      }
      return '';
    };
    for (const c of store.rawData.connections) {
      if (!satConnectionMap.has(c.sat_name)) satConnectionMap.set(c.sat_name, []);
      satConnectionMap.get(c.sat_name).push(c.gs_name);
      if (!stnConnectionMap.has(c.gs_name)) stnConnectionMap.set(c.gs_name, []);
      stnConnectionMap.get(c.gs_name).push(c.sat_name);
      const k = pairKey(c.gs_name, c.sat_name);
      if (!ntcMap.has(k)) {
        const ntc = pickNtc(c);
        if (ntc) ntcMap.set(k, ntc);
      }
    }
    const ntcOf = (gs, sat) => ntcMap.get(pairKey(gs, sat)) || '';
    for (const s of store.rawData.satellites) {
      s.ground_stations = [...new Set(satConnectionMap.get(s.name) || [])];
      s.lat = 0;
      s.lon = s.long_nom !== undefined && s.long_nom !== null ? s.long_nom : (s.lon ?? 0);
    }
    for (const stn of store.rawData.stations) {
      stn.satellites = [...new Set(stnConnectionMap.get(stn.name) || [])];
    }

    // Build lookup indexes once. Each link row also carries the connection's
    // ntc id list so hover rows can deep-link to the ITU dashboard for the
    // exact ground-station + satellite + ntc triple (same URL from either
    // side: GS hover row and SAT hover row use the same triple).
    store.satByName.clear();
    store.stationByName.clear();
    store.satsByGsName.clear();
    store.gsBySatName.clear();
    store.satLonByName.clear();
    store.ntcByGsSat.clear();
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
        return { name: nm, country: s ? (s.operator || s.satcountry || 'Unknown') : 'Unknown', ntcId: ntcOf(gsName, nm) };
      }));
    }
    for (const [satName, gsNames] of satConnectionMap) {
      store.gsBySatName.set(satName, [...new Set(gsNames)].map(nm => {
        const g = store.stationByName.get(nm);
        return { name: nm, country: g ? (g.country || g.gscountry || 'Unknown') : 'Unknown', ntcId: ntcOf(nm, satName) };
      }));
    }
    store.ntcByGsSat.clear();
    for (const [k, v] of ntcMap) store.ntcByGsSat.set(k, v);
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
