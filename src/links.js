// Instanced link-beam rendering.
//
// Why: 7840 links as individual meshes = 7840 draw calls + heavy GC on every
// filter. One InstancedMesh (8-sided cylinder) = 1 draw call; per-link state
// (colour/opacity) is updated via instanceColor without rebuilding geometry.
// Lines are translucent (opacity ~0.28 GSO / 0.12 LEO-idle) for visibility.
import * as THREE from 'three';
import { PALETTE, GSO_ALTITUDE_RATIO } from './constants.js';
import { store } from './state.js';
import { normalizeCountryName } from './countryNorm.js';

const LINK_RADIAL_SEGMENTS = 6;
const GSO_COLOR = new THREE.Color(PALETTE.gray_mid1).multiplyScalar(0.85);
const GSO_COLOR_HEX = GSO_COLOR.getHex();
const LEO_IDLE_COLOR = new THREE.Color(0x8f8f8f);
const LEO_HIT_COLOR = new THREE.Color(0x00ffcc);

let sharedLinkGeo = null;
const _m = new THREE.Matrix4();
const _q = new THREE.Quaternion();
const _up = new THREE.Vector3(0, 1, 0);
const _mid = new THREE.Vector3();
const _dir = new THREE.Vector3();
const _scale = new THREE.Vector3();
const _col = new THREE.Color();

export const LEO_DIM_COLOR = LEO_IDLE_COLOR;

function disposeLinkMesh() {
  if (!store.linkMesh) return;
  store.world.scene().remove(store.linkMesh);
  store.linkMesh.dispose();
  store.linkMesh = null;
  store.linkLinesMesh = null;
  store.linkMeta = null;
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
  const opacity = isGsoMode ? 0.28 : 0.12;
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
  const country = new Array(n);
  const ident = new Array(n);

  const baseColor = isGsoMode ? GSO_COLOR : LEO_IDLE_COLOR;

  for (let i = 0; i < n; i++) {
    const conn = list[i];
    const satLon = store.satLonByName.get(conn.sat_name) ?? conn.sat_lon ?? 0;
    const p1 = store.world.getCoords(conn.gs_lat, conn.gs_lon, 0.01);
    const p2 = store.world.getCoords(0, satLon, GSO_ALTITUDE_RATIO);
    _mid.set((p1.x + p2.x) / 2, (p1.y + p2.y) / 2, (p1.z + p2.z) / 2);
    _dir.set(p2.x - p1.x, p2.y - p1.y, p2.z - p1.z);
    const len = _dir.length() || 1e-6;
    _q.setFromUnitVectors(_up, _dir.clone().normalize());
    _scale.set(1, len, 1);
    _m.compose(_mid, _q, _scale);
    mesh.setMatrixAt(i, _m);
    mesh.setColorAt(i, _col.copy(baseColor));

    gsLat[i] = conn.gs_lat; gsLon[i] = conn.gs_lon;
    gsX[i] = p1.x; gsY[i] = p1.y; gsZ[i] = p1.z;
    dirX[i] = (p2.x - p1.x) / len; dirY[i] = (p2.y - p1.y) / len; dirZ[i] = (p2.z - p1.z) / len;
    const stn = store.stationByName.get(conn.gs_name);
    country[i] = stn ? normalizeCountryName(stn.country || stn.gscountry || '') : '';
    ident[i] = `${conn.gs_lat},${conn.gs_lon}-${satLon}`;
  }
  mesh.instanceMatrix.needsUpdate = true;
  if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
  mesh.material.opacity = opacity;
  mesh.material.needsUpdate = false;

  store.linkMeta = { count: n, gsLat, gsLon, gsX, gsY, gsZ, dirX, dirY, dirZ, country, ident };
}

// Recolour instances by index (used by LEO highlight + reset).
export function paintLinkInstances(indices, hex) {
  const mesh = store.linkMesh;
  if (!mesh) return;
  _col.setHex(hex);
  for (const i of indices) mesh.setColorAt(i, _col);
  if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
}

export function paintAllLinks(hex) {
  const mesh = store.linkMesh;
  if (!mesh || !store.linkMeta) return;
  _col.setHex(hex);
  for (let i = 0; i < store.linkMeta.count; i++) mesh.setColorAt(i, _col);
  if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
}

export { GSO_COLOR_HEX };
