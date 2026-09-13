import Globe from 'https://esm.sh/globe.gl';
import * as THREE from 'https://esm.sh/three';

const PALETTE = {
  scene_bg: "#f1eee8",
  gray_dark: "#8f8f8f",
  gray_mid1: "#B0B0B0",
  yellow_soft: "#f7dc93",
  false_sat: "#E69F00", // Non-planned
  true_sat: "#1977AD"   // Planned
};

const EARTH_RADIUS_KM = 6378.137;
const GSO_ALTITUDE_KM = 35786.0; 
const GSO_ALTITUDE_RATIO = GSO_ALTITUDE_KM / EARTH_RADIUS_KM;

let world;
let linkLinesMesh = null;
let cachedGeoJsonFeatures = [];
let countryExceptions = {};
let currentHighlightedSet = new Set();

let rawData = {
  stations: [],
  satellites: [],
  connections: []
};

// Common country aliases and variations (resolving the USA / United States mismatch glitch)
const COUNTRY_ALIASES = {
  "usa": "united states",
  "us": "united states",
  "united states of america": "united states",
  "u.s.": "united states",
  "u.s.a.": "united states"
};

document.addEventListener("DOMContentLoaded", () => {
  initGlobe();
  loadData();
  setupUIEvents();
});

function normalizeCountryName(name) {
  if (!name) return "";
  const trimmed = name.trim().toLowerCase();
  
  if (COUNTRY_ALIASES[trimmed]) {
    return COUNTRY_ALIASES[trimmed];
  }
  
  for (const [key, val] of Object.entries(countryExceptions)) {
    if (key.toLowerCase() === trimmed) {
      return val.toLowerCase().trim();
    }
  }
  
  return trimmed;
}

function updateHighlightedCountriesCache() {
  const gsCountry = document.getElementById("filterGsCountry")?.value;
  const satCountry = document.getElementById("filterSatCountry")?.value;
  
  const highlighted = new Set();
  
  if (gsCountry && gsCountry !== "all") {
    highlighted.add(normalizeCountryName(gsCountry));
  }
  
  if (satCountry && satCountry !== "all") {
    const targetSatCountry = normalizeCountryName(satCountry);
    
    const sats = rawData.satellites.filter(s => {
      const op = normalizeCountryName(s.operator || s.satcountry || "");
      return op === targetSatCountry;
    });
    const satNames = new Set(sats.map(s => s.name));
    
    const gsNames = new Set();
    rawData.connections.forEach(c => {
      if (satNames.has(c.sat_name)) {
        gsNames.add(c.gs_name);
      }
    });
    
    rawData.stations.forEach(stn => {
      if (gsNames.has(stn.name)) {
        const cName = normalizeCountryName(stn.country || stn.gscountry || "");
        if (cName) highlighted.add(cName);
      }
    });
  }
  
  currentHighlightedSet = highlighted;
}

function isCountryHighlighted(featureProps) {
  if (!featureProps || currentHighlightedSet.size === 0) return false;
  
  const rawNames = [
    featureProps.name,
    featureProps.ADMIN,
    featureProps.NAME,
    featureProps.ISO_A2,
    featureProps.ISO_A3
  ].filter(Boolean);

  return rawNames.some(rawN => {
    const normN = normalizeCountryName(rawN);
    return Array.from(currentHighlightedSet).some(h => {
      const normH = normalizeCountryName(h);
      if (normN === normH) return true;
      if (normH.length <= 3) return normN === normH;
      return normN.includes(normH) || normH.includes(normN);
    });
  });
}

