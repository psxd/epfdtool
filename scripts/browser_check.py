"""Headless smoke test: boots the real app in Chromium, then checks that for
every sampled node the number of beams the renderer actually draws equals the
number of connections its card lists - including the same-named nodes that the
old name-keyed pipeline used to merge.

Run: python3 scripts/browser_check.py   (needs `npm run dev` NOT running; this
script starts its own Vite server on port 5199).
"""
import json
import subprocess
import sys
import time
from pathlib import Path

from playwright.sync_api import sync_playwright

BASE = Path(__file__).resolve().parent.parent

# The store is reached by importing the live module through the Vite dev server,
# so no test-only global is added to the app itself.
GET_STORE = "import('/src/state.js').then(m => m.store)"

server = subprocess.Popen(
    ["npx", "vite", "--port", "5199", "--strictPort"],
    cwd=BASE, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
)
time.sleep(6)

try:
    with sync_playwright() as p:
        browser = p.chromium.launch()
        page = browser.new_page()
        errors = []
        page.on("pageerror", lambda e: errors.append(str(e)))
        page.on("console", lambda m: errors.append(m.text) if m.type == "error" else None)

        page.goto("http://localhost:5199/", wait_until="load")
        page.wait_for_function(
            "async () => (await import('/src/state.js')).store.linkMeta?.count > 0",
            timeout=60000,
        )
        page.wait_for_timeout(1500)

        boot = page.evaluate("""async () => {
          const { store } = await import('/src/state.js');
          const meta = store.linkMeta;
          const drawnFor = (kind, id) => {
            const arr = kind === 'sat' ? meta.satId : meta.gsId;
            let n = 0;
            for (let i = 0; i < meta.count; i++) if (arr[i] === id) n++;
            return n;
          };
          const listedFor = (kind, id) =>
            (kind === 'sat' ? store.gsBySatId.get(id) : store.satsByGsId.get(id) || []).length;

          const dupGs = [...store.gsIdsByName.entries()].filter(([, v]) => v.length > 1);
          const dupSat = [...store.satIdsByName.entries()].filter(([, v]) => v.length > 1);
          // Sample the previously-broken nodes plus a spread of ordinary ones.
          const gsIds = dupGs.slice(0, 40).flatMap(([, v]) => v);
          const satIds = dupSat.flatMap(([, v]) => v);
          const allGs = [...store.stationById.keys()];
          const allSat = [...store.satById.keys()];
          for (let i = 0; i < allGs.length; i += 37) gsIds.push(allGs[i]);
          for (let i = 0; i < allSat.length; i += 7) satIds.push(allSat[i]);

          const mismatches = [];
          for (const id of new Set(gsIds)) {
            const d = drawnFor('gs', id), l = listedFor('gs', id);
            if (d !== l) mismatches.push({ kind: 'gs', id, drawn: d, listed: l });
          }
          for (const id of new Set(satIds)) {
            const d = drawnFor('sat', id), l = listedFor('sat', id);
            if (d !== l) mismatches.push({ kind: 'sat', id, drawn: d, listed: l });
          }
          return {
            totalBeams: meta.count,
            dupGsNames: dupGs.length,
            dupSatNames: dupSat.length,
            checkedGs: new Set(gsIds).size,
            checkedSat: new Set(satIds).size,
            mismatches: mismatches.slice(0, 10),
            summaryHiddenWhenIdle: document.getElementById('filterSummarySection').style.display === 'none',
            satStat: document.getElementById('satelliteStat')?.textContent,
            stnStat: document.getElementById('stationStat')?.textContent,
          };
        }""")

        # Search must find BOTH same-named stations and select a specific one.
        page.click("#searchInput")
        page.type("#searchInput", "SIDODADI")
        page.wait_for_selector(".suggestion-item", timeout=10000)
        page.wait_for_timeout(300)
        suggestion_count = page.eval_on_selector_all(".suggestion-item", "els => els.length")
        page.click(".suggestion-item")
        page.wait_for_timeout(800)
        after = page.evaluate("""async () => {
          const { store } = await import('/src/state.js');
          const sel = store.selection;
          const meta = store.linkMeta;
          const arr = sel.kind === 'sat' ? meta.satId : meta.gsId;
          let drawn = 0;
          for (let i = 0; i < meta.count; i++) if (arr[i] === sel.id) drawn++;
          return {
            text: document.getElementById('filterSummaryBox').textContent.trim(),
            hidden: document.getElementById('filterSummarySection').style.display === 'none',
            selection: sel,
            drawnBeams: drawn,
            listedRows: (sel.kind === 'sat' ? store.gsBySatId.get(sel.id)
                                           : store.satsByGsId.get(sel.id) || []).length,
            card: document.getElementById('detailsBox').textContent.replace(/\\s+/g, ' ').trim().slice(0, 220),
          };
        }""")

        browser.close()

    report = dict(boot)
    report["suggestionCount"] = suggestion_count
    report["afterSelect"] = after
    report["errors"] = errors[:5]
    print(json.dumps(report, indent=2))
    ok = not boot["mismatches"] and after["drawnBeams"] == after["listedRows"] and not errors
    print("\nPASS: drawn beams == listed connections for every sampled node."
          if ok else "\nFAIL: see mismatches / errors above.")
    sys.exit(0 if ok else 1)
finally:
    server.terminate()
    server.wait(timeout=10)
