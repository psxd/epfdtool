// ITU definition popups (filter labels + legend rows).
// JS owns show/hide AND placement: position: fixed, viewport-clamped, so the
// cards (including the nested "Station" card) can never be cut off by the
// scrollable #ui panel - CSS-absolute tips used to be clipped at its edge.
// Each tip stays a DOM child of its term, and the small pixel gap between a
// term and its card is bridged by a short leave delay (LEAVE_DELAY_MS), so
// both the primary card and the secondary card (Station / filing) are easy
// to reach without flicker.
// Interaction:
//  * hover / keyboard focus -> show; leaving -> hides after the delay.
//  * CLICK a term -> PIN it open (text behaves like the old i button).
//  * CLICK a legend i button -> BOTH definitions of that row, stacked as two
//    cards; while nothing is pinned, hovering either word still shows only
//    that word's own definition.
//  * Esc / click outside -> unpin + close. Scroll/resize -> hides (fixed
//    coords go stale); a pinned card re-appears on re-hover.
// Kept deliberately lightweight: no per-frame work, one shared leave timer,
// pure class toggles, an open-card Set instead of DOM queries on scroll, and
// each card's size measured ONCE (content is static) then cached - showing a
// card costs one anchor-rect read and two style writes.
const TIP_MARGIN = 8;
const TIP_GAP = 6;
const LEAVE_DELAY_MS = 160; // bridges the pixel gap between term and card

let pinned = null;      // anchor term whose card(s) are pinned
let pinnedInner = null; // co-pinned partner: stack 2nd card OR nested Station
let pinMode = null;     // null = single | 'stack' = i button | 'sub' = Station
let leaveTimer = 0;

const openEls = new Set();      // terms with a card currently open
const sizeCache = new WeakMap(); // tip -> { w, h } (static content)

function tipOf(el) {
  return el.classList.contains('ituStation')
    ? el.querySelector(':scope > .ituStationTip')
    : el.querySelector(':scope > .ituTip');
}

function setAria(el, open) {
  // The i button lives inside one of the row's terms, but any term of the
  // row can toggle it -> resolve through the legend row instead of `:scope`.
  const row = el.closest('.legendRow');
  const btn = row ? row.querySelector('.ituInfo') : null;
  if (btn) btn.setAttribute('aria-expanded', open ? 'true' : 'false');
}

// Measure once, reuse forever: the definition cards never change content, so
// repeated shows never read offsetWidth/offsetHeight again.
function measure(tip) {
  let sz = sizeCache.get(tip);
  if (!sz) {
    sz = { w: tip.offsetWidth, h: tip.offsetHeight };
    if (sz.w > 0 && sz.h > 0) sizeCache.set(tip, sz);
  }
  return sz;
}

function clampLeft(left, w, vw) {
  left = Math.min(Math.max(TIP_MARGIN, left), vw - w - TIP_MARGIN);
  return left < TIP_MARGIN ? TIP_MARGIN : left;
}

// Single card: below the element, flipping above when the viewport bottom is
// short (legend rows sit at the bottom of the panel). Nested Station cards
// prefer ABOVE the word (an overlay on top of the outer card).
function anchor(el) {
  const tip = tipOf(el);
  if (!tip) return;
  const above = el.classList.contains('ituStation');
  const sz = measure(tip);
  const r = el.getBoundingClientRect();
  const vw = window.innerWidth;
  const vh = window.innerHeight;
  const left = clampLeft(r.left, sz.w, vw);
  let top;
  if (above) {
    top = r.top - TIP_GAP - sz.h;
    if (top < TIP_MARGIN) top = r.bottom + TIP_GAP;
  } else {
    top = r.bottom + TIP_GAP;
    if (top + sz.h > vh - TIP_MARGIN) {
      const over = r.top - TIP_GAP - sz.h;
      top = over >= TIP_MARGIN ? over : vh - sz.h - TIP_MARGIN;
    }
  }
  if (top < TIP_MARGIN) top = TIP_MARGIN;
  tip.style.left = left + 'px';
  tip.style.top = top + 'px';
}

