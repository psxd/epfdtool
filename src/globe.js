// Globe scene creation, GSO ring, camera helpers.
// NOTE: points stay UNMERGED on purpose. three-globe tags a merged points
// layer as one 'points' object, but globe.gl's tooltip/click handlers only
// know the singular 'point' type - so pointsMerge(true) silently kills ALL
// ground-station hover text and point clicks. Unmerged = ver1 behaviour.
import Globe from 'globe.gl';
import * as THREE from 'three';
import { PALETTE, GSO_ALTITUDE_RATIO } from './constants.js';
import { store } from './state.js';
import { isCountryHighlighted, isCountryOutlined, isCountryFootprint, updateHighlightedCountriesCache } from './countryHi.js';
import { buildGeoNameSet } from './countryNorm.js';
import { stationHoverHtml, satelliteHoverHtml } from './hoverText.js';
import { highlightBeams, clearBeamHighlight } from './links.js';
export const DEFAULT_VIEW = { lat: 20, lng: 0, altitude: 2.2 };

// Altitude for EVERY polygon, in globe radii (globe radius = 100 units, so
// 0.004 == 0.4 units of lift).
//
// This value is NOT arbitrary, and neither is the curvature resolution below -
// they fix the same pair of reported bugs together.
//
// three-conic-polygon-geometry tessellates a country's cap as straight chords
// between boundary points, and a chord spanning N degrees sags below the
// sphere by r * (1 - cos(N/2)). Measured on the actual globe.json: the longest
// boundary edge is 5.69 deg (the median is 0.56 deg). Unsubdivided that chord
// sags 0.123 units, while the previous lift of 0.0015 was only 0.150 units - a
// 1.2x margin, which is well inside depth-buffer precision, so the cap sank back
// under the globe sphere along those edges. That is why the big countries
// (Russia, Greenland, Canada, USA) filled non-solid, and why the 1px border
// vanished in the same places.
//
// 0.004 == 0.4 units of lift, which clears even the UNSUBDIVIDED worst case
// (0.123) with room to spare. Higher would start floating the cap visibly off
// the surface. One constant for every polygon on purpose: per-category
// altitudes float extruded caps at different heights that z-fight each other,
// which is what glitched when many countries lit at once.
export const POLYGON_ALTITUDE = 0.004;

// Angular resolution (degrees) for subdividing country edges. This drives BOTH
// the cap fill and the border outline: three-globe builds the stroke with
// `new GeoJsonGeometry(polygon, GLOBE_RADIUS, capCurvatureResolution)`, and
// GeoJsonGeometry runs every ring through interpolateLine(coords, resolution),
// which re-samples any segment longer than this. The library default is 5 deg,
// so at the default a 5.69 deg edge is NOT re-sampled at all and stays a long
// sagging chord. At 1 deg every edge becomes <= 1 deg, cutting the sag ~32x
// (0.123 -> 0.0038 units, a 105x margin against the lift above). That is what
// makes the fill solid AND the border continuous all the way round.
export const POLYGON_CURVATURE_RESOLUTION = 1;

// Camera altitude bounds shared by the zoom buttons and the country framing.
export const MIN_CAMERA_ALTITUDE = 0.3;
export const MAX_CAMERA_ALTITUDE = 12;

// ver1's transition duration, applied to every camera move.
const CAMERA_TWEEN_MS = 800;

const now = () => (typeof performance !== 'undefined' && performance.now ? performance.now() : Date.now());
const wrapLng = (lng) => ((lng + 540) % 360) - 180;
const easeCubicInOut = (t) => (t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2);

export function clampCameraAltitude(altitude) {
  const alt = Number(altitude);
  if (!Number.isFinite(alt)) return DEFAULT_VIEW.altitude;
  return Math.min(MAX_CAMERA_ALTITUDE, Math.max(MIN_CAMERA_ALTITUDE, alt));
}

