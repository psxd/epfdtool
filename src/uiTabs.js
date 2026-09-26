// Tab switching + LEO search/reset wiring.
import { store } from './state.js';
import { applyFilters } from './gsoFilters.js';
import { DEFAULT_VIEW } from './globe.js';
import { focusCameraOn } from './globe.js';
import { resetLeoVisualization } from './leoHighlight.js';
import { loadAndPropagateLeo } from './leoPropagation.js';

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
    focusCameraOn(DEFAULT_VIEW.lat, DEFAULT_VIEW.lng, DEFAULT_VIEW.altitude);
  });
}

export function setupLeoUIEvents() {
  const searchInput = document.getElementById('leoSearchInput');
  const suggestionBox = document.getElementById('leoSearchSuggestions');
  const resetBtn = document.getElementById('leoResetBtn');
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
    applyFilters(true);
  });
  document.addEventListener('click', (e) => {
    if (suggestionBox && searchInput && !searchInput.contains(e.target) && !suggestionBox.contains(e.target)) {
      suggestionBox.style.display = 'none';
    }
  });
  void store;
}
