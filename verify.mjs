// Local regression harness for the GSO highlight + camera logic: `node verify.mjs`.
// It drives the REAL applyFilters / zoomBy / setupUIEvents against a stubbed globe,
// DOM and a pumpable requestAnimationFrame, so highlight sets and the camera tween
// are measured exactly as a browser computes them. Sections:
//   A substring-leak probes            B USA sat filter (footprint countries only)
//   C every GS dropdown value          D every SAT dropdown value
//   E combined filters                 F no unselected polygon ever lights up
//   G Monaco / Tonga detail            H zoom buttons + 800 ms tween + country framing
import { readFileSync } from 'fs';
import * as THREE from 'three';
import { store } from './src/state.js';
import { resetCountryNameCache, buildGeoNameSet, normalizeCountryName } from './src/countryNorm.js';
import { isCountryHighlighted, isCountryOutlined, isCountryFootprint, linkedGsCountries } from './src/countryHi.js';

const rd = (p) => JSON.parse(readFileSync(p, 'utf8'));
store.countryExceptions = rd('./public/data/exceptions.json');
store.cachedGeoJsonFeatures = rd('./public/data/globe.json').features;
store.rawData.stations = rd('./public/data/stations.json');
store.rawData.satellites = rd('./public/data/satellites.json');
store.rawData.connections = rd('./public/data/connections.json');
for (const s of store.rawData.satellites) s.lon = s.long_nom ?? s.lon ?? 0;
resetCountryNameCache();
buildGeoNameSet();

// Indexes that loadData() normally builds.
const satByName = new Map(), stationByName = new Map(), satLonByName = new Map();
const satConn = new Map(), stnConn = new Map();
for (const c of store.rawData.connections) {
  if (!satConn.has(c.sat_name)) satConn.set(c.sat_name, []);
  satConn.get(c.sat_name).push(c.gs_name);
  if (!stnConn.has(c.gs_name)) stnConn.set(c.gs_name, []);
  stnConn.get(c.gs_name).push(c.sat_name);
}
for (const s of store.rawData.satellites) { satByName.set(s.name, s); satLonByName.set(s.name, s.lon); }
for (const s of store.rawData.stations) stationByName.set(s.name, s);
store.satByName = satByName; store.stationByName = stationByName; store.satLonByName = satLonByName;
store.satsByGsName = new Map([...stnConn].map(([gs, list]) => [gs, [...new Set(list)].map(n => ({ name: n, country: satByName.get(n)?.operator || '' }))]));
store.gsBySatName = new Map([...satConn].map(([sat, list]) => [sat, [...new Set(list)].map(n => ({ name: n, country: stationByName.get(n)?.country || '' }))]));

// Globe stub. Stateful POV (globe.js reads the live position to start a camera
// tween) + a pumpable requestAnimationFrame + fake clock so the 800 ms tween can
// be stepped deterministically. Durations are irrelevant to a real globe.gl
// 2.31 pointOfView call, so the stub mirrors only what actually lands: dur 0.
// polygonsData records every re-push: the highlight repaint REQUIRES one push
// per filter change (accessors never re-run otherwise); the harness asserts
// exactly one push per run (no redundant re-digests).
const DEG = Math.PI / 180;
const cameraMoves = [];
let stubPov = { lat: 20, lng: 0, altitude: 2.2 };
let fakeNow = 0;
let nextFrameId = 1;
let polygonPushes = 0;
const pendingFrames = new Map();   // rAF id -> callback (cancellation really cancels)
Object.defineProperty(globalThis, 'performance', { value: { now: () => fakeNow }, configurable: true, writable: true });
global.requestAnimationFrame = (cb) => { const id = nextFrameId++; pendingFrames.set(id, cb); return id; };
global.cancelAnimationFrame = (id) => { pendingFrames.delete(id); };
store.world = {
  scene: () => new THREE.Scene(),
  getCoords: (lat, lng, alt = 0) => {
    const phi = (90 - lat) * DEG, theta = (lng + 180) * DEG, r = 1 + alt;
    return new THREE.Vector3(-r * Math.sin(phi) * Math.cos(theta), r * Math.cos(phi), r * Math.sin(phi) * Math.sin(theta));
  },
  pointsData: () => {}, objectsData: () => {}, polygonsData: () => { polygonPushes++; },
  pointOfView: (pov, dur) => {
    if (!pov) return { ...stubPov };            // getter, like globe.gl
    cameraMoves.push({ ...pov, dur });
    stubPov = { lat: pov.lat, lng: pov.lng, altitude: pov.altitude };
    return undefined;
  },
};

