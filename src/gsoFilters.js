// Country dropdowns + combined filtering + smart camera.
// Camera framing comes from countryView.filterView: a filtered country is
// framed from its real GeoJSON polygons (and from the filtered ground stations
// when the dataset has no polygon for that name), so switching a country in
// either dropdown always moves the view onto what got highlighted.
import { store } from './state.js';
import { normalizeCountryName } from './countryNorm.js';
import { updateHighlightedCountriesCache } from './countryHi.js';
import { filterView } from './countryView.js';
import { focusCameraOn, setSatellites, selectEntity } from './globe.js';
import { renderStraightLinkBeams, setFilterBeamHighlight } from './links.js';
import { updateFilterSummary } from './filterSummary.js';

export function populateCountryFilters(satellites, stations) {
  const satCountrySelect = document.getElementById('filterSatCountry');
  const gsCountrySelect = document.getElementById('filterGsCountry');
  if (satCountrySelect) {
    satCountrySelect.innerHTML = '<option value="all">All Countries</option>';
    const satCountries = [...new Set(satellites.map(s => s.operator || s.satcountry).filter(Boolean))].sort();
    for (const country of satCountries) {
      const option = document.createElement('option');
      option.value = country;
      option.textContent = country;
      satCountrySelect.appendChild(option);
    }
  }
  if (gsCountrySelect) {
    gsCountrySelect.innerHTML = '<option value="all">All Countries</option>';
    const gsCountries = [...new Set(stations.map(stn => stn.country || stn.gscountry).filter(Boolean))].sort();
    for (const country of gsCountries) {
      const option = document.createElement('option');
      option.value = country;
      option.textContent = country;
      gsCountrySelect.appendChild(option);
    }
  }
}

let filterTimer = 0;
export function requestApplyFilters(adjustView = true) {
  clearTimeout(filterTimer);
  filterTimer = setTimeout(() => applyFilters(adjustView), 60);
}

export function applyFilters(adjustView = true) {
  if (store.isLeoActive || !store.world) return;
  const filterStatus = document.getElementById('filterStatus')?.value || 'all';
  const satCountry = document.getElementById('filterSatCountry')?.value || 'all';
  const gsCountry = document.getElementById('filterGsCountry')?.value || 'all';
  const hasSat = satCountry !== 'all';
  const hasGs = gsCountry !== 'all';

  updateHighlightedCountriesCache();

  const targetGs = hasGs ? normalizeCountryName(gsCountry) : null;
  const targetSat = hasSat ? normalizeCountryName(satCountry) : null;

  let filteredStations = hasGs
    ? store.rawData.stations.filter(stn => normalizeCountryName(stn.country || stn.gscountry || '') === targetGs)
    : store.rawData.stations;

  let gsScopedSatNames = null;
  if (hasGs) {
    gsScopedSatNames = new Set();
    for (const stn of filteredStations) {
      const links = store.satsByGsName.get(stn.name);
      if (links) for (const l of links) gsScopedSatNames.add(l.name);
    }
  }
  const filteredSatellites = store.rawData.satellites.filter(sat => {
    const isPlanned = sat.planned === true || sat.planned === 1 || sat.planned === '1' || sat.planned === 'true';
    if (filterStatus === 'planned' && !isPlanned) return false;
    if (filterStatus === 'nonplanned' && isPlanned) return false;
    if (hasSat && normalizeCountryName(sat.operator || sat.satcountry || '') !== targetSat) return false;
    if (gsScopedSatNames && !gsScopedSatNames.has(sat.name)) return false;
    return true;
  });

  if (hasSat) {
    const activeSatNames = new Set(filteredSatellites.map(s => s.name));
    const validGsNames = new Set();
    for (const conn of store.rawData.connections) {
      if (activeSatNames.has(conn.sat_name)) validGsNames.add(conn.gs_name);
    }
    filteredStations = filteredStations.filter(stn => validGsNames.has(stn.name));
  }

  // Dedupe rows by name before they reach the scene, the beam intersection
  // and the stat counters: the source files carry duplicate rows (120 station
  // names appear twice, e.g. SIDODADI; 2 satellites likewise), while hover +
  // click only ever resolve ONE row per name (last one wins in
  // stationByName/satByName). Counting raw rows inflated the left-panel
  // totals above the unique satellites / ground stations actually shown.
  // `filteredSatellites` is a const above, so the deduped rows get their own
  // names rather than a reassignment.
  const visibleStations = [...new Map(filteredStations.map(s => [s.name, s])).values()];
  const visibleSatellites = [...new Map(filteredSatellites.map(s => [s.name, s])).values()];

  const finalActiveSatNames = new Set(visibleSatellites.map(s => s.name));
  const stationSet = new Set(visibleStations.map(s => s.name));
  const filteredConnections = [];
  for (const conn of store.rawData.connections) {
    if (finalActiveSatNames.has(conn.sat_name) && stationSet.has(conn.gs_name)) filteredConnections.push(conn);
  }

  store.world.pointsData(visibleStations);
  setSatellites(visibleSatellites);
  renderStraightLinkBeams(filteredConnections, true);

  // Beam emphasis for the new state. renderStraightLinkBeams reset every flag
  // (the beam set was rebuilt), so the highlight has to be re-applied:
  //  * an entity is still selected -> re-select it. If the filter just removed
  //    it from view, the selection is dropped instead, so a stale highlight can
  //    never point at something that is no longer on the globe.
  //  * otherwise any active country / filing filter paints and thickens every
  //    drawn beam (the filtered rows already ARE the filtered set).
  //  * no filter and no selection -> plain grey beams.
  const sel = store.selection;
  if (sel) {
    const stillVisible = sel.kind === 'sat'
      ? visibleSatellites.some(s => s.name === sel.name)
      : visibleStations.some(s => s.name === sel.name);
    if (stillVisible) {
      const row = sel.kind === 'sat' ? store.satByName.get(sel.name) : store.stationByName.get(sel.name);
      selectEntity(sel.kind, row, { zoom: false });
    } else {
      store.selection = null;
      setFilterBeamHighlight(hasSat || hasGs || filterStatus !== 'all');
    }
  } else {
    setFilterBeamHighlight(hasSat || hasGs || filterStatus !== 'all');
  }

  // Re-push the SAME feature array so three-globe re-runs the cap/stroke
  // color accessors against the fresh highlight sets. This is required:
  // without it the accessors are never re-evaluated and no country ever
  // repaints. It is cheap and glitch-free now: altitude is constant 0 for
  // every polygon (no geometry re-extrusion) and polygonsTransitionDuration
  // is 0 (no morph tween).
  if (store.world && store.cachedGeoJsonFeatures.length > 0) {
    store.world.polygonsData(store.cachedGeoJsonFeatures);
  }

  const satStat = document.getElementById('satelliteStat');
  const stnStat = document.getElementById('stationStat');
  if (satStat) satStat.textContent = visibleSatellites.length.toLocaleString();
  if (stnStat) stnStat.textContent = visibleStations.length.toLocaleString();

  updateFilterSummary();

  if (adjustView) {
    const view = filterView({
      hasGs, hasSat, targetSat,
      stations: visibleStations,
      satellites: visibleSatellites,
    });
    if (view) focusCameraOn(view.lat, view.lng, view.altitude);
  }
}
