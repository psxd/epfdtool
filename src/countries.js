// Part 1/2: canonicalisation helpers (see countryNorm/countryHi/countryView).
import { COUNTRY_ALIASES } from './constants.js';
import { store } from './state.js';

export const FLAG_RE = /[\u{1F1E6}-\u{1F1FF}\u{1F000}-\u{1FAFF}\u{2600}-\u{27BF}\u{FE0F}\u{200D}]/gu;

// Formal ITU names -> short geo names. A short name that has no polygon in
// globe.json (Singapore, Bahrain, Maldives, Macao, Hong Kong, ...) simply never
// highlights a polygon; nothing needs to be special-cased for it, because
// normalizeCountryName only collapses a qualifier when the BARE name really
// exists in the geo set (see countryNorm.js) and the camera then falls back to
// the filtered entities' own position (see countryView.filterView).
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
  // Territories that own a polygon in globe.json stay themselves - never fold
  // them into the parent state.
  'bermuda': 'bermuda',
  'puerto rico': 'puerto rico',
  'new caledonia': 'new caledonia',
  'falkland islands': 'falkland islands',
  'french guiana': 'french guiana',
  // Deliberately NO entry for "Alaska (State of)", "Hawaii (State of)" or
  // "Guam 🇬🇺": they have no polygon of their own and ver1 resolves them
  // through exceptions.json to United States of America. An identity entry
  // here would swallow that lookup and leave those filters with nothing to
  // highlight (and the camera with nothing to frame).
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
  for (const [key, val] of Object.entries(store.countryExceptions || {})) {
    if (key.toLowerCase().trim() === raw || stripDecorations(key).toLowerCase() === lower) {
      const v = val.toLowerCase().trim();
      if (Object.hasOwn(CANONICAL_OVERRIDES, v)) return CANONICAL_OVERRIDES[v];
      return COUNTRY_ALIASES[v] || v;
    }
  }
  return lower;
}