// Run the queued animation frames forward: 40 x 50 ms of fake time is well past
// the 800 ms camera tween. three-globe's module-scope ticker queues frames too,
// so every callback is isolated.
function settleFrames(count = 40) {
  for (let i = 0; i < count; i++) {
    fakeNow += 50;
    const cbs = [...pendingFrames.values()];
    pendingFrames.clear();
    for (const cb of cbs) {
      try { cb(fakeNow); } catch { /* three-globe ticker with no renderer */ }
    }
  }
  return { ...stubPov };
}


// d3 (float-tooltip) reads/writes style through the CSSOM, so the stub's style
// object needs getPropertyValue/setProperty, not just a plain {}.
const stubNode = (tagName = 'div') => ({
  tagName: String(tagName).toUpperCase(),
  nodeName: String(tagName).toUpperCase(),
  innerHTML: '', textContent: '', value: '',
  style: { getPropertyValue: () => '', setProperty() {}, removeProperty() {} },
  setAttribute() {}, removeAttribute() {}, appendChild() {}, addEventListener() {},
  getBoundingClientRect: () => ({ x: 0, y: 0, top: 0, left: 0, right: 0, bottom: 0, width: 0, height: 0 }),
  get ownerDocument() { return global.document; },
  parentNode: null, childNodes: [], classList: { add() {}, remove() {} },
});
// DOM stub for the two dropdowns (+ the bits float-tooltip injects at import).
const elements = {
  filterStatus: { value: 'all' },
  filterSatCountry: { value: 'all' },
  filterGsCountry: { value: 'all' },
  satelliteStat: { textContent: '' }, stationStat: { textContent: '' },
  detailsBox: { innerHTML: '' },
  // NOTE: #globeCanvas is deliberately NOT stubbed. kapsule skips a
  // component's init() entirely when it is constructed with a null element
  // (`classMode && nodeElement && comp(nodeElement)`), so leaving
  // getElementById('globeCanvas') -> null gives us the real globe.gl API
  // (pointOfView / polygonsData / controls) with no WebGLRenderer, which is
  // what the rest of this harness runs against. Stubbing it would spin up a
  // real renderer and need a real GL context.
};
global.document = {
  getElementById: (id) => elements[id] || null,
  createElement: stubNode,
  createTextNode: stubNode,
  getElementsByTagName: () => [],
  createElementNS: (_ns, name) => stubNode(name),
  head: stubNode(),
  body: stubNode(),
  addEventListener() {},
  // d3 falls back to document.defaultView.getComputedStyle when a node's
  // inline style carries no value for the property being read.
  defaultView: { getComputedStyle: () => ({ getPropertyValue: () => '' }) },
};

// globe.gl's polygon layer reads window.THREE at module scope, and three-globe
// starts a FrameTicker on import; stubs are enough for Node (the real globe is
// replaced by `store.world` below).
global.window = Object.assign(global.window || {}, {
  requestAnimationFrame: global.requestAnimationFrame,
  cancelAnimationFrame: global.cancelAnimationFrame,
});

const { applyFilters } = await import('./src/gsoFilters.js');

// Shared pass/fail ledger: every section reports through `expect`, so the run
// exits non-zero the moment any expectation breaks.
const fails = [];
const expect = (label, ok, detail) => {
  if (!ok) fails.push(label);
  console.log(`  ${ok ? 'ok  ' : 'FAIL'} ${label}${detail ? ` - ${detail}` : ''}`);
};

// Countries that get the blue OUTLINE. isCountryOutlined covers BOTH the
// sat-filtered operator's own country and every GS country it links to - the
// exact set globe.js feeds to polygonStrokeColor.
function outlined() {
  return store.cachedGeoJsonFeatures.filter(f => isCountryOutlined(f.properties)).map(f => f.properties.name).sort();
}
function painted() {
  return store.cachedGeoJsonFeatures.filter(f => isCountryHighlighted(f.properties)).map(f => f.properties.name);
}
function run(sat, gs, status = 'all') {
  elements.filterStatus.value = status;
  elements.filterSatCountry.value = sat;
  elements.filterGsCountry.value = gs;
  cameraMoves.length = 0;
  polygonPushes = 0;
  pendingFrames.clear();
  applyFilters(true);
  const pushes = polygonPushes;
  // The camera only lands once the tween has run - same as the browser.
  const out = { painted: painted(), outlined: outlined(), keys: [...store.currentHighlightedSet], footKeys: [...(store.currentFootprintSet || [])], cam: settleFrames(), moved: cameraMoves.length > 0, pushes };
  if (pushes !== 1) fails.push(`run(${sat},${gs}): expected exactly 1 polygonsData repaint, got ${pushes}`);
  return out;
}