// Why the camera is animated here instead of by globe.gl:
// globe.gl 2.31's pointOfView(pov, ms) starts a @tweenjs/tween.js tween, but
// nothing in the bundle ever calls TWEEN.update() (three-render-objects only
// ticks its own private tween group). Every transition with ms > 0 is therefore
// a silent no-op - only ms = 0 lands. ver1 shipped the very same dependency, so
// its 800 ms camera moves never animated either and its zoom was wheel/drag
// only. So we step the POV ourselves each frame via globe.gl's instant setter,
// over ver1's 800 ms, with ver1's cubic-in-out easing.
let cameraTween = null;

function cancelCameraTween() {
  if (cameraTween && cameraTween.raf && typeof cancelAnimationFrame === 'function') {
    cancelAnimationFrame(cameraTween.raf);
  }
  cameraTween = null;
}

function applyCamera(lat, lng, altitude) {
  store.world.pointOfView({ lat, lng: wrapLng(lng), altitude: clampCameraAltitude(altitude) }, 0);
  // Rescale the dots HERE, inside every tween step. The dots are world-sized
  // spheres, so they must be re-scaled the moment the altitude changes or they
  // keep the size they had at the start of the move and look wrong (huge when
  // zoomed out, invisible when zoomed in) once it finishes.
  syncSatDotScale();
}

// Animated camera move. Antimeridian-safe: the longitude travels the short way
// round, and repeated calls while a move is in flight re-aim from wherever the
// camera currently is (so rapid zoom clicks keep compounding). Skips the
// rAF loop entirely for sub-degree nudges (instant set, no tween overhead).
export function animateCameraTo(lat, lng, altitude, durationMs = CAMERA_TWEEN_MS) {
  if (!store.world) return;
  const toLat = Number(lat) || 0;
  const toLng = wrapLng(Number(lng) || 0);
  const toAlt = clampCameraAltitude(altitude);
  const from = store.world.pointOfView() || DEFAULT_VIEW;
  if (!(durationMs > 0) || typeof requestAnimationFrame !== 'function') {
    cancelCameraTween();
    applyCamera(toLat, toLng, toAlt);
    return;
  }
  let dLng = toLng - wrapLng(from.lng);
  if (dLng > 180) dLng -= 360;
  if (dLng < -180) dLng += 360;
  const dLat = toLat - from.lat;
  const dAlt = toAlt - from.altitude;
  // Nudge-sized move (hover refocus etc.): land instantly, skip the tween.
  if (Math.hypot(dLat, dLng, dAlt) < 0.5) {
    cancelCameraTween();
    applyCamera(toLat, toLng, toAlt);
    return;
  }
  cancelCameraTween();
  const tween = {
    fromLat: from.lat, fromLng: from.lng, fromAlt: from.altitude,
    toLat, toLngUnwrapped: wrapLng(from.lng) + dLng, toAlt,
    target: { lat: toLat, lng: toLng, altitude: toAlt },
    start: now(), duration: durationMs, raf: 0,
  };
  const step = () => {
    const t = Math.min(1, (now() - tween.start) / tween.duration);
    const k = easeCubicInOut(t);
    applyCamera(
      tween.fromLat + (tween.toLat - tween.fromLat) * k,
      tween.fromLng + (tween.toLngUnwrapped - tween.fromLng) * k,
      tween.fromAlt + (tween.toAlt - tween.fromAlt) * k,
    );
    if (t < 1) tween.raf = requestAnimationFrame(step);
    else if (cameraTween === tween) cameraTween = null;
  };
  cameraTween = tween;
  tween.raf = requestAnimationFrame(step);
}

// ver1 signature: focusCameraOn(lat, lng, altitude) with an 800 ms move.
export function focusCameraOn(lat, lng, altitude = 1.6, durationMs = CAMERA_TWEEN_MS) {
  animateCameraTo(lat, lng, altitude, durationMs);
}

