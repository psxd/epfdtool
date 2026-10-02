// Left-panel "Filtered View" summary: one plain-English sentence describing
// exactly what is on the globe right now.
//
// It lives ONLY in #filterSummaryBox (the blue panel section). The yellow
// #detailsBox below it is owned solely by the click renderers in gsoNetwork
// (showSatelliteDetails / showStationDetails) and shows either a selected
// entity's detail card or the hover hint - never this text, so the same
// sentence can never appear twice on screen.
import { store } from './state.js';

export const NO_FILTER_TEXT = 'No filter applied';

function escapeHtml(s) {
  return String(s ?? '')
    .replace(/&/g, '&amp;').replace(/</g, '&lt;')
    .replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function selectValue(id) {
  const el = document.getElementById(id);
  const v = el ? el.value : 'all';
  return !v || v === 'all' ? '' : String(v);
}

function filingClause(status) {
  if (status === 'planned') return ' Planned filings only.';
  if (status === 'nonplanned') return ' Non-planned filings only.';
  return '';
}

// The full sentence for the current state.
export function filterSummaryText() {
  const satCountry = selectValue('filterSatCountry');
  const gsCountry = selectValue('filterGsCountry');
  const status = selectValue('filterStatus');
  const sel = store.selection;
  // A satellite and a ground station can share a name, and store.selection.kind
  // is the authority on which one was clicked - so resolve the row by KIND, not
  // by whichever lookup happens to match first.
  const selRow = sel
    ? (sel.kind === 'sat' ? store.satByName.get(sel.name) : store.stationByName.get(sel.name))
    : null;

  if (selRow) {
    // "Showing satellite (NAME)." on its own, or scoped by whatever filters are
    // also set. Labelling the kind matters: the name alone does not say whether
    // it is a spacecraft or a ground station.
    const kindLabel = sel.kind === 'sat' ? 'satellite' : 'ground station';
    let scope = '';
    if (satCountry && gsCountry) {
      scope = ` within satellites operated by (${satCountry}) having links with ground stations in (${gsCountry})`;
    } else if (satCountry) {
      scope = ` within satellites operated by (${satCountry})`;
    } else if (gsCountry) {
      scope = ` within ground stations operated by (${gsCountry})`;
    }
    return `Showing ${kindLabel} (${selRow.name})${scope}.${filingClause(status)}`;
  }

  if (!satCountry && !gsCountry && !status) return NO_FILTER_TEXT;

  let text;
  if (satCountry && gsCountry) {
    text = `Showing satellites operated by (${satCountry}) having links with ground stations in (${gsCountry}).`;
  } else if (satCountry) {
    text = `Showing satellites operated by (${satCountry}).`;
  } else if (gsCountry) {
    text = `Showing ground stations operated by (${gsCountry}).`;
  } else {
    text = 'Showing all satellites.';
  }
  return text + filingClause(status);
}

const SUMMARY_TEXT_STYLE = 'margin: 0; font-size: 13px; line-height: 1.45; color: #111111;';

// Repaint the blue summary box and the Clear button. Returns the text it wrote.
// Deliberately does NOT touch #detailsBox - the yellow box belongs to the click
// renderers (gsoNetwork) so the same sentence can never appear in both places.
export function updateFilterSummary() {
  const text = filterSummaryText();
  const box = document.getElementById('filterSummaryBox');
  if (box) box.innerHTML = `<p style="${SUMMARY_TEXT_STYLE}">${escapeHtml(text)}</p>`;
  // The Clear button only exists while something is selected.
  const clearBtn = document.getElementById('clearSelectionBtn');
  if (clearBtn) clearBtn.style.display = store.selection ? 'inline-block' : 'none';
  return text;
}