// TEMPORARY diagnostic: measure how far the country cap/stroke geometry sags
// below the globe sphere, which is what makes big countries fill non-solid and
// leaves their borders only partially drawn.
import fs from 'fs';

const R = 100; // GLOBE_RADIUS
const ALT = 0.0015; // current POLYGON_ALTITUDE
const geo = JSON.parse(fs.readFileSync('./public/data/globe.json', 'utf8'));

// Chord sag for a boundary segment spanning `deg` degrees, at radius r.
const chordSag = (deg, r) => r * (1 - Math.cos((deg * Math.PI / 180) / 2));

// Find the longest single boundary edge per country - that is what sets how far
// the cap dips below the sphere between two tessellated contour points.
function maxEdgeDeg(coords) {
  let max = 0;
  const walk = (ring) => {
    for (let i = 0; i < ring.length; i++) {
      const [x1, y1] = ring[i];
      const [x2, y2] = ring[(i + 1) % ring.length];
      const d = Math.hypot(((x2 - x1 + 540) % 360) - 180, y2 - y1);
      if (d > max) max = d;
    }
  };
  if (coords[0][0].length && typeof coords[0][0][0] === 'number') walk(coords[0]);
  else coords.forEach(poly => poly.forEach(walk));
  return max;
}

const rows = geo.features.map(f => {
  const g = f.geometry;
  const coords = g.type === 'Polygon' ? [g.coordinates] : g.coordinates;
  return { name: f.properties.name, deg: maxEdgeDeg(coords) };
}).sort((a, b) => b.deg - a.deg);

console.log('countries:', rows.length);
console.log('longest boundary edge (deg) per country, worst 12:');
for (const r of rows.slice(0, 12)) {
  console.log('  ' + r.name.padEnd(30) + r.deg.toFixed(1) + ' deg');
}
const med = rows[Math.floor(rows.length / 2)].deg;
console.log('median longest edge:', med.toFixed(2), 'deg');

// With resolution=5 the library only re-samples edges LONGER than 5 deg, so
// short edges stay as-is. The sag of the longest edge is the worst case.
console.log('\ncap sag vs altitude lift (lift = ' + (R * ALT).toFixed(3) + ' units at r=100):');
for (const deg of [rows[0].deg, 20, 10, 5, 2, 1]) {
  const sag = chordSag(deg, R);
  console.log('  edge ' + String(deg.toFixed(1)).padStart(5) + ' deg -> sag ' +
    sag.toFixed(3) + '  ' + (sag > R * ALT ? 'SINKS BELOW GLOBE' : 'clears'));
}
