// LEO side-effects: link-intersection highlight + teardown.
// Perf: works on flat Float32 meta arrays of the instanced mesh (no Vector3
// allocs, no per-frame polygon rebuilds); paints instances in place.
import { PALETTE, EARTH_RADIUS_KM } from './constants.js';
import { store } from './state.js';
import { paintLinkInstances, GSO_COLOR_HEX } from './links.js';

const CONE_COS = Math.cos(1.0 * Math.PI / 180);
const DEG = Math.PI / 180;
let lastPolyKey = '';

function refreshPolygonsIfNeeded() {
  if (!store.world || store.cachedGeoJsonFeatures.length === 0) return;
  const key = store.isLeoActive ? 'leo:' + store.currentHighlightedSet.size : 'gso';
  if (key === lastPolyKey) return;
  lastPolyKey = key;
  store.world.polygonsData([...store.cachedGeoJsonFeatures]);
}

export function checkAndHighlightPassingLinks(leoCoordsVec, lat, lon) {
  const meta = store.linkMeta;
  const lx = leoCoordsVec.x, ly = leoCoordsVec.y, lz = leoCoordsVec.z;
  if (meta) {
    const toPaint = [];
    const latR = lat * DEG;
    const cosLat = Math.cos(latR);
    const done = store.persistentlyHighlightedLinks;
    for (let i = 0; i < meta.count; i++) {
      const id = meta.ident[i];
      if (done.has(id)) continue;
      const dLatDeg = lat - meta.gsLat[i];
      if (dLatDeg > 8 || dLatDeg < -8) continue;
      let dLonDeg = Math.abs(lon - meta.gsLon[i]);
      if (dLonDeg > 180) dLonDeg = 360 - dLonDeg;
      if (dLonDeg * cosLat > 8) continue;
      const dLat = dLatDeg * DEG, dLon = dLonDeg * DEG;
      const gsLatR = meta.gsLat[i] * DEG;
      const a = Math.sin(dLat / 2) ** 2 + Math.cos(gsLatR) * cosLat * Math.sin(dLon / 2) ** 2;
      if (2 * EARTH_RADIUS_KM * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a)) > 100000) continue;
      const vx = lx - meta.gsX[i], vy = ly - meta.gsY[i], vz = lz - meta.gsZ[i];
      const vLen = Math.sqrt(vx * vx + vy * vy + vz * vz) || 1e-9;
      if ((vx * meta.dirX[i] + vy * meta.dirY[i] + vz * meta.dirZ[i]) / vLen >= CONE_COS) {
        done.add(id);
        const c = meta.country[i];
        if (c) store.currentHighlightedSet.add(c);
        toPaint.push(i);
      }
    }
    if (toPaint.length > 0) paintLinkInstances(toPaint, 0x00ffcc);
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
  if (store.linkMeta) paintLinkInstances(Array.from({ length: store.linkMeta.count }, (_, i) => i), GSO_COLOR_HEX);
  if (store.world && store.cachedGeoJsonFeatures.length > 0) {
    lastPolyKey = '';
    store.world.polygonsData([...store.cachedGeoJsonFeatures]);
  }
  void PALETTE;
}
