// GSO search (index-based, debounced) + restored zoom buttons + view toggle.
import { store } from './state.js';
import { requestApplyFilters, applyFilters } from './gsoFilters.js';
import { focusCameraOn, zoomBy } from './globe.js';
import { showSatelliteDetails, showStationDetails } from './gsoNetwork.js';
import { renderStraightLinkBeams } from './links.js';
import { setSatellites } from './globe.js';

export function setupUIEvents() {
  const searchInput = document.getElementById('searchInput');
  const filterStatus = document.getElementById('filterStatus');
  const filterSatCountry = document.getElementById('filterSatCountry');
  const filterGsCountry = document.getElementById('filterGsCountry');
  const suggestionBox = document.getElementById('searchSuggestions');
  const viewToggleBtn = document.getElementById('viewToggleBtn');
  const zoomInBtn = document.getElementById('zoomInBtn');
  const zoomOutBtn = document.getElementById('zoomOutBtn');

  if (zoomInBtn) zoomInBtn.addEventListener('click', () => zoomBy(0.75));
  if (zoomOutBtn) zoomOutBtn.addEventListener('click', () => zoomBy(1.33));

  if (viewToggleBtn) {
    let isHorizonView = false;
    viewToggleBtn.addEventListener('click', () => {
      isHorizonView = !isHorizonView;
      if (isHorizonView) {
        focusCameraOn(25, -100, 1.2);
        viewToggleBtn.textContent = '◎';
        viewToggleBtn.title = 'Switch to overhead globe view';
      } else {
        focusCameraOn(15, 15, 12);
        viewToggleBtn.textContent = '◠';
        viewToggleBtn.title = 'Toggle globe / horizon view';
      }
    });
  }

  if (filterStatus) filterStatus.addEventListener('change', () => requestApplyFilters(true));
  if (filterSatCountry) filterSatCountry.addEventListener('change', () => requestApplyFilters(true));
  if (filterGsCountry) filterGsCountry.addEventListener('change', () => requestApplyFilters(true));

  if (searchInput) {
    let deb = 0;
    searchInput.addEventListener('input', (e) => {
      clearTimeout(deb);
      deb = setTimeout(() => onGsoSearchInput(e, searchInput, suggestionBox, filterStatus, filterSatCountry, filterGsCountry), 120);
    });
    document.addEventListener('click', (e) => {
      if (suggestionBox && searchInput && !searchInput.contains(e.target) && !suggestionBox.contains(e.target)) {
        suggestionBox.style.display = 'none';
      }
    });
  }
}

function onGsoSearchInput(e, searchInput, suggestionBox, filterStatus, filterSatCountry, filterGsCountry) {
  const val = e.target.value.toLowerCase().trim();
  if (val.length === 0) {
    if (suggestionBox) suggestionBox.style.display = 'none';
    return;
  }
  const sats = [];
  const stns = [];
  for (const entry of store.searchIndex) {
    if (!entry.lcName.includes(val)) continue;
    if (entry.kind === 'sat' && sats.length < 5) sats.push(entry);
    else if (entry.kind === 'stn' && stns.length < 5) stns.push(entry);
    if (sats.length >= 5 && stns.length >= 5) break;
  }
  let html = '';
  for (const s of sats) html += `<div class="suggestion-item" data-type="sat" data-name="${s.name}" style="padding: 10px 14px; cursor: pointer; border-bottom: 1px solid #eee; font-size: 13px; color: #111;">🛰️ <b>${s.name}</b> (Satellite)</div>`;
  for (const s of stns) html += `<div class="suggestion-item" data-type="stn" data-name="${s.name}" style="padding: 10px 14px; cursor: pointer; border-bottom: 1px solid #eee; font-size: 13px; color: #111;">📡 <b>${s.name}</b> (${s.country || 'Ground Station'})</div>`;
  if (html && suggestionBox) {
    suggestionBox.innerHTML = html;
    suggestionBox.style.display = 'block';
    suggestionBox.querySelectorAll('.suggestion-item').forEach(item => {
      item.addEventListener('click', () => pickGsoSuggestion(item, searchInput, suggestionBox, filterStatus, filterSatCountry, filterGsCountry));
    });
  } else if (suggestionBox) {
    suggestionBox.style.display = 'none';
  }
}

function pickGsoSuggestion(item, searchInput, suggestionBox, filterStatus, filterSatCountry, filterGsCountry) {
  const type = item.getAttribute('data-type');
  const name = item.getAttribute('data-name');
  searchInput.value = name;
  suggestionBox.style.display = 'none';
  if (filterStatus) filterStatus.value = 'all';
  if (filterSatCountry) filterSatCountry.value = 'all';
  if (filterGsCountry) filterGsCountry.value = 'all';
  applyFilters(false);
  if (type === 'sat') {
    const sat = store.satByName.get(name);
    if (sat) {
      setSatellites([sat]);
      store.world.pointsData([]);
      renderStraightLinkBeams([]);
      showSatelliteDetails(sat);
      focusCameraOn(sat.lat || 0, sat.lon, 2.0);
    }
  } else {
    const stn = store.stationByName.get(name);
    if (stn) {
      store.world.pointsData([stn]);
      setSatellites([]);
      renderStraightLinkBeams([]);
      showStationDetails(stn);
      focusCameraOn(stn.lat, stn.lon, 1.25);
    }
  }
}
