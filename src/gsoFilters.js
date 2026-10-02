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

  let gsScopedSatIds = null;
  if (hasGs) {
    gsScopedSatIds = new Set();
    for (const stn of filteredStations) {
      const links = store.satsByGsId.get(stn.id);
      if (links) for (const l of links) gsScopedSatIds.add(l.id);
    }
  }
  const filteredSatellites = store.rawData.satellites.filter(sat => {
    const isPlanned = sat.planned === true || sat.planned === 1 || sat.planned === '1' || sat.planned === 'true';
    if (filterStatus === 'planned' && !isPlanned) return false;
    if (filterStatus === 'nonplanned' && isPlanned) return false;
    if (hasSat && normalizeCountryName(sat.operator || sat.satcountry || '') !== targetSat) return false;
    if (gsScopedSatIds && !gsScopedSatIds.has(sat.id)) return false;
    return true;
  });

  if (hasSat) {
    const activeSatIds = new Set(filteredSatellites.map(s => s.id));
    const validGsIds = new Set();
    for (const conn of store.rawData.connections) {
      if (activeSatIds.has(conn.sat_id)) validGsIds.add(conn.gs_id);
    }
    filteredStations = filteredStations.filter(stn => validGsIds.has(stn.id));
  }

  // NO de-duplication by name. Rows in the source are already unique per node
  // POSITION, and two rows sharing a name are two genuinely different sites
  // that each keep their own beams - collapsing them by name is what used to
  // drop a station off the globe and desync the list from the drawn lines. The
  // row lists in hoverText are likewise per node id, never per name.
  const visibleStations = filteredStations;
  const visibleSatellites = filteredSatellites;

  // A link is drawn iff BOTH of its exact endpoint nodes survived the filter,
  // so the beams are exactly the union of the per-node lists shown to the user.
  const finalActiveSatIds = new Set(visibleSatellites.map(s => s.id));
  const stationIdSet = new Set(visibleStations.map(s => s.id));
  const filteredConnections = [];
  for (const conn of store.rawData.connections) {
    if (finalActiveSatIds.has(conn.sat_id) && stationIdSet.has(conn.gs_id)) filteredConnections.push(conn);
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
      ? visibleSatellites.some(s => s.id === sel.id)
      : visibleStations.some(s => s.id === sel.id);
    if (stillVisible) {
      const row = sel.kind === 'sat' ? store.satById.get(sel.id) : store.stationById.get(sel.id);
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

  // Counts are the endpoints of the DRAWN LINES, not the drawn node arrays, and
  // they are counted as DISTINCT NAMES so the figure reads as "unique entities"
  // (the two SIDODADI sites are one entity name shown at two positions). A
  // satellite that passes the dropdown filters but has no surviving link is not
  // on the globe either, so counting it would report a total the viewer cannot
  // see. Deriving both from filteredConnections also keeps the two numbers
  // consistent with each other: a country filter narrows the LINKS and both
  // sides follow from them (GS=France shows only satellites wired to French
  // stations).
  const connectedSatIds = new Set(filteredConnections.map(c => c.sat_id));
  const connectedGsIds = new Set(filteredConnections.map(c => c.gs_id));
  const connectedSatNames = new Set();
  for (const id of connectedSatIds) {
    const s = store.satById.get(id);
    if (s) connectedSatNames.add(s.name);
  }
  const connectedGsNames = new Set();
  for (const id of connectedGsIds) {
    const stn = store.stationById.get(id);
    if (stn) connectedGsNames.add(stn.name);
  }
  const satStat = document.getElementById('satelliteStat');
  const stnStat = document.getElementById('stationStat');
  const satLabel = document.getElementById('satelliteStatLabel');
  const stnLabel = document.getElementById('stationStatLabel');
  const satCount = connectedSatNames.size.toLocaleString();
  const stnCount = connectedGsNames.size.toLocaleString();
  if (satStat) satStat.textContent = satCount;
  if (stnStat) stnStat.textContent = stnCount;
  // The country is named ONLY when that dimension is actually filtered, so a bare
  // total is never shown beside a filtered figure. The big .statNumber holds
  // the figure, so the label below it is just the unit + optional country.
  if (satLabel) satLabel.textContent = 'satellites' + (hasSat ? ' in ' + satCountry : '');
  if (stnLabel) stnLabel.textContent = 'ground stations' + (hasGs ? ' in ' + gsCountry : '');

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