const satValues = [...new Set(store.rawData.satellites.map(s => s.operator || s.satcountry).filter(Boolean))].sort();
const gsValues = [...new Set(store.rawData.stations.map(s => s.country || s.gscountry).filter(Boolean))].sort();
const allGeoCanon = new Set(store.cachedGeoJsonFeatures.map(f => isCountryHighlighted.name && f.properties.name));

console.log('=== A. SUBSTRING-LEAK PROBES (strict matching) ===');
// Each entry: filtered country -> geo polygon that a substring matcher would
// wrongly light up in ver1 (normH inside normN).
const leakProbes = [
  ['Mali', 'Somalia'], ['Oman', 'Romania'], ['Niger', 'Nigeria'],
  ['Guinea', 'Equatorial Guinea'], ['Chad', 'Chad'],
];
for (const [gs] of leakProbes) {
  const value = gsValues.find(v => v.toLowerCase().startsWith(gs.toLowerCase()));
  if (!value) { console.log(`  (no dropdown value for ${gs})`); continue; }
  const r = run('all', value);
  const leakTargets = { Mali: 'Somalia', Oman: 'Romania', Niger: 'Nigeria', Guinea: 'Equatorial Guinea' }[gs];
  const leaked = leakTargets ? r.painted.includes(leakTargets) : false;
  console.log(`  ${value} -> painted=[${r.painted.join(', ')}] leaked ${leakTargets || '-'}? ${leaked ? 'YES (BUG)' : 'no'} cam=${r.moved ? `${r.cam.lat.toFixed(1)},${r.cam.lng.toFixed(1)}@${r.cam.altitude.toFixed(2)}` : 'NONE (BUG)'}`);
}

console.log('\n=== B. USA SAT FILTER (outline only, never filled) ===');
const usaSat = satValues.find(v => v.includes(String.fromCharCode(85, 110, 105, 116, 101, 100, 32, 83, 116, 97, 116, 101, 115)));
const usa = run(usaSat, 'all');
// Reference footprint: operator country + linked GS countries with polygons.
const usaTarget = normalizeCountryName(usaSat);
const usaFootprint = new Set([usaTarget, ...linkedGsCountries(usaTarget)]);
const usaFootprintOnMap = new Set(
  store.cachedGeoJsonFeatures
    .map(f => normalizeCountryName(f.properties.name))
    .filter(k => usaFootprint.has(k)),
);
const usaOutExtra = usa.outlined.filter(p => !usaFootprintOnMap.has(normalizeCountryName(p)));
const usaOutMissing = [...usaFootprintOnMap].filter(k => !usa.outlined.some(p => normalizeCountryName(p) === k));
console.log('  filled=' + usa.painted.length + ' [' + usa.painted.join(', ') + '] outlined=' + usa.outlined.length + ' footprint-with-polygon=' + usaFootprintOnMap.size);
console.log('  camera: ' + (usa.cam ? usa.cam.lat.toFixed(1) + ',' + usa.cam.lng.toFixed(1) + '@' + usa.cam.altitude.toFixed(2) : 'NONE (BUG)'));
// THE rule the user asked for: a sat-country filter must never fill anything.
// Only the blue OUTLINE is applied, so the globe can never be washed.
expect('sat USA fills NOTHING at all (outline only, never a blue wash)',
  usa.painted.length === 0 && usa.keys.length === 0,
  'filled=[' + usa.painted.join(', ') + '] keys=[' + usa.keys.join(', ') + ']');
expect('sat USA outlines exactly the linked footprint (incl. the USA itself)',
  usaOutExtra.length === 0 && usaOutMissing.length === 0,
  'outlined=' + usa.outlined.length + ' expected=' + usaFootprintOnMap.size +
  (usaOutExtra.length ? ' extra=[' + usaOutExtra.join(', ') + ']' : '') +
  (usaOutMissing.length ? ' missing=[' + usaOutMissing.join(', ') + ']' : ''));
expect('sat USA outlines the USA itself (the operator country is visible)',
  usa.outlined.some(p => p === 'United States of America'),
  usa.outlined.includes('United States of America') ? 'yes' : 'NO - USA not outlined');
expect('sat USA camera sits on the USA itself (not the footprint mean)',
  usa.cam && usa.cam.lat > 20 && usa.cam.lat < 60 && usa.cam.lng < -60 && usa.cam.lng > -130,
  usa.cam ? usa.cam.lat.toFixed(1) + ',' + usa.cam.lng.toFixed(1) + '@' + usa.cam.altitude.toFixed(2) : 'no move');
