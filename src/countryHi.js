// Highlight-set updater + strict polygon matcher.
// GSO semantics (two tiers in ONE blue, never any lift - see globe.js):
//  * PRIMARY: the country the user actually picked - the sat country for a
//    sat-only filter, the GS country for a GS-only or a linked both-filter.
//    Blue fill + blue stroke. At most ONE polygon family ever fills.
//  * FOOTPRINT: countries whose ground stations communicate with the picked
//    operator's fleet. SAME blue (#1977AD) outline, transparent cap - so
//    sat=USA + GS=All shows the USA filled blue with linked countries
//    outlined blue, never a near-whole-globe wash and never z-fighting
//    (altitude is constant 0 for every polygon).
//  * both filtered -> only the GS country, and only when at least one link
//    between that GS country and the sat country exists; otherwise nothing.
// Camera framing lives in countryView.js: the primary country is framed.
import { store } from './state.js';
import { normalizeCountryName } from './countryNorm.js';

function gsCountryOfStation(gsName, fallbackCountry) {
  const stn = store.stationByName ? store.stationByName.get(gsName) : undefined;
  const raw = stn ? (stn.country || stn.gscountry || '') : (fallbackCountry || '');
  return normalizeCountryName(raw);
}

function hasPolygon(key) {
  if (!key) return false;
  // Geo set not loaded yet (filters can run before globe.json arrives): keep
  // the key - it paints nothing until then and is re-resolved on load.
  if (!store.geoNameSet) return true;
  return store.geoNameSet.has(key);
}

// Countries hosting stations that talk to targetSat's fleet (polygon-gated).
// Exported so the regression harness can derive the allowed set independently.
export function linkedGsCountries(targetSat) {
  const out = new Set();
  const sats = (store.rawData && store.rawData.satellites) || [];
  for (const sat of sats) {
    if (normalizeCountryName(sat.operator || sat.satcountry || '') !== targetSat) continue;
    const links = store.gsBySatName ? store.gsBySatName.get(sat.name) : undefined;
    if (!links) continue;
    for (const l of links) {
      const c = gsCountryOfStation(l.name, l.country);
      if (c && hasPolygon(c)) out.add(c);
    }
  }
  return out;
}

function gsSatLinkExists(targetGs, targetSat) {
  const sats = (store.rawData && store.rawData.satellites) || [];
  for (const sat of sats) {
    if (normalizeCountryName(sat.operator || sat.satcountry || '') !== targetSat) continue;
    const links = store.gsBySatName ? store.gsBySatName.get(sat.name) : undefined;
    if (!links) continue;
    for (const l of links) {
      if (gsCountryOfStation(l.name, l.country) === targetGs) return true;
    }
  }
  return false;
}

export function updateHighlightedCountriesCache() {
  const highlighted = new Set();   // gets the solid blue FILL
  const satOutline = new Set();    // blue OUTLINE only, never filled
  const footprint = new Set();     // blue OUTLINE only, never filled
  if (!store.isLeoActive) {
    const gsCountry = document.getElementById('filterGsCountry')?.value;
    const satCountry = document.getElementById('filterSatCountry')?.value;
    const hasGs = Boolean(gsCountry) && gsCountry !== 'all';
    const hasSat = Boolean(satCountry) && satCountry !== 'all';
    if (hasGs && hasSat) {
      const g = normalizeCountryName(gsCountry);
      const t = normalizeCountryName(satCountry);
      // Unique linked set only: the GS country fills iff its stations really
      // talk to the picked operator's fleet.
      if (g && t && gsSatLinkExists(g, t)) highlighted.add(g);
    } else if (hasGs) {
      // GS country filter -> solid blue fill.
      const g = normalizeCountryName(gsCountry);
      if (g) highlighted.add(g);
    } else if (hasSat) {
      // sat country filter -> the operator's country is OUTLINED in the same
      // blue, never filled, and so is every GS country it talks to. Nothing is
      // filled here, which is what stops a sat filter from washing the globe.
      const t = normalizeCountryName(satCountry);
      if (t) satOutline.add(t);
      for (const c of linkedGsCountries(t)) {
        if (c !== t) footprint.add(c);
      }
    }
  }
  store.currentHighlightedSet = highlighted;
  store.currentSatOutlineSet = satOutline;
  store.currentFootprintSet = footprint;
}

// A polygon that should get the blue OUTLINE (sat-filtered country + its
// linked GS countries). Never filled, so many of them can be lit at once
// without any of them fighting for the same pixels.
export function isCountryOutlined(featureProps) {
  if (!featureProps) return false;
  const outline = store.currentSatOutlineSet;
  const footprint = store.currentFootprintSet;
  if ((!outline || outline.size === 0) && (!footprint || footprint.size === 0)) return false;
  const rawNames = [
    featureProps.name, featureProps.ADMIN, featureProps.NAME,
    featureProps.ISO_A2, featureProps.ISO_A3,
  ].filter(Boolean);
  for (const rawN of rawNames) {
    const key = normalizeCountryName(rawN);
    if (store.currentHighlightedSet.has(key)) continue; // filled country wins
    if (outline && outline.has(key)) return true;
    if (footprint && footprint.has(key)) return true;
  }
  return false;
}

export function isCountryHighlighted(featureProps) {
  if (!featureProps || store.currentHighlightedSet.size === 0) return false;
  const rawNames = [
    featureProps.name, featureProps.ADMIN, featureProps.NAME,
    featureProps.ISO_A2, featureProps.ISO_A3,
  ].filter(Boolean);
  for (const rawN of rawNames) {
    if (store.currentHighlightedSet.has(normalizeCountryName(rawN))) return true;
  }
  return false;
}

// True for the GS countries linked to the sat-filtered operator's fleet. These
// are outlined only. Kept as its own predicate (rather than folded into
// isCountryOutlined) because the harness asserts the footprint set exactly.
export function isCountryFootprint(featureProps) {
  if (!featureProps || !store.currentFootprintSet || store.currentFootprintSet.size === 0) return false;
  const rawNames = [
    featureProps.name, featureProps.ADMIN, featureProps.NAME,
    featureProps.ISO_A2, featureProps.ISO_A3,
  ].filter(Boolean);
  for (const rawN of rawNames) {
    const key = normalizeCountryName(rawN);
    if (store.currentHighlightedSet.has(key)) continue; // primary wins
    if (store.currentFootprintSet.has(key)) return true;
  }
  return false;
}
