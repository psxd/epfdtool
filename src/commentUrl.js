// Pure helpers for the comment system: camera view + filter state <-> URL
// serialisation, the view_hash payload, HTML escaping and local-timezone
// timestamp formatting. Deliberately DOM-free so it can be smoke-tested under
// plain Node without pulling in globe.gl.

/** Canonical Supabase gen_random_uuid() shape — used to accept ?comment= safely. */
export const UUID_RE = /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/;

export function clamp(n, lo, hi) {
  return Math.min(hi, Math.max(lo, n));
}

export function round(n, dp) {
  const v = Number(n);
  if (!Number.isFinite(v)) return 0;
  const f = 10 ** dp;
  return Math.round(v * f) / f;
}

/** Escape every user-controlled string before it goes near innerHTML. */
export function escapeHtml(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

export function truncate(text, max) {
  const s = String(text ?? '');
  return s.length > max ? `${s.slice(0, max - 1)}…` : s;
}

/** e.g. "Sep 25, 2026, 4:32 PM EDT" — always the viewer's local zone. */
export function formatTime(iso) {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  try {
    return new Intl.DateTimeFormat('en-US', {
      month: 'short',
      day: 'numeric',
      year: 'numeric',
      hour: 'numeric',
      minute: '2-digit',
      timeZoneName: 'short',
    }).format(d);
  } catch {
    return d.toLocaleString();
  }
}

// ---------- view <-> URL ----------

export function serializeView(view) {
  if (!view) return '';
  return `${round(view.lat, 4)},${round(view.lng, 4)},${round(view.altitude, 4)}`;
}

export function parseView(raw) {
  if (!raw) return null;
  const parts = String(raw).split(',');
  if (parts.length !== 3) return null;
  const nums = parts.map(Number);
  if (!nums.every(Number.isFinite)) return null;
  const [lat, lng, alt] = nums;
  return {
    lat: clamp(lat, -90, 90),
    lng: clamp((((lng % 360) + 540) % 360) - 180, -180, 180),
    altitude: clamp(alt, 0.3, 12),
  };
}

// ---------- filters <-> URL ----------
// Each field is percent-encoded individually so country names containing
// "," / "|" / "%" round-trip safely through the single "|" separator.

export function serializeFilters(filters) {
  if (!filters) return '';
  return [filters.status, filters.sat, filters.gs]
    .map((v) => encodeURIComponent(String(v || 'all')))
    .join('|');
}

export function parseFilters(raw) {
  if (!raw) return null;
  const parts = String(raw).split('|');
  if (parts.length !== 3) return null;
  let decoded;
  try {
    decoded = parts.map((p) => decodeURIComponent(p));
  } catch {
    return null;
  }
  if (decoded.some((p) => p.length > 120)) return null;
  const [status, sat, gs] = decoded;
  return { status, sat, gs };
}

/** Query tail shared between localhost and GitHub Pages: `view=..&filters=..&comment=..`. */
export function buildQuery(view, filters, commentId) {
  const p = new URLSearchParams();
  if (view) p.set('view', serializeView(view));
  if (filters) p.set('filters', serializeFilters(filters));
  if (commentId) p.set('comment', String(commentId));
  return p.toString();
}

// ---------- view_hash column payload ----------
// Stores the stringified view + filters plus the card anchor (x/y as % of the
// viewport) so a shared thread re-opens on the exact camera, filters and card
// position it was written from.

export function makeViewHash(view, filters, anchor) {
  return JSON.stringify({
    view: serializeView(view),
    filters: serializeFilters(filters),
    x: round(anchor && anchor.x, 2),
    y: round(anchor && anchor.y, 2),
  });
}

export function parseViewHash(raw) {
  if (!raw) return {};
  try {
    const o = JSON.parse(String(raw));
    return o && typeof o === 'object' ? o : {};
  } catch {
    return {};
  }
}