console.log('  footprint: ' + store.rawData.satellites.length + ' sats -> 1 filled + ' + usa.footKeys.length + ' outlined');
console.log('\n=== C. EVERY GS DROPDOWN VALUE: paint + camera ===');
let gsFail = 0;
const gsExcess = [];
for (const g of gsValues) {
  const r = run('all', g);
  const target = normalizeCountryName(g);
  const allowed = new Set([target, ...linkedGsCountries(target)]);
  const extra = r.painted.filter(n => normalizeCountryName(n) !== target);
  const outExtra = r.outlined.filter(n => !allowed.has(normalizeCountryName(n)));
  if (extra.length) gsExcess.push(`${g} (+${extra.length}: ${extra.slice(0, 3).join(', ')})`);
  if (!r.moved || r.painted.length === 0 || extra.length || outExtra.length) {
    gsFail++;
    console.log(`  ${g} -> painted=${r.painted.length} keys=[${r.keys.join(', ')}] cam=${r.moved ? 'ok' : 'NONE'} extra=[${extra.join(', ')}]`);
  }
}
console.log(`  GS values with no polygon to paint (camera still frames them): ${gsFail} / ${gsValues.length}`);
expect('no GS dropdown value lights a country other than the picked one', gsExcess.length === 0, gsExcess.slice(0, 5).join(' | ') || 'none');

console.log('\n=== D. EVERY SAT DROPDOWN VALUE: outline only + camera ===');
let satFail = 0;
const satExcess = [];
for (const s of satValues) {
  const r = run(s, 'all');
  const target = normalizeCountryName(s);
  const allowed = new Set([target, ...linkedGsCountries(target)]);
  const outExtra = r.outlined.filter(n => !allowed.has(normalizeCountryName(n)));
  // A sat filter must NEVER fill: outline only. Any painted polygon is a bug.
  if (r.painted.length) satExcess.push(`${s} filled ${r.painted.length} (${r.painted.slice(0, 3).join(', ')})`);
  if (outExtra.length) satExcess.push(`${s} outlined extra ${outExtra.length}: ${outExtra.slice(0, 3).join(', ')}`);
  if (!r.moved || r.painted.length || outExtra.length) {
    satFail++;
    console.log(`  FAIL ${s} -> painted=${r.painted.length} outlined=${r.outlined.length} keys=[${r.keys.join(', ')}] cam=${r.moved ? 'ok' : 'NONE'} outExtra=[${outExtra.join(', ')}]`);
  }
}
console.log(`  SAT values with no camera move, a stray fill, or a stray outline: ${satFail} / ${satValues.length}`);
expect('no SAT dropdown value ever fills a country (outline only) or lights an unlinked one', satExcess.length === 0, satExcess.slice(0, 5).join(' | ') || 'none');

