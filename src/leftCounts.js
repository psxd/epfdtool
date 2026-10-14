// Left-panel counts shared by filters + selection.
// Rule (user-approved):
//  * No selection            -> totals from the DRAWN (filtered) link set,
//                               counted as distinct names (SIDODADI = 1 entity).
//  * Sat selected (click/search) -> 1 space station + N earth stations where N
//                               is exactly the rows in its left-panel card.
//  * GS selected                 -> M space stations (card rows) + 1 earth station.
// The card lists themselves are filtered to the drawn beams (store.linkMeta),
// so "rows in the card" == "entities connected by the highlighted links" even
// when a filing/country dropdown is active. This module only imports store, so
// globe/gsoFilters/hoverText can all use it without import cycles.
import { store } from './state.js';

// Drawn-beam pair lookup: linkMeta holds the filtered connection rows that were
// actually rendered (see renderStraightLinkBeams). Filtering the card lists to
// these ids makes hover cards, click cards, counts and highlighted beams agree.
function drawnGsIdSetForSat(satId) {
  const meta = store.linkMeta;
  if (!meta || !meta.count) return null; // not loaded yet -> caller falls back to full list
  const set = new Set();
  const mSat = meta.satId;
  const mGs = meta.gsId;
  for (let i = 0; i < meta.count; i++) {
    if (mSat[i] === satId) set.add(mGs[i]);
  }
  return set;
}

function drawnSatIdSetForGs(gsId) {
  const meta = store.linkMeta;
  if (!meta || !meta.count) return null;
  const set = new Set();
  const mSat = meta.satId;
  const mGs = meta.gsId;
  for (let i = 0; i < meta.count; i++) {
    if (mGs[i] === gsId) set.add(mSat[i]);
  }
  return set;
}

// Card-row lists, filtered to drawn beams. Length == card header number.
// Falls back to the full per-node list before the first render (linkMeta null)
// or when the drawn set is empty.
export function filteredStationsForSat(satId) {
  const all = store.gsBySatId.get(satId) || [];
  const drawn = drawnGsIdSetForSat(satId);
  if (!drawn) return all;
  if (drawn.size === 0) return [];
  return all.filter((g) => drawn.has(g.id));
}

export function filteredSatsForGs(gsId) {
  const all = store.satsByGsId.get(gsId) || [];
  const drawn = drawnSatIdSetForGs(gsId);
  if (!drawn) return all;
  if (drawn.size === 0) return [];
  return all.filter((s) => drawn.has(s.id));
}

export function writeLeftCounts(satNum, stnNum, satLabel, stnLabel) {
  const satStat = document.getElementById('satelliteStat');
  const stnStat = document.getElementById('stationStat');
  const satLabelEl = document.getElementById('satelliteStatLabel');
  const stnLabelEl = document.getElementById('stationStatLabel');
  if (satStat) satStat.textContent = Number(satNum).toLocaleString();
  if (stnStat) stnStat.textContent = Number(stnNum).toLocaleString();
  if (satLabelEl && satLabel !== undefined) satLabelEl.textContent = satLabel;
  if (stnLabelEl && stnLabel !== undefined) stnLabelEl.textContent = stnLabel;
}

function dropdownContext() {
  const satCountry = document.getElementById('filterSatCountry')?.value || 'all';
  const gsCountry = document.getElementById('filterGsCountry')?.value || 'all';
  return {
    hasSat: satCountry !== 'all',
    hasGs: gsCountry !== 'all',
    satCountry,
    gsCountry,
  };
}

// Selection path: count = exactly the card rows. Selected side is always 1,
// the other side is the filtered list length (== card header number).
export function updateLeftCountsForSelection(kind, id) {
  if (kind === 'sat') {
    const n = filteredStationsForSat(id).length;
    writeLeftCounts(1, n, 'space station (selected)', n === 1 ? 'linked earth station' : 'linked earth stations');
  } else {
    const m = filteredSatsForGs(id).length;
    writeLeftCounts(m, 1, m === 1 ? 'linked space station' : 'linked space stations', 'earth station (selected)');
  }
}

// No-selection path: totals from the drawn (filtered) connections, distinct
// names so the figure reads as unique entities. Kept here so select/clear and
// applyFilters all write through the same helper.
export function updateLeftCountsNoSelection(filteredConnections) {
  const { hasSat, hasGs, satCountry, gsCountry } = dropdownContext();
  const connectedSatIds = new Set();
  const connectedGsIds = new Set();
  for (const c of filteredConnections) {
    connectedSatIds.add(c.sat_id);
    connectedGsIds.add(c.gs_id);
  }
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
  writeLeftCounts(
    connectedSatNames.size,
    connectedGsNames.size,
    'space stations' + (hasSat ? ' in ' + satCountry : ''),
    'earth stations' + (hasGs ? ' in ' + gsCountry : ''),
  );
}

// Clear-selection path: totals from the CURRENTLY DRAWN beams (linkMeta),
// distinct names. Used when a click/search selection is dropped without
// changing the dropdowns, so no re-filter is needed.
export function updateLeftCountsFromDrawnBeams() {
  const { hasSat, hasGs, satCountry, gsCountry } = dropdownContext();
  const meta = store.linkMeta;
  const satNames = new Set();
  const gsNames = new Set();
  if (meta && meta.count) {
    for (let i = 0; i < meta.count; i++) {
      const s = store.satById.get(meta.satId[i]);
      if (s) satNames.add(s.name);
      const g = store.stationById.get(meta.gsId[i]);
      if (g) gsNames.add(g.name);
    }
  }
  writeLeftCounts(
    satNames.size,
    gsNames.size,
    'space stations' + (hasSat ? ' in ' + satCountry : ''),
    'earth stations' + (hasGs ? ' in ' + gsCountry : ''),
  );
}
