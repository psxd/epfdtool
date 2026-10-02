// GSO search (index-based, debounced) + restored zoom buttons + view toggle.
import { store } from './state.js';
import { requestApplyFilters, applyFilters } from './gsoFilters.js';
import { focusCameraOn, zoomBy, selectEntity, clearSelection, DEFAULT_VIEW } from './globe.js';
import { showDetailsPlaceholder } from './gsoNetwork.js';

// Maps the two clickable filing-box states onto the hidden #filterStatus
// select: both on or both off -> 'all'; only Planned on -> 'planned';
// only Non-Planned on -> 'nonplanned'. The select stays the source of
// truth so serializeFilters / normalizeFilter / comment URLs are unchanged.
export function syncFilingBoxes() {
  const plannedBtn = document.getElementById('filingPlanned');
  const nonPlannedBtn = document.getElementById('filingNonPlanned');
  const sel = document.getElementById('filterStatus');
  const v = sel ? sel.value : 'all';
  if (plannedBtn) plannedBtn.setAttribute('aria-pressed', v === 'planned' || v === 'all' ? 'true' : 'false');
  if (nonPlannedBtn) nonPlannedBtn.setAttribute('aria-pressed', v === 'nonplanned' || v === 'all' ? 'true' : 'false');
}

function filingValueFromBoxes(plannedOn, nonPlannedOn) {
  if (plannedOn && nonPlannedOn) return 'all';
  if (plannedOn) return 'planned';
  if (nonPlannedOn) return 'nonplanned';
  return 'all';
}

function setupFilingBoxes() {
  const plannedBtn = document.getElementById('filingPlanned');
  const nonPlannedBtn = document.getElementById('filingNonPlanned');
  const sel = document.getElementById('filterStatus');
  if (!plannedBtn || !nonPlannedBtn || !sel) return;
  syncFilingBoxes();
  for (const btn of [plannedBtn, nonPlannedBtn]) {
    btn.addEventListener('click', () => {
      const next = btn.getAttribute('aria-pressed') !== 'true';
      btn.setAttribute('aria-pressed', next ? 'true' : 'false');
      const plannedOn = plannedBtn.getAttribute('aria-pressed') === 'true';
      const nonPlannedOn = nonPlannedBtn.getAttribute('aria-pressed') === 'true';
      sel.value = filingValueFromBoxes(plannedOn, nonPlannedOn);
      syncFilingBoxes();
      requestApplyFilters(true);
    });
  }
}

export function setupUIEvents() {
  const searchInput = document.getElementById('searchInput');
  const filterStatus = document.getElementById('filterStatus');
  const filterSatCountry = document.getElementById('filterSatCountry');
  const filterGsCountry = document.getElementById('filterGsCountry');
  const suggestionBox = document.getElementById('searchSuggestions');
  const viewToggleBtn = document.getElementById('viewToggleBtn');
  const zoomInBtn = document.getElementById('zoomInBtn');
  const zoomOutBtn = document.getElementById('zoomOutBtn');

  setupFilingBoxes();

  if (zoomInBtn) zoomInBtn.addEventListener('click', () => zoomBy(0.75));
  if (zoomOutBtn) zoomOutBtn.addEventListener('click', () => zoomBy(1.33));

  // Reset = back to the INITIAL BOOT VIEW: every dropdown filter cleared
  // (full dataset restored), camera at the default wide view, search box +
  // details card cleared. Filtering still only ever happens through the left
  // filter box.
  const resetViewBtn = document.getElementById('resetViewBtn');
  if (resetViewBtn) {
    resetViewBtn.addEventListener('click', () => {
      if (store.isLeoActive) return; // LEO tab has its own Reset View button
      if (searchInput) searchInput.value = '';
      if (filterStatus) filterStatus.value = 'all';
      if (filterSatCountry) filterSatCountry.value = 'all';
      if (filterGsCountry) filterGsCountry.value = 'all';
      syncFilingBoxes();
      clearSelection();
      applyFilters(false);
      showDetailsPlaceholder();
      focusCameraOn(DEFAULT_VIEW.lat, DEFAULT_VIEW.lng, DEFAULT_VIEW.altitude);
    });
  }

  // Clear button next to the "Filtered View" summary: drops only the entity
  // selection (country / filing filters stay applied), and the search box is
  // emptied to match so the two never disagree about what is selected.
  const clearSelectionBtn = document.getElementById('clearSelectionBtn');
  if (clearSelectionBtn) {
    clearSelectionBtn.addEventListener('click', () => {
      clearSelection();
      if (searchInput) searchInput.value = '';
      applyFilters(false);
    });
  }

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
      deb = setTimeout(() => {
        if (e.target.value.trim().length === 0) {
          // Empty box = no entity selected: restore the full filtered beam set.
          // Only touch the selection here; the country filters are untouched.
          if (store.selection) clearSelection();
          if (suggestionBox) suggestionBox.style.display = 'none';
          return;
        }
        onGsoSearchInput(e, searchInput, suggestionBox);
      }, 120);
    });
    // Enter picks the top suggestion of whichever kind it belongs to, so a typed
    // name selects + highlights + zooms without needing the mouse.
    searchInput.addEventListener('keydown', (e) => {
      if (e.key !== 'Enter' || !suggestionBox) return;
      const first = suggestionBox.querySelector('.suggestion-item');
      if (!first) return;
      e.preventDefault();
      first.click();
    });
    // Escape abandons the search: clears the box and the selection.
    searchInput.addEventListener('keydown', (e) => {
      if (e.key !== 'Escape') return;
      searchInput.value = '';
      if (suggestionBox) suggestionBox.style.display = 'none';
      clearSelection();
    });
    document.addEventListener('click', (e) => {
      if (suggestionBox && searchInput && !searchInput.contains(e.target) && !suggestionBox.contains(e.target)) {
        suggestionBox.style.display = 'none';
      }
    });
  }
}