function initGlobe() {
  const container = document.getElementById("globeCanvas");

  world = Globe()(container)
    .backgroundColor(PALETTE.scene_bg)
    .showGlobe(true)
    .showAtmosphere(false)
    .globeMaterial(new THREE.MeshBasicMaterial({ color: 0x111111 }))
    
    .polygonCapColor(d => isCountryHighlighted(d.properties) ? "rgba(25, 119, 173, 0.55)" : "transparent")
    .polygonSideColor(() => "transparent")
    .polygonStrokeColor(d => isCountryHighlighted(d.properties) ? "#1977AD" : "#cccccc")
    .polygonAltitude(d => isCountryHighlighted(d.properties) ? 0.005 : 0.0)
    
    // --- 1. GROUND STATIONS ---
    .pointsData([])
    .pointLat('lat')
    .pointLng('lon')
    .pointAltitude(0.01)
    .pointRadius(0.24)
    .pointColor(() => PALETTE.gray_dark)
    .pointLabel(d => {
      const connectedSats = d.satellites || [];
      let satHtml = "<b>No connected satellites</b>";
      if (connectedSats.length > 0) {
        satHtml = "<b>Satellites:</b><br>" + connectedSats.map(s => ` - ${s}`).join("<br>");
      }
      return `
        <div style="min-width: 240px; max-width: 320px; padding: 10px 14px; background: #f7dc93; color: #111111; border-radius: 4px; font-size: 13px; line-height: 1.4; box-shadow: 0 4px 10px rgba(0,0,0,0.25); word-break: break-word;">
          <b>${d.name}</b> (${d.operator || 'Unknown'})<br>
          Country: ${d.country || 'Unknown'}<br><br>
          ${satHtml}
        </div>
      `;
    })
    .onPointClick(d => {
      showStationDetails(d);
      focusCameraOn(d.lat, d.lon, 1.25);
    })

    // --- 2. GSO SATELLITES ---
    .objectsData([])
    .objectLat('lat')
    .objectLng('lon')
    .objectAltitude(GSO_ALTITUDE_RATIO)
    .objectThreeObject(d => {
      const isPlanned = d.planned === true || d.planned === 1 || d.planned === "1" || d.planned === "true";
      const color = isPlanned ? PALETTE.true_sat : PALETTE.false_sat;
      
      const geometry = new THREE.SphereGeometry(0.30, 16, 16);
      const material = new THREE.MeshBasicMaterial({ color: color });
      const mesh = new THREE.Mesh(geometry, material);
      mesh.userData = d;
      return mesh;
    })
    .objectLabel(d => {
      const isPlanned = d.planned === true || d.planned === 1 || d.planned === "1" || d.planned === "true";
      const status = isPlanned ? "Planned" : "Non-Planned";
      const gsList = d.ground_stations || [];
      let gsHtml = "No ground stations";
      if (gsList.length > 0) {
        gsHtml = "<b>Ground Stations:</b><br>" + gsList.map(g => ` - ${g}`).join("<br>");
      }
      return `
        <div style="min-width: 240px; max-width: 320px; padding: 10px 14px; background: #f7dc93; color: #111111; border-radius: 4px; font-size: 13px; line-height: 1.4; box-shadow: 0 4px 10px rgba(0,0,0,0.25); word-break: break-word;">
          <b>${d.name} (${status})</b> (${d.operator || 'Unknown'})<br>
          Longitude: ${d.lon}°<br><br>
          ${gsHtml}
        </div>
      `;
    })
    .onObjectClick(obj => {
      if (obj && obj.userData) {
        const sat = obj.userData;
        showSatelliteDetails(sat);
        focusCameraOn(sat.lat || 0, sat.lon, 2.0);
      }
    });

  fetch("./data/globe.json")
    .then(res => res.json())
    .then(geojson => {
      cachedGeoJsonFeatures = geojson.features || [];
      world.polygonsData(cachedGeoJsonFeatures);
    })
    .catch(() => {
      fetch("https://raw.githubusercontent.com/johan/world.geo.json/master/countries.geo.json")
        .then(res => res.json())
        .then(geojson => {
          cachedGeoJsonFeatures = geojson.features || [];
          world.polygonsData(cachedGeoJsonFeatures);
        });
    });

  renderGSORing();
  world.pointOfView({ lat: 20, lng: 0, altitude: 2.2 }, 0);

  world.controls().addEventListener('change', () => {
    const pov = world.pointOfView();
    const scaleFactor = Math.max(1.0, pov.altitude * 0.6);
    
    world.scene().traverse(node => {
      if (node.isMesh && node.geometry instanceof THREE.SphereGeometry && node.userData && node.userData.planned !== undefined) {
        node.scale.set(scaleFactor, scaleFactor, scaleFactor);
      }
    });
  });
}