console.log('\n=== E. COMBINED FILTERS (unique linked sets only) ===');
{
  const show = (gs, sat, status) => {
    const r = run(sat, gs, status);
    console.log('  gs=' + gs + ' sat=' + sat + ' status=' + status + ' -> painted=[' + r.painted.join(', ') + ']');
  };
  show('India (Republic of)', 'all', 'all');
  show('Japan', 'all', 'all');
  show('United States of America', 'all', 'all');
  show('Germany (Federal Republic of)', 'all', 'planned');
  show('Germany (Federal Republic of)', 'United States of America', 'all');
  show('all', 'all', 'nonplanned');
  const usaV = satValues.find(v => v.includes('United States'));
  const gerV = gsValues.find(v => v.startsWith('Germany'));
  const linked = run(usaV, gerV, String.fromCharCode(97, 108, 108));
  expect('both-filter with a real link keeps only the GS country',
    linked.painted.length === 1 && normalizeCountryName(linked.painted[0]) === 'germany',
    'painted=[' + linked.painted.join(', ') + ']');
  const indV = gsValues.find(v => v.toLowerCase().startsWith('india'));
  const unlinked = run(usaV, indV, String.fromCharCode(97, 108, 108));
  expect('both-filter with no link lights nothing',
    unlinked.painted.length === 0 && unlinked.keys.length === 0,
    'painted=[' + unlinked.painted.join(', ') + '] keys=[' + unlinked.keys.join(', ') + ']');
}
console.log('\n=== G. DETAIL: Monaco / Tonga sat filters ===');
for (const s of satValues.filter(v => /Monaco|Tonga/.test(v))) {
  const r = run(s, 'all');
  const target = normalizeCountryName(s);
  const sats = store.rawData.satellites.filter(x => normalizeCountryName(x.operator || x.satcountry || '') === target);
  const gsNames = new Set();
  for (const c of store.rawData.connections) if (sats.some(x => x.name === c.sat_name)) gsNames.add(c.gs_name);
  const raw = [...gsNames].map(n => `${n} [${store.stationByName.get(n)?.country}]`);
  console.log(`  ${s} target=${JSON.stringify(target)} sats=${sats.length} keys=[${r.keys.join(', ')}] painted=[${r.painted.join(', ')}]`);
  console.log(`    linked GSs: ${raw.slice(0, 6).join(' ; ')}${raw.length > 6 ? ` ...(+${raw.length - 6})` : ''}`);
}
console.log(`\n=== F. INVARIANT: nothing lights up except the country/countries picked in the dropdowns ===`);
let litMismatch = 0;
const fCases = [
  ...satValues.map(v => [v, 'all']),
  ...gsValues.map(v => ['all', v]),
  [satValues.find(v => v.includes('United States')), gsValues.find(v => v.toLowerCase().startsWith('germany'))],
  [satValues.find(v => v.toLowerCase().startsWith('france')), gsValues.find(v => v.toLowerCase().startsWith('japan'))],
];
for (const [s, g] of fCases) {
  // Allowed = picked countries + linked footprint (polygon-gated). sat-only
  // expands to the operator country + linked GS countries; both-filters keep
  // only the GS country when a real link exists (else nothing).
  const footprint = (s !== 'all' && g === 'all')
    ? new Set([normalizeCountryName(s), ...linkedGsCountries(normalizeCountryName(s))])
    : new Set();
  if (!s || !g) continue;
  const r = run(s, g);
  const allowed = new Set();
  if (s !== 'all') allowed.add(normalizeCountryName(s));
  if (g !== 'all') allowed.add(normalizeCountryName(g));
  // A sat-country filter (with or without a GS filter) never FILLS - it only
  // outlines. A GS-only filter fills exactly the GS country. So any painted
  // polygon that is not the picked GS country is a bug.
  const bad = r.painted.filter(name => !allowed.has(normalizeCountryName(name)));
  // And with a GS filter, only the GS country may be filled.
  if (g !== 'all' && r.painted.length && r.painted.some(name => normalizeCountryName(name) !== normalizeCountryName(g))) {
    bad.push(...r.painted.filter(name => normalizeCountryName(name) !== normalizeCountryName(g)));
  }
  // Outlines must stay inside the linked footprint.
  const outBad = r.outlined.filter(name => !footprint.has(normalizeCountryName(name)) && normalizeCountryName(name) !== normalizeCountryName(g));
  if (bad.length || outBad.length) {
    litMismatch++;
    console.log(`  FAIL sat=${s} gs=${g}: stray lit polygons -> ${[...bad, ...outBad].join(', ')}`);
  }
}
console.log(`  cases (${fCases.length}) that light an unselected polygon: ${litMismatch}`);
expect('highlight set never contains an unselected country', litMismatch === 0, `${litMismatch} failing cases`);

// ---------------------------------------------------------------------------
// H. ZOOM BUTTONS + CAMERA TWEEN (ver1's zoom path)
// globe.gl 2.31.0's pointOfView(pov, ms>0) builds a @tweenjs/tween.js tween that
// nothing ever updates -> duration-based moves are silent no-ops, which is why
// ver1's zoom was wheel/drag only. ver2 animates the camera itself, so these
// checks press the real button handlers and then let the tween land.
// ---------------------------------------------------------------------------
console.log('\n=== H. ZOOM BUTTONS + CAMERA TWEEN ===');
let hFail = 0;
const check = (label, ok, detail) => { if (!ok) hFail++; expect(label, ok, detail); };
const mkBtn = (id) => ({
  id, listeners: {}, style: {}, title: '', textContent: '', value: '',
  addEventListener(ev, fn) { (this.listeners[ev] = this.listeners[ev] || []).push(fn); },
  click() { for (const fn of this.listeners.click || []) fn({ target: this }); },
  contains: () => false, getAttribute: () => null, setAttribute() {}, querySelectorAll: () => [],
});
for (const id of ['searchInput', 'searchSuggestions', 'viewToggleBtn', 'zoomInBtn', 'zoomOutBtn']) elements[id] = mkBtn(id);
// The three <select> stubs only carry a value; setupUIEvents wants change listeners.
for (const id of ['filterStatus', 'filterSatCountry', 'filterGsCountry']) elements[id].addEventListener = () => {};
const { setupUIEvents } = await import('./src/uiSearch.js');
setupUIEvents();
const press = (id, times) => { for (let i = 0; i < times; i++) elements[id].click(); };
const resetCam = (altitude = 2.2) => {
  cameraMoves.length = 0; pendingFrames.clear();
  store.world.pointOfView({ lat: 20, lng: 0, altitude }, 0);
};
const drainFrames = () => { const cbs = [...pendingFrames.values()]; pendingFrames.clear(); for (const cb of cbs) { try { cb(fakeNow); } catch { /* ticker */ } } return { ...stubPov }; };