// Zoom buttons (index.html #zoomInBtn / #zoomOutBtn). ver1 shipped those
// buttons in the DOM but never wired a handler, and its transitions were dead
// anyway, so zooming there was wheel/drag only. Here they step the altitude the
// rest of the camera code uses, compounding across repeated clicks and clamped
// to the shared camera range.
export function zoomBy(factor) {
  if (!store.world) return;
  const current = cameraTween ? cameraTween.target : (store.world.pointOfView() || DEFAULT_VIEW);
  animateCameraTo(current.lat, current.lng, clampCameraAltitude(current.altitude * factor));
}

let satGeoPlanned = null;
let satGeoNonPlanned = null;
let satMatPlanned = null;
let satMatNonPlanned = null;
// Base radius of a satellite dot's geometry. The per-zoom value is
// satScaleForAltitude() and is a MULTIPLIER on this, never a replacement for it.
const SAT_BASE_RADIUS = 0.3;
let satGeoPick = null;
let satMatPick = null;
const _pickVec = new THREE.Vector3();
// Invisible pick proxy, parented to every satellite dot. A visible dot is ~1px
// across at the default view and satScaleForAltitude holds it at that size at
// EVERY zoom by design, so satellites could only ever be hit by luck. The proxy
// is a sphere that is NEVER RENDERED but is still raycast: three's
// Raycaster.intersect() only tests `object.layers`, it does NOT skip
// `visible = false` meshes (checked against the three in package.json) and
// three-render-objects raycasts with intersectObjects(objects, true) - i.e.
// recursively - so a hidden child costs zero draw calls and zero pixels while
// still giving globe.gl's hover/click raycast something to hit.
// It is sized in SCREEN PIXELS (not world units) so the target is the same size
// at every zoom: see satPickLocalScale / syncSatDotScale, which re-size it on
// every camera move exactly like the dots themselves.
const SAT_PICK_PROXY_PX = 14;
// Used when there is no camera to measure (headless harness): a plain multiple
// of the dot, which is still far more forgiving than the dot itself.
const SAT_PICK_PROXY_FALLBACK_FACTOR = 4;

// Canvas height in CSS px - the bridge between a pixel size and world units.
function canvasPixelHeight() {
  const fromWorld = store.world && store.world.height ? Number(store.world.height()) : 0;
  if (fromWorld > 0) return fromWorld;
  if (typeof window !== 'undefined' && window.innerHeight > 0) return window.innerHeight;
  return 900;
}

// Local scale for a dot's pick proxy (same geometry radius as the dot, so the
// scale is directly "how much bigger than the dot"): converts a world radius
// computed from the perspective camera into the child's local scale.
function satPickLocalScale(mesh, dotScale, camera, canvasHeight) {
  const inherited = SAT_BASE_RADIUS * (dotScale || 1);
  if (!camera || !camera.position || inherited <= 0) return SAT_PICK_PROXY_FALLBACK_FACTOR;
  // Distance from the camera to THIS dot, not to the globe centre: rim dots sit
  // ~2x further from the camera than centre-aligned ones, so one shared distance
  // would size their targets unevenly. getWorldPosition also flushes any stale
  // world matrix, so this is correct even before the first render.
  const distance = Math.max(mesh.getWorldPosition(_pickVec).distanceTo(camera.position), 1);
  const worldPerPixel = (2 * distance * Math.tan(((Number(camera.fov) || 50) * Math.PI) / 360)) / (canvasHeight || 900);
  return ((SAT_PICK_PROXY_PX / 2) * worldPerPixel) / inherited;
}