function show(el) {
  const tip = tipOf(el);
  if (!tip) return;
  // NO ancestor suppression: the filing words are now SIBLING terms (each
  // owns its own card), and the nested "Station" card must be ADDITIVE -
  // hovering it used to close its primary card, collapsing the word's rect
  // to 0,0 and throwing the secondary card into the viewport corner.
  el.classList.add('ituOpen');
  openEls.add(el);
  setAria(el, true);
  anchor(el);
}

// BOTH cards pinned from a legend i button: the row's own definition card
// first (anchored under the row), the second card stacked beneath it. The
// pair is clamped as one unit so it always fits inside the viewport.
function showStacked(anchorEl, secondEl) {
  const firstTip = tipOf(anchorEl);
  if (!firstTip) return;
  const secondTip = secondEl && secondEl !== anchorEl ? tipOf(secondEl) : null;
  if (!secondTip) {
    // Only one real card -> behave like a single pin.
    show(anchorEl);
    return;
  }
  anchorEl.classList.add('ituOpen');
  openEls.add(anchorEl);
  setAria(anchorEl, true);
  secondEl.classList.add('ituOpen');
  openEls.add(secondEl);
  const so = measure(firstTip);
  const si = measure(secondTip);
  const r = anchorEl.getBoundingClientRect();
  const vw = window.innerWidth;
  const vh = window.innerHeight;
  const left = clampLeft(r.left, Math.max(so.w, si.w), vw);
  const stackH = so.h + TIP_GAP + si.h;
  let top = r.bottom + TIP_GAP;
  if (top + stackH > vh - TIP_MARGIN) {
    const above = r.top - TIP_GAP - stackH;
    top = above >= TIP_MARGIN ? above : vh - TIP_MARGIN - stackH;
  }
  if (top < TIP_MARGIN) top = TIP_MARGIN;
  firstTip.style.left = left + 'px';
  firstTip.style.top = top + 'px';
  let top2 = top + so.h + TIP_GAP;
  const maxTop2 = vh - TIP_MARGIN - si.h;
  if (top2 > maxTop2) top2 = Math.max(TIP_MARGIN, maxTop2);
  secondTip.style.left = left + 'px';
  secondTip.style.top = top2 + 'px';
}

function hide(el) {
  el.classList.remove('ituOpen');
  openEls.delete(el);
  setAria(el, false);
  const tip = tipOf(el);
  if (tip) {
    tip.style.left = '';
    tip.style.top = '';
  }
}

function closeAll() {
  for (const el of [...openEls]) hide(el);
  pinned = null;
  pinnedInner = null;
  pinMode = null;
}

// Any open card that does not belong to the pointer's current position is a
// leftover (e.g. its hide timer was cancelled by entering something else) ->
// close it. Iterates the small open Set, never the DOM.
function hideStale(except) {
  for (const el of [...openEls]) {
    if (except.some((x) => x && (x === el || x.contains(el) || el.contains(x)))) continue;
    hide(el);
  }
}

// Reveal what should be visible for the element the pointer/focus just
// entered: pinned state wins (stacks re-show as a pair, a sub-pinned Station
// unit re-shows primary + Station together), otherwise show only that
// element's own card.
function reveal(el) {
  if (!pinned) {
    show(el);
    return;
  }
  if (el !== pinned && el !== pinnedInner) return; // a pinned card wins
  if (pinMode === 'stack') {
    showStacked(pinned, pinnedInner);
    return;
  }
  if (pinMode === 'sub') {
    show(pinned); // primary card first (the Station word lives inside it)
    if (pinnedInner) show(pinnedInner);
    return;
  }
  if (el === pinned) show(pinned);
}

// Click a term's text: pin just that card.
function togglePin(el) {
  if (pinned === el && !pinnedInner) {
    closeAll();
    return;
  }
  closeAll();
  pinned = el;
  pinnedInner = null;
  pinMode = null;
  show(el);
}

// Click the nested "Station" word: pin the primary card AND the Station card
// together - the word lives inside the primary card, so the Station card
// cannot stay open on its own (its anchor would collapse with the card).
function togglePinSub(stationEl) {
  const primary = stationEl.closest('.ituTerm');
  if (!primary) {
    togglePin(stationEl);
    return;
  }
  if (pinned === primary && pinnedInner === stationEl && pinMode === 'sub') {
    closeAll();
    return;
  }
  closeAll();
  pinned = primary;
  pinnedInner = stationEl;
  pinMode = 'sub';
  show(primary);
  show(stationEl);
}

