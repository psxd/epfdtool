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
  "u.s.a.": "united states"
};
