// Part 1/2: canonicalisation helpers (see countryNorm/countryHi/countryView).
import { COUNTRY_ALIASES } from './constants.js';

export const FLAG_RE = /[\u{1F1E6}-\u{1F1FF}\u{1F000}-\u{1FAFF}\u{2600}-\u{27BF}\u{FE0F}\u{200D}]/gu;

// Formal ITU names -> short geo names. A short name that has no polygon in
// globe.json (Singapore, Bahrain, Maldives, Macao, Hong Kong, ...) simply never
// highlights a polygon; nothing needs to be special-cased for it, because
// normalizeCountryName only collapses a qualifier when the BARE name really
// exists in the geo set (see countryNorm.js) and the camera then falls back to
// the filtered entities' own position (see countryView.filterView).
//
// BUILT-IN EXCEPTIONS (previously public/data/exceptions.json, now inlined so
// no exceptions file is generated or fetched): territory / state names that
// have no polygon of their own and must resolve to the parent state. This is
// handled internally by canonicalise() below.
export const COUNTRY_EXCEPTIONS = {
  'alaska (state of)': 'united states of america',
  'hawaii (state of)': 'united states of america',
  'guam': 'united states of america',
  'ascension island': 'united kingdom',
  'azores': 'portugal',
  'canary islands': 'spain',
  'cayman islands': 'united kingdom',
  'cocos (keeling) islands': 'australia',
  'christmas island (indian ocean)': 'australia',
  'diego garcia': 'united kingdom',
  'faroe islands': 'denmark',
  'gibraltar': 'united kingdom',
  'guadeloupe (french department of)': 'france',
  'guiana (french department of)': 'france',
  'madeira': 'portugal',
  'martinique (french department of)': 'france',
  'mayotte (territorial collectivity of)': 'france',
  'montserrat': 'united kingdom',
  'reunion (french department of)': 'france',
  'saint pierre and miquelon (territorial collectivity of)': 'france',
};
export const CANONICAL_OVERRIDES = {
  'russian federation': 'russia',
  'kyrgyz republic': 'kyrgyzstan',
  'syrian arab republic': 'syria',
  'argentine republic': 'argentina',
  'korea (republic of)': 'south korea',
  "lao people's democratic republic": 'laos',
  'slovak republic': 'slovakia',
  'republic of turkiye': 'turkey',
  'viet nam (socialist republic of)': 'vietnam',
  'united kingdom of great britain and northern ireland': 'united kingdom',
  'moldova (republic of)': 'moldova',
  'angola (republic of)': 'angola',
  'armenia (republic of)': 'armenia',
  'azerbaijan (republic of)': 'azerbaijan',
  'belarus (republic of)': 'belarus',
  'brazil (federative republic of)': 'brazil',
  'bulgaria (republic of)': 'bulgaria',
  'cabo verde (republic of)': 'cabo verde',
  'china (people\u2019s republic of)': 'china',
  "china (people's republic of)": 'china',
  'colombia (republic of)': 'colombia',
  'comoros (union of the)': 'comoros',
  'croatia (republic of)': 'croatia',
  'cyprus (republic of)': 'cyprus',
  'djibouti (republic of)': 'djibouti',
  'egypt (arab republic of)': 'egypt',
  'estonia (republic of)': 'estonia',
  'fiji (republic of)': 'fiji',
  'germany (federal republic of)': 'germany',
  'india (republic of)': 'india',
  'indonesia (republic of)': 'indonesia',
  'iran (islamic republic of)': 'iran',
  'iraq (republic of)': 'iraq',
  'israel (state of)': 'israel',
  'jordan (hashemite kingdom of)': 'jordan',
  'kazakhstan (republic of)': 'kazakhstan',
  'kuwait (state of)': 'kuwait',
  'latvia (republic of)': 'latvia',
  'libya (state of)': 'libya',
  'lithuania (republic of)': 'lithuania',
  'madagascar (republic of)': 'madagascar',
  'maldives (republic of)': 'maldives',
  'mauritius (republic of)': 'mauritius',
  'morocco (kingdom of)': 'morocco',
  'myanmar (union of)': 'myanmar',
  'netherlands (kingdom of the)': 'netherlands',
  'oman (sultanate of)': 'oman',
  'poland (republic of)': 'poland',
  'saudi arabia (kingdom of)': 'saudi arabia',
  'seychelles (republic of)': 'seychelles',
  'singapore (republic of)': 'singapore',
  'slovenia (republic of)': 'slovenia',
  'south africa (republic of)': 'south africa',
  'sudan (republic of the)': 'sudan',
  'switzerland (confederation of)': 'switzerland',
  'tonga (kingdom of)': 'tonga',
  'uzbekistan (republic of)': 'uzbekistan',
  'yemen (republic of)': 'yemen',
  'car': 'central african republic',
  'bahrain (kingdom of)': 'bahrain',
  'monaco (principality of)': 'monaco',
  'serbia (republic of)': 'serbia',
  // Geo spellings that differ from the station/ITU spelling. The polygon in
  // globe.json is named "Republic of Serbia" while the stations carry the ITU
  // administration code "XYU" (-> COUNTRY_ALIASES) or, after a data refresh,
  // "Serbia"/"Serbia (Republic of)" - all of them must land on the same key, or
  // a country that really has a polygon is linked but never outlined (the
  // BEOGRAD KRNJACA stations talk to the France fleet). Same story for the ITU
  // "Cape Verde" vs the geo name "Cabo Verde". A key that still has no polygon
  // is skipped by the outline logic on purpose - its stations and link beams are
  // unaffected (see countryHi.linkedGsCountries).
  'republic of serbia': 'serbia',
  'cape verde': 'cabo verde',
  // Territories that own a polygon in globe.json stay themselves - never fold
  // them into the parent state.
  'bermuda': 'bermuda',
  'puerto rico': 'puerto rico',
  'new caledonia': 'new caledonia',
  'falkland islands': 'falkland islands',
  'french guiana': 'french guiana',
  // COUNTRY_EXCEPTIONS (top of this file) intentionally holds the Alaska /
  // Hawaii / Guam -> USA parent mappings, so they still highlight the USA.
};

export function stripDecorations(name) {
  return name.replace(FLAG_RE, '').replace(/\s+/g, ' ').trim();
}

export function stripTrailingQualifier(name) {
  return name.replace(/\s*\([^()]*\)\s*$/, '').trim();
}

export function canonicalise(raw) {
  const clean = stripDecorations(raw);
  const lower = clean.toLowerCase();
  if (Object.hasOwn(CANONICAL_OVERRIDES, lower)) return CANONICAL_OVERRIDES[lower];
  if (COUNTRY_ALIASES[lower]) return COUNTRY_ALIASES[lower];
  // Internal exceptions map (decoration-insensitive, no fetch needed).
  for (const [key, val] of Object.entries(COUNTRY_EXCEPTIONS)) {
    if (key === lower || stripDecorations(key).toLowerCase() === lower) {
      const v = String(val).toLowerCase().trim();
      if (Object.hasOwn(CANONICAL_OVERRIDES, v)) return CANONICAL_OVERRIDES[v];
      return COUNTRY_ALIASES[v] || v;
    }
  }
  return lower;
}
