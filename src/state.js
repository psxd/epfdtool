// Central mutable store shared by all modules.
export const store = {
  world: null,
  // Instanced link-beam mesh (one draw call for all links) + flat meta arrays.
  linkMesh: null,
  linkMeta: null, // { count, gsLat, gsLon, gsX, gsY, gsZ, dirX, dirY, dirZ, country, ident }
  linkLinesMesh: null, // legacy alias kept so old call sites keep working
  cachedGeoJsonFeatures: [],
  geoNameSet: null, // Set of canonical geo names, built once globe.json loads
  nameCache: new Map(),
  currentHighlightedSet: new Set(), // canonical keys that get the solid blue FILL
  currentSatOutlineSet: new Set(), // sat-filtered country: blue OUTLINE, never filled
  currentFootprintSet: new Set(), // sat-filter linked GS countries (outline only)
  persistentlyHighlightedLinks: new Set(),
  // Lookup indexes built once in loadData (avoid O(N^2) scans in filters/hovers).
  satByName: new Map(),
  stationByName: new Map(),
  satsByGsName: new Map(), // gsName -> [{ name, country, ntcId }]
  gsBySatName: new Map(),  // satName -> [{ name, country, ntcId }]
  satLonByName: new Map(),
  ntcByGsSat: new Map(), // JSON "[gsName, satName]" -> ntc id (dashboard deep-link)
  searchIndex: [], // [{ kind, name, lcName, country }]
  satMeshes: [], // satellite meshes for cheap rescale on zoom
  leoTrajectoryMesh: null,
  leoTrail: null, // { mesh, attr, capacity }
  activeLeoAnimation: null,
  selectedSatrec: null,
  leoStartTime: null,
  leoSimulationEpochTime: null,
  leoSatelliteMesh: null,
  isLeoActive: false,
  leoPositionHistory: [],
  orbitalPeriodMs: 0,
  rawData: {
    stations: [],
    satellites: [],
    connections: []
  },
  dataMeta: {}, // { br_ific } from public/data/meta.json (scraped by spaceexplorer.py)
};