function renderGSORing() {
  const scene = world.scene();
  const radius = 1 + GSO_ALTITUDE_RATIO;
  
  const geometry = new THREE.RingGeometry(radius - 0.04, radius + 0.04, 128);
  const material = new THREE.MeshBasicMaterial({
    color: new THREE.Color(PALETTE.true_sat),
    side: THREE.DoubleSide,
    transparent: true,
    opacity: 0.35
  });

  const ringMesh = new THREE.Mesh(geometry, material);
  ringMesh.rotation.x = Math.PI / 2;
  scene.add(ringMesh);

  const wireGeometry = new THREE.RingGeometry(radius - 0.08, radius + 0.08, 64);
  const wireMaterial = new THREE.MeshBasicMaterial({
    color: new THREE.Color(PALETTE.gray_mid1),
    side: THREE.DoubleSide,
    transparent: true,
    opacity: 0.15,
    wireframe: true
  });
  const wireRing = new THREE.Mesh(wireGeometry, wireMaterial);
  wireRing.rotation.x = Math.PI / 2;
  scene.add(wireRing);
}

async function loadData() {
  try {
    const [stationsRes, satellitesRes, connectionsRes, exceptionsRes] = await Promise.all([
      fetch("./data/stations.json"),
      fetch("./data/satellites.json"),
      fetch("./data/connections.json"),
      fetch("./data/exceptions.json").catch(() => ({ json: () => ({}) }))
    ]);

    rawData.stations = await stationsRes.json();
    rawData.satellites = await satellitesRes.json();
    rawData.connections = await connectionsRes.json();
    countryExceptions = await exceptionsRes.json().catch(() => ({}));

    const satConnectionMap = new Map();
    const stnConnectionMap = new Map();

    rawData.connections.forEach(c => {
      if (!satConnectionMap.has(c.sat_name)) satConnectionMap.set(c.sat_name, []);
      satConnectionMap.get(c.sat_name).push(c.gs_name);

      if (!stnConnectionMap.has(c.gs_name)) stnConnectionMap.set(c.gs_name, []);
      stnConnectionMap.get(c.gs_name).push(c.sat_name);
    });

    rawData.satellites.forEach(s => {
      s.ground_stations = [...new Set(satConnectionMap.get(s.name) || [])];
      s.lat = 0; 
      s.lon = s.long_nom !== undefined && s.long_nom !== null ? s.long_nom : (s.lon !== undefined && s.lon !== null ? s.lon : 0);
    });

    rawData.stations.forEach(stn => {
      stn.satellites = [...new Set(stnConnectionMap.get(stn.name) || [])];
    });

    populateCountryFilters(rawData.satellites, rawData.stations);
    applyFilters(false);

  } catch (err) {
    console.error("Dataset loading error:", err);
    const detailsBox = document.getElementById("detailsBox");
    if (detailsBox) {
      detailsBox.innerHTML = `<p style="color: #d9534f; margin:0;">Error loading dataset from ./data/ folder.</p>`;
    }
  }
}

function populateCountryFilters(satellites, stations) {
  const satCountrySelect = document.getElementById("filterSatCountry");
  const gsCountrySelect = document.getElementById("filterGsCountry");

  if (satCountrySelect) {
    satCountrySelect.innerHTML = '<option value="all">All Countries</option>';
    const satCountries = [...new Set(satellites.map(s => s.operator || s.satcountry).filter(Boolean))].sort();
    satCountries.forEach(country => {
      const option = document.createElement("option");
      option.value = country;
      option.textContent = country;
      satCountrySelect.appendChild(option);
    });
  }

  if (gsCountrySelect) {
    gsCountrySelect.innerHTML = '<option value="all">All Countries</option>';
    const gsCountries = [...new Set(stations.map(stn => stn.country || stn.gscountry).filter(Boolean))].sort();
    gsCountries.forEach(country => {
      const option = document.createElement("option");
      option.value = country;
      option.textContent = country;
      gsCountrySelect.appendChild(option);
    });
  }
}