// Satellite dot size at the current camera altitude. Dots are world-sized
// spheres: zoom OUT and the globe shrinks away from them, zoom IN and they
// shrink to nothing, so this counter-scales with altitude to keep their SCREEN
// size roughly constant.
// This returns a PURE MULTIPLIER for the 0.30-radius geometry, exactly like
// ver1 (`Math.max(1.0, pov.altitude * 0.6)`). It must NOT bake the base radius
// in as well: the scale is applied on top of a geometry that is already 0.30,
// so folding 0.3 in here shrank every dot twice over (0.30 * 0.396 = 0.119,
// i.e. 3.3x too small - the satellites were nearly invisible at every zoom).
export function satScaleForAltitude(altitude) {
  return Math.max(1.0, (Number(altitude) || DEFAULT_VIEW.altitude) * 0.6);
}

// Re-apply the current-altitude scale to every satellite dot. Called from
// applyCamera (each tween step) and from the coalesced controls handler (user
// drag / wheel), so the dots are never left at a stale size.
export function syncSatDotScale() {
  if (!store.world) return;
  const sc = satScaleForAltitude(store.world.pointOfView().altitude);
  const camera = store.world.camera ? store.world.camera() : null;
  const canvasHeight = canvasPixelHeight();
  for (const mesh of store.satMeshes) {
    mesh.scale.set(sc, sc, sc);
    // A dot's only child is its hidden pick proxy (see satMeshFor).
    const pick = mesh.children[0];
    if (pick) pick.scale.setScalar(satPickLocalScale(mesh, sc, camera, canvasHeight));
  }
}

function satMeshFor(d) {
  const isPlanned = d.planned === true || d.planned === 1 || d.planned === '1' || d.planned === 'true';
  if (!satGeoPlanned) {
    // Geometry radius must stay SAT_BASE_RADIUS - satScaleForAltitude is a
    // MULTIPLIER applied on top of this in satMeshFor/syncSatDotScale. Folding
    // the base radius into the multiplier as well is what shrank the dots 3x.
    satGeoPlanned = new THREE.SphereGeometry(SAT_BASE_RADIUS, 12, 12);
    satGeoNonPlanned = new THREE.SphereGeometry(SAT_BASE_RADIUS, 12, 12);
    satMatPlanned = new THREE.MeshBasicMaterial({ color: new THREE.Color(PALETTE.true_sat) });
    satMatNonPlanned = new THREE.MeshBasicMaterial({ color: new THREE.Color(PALETTE.false_sat) });
  }
  const mesh = new THREE.Mesh(isPlanned ? satGeoPlanned : satGeoNonPlanned, isPlanned ? satMatPlanned : satMatNonPlanned);
  const sc = satScaleForAltitude(store.world ? store.world.pointOfView().altitude : DEFAULT_VIEW.altitude);
  mesh.scale.set(sc, sc, sc);
  mesh.userData = d;
  // Hidden pick proxy (see SAT_PICK_PROXY_PX). A CHILD of the dot, so it
  // follows the dot's position for free, and it carries the same row in
  // userData as the dot itself. Sized here for the current camera and re-sized
  // on every camera move by syncSatDotScale (setSatellites calls it once the
  // dots are positioned).
  if (!satGeoPick) {
    satGeoPick = new THREE.SphereGeometry(SAT_BASE_RADIUS, 8, 6);
    satMatPick = new THREE.MeshBasicMaterial();
  }
  const pick = new THREE.Mesh(satGeoPick, satMatPick);
  pick.visible = false; // never drawn - three's Raycaster still hits it
  pick.userData = d;
  mesh.add(pick);
  const camera = store.world.camera ? store.world.camera() : null;
  pick.scale.setScalar(satPickLocalScale(mesh, sc, camera, canvasPixelHeight()));
  store.satMeshes.push(mesh);
  return mesh;
}

// The satellite click callback's argument shape differs by globe.gl version:
// the installed one hands over the DATA ROW (its dataAccessors.object unwraps
// the three-globe group's `__data`), while other paths hand over the intersected
// THREE object. Accept both - rows pass straight through, meshes/points are
// resolved through the userData stamped on every satellite dot and pick proxy.
function satelliteFromClickArg(arg) {
  if (!arg) return null;
  if (arg.isObject3D) {
    for (let node = arg; node; node = node.parent) {
      const data = node.userData;
      if (data && !data.isObject3D && data.name) return data;
    }
    return null;
  }
  return arg.name ? arg : null;
}

