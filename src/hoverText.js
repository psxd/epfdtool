// Cached hover/tooltip HTML builders.
//
// GS hover: satellite list shows "SAT (Country)" per row.
// SAT hover: ground-station list shows "STATION (Country)" per row.
// Rows are UNCAPPED (one row per drawn link beam — hover must list exactly
// what the globe draws) + HTML escaped; the list header carries the total
// count in parentheses; per-entity caching keeps hover at ~O(1).
//
// NOTE: globe.gl renders these as pointer-tracking HTML tooltips, which are
// NOT clickable (making them hoverable causes flicker as they steal the
// mouse). So hover rows stay plain text here; the clickable ITU dashboard
// links for the same triples live in the left-panel click card (stationClickHtml
// / satelliteClickHtml below, same dashboardUrl + same link styling).
import { store } from './state.js';

const ITU_DASHBOARD_BASE = 'https://www.itu.int/itu-r/space/apps/public/spaceexplorer/networks-explorer/earth-stations/dashboard';

const gsHoverCache = new Map();
const satHoverCache = new Map();

export function clearHoverCaches() {
  gsHoverCache.clear();
  satHoverCache.clear();
}

function escapeHtml(s) {
  return String(s ?? 'Unknown')
    .replace(/&/g, '&amp;').replace(/</g, '&lt;')
    .replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

// Dashboard URL for one connection triple. Ground station first, then
// satellite, then ntc id — encodeURIComponent gives the %20 for spaces.
// Returns '' when there is no usable ntc id (row then stays plain text).
export function dashboardUrl(gsName, satName, ntcId) {
  const ntc = String(ntcId ?? '').trim();
  if (!gsName || !satName || !ntc || ntc.toLowerCase() === 'nan') return '';
  return `${ITU_DASHBOARD_BASE}/${encodeURIComponent(String(gsName))}/${encodeURIComponent(String(satName))}/${encodeURIComponent(ntc)}`;
}

// Wrap already-escaped row text in an invisible-styled link when a URL
// exists; otherwise return the text unchanged. Used by the left-panel click
// card (hover tooltips are not clickable — see note at top).
function linkOrText(gsName, satName, ntcId, escapedText) {
  const url = dashboardUrl(gsName, satName, ntcId);
  if (!url) return escapedText;
  return `<a href="${url}" target="_blank" rel="noopener" style="color: inherit; text-decoration: none;">${escapedText}</a>`;
}

const CARD_STYLE = 'min-width: 240px; max-width: 340px; padding: 10px 14px; background: #f7dc93; color: #111111; border-radius: 4px; font-size: 13px; line-height: 1.5; box-shadow: 0 4px 10px rgba(0,0,0,0.25); word-break: break-word;';

export function stationHoverHtml(d) {
  if (!d) return '';
  const key = `gs:${d.name}`;
  const cached = gsHoverCache.get(key);
  if (cached) return cached;
  const html = stationCardHtml(d, false);
  if (gsHoverCache.size > 4000) gsHoverCache.clear();
  gsHoverCache.set(key, html);
  return html;
}

export function satelliteHoverHtml(d) {
  if (!d) return '';
  const key = `sat:${d.name}`;
  const cached = satHoverCache.get(key);
  if (cached) return cached;
  const html = satelliteCardHtml(d, false);
  if (satHoverCache.size > 2000) satHoverCache.clear();
  satHoverCache.set(key, html);
  return html;
}

// Click-pinned card for the left panel (shown under the filters when a node
// is clicked). Same content as the hover box, but the list rows are clickable
// links to the ITU dashboard for that exact GS + SAT + ntc triple. The URL is
// identical whichever side it is opened from. Same colours/text as the hover
// box — rows just become links when an ntc id exists.
export function stationClickHtml(d) {
  if (!d) return '';
  return stationCardHtml(d, true);
}

export function satelliteClickHtml(d) {
  if (!d) return '';
  return satelliteCardHtml(d, true);
}

function stationCardHtml(d, clickable) {
  const sats = store.satsByGsName.get(d.name) || [];
  let satHtml = '<b>No connected satellites</b>';
  if (sats.length > 0) {
    const rows = sats.map(s => ` - ${satRowText(d.name, s, clickable)}`);
    satHtml = `<b>Satellites (${sats.length}):</b><br>` + rows.join('<br>');
  }
  return `<div style="${CARD_STYLE}"><b>${escapeHtml(d.name)}</b> (${escapeHtml(d.operator || 'Unknown')})<br>Country: ${escapeHtml(d.country || 'Unknown')}<br><br>${satHtml}</div>`;
}

function satelliteCardHtml(d, clickable) {
  const stations = store.gsBySatName.get(d.name) || [];
  let gsHtml = 'No ground stations';
  if (stations.length > 0) {
    const rows = stations.map(g => ` - ${gsRowText(g, d.name, clickable)}`);
    gsHtml = `<b>Ground Stations (${stations.length}):</b><br>` + rows.join('<br>');
  }
  const isPlanned = d.planned === true || d.planned === 1 || d.planned === '1' || d.planned === 'true';
  const status = isPlanned ? 'Planned' : 'Non-Planned';
  return `<div style="${CARD_STYLE}"><b>${escapeHtml(d.name)} (${status})</b> (${escapeHtml(d.operator || 'Unknown')})<br>Longitude: ${escapeHtml(d.lon)}°<br><br>${gsHtml}</div>`;
}

function satRowText(gsName, s, clickable) {
  const text = `${escapeHtml(s.name)} (${escapeHtml(s.country || 'Unknown')})`;
  if (!clickable) return text;
  return linkOrText(gsName, s.name, s.ntcId, text);
}

function gsRowText(g, satName, clickable) {
  const text = `${escapeHtml(g.name)} (${escapeHtml(g.country || 'Unknown')})`;
  if (!clickable) return text;
  return linkOrText(g.name, satName, g.ntcId, text);
}
