// LEO side-effects: link-intersection highlight + teardown.
// Perf: works on flat Float32 meta arrays of the instanced mesh (no Vector3
// allocs, no per-frame polygon rebuilds); paints instances in place.
import { EARTH_RADIUS_KM } from './constants.js';
import { store } from './state.js';
import { markLeoConflicts, clearLeoConflicts } from './links.js';

const DEG = Math.PI / 180;

// The 1-degree conflict threshold (kept from the original rule); CONE_COS is
// the legacy cone test's own 1-degree half-angle.
const CONFLICT_DEG = 1.0;
const CONE_COS = Math.cos(CONFLICT_DEG * DEG);

let lastPolyKey = '';

function refreshPolygonsIfNeeded() {
  if (!store.world || store.cachedGeoJsonFeatures.length === 0) return;
  const key = store.isLeoActive ? 'leo:' + store.currentHighlightedSet.size : 'gso';
  if (key === lastPolyKey) return;
  lastPolyKey = key;
  store.world.polygonsData([...store.cachedGeoJsonFeatures]);
}

// Central angle (degrees) between two geodetic points, haversine form -
// numerically stable for the very small angles this feature fires on (a plain
// dot-product cosine loses all precision below ~1e-4 deg).
export function centralAngleDeg(lat1, lon1, lat2, lon2) {
  const dLat = (lat2 - lat1) * DEG;
  let dLon = (lon2 - lon1) * DEG;
  if (dLon > Math.PI) dLon -= 2 * Math.PI;
  else if (dLon < -Math.PI) dLon += 2 * Math.PI;
  const a = Math.sin(dLat / 2) ** 2 +
    Math.cos(lat1 * DEG) * Math.cos(lat2 * DEG) * Math.sin(dLon / 2) ** 2;
  return 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a)) / DEG;
}

// A ground station is VISIBLE from a satellite at altitude h when it lies on
// the near cap: the Earth-angle between the satellite's sub-point and the
// station must not exceed the horizon angle acos(R / (R + h)). For a 400 km LEO
// that is ~19.8 deg, growing with altitude. This replaces the old fixed 8 deg
// lat/lon box (which silently discarded every station beyond it) and the
// impossible 100,000 km slant-range cut.
function horizonAngleDeg(altKm) {
  const r = Math.max(1, 1 + (Number(altKm) || 0) / EARTH_RADIUS_KM);
  return Math.acos(Math.min(1, 1 / r)) / DEG;
}

export function checkAndHighlightPassingLinks(leoCoordsVec, lat, lon, altKm = 0) {
  const meta = store.linkMeta;
  const lx = leoCoordsVec.x, ly = leoCoordsVec.y, lz = leoCoordsVec.z;
  if (meta) {
    const toPaint = [];
    const horizonCos = Math.cos(horizonAngleDeg(altKm) * DEG);
    const done = store.persistentlyHighlightedLinks;
    for (let i = 0; i < meta.count; i++) {
      const id = meta.ident[i];
      if (done.has(id)) continue;
      // Primary test: the angle between the satellite's CURRENT sub-point and
      // the ground station, gated on the visible hemisphere.
      const gamma = centralAngleDeg(lat, lon, meta.gsLat[i], meta.gsLon[i]);
      let conflict = false;
      if (gamma <= 90 && Math.cos(gamma * DEG) >= horizonCos) {
        conflict = gamma < CONFLICT_DEG;
      }
      if (!conflict) {
        // Legacy test, retained: the angle AT the ground station between its
        // drawn beam direction and the direction to the current sat position.
        const vx = lx - meta.gsX[i], vy = ly - meta.gsY[i], vz = lz - meta.gsZ[i];
        const vLen = Math.sqrt(vx * vx + vy * vy + vz * vz) || 1e-9;
        conflict = (vx * meta.dirX[i] + vy * meta.dirY[i] + vz * meta.dirZ[i]) / vLen >= CONE_COS;
      }
      if (!conflict) continue;
      // ONLY this link is marked: the ground station's other links stay exactly
      // as they are.
      done.add(id);
      const c = meta.country[i];
      if (c) store.currentHighlightedSet.add(c);
      toPaint.push(i);
    }
    if (toPaint.length > 0) markLeoConflicts(toPaint);
  }
  const countEl = document.getElementById('leoCompromisedCount');
  if (countEl) {
    const n = String(store.persistentlyHighlightedLinks.size);
    if (countEl.textContent !== n) countEl.textContent = n;
  }
  refreshPolygonsIfNeeded();
}

export function resetLeoVisualization() {
  if (store.activeLeoAnimation) cancelAnimationFrame(store.activeLeoAnimation);
  store.activeLeoAnimation = null;
  store.isLeoActive = false;
  store.leoPositionHistory = [];
  store.leoTrail = null;
  store.orbitalPeriodMs = 0;
  store.persistentlyHighlightedLinks.clear();
  store.currentHighlightedSet.clear();
  if (store.currentFootprintSet) store.currentFootprintSet.clear();
  if (store.currentSatOutlineSet) store.currentSatOutlineSet.clear();
  const countEl = document.getElementById('leoCompromisedCount');
  if (countEl) countEl.textContent = '0';
  const scene = store.world.scene();
  if (store.leoTrajectoryMesh) {
    scene.remove(store.leoTrajectoryMesh);
    store.leoTrajectoryMesh.geometry.dispose();
    store.leoTrajectoryMesh.material.dispose();
    store.leoTrajectoryMesh = null;
  }
  if (store.leoSatelliteMesh) store.leoSatelliteMesh.visible = false;
  const searchInput = document.getElementById('leoSearchInput');
  if (searchInput) searchInput.value = '';
  const statusEl = document.getElementById('leoStatusText');
  if (statusEl) statusEl.textContent = 'Idle';
  const timeEl = document.getElementById('leoTimeText');
  if (timeEl) timeEl.textContent = '-';
  const altEl = document.getElementById('leoAltText');
  if (altEl) altEl.textContent = '-';
  // Drop every conflict mark so the beam set returns to plain base styling.
  clearLeoConflicts();
  if (store.world && store.cachedGeoJsonFeatures.length > 0) {
    lastPolyKey = '';
    store.world.polygonsData([...store.cachedGeoJsonFeatures]);
  }
}
