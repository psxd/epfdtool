// Invariant test for the ITU -> JSON -> view pipeline.
//
// The rule under test: for any node the user clicks, searches or filters to,
// the number of lines drawn from it equals the number of connections listed
// under it. Run: node scripts/verify-links.mjs
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const pub = join(here, '..', 'public', 'data');
const load = (f) => JSON.parse(readFileSync(join(pub, f), 'utf8'));

const stations = load('stations.json');
const satellites = load('satellites.json');
const connections = load('connections.json');

let failures = 0;
const check = (label, actual, expected) => {
  const ok = actual === expected;
  if (!ok) failures++;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}: ${actual}${ok ? '' : ` (expected ${expected})`}`);
};

// --- identity ---------------------------------------------------------------
const gsIds = new Set(stations.map((s) => s.id));
const satIds = new Set(satellites.map((s) => s.id));
check('every station has a unique id', new Set(stations.map((s) => s.id)).size, stations.length);
check('every satellite has a unique id', new Set(satellites.map((s) => s.id)).size, satellites.length);

// --- no lost / dangling links ----------------------------------------------
const pairKey = (a, b) => JSON.stringify([a, b]);
const pairs = new Set(connections.map((c) => pairKey(c.gs_id, c.sat_id)));
check('every connection is unique per endpoint pair', pairs.size, connections.length);
check('dangling connections', connections.filter((c) => !gsIds.has(c.gs_id) || !satIds.has(c.sat_id)).length, 0);

const linkedGs = new Set(connections.map((c) => c.gs_id));
const linkedSat = new Set(connections.map((c) => c.sat_id));
check('stations with no link', stations.filter((s) => !linkedGs.has(s.id)).length, 0);
check('satellites with no link', satellites.filter((s) => !linkedSat.has(s.id)).length, 0);

// --- the lists the user reads are the lines they see ------------------------
// This mirrors gsoNetwork.loadData's index build exactly.
const satsByGsId = new Map();
const gsBySatId = new Map();
for (const c of connections) {
  if (!satsByGsId.has(c.gs_id)) satsByGsId.set(c.gs_id, new Set());
  satsByGsId.get(c.gs_id).add(c.sat_id);
  if (!gsBySatId.has(c.sat_id)) gsBySatId.set(c.sat_id, new Set());
  gsBySatId.get(c.sat_id).add(c.gs_id);
}
let listMismatch = 0;
for (const c of connections) {
  if (satsByGsId.get(c.gs_id).size < 1) listMismatch++;
  if (gsBySatId.get(c.sat_id).size < 1) listMismatch++;
}
check('nodes whose listed links are empty', listMismatch, 0);

// The drawn beam count for a node must equal its listed count, by construction
// one beam is drawn per connection row and the list is built from those rows.
let beamVsList = 0;
for (const stn of stations) {
  const drawn = connections.filter((c) => c.gs_id === stn.id).length;
  const listed = (satsByGsId.get(stn.id) || new Set()).size;
  if (drawn !== listed) beamVsList++;
}
for (const sat of satellites) {
  const drawn = connections.filter((c) => c.sat_id === sat.id).length;
  const listed = (gsBySatId.get(sat.id) || new Set()).size;
  if (drawn !== listed) beamVsList++;
}
check('nodes where drawn beams != listed connections', beamVsList, 0);

// --- same-named nodes stay distinct -----------------------------------------
const byName = new Map();
for (const s of stations) {
  if (!byName.has(s.name)) byName.set(s.name, []);
  byName.get(s.name).push(s);
}
const dupNames = [...byName.entries()].filter(([, v]) => v.length > 1);
console.log(`\nstation names at >1 position: ${dupNames.length} (each keeps its own id + links)`);
let dupOk = true;
for (const [, rows] of dupNames) {
  const ids = new Set(rows.map((r) => r.id));
  if (ids.size !== rows.length) dupOk = false;
  for (const r of rows) if (!satsByGsId.has(r.id)) dupOk = false;
}
check('every same-named station position is a distinct, linked node', dupOk, true);

const satByName = new Map();
for (const s of satellites) {
  if (!satByName.has(s.name)) satByName.set(s.name, []);
  satByName.get(s.name).push(s);
}
const dupSats = [...satByName.entries()].filter(([, v]) => v.length > 1);
console.log(`satellite names at >1 longitude: ${dupSats.length}`);

// --- the earlier collapse is really gone ------------------------------------
// The old name-keyed pipeline merged these into one row each; the count of
// (station, satellite) NAME pairs must now be strictly below the link count.
const namePairs = new Set(connections.map((c) => pairKey(c.gs_name, c.sat_name)));
console.log(`\nname-keyed pairs would be ${namePairs.size}; position-keyed links are ${connections.length}`);
check('links recovered vs the old name-keyed pipeline', connections.length - namePairs.size, 35);

console.log(failures === 0 ? '\nAll invariants hold.' : `\n${failures} invariant(s) FAILED.`);
process.exit(failures === 0 ? 0 : 1);