export function renderGSORing() {
  const scene = store.world.scene();
  const radius = 1 + GSO_ALTITUDE_RATIO;
  const geometry = new THREE.RingGeometry(radius - 0.04, radius + 0.04, 128);
  const material = new THREE.MeshBasicMaterial({
    color: new THREE.Color(PALETTE.true_sat),
    side: THREE.DoubleSide, transparent: true, opacity: 0.35
  });
  const ringMesh = new THREE.Mesh(geometry, material);
  ringMesh.rotation.x = Math.PI / 2;
  scene.add(ringMesh);
  const wireGeometry = new THREE.RingGeometry(radius - 0.08, radius + 0.08, 64);
  const wireMaterial = new THREE.MeshBasicMaterial({
    color: new THREE.Color(PALETTE.gray_mid1),
    side: THREE.DoubleSide, transparent: true, opacity: 0.15, wireframe: true
  });
  const wireRing = new THREE.Mesh(wireGeometry, wireMaterial);
  wireRing.rotation.x = Math.PI / 2;
  scene.add(wireRing);
}

export function setSatellites(list) {
  store.satMeshes.length = 0;
  store.world.objectsData(list || []);
  // three-globe runs objectThreeObject() BEFORE it positions the dots, so size
  // the pick proxies here, once every dot is actually where it belongs - and on
  // a filter change too, not just on the next camera move.
  syncSatDotScale();
}

// Intro dolly-in tuning. The globe parks 1.6x out and eases down once - a
// single professional move rather than elements popping in at random.
export const BOOT_START_ALTITUDE = DEFAULT_VIEW.altitude * 1.6;
export const BOOT_FLIGHT_MS = 1200;

// Intro dolly-in. Deliberately NOT fired from initGlobe: the dataset arrives
// asynchronously, so starting the flight at t=0 made stations/satellites/links
// pop in at random moments while the camera was still moving. loadData() calls
// this once the scene is populated, so the flight always plays over a complete
// scene. Idempotent, so a late second call (or the error path) cannot stack a
// second flight on top of the first.
let bootPlayed = false;
export function startBootAnimation() {
  if (bootPlayed || !store.world) return;
  bootPlayed = true;
  animateCameraTo(DEFAULT_VIEW.lat, DEFAULT_VIEW.lng, DEFAULT_VIEW.altitude, BOOT_FLIGHT_MS);
}

