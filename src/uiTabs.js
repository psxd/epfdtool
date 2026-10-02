// Tab switching + LEO search/reset wiring.
import { store } from './state.js';
import { applyFilters } from './gsoFilters.js';
import { DEFAULT_VIEW } from './globe.js';
import { focusCameraOn, clearSelection, cancelFollow } from './globe.js';
import { resetLeoVisualization } from './leoHighlight.js';
import { loadAndPropagateLeo } from './leoPropagation.js';
import { updateFilterSummary } from './filterSummary.js';

export function setupTabs() {
  const tabGso = document.getElementById('tabGsoBtn');
  const tabLeo = document.getElementById('tabLeoBtn');
  const gsoSection = document.getElementById('gsoPanel');
  const leoSection = document.getElementById('leoPanel');
  tabGso?.addEventListener('click', () => {
    tabGso.classList.add('active');
    tabGso.style.fontWeight = 'bold';
    tabLeo.classList.remove('active');
    tabLeo.style.fontWeight = 'normal';
    gsoSection.style.display = 'block';
    leoSection.style.display = 'none';
    resetLeoVisualization();
    // Leaving LEO must not carry follow into the GSO view.
    cancelFollow();
    const followBox = document.getElementById('leoFollowCheckbox');
    if (followBox) followBox.checked = false;
    // An entity selected before the LEO tab was opened must not leave half the
    // GSO beams hidden once we are back here.
    clearSelection();
    applyFilters(true);
    focusCameraOn(DEFAULT_VIEW.lat, DEFAULT_VIEW.lng, DEFAULT_VIEW.altitude);
  });
  tabLeo?.addEventListener('click', () => {
    tabLeo.classList.add('active');
    tabLeo.style.fontWeight = 'bold';
    tabGso.classList.remove('active');
    tabGso.style.fontWeight = 'normal';
    gsoSection.style.display = 'none';
    leoSection.style.display = 'block';
    resetLeoVisualization();
    clearSelection();
    updateFilterSummary();
    focusCameraOn(DEFAULT_VIEW.lat, DEFAULT_VIEW.lng, DEFAULT_VIEW.altitude);
  });
}

export function setupLeoUIEvents() {
  const searchInput = document.getElementById('leoSearchInput');
  const suggestionBox = document.getElementById('leoSearchSuggestions');
  const resetBtn = document.getElementById('leoResetBtn');
  const followBox = document.getElementById('leoFollowCheckbox');

  // Satellite-follow toggle. Enabling snaps the camera to the satellite on the
  // very next propagation frame (no 800 ms fly-in from the default view, which
  // would read as a swoop rather than joining the satellite mid-orbit).
  if (followBox) {
    followBox.addEventListener('change', () => {
      store.leoFollowSatellite = followBox.checked;
      store.leoFollowBreakout = false;
    });
  }

  // A real DRAG breaks follow so the camera never fights the user; a plain click
  // or a text selection must NOT (following survives those). DRAG_PX below is a
  // deliberately generous threshold so small pointer jitter and accidental
  // nudges never drop follow - you have to really drag the globe to take over.
  // Bound on the canvas wrapper, NOT via globe.gl's controls(): this bundle
  // never links that method onto the Globe instance.
  const canvasWrap = document.getElementById('canvas-wrap');
  if (canvasWrap) {
    const DRAG_PX = 100;
    let dragFrom = null;
    const breakFollow = () => {
      if (!store.leoFollowSatellite) return;
      store.leoFollowSatellite = false;
      store.leoFollowBreakout = true;
      if (followBox) followBox.checked = false;
    };
    canvasWrap.addEventListener('pointerdown', (e) => {
      dragFrom = { x: e.clientX, y: e.clientY };
    }, true);
    canvasWrap.addEventListener('pointermove', (e) => {
      if (!dragFrom || !store.leoFollowSatellite) return;
      if (Math.hypot(e.clientX - dragFrom.x, e.clientY - dragFrom.y) > DRAG_PX) breakFollow();
    }, true);
    const endDrag = () => { dragFrom = null; };
    canvasWrap.addEventListener('pointerup', endDrag, true);
    canvasWrap.addEventListener('pointercancel', endDrag, true);
    // A scroll is unambiguously a camera intent, so it still breaks immediately.
    canvasWrap.addEventListener('wheel', breakFollow, { capture: true, passive: true });
  }
  searchInput?.addEventListener('input', async (e) => {
    const query = e.target.value.trim();
    if (query.length < 2) {
      if (suggestionBox) suggestionBox.style.display = 'none';
      return;
    }
    try {
      const res = await fetch(`https://celestrak.org/NORAD/elements/gp.php?NAME=${encodeURIComponent(query.toUpperCase())}&FORMAT=TLE`);
      const text = await res.text();
      const lines = text.trim().split(/\r?\n/).filter(Boolean);
      let html = '';
      for (let i = 0; i < lines.length; i += 3) {
        if (i + 2 < lines.length) {
          const satName = lines[i].trim();
          const t1 = lines[i + 1];
          const t2 = lines[i + 2];
          html += `<div class="leo-suggestion-item" data-name="${satName}" data-t1="${t1}" data-t2="${t2}" style="padding: 8px; cursor: pointer; border-bottom: 1px solid #eee; font-size: 13px; color: #111;">🛰️ <b>${satName}</b></div>`;
        }
      }
      if (html && suggestionBox) {
        suggestionBox.innerHTML = html;
        suggestionBox.style.display = 'block';
        suggestionBox.querySelectorAll('.leo-suggestion-item').forEach(item => {
          item.addEventListener('click', () => {
            searchInput.value = item.getAttribute('data-name');
            suggestionBox.style.display = 'none';
            loadAndPropagateLeo(searchInput.value, item.getAttribute('data-t1'), item.getAttribute('data-t2'));
          });
        });
      } else if (suggestionBox) {
        suggestionBox.style.display = 'none';
      }
    } catch (err) {
      console.error('Error fetching TLE:', err);
    }
  });
  resetBtn?.addEventListener('click', () => {
    resetLeoVisualization();
    // Reset clears follow too, and returns the camera to the default view.
    cancelFollow();
    if (followBox) followBox.checked = false;
    focusCameraOn(DEFAULT_VIEW.lat, DEFAULT_VIEW.lng, DEFAULT_VIEW.altitude);
    applyFilters(true);
  });
  document.addEventListener('click', (e) => {
    if (suggestionBox && searchInput && !searchInput.contains(e.target) && !suggestionBox.contains(e.target)) {
      suggestionBox.style.display = 'none';
    }
  });
  void store;
}
