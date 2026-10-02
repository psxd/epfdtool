// Instanced link-beam rendering.
//
// Why: 7840 links as individual meshes = 7840 draw calls + heavy GC on every
// filter. One InstancedMesh (8-sided cylinder) = 1 draw call; per-link state
// (colour/opacity) is updated via instanceColor without rebuilding geometry.
// Lines are translucent (opacity ~0.5 GSO / 0.2 LEO-idle) for visibility.
import * as THREE from 'three';
import { PALETTE, GSO_ALTITUDE_RATIO } from './constants.js';
import { store } from './state.js';
import { normalizeCountryName } from './countryNorm.js';

const LINK_RADIAL_SEGMENTS = 6;
const GSO_COLOR = new THREE.Color(PALETTE.gray_mid1).multiplyScalar(0.85);
const GSO_COLOR_HEX = GSO_COLOR.getHex();
const LEO_IDLE_COLOR = new THREE.Color(0x8f8f8f);
const LEO_HIT_COLOR = new THREE.Color(0x00ffcc);

// A highlighted beam is re-composed with this radial multiplier on the shared
// cylinder geometry, i.e. 2.6x thicker than a normal link. The cylinder's own
// radius (0.09/0.03) is unchanged, so un-highlighted beams keep their current
// appearance exactly.
const HIGHLIGHT_RADIAL_SCALE = 2.6;
const HIGHLIGHT_HEX = new THREE.Color(PALETTE.false_sat).getHex();

let sharedLinkGeo = null;
const _m = new THREE.Matrix4();
const _q = new THREE.Quaternion();
const _up = new THREE.Vector3(0, 1, 0);
const _mid = new THREE.Vector3();
const _dir = new THREE.Vector3();
const _scale = new THREE.Vector3();
const _col = new THREE.Color();

// ---------------------------------------------------------------------------
// Per-instance visual state.
//
// Every beam's colour AND thickness are derived from these flags plus its
// stored geometry (gs position + unit direction + length), so any beam can be
// re-composed at a new radius without touching the connection rows or rebuilding
// geometry. Precedence, highest first: HIDDEN, LEO conflict, SELECTED, HOVER,
// base.
//
// HIDDEN is a DEGENERATE matrix (zero radial scale), not a geometry change: the
// beam is simply not drawn and still costs nothing - the whole link set stays a
// single InstancedMesh / one draw call either way.
const FLAG_HIDDEN = 1;
const FLAG_SELECTED = 2;
const FLAG_HOVER = 4;
const FLAG_LEO_CONFLICT = 8;

let beamFlags = null;    // Uint8Array(count)
let beamRadial = null;   // Float32Array(count), cached radial scale per beam
let selectionKey = null; // 'sat:NAME' | 'gs:NAME'
let hoverKey = null;     // 'sat:NAME' | 'gs:NAME'
let filterHighlightAll = false;

export const LEO_DIM_COLOR = LEO_IDLE_COLOR;

// Recompose ONE instance's transform from its stored geometry at the given
// radial scale. scaleRadial === 0 collapses it to a degenerate (invisible)
// matrix.
function composeBeam(i, scaleRadial) {
  const meta = store.linkMeta;
  const len = meta.len[i];
  const x = meta.gsX[i], y = meta.gsY[i], z = meta.gsZ[i];
  _mid.set(x + (meta.dirX[i] * len) / 2, y + (meta.dirY[i] * len) / 2, z + (meta.dirZ[i] * len) / 2);
  _dir.set(meta.dirX[i], meta.dirY[i], meta.dirZ[i]);
  _q.setFromUnitVectors(_up, _dir);
  _scale.set(scaleRadial, len, scaleRadial);
  _m.compose(_mid, _q, _scale);
  store.linkMesh.setMatrixAt(i, _m);
}

// Apply the flag set to every instance: colour first, then transform (and only
// when the cached radial scale differs, so a colour-only change such as a hover
// costs no matrix work).
function refreshBeamVisuals() {
  const mesh = store.linkMesh;
  const meta = store.linkMeta;
  if (!mesh || !meta || !beamFlags) return;
  const base = meta.isGsoMode ? GSO_COLOR : LEO_IDLE_COLOR;
  for (let i = 0; i < meta.count; i++) {
    const f = beamFlags[i];
    const selected = (f & FLAG_SELECTED) !== 0 || filterHighlightAll;
    let radial = 1;
    if (f & FLAG_HIDDEN) {
      radial = 0;
    } else if (f & FLAG_LEO_CONFLICT) {
      _col.copy(LEO_HIT_COLOR);
      radial = HIGHLIGHT_RADIAL_SCALE;
    } else if (selected) {
      _col.setHex(HIGHLIGHT_HEX);
      radial = HIGHLIGHT_RADIAL_SCALE;
    } else if (f & FLAG_HOVER) {
      _col.setHex(HIGHLIGHT_HEX);
    } else {
      _col.copy(base);
    }
    mesh.setColorAt(i, _col);
    if (beamRadial[i] !== radial) {
      composeBeam(i, radial);
      beamRadial[i] = radial;
    }
  }
  mesh.instanceMatrix.needsUpdate = true;
  if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
}

