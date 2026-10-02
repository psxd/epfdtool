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
//
// The yellow detailsBox has exactly ONE owner (this module): it shows a clicked
// entity's card, or the hover hint when nothing is selected. The "what is
// filtered" sentence deliberately does NOT live here - that is the blue
// #filterSummaryBox (filterSummary.js) - so the two panels never show the same
// text.
export const DETAILS_PLACEHOLDER_HTML =
  '<p class="placeholderText">Hover over or click nodes on the globe to inspect payload metadata.</p>';

export function showSatelliteDetails(sat) {
  const detailsBox = document.getElementById('detailsBox');
  if (detailsBox) detailsBox.innerHTML = satelliteClickHtml(sat);
}

export function showStationDetails(stn) {
  const detailsBox = document.getElementById('detailsBox');
  if (detailsBox) detailsBox.innerHTML = stationClickHtml(stn);
}

// Restore the yellow box to its idle hint. Called whenever the selection is
// dropped, so the box can never be left holding the previous entity's card.
export function showDetailsPlaceholder() {
  const detailsBox = document.getElementById('detailsBox');
  if (detailsBox) detailsBox.innerHTML = DETAILS_PLACEHOLDER_HTML;
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
    // "line to nowhere"). Resolved by NODE ID, not by name: a name can match a
    // different physical station than the one the link was filed against. The
    // current dataset drops 0 rows - this is the structural invariant for
    // future datasets.
    const satOk = new Set(store.rawData.satellites.map(s => s.id));
    const gsOk = new Set(store.rawData.stations.map(s => s.id));
    store.rawData.connections = store.rawData.connections.filter(c => satOk.has(c.sat_id) && gsOk.has(c.gs_id));
    updateDataSourceLabel();
    resetCountryNameCache();
    clearHoverCaches();

    const satConnectionMap = new Map();
    const stnConnectionMap = new Map();
    // ntc id per (ground-station, satellite) pair: connections.json rows may
    // carry `ntc_id` (string or array from the new pipeline) or nothing at
    // all (old files). First id wins; deterministic for a given triple.
    const ntcMap = new Map();
    // The pair key is a JSON pair, NOT two ids joined by a separator: ids embed
    // ITU names, which can contain any printable character, so any single
    // separator risks a collision.
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
      if (!satConnectionMap.has(c.sat_id)) satConnectionMap.set(c.sat_id, []);
      satConnectionMap.get(c.sat_id).push(c.gs_id);
      if (!stnConnectionMap.has(c.gs_id)) stnConnectionMap.set(c.gs_id, []);
      stnConnectionMap.get(c.gs_id).push(c.sat_id);
      const k = pairKey(c.gs_id, c.sat_id);
      if (!ntcMap.has(k)) {
        const ntc = pickNtc(c);
        if (ntc) ntcMap.set(k, ntc);
      }
    }
    const ntcOf = (gs, sat) => ntcMap.get(pairKey(gs, sat)) || '';
    for (const s of store.rawData.satellites) {
      s.ground_stations = [...new Set(satConnectionMap.get(s.id) || [])];
      s.lat = 0;
      s.lon = s.long_nom !== undefined && s.long_nom !== null ? s.long_nom : (s.lon ?? 0);
    }
    for (const stn of store.rawData.stations) {
      stn.satellites = [...new Set(stnConnectionMap.get(stn.id) || [])];
    }

    // Build lookup indexes once, all keyed by node id. Each link row also
    // carries the connection's ntc id list so hover rows can deep-link to the
    // ITU dashboard for the exact ground-station + satellite + ntc triple (same
    // URL from either side: GS hover row and SAT hover row use the same triple).
    store.satById.clear();
    store.stationById.clear();
    store.satsByGsId.clear();
    store.gsBySatId.clear();
    store.satLonById.clear();
    store.gsIdsByName.clear();
    store.satIdsByName.clear();
    store.ntcByGsSat.clear();
    for (const s of store.rawData.satellites) {
      store.satById.set(s.id, s);
      store.satLonById.set(s.id, s.lon);
      if (!store.satIdsByName.has(s.name)) store.satIdsByName.set(s.name, []);
      store.satIdsByName.get(s.name).push(s.id);
    }
    for (const stn of store.rawData.stations) {
      store.stationById.set(stn.id, stn);
      if (!store.gsIdsByName.has(stn.name)) store.gsIdsByName.set(stn.name, []);
      store.gsIdsByName.get(stn.name).push(stn.id);
    }
    // One entry per LINK, and every (gsId, satId) pair is unique in
    // connections.json, so these lists are exactly the beams drawn from that
    // node - the list length a user reads in the hover/card matches the beams
    // they see. No name-based de-duplication happens here: two stations that
    // share a name are different physical sites and each keeps its own list.
    for (const [gsId, satIds] of stnConnectionMap) {
      const gsName = (store.stationById.get(gsId) || {}).name || gsId;
      store.satsByGsId.set(gsId, [...new Set(satIds)].map(id => {
        const s = store.satById.get(id);
        return {
          id, name: s ? s.name : id, gsName,
          country: s ? (s.operator || s.satcountry || 'Unknown') : 'Unknown',
          ntcId: ntcOf(gsId, id),
        };
      }));
    }
    for (const [satId, gsIds] of satConnectionMap) {
      const satName = (store.satById.get(satId) || {}).name || satId;
      store.gsBySatId.set(satId, [...new Set(gsIds)].map(id => {
        const g = store.stationById.get(id);
        return {
          id, name: g ? g.name : id, satName,
          country: g ? (g.country || g.gscountry || 'Unknown') : 'Unknown',
          ntcId: ntcOf(id, satId),
        };
      }));
    }
    for (const [k, v] of ntcMap) store.ntcByGsSat.set(k, v);
    // One search entry per NODE (not per name), so the two SIDODADI sites and
    // the two INTELSAT6 335.5E slots are each separately searchable and each
    // selects its own node. `position` disambiguates the duplicate labels.
    store.searchIndex = [
      ...store.rawData.satellites.map(s => ({
        kind: 'sat', id: s.id, name: s.name, lcName: s.name.toLowerCase(),
        country: s.operator || s.satcountry || '',
        position: `lon ${s.lon}°`,
      })),
      ...store.rawData.stations.map(s => ({
        kind: 'stn', id: s.id, name: s.name, lcName: s.name.toLowerCase(),
        country: s.country || s.gscountry || '',
        position: `${s.lat}, ${s.lon}`,
      })),
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