function applyFilters(adjustView = true) {
  const filterStatusEl = document.getElementById("filterStatus");
  const filterSatCountryEl = document.getElementById("filterSatCountry");
  const filterGsCountryEl = document.getElementById("filterGsCountry");

  const filterStatus = filterStatusEl ? filterStatusEl.value : "all";
  const satCountry = filterSatCountryEl ? filterSatCountryEl.value : "all";
  const gsCountry = filterGsCountryEl ? filterGsCountryEl.value : "all";

  updateHighlightedCountriesCache();

  let filteredStations = rawData.stations.filter(stn => {
    const stnCountry = normalizeCountryName(stn.country || stn.gscountry || "");
    const targetGs = normalizeCountryName(gsCountry);
    return gsCountry === "all" || stnCountry === targetGs;
  });

  let validSatNamesByGs = new Set();
  if (gsCountry !== "all") {
    filteredStations.forEach(stn => {
      const connectedSats = rawData.connections.filter(c => c.gs_name === stn.name);
      connectedSats.forEach(c => validSatNamesByGs.add(c.sat_name));
    });
  }

  let filteredSatellites = rawData.satellites.filter(sat => {
    const isPlanned = sat.planned === true || sat.planned === 1 || sat.planned === "1" || sat.planned === "true";
    
    const matchesStatus = 
      filterStatus === "all" || 
      (filterStatus === "planned" && isPlanned) || 
      (filterStatus === "nonplanned" && !isPlanned);

    const satOp = normalizeCountryName(sat.operator || sat.satcountry || "");
    const matchesSatCountry = satCountry === "all" || satOp === normalizeCountryName(satCountry);

    const matchesGsConnectivity = gsCountry === "all" || validSatNamesByGs.has(sat.name);

    return matchesStatus && matchesSatCountry && matchesGsConnectivity;
  });

  if (satCountry !== "all") {
    const activeSatNames = new Set(filteredSatellites.map(s => s.name));
    const validGsNames = new Set();
    rawData.connections.forEach(conn => {
      if (activeSatNames.has(conn.sat_name)) {
        validGsNames.add(conn.gs_name);
      }
    });

    filteredStations = filteredStations.filter(stn => validGsNames.has(stn.name));
  }

  const finalActiveSatNames = new Set(filteredSatellites.map(s => s.name));
  const filteredConnections = rawData.connections.filter(conn => 
    finalActiveSatNames.has(conn.sat_name) && filteredStations.some(stn => stn.name === conn.gs_name)
  );

  world.pointsData(filteredStations);
  world.objectsData(filteredSatellites);
  renderStraightLinkBeams(filteredConnections);

  if (world && cachedGeoJsonFeatures.length > 0) {
    world.polygonsData([...cachedGeoJsonFeatures]);
  }

  const satStat = document.getElementById("satelliteStat");
  const stnStat = document.getElementById("stationStat");
  if (satStat) satStat.textContent = filteredSatellites.length.toLocaleString();
  if (stnStat) stnStat.textContent = filteredStations.length.toLocaleString();

  if (adjustView) {
    if (gsCountry !== "all" && filteredStations.length > 0) {
      const avgLat = filteredStations.reduce((sum, s) => sum + s.lat, 0) / filteredStations.length;
      const avgLon = filteredStations.reduce((sum, s) => sum + s.lon, 0) / filteredStations.length;
      focusCameraOn(avgLat, avgLon, filteredStations.length === 1 ? 1.25 : 1.55);
    } else if (satCountry !== "all" && filteredSatellites.length > 0) {
      const avgLon = filteredSatellites.reduce((sum, s) => sum + s.lon, 0) / filteredSatellites.length;
      focusCameraOn(0, avgLon, 1.9);
    }
  }
}

