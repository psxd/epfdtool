// Comment system: yellow add-comment button + server-checked login gate,
// click-to-place comment cards, Supabase threads (view_comments — schema in
// ./supabase.txt), shareable ?view=..&filters=..&comment=.. URLs and Slack
// notifications. Supabase keys arrive from the Netlify function at runtime
// (nothing secret lives in this public repo); rows go straight into Supabase
// from the browser via the supabase-js client; Slack goes through the
// token-protected Netlify function.
//
// Flow: yellow button -> login (Netlify function action: login) ->
// "add mode" (old cards hidden, ?comment= stripped) -> click anywhere on the
// globe -> composer -> Save -> insert row -> pushState the shareable URL ->
// copy it to the clipboard + toast -> Slack -> render the card focused.
// Reply logs in if needed and appends with parent_id = root id, so the shared
// comment URL always opens the whole updated thread.
import { store } from './state.js';
import { applyFilters } from './gsoFilters.js';
import { focusCameraOn } from './globe.js';
import { getSupabaseConfig, verifyLogin, sendSlackNotification } from './commentConfig.js';
import {
  UUID_RE, clamp, round, escapeHtml, truncate, formatTime,
  parseView, parseFilters, buildQuery, makeViewHash, parseViewHash,
} from './commentUrl.js';

// ---------- module state ----------
let client = null;
let currentUser = null;   // set by the local login gate; becomes the comment author
let addMode = false;
let composerEl = null;
let loginSuccessCb = null;
let prevUrl = '';
let activeThread = null;  // { root, replies } — restored when add mode cancels
let toastTimer = 0;
let wired = false;
const threadCache = new Map();

const $ = (id) => document.getElementById(id);

// ---------- feedback ----------
function toast(message) {
  const el = $('commentToast');
  if (!el) return;
  el.textContent = String(message ?? ''); // textContent = XSS-safe by construction
  el.style.display = 'block';
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { el.style.display = 'none'; }, 5000);
}

function showErr(el, message) {
  if (el) { el.textContent = String(message ?? ''); el.style.display = 'block'; }
}

function hideErr(el) {
  if (el) { el.textContent = ''; el.style.display = 'none'; }
}

// ---------- view + filter state <-> URL ----------
function captureViewState() {
  let pov = { lat: 20, lng: 0, altitude: 2.2 };
  try {
    if (store.world && typeof store.world.pointOfView === 'function') pov = store.world.pointOfView() || pov;
  } catch { /* globe not ready yet: fall back to the default view */ }
  return {
    view: { lat: round(pov.lat, 4), lng: round(pov.lng, 4), altitude: round(pov.altitude, 4) },
    filters: {
      status: ($('filterStatus') || {}).value || 'all',
      sat: ($('filterSatCountry') || {}).value || 'all',
      gs: ($('filterGsCountry') || {}).value || 'all',
    },
  };
}

/** Only accept filter values that actually exist in the populated <select>. */
function normalizeFilter(selectId, value) {
  const sel = $(selectId);
  if (!sel || typeof value !== 'string') return 'all';
  for (const opt of sel.options) if (opt.value === value) return value;
  return 'all';
}

function applyViewAndFilters(view, filters) {
  try {
    if (filters) {
      const s = $('filterStatus');
      const sc = $('filterSatCountry');
      const gc = $('filterGsCountry');
      if (s) s.value = normalizeFilter('filterStatus', filters.status);
      if (sc) sc.value = normalizeFilter('filterSatCountry', filters.sat);
      if (gc) gc.value = normalizeFilter('filterGsCountry', filters.gs);
      applyFilters(false);
    }
    if (view && store.world) focusCameraOn(view.lat, view.lng, view.altitude);
  } catch (err) {
    console.warn('Could not apply URL view/filters:', err);
  }
}

function readUrlState() {
  if (typeof window === 'undefined' || !window.location) return { view: null, filters: null, commentId: '' };
  const p = new URLSearchParams(window.location.search || '');
  const raw = (p.get('comment') || '').trim();
  return {
    view: parseView(p.get('view')),
    filters: parseFilters(p.get('filters')),
    commentId: UUID_RE.test(raw) ? raw : '',
  };
}

