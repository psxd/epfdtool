// Vite entry point. Behaviour is split into modules but stays 1:1 with ver1/app.js;
// this file only wires startup in the same order.
import '../style.css';
import { initGlobe } from './globe.js';
import { loadData, showSatelliteDetails, showStationDetails } from './gsoNetwork.js';
import { setupUIEvents } from './uiSearch.js';
import { setupTabs, setupLeoUIEvents } from './uiTabs.js';
import { initComments } from './comments.js';

document.addEventListener('DOMContentLoaded', () => {
  initGlobe({ showSatelliteDetails, showStationDetails });
  loadData();
  setupUIEvents();
  setupTabs();
  setupLeoUIEvents();
  initComments();
});