function renderStraightLinkBeams(connections) {
  const scene = world.scene();

  if (linkLinesMesh) {
    scene.remove(linkLinesMesh);
    linkLinesMesh.traverse(child => {
      if (child.geometry) child.geometry.dispose();
      if (child.material) child.material.dispose();
    });
    linkLinesMesh = null;
  }

  if (!connections || connections.length === 0) return;

  const group = new THREE.Group();
  const material = new THREE.MeshBasicMaterial({
    color: new THREE.Color("#B0B0B0"), 
    transparent: true,
    opacity: 0.95                      
  });

  connections.forEach(conn => {
    const satObj = rawData.satellites.find(s => s.name === conn.sat_name);
    const satLon = satObj ? satObj.lon : (conn.sat_lon || 0);

    const p1 = world.getCoords(conn.gs_lat, conn.gs_lon, 0.01);
    const p2 = world.getCoords(0, satLon, GSO_ALTITUDE_RATIO);

    const v1 = new THREE.Vector3(p1.x, p1.y, p1.z);
    const v2 = new THREE.Vector3(p2.x, p2.y, p2.z);

    const distance = v1.distanceTo(v2);
    const geometry = new THREE.CylinderGeometry(0.1, 0.035, distance, 4);
    
    const cylinder = new THREE.Mesh(geometry, material);
    
    cylinder.position.copy(v1).add(v2).multiplyScalar(0.5);
    cylinder.lookAt(v2);
    cylinder.rotateX(Math.PI / 2);

    group.add(cylinder);
  });

  linkLinesMesh = group;
  scene.add(linkLinesMesh);
}

function focusCameraOn(lat, lng, altitude = 1.6) {
  world.pointOfView({ lat, lng, altitude }, 800);
}

function showSatelliteDetails(sat) {
  const isPlanned = sat.planned === true || sat.planned === 1 || sat.planned === "1" || sat.planned === "true";
  const status = isPlanned ? "Planned" : "Non-Planned";
  const connectedLinks = rawData.connections.filter(c => c.sat_name === sat.name);
  const detailsBox = document.getElementById("detailsBox");
  
  if (detailsBox) {
    detailsBox.innerHTML = `
      <strong>${sat.name} (${status})</strong><br>
      Operator Country: ${sat.operator || sat.satcountry || 'Unknown'}<br>
      Nominal Longitude: ${sat.lon}°<br>
      Active Ground Station Links: ${connectedLinks.length}
    `;
  }
}

function showStationDetails(stn) {
  const connectedLinks = rawData.connections.filter(c => c.gs_name === stn.name);
  const detailsBox = document.getElementById("detailsBox");
  
  if (detailsBox) {
    detailsBox.innerHTML = `
      <strong>${stn.name}</strong> (${stn.operator || 'Unknown'})<br>
      Country: ${stn.country || stn.gscountry || 'Unknown'}<br>
      Lat/Lon: ${stn.lat.toFixed(2)}°, ${stn.lon.toFixed(2)}°<br>
      Connected Satellites: ${connectedLinks.length}
    `;
  }
}