function ensureBeamState(count) {
  if (beamFlags && beamFlags.length === count) return;
  beamFlags = new Uint8Array(count);
  beamRadial = new Float32Array(count).fill(-1);
}

function clearFlags(mask) {
  if (!beamFlags) return;
  const meta = store.linkMeta;
  if (!meta) return;
  for (let i = 0; i < meta.count; i++) beamFlags[i] &= ~mask;
}

// --- Selection (click / search) ---------------------------------------------
// Every beam touching the selected satellite or ground station is highlighted
// AND thickened; every other beam is removed from view, so the selected entity's
// links are the only ones left on the globe.
export function setBeamSelection(kind, id) {
  const meta = store.linkMeta;
  if (!meta || store.isLeoActive) return;
  const key = kind + ':' + id;
  if (selectionKey === key) return;
  selectionKey = key;
  hoverKey = null;
  filterHighlightAll = false;
  // Matched on the endpoint ID, so exactly this node's own beams are kept and
  // every other beam hidden - the number lit always equals the number listed.
  const ids = kind === 'sat' ? meta.satId : meta.gsId;
  for (let i = 0; i < meta.count; i++) {
    beamFlags[i] = ids[i] === id ? FLAG_SELECTED : FLAG_HIDDEN;
  }
  refreshBeamVisuals();
}

export function clearBeamSelection() {
  if (!selectionKey && !filterHighlightAll) return;
  selectionKey = null;
  filterHighlightAll = false;
  clearFlags(FLAG_HIDDEN | FLAG_SELECTED);
  refreshBeamVisuals();
}

// A country filter keeps every drawn beam (the filtered rows already ARE the
// filtered set), but paints and thickens all of them so the active filter is
// unmistakable. Cleared again by clearBeamSelection().
export function setFilterBeamHighlight(on) {
  if (!store.linkMeta) return;
  filterHighlightAll = !!on;
  if (filterHighlightAll) selectionKey = null;
  refreshBeamVisuals();
}

// LEO: only the conflicting link itself is marked, never the whole ground
// station's link set.
export function markLeoConflicts(indices) {
  if (!beamFlags) return;
  for (const i of indices) beamFlags[i] |= FLAG_LEO_CONFLICT;
  refreshBeamVisuals();
}

export function clearLeoConflicts() {
  if (!beamFlags) return;
  clearFlags(FLAG_LEO_CONFLICT);
  refreshBeamVisuals();
}

function disposeLinkMesh() {
  if (!store.linkMesh) return;
  store.world.scene().remove(store.linkMesh);
  store.linkMesh.dispose();
  store.linkMesh = null;
  store.linkLinesMesh = null;
  store.linkMeta = null;
  beamFlags = null;
  beamRadial = null;
  selectionKey = null;
  hoverKey = null;
  filterHighlightAll = false;
}

function ensureLinkMesh(count, opacity) {
  const scene = store.world.scene();
  if (store.linkMesh && store.linkMesh.count === count) {
    store.linkMesh.material.opacity = opacity;
    return store.linkMesh;
  }
  disposeLinkMesh();
  if (count === 0) return null;
  if (!sharedLinkGeo) sharedLinkGeo = new THREE.CylinderGeometry(0.09, 0.03, 1, LINK_RADIAL_SEGMENTS, 1, true);
  const material = new THREE.MeshBasicMaterial({
    transparent: true, opacity, depthWrite: false,
  });
  const mesh = new THREE.InstancedMesh(sharedLinkGeo, material, count);
  mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
  mesh.frustumCulled = false;
  for (let i = 0; i < count; i++) mesh.setColorAt(i, _col.copy(GSO_COLOR));
  mesh.instanceColor.setUsage(THREE.DynamicDrawUsage);
  scene.add(mesh);
  store.linkMesh = mesh;
  store.linkLinesMesh = mesh;
  return mesh;
}

