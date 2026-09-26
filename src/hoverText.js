// Cached hover/tooltip HTML builders.
//
// GS hover: satellite list shows "SAT (Country)" per row.
// SAT hover: ground-station list shows "STATION (Country)" per row.
// Rows capped + HTML escaped; per-entity caching keeps hover at ~O(1).
import { store } from './state.js';

const GS_ROW_CAP = 12;
const SAT_ROW_CAP = 12;

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

const CARD_STYLE = 'min-width: 240px; max-width: 340px; padding: 10px 14px; background: #f7dc93; color: #111111; border-radius: 4px; font-size: 13px; line-height: 1.5; box-shadow: 0 4px 10px rgba(0,0,0,0.25); word-break: break-word;';

export function stationHoverHtml(d) {
  if (!d) return '';
  const cached = gsHoverCache.get(d.name);
  if (cached) return cached;
  const sats = store.satsByGsName.get(d.name) || [];
  let satHtml = '<b>No connected satellites</b>';
  if (sats.length > 0) {
    const rows = sats.slice(0, GS_ROW_CAP).map(s => ` - ${escapeHtml(s.name)} (${escapeHtml(s.country || 'Unknown')})`);
    const extra = sats.length > GS_ROW_CAP ? `<br> - … +${sats.length - GS_ROW_CAP} more` : '';
    satHtml = '<b>Satellites:</b><br>' + rows.join('<br>') + extra;
  }
  const html = `<div style="${CARD_STYLE}"><b>${escapeHtml(d.name)}</b> (${escapeHtml(d.operator || 'Unknown')})<br>Country: ${escapeHtml(d.country || 'Unknown')}<br><br>${satHtml}</div>`;
  if (gsHoverCache.size > 4000) gsHoverCache.clear();
  gsHoverCache.set(d.name, html);
  return html;
}

export function satelliteHoverHtml(d) {
  if (!d) return '';
  const cached = satHoverCache.get(d.name);
  if (cached) return cached;
  const stations = store.gsBySatName.get(d.name) || [];
  let gsHtml = 'No ground stations';
  if (stations.length > 0) {
    const rows = stations.slice(0, SAT_ROW_CAP).map(g => ` - ${escapeHtml(g.name)} (${escapeHtml(g.country || 'Unknown')})`);
    const extra = stations.length > SAT_ROW_CAP ? `<br> - … +${stations.length - SAT_ROW_CAP} more` : '';
    gsHtml = '<b>Ground Stations:</b><br>' + rows.join('<br>') + extra;
  }
  const isPlanned = d.planned === true || d.planned === 1 || d.planned === '1' || d.planned === 'true';
  const status = isPlanned ? 'Planned' : 'Non-Planned';
  const html = `<div style="${CARD_STYLE}"><b>${escapeHtml(d.name)} (${status})</b> (${escapeHtml(d.operator || 'Unknown')})<br>Longitude: ${escapeHtml(d.lon)}°<br><br>${gsHtml}</div>`;
  if (satHoverCache.size > 2000) satHoverCache.clear();
  satHoverCache.set(d.name, html);
  return html;
}
