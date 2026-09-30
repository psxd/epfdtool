// Memoised country-name normalisation (canonical keys everywhere).
import { COUNTRY_ALIASES } from './constants.js';
import { store } from './state.js';
import {
  canonicalise, stripDecorations, stripTrailingQualifier, CANONICAL_OVERRIDES,
  COUNTRY_EXCEPTIONS,
} from './countries.js';

// Cache of canonicalised exception TARGET values (e.g. 'united kingdom'),
// so a picked filter value that equals a parent state resolves identically
// whether it came from a station record or the dropdown.
let exceptionsValueCanon = null;

function buildExceptionsValueCanon() {
  if (exceptionsValueCanon) return exceptionsValueCanon;
  exceptionsValueCanon = new Map();
  for (const val of Object.values(COUNTRY_EXCEPTIONS || {})) {
    const canon = canonicalise(String(val));
    if (canon) exceptionsValueCanon.set(String(val).toLowerCase().trim(), canon);
  }
  return exceptionsValueCanon;
}

export function normalizeCountryName(name) {
  if (!name) return '';
  const raw = String(name).trim().toLowerCase();
  const cached = store.nameCache.get(raw);
  if (cached !== undefined) return cached;
  let resolved = canonicalise(String(name).trim());
  // Guarded qualifier fallback: only collapse "X (qualifier)" -> "X" when the
  // full name has NO polygon but bare X does (e.g. "Germany (Federal Republic
  // of)" -> "germany"). Explicit '' overrides above never reach here as ''.
  if (resolved && store.geoNameSet && !store.geoNameSet.has(resolved)) {
    const bare = stripTrailingQualifier(stripDecorations(String(name).trim())).toLowerCase();
    let bareCanon = null;
    if (Object.hasOwn(CANONICAL_OVERRIDES, bare)) bareCanon = CANONICAL_OVERRIDES[bare];
    else bareCanon = COUNTRY_ALIASES[bare] || bare;
    if (bareCanon && store.geoNameSet.has(bareCanon)) resolved = bareCanon;
  }
  if (resolved) {
    const valCanon = buildExceptionsValueCanon().get(resolved);
    if (valCanon) resolved = valCanon;
  }
  store.nameCache.set(raw, resolved);
  return resolved;
}

export function resetCountryNameCache() {
  store.nameCache.clear();
  exceptionsValueCanon = null;
}

export function buildGeoNameSet() {
  store.geoNameSet = new Set(
    store.cachedGeoJsonFeatures.map(f => normalizeCountryName((f.properties && f.properties.name) || ''))
  );
  resetCountryNameCache();
}