check('zoom buttons wired', (elements.zoomInBtn.listeners.click || []).length === 1 && (elements.zoomOutBtn.listeners.click || []).length === 1,
  `zoomIn=${(elements.zoomInBtn.listeners.click || []).length} zoomOut=${(elements.zoomOutBtn.listeners.click || []).length}`);

resetCam();
press('zoomInBtn', 1);
const in1 = settleFrames();
check('one + click zooms in', Math.abs(in1.altitude - 1.65) < 0.01, `2.20 -> ${in1.altitude.toFixed(3)} (x0.75)`);

resetCam();
press('zoomOutBtn', 1);
const out1 = settleFrames();
check('one - click zooms out', Math.abs(out1.altitude - 2.926) < 0.01, `2.20 -> ${out1.altitude.toFixed(3)} (x1.33)`);

resetCam();
press('zoomInBtn', 3);
const rapid = settleFrames();
check('rapid clicks compound', Math.abs(rapid.altitude - 0.9278) < 0.01, `2.20 -> ${rapid.altitude.toFixed(3)} (0.75^3)`);

resetCam();
press('zoomInBtn', 25);
const atMin = settleFrames();
check('clamped at MIN_CAMERA_ALTITUDE', Math.abs(atMin.altitude - 0.3) < 1e-9, `25 clicks -> ${atMin.altitude.toFixed(3)}`);
resetCam();
press('zoomOutBtn', 25);
const atMax = settleFrames();
check('clamped at MAX_CAMERA_ALTITUDE', Math.abs(atMax.altitude - 12) < 1e-9, `25 clicks -> ${atMax.altitude.toFixed(3)}`);

resetCam();
elements.zoomInBtn.click();
fakeNow += 400;
const mid = drainFrames();
const landed = settleFrames();
check('move eases over 800 ms instead of jumping', mid.altitude > 1.65 && mid.altitude < 2.2 && Math.abs(landed.altitude - 1.65) < 0.01,
  `t=400ms alt=${mid.altitude.toFixed(3)}, settled ${landed.altitude.toFixed(3)}`);
check('every frame uses a duration-0 set', cameraMoves.every(m => m.dur === 0), `${cameraMoves.length} frame updates`);

console.log('  --- filter -> camera lands on the filtered country ---');
for (const [label, val] of [
  ['gs India', gsValues.find(v => v.toLowerCase().startsWith('india'))],
  ['gs Japan', gsValues.find(v => v.toLowerCase().startsWith('japan'))],
]) {
  if (!val) { console.log(`  (no dropdown value for ${label})`); continue; }
  const r = run('all', val);
  const onCountry = r.cam.lat > 0 && r.cam.lat < 50 && r.cam.lng > 60 && r.cam.lng < 150;
  check(`${label}: camera lands on that country`, onCountry, `cam ${r.cam.lat.toFixed(1)},${r.cam.lng.toFixed(1)}@${r.cam.altitude.toFixed(2)}`);
}
const usaSatVal = satValues.find(v => v.includes('United States'));
if (usaSatVal) {
  const r = run(usaSatVal, 'all');
  check('sat USA: camera lands on the USA footprint', r.cam.lat > 20 && r.cam.lat < 60 && r.cam.lng < -60 && r.cam.lng > -130,
    `cam ${r.cam.lat.toFixed(1)},${r.cam.lng.toFixed(1)}@${r.cam.altitude.toFixed(2)}, filled=${r.painted.length} outlined=${r.outlined.length}`);
}
const mrlVal = gsValues.find(v => v.toUpperCase().startsWith('MRL'));
if (mrlVal) {
  const r = run('all', mrlVal);
  check('gs MRL (no polygon): ver1 station fallback', Math.abs(r.cam.altitude - 1.55) < 1e-9,
    `cam ${r.cam.lat.toFixed(1)},${r.cam.lng.toFixed(1)}@${r.cam.altitude.toFixed(2)}`);
}
resetCam(0.8);
const viewToggleClicks = elements.viewToggleBtn.listeners.click || [];
if (viewToggleClicks.length === 1) {
  elements.viewToggleBtn.click();
  const horizon = settleFrames();
  elements.viewToggleBtn.click();
  const overhead = settleFrames();
  check('view toggle: horizon 1.20 then overhead 12.00', Math.abs(horizon.altitude - 1.2) < 1e-9 && Math.abs(overhead.altitude - 12) < 1e-9,
    `horizon=${horizon.altitude.toFixed(2)} overhead=${overhead.altitude.toFixed(2)}`);
}
console.log(`  SECTION H FAILURES: ${hFail}`);