function setupUIEvents() {
  const searchInput = document.getElementById("searchInput");
  const filterStatus = document.getElementById("filterStatus");
  const filterSatCountry = document.getElementById("filterSatCountry");
  const filterGsCountry = document.getElementById("filterGsCountry");
  const suggestionBox = document.getElementById("searchSuggestions");

  if (filterStatus) filterStatus.addEventListener("change", () => applyFilters(true));
  if (filterSatCountry) filterSatCountry.addEventListener("change", () => applyFilters(true));
  if (filterGsCountry) filterGsCountry.addEventListener("change", () => applyFilters(true));

  if (searchInput) {
    searchInput.addEventListener("input", (e) => {
      const val = e.target.value.toLowerCase().trim();
      if (val.length === 0) {
        if (suggestionBox) suggestionBox.style.display = "none";
        return;
      }

      const matchingSats = rawData.satellites.filter(s => s.name.toLowerCase().includes(val)).slice(0, 5);
      const matchingStations = rawData.stations.filter(stn => stn.name.toLowerCase().includes(val)).slice(0, 5);

      let html = "";
      matchingSats.forEach(s => {
        html += `<div class="suggestion-item" data-type="sat" data-name="${s.name}" style="padding: 10px 14px; cursor: pointer; border-bottom: 1px solid #eee; font-size: 13px; color: #111;">🛰️ <b>${s.name}</b> (Satellite)</div>`;
      });
      matchingStations.forEach(stn => {
        html += `<div class="suggestion-item" data-type="stn" data-name="${stn.name}" style="padding: 10px 14px; cursor: pointer; border-bottom: 1px solid #eee; font-size: 13px; color: #111;">📡 <b>${stn.name}</b> (${stn.country || 'Ground Station'})</div>`;
      });

      if (html && suggestionBox) {
        suggestionBox.innerHTML = html;
        suggestionBox.style.display = "block";

        suggestionBox.querySelectorAll(".suggestion-item").forEach(item => {
          item.addEventListener("click", () => {
            const type = item.getAttribute("data-type");
            const name = item.getAttribute("data-name");
            searchInput.value = name;
            suggestionBox.style.display = "none";

            if (filterStatus) filterStatus.value = "all";
            if (filterSatCountry) filterSatCountry.value = "all";
            if (filterGsCountry) filterGsCountry.value = "all";

            applyFilters(false);

            if (type === "sat") {
              const sat = rawData.satellites.find(s => s.name === name);
              if (sat) {
                world.objectsData([sat]);
                world.pointsData([]);
                renderStraightLinkBeams([]);
                showSatelliteDetails(sat);
                focusCameraOn(0, sat.lon, 2.0);
              }
            } else {
              const stn = rawData.stations.find(s => s.name === name);
              if (stn) {
                world.pointsData([stn]);
                world.objectsData([]);
                renderStraightLinkBeams([]);
                showStationDetails(stn);
                focusCameraOn(stn.lat, stn.lon, 1.25);
              }
            }
          });
        });
      } else if (suggestionBox) {
        suggestionBox.style.display = "none";
      }
    });

    document.addEventListener("click", (e) => {
      if (suggestionBox && !searchInput.contains(e.target) && !suggestionBox.contains(e.target)) {
        suggestionBox.style.display = "none";
      }
    });
  }

  const zoomInBtn = document.getElementById("zoomInBtn");
  const zoomOutBtn = document.getElementById("zoomOutBtn");
  const viewToggleBtn = document.getElementById("viewToggleBtn");

  if (zoomInBtn) {
    zoomInBtn.addEventListener("click", () => {
      const pov = world.pointOfView();
      const newAlt = Math.max(pov.altitude - 0.4, 0.5);
      world.pointOfView({ ...pov, altitude: newAlt }, 400);
    });
  }

  if (zoomOutBtn) {
    zoomOutBtn.addEventListener("click", () => {
      const pov = world.pointOfView();
      const newAlt = Math.min(pov.altitude + 0.4, 8.0);
      world.pointOfView({ ...pov, altitude: newAlt }, 400);
    });
  }

  if (viewToggleBtn) {
    let isHorizonView = false;
    viewToggleBtn.addEventListener("click", () => {
      isHorizonView = !isHorizonView;
      if (isHorizonView) {
        world.pointOfView({ lat: 25, lng: -100, altitude: 1.2 }, 800);
        viewToggleBtn.textContent = "◎";
        viewToggleBtn.title = "Switch to overhead globe view";
      } else {
        world.pointOfView({ lat: 20, lng: 0, altitude: 2.2 }, 800);
        viewToggleBtn.textContent = "◠";
        viewToggleBtn.title = "Toggle globe / horizon view";
      }
    });
  }
}