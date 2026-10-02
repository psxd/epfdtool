// LEO TLE propagation. Perf: trail reuses ONE preallocated buffer, cone check
// every 2nd frame, DOM text only when the displayed second changes.
import * as THREE from 'three';
import * as satellite from 'satellite.js';
import { EARTH_RADIUS_KM } from './constants.js';
import { store } from './state.js';
import { renderStraightLinkBeams } from './links.js';
import { setSatellites } from './globe.js';
import { applyCameraFollow } from './globe.js';
import { checkAndHighlightPassingLinks } from './leoHighlight.js';

const TRAIL_MAX = 600;
const _statusCache = { text: '', time: '', alt: '' };
// A stalled frame (backgrounded tab, a heavy filter pass, a long GC pause) must
// not teleport the orbit: without this clamp the very next frame advances the
// simulation by however long the page was frozen - at 100x that is hours, and
// the satellite jumps across the globe with a straight-line trail.
const MAX_REAL_FRAME_MS = 50;
// Sampling cadence for the trail and the conflict test, in SIMULATION seconds.
// Frame-parity sampling ((frame & 1)) thinned the track exactly when it mattered
// - at 100x one sample covered ~2 s of motion, so the 1-degree test could step
// straight over a ground station.
// Camera standoff for satellite-follow view, in globe radii ABOVE the
// satellite's own altitude. Recomputed every frame from the live altitude, so
// the visual "closeness" is identical at any orbit height (340 km and 2000 km
// both sit 0.4 radii above their satellite) and an elliptical orbit breathes
// up and down with the satellite instead of holding rigid.
const FOLLOW_STANDOFF_RADII = 0.4;
const SAMPLE_INTERVAL_SIM_MS = 1000;

export function loadAndPropagateLeo(name, line1, line2) {
  if (store.activeLeoAnimation) cancelAnimationFrame(store.activeLeoAnimation);
  store.isLeoActive = true;
  // A malformed TLE pair used to throw inside twoline2satrec and leave the
  // animation flag set with nothing running; fail loudly instead.
  try {
    store.selectedSatrec = satellite.twoline2satrec(line1, line2);
  } catch (err) {
    store.isLeoActive = false;
    const statusEl = document.getElementById('leoStatusText');
    if (statusEl) statusEl.textContent = 'Invalid TLE';
    console.error('Could not parse TLE for', name, err);
    return;
  }
  // Any GSO selection must not survive into LEO mode: its beams are gone.
  store.selection = null;
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
  // Fewer than two samples = no line to draw. Previously this returned early
  // and left whatever was drawn before still on screen, so a restarted
  // propagation kept showing the previous satellite's stale track.
  if (n < 2) {
    if (store.leoTrajectoryMesh) store.leoTrajectoryMesh.geometry.setDrawRange(0, 0);
    return;
  }
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
  let lastSampleSimMs = 0;
  const statusEl = document.getElementById('leoStatusText');
  const timeEl = document.getElementById('leoTimeText');
  const altEl = document.getElementById('leoAltText');
  const speedEl = document.getElementById('leoSpeedSelect');
  const satName = (store.selectedSatrec && store.selectedSatrec.name) || '';
  function stop(statusText) {
    store.isLeoActive = false;
    if (statusEl) statusEl.textContent = statusText;
  }
  function animateStep(currentTime) {
    if (!store.isLeoActive) return;
    // Clamp the real elapsed time (see MAX_REAL_FRAME_MS) so a frozen tab
    // resumes smoothly instead of jumping.
    const deltaRealMs = Math.min(MAX_REAL_FRAME_MS, Math.max(0, currentTime - lastFrameTime));
    lastFrameTime = currentTime;
    const speedMultiplier = parseInt(speedEl?.value || '1') || 1;
    store.leoSimulationEpochTime = new Date(store.leoSimulationEpochTime.getTime() + deltaRealMs * speedMultiplier);
    const pv = satellite.propagate(store.selectedSatrec, store.leoSimulationEpochTime);
    const gmst = satellite.gstime(store.leoSimulationEpochTime);
    // A failed / unpropagatable TLE (decayed or malformed elements) used to be
    // ignored silently: the loop kept running while the panel froze on the last
    // good frame with no way to tell it had stopped.
    if (!pv || !pv.position || (pv.error && pv.error !== 0)) {
      stop('Propagation error');
      return;
    }
    if (pv.position) {
      const gd = satellite.eciToGeodetic(pv.position, gmst);
      const lat = satellite.degreesLat(gd.latitude);
      const lon = satellite.degreesLong(gd.longitude);
      const alt = gd.height;
      const statusText = `Propagating ${satName || 'Orbit'} (${speedMultiplier}x)`;
      const timeText = store.leoSimulationEpochTime.toUTCString().slice(17, 25);
      const altText = alt.toFixed(1);
      if (statusEl && _statusCache.text !== statusText) { _statusCache.text = statusText; statusEl.textContent = statusText; }
      if (timeEl && _statusCache.time !== timeText) { _statusCache.time = timeText; timeEl.textContent = timeText; }
      if (altEl && _statusCache.alt !== altText) { _statusCache.alt = altText; altEl.textContent = altText; }
      const coords = store.world.getCoords(lat, lon, alt / EARTH_RADIUS_KM);
      store.leoSatelliteMesh.position.set(coords.x, coords.y, coords.z);
      // Satellite-follow camera: re-aim at the live sub-point every frame so
      // the camera flies with the satellite. The altitude is derived from the
      // satellite's CURRENT altitude (never a fixed value), clamped by
      // applyCamera. Only active while the user has not grabbed the globe.
      if (store.leoFollowSatellite && !store.leoFollowBreakout) {
        applyCameraFollow(lat, lon, alt / EARTH_RADIUS_KM + FOLLOW_STANDOFF_RADII);
      }
      // Sample the trail + run the conflict test on a fixed SIMULATION cadence
      // instead of every other frame, so the track stays smooth and the 1-degree
      // test cannot step over a station at high speed multipliers.
      const simNow = store.leoSimulationEpochTime.getTime();
      if (simNow - lastSampleSimMs >= SAMPLE_INTERVAL_SIM_MS) {
        lastSampleSimMs = simNow;
        store.leoPositionHistory.push({ lat, lon, alt, time: simNow });
        const cutoff = simNow - store.orbitalPeriodMs;
        while (store.leoPositionHistory.length > 0 && store.leoPositionHistory[0].time < cutoff) store.leoPositionHistory.shift();
        if (store.leoPositionHistory.length > TRAIL_MAX * 2) store.leoPositionHistory.splice(0, store.leoPositionHistory.length - TRAIL_MAX * 2);
        updateLeoOrbitPathMesh();
        checkAndHighlightPassingLinks(coords, lat, lon, alt);
      }
    }
    store.activeLeoAnimation = requestAnimationFrame(animateStep);
  }
  store.activeLeoAnimation = requestAnimationFrame(animateStep);
}