export function initGlobe({ showSatelliteDetails, showStationDetails }) {
  const container = document.getElementById('globeCanvas');
  // BUILD ORDER (staged = smooth, not random):
  //   1. shell first (globe + GSO ring + parked POV) so first paint is instant;
  //   2. globe.json resolves -> ONE polygonsData (capped DPR already applied);
  //   3. loadData resolves -> points/sats/links via applyFilters(false), which
  //      does NOT move the camera, then calls startBootAnimation() so the intro
  //      flight only ever plays over a fully populated scene.
  store.world = Globe()(container)
    .backgroundColor(PALETTE.scene_bg)
    .showGlobe(true)
    .showAtmosphere(false)
    .globeMaterial(new THREE.MeshBasicMaterial({ color: 0x111111 }))
    // Highlight colours. One blue (#1977AD) for every highlight, in two styles:
    //   GS country filtered   -> the country is FILLED solid blue.
    //   sat country filtered  -> the country is OUTLINED in that same blue and
    //                            NOT filled; its linked GS countries are also
    //                            outlined (never filled), so picking a sat
    //                            country can never turn the globe into a wash.
    // Fill (GS country filter only): solid, fully opaque blue. Opaque rather
    // than translucent on purpose - a translucent cap gets blended with what
    // is behind it, which flickers while the globe turns and reads as a
    // rendering glitch. A sat country filter never reaches this branch, so it
    // can only ever outline, never fill.
    .polygonCapColor(d => (isCountryHighlighted(d.properties) ? '#1977AD' : 'rgba(0,0,0,0)'))
    .polygonSideColor(() => 'rgba(0,0,0,0)')
    // Outline: blue for a GS fill, and blue for every sat-filter country
    // (the operator's country + its linked GS countries). Outline is 1px
    // because globe.gl draws borders with LineBasicMaterial and WebGL ignores
    // linewidth everywhere - the caps stay flat (no altitude lift) so many
    // outlines can be lit at once without any of them fighting for depth.
    .polygonStrokeColor(d => (isCountryHighlighted(d.properties) || isCountryOutlined(d.properties)) ? '#1977AD' : '#cccccc')
    .polygonAltitude(POLYGON_ALTITUDE)
    // Subdivide country edges so the cap and border follow the sphere. The
    // library default (5 deg) leaves most edges as a single long chord, which
    // dips under the globe and both hollows out big-country fills and punches
    // gaps in their borders. 1 deg keeps the sag ~25x smaller.
    .polygonCapCurvatureResolution(POLYGON_CURVATURE_RESOLUTION)
    // Altitude is ONE constant for every polygon and must stay well clear of
    // the worst-case chord sag (see POLYGON_ALTITUDE): too low and the cap
    // sinks under the globe and the fill renders non-solid; varying it per
    // category floats extruded caps at different heights that z-fight each
    // other, which is what glitched when many countries lit at once. Constant
    // altitude + polygonsTransitionDuration(0) = a highlight change is a pure
    // material recolour: no re-extrusion, no morph, no flicker.
    .polygonsTransitionDuration(0)
    .pointsData([])
    .pointsMerge(false)
    .pointLat('lat')
    .pointLng('lon')
    .pointAltitude(0.01)
    .pointRadius(0.10)
    .pointColor(() => PALETTE.gray_dark)
    .pointLabel(d => (store.isLeoActive ? '' : stationHoverHtml(d)))
    .onPointClick(d => {
      if (store.isLeoActive) return;
      // Click = details card + zoom ONLY. No filtering happens here - the
      // left filter box is the only thing that adds/removes nodes and beams.
      showStationDetails(d);
      focusCameraOn(d.lat, d.lon, 1.25);
    })
    .onPointHover(d => {
      if (store.isLeoActive) return;
      // Colour-only cue: brighten the hovered station's own beams so its
      // connections are unmistakable among the many beams converging nearby.
      // Lines are never added or removed by hover.
      if (d) highlightBeams('gs', d.name); else clearBeamHighlight();
    })
    .objectsData([])
    .objectLat('lat')
    .objectLng('lon')
    .objectAltitude(GSO_ALTITUDE_RATIO)
    .objectThreeObject(d => satMeshFor(d))
    .objectLabel(d => (store.isLeoActive ? '' : satelliteHoverHtml(d)))
    .onObjectClick(obj => {
      if (store.isLeoActive) return;
      // NOTE: this callback receives the DATA ROW, not the THREE mesh built in
      // satMeshFor - globe.gl's dataAccessors.object() unwraps three-globe's
      // `__data` off the layer group before calling us. The old `obj.userData`
      // test therefore never matched and satellite clicks did nothing at all.
      const sat = satelliteFromClickArg(obj);
      if (!sat) return;
      // Click = details card + zoom ONLY (no beam filtering - the left filter
      // box is the only thing that changes what's drawn).
      showSatelliteDetails(sat);
      focusCameraOn(sat.lat || 3.5, sat.lon, 7);
    })
    .onObjectHover(obj => {
      if (store.isLeoActive) return;
      const sat = obj ? satelliteFromClickArg(obj) : null;
      // Colour-only cue (see onPointHover): brighten THIS satellite's beams.
      // Neighbouring GSO satellites share longitudes (EXPRESS-4/4B sit at the
      // same 40E slot as STATSIONAR-12), so ~300 beams converge on the same
      // dot - the highlight makes the hovered node's own connections (the
      // ones listed in its hover card) unmistakable.
      if (sat) highlightBeams('sat', sat.name); else clearBeamHighlight();
    });

  fetch('./data/globe.json')
    .then(res => res.json())
    .then(geojson => {
      store.cachedGeoJsonFeatures = geojson.features || [];
      buildGeoNameSet();
      // Re-resolve the highlight keys: any country normalised before the geo
      // set existed would otherwise keep its pre-collapse spelling.
      updateHighlightedCountriesCache();
      store.world.polygonsData(store.cachedGeoJsonFeatures);
    })
    .catch(() => {
      fetch('https://raw.githubusercontent.com/johan/world.geo.json/master/countries.geo.json')
        .then(res => res.json())
        .then(geojson => {
          store.cachedGeoJsonFeatures = geojson.features || [];
          buildGeoNameSet();
          updateHighlightedCountriesCache();
          store.world.polygonsData(store.cachedGeoJsonFeatures);
        });
    });

  renderGSORing();
  // Park the camera high. The dolly-in does NOT start here - it is owned by
  // startBootAnimation() and fires once the dataset has actually landed, so
  // the intro plays over a fully populated scene instead of having stations,
  // satellites and links pop in at random moments mid-flight.
  // applyFilters(false) from loadData never touches the camera, so this flight
  // is never fought over.
  store.world.pointOfView({ ...DEFAULT_VIEW, altitude: BOOT_START_ALTITUDE }, 0);
  if (typeof requestAnimationFrame !== 'function') {
    // No rAF (harness): nothing can animate, so land straight on the default view.
    store.world.pointOfView({ ...DEFAULT_VIEW }, 0);
    bootPlayed = true;
  }

  // Idle rescale of satellite sprites on user zoom: coalesced through a single
  // rAF (no per-change-event storm) AND skipped while a camera tween is in
  // flight - the tween steps the POV every frame, so rescaling inside it just
  // fights the animation. The final size lands on the tween's last step.
  // User-driven zoom (drag / wheel). Coalesced through a single rAF so a burst
  // of change events costs one rescale, and deliberately NOT skipped while a
  // tween is running: applyCamera already rescales on every tween step, so
  // this is just a cheap second safety net that guarantees the final resting
  // size is right even if the tween was cancelled mid-flight.
  let rescaleQueued = false;
  store.world.controls().addEventListener('change', () => {
    if (rescaleQueued) return;
    rescaleQueued = true;
    requestAnimationFrame(() => {
      rescaleQueued = false;
      syncSatDotScale();
    });
  });

  // Responsive canvas: keep the renderer at the exact container size (a
  // mismatched drawing buffer is the classic "glitchy on rotate/resize"
  // cause: stretched pixels + needless overdraw). ResizeObserver coalesces
  // bursts; devicePixelRatio is capped at 2 so hidpi stays sharp without
  // quadrupling fragment work.
  const canvasWrap = document.getElementById('canvas-wrap');
  if (canvasWrap && typeof ResizeObserver !== 'undefined') {
    let resizeQueued = false;
    new ResizeObserver(() => {
      if (resizeQueued) return;
      resizeQueued = true;
      requestAnimationFrame(() => {
        resizeQueued = false;
        const w = canvasWrap.clientWidth || window.innerWidth;
        const h = canvasWrap.clientHeight || window.innerHeight;
        store.world.width(w);
        store.world.height(h);
        const renderer = store.world.renderer && store.world.renderer();
        if (renderer && typeof renderer.setPixelRatio === 'function') {
          renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
        }
      });
    }).observe(canvasWrap);
  }
}