// Click a legend i button: pin BOTH definitions of that row, stacked.
function toggleStack(anchorEl, secondEl) {
  if (pinned === anchorEl && pinnedInner === secondEl && pinMode === 'stack') {
    closeAll();
    return;
  }
  closeAll();
  pinned = anchorEl;
  pinnedInner = secondEl;
  pinMode = 'stack';
  showStacked(anchorEl, secondEl);
}

export function setupItuDefinitions() {
  document.querySelectorAll('.ituTerm, .ituStation').forEach((el) => {
    const isStation = el.classList.contains('ituStation');
    const tip = tipOf(el);
    // Reaching the card itself cancels a pending hide (gap-crossing safety).
    if (tip) tip.addEventListener('mouseenter', () => clearTimeout(leaveTimer));

    el.addEventListener('mouseenter', () => {
      clearTimeout(leaveTimer);
      // Keep the hovered element's ANCESTOR cards open: the nested Station
      // word lives inside its primary card, and hiding that card would
      // collapse the word's rect to 0,0 (the secondary-card bug).
      const keep = [el, pinned, pinnedInner];
      let a = el.parentElement ? el.parentElement.closest('.ituTerm, .ituStation') : null;
      while (a) {
        keep.push(a);
        a = a.parentElement ? a.parentElement.closest('.ituTerm, .ituStation') : null;
      }
      hideStale(keep);
      reveal(el);
    });

    el.addEventListener('mouseleave', () => {
      if (pinned === el || pinnedInner === el) return;
      clearTimeout(leaveTimer);
      // Delayed hide bridges the gap between the term and its card (and the
      // corridor above the word leading to a nested card): the pointer gets
      // LEAVE_DELAY_MS to reach the card before anything closes, and the
      // card's own mouseenter cancels the timer. Once it fires we hide, then
      // hand the tip to any ANCESTOR term the pointer is now over (e.g. back
      // from the filing word onto the row text).
      leaveTimer = setTimeout(() => {
        if (el.matches(':hover')) return;
        const t = tipOf(el);
        if (t && t.matches(':hover')) return;
        hide(el);
        let p = el.parentElement ? el.parentElement.closest('.ituTerm, .ituStation') : null;
        while (p) {
          if (pinned === p || p.matches(':hover')) {
            show(p);
            return;
          }
          p = p.parentElement ? p.parentElement.closest('.ituTerm, .ituStation') : null;
        }
      }, LEAVE_DELAY_MS);
    });

    el.addEventListener('focusin', () => {
      clearTimeout(leaveTimer);
      reveal(el);
    });
    el.addEventListener('focusout', () => {
      if (pinned === el || pinnedInner === el) return;
      if (!el.matches(':hover')) hide(el);
    });

    el.addEventListener('click', (e) => {
      if (e.target.closest('a')) return; // source links must navigate
      e.preventDefault(); // also stops a label opening its <select>
      if (isStation) {
        e.stopPropagation(); // don't let the document handler close it
        togglePinSub(el);
        return;
      }
      const iBtn = e.target.closest('.ituInfo');
      if (iBtn) {
        // Legend i button -> BOTH definitions of the row, stacked. The row's
        // FIRST term anchors the pair (filing word / Earth term), whichever
        // term the button happens to live in.
        const row = el.closest('.legendRow');
        const terms = row ? [...row.querySelectorAll('.ituTerm')] : [];
        const first = terms[0] || el;
        const second = terms[1] || first.querySelector('.ituStation');
        toggleStack(first, second || first);
        return;
      }
      togglePin(el);
    });
  });

  // Esc / outside click: drop the pin and close everything.
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') closeAll();
  });
  document.addEventListener('click', (e) => {
    if (e.target.closest && e.target.closest('.ituTerm, .ituStation')) return;
    closeAll();
  });

  // Fixed-position coords go stale when anything scrolls or resizes. Hides
  // the cards but KEEPS the pin, so a pinned card returns on re-hover.
  // Iterates the open Set (a handful of elements), never the DOM.
  const reflow = () => {
    for (const el of [...openEls]) hide(el);
  };
  window.addEventListener('scroll', reflow, true);
  window.addEventListener('resize', reflow);
}
