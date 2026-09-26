// LEO TLE propagation. Perf: trail reuses ONE preallocated buffer, cone check
// every 2nd frame, DOM text only when the displayed second changes.
import * as THREE from 'three';
import * as satellite from 'satellite.js';
import { EARTH_RADIUS_KM } from './constants.js';
import { store } from './state.js';
import { renderStraightLinkBeams } from './links.js';
import { setSatellites } from './globe.js';
import { checkAndHighlightPassingLinks } from './leoHighlight.js';

const TRAIL_MAX = 600;
const _statusCache = { text: '', time: '', alt: '' };

export function loadAndPropagateLeo(name, line1, line2) {
  if (store.activeLeoAnimation) cancelAnimationFrame(store.activeLeoAnimation);
  store.isLeoActive = true;
  store.selectedSatrec = satellite.twoline2satrec(line1, line2);
  const periodMinutes = (2 * Math.PI) / store.selectedSatrec.no;
  store.orbitalPeriodMs = periodMinutes * 60 * 1000;
  store.leoStartTime = new Date();
  store.leoSimulationEpochTime = new Date(store.leoStartTime.getTime());
  store.persistentlyHighlightedLinks.clear();
  store.currentHighlightedSet.clear();
  if (store.currentFootprintSet) store.currentFootprintSet.clear();
  if (store.currentSatOutlineSet) store.currentSatOutlineSet.clear();
  store.leoPositionHistory = [];
  store.leoTrail = null;
  store.world.pointsData(store.rawData.stations);
  setSatellites([]);
  renderStraightLinkBeams(store.rawData.connections, false);
  startLeoAnimation();
}

export function updateLeoOrbitPathMesh() {
  const scene = store.world.scene();
  const n = store.leoPositionHistory.length;
  if (n < 2) return;
  if (!store.leoTrail || store.leoTrail.capacity < n) {
    if (store.leoTrajectoryMesh) {
      scene.remove(store.leoTrajectoryMesh);
      store.leoTrajectoryMesh.geometry.dispose();
      store.leoTrajectoryMesh.material.dispose();
      store.leoTrajectoryMesh = null;
    }
    const capacity = Math.max(n, TRAIL_MAX);
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute('position', new THREE.BufferAttribute(new Float32Array(capacity * 3), 3));
    const material = new THREE.LineBasicMaterial({ color: 0x1977ad });
    store.leoTrajectoryMesh = new THREE.Line(geometry, material);
    store.leoTrajectoryMesh.frustumCulled = false;
    store.leoTrail = { capacity };
    scene.add(store.leoTrajectoryMesh);
  }
  const attr = store.leoTrajectoryMesh.geometry.getAttribute('position');
  const start = Math.max(0, n - TRAIL_MAX);
  const count = n - start;
  for (let i = 0; i < count; i++) {
    const p = store.leoPositionHistory[start + i];
    const coords = store.world.getCoords(p.lat, p.lon, p.alt / EARTH_RADIUS_KM);
    attr.setXYZ(i, coords.x, coords.y, coords.z);
  }
  store.leoTrajectoryMesh.geometry.setDrawRange(0, count);
  attr.needsUpdate = true;
}

export function startLeoAnimation() {
  const scene = store.world.scene();
  if (!store.leoSatelliteMesh) {
    const geometry = new THREE.BoxGeometry(1.6, 1.6, 1.6);
    const material = new THREE.MeshBasicMaterial({ color: 0xe69f00 });
    store.leoSatelliteMesh = new THREE.Mesh(geometry, material);
    scene.add(store.leoSatelliteMesh);
  } else {
    store.leoSatelliteMesh.visible = true;
  }
  let lastFrameTime = performance.now();
  let frame = 0;
  const statusEl = document.getElementById('leoStatusText');
  const timeEl = document.getElementById('leoTimeText');
  const altEl = document.getElementById('leoAltText');
  const speedEl = document.getElementById('leoSpeedSelect');
  function animateStep(currentTime) {
    if (!store.isLeoActive) return;
    const deltaRealMs = currentTime - lastFrameTime;
    lastFrameTime = currentTime;
    const speedMultiplier = parseInt(speedEl?.value || '1');
    store.leoSimulationEpochTime = new Date(store.leoSimulationEpochTime.getTime() + deltaRealMs * speedMultiplier);
    const pv = satellite.propagate(store.selectedSatrec, store.leoSimulationEpochTime);
    const gmst = satellite.gstime(store.leoSimulationEpochTime);
    if (pv.position) {
      const gd = satellite.eciToGeodetic(pv.position, gmst);
      const lat = satellite.degreesLat(gd.latitude);
      const lon = satellite.degreesLong(gd.longitude);
      const alt = gd.height;
      const statusText = `Propagating Orbit (${speedMultiplier}x)`;
      const timeText = store.leoSimulationEpochTime.toUTCString().slice(17, 25);
      const altText = alt.toFixed(1);
      if (statusEl && _statusCache.text !== statusText) { _statusCache.text = statusText; statusEl.textContent = statusText; }
      if (timeEl && _statusCache.time !== timeText) { _statusCache.time = timeText; timeEl.textContent = timeText; }
      if (altEl && _statusCache.alt !== altText) { _statusCache.alt = altText; altEl.textContent = altText; }
      const coords = store.world.getCoords(lat, lon, alt / EARTH_RADIUS_KM);
      store.leoSatelliteMesh.position.set(coords.x, coords.y, coords.z);
      frame++;
      if ((frame & 1) === 0) {
        store.leoPositionHistory.push({ lat, lon, alt, time: store.leoSimulationEpochTime.getTime() });
        const cutoff = store.leoSimulationEpochTime.getTime() - store.orbitalPeriodMs;
        while (store.leoPositionHistory.length > 0 && store.leoPositionHistory[0].time < cutoff) store.leoPositionHistory.shift();
        if (store.leoPositionHistory.length > TRAIL_MAX * 2) store.leoPositionHistory.splice(0, store.leoPositionHistory.length - TRAIL_MAX * 2);
        updateLeoOrbitPathMesh();
        checkAndHighlightPassingLinks(coords, lat, lon);
      }
    }
    store.activeLeoAnimation = requestAnimationFrame(animateStep);
  }
  store.activeLeoAnimation = requestAnimationFrame(animateStep);
}
