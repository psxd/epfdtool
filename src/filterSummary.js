// Left-panel "Filtered View" summary. This is a caption to the stats block
// below (same muted grey as .statIntro), NOT a duplicate of the country detail:
// that detail moved into the count labels (#satelliteStatLabel /
// #stationStatLabel) fed with connected-endpoint counts by gsoFilters.
// This only names the SELECTED entity. With nothing selected it renders EMPTY -
// there is no "No filter applied" caption, and the whole section is hidden
// rather than showing a placeholder sentence. The yellow #detailsBox below it is
// owned solely by the click renderers in gsoNetwork and shows either the
// entity's detail card or the hover hint - never this text, so the same
// sentence can never appear twice on screen.
import { store } from './state.js';

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

// The selected-entity caption. If no entity is selected the country detail
// lives only in the count labels, so this returns '' and the section is hidden.
export function filterSummaryText() {
  const status = selectValue('filterStatus');
  const sel = store.selection;
  // A satellite and a ground station can share a name, and store.selection.kind
  // is the authority on which one was clicked - so resolve the row by KIND, and
  // by ID within that kind (a name can match two real nodes).
  const selRow = sel
    ? (sel.kind === 'sat' ? store.satById.get(sel.id) : store.stationById.get(sel.id))
    : null;

  if (selRow) {
    const kindLabel = sel.kind === 'sat' ? 'satellite' : 'ground station';
    // Two nodes can share a name, so the position is named too - otherwise the
    // caption is ambiguous about which of them is selected.
    const where = sel.kind === 'sat'
      ? ` at ${selRow.lon}°`
      : ` at ${selRow.lat}, ${selRow.lon}`;
    return 'Showing ' + kindLabel + ' (' + selRow.name + where + ').' + filingClause(status);
  }

  return '';
}

const SUMMARY_TEXT_STYLE = 'margin: 0; font-size: 13px; line-height: 1.45; color: #111111;';
const SUMMARY_NAME_STYLE = SUMMARY_TEXT_STYLE + ' font-weight: 600;';

// Repaint the caption line and the Clear button. Returns the text it wrote.
// Deliberately does NOT touch #detailsBox - the yellow box belongs to the click
// renderers (gsoNetwork) so the same sentence can never appear in both places.
export function updateFilterSummary() {
  const text = filterSummaryText();
  const box = document.getElementById('filterSummaryBox');
  const section = document.getElementById('filterSummarySection');
  // With no entity selected there is nothing to say, so the section is hidden
  // outright - no "No filter applied" placeholder is ever rendered.
  if (section) section.style.display = text ? '' : 'none';
  if (box) {
    if (!text) {
      box.innerHTML = '';
    } else {
      // Stat-section caption: grey 13px caption, with the entity name bolded
      // when one is selected, mirroring .statIntro / .statLabel styling.
      const sel = store.selection;
      if (sel) {
        const open = text.indexOf('(');
        const close = text.indexOf(')');
        const before = text.slice(0, open);
        const name = text.slice(open, close + 1);
        const after = text.slice(close + 1);
        const style = 'style="' + SUMMARY_TEXT_STYLE + '"';
        const nameStyle = 'style="' + SUMMARY_NAME_STYLE + '" class="filterSummaryName"';
        box.innerHTML = '<p ' + style + '>' + escapeHtml(before) + '<span ' + nameStyle + '>' + escapeHtml(name) + '</span>' + escapeHtml(after) + '</p>';
      } else {
        box.innerHTML = '<p style="' + SUMMARY_TEXT_STYLE + '">' + escapeHtml(text) + '</p>';
      }
    }
  }
  // The Clear button only exists while something is selected.
  const clearBtn = document.getElementById('clearSelectionBtn');
  if (clearBtn) clearBtn.style.display = store.selection ? 'inline-block' : 'none';
  return text;
}