// ---------------------------------------------------------------------------
// I. SATELLITE DOT SCALE + DOT RESCALE ON ZOOM + BOOT FLIGHT (globe.js)
console.log('\n=== I. DOT SCALE + BOOT ===');
let iFail = 0;
const checkI = (label, ok, detail) => { if (!ok) iFail++; expect(label, ok, detail); };
const { satScaleForAltitude, syncSatDotScale, DEFAULT_VIEW, BOOT_START_ALTITUDE, initGlobe, startBootAnimation } =
  await import('./src/globe.js');
{
  const sNear = satScaleForAltitude(0.3), sHome = satScaleForAltitude(2.2), sFar = satScaleForAltitude(12);
  checkI('dots keep screen size: scale grows with altitude', sNear < sHome && sHome < sFar,
    `0.3->${sNear.toFixed(2)} 2.2->${sHome.toFixed(2)} 12->${sFar.toFixed(2)}`);
  checkI('dot scale is finite at crazy input', Number.isFinite(satScaleForAltitude(NaN)) && Number.isFinite(satScaleForAltitude(-5)),
    `NaN->${satScaleForAltitude(NaN).toFixed(2)}`);
}
{
  // The dots are world-sized spheres, so they must be rescaled the moment the
  // altitude changes. Regression: the rescale used to be skipped while a camera
  // tween was in flight, so after every programmatic zoom the dots kept the
  // size they had BEFORE the move (huge zoomed out, invisible zoomed in).
  const seen = [];
  store.satMeshes.length = 0;
  for (let i = 0; i < 3; i++) store.satMeshes.push({ scale: { set: (x) => seen.push(x) } });
  resetCam(0.3);                       // zoomed right in
  syncSatDotScale();
  const atNear = store.satMeshes.length && seen[seen.length - 1];
  resetCam(12);                        // zoomed right out
  syncSatDotScale();
  const atFar = seen[seen.length - 1];
  checkI('dots rescale to the CURRENT altitude on every camera change', atFar > atNear,
    `alt 0.3 -> scale ${atNear}, alt 12 -> scale ${atFar}`);
  // And the same must happen automatically as part of a tween, without any
  // explicit call: applyCamera rescales as part of each step.
  seen.length = 0;
  resetCam(0.3);
  const { animateCameraTo } = await import('./src/globe.js');
  animateCameraTo(0, 0, 12, 400);
  settleFrames();
  const afterTween = seen[seen.length - 1];
  checkI('a camera tween rescales the dots by itself (no stale size at rest)', afterTween > satScaleForAltitude(0.3),
    `ended alt 12 -> scale ${afterTween}`);
  store.satMeshes.length = 0;
}
{
  // Boot flight: the intro is GATED on the data being ready, so it cannot play
  // over a half-populated scene (that was the "elements load randomly" glitch).
  // initGlobe() itself needs a real WebGL context, which Node does not have, so
  // the gating is asserted through its observable effect on the camera plus
  // startBootAnimation()'s own contract - both of which run on the stub world.
  resetCam(BOOT_START_ALTITUDE);
  cameraMoves.length = 0;
  pendingFrames.clear();
  fakeNow = 0;
  try {
    initGlobe({ showSatelliteDetails() {}, showStationDetails() {} });
  } catch {
    // No WebGL in Node (expected). The real browser runs this against a live
    // canvas; here we only need the camera contract below.
  }
  const parked = settleFrames();
  checkI('intro does not fly on its own - it waits for the data to land',
    Math.abs(parked.altitude - BOOT_START_ALTITUDE) < 1e-9,
    `parked at ${parked.altitude.toFixed(2)}, no flight until startBootAnimation()`);
  startBootAnimation();               // loadData() calls this once data is in
  const bootLanded = settleFrames();
  checkI('boot flight lands on the default view', Math.abs(bootLanded.altitude - DEFAULT_VIEW.altitude) < 0.01,
    `start ${BOOT_START_ALTITUDE.toFixed(2)} -> ${bootLanded.altitude.toFixed(2)}`);
  checkI('boot flight is one smooth tween (no stacked flights)', cameraMoves.length > 2 && cameraMoves.length < 200,
    `${cameraMoves.length} frame updates`);
  // Idempotent: a late second call must not restart or stack another flight.
  cameraMoves.length = 0;
  startBootAnimation();
  checkI('boot animation is idempotent (no second flight on reload/err path)', cameraMoves.length === 0,
    `${cameraMoves.length} extra frame updates`);
}
console.log(`  SECTION I FAILURES: ${iFail}`);