export function renderStraightLinkBeams(connections, isGsoMode = false) {
  if (!store.world) return;
  const list = connections || [];
  const opacity = isGsoMode ? 0.5 : 0.2;
  const mesh = ensureLinkMesh(list.length, opacity);
  if (!mesh || list.length === 0) {
    disposeLinkMesh();
    store.linkMeta = null;
    return;
  }

  const n = list.length;
  const gsLat = new Float32Array(n);
  const gsLon = new Float32Array(n);
  const gsX = new Float32Array(n);
  const gsY = new Float32Array(n);
  const gsZ = new Float32Array(n);
  const dirX = new Float32Array(n);
  const dirY = new Float32Array(n);
  const dirZ = new Float32Array(n);
  const len = new Float32Array(n);
  const country = new Array(n);
  const ident = new Array(n);
  const satName = new Array(n);
  const gsName = new Array(n);
  // Beam identity is the ENDPOINT ID, not the name. Name-based matching merged
  // every beam of two same-named stations into one highlight set, so a click
  // lit beams belonging to the other site.
  const satId = new Array(n);
  const gsId = new Array(n);

  for (let i = 0; i < n; i++) {
    const conn = list[i];
    // Resolve BOTH endpoints by id. The connection row already carries the exact
    // position it was filed against, so the beam is built from the row itself -
    // no name lookup that could snap it onto a different station sharing the
    // name, and no ambiguity when a satellite name spans two orbital slots.
    const satLon = store.satLonById.get(conn.sat_id) ?? conn.sat_lon ?? 0;
    const gLat = conn.gs_lat;
    const gLon = conn.gs_lon;
    const p1 = store.world.getCoords(gLat, gLon, 0.01);
    const p2 = store.world.getCoords(0, satLon, GSO_ALTITUDE_RATIO);
    _dir.set(p2.x - p1.x, p2.y - p1.y, p2.z - p1.z);
    const beamLen = _dir.length() || 1e-6;

    gsLat[i] = gLat; gsLon[i] = gLon;
    gsX[i] = p1.x; gsY[i] = p1.y; gsZ[i] = p1.z;
    dirX[i] = (p2.x - p1.x) / beamLen; dirY[i] = (p2.y - p1.y) / beamLen; dirZ[i] = (p2.z - p1.z) / beamLen;
    len[i] = beamLen;
    const stn = store.stationById.get(conn.gs_id);
    country[i] = stn ? normalizeCountryName(stn.country || stn.gscountry || '') : '';
    ident[i] = `${gLat},${gLon}-${satLon}`;
    satName[i] = conn.sat_name;
    gsName[i] = conn.gs_name;
    satId[i] = conn.sat_id;
    gsId[i] = conn.gs_id;
  }

  // Fresh link set: every flag cleared (a beam re-render invalidates any
  // previous selection / filter highlight), then one pass of colours + matrices.
  store.linkMeta = { count: n, gsLat, gsLon, gsX, gsY, gsZ, dirX, dirY, dirZ, len, country, ident, satName, gsName, satId, gsId, isGsoMode };
  ensureBeamState(n);
  hoverKey = null;
  selectionKey = null;
  filterHighlightAll = false;
  for (let i = 0; i < n; i++) beamRadial[i] = -1; // force a matrix write
  refreshBeamVisuals();
}

// Recolour instances by index. Kept as the thin escape hatch it always was;
// selection / filter / LEO highlighting all go through the flag system above so
// the transforms stay in sync with the colours.
export function paintLinkInstances(indices, hex) {
  const mesh = store.linkMesh;
  if (!mesh || !beamFlags) return;
  _col.setHex(hex);
  for (const i of indices) mesh.setColorAt(i, _col);
  if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
}

// --- Transient hover highlight ------------------------------------------------
// Colour-only: brightens the beams of ONE node so a viewer can see exactly
// which lines belong to the hovered satellite/station and check them against
// the hover list. It never adds/removes beams - the drawn set is always
// exactly the (filtered) connection rows. Suppressed while a selection or a
// country-filter highlight is active: those already decide which beams are
// orange, and hover must not repaint over them.
export function highlightBeams(kind, id) {
  const meta = store.linkMeta;
  if (!meta || !meta.isGsoMode || store.isLeoActive) return;
  if (selectionKey || filterHighlightAll) return;
  const key = kind + ':' + id;
  if (hoverKey === key) return;
  clearFlags(FLAG_HOVER);
  hoverKey = key;
  const ids = kind === 'sat' ? meta.satId : meta.gsId;
  for (let i = 0; i < meta.count; i++) {
    if (ids[i] === id) beamFlags[i] |= FLAG_HOVER;
  }
  refreshBeamVisuals();
}

export function clearBeamHighlight() {
  if (!hoverKey) return;
  hoverKey = null;
  clearFlags(FLAG_HOVER);
  refreshBeamVisuals();
}

export { GSO_COLOR_HEX };