function escapeHtml(s) {
  return String(s ?? '')
    .replace(/&/g, '&amp;').replace(/</g, '&lt;')
    .replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

// Node ids embed ITU names, so they must be attribute-escaped before being
// written into a data- attribute.
function escapeAttr(s) {
  return escapeHtml(s).replace(/'/g, '&#39;');
}

function onGsoSearchInput(e, searchInput, suggestionBox) {
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
  for (const s of sats) html += `<div class="suggestion-item" data-type="sat" data-id="${escapeAttr(s.id)}" style="padding: 10px 14px; cursor: pointer; border-bottom: 1px solid #eee; font-size: 13px; color: #111;">🛰️ <b>${escapeHtml(s.name)}</b> (Satellite · ${escapeHtml(s.position)})</div>`;
  for (const s of stns) html += `<div class="suggestion-item" data-type="stn" data-id="${escapeAttr(s.id)}" style="padding: 10px 14px; cursor: pointer; border-bottom: 1px solid #eee; font-size: 13px; color: #111;">📡 <b>${escapeHtml(s.name)}</b> (${escapeHtml(s.country || 'Ground Station')} · ${escapeHtml(s.position)})</div>`;
  if (html && suggestionBox) {
    suggestionBox.innerHTML = html;
    suggestionBox.style.display = 'block';
    suggestionBox.querySelectorAll('.suggestion-item').forEach(item => {
      item.addEventListener('click', () => pickGsoSuggestion(item, searchInput, suggestionBox));
    });
  } else if (suggestionBox) {
    suggestionBox.style.display = 'none';
  }
}

// Picking a search result is the SAME action as clicking the node on the globe:
// the entity's links are highlighted + thickened, every other link is hidden,
// the blue box names it and the camera zooms to it (all inside selectEntity).
// The country / filing filters are NOT changed, so this stays a look-up and
// never rewrites the filtered node set.
// Selected by NODE ID: a name can map to two real nodes (120 station names and
// 2 satellite names are each filed twice), so the suggestion carries the exact
// id and picks that specific site.
function pickGsoSuggestion(item, searchInput, suggestionBox) {
  const type = item.getAttribute('data-type');
  const id = item.getAttribute('data-id');
  const row = type === 'sat' ? store.satById.get(id) : store.stationById.get(id);
  if (!row) return;
  searchInput.value = row.name;
  suggestionBox.style.display = 'none';
  if (type === 'sat') selectEntity('sat', row);
  else selectEntity('gs', row);
}
