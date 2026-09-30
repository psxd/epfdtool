// Shared visual + orbital constants (1:1 with ver1/app.js).
export const PALETTE = {
  scene_bg: "#f1eee8",
  gray_dark: "#8f8f8f",
  gray_mid1: "#B0B0B0",
  yellow_soft: "#f7dc93",
  false_sat: "#E69F00",
  true_sat: "#1977AD"
};

export const EARTH_RADIUS_KM = 6378.137;
export const GSO_ALTITUDE_KM = 35786.0;
export const GSO_ALTITUDE_RATIO = GSO_ALTITUDE_KM / EARTH_RADIUS_KM;

export const COUNTRY_ALIASES = {
  "usa": "united states",
  "us": "united states",
  "united states of america": "united states",
  "u.s.": "united states",
  "u.s.a.": "united states",
  // ITU Space Explorer sometimes ships an administration CODE with no country
  // name/flag behind it (mapping.json has no entry for the code). Two such
  // codes actually own ground stations in the current dataset:
  //   MRL -> EBEYE / MAJURO (Marshall Islands, no polygon in globe.json),
  //   XYU -> BEOGRAD KRNJACA RTB1/RTB3 (Serbia - the polygon DOES exist, as
  //          "Republic of Serbia", so without this the Serbian stations linked
  //          to the France fleet were drawn but Serbia was never outlined).
  // Unmapped codes stay unresolved and are simply skipped, exactly like a
  // recognized country that has no polygon.
  "mrl": "marshall islands",
  "xyu": "serbia"
};