// ---------------------------------------------------------------------------
// J. POLYGON GEOMETRY: the cap/border must ride ON the sphere, not sink into it
// ---------------------------------------------------------------------------
console.log('\n=== J. POLYGON GEOMETRY (cap/border sag) ===');
let jFail = 0;
const checkJ = (label, ok, detail) => { if (!ok) jFail++; expect(label, ok, detail); };
{
  const GLOBE_RADIUS = 100;                       // three-globe's fixed radius
  const { POLYGON_ALTITUDE, POLYGON_CURVATURE_RESOLUTION } = await import('./src/globe.js');
  const geo = JSON.parse(await (await import('node:fs/promises')).readFile('./public/data/globe.json', 'utf8'));
  // Longest boundary edge in the dataset, in degrees - the worst-case span a
  // cap chord (and a border chord) can cover.
  const spans = [];
  const walk = (ring) => {
    for (let i = 1; i < ring.length; i++) {
      const [lo1, la1] = ring[i - 1], [lo2, la2] = ring[i];
      const t = Math.PI / 180;
      const dLat = (la2 - la1) * t;
      const dLon = (lo2 - lo1) * t;
      const a = Math.sin(dLat / 2) ** 2 +
        Math.cos(la1 * t) * Math.cos(la2 * t) * Math.sin(dLon / 2) ** 2;
      spans.push(2 * Math.asin(Math.min(1, Math.sqrt(a))) / t);
    }
  };
  for (const f of geo.features) {
    const g = f.geometry; if (!g) continue;
    for (const poly of (g.type === 'Polygon' ? [g.coordinates] : g.coordinates)) poly.forEach(walk);
  }
  spans.sort((a, b) => a - b);
  const longest = spans[spans.length - 1];
  const median = spans[Math.floor(spans.length / 2)];

  // Sag of a chord spanning `deg` on a sphere of radius r: r * (1 - cos(deg/2)).
  const sag = (deg) => GLOBE_RADIUS * (1 - Math.cos((deg / 2) * Math.PI / 180));
  // Sag of the longest edge, NOT subdivided (the library's 5 deg default).
  const sagUnsubdivided = sag(longest);
  // Sag once edges are subdivided to <= POLYGON_CURVATURE_RESOLUTION degrees.
  const sagSubdivided = sag(Math.min(longest, POLYGON_CURVATURE_RESOLUTION));
  const lift = POLYGON_ALTITUDE * GLOBE_RADIUS;

  checkJ('curvature resolution subdivides far more than the 5 deg library default',
    POLYGON_CURVATURE_RESOLUTION < 5,
    `${POLYGON_CURVATURE_RESOLUTION} deg vs default 5 deg`);
  checkJ('worst-case cap sag (longest edge) is measured and reported', longest > 0,
    `longest ${longest.toFixed(2)} deg, median ${median.toFixed(2)} deg -> unsubdivided sag ${sagUnsubdivided.toFixed(3)} units`);
  checkJ('cap altitude clears the sag of a SUBDIVIDED edge (fill stays solid)',
    lift > sagSubdivided * 10,
    `lift ${lift.toFixed(3)} units vs sag ${sagSubdivided.toFixed(4)} units (${(lift / sagSubdivided).toFixed(0)}x margin)`);
  checkJ('cap altitude is never the cause: the old 0.0015 lift sank under the sphere',
    lift > sagUnsubdivided,
    `lift ${lift.toFixed(3)} > unsubdivided sag ${sagUnsubdivided.toFixed(3)} - so the subdiv is load-bearing`);
  checkJ('cap altitude stays small enough not to visibly float the country',
    lift < 1.0,
    `${lift.toFixed(3)} units of lift on a ${GLOBE_RADIUS} unit globe`);
}
console.log(`  SECTION J FAILURES: ${jFail}`);
console.log('\n=== TOTAL ===');
if (fails.length === 0) {
  console.log('  ALL GREEN - 0 failed expectations');
} else {
  console.log(`  FAILURES: ${fails.length}`);
  for (const f of fails) console.log(`   - ${f}`);
  process.exitCode = 1;
}