/** path + relative query tail: portable between localhost and GitHub Pages. */
function setUrl(view, filters, commentId, replace = false) {
  if (typeof window === 'undefined' || !window.history) return;
  try {
    const qs = buildQuery(view, filters, commentId);
    const url = `${window.location.pathname}${qs ? `?${qs}` : ''}`;
    if (replace && window.history.replaceState) window.history.replaceState({}, '', url);
    else if (window.history.pushState) window.history.pushState({}, '', url);
  } catch (err) {
    console.warn('Comment URL update failed:', err);
  }
}

function shareableUrl(view, filters, commentId) {
  const qs = buildQuery(view, filters, commentId);
  const loc = window.location;
  const origin = (loc.origin && loc.origin !== 'null') ? loc.origin : loc.href.split(/[?#]/)[0];
  return `${origin}?${qs}`;
}

// ---------- Supabase + Slack + clipboard ----------
let configPromise = null;

/** Fetch Supabase config from the Netlify function once; cached + retryable. */
function loadSupabaseConfig() {
  if (!configPromise) {
    configPromise = getSupabaseConfig().then((cfg) => {
      if (!cfg || !cfg.SUPABASE_URL || !cfg.SUPABASE_ANON_KEY) {
        throw new Error('Netlify function returned no Supabase config — check SUPABASE_URL / SUPABASE_ANON_KEY env vars in Netlify.');
      }
      // Common paste mistake: URL and anon key swapped in the Netlify env vars.
      if (!/^https?:\/\//i.test(cfg.SUPABASE_URL)) {
        throw new Error('SUPABASE_URL must start with https:// — it looks like the URL and anon key are swapped in the Netlify env vars.');
      }
      if (/^https?:\/\//i.test(cfg.SUPABASE_ANON_KEY)) {
        throw new Error('SUPABASE_ANON_KEY looks like a URL — the URL and anon key are swapped in the Netlify env vars.');
      }
      return cfg;
    }).catch((err) => {
      configPromise = null; // allow a retry on the next attempt
      throw new Error(`Could not fetch Supabase config from the Netlify function: ${err.message || err}`);
    });
  }
  return configPromise;
}

async function ensureClient() {
  if (client) return client;
  const { SUPABASE_URL, SUPABASE_ANON_KEY } = await loadSupabaseConfig();
  if (typeof window === 'undefined' || !window.supabase || typeof window.supabase.createClient !== 'function') {
    throw new Error('Supabase JS client failed to load — check the CDN <script> in index.html.');
  }
  try {
    client = window.supabase.createClient(SUPABASE_URL, SUPABASE_ANON_KEY);
  } catch (err) {
    console.error('Supabase createClient failed:', err);
    throw new Error(`Supabase client failed to start: ${err && err.message ? err.message : err}.`);
  }
  return client;
}

/** Fire-and-forget via the Netlify function (auth token from the login gate). */
function notifySlack(text) {
  sendSlackNotification(text).catch((err) => console.warn('Slack notification failed:', err));
}

async function copyToClipboard(text) {
  try {
    if (navigator.clipboard && navigator.clipboard.writeText) {
      await navigator.clipboard.writeText(text);
      return true;
    }
  } catch { /* fall through to the legacy path */ }
  try {
    const ta = document.createElement('textarea');
    ta.value = text;
    ta.setAttribute('readonly', '');
    ta.style.position = 'fixed';
    ta.style.opacity = '0';
    document.body.appendChild(ta);
    ta.select();
    const ok = document.execCommand('copy');
    ta.remove();
    return ok;
  } catch {
    return false;
  }
}

// ---------- local login gate ----------
function openLoginModal(onSuccess) {
  const bd = $('commentModalBackdrop');
  if (!bd) return;
  loginSuccessCb = typeof onSuccess === 'function' ? onSuccess : null;
  hideErr($('commentLoginError'));
  const passEl = $('commentPassword');
  if (passEl) passEl.value = '';
  bd.style.display = 'flex';
  const userEl = $('commentUsername');
  if (userEl) userEl.focus();
}

function closeLoginModal() {
  const bd = $('commentModalBackdrop');
  if (bd) bd.style.display = 'none';
  loginSuccessCb = null;
  const passEl = $('commentPassword');
  if (passEl) passEl.value = '';
}

async function attemptLogin() {
  const nameEl = $('commentUsername');
  const passEl = $('commentPassword');
  const errEl = $('commentLoginError');
  const name = nameEl ? nameEl.value.trim() : '';
  const pass = passEl ? passEl.value : '';
  const fail = (msg) => { showErr(errEl, msg); if (passEl) passEl.value = ''; };
  if (!name || !pass) { fail('Enter both username and password.'); return; }
  const loginBtn = $('commentLoginBtn');
  if (loginBtn) loginBtn.disabled = true;
  let ok = false;
  try {
    ok = await verifyLogin(name, pass);
  } catch (err) {
    console.error('Login failed:', err);
    fail('Login failed — check your connection and try again.');
    if (loginBtn) loginBtn.disabled = false;
    return;
  }
  if (loginBtn) loginBtn.disabled = false;
  if (!ok) { fail('Invalid username or password.'); return; }
  currentUser = name;
  const cb = loginSuccessCb;
  loginSuccessCb = null;
  closeLoginModal();
  const listBtn = $('myCommentsBtn');
  if (listBtn) listBtn.style.display = 'flex';
  toast(`Signed in as ${currentUser}`);
  if (cb) cb();
}

function requireAuth(cb) {
  if (currentUser) cb();
  else openLoginModal(cb);
}

// ---------- add mode (yellow button -> click the globe) ----------
function startAddMode() {
  const begin = async () => {
    if (addMode) return;
    try {
      await ensureClient();
    } catch (err) {
      console.error('Comment add-mode failed:', err);
      toast(err.message);
      return;
    }
    const panel = $('myCommentsPanel');
    if (panel) panel.style.display = 'none';
    prevUrl = `${window.location.pathname}${window.location.search}`;
    const layer = $('commentLayer');
    if (layer) { layer.innerHTML = ''; layer.style.display = 'none'; }
    addMode = true;
    document.body.classList.add('comment-add-mode');
    const hint = $('commentHint');
    if (hint) hint.style.display = 'block';
    // Drop ?comment= so the URL reflects the view being commented on now.
    const { view, filters } = captureViewState();
    setUrl(view, filters, null, true);
  };
  requireAuth(begin);
}

function endAddMode({ restore = false } = {}) {
  addMode = false;
  document.body.classList.remove('comment-add-mode');
  const hint = $('commentHint');
  if (hint) hint.style.display = 'none';
  if (restore) {
    try {
      if (prevUrl && typeof window !== 'undefined' && window.history && window.history.replaceState) {
        window.history.replaceState({}, '', prevUrl);
      }
    } catch (err) {
      console.warn(err);
    }
    if (activeThread) renderThread(activeThread.root, activeThread.replies, { focus: false });
    else {
      const layer = $('commentLayer');
      if (layer) { layer.innerHTML = ''; layer.style.display = 'none'; }
    }
  }
  prevUrl = '';
}

// ---------- composer ----------
function positionCard(el, xPct, yPct) {
  const pad = 10;
  const vw = window.innerWidth;
  const vh = window.innerHeight;
  const w = el.offsetWidth || 306;
  const h = el.offsetHeight || 160;
  el.style.left = `${clamp((xPct / 100) * vw, pad, Math.max(pad, vw - w - pad))}px`;
  el.style.top = `${clamp((yPct / 100) * vh, pad, Math.max(pad, vh - h - pad))}px`;
}

function removeComposer() {
  if (composerEl) { composerEl.remove(); composerEl = null; }
}

function openComposer(xPct, yPct) {
  removeComposer();
  const anchor = { x: clamp(round(xPct, 2), 2, 98), y: clamp(round(yPct, 2), 2, 96) };
  const el = document.createElement('div');
  el.className = 'commentCard commentComposer';
  el.dataset.x = String(anchor.x);
  el.dataset.y = String(anchor.y);
  el.innerHTML = `
    <div class="commentCardHeader">
      <span class="commentAuthor">${escapeHtml(currentUser || 'Commenter')}</span>
      <span class="commentTime">New comment</span>
    </div>
    <textarea class="commentTextarea" maxlength="2000" placeholder="Write your comment..."></textarea>
    <div class="commentComposerError" style="display:none;"></div>
    <div class="commentComposerActions">
      <button type="button" class="commentBtnSecondary" data-action="cancel">Cancel</button>
      <button type="button" class="commentBtnYellow" data-action="save">Save</button>
    </div>`;
  document.body.appendChild(el);
  composerEl = el;
  positionCard(el, anchor.x, anchor.y);
  el.querySelector('[data-action="cancel"]').addEventListener('click', () => {
    removeComposer();
    endAddMode({ restore: true });
  });
  el.querySelector('[data-action="save"]').addEventListener('click', saveNewComment);
  const ta = el.querySelector('.commentTextarea');
  if (ta) ta.focus();
}

// ---------- save a new comment -> Supabase -> shareable URL ----------
async function saveNewComment() {
  const el = composerEl;
  if (!el) return;
  const ta = el.querySelector('.commentTextarea');
  const errEl = el.querySelector('.commentComposerError');
  const btn = el.querySelector('[data-action="save"]');
  const text = (ta ? ta.value : '').trim();
  if (!text) { showErr(errEl, 'Write something before saving.'); return; }
  hideErr(errEl);
  if (btn) btn.disabled = true;
  try {
    const db = await ensureClient();
    const anchor = {
      x: clamp(round(Number(el.dataset.x), 2), 2, 98),
      y: clamp(round(Number(el.dataset.y), 2), 2, 96),
    };
    const { view, filters } = captureViewState();
    const hash = makeViewHash(view, filters, anchor);
    const { data, error } = await db
      .from('view_comments')
      .insert({ view_hash: hash, author: currentUser, comment_text: text, parent_id: null })
      .select('id')
      .single();
    if (error) throw error;
    const id = data && data.id;
    if (!id) throw new Error('Supabase did not return the new comment id.');
    const url = shareableUrl(view, filters, id);
    removeComposer();
    endAddMode({ restore: false });
    setUrl(view, filters, id, false);
    const copied = await copyToClipboard(url);
    toast(copied
      ? 'Comment saved — shareable link copied to your clipboard.'
      : `Comment saved — copy this link: ${url}`);
    notifySlack(`*New EPFD comment by ${currentUser}*\n>${text.replace(/\n/g, '\n>')}\n${url}`);
    const root = { id, author: currentUser, comment_text: text, view_hash: hash, created_at: new Date().toISOString(), parent_id: null };
    renderThread(root, [], { focus: true });
  } catch (err) {
    console.error('Comment save failed:', err);
    showErr(errEl, `Save failed: ${err.message || err}`);
    if (btn) btn.disabled = false;
  }
}

// ---------- Supabase reads ----------
async function fetchCommentRow(id, db) {
  const { data, error } = await db.from('view_comments').select('*').eq('id', id).maybeSingle();
  if (error) throw error;
  let row = data || null;
  let guard = 0;
  // Climb parent_id until we hit the thread root, so a reply URL opens the
  // whole thread (replies always have parent_id = root comment id).
  while (row && row.parent_id && guard < 5) {
    guard += 1;
    const { data: parent, error: perr } = await db.from('view_comments').select('*').eq('id', row.parent_id).maybeSingle();
    if (perr) throw perr;
    if (!parent) break;
    row = parent;
  }
  return row;
}

async function fetchReplies(rootId, db) {
  const { data, error } = await db
    .from('view_comments')
    .select('*')
    .eq('parent_id', rootId)
    .order('created_at', { ascending: true });
  if (error) throw error;
  return data || [];
}

async function fetchThread(commentId) {
  const db = await ensureClient();
  const root = await fetchCommentRow(commentId, db);
  if (!root) throw new Error('Comment not found.');
  const replies = await fetchReplies(root.id, db);
  threadCache.set(root.id, root);
  return { root, replies };
}

// ---------- render one thread (root card + replies) ----------
function renderThread(root, replies, { focus = false } = {}) {
  const layer = $('commentLayer');
  if (!layer || !root) return;
  activeThread = { root, replies };
  layer.innerHTML = '';
  layer.style.display = 'block';
  const meta = parseViewHash(root.view_hash);
  const anchor = {
    x: Number.isFinite(Number(meta.x)) && Number(meta.x) ? Number(meta.x) : 62,
    y: Number.isFinite(Number(meta.y)) && Number(meta.y) ? Number(meta.y) : 14,
  };
  const card = document.createElement('div');
  card.className = `commentCard${focus ? ' commentCardFocused' : ''}`;
  card.dataset.x = String(anchor.x);
  card.dataset.y = String(anchor.y);
  card.tabIndex = 0;
  const replyHtml = replies.map((r) => `
    <div class="commentReply">
      <div class="commentCardHeader">
        <span class="commentAuthor">${escapeHtml(r.author)}</span>
        <span class="commentTime">${escapeHtml(formatTime(r.created_at))}</span>
      </div>
      <div class="commentText">${escapeHtml(r.comment_text)}</div>
    </div>`).join('');
  card.innerHTML = `
    <div class="commentCardHeader">
      <span class="commentAuthor">${escapeHtml(root.author)}</span>
      <span class="commentTime commentTimeBlock">${escapeHtml(formatTime(root.created_at))}</span>
    </div>
    <div class="commentText">${escapeHtml(root.comment_text)}</div>
    <div class="commentCardActions">
      <button type="button" class="commentBtnYellow commentBtnTiny" data-action="reply">↩ Reply</button>
      <span class="commentThreadCount">${replies.length ? `${replies.length} ${replies.length === 1 ? 'reply' : 'replies'}` : 'No replies yet'}</span>
    </div>
    <div class="commentReplyList" style="${replies.length ? '' : 'display:none;'}">${replyHtml}</div>`;
  layer.appendChild(card);
  positionCard(card, anchor.x, anchor.y);
  card.querySelector('[data-action="reply"]').addEventListener('click', () => {
    openReplyComposer(card, root);
  });
  threadCache.set(root.id, root);
}

// ---------- inline reply composer (one per card) ----------
function openReplyComposer(card, root) {
  requireAuth(() => {
    let box = card.querySelector('.commentReplyComposer');
    if (box) { const t = box.querySelector('.commentTextarea'); if (t) t.focus(); return; }
    box = document.createElement('div');
    box.className = 'commentReplyComposer';
    box.innerHTML = `
      <div class="commentComposerActions" style="margin-top:0; justify-content:space-between;">
        <span class="commentThreadCount">Replying as ${escapeHtml(currentUser || '')}</span>
        <span style="display:flex; gap:8px;">
          <button type="button" class="commentBtnSecondary commentBtnTiny" data-action="rcancel">Cancel</button>
          <button type="button" class="commentBtnYellow commentBtnTiny" data-action="rsave">Reply</button>
        </span>
      </div>
      <textarea class="commentTextarea" maxlength="2000" placeholder="Write your reply..."></textarea>
      <div class="commentComposerError" style="display:none;"></div>`;
    card.appendChild(box);
    positionCard(card, Number(card.dataset.x) || 62, Number(card.dataset.y) || 14);
    box.querySelector('[data-action="rcancel"]').addEventListener('click', () => {
      box.remove();
      positionCard(card, Number(card.dataset.x) || 62, Number(card.dataset.y) || 14);
    });
    box.querySelector('[data-action="rsave"]').addEventListener('click', () => saveReply(box, root));
    const ta = box.querySelector('.commentTextarea');
    if (ta) ta.focus();
  });
}

async function saveReply(box, root) {
  const ta = box.querySelector('.commentTextarea');
  const errEl = box.querySelector('.commentComposerError');
  const btn = box.querySelector('[data-action="rsave"]');
  const text = (ta ? ta.value : '').trim();
  if (!text) { showErr(errEl, 'Write something before replying.'); return; }
  hideErr(errEl);
  if (btn) btn.disabled = true;
  try {
    const db = await ensureClient();
    const { error } = await db
      .from('view_comments')
      .insert({ view_hash: root.view_hash, author: currentUser, comment_text: text, parent_id: root.id });
    if (error) throw error;
    const replies = await fetchReplies(root.id, db);
    const meta = parseViewHash(root.view_hash);
    const view = (typeof meta.view === 'string' && parseView(meta.view)) || null;
    const filters = (typeof meta.filters === 'string' && parseFilters(meta.filters)) || null;
    const url = shareableUrl(view || captureViewState().view, filters || captureViewState().filters, root.id);
    toast('Reply posted.');
    notifySlack(`*Reply by ${currentUser} on ${root.author}'s comment*\n>${text.replace(/\n/g, '\n>')}\n${url}`);
    renderThread(root, replies, { focus: true });
  } catch (err) {
    console.error('Reply save failed:', err);
    showErr(errEl, `Reply failed: ${err.message || err}`);
    if (btn) btn.disabled = false;
  }
}

// ---------- "My comments" panel ----------
async function openMyComments() {
  const panel = $('myCommentsPanel');
  if (!panel) return;
  if (!currentUser) {
    openLoginModal(() => { openMyComments().catch((err) => console.error(err)); });
    return;
  }
  panel.style.display = 'block';
  const statusEl = $('myCommentsStatus');
  const listEl = $('myCommentsList');
  if (statusEl) {
    statusEl.style.display = 'block';
    statusEl.classList.remove('commentError');
    statusEl.textContent = 'Loading your comments…';
  }
  if (listEl) listEl.innerHTML = '';
  try {
    const db = await ensureClient();
    const { data, error } = await db
      .from('view_comments')
      .select('*')
      .eq('author', currentUser)
      .order('created_at', { ascending: false });
    if (error) throw error;
    const rows = data || [];
    if (!rows.length) {
      if (statusEl) statusEl.textContent = 'No comments yet.';
      return;
    }
    if (statusEl) statusEl.style.display = 'none';
    if (listEl) {
      listEl.innerHTML = rows.map((r) => {
        const isReply = Boolean(r.parent_id);
        const target = (r.parent_id && UUID_RE.test(String(r.parent_id)) && r.parent_id)
          || (UUID_RE.test(String(r.id)) && r.id)
          || '';
        return `
          <button type="button" class="myCommentItem" data-id="${escapeHtml(String(target))}" ${target ? '' : 'disabled'}>
            <span class="myCommentMeta">
              <span class="badge${isReply ? ' badgeReply' : ''}">${isReply ? 'Reply' : 'Comment'}</span>
              <span class="myCommentTime">${escapeHtml(formatTime(r.created_at))}</span>
            </span>
            <span class="myCommentSnippet">${escapeHtml(truncate(r.comment_text, 120))}</span>
          </button>`;
      }).join('');
    }
  } catch (err) {
    if (statusEl) {
      statusEl.style.display = 'block';
      statusEl.classList.add('commentError');
      statusEl.textContent = `Could not load comments: ${err.message || err}`;
    }
    console.error('My comments load failed:', err);
  }
}

/** Open a comment by id: apply its stored view + filters, pushState, render. */
async function openCommentById(id) {
  if (addMode) {
    removeComposer();
    endAddMode({ restore: false });
  }
  const { root, replies } = await fetchThread(id);
  const meta = parseViewHash(root.view_hash);
  const cap = captureViewState();
  const view = (typeof meta.view === 'string' && parseView(meta.view)) || cap.view;
  const filters = (typeof meta.filters === 'string' && parseFilters(meta.filters)) || cap.filters;
  applyViewAndFilters(view, filters);
  setUrl(view, filters, root.id, false);
  renderThread(root, replies, { focus: true });
}

// ---------- boot from a shared URL ----------
function waitForData(timeoutMs = 20000) {
  return new Promise((resolve) => {
    const t0 = Date.now();
    const tick = () => {
      const satSel = $('filterSatCountry');
      const ready = Boolean(store.world)
        && store.searchIndex.length > 0
        && satSel && satSel.options && satSel.options.length > 0;
      if (ready) resolve(true);
      else if (Date.now() - t0 > timeoutMs) resolve(false);
      else setTimeout(tick, 60);
    };
    tick();
  });
}

async function bootFromUrl() {
  const st = readUrlState();
  const ready = await waitForData();
  if (!ready) {
    console.warn('Comment system: dataset never became ready; skipping URL restore.');
    return;
  }
  let { view, filters } = st;
  let thread = null;
  if (st.commentId) {
    try {
      thread = await fetchThread(st.commentId);
      const meta = parseViewHash(thread.root.view_hash);
      // URL params win; otherwise fall back to what the comment stored.
      if (!view && typeof meta.view === 'string') view = parseView(meta.view);
      if (!filters && typeof meta.filters === 'string') filters = parseFilters(meta.filters);
    } catch (err) {
      console.error('Comment load failed:', err);
      toast(`Could not load comment: ${err.message || err}`);
    }
  }
  applyViewAndFilters(view, filters);
  if (thread) renderThread(thread.root, thread.replies, { focus: false });
}

// ---------- wiring ----------
function repositionCards() {
  document.querySelectorAll('#commentLayer .commentCard').forEach((card) => {
    positionCard(card, Number(card.dataset.x) || 62, Number(card.dataset.y) || 14);
  });
  if (composerEl) positionCard(composerEl, Number(composerEl.dataset.x) || 60, Number(composerEl.dataset.y) || 14);
}

function wireControls() {
  if (wired) return;
  wired = true;

  const addBtn = $('addCommentBtn');
  if (addBtn) addBtn.addEventListener('click', () => {
    try { startAddMode(); } catch (err) { console.error(err); toast(err.message); }
  });

  const listBtn = $('myCommentsBtn');
  if (listBtn) listBtn.addEventListener('click', () => {
    openMyComments().catch((err) => { console.error(err); toast(`Could not load comments: ${err.message || err}`); });
  });

  const listClose = $('myCommentsClose');
  if (listClose) listClose.addEventListener('click', () => {
    const p = $('myCommentsPanel');
    if (p) p.style.display = 'none';
  });

  const loginBtn = $('commentLoginBtn');
  if (loginBtn) loginBtn.addEventListener('click', attemptLogin);
  const cancelBtn = $('commentCancelBtn');
  if (cancelBtn) cancelBtn.addEventListener('click', closeLoginModal);
  for (const id of ['commentUsername', 'commentPassword']) {
    const el = $(id);
    if (el) el.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') { e.preventDefault(); attemptLogin(); }
    });
  }
  const backdrop = $('commentModalBackdrop');
  if (backdrop) backdrop.addEventListener('click', (e) => {
    if (e.target === backdrop) closeLoginModal();
  });

  const listEl = $('myCommentsList');
  if (listEl) listEl.addEventListener('click', (e) => {
    const item = e.target && e.target.closest ? e.target.closest('.myCommentItem') : null;
    if (!item) return;
    const id = item.getAttribute('data-id') || '';
    if (!UUID_RE.test(id)) return;
    const panel = $('myCommentsPanel');
    if (panel) panel.style.display = 'none';
    openCommentById(id).catch((err) => {
      console.error(err);
      toast(`Could not open comment: ${err.message || err}`);
    });
  });

  // Placement: a click (not a globe drag) on anything that isn't a UI surface.
  let pointerDownAt = null;
  document.addEventListener('pointerdown', (e) => {
    pointerDownAt = { x: e.clientX, y: e.clientY };
  }, true);
  document.addEventListener('click', (e) => {
    if (!addMode || composerEl) return;
    const t = e.target;
    if (!t || typeof t.closest !== 'function') return;
    if (t.closest('#ui, #cameraControls, .commentModalBackdrop, .myCommentsPanel, .commentCard, .commentHint, #gtLogo')) return;
    if (pointerDownAt && Math.hypot(e.clientX - pointerDownAt.x, e.clientY - pointerDownAt.y) > 6) return;
    const x = (e.clientX / Math.max(1, window.innerWidth)) * 100;
    const y = (e.clientY / Math.max(1, window.innerHeight)) * 100;
    openComposer(x, y);
  }, true);

  document.addEventListener('keydown', (e) => {
    if (e.key !== 'Escape') return;
    const bd = $('commentModalBackdrop');
    if (bd && bd.style.display === 'flex') { closeLoginModal(); return; }
    if (composerEl) { removeComposer(); endAddMode({ restore: true }); return; }
    if (addMode) { endAddMode({ restore: true }); return; }
    const panel = $('myCommentsPanel');
    if (panel && panel.style.display === 'block') panel.style.display = 'none';
  });

  window.addEventListener('resize', repositionCards);

  window.addEventListener('popstate', () => {
    if (addMode || composerEl) return;
    const st = readUrlState();
    applyViewAndFilters(st.view, st.filters);
    if (st.commentId) {
      fetchThread(st.commentId)
        .then(({ root, replies }) => renderThread(root, replies, { focus: false }))
        .catch((err) => console.warn('Comment restore failed:', err));
    } else {
      activeThread = null;
      const layer = $('commentLayer');
      if (layer) { layer.innerHTML = ''; layer.style.display = 'none'; }
    }
  });
}

/** Entry point — called from app.js on DOMContentLoaded. */
export function initComments() {
  try {
    wireControls();
  } catch (err) {
    console.error('Comment controls failed to initialise:', err);
  }
  bootFromUrl().catch((err) => console.error('Comment URL restore failed:', err));
}








