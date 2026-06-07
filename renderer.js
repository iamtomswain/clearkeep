"use strict";

/* ───────────────────────────────────────────────────────────────────────────
   ClearKeep — renderer
   Accounts are kept SEPARATE: each account is its own inbox; folders / archive /
   trash scope to the active account. Read path is live; archive/trash/code-clear
   are local-only for now (labeled). Categories are a local heuristic placeholder
   until the Claude classifier.
─────────────────────────────────────────────────────────────────────────────*/

const api = window.clearkeep;

// Renderer-side tuning knobs (the main process has its own in lib/config.js;
// the two processes can't share a module).
const CFG = {
  pollMs: 150000,                     // important auto-classify + reminder tick cadence
  needsRefreshCheckMs: 30 * 60 * 1000, // how often to check whether Needs is stale
  needsRefreshStaleMs: 3 * 3600 * 1000, // re-scan Needs bodies if older than this
  snoozeMs: 3 * 86400000,             // "Snooze" duration (3 days)
  remindLeadDays: 1,                  // notify when a deadline is within N days
  askHistoryTurns: 4,                 // conversation turns sent to Ask
  askPriorRefTurns: 3,                // turns whose citations are carried forward
  askPriorRefCap: 8,                  // max carried citations
};

const CATEGORIES = {
  human:        { label: "Human",        color: "#22c55e" },
  newsletter:   { label: "Newsletter",   color: "#f59e0b" },
  notification: { label: "Notification", color: "#64748b" },
  transactional:{ label: "Transactional",color: "#3b82f6" },
  cold:         { label: "Cold outreach",color: "#a855f7" },
  code:         { label: "Login code",   color: "#e4e4e7" },
};

let FOLDERS = []; // loaded from main (persistent, AI-managed rules)

let accountsList = [];
let MESSAGES = [];
let state = {
  activeAccount: null,
  view: { type: "inbox" },   // inbox | folder | archive | trash
  activeId: null,
  layout: document.body.getAttribute("data-layout"),
  search: "",
  loading: false,
  foldersExpanded: false,
  sort: "status",            // status | timeline
  categoryFilter: "all",     // all | <category key>
  loadingMore: false,        // a "Load more" fetch is in flight
};
const REQUEST_PAGE = 100;  // per network request — provider-safe (Gmail caps list calls at 100)
const LOAD_CHUNK = 250;    // messages pulled per load: initial fetch and each "Load more"
// True server pagination — pages append, cursors come from the provider so we
// never miss or duplicate a message and always know if there's more.
let inboxCursors = {};        // accountId -> { cursor, hasMore }
let serverInboxUnread = {};   // accountId -> real server inbox unread count
let folderCursor = { cursor: null, hasMore: false }; // current server-folder view

// Bulk selection
let selection = new Set();   // message ids
let lastIndex = -1;          // anchor for shift-range

// List grouping: sections collapsed to the first N (per-section cap, set in
// buildSections) until "View more" is clicked.
let sectionExpanded = new Set();  // keys of sections the user expanded

// Deferred read: an opened unread message stays highlighted in the Unread
// section until you leave it; then it's marked read and falls to Read.
let pendingReadId = null;
function commitPendingRead() {
  if (!pendingReadId) return;
  const m = findMsg(pendingReadId);
  pendingReadId = null;
  if (m && m.unread) {
    m.unread = false;
    if (m.account && m.messageId) api.setRead({ accountId: m.account, messageIds: [m.messageId], read: true }).catch(() => {});
    if (importantIds.has(m.messageId)) updateAttention(); // reading an important email clears its badge weight
  }
}
let currentList = [];        // messages in current display order
let folderViewMessages = []; // server-fetched mail for Archive/Trash/Spam views
let folderViewError = null;  // e.g. missing scope for system folders
let searchViewMessages = []; // whole-mailbox "deep search" results (full screen view)
let searchViewMeta = { query: "", errors: [] };
let searchLoading = false;   // deep search in flight (show loading state in the screen view)
let searchSeq = 0;           // guards against a stale search overwriting a newer one

// Command palette state
let paletteResults = [];
let paletteActive = -1;
let paletteTimer = null;
let paletteSeq = 0;

function findMsg(id) { return MESSAGES.find((m) => m.id === id) || folderViewMessages.find((m) => m.id === id) || searchViewMessages.find((m) => m.id === id) || paletteResults.find((m) => m.id === id) || needsSourceMsgs.find((m) => m.id === id) || importantSourceMsgs.find((m) => m.id === id) || askSourceMsgs.find((m) => m.id === id); }
function groupMessageIds(ids) {
  const map = new Map();
  ids.forEach((id) => { const m = findMsg(id); if (!m) return; if (!map.has(m.account)) map.set(m.account, []); map.get(m.account).push(m.messageId); });
  return map;
}
function removeIdsLocally(ids) {
  const set = new Set(ids);
  MESSAGES = MESSAGES.filter((m) => !set.has(m.id));
  folderViewMessages = folderViewMessages.filter((m) => !set.has(m.id));
  searchViewMessages = searchViewMessages.filter((m) => !set.has(m.id));
}

// ── Helpers ─────────────────────────────────────────────────────────────────
const $ = (s) => document.querySelector(s);
const domainOf = (email) => (String(email).split("@")[1] || "").toLowerCase();
function rootDomain(email) {
  const d = domainOf(email);
  const p = d.split(".");
  return p.length >= 2 ? p.slice(-2).join(".") : d;
}
let OVERRIDES = new Set(); // "account|messageId" pinned back to inbox
function folderForMessage(m) {
  if (OVERRIDES.has(`${m.account}|${m.messageId}`)) return null;
  const addr = String(m.fromEmail).toLowerCase();
  const d = domainOf(addr);
  return FOLDERS.find((f) =>
    (f.addresses || []).includes(addr) ||
    (f.domains || []).some((dom) => d === dom || d.endsWith("." + dom))
  );
}
// Folders are per-account, so only feed the active account's senders to the AI.
function activeMessages() { return MESSAGES.filter((m) => m.account === state.activeAccount); }
function distinctSenders() {
  const seen = new Map();
  activeMessages().forEach((m) => {
    const k = String(m.fromEmail).toLowerCase();
    if (k && !seen.has(k)) seen.set(k, m.fromName && m.fromName !== m.fromEmail ? `${m.fromEmail} (${m.fromName})` : m.fromEmail);
  });
  return [...seen.values()];
}
// Distinct senders tagged with their email count — input for the AI organize sweep.
function sendersWithCounts() {
  const map = new Map();
  activeMessages().forEach((m) => {
    const k = String(m.fromEmail).toLowerCase();
    if (!k) return;
    const e = map.get(k) || { label: m.fromName && m.fromName !== m.fromEmail ? `${m.fromEmail} (${m.fromName})` : m.fromEmail, count: 0 };
    e.count++;
    map.set(k, e);
  });
  let arr = [...map.values()].sort((a, b) => b.count - a.count);
  // Drop the long tail of one-off senders (they can't reach a 3-email vendor on
  // their own) and cap the list so the AI sweep stays fast and reliable on big,
  // spammy mailboxes. Keep everything if filtering would leave too little.
  const multi = arr.filter((e) => e.count >= 2);
  if (multi.length >= 5) arr = multi;
  return arr.slice(0, 200).map((e) => `${e.label} ×${e.count}`);
}
function initials(name) {
  const s = String(name || "?").trim();
  const parts = s.split(/[\s@.]+/).filter(Boolean);
  return ((parts[0] || "?")[0] + (parts[1] ? parts[1][0] : "")).toUpperCase();
}

// Look-alike letters spammers use that NFKC normalization doesn't cover:
// small-capital and turned/reversed Latin letters → their plain equivalents.
const LOOKALIKE = {
  "ᴀ": "A", "ʙ": "B", "ᴄ": "C", "ᴅ": "D", "ᴇ": "E", "ꜰ": "F",
  "ɢ": "G", "ʜ": "H", "ɪ": "I", "ᴊ": "J", "ᴋ": "K", "ʟ": "L",
  "ᴍ": "M", "ɴ": "N", "ᴏ": "O", "ᴘ": "P", "ʀ": "R", "ꜱ": "S",
  "ᴛ": "T", "ᴜ": "U", "ᴠ": "V", "ᴡ": "W", "ʏ": "Y", "ᴢ": "Z",
  "Ǝ": "E", "ⱻ": "e", "Ɐ": "A", "ɐ": "a", "ǝ": "e", "ɹ": "r",
  "ʇ": "t", "ɔ": "c", "ʌ": "v", "ʍ": "w",
};
// Clean obfuscated sender names / subjects for DISPLAY only (raw data untouched).
// NFKC folds math-alphanumeric + fullwidth glyphs to ASCII; the table handles
// small-caps/reversed letters; then we strip zero-width junk and de-space.
// Legitimate accents (é, ñ, …) are preserved.
function cleanName(s) {
  if (!s) return s;
  let t = String(s).replace(/[​-‍⁠﻿︀-️]/g, "");
  try { t = t.normalize("NFKC"); } catch {}
  t = Array.from(t).map((c) => LOOKALIKE[c] || c).join("");
  // collapse spaced-out runs ("F i n a l" → "Final"), 4+ single chars in a row
  t = t.replace(/(?:[A-Za-z0-9] ){3,}[A-Za-z0-9]/g, (m) => m.replace(/ /g, ""));
  return t.replace(/[ \t]{2,}/g, " ").trim();
}
function acctById(id) { return accountsList.find((a) => a.id === id); }
function escapeHtml(s) {
  return String(s || "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}

// Avatar: the person's own photo (Gravatar by email) first, else the brand
// logo by domain — both fetched + validated in main — else clean colorless
// initials. Keyed by email (falling back to domain) so each identity resolves
// independently. avatarMem: key -> dataUrl(string) | null(none).
const avatarMem = new Map();
const avatarInflight = new Set();

function avatarHtml(name, email, cls) {
  const em = String(email || "").toLowerCase().trim();
  const root = rootDomain(email);
  const key = em || root;
  const init = escapeHtml(initials(name || email));
  const cached = key ? avatarMem.get(key) : null;
  const img = typeof cached === "string" ? `<img class="avatar-img" src="${cached}" alt="">` : "";
  return `<span class="avatar ${cls || ""}" data-key="${escapeHtml(key)}" data-email="${escapeHtml(em)}" data-domain="${escapeHtml(root || "")}"><span class="avatar-fallback">${init}</span>${img}</span>`;
}

function applyAvatar(key) {
  const url = avatarMem.get(key);
  if (typeof url !== "string") return;
  document.querySelectorAll('.avatar[data-key="' + CSS.escape(key) + '"]').forEach((s) => {
    if (!s.querySelector("img")) {
      const img = document.createElement("img");
      img.className = "avatar-img"; img.src = url; img.alt = "";
      s.appendChild(img);
    }
  });
}

function hydrateAvatars(scope) {
  (scope || document).querySelectorAll(".avatar[data-key]").forEach((s) => {
    const key = s.getAttribute("data-key");
    if (!key) return;
    if (typeof avatarMem.get(key) === "string") { applyAvatar(key); return; }
    if (avatarMem.has(key) || avatarInflight.has(key)) return; // known no-avatar or pending
    avatarInflight.add(key);
    api.fetchAvatar({ email: s.getAttribute("data-email") || "", domain: s.getAttribute("data-domain") || "" })
      .then((res) => { avatarMem.set(key, res && res.dataUrl ? res.dataUrl : null); avatarInflight.delete(key); applyAvatar(key); })
      .catch(() => { avatarMem.set(key, null); avatarInflight.delete(key); });
  });
}

// Lightweight category heuristic — placeholder until the Claude classifier.
function detectCode(subject) {
  if (!/(verification|one[- ]?time|security|login|sign[- ]?in|confirm|otp|passcode|2fa|code)/i.test(subject)) return null;
  const m = subject.match(/\b(\d{4,8})\b/);
  return m ? m[1] : null;
}
// Provisional category shown instantly; the Claude classifier refines it.
function classify(m) {
  const code = detectCode(m.subject);
  if (code) return { category: "code", code };
  return { category: "notification" }; // neutral default — never guess "human"
}

const categoryCache = new Map(); // messageId -> category (from the classifier)
function normalizeCat(c) {
  c = String(c || "").toLowerCase().trim();
  if (/cold|sales|recruit|outreach/.test(c)) return "cold";
  if (/code|otp|verif|one[- ]?time|passcode/.test(c)) return "code";
  if (/news|market|promo|digest|subscription/.test(c)) return "newsletter";
  if (/transac|receipt|invoice|order|confirm|welcome|trial/.test(c)) return "transactional";
  if (/human|personal/.test(c)) return "human";
  if (/notif|alert|update/.test(c)) return "notification";
  return CATEGORIES[c] ? c : "notification";
}

// Refine a list's categories via Claude (cached per message id).
async function classifyMessages(list) {
  list.forEach((m) => { if (m.category !== "code" && categoryCache.has(m.messageId)) m.category = categoryCache.get(m.messageId); });
  const todo = list.filter((m) => m.category !== "code" && !categoryCache.has(m.messageId));
  if (!todo.length) { renderList(); return; }
  // Batch so big pulls (e.g. 500) stay reliable and the list updates as we go.
  const BATCH = 50;
  for (let i = 0; i < todo.length; i += BATCH) {
    const chunk = todo.slice(i, i + BATCH);
    try {
      const res = await api.classifyMessages({ items: chunk.map((m) => ({ from: m.fromEmail, subject: m.subject })) });
      const cats = (res && res.categories) || [];
      chunk.forEach((m, j) => { if (j < cats.length) { const c = normalizeCat(cats[j]); categoryCache.set(m.messageId, c); m.category = c; } });
      renderList();
    } catch { /* keep provisional for this chunk */ }
  }
}

// Lazy snippet hydration: IMAP arrives with no preview text, so after a list
// loads we fetch previews in the background and patch the rows in. Cached per
// messageId so it only fetches once; other providers already carry snippets.
const snippetCache = new Map();
let snippetsPending = false;
async function hydrateSnippets(list) {
  if (!list || !list.length) return;
  list.forEach((m) => { if (!m.snippet && snippetCache.has(m.messageId)) m.snippet = snippetCache.get(m.messageId); });
  if (snippetsPending) return;
  const todo = list.filter((m) => !m.snippet && !snippetCache.has(m.messageId) && m.account === state.activeAccount && m.messageId);
  if (!todo.length) return;
  snippetsPending = true;
  try {
    const batch = todo.slice(0, 100); // bound the background fetch to roughly a page
    const res = await api.snippets({ accountId: state.activeAccount, messageIds: batch.map((m) => m.messageId) });
    const map = (res && res.snippets) || null;
    if (map) {
      batch.forEach((m) => { const s = map[m.messageId]; if (s != null) { snippetCache.set(m.messageId, s); m.snippet = s; } });
      renderList();
    }
  } catch {}
  finally { snippetsPending = false; }
}

function visibleMessages() {
  const acc = state.activeAccount;
  const v = state.view;
  let msgs;
  if (v.type === "search") {
    msgs = searchViewMessages.slice(); // whole-mailbox deep-search results
  } else if (isServerFolderView()) {
    msgs = folderViewMessages.slice(); // server-fetched (real provider folder / label)
  } else {
    // Folders are now real server folders, so the inbox is simply the server
    // inbox (filed mail has physically moved out). No client-side routing.
    msgs = MESSAGES.filter((m) => m.account === acc);
  }

  if (state.categoryFilter !== "all") {
    msgs = msgs.filter((m) => m.category === state.categoryFilter);
  }
  if (state.search.trim()) {
    const q = state.search.toLowerCase();
    msgs = msgs.filter((m) =>
      m.subject.toLowerCase().includes(q) || m.fromName.toLowerCase().includes(q) || m.fromEmail.toLowerCase().includes(q));
  }
  return msgs;
}

function unreadFor(accId, predicate) {
  return MESSAGES.filter((m) => m.account === accId && m.box === "inbox" && m.unread && predicate(m)).length;
}

// Folders sorted by newest unread mail (then newest mail) for the active account.
// Drag type for reordering folders — distinct from message drag ("text/plain")
// so dropping a message onto a folder and reordering folders never collide.
const FOLDER_DND = "application/x-clearkeep-folder";

// Folders order by the user's MANUAL order once they've reordered (f.pos set);
// otherwise by activity (newest unread, then newest mail). New folders (pos null)
// fall to the end in activity order even in manual mode.
function sortedFolders() {
  const data = {};
  MESSAGES.forEach((m) => {
    if (m.account !== state.activeAccount) return;
    const f = folderForMessage(m);
    if (!f) return;
    const d = data[f.id] || { u: 0, n: 0 };
    if (m.dateMs > d.n) d.n = m.dateMs;
    if (m.unread && m.dateMs > d.u) d.u = m.dateMs;
    data[f.id] = d;
  });
  const activityCmp = (a, b) => {
    const da = data[a.id] || { u: 0, n: 0 }, db = data[b.id] || { u: 0, n: 0 };
    if (db.u !== da.u) return db.u - da.u;
    return db.n - da.n;
  };
  const manual = FOLDERS.some((f) => f.pos != null);
  return FOLDERS.slice().sort((a, b) => {
    if (manual) {
      const pa = a.pos == null ? 1e9 : a.pos, pb = b.pos == null ? 1e9 : b.pos;
      if (pa !== pb) return pa - pb;
    }
    return activityCmp(a, b);
  });
}
function clearFolderDropMarks() {
  document.querySelectorAll("#folder-items .rail-row").forEach((r) => r.classList.remove("drop-before", "drop-after"));
}
// Persist a new folder order after a drag-drop. `after` = drop below the target.
async function reorderFolder(draggedId, targetId, after) {
  if (!draggedId || draggedId === targetId) return;
  const cur = sortedFolders().map((f) => f.id);
  const from = cur.indexOf(draggedId);
  if (from < 0) return;
  cur.splice(from, 1);
  let ti = cur.indexOf(targetId);
  if (ti < 0) return;
  if (after) ti += 1;
  cur.splice(ti, 0, draggedId);
  const idx = new Map(cur.map((id, i) => [id, i])); // optimistic local update
  FOLDERS.forEach((f) => { f.pos = idx.has(f.id) ? idx.get(f.id) : null; });
  renderRail();
  try { await api.setFolderOrder({ accountId: state.activeAccount, order: cur }); }
  catch (e) { toast("Couldn't save folder order: " + e.message, { error: true }); }
}

// ── Icons ───────────────────────────────────────────────────────────────────
function svgMailbox(kind) {
  const icons = {
    inbox: '<path d="M2.5 8.5H5.5L6.5 10.5H9.5L10.5 8.5H13.5M2.5 8.5L4 4.2C4.1 3.8 4.5 3.5 4.9 3.5H11.1C11.5 3.5 11.9 3.8 12 4.2L13.5 8.5M2.5 8.5V11.5C2.5 12 2.9 12.4 3.4 12.4H12.6C13.1 12.4 13.5 12 13.5 11.5V8.5" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" stroke-linejoin="round"/>',
    archive: '<rect x="2.5" y="4.5" width="11" height="8" rx="1.2" stroke="currentColor" stroke-width="1.3"/><path d="M2.5 4.5L3.4 2.8C3.6 2.5 3.9 2.3 4.2 2.3H11.8C12.1 2.3 12.4 2.5 12.6 2.8L13.5 4.5" stroke="currentColor" stroke-width="1.3" stroke-linejoin="round"/><path d="M6.3 7.5H9.7" stroke="currentColor" stroke-width="1.3" stroke-linecap="round"/>',
    trash: '<path d="M3.5 4.5H12.5M6.5 4.5V3.3C6.5 2.9 6.8 2.6 7.2 2.6H8.8C9.2 2.6 9.5 2.9 9.5 3.3V4.5M5 4.5L5.5 12.4C5.5 12.8 5.9 13.1 6.3 13.1H9.7C10.1 13.1 10.5 12.8 10.5 12.4L11 4.5" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" stroke-linejoin="round"/>',
    folder: '<path d="M2.5 5C2.5 4.4 2.9 4 3.5 4H6L7.2 5.3H12.5C13.1 5.3 13.5 5.7 13.5 6.3V11.5C13.5 12.1 13.1 12.5 12.5 12.5H3.5C2.9 12.5 2.5 12.1 2.5 11.5V5Z" stroke="currentColor" stroke-width="1.3" stroke-linejoin="round"/>',
    spam: '<path d="M8 2.2L13 4.2V8C13 11 10.8 13.2 8 14C5.2 13.2 3 11 3 8V4.2L8 2.2Z" stroke="currentColor" stroke-width="1.3" stroke-linejoin="round"/><path d="M8 6V8.7M8 10.6V10.7" stroke="currentColor" stroke-width="1.3" stroke-linecap="round"/>',
    all: '<path d="M3 4.5H13M3 8H13M3 11.5H13" stroke="currentColor" stroke-width="1.3" stroke-linecap="round"/>',
    sent: '<path d="M13.5 2.5L7.2 8.8M13.5 2.5L9.4 13.5L7.2 8.8M13.5 2.5L2.5 6.6L7.2 8.8" stroke="currentColor" stroke-width="1.3" stroke-linejoin="round" stroke-linecap="round"/>',
    markread: '<path d="M3.5 8.5L6.5 11.5L12.5 4.5" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/>',
    markunread: '<circle cx="8" cy="8" r="3" fill="currentColor"/>',
  };
  return `<svg width="15" height="15" viewBox="0 0 16 16" fill="none" aria-hidden="true">${icons[kind] || icons.folder}</svg>`;
}
function svgBroom() {
  return '<svg width="15" height="15" viewBox="0 0 16 16" fill="none" aria-hidden="true"><path d="M11.5 2.5L7.8 6.2M5.2 8.8C4.2 9.8 3.6 11.6 3.4 13.2C5 13 6.8 12.4 7.8 11.4L10.4 8.8C11 8.2 11 7.2 10.4 6.6L9.4 5.6C8.8 5 7.8 5 7.2 5.6L5.2 8.8Z" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" stroke-linejoin="round"/><path d="M4.2 11.2L3 13.5" stroke="currentColor" stroke-width="1.3" stroke-linecap="round"/></svg>';
}
function copyIconSvg() {
  return '<svg width="13" height="13" viewBox="0 0 16 16" fill="none" aria-hidden="true"><rect x="5.5" y="5.5" width="7.5" height="7.5" rx="1.4" stroke="currentColor" stroke-width="1.3"/><path d="M3.5 10.2V4C3.5 3.4 3.9 3 4.5 3H10.2" stroke="currentColor" stroke-width="1.3" stroke-linecap="round"/></svg>';
}
function svgFindImportant() {
  return '<svg width="15" height="15" viewBox="0 0 16 16" fill="none" aria-hidden="true"><path d="M8 1.9l1.7 3.85 4.2.38-3.18 2.78 0.96 4.1L8 11.9 4.32 13.0l0.96-4.1L2.1 6.13l4.2-.38L8 1.9Z" stroke="currentColor" stroke-width="1.2" stroke-linejoin="round" stroke-linecap="round"/></svg>';
}
function checkSvg() {
  return '<svg width="11" height="11" viewBox="0 0 16 16" fill="none"><path d="M3.5 8.5L6.5 11.5L12.5 4.5" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg>';
}
function svgNeedsYou() {
  return '<svg width="15" height="15" viewBox="0 0 16 16" fill="none" aria-hidden="true"><path d="M8 2.2c-2 0-3.3 1.5-3.3 3.5 0 3-1.2 3.7-1.2 3.7h9s-1.2-.7-1.2-3.7C11.3 3.7 10 2.2 8 2.2Z" stroke="currentColor" stroke-width="1.2" stroke-linejoin="round"/><path d="M6.7 11.7a1.4 1.4 0 0 0 2.6 0" stroke="currentColor" stroke-width="1.2" stroke-linecap="round"/></svg>';
}
function svgOpenMail() {
  return '<svg width="13" height="13" viewBox="0 0 16 16" fill="none"><rect x="2.5" y="3.5" width="11" height="9" rx="1.4" stroke="currentColor" stroke-width="1.3"/><path d="M3 4.5L8 8.5L13 4.5" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" stroke-linejoin="round"/></svg>';
}
function svgAsk() {
  return '<svg width="15" height="15" viewBox="0 0 16 16" fill="none" aria-hidden="true"><path d="M3 3.2h10c.6 0 1 .5 1 1v5.6c0 .6-.4 1-1 1H6.6L4 13.2v-2.2H3c-.6 0-1-.4-1-1V4.2c0-.5.4-1 1-1Z" stroke="currentColor" stroke-width="1.2" stroke-linejoin="round"/><path d="M6.4 6.1c0-.9.8-1.5 1.7-1.4.8 0 1.5.6 1.5 1.4 0 1-1.1 1.1-1.5 1.7" stroke="currentColor" stroke-width="1.2" stroke-linecap="round" stroke-linejoin="round"/><circle cx="8.05" cy="9.4" r="0.55" fill="currentColor"/></svg>';
}
function svgAskSend() {
  return '<svg width="16" height="16" viewBox="0 0 16 16" fill="none" aria-hidden="true"><path d="M8 13V3.5M8 3.5L4 7.5M8 3.5L12 7.5" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"/></svg>';
}
function svgSnooze() {
  return '<svg width="13" height="13" viewBox="0 0 16 16" fill="none"><circle cx="8" cy="8.5" r="5" stroke="currentColor" stroke-width="1.3"/><path d="M8 5.8V8.5L9.8 9.8" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" stroke-linejoin="round"/></svg>';
}
function svgX() {
  return '<svg width="12" height="12" viewBox="0 0 16 16" fill="none"><path d="M4.5 4.5L11.5 11.5M11.5 4.5L4.5 11.5" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/></svg>';
}
// Row hover-actions vary by the view: restore appears in folders/archive/trash;
// archive in inbox/folders; delete everywhere except the trash view itself.
function rowActionsHtml(id) {
  const v = state.view.type;
  const m = findMsg(id);
  const btn = (act, title, kind) => `<button class="row-act" data-act="${act}" data-id="${id}" title="${title}">${svgMailbox(kind)}</button>`;
  const out = [];
  if (m) out.push(m.unread ? btn("read", "Mark as read", "markread") : btn("unread", "Mark as unread", "markunread"));
  if (v === "folder" || v === "archive" || v === "trash" || v === "spam") out.push(btn("toinbox", v === "spam" ? "Not spam — move to inbox" : "Move to inbox", "inbox"));
  if (v === "inbox" || v === "folder" || v === "all") out.push(btn("archive", "Archive", "archive"));
  if (v !== "trash") out.push(btn("trash", "Delete", "trash"));
  return out.join("");
}

// ── Rail ────────────────────────────────────────────────────────────────────
function railRow({ icon, label, count, active, onClick, onRemove, onRefile, onDrop, tone }) {
  const row = document.createElement("div");
  row.className = "rail-row" + (active ? " active" : "") + (tone ? " " + tone : "");
  row.innerHTML = `<span class="rr-icon">${icon}</span><span class="rr-label">${escapeHtml(label)}</span>` + (count ? `<span class="rr-count">${count}</span>` : "");
  row.addEventListener("click", onClick);
  if (onDrop) { // drop target for dragged messages (ignores folder-reorder drags)
    row.addEventListener("dragover", (e) => {
      if (e.dataTransfer.types.includes(FOLDER_DND)) return; // folder reorder, not a message drop
      e.preventDefault(); e.dataTransfer.dropEffect = "move"; row.classList.add("rr-drop");
    });
    row.addEventListener("dragleave", () => row.classList.remove("rr-drop"));
    row.addEventListener("drop", (e) => {
      if (e.dataTransfer.types.includes(FOLDER_DND)) return; // handled by the reorder drop
      e.preventDefault(); row.classList.remove("rr-drop");
      const ids = (e.dataTransfer.getData("text/plain") || "").split("\n").filter(Boolean);
      if (ids.length) onDrop(ids);
    });
  }
  if (onRefile) {
    const rf = document.createElement("button");
    rf.className = "rr-refile";
    rf.title = "Re-file: sweep new matching mail into this folder";
    rf.innerHTML = '<svg width="12" height="12" viewBox="0 0 16 16" fill="none"><path d="M13 8a5 5 0 1 1-1.5-3.5M13 2.5V5H10.5" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round"/></svg>';
    rf.addEventListener("click", (e) => { e.stopPropagation(); onRefile(); });
    row.appendChild(rf);
  }
  if (onRemove) {
    const rm = document.createElement("button");
    rm.className = "rr-remove";
    rm.title = "Delete folder";
    rm.innerHTML = '<svg width="11" height="11" viewBox="0 0 16 16" fill="none"><path d="M4 4L12 12M12 4L4 12" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/></svg>';
    rm.addEventListener("click", (e) => { e.stopPropagation(); onRemove(); });
    row.appendChild(rm);
  }
  return row;
}

// ── Workspace (account) dropdown ─────────────────────────────────────────────
const WS_CHEVRON = '<svg class="ws-chevron" width="12" height="12" viewBox="0 0 16 16" fill="none" aria-hidden="true"><path d="M4.5 6.5L8 10L11.5 6.5" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round"/></svg>';
function closeWorkspaceMenu() {
  const menu = $("#workspace-menu"); if (menu) menu.classList.add("hidden");
  const cur = $("#workspace-current"); if (cur) cur.setAttribute("aria-expanded", "false");
}
function toggleWorkspaceMenu() {
  const menu = $("#workspace-menu"), cur = $("#workspace-current");
  if (!menu || !cur) return;
  const open = menu.classList.toggle("hidden") === false;
  cur.setAttribute("aria-expanded", open ? "true" : "false");
}
// Switch the active workspace; resets the view to that account's Inbox.
async function selectWorkspace(id) {
  closeWorkspaceMenu();
  if (state.activeAccount !== id) { state.activeAccount = id; askHistory = []; askSourceMsgs = []; askPending = ""; askUI = { phase: "idle", progress: null, account: null }; await loadFolders(); loadNeeds(); loadImportant(); loadContacts(); }
  setView({ type: "inbox" }); // calls renderAll → renderRail
}
function renderWorkspace() {
  const cur = $("#workspace-current"), menu = $("#workspace-menu");
  if (!cur || !menu) return;
  const a = acctById(state.activeAccount);
  if (!a) {
    cur.removeAttribute("data-account-id");
    cur.innerHTML = `<span class="ws-label ws-empty">Add account</span>${WS_CHEVRON}`;
  } else {
    cur.dataset.accountId = a.id;
    cur.innerHTML = avatarHtml(a.address, a.address, "avatar-sm") + `<span class="ws-label">${escapeHtml(a.address)}</span>${WS_CHEVRON}`;
  }

  menu.innerHTML = "";
  accountsList.forEach((acc) => {
    const count = serverInboxUnread[acc.id] != null ? serverInboxUnread[acc.id] : unreadFor(acc.id, () => true);
    const opt = document.createElement("div");
    opt.className = "ws-option" + (acc.id === state.activeAccount ? " selected" : "");
    opt.dataset.accountId = acc.id;
    opt.innerHTML = avatarHtml(acc.address, acc.address, "avatar-sm") +
      `<span class="rr-label">${escapeHtml(acc.address)}</span>` + (count ? `<span class="rr-count">${count}</span>` : "");
    opt.addEventListener("click", () => selectWorkspace(acc.id));
    menu.appendChild(opt);
  });
  const add = document.createElement("div");
  add.className = "ws-option ws-add";
  add.innerHTML = `<span class="rr-icon"><svg width="13" height="13" viewBox="0 0 16 16" fill="none" aria-hidden="true"><path d="M8 3.5V12.5M3.5 8H12.5" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/></svg></span><span class="rr-label">Add account</span>`;
  add.addEventListener("click", () => { closeWorkspaceMenu(); openSettings(); });
  menu.appendChild(add);

  hydrateAvatars(cur);
  hydrateAvatars(menu);
  hydrateAccountAvatars();
}

function renderRail() {
  // The selected account is the persistent workspace; Inbox/Archive/Spam/Trash
  // and Folders below all operate within it.
  renderWorkspace();

  // mailboxes (scoped to the selected workspace account)
  const mbEl = $("#mailbox-items");
  mbEl.innerHTML = "";
  const acc = state.activeAccount;
  const inboxCount = acc ? (serverInboxUnread[acc] != null ? serverInboxUnread[acc] : unreadFor(acc, () => true)) : 0;
  mbEl.appendChild(railRow({ icon: svgMailbox("inbox"), label: "Inbox", count: inboxCount, active: state.view.type === "inbox", onClick: () => setView({ type: "inbox" }) }));
  mbEl.appendChild(railRow({ icon: svgMailbox("sent"), label: "Sent", active: state.view.type === "sent", onClick: () => setView({ type: "sent" }) }));
  mbEl.appendChild(railRow({ icon: svgMailbox("archive"), label: "Archive", active: state.view.type === "archive", onClick: () => setView({ type: "archive" }) }));
  mbEl.appendChild(railRow({ icon: svgMailbox("spam"), label: "Spam", active: state.view.type === "spam", onClick: () => setView({ type: "spam" }) }));
  mbEl.appendChild(railRow({ icon: svgMailbox("trash"), label: "Trash", active: state.view.type === "trash", onClick: () => setView({ type: "trash" }) }));
  // Clean up / Important / Needs you / Ask AI are this app's features — they live in
  // the workspace-header pills now (see #filter-pills), not in the mailbox rail.

  // folders (scoped to active account)
  const fEl = $("#folder-items");
  fEl.innerHTML = "";
  const CAP = 3;
  const sorted = sortedFolders();
  let shown = state.foldersExpanded ? sorted : sorted.slice(0, CAP);
  // keep the active folder visible even when collapsed
  if (!state.foldersExpanded && state.view.type === "folder") {
    const active = sorted.find((f) => f.id === state.view.id);
    if (active && !shown.includes(active)) shown = [...shown, active];
  }
  shown.forEach((f) => {
    const fRow = railRow({
      icon: svgMailbox("folder"), label: f.name, count: f.unread,
      active: state.view.type === "folder" && state.view.id === f.id,
      onClick: () => setView({ type: "folder", id: f.id }),
      onDrop: (ids) => dropToFolder(ids, f.name),
      onRefile: () => refileFolder(f.id, f.name),
      onRemove: async () => {
        // Removing a server-backed folder moves its mail back to the inbox.
        toast(`Removing “${f.name}”…`);
        await api.unfileFolder({ accountId: state.activeAccount, name: f.name, id: f.id });
        if (state.view.type === "folder" && state.view.id === f.id) state.view = { type: "inbox" };
        await loadInbox();
        await loadFolders();
        renderAll();
        toast(`Removed “${f.name}” — mail returned to inbox`);
      },
    });
    fRow.dataset.folderId = f.id;
    // Drag-to-reorder (distinct drag type from message-onto-folder drops).
    fRow.draggable = true;
    fRow.addEventListener("dragstart", (e) => {
      e.dataTransfer.setData(FOLDER_DND, f.id);
      e.dataTransfer.effectAllowed = "move";
      fRow.classList.add("rr-dragging");
      document.body.classList.add("reordering-folders");
    });
    fRow.addEventListener("dragend", () => { fRow.classList.remove("rr-dragging"); document.body.classList.remove("reordering-folders"); clearFolderDropMarks(); });
    fRow.addEventListener("dragover", (e) => {
      if (!e.dataTransfer.types.includes(FOLDER_DND)) return; // a message drag → let the message-drop handler run
      e.preventDefault(); e.dataTransfer.dropEffect = "move";
      const r = fRow.getBoundingClientRect();
      const after = (e.clientY - r.top) > r.height / 2;
      clearFolderDropMarks();
      fRow.classList.add(after ? "drop-after" : "drop-before");
    });
    fRow.addEventListener("drop", (e) => {
      if (!e.dataTransfer.types.includes(FOLDER_DND)) return;
      e.preventDefault();
      const r = fRow.getBoundingClientRect();
      const after = (e.clientY - r.top) > r.height / 2;
      clearFolderDropMarks();
      reorderFolder(e.dataTransfer.getData(FOLDER_DND), f.id, after);
    });
    fEl.appendChild(fRow);
  });
  // expand/collapse chevron next to the "Folders" label (only when there's overflow)
  const foldBtn = $("#folders-fold-btn");
  if (foldBtn) {
    if (sorted.length > CAP) {
      foldBtn.classList.remove("hidden");
      foldBtn.innerHTML = foldChevron(state.foldersExpanded);
      foldBtn.title = state.foldersExpanded ? "Collapse folders" : `Show all ${sorted.length} folders`;
    } else {
      foldBtn.classList.add("hidden");
    }
  }

  // account avatars are hydrated inside renderWorkspace()
  updateAttention(); // keep the dock badge + inbox banner in sync with the rail counts
}
function foldChevron(up) {
  return `<svg width="11" height="11" viewBox="0 0 16 16" fill="none" aria-hidden="true"><path d="${up ? "M4.5 9.5L8 6L11.5 9.5" : "M4.5 6.5L8 10L11.5 6.5"}" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"/></svg>`;
}

// The account's own profile photo (e.g. the picture set in Zoho) takes
// precedence over the generic logo/initials. Provider-specific; null falls
// through to whatever hydrateAvatars resolved.
const accountAvatarMem = new Map();   // accountId -> dataUrl|null
const accountAvatarInflight = new Set();
// Apply a known account photo to every place that account is shown (workspace
// header + dropdown options).
function applyAccountAvatar(id) {
  const url = accountAvatarMem.get(id);
  if (typeof url !== "string") return;
  document.querySelectorAll('[data-account-id="' + CSS.escape(id) + '"]').forEach((el) => {
    const span = el.classList.contains("avatar") ? el : el.querySelector(".avatar");
    if (span) setAccountAvatarImg(span, url);
  });
}
function hydrateAccountAvatars() {
  accountsList.forEach((a) => {
    if (typeof accountAvatarMem.get(a.id) === "string") { applyAccountAvatar(a.id); return; }
    if (accountAvatarMem.has(a.id) || accountAvatarInflight.has(a.id)) return;
    accountAvatarInflight.add(a.id);
    api.fetchAccountAvatar(a.id)
      .then((res) => { accountAvatarMem.set(a.id, res && res.dataUrl ? res.dataUrl : null); accountAvatarInflight.delete(a.id); applyAccountAvatar(a.id); })
      .catch(() => { accountAvatarMem.set(a.id, null); accountAvatarInflight.delete(a.id); });
  });
}
function setAccountAvatarImg(span, url) {
  let img = span.querySelector("img");
  if (!img) { img = document.createElement("img"); img.className = "avatar-img"; img.alt = ""; span.appendChild(img); }
  if (img.src !== url) img.src = url;
}

// ── List ────────────────────────────────────────────────────────────────────
function viewTitle() {
  const v = state.view;
  if (v.type === "inbox") { const a = acctById(state.activeAccount); return a ? a.address : "Inbox"; }
  if (v.type === "folder") return FOLDERS.find((f) => f.id === v.id).name;
  if (v.type === "all") return "All emails";
  if (v.type === "sent") return "Sent";
  if (v.type === "archive") return "Archive";
  if (v.type === "spam") return "Spam";
  if (v.type === "trash") return "Trash";
  if (v.type === "search") return `Search: “${v.query || ""}”`;
  return "Mail";
}

function setEmptyState(show) {
  $("#mail-empty").classList.toggle("hidden", !show);
  $("#message-list").style.display = show ? "none" : "";
  $("#list-header").style.visibility = show ? "hidden" : "";
}

function renderList() {
  if (accountsList.length === 0) { setEmptyState(true); $("#cleanup-view").classList.add("hidden"); $("#keepers-view").classList.add("hidden"); $("#needs-view").classList.add("hidden"); $("#ask-view").classList.add("hidden"); return; }
  setEmptyState(false);
  $("#ask-view").classList.add("hidden"); // re-shown below only when the Ask view is active

  const cleanupEl = $("#cleanup-view");
  if (state.view.type === "cleanup") {
    $("#message-list").style.display = "none";
    $("#list-header").style.display = "none";
    $("#selection-bar").classList.add("hidden");
    $("#reader").classList.add("hidden"); // no reading pane on Clean up — nothing to read
    cleanupEl.classList.remove("hidden");
    $("#keepers-view").classList.add("hidden");
    $("#needs-view").classList.add("hidden");
    renderCleanup();
    return;
  }
  cleanupEl.classList.add("hidden");

  const keepersEl = $("#keepers-view");
  if (state.view.type === "keepers") {
    $("#message-list").style.display = "none";
    $("#list-header").style.display = "none";
    $("#selection-bar").classList.add("hidden");
    $("#reader").classList.add("hidden"); // no reading pane on Find important
    keepersEl.classList.remove("hidden");
    $("#needs-view").classList.add("hidden");
    renderKeepers();
    return;
  }
  keepersEl.classList.add("hidden");

  const needsEl = $("#needs-view");
  if (state.view.type === "needs") {
    $("#message-list").style.display = "none";
    $("#list-header").style.display = "none";
    $("#selection-bar").classList.add("hidden");
    needsEl.classList.remove("hidden");
    renderNeeds();
    return;
  }
  needsEl.classList.add("hidden");

  if (state.view.type === "ask") {
    $("#message-list").style.display = "none";
    $("#list-header").style.display = "none";
    $("#selection-bar").classList.add("hidden");
    $("#ask-view").classList.remove("hidden");
    // Keep the reading pane present beside the chat: idle ("No email selected") until
    // a citation is clicked, then it shows that email. syncReader never hides in pane,
    // so a citation's openMessage → renderList won't close the email it just opened.
    syncReader();
    renderAsk();
    return;
  }

  $("#message-list").style.display = "";
  $("#list-header").style.display = "";

  $("#list-title").textContent = viewTitle();
  const msgs = visibleMessages();
  const unread = msgs.filter((m) => m.unread).length;
  $("#list-meta").textContent = state.loading
    ? "Syncing…"
    : (msgs.length === 0 ? "" : `${msgs.length} message${msgs.length > 1 ? "s" : ""}` + (unread ? ` · ${unread} unread` : ""));
  if (state.view.type === "search") {
    $("#list-meta").textContent = searchLoading
      ? "Searching…"
      : (msgs.length
        ? `${msgs.length} result${msgs.length === 1 ? "" : "s"} · whole mailbox · drag into a folder to file`
        : "No matches in your whole mailbox");
  }

  const listEl = $("#message-list");
  listEl.innerHTML = "";

  if (msgs.length === 0) {
    const empty = document.createElement("div");
    empty.className = "list-empty";
    const isSys = state.view.type === "archive" || state.view.type === "trash" || state.view.type === "spam";
    if (state.view.type === "search" && searchLoading) {
      empty.innerHTML = `<div class="list-empty-loading"><div class="cu-spinner"></div><div>Searching your mailbox for “${escapeHtml(searchViewMeta.query)}”…</div></div>`;
    } else {
      empty.textContent = state.loading ? "Connecting to your mailbox…"
        : (isSys && folderViewError ? folderViewError : "Nothing here.");
    }
    listEl.appendChild(empty);
    currentList = msgs;
    syncReader();
    return;
  }

  currentList = msgs.slice().sort((a, b) => b.dateMs - a.dateMs);
  // Group into sections per the active sort; each grouped section shows the
  // first sec.cap rows until "View more" expands it.
  const sections = buildSections(currentList);
  sections.forEach((sec, i) => {
    if (i > 0) listEl.appendChild(listDivider());
    const expanded = sectionExpanded.has(sec.key);
    const hasMore = sec.msgs.length > sec.cap;
    const more = hasMore ? { key: sec.key, expanded, hidden: sec.msgs.length - sec.cap } : null;
    if (sec.label) listEl.appendChild(listHeading(sec.label, sec.msgs.length, more));
    const rows = expanded ? sec.msgs : sec.msgs.slice(0, sec.cap);
    rows.forEach((m) => listEl.appendChild(buildRow(m)));
    if (hasMore && !sec.label) listEl.appendChild(listMore(sec.key, expanded, sec.msgs.length - sec.cap)); // no heading → standalone toggle
  });
  renderLoadMore(listEl);
  hydrateAvatars(listEl);
  updateSelectionUI();
  syncReader();
  maybeScanUnsub(); // lazily probe + reveal per-row unsubscribe chips (Yahoo)
}

function listHeading(text, count, more) {
  const el = document.createElement("div");
  el.className = "list-section-label";
  el.innerHTML = `<span>${escapeHtml(text)}</span>` + (count != null ? `<span class="lsl-count">${count}</span>` : "")
    + (more ? `<button class="lsl-more" type="button">${more.expanded ? "View less" : `View ${more.hidden} more`}</button>` : "");
  if (more) el.querySelector(".lsl-more").addEventListener("click", (e) => {
    e.stopPropagation();
    if (sectionExpanded.has(more.key)) sectionExpanded.delete(more.key); else sectionExpanded.add(more.key);
    renderList();
  });
  return el;
}
function listDivider() {
  const el = document.createElement("div");
  el.className = "list-divider";
  return el;
}
function listMore(key, expanded, hidden) {
  const b = document.createElement("button");
  b.className = "list-more";
  b.type = "button";
  b.textContent = expanded ? "View less" : `View ${hidden} more`;
  b.addEventListener("click", () => {
    if (sectionExpanded.has(key)) sectionExpanded.delete(key); else sectionExpanded.add(key);
    renderList();
  });
  return b;
}

// ── Load more: true cursor pagination — append the next page from the server ──
function isServerFolderView() {
  return ["archive", "trash", "spam", "sent", "folder"].includes(state.view.type);
}
// The server scope/name to fetch for the current view.
function viewServerScope() {
  const v = state.view;
  if (v.type === "folder") { const f = FOLDERS.find((x) => x.id === v.id); return f ? f.name : null; }
  return v.type === "trash" ? "Trash" : v.type === "spam" ? "Spam" : v.type === "sent" ? "Sent" : "Archive";
}
// The provider told us whether more pages exist — no guessing.
function canLoadMore() {
  if (accountsList.length === 0 || state.loading) return false;
  if (isServerFolderView()) return !!folderCursor.hasMore;
  const cur = inboxCursors[state.activeAccount];
  return !!(cur && cur.hasMore);
}
function renderLoadMore(listEl) {
  if (!(state.loadingMore || canLoadMore())) return;
  const b = document.createElement("button");
  b.className = "list-loadmore";
  b.type = "button";
  b.disabled = state.loadingMore;
  b.textContent = state.loadingMore ? "Loading…" : "Load more";
  b.addEventListener("click", loadMore);
  listEl.appendChild(b);
}
async function loadMore() {
  if (state.loadingMore || !canLoadMore()) return;
  const listEl = $("#message-list");
  const sc = listEl ? listEl.scrollTop : 0;
  state.loadingMore = true;
  renderList(); // flip the button to "Loading…"
  try {
    if (isServerFolderView()) await loadMoreFolder();
    else await loadMoreInbox();
  } catch (e) { toast(`Load more failed: ${e.message}`); }
  state.loadingMore = false;
  renderAll();
  const el = $("#message-list"); if (el) el.scrollTop = sc; // keep the user's place
}

// Group the (newest-first) messages into sections per the active sort mode.
function buildSections(msgs) {
  if (state.sort === "timeline") {
    return [{ key: "timeline", label: "", msgs, cap: Infinity }];
  }
  // status: Unread on top, Read below. One-section views drop the heading.
  const unread = msgs.filter((m) => m.unread);
  const read = msgs.filter((m) => !m.unread);
  const secs = [];
  if (unread.length) secs.push({ key: "unread", label: "Unread", msgs: unread, cap: 10 });
  if (read.length) secs.push({ key: "read", label: "Read", msgs: read, cap: 20 });
  if (secs.length === 1) secs[0].label = "";
  return secs;
}

// First address out of a "Name <email>, …" header string → {name, email}.
function firstAddress(s) {
  const first = String(s || "").split(",")[0].trim();
  const m = first.match(/^\s*"?([^"<]*?)"?\s*<([^>]+)>/);
  if (m) return { name: (m[1] || "").trim() || m[2].trim(), email: m[2].trim() };
  return { name: first, email: first };
}

function buildRow(m) {
  const cat = CATEGORIES[m.category] || CATEGORIES.human;
  const sent = state.view.type === "sent";
  const who = sent ? firstAddress(m.to) : { name: m.fromName, email: m.fromEmail };
  const row = document.createElement("div");
  row.dataset.id = m.id;
  row.className = "msg-row" + (m.unread ? "" : " read") + (m.id === state.activeId ? " active" : "") + (selection.has(m.id) ? " selected" : "") + (m.category === "code" ? " is-code" : "");

  let tagsHtml = "";   // category chips removed (no AI classify); login-code chip stays
  if (m.category === "code" && m.code) {
    tagsHtml = `<div class="msg-tags">
      <button class="code-chip" data-copy="${m.code}" data-id="${m.id}"><span>${m.code}</span><span class="copy-glyph">${copyIconSvg()}</span></button>
      <span class="code-hint">copy clears it</span>
    </div>`;
  }

  row.innerHTML = `
    <span class="msg-check" data-id="${m.id}"><svg width="11" height="11" viewBox="0 0 16 16" fill="none"><path d="M3.5 8.5L6.5 11.5L12.5 4.5" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg></span>
    <span class="avatar-wrap">${avatarHtml(cleanName(who.name), who.email, "msg-avatar")}${m.unread ? '<span class="msg-unread"></span>' : ""}</span>
    <div class="msg-main">
      <div class="msg-line1">
        <span class="msg-sender">${sent ? "To: " : ""}${escapeHtml(cleanName(who.name))}</span>
        <span class="msg-time">${m.time}</span>
      </div>
      <div class="msg-subject">${escapeHtml(cleanName(m.subject))}</div>
      ${m.snippet ? `<div class="msg-snippet">${escapeHtml(cleanName(m.snippet))}</div>` : ""}
      ${tagsHtml}
    </div>
    <div class="msg-actions">${rowActionsHtml(m.id)}</div>`;

  row.addEventListener("click", (e) => {
    if (e.target.closest(".row-act") || e.target.closest(".code-chip") || e.target.closest(".msg-check")) return;
    openMessage(m.id);
  });
  // Warm the body cache when the cursor pauses on a row, so the click feels instant.
  let warm = null;
  row.addEventListener("mouseenter", () => { warm = setTimeout(() => prefetchBody(m), 110); });
  row.addEventListener("mouseleave", () => { if (warm) { clearTimeout(warm); warm = null; } });
  row.querySelectorAll(".row-act").forEach((btn) => btn.addEventListener("click", (e) => { e.stopPropagation(); applyAction([btn.getAttribute("data-id")], btn.getAttribute("data-act")); }));
  row.querySelectorAll(".code-chip").forEach((chip) => chip.addEventListener("click", (e) => { e.stopPropagation(); copyCode(chip.getAttribute("data-copy"), chip.getAttribute("data-id")); }));
  row.querySelectorAll(".msg-check").forEach((cb) => cb.addEventListener("click", (e) => { e.stopPropagation(); e.preventDefault(); toggleSelect(cb.getAttribute("data-id"), e.shiftKey); }));
  // drag-and-drop: drag this message (or the whole selection if it's selected) onto a folder
  row.draggable = true;
  row.addEventListener("dragstart", (e) => {
    const ids = (selection.has(m.id) && selection.size) ? [...selection] : [m.id];
    e.dataTransfer.setData("text/plain", ids.join("\n"));
    e.dataTransfer.effectAllowed = "move";
    document.body.classList.add("dragging-msg");
  });
  row.addEventListener("dragend", () => document.body.classList.remove("dragging-msg"));
  applyUnsubChip(row, m); // show the unsubscribe chip if this row's tier is already known
  applyRowImportant(row, m); // star rows the AI flagged as important
  return row;
}

// ── Per-row unsubscribe (List-Unsubscribe header, IMAP/Yahoo only) ────────────
// The list fetch only pulls envelopes, so a row's unsub tier is probed lazily
// (maybeScanUnsub) and cached on the message object as m.unsub = {tier, …}.
//   one-click / mailto → headless (POST / pooled SMTP), behind a tiny confirm
//   link               → not headless; opens the page in a browser
const UNSUB_SVG = {
  minus: '<svg width="12" height="12" viewBox="0 0 16 16" fill="none"><circle cx="8" cy="8" r="5.5" stroke="currentColor" stroke-width="1.3"/><path d="M5.5 8H10.5" stroke="currentColor" stroke-width="1.3" stroke-linecap="round"/></svg>',
  check: '<svg width="12" height="12" viewBox="0 0 16 16" fill="none"><path d="M3.5 8.5L6.5 11.5L12.5 4.5" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"/></svg>',
  ext: '<svg width="12" height="12" viewBox="0 0 16 16" fill="none"><path d="M6 3.5H4.2C3.5 3.5 3 4 3 4.7V11.8C3 12.5 3.5 13 4.2 13H11.3C12 13 12.5 12.5 12.5 11.8V10" stroke="currentColor" stroke-width="1.3" stroke-linecap="round"/><path d="M9.5 3.5H12.5V6.5" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" stroke-linejoin="round"/><path d="M12.4 3.6L7.8 8.2" stroke="currentColor" stroke-width="1.3" stroke-linecap="round"/></svg>',
  spin: '<span class="unsub-spin"></span>',
};
// The chip's look/label for the current message state, or null if no chip.
function unsubChipState(m) {
  const u = m.unsub;
  if (!u || !u.tier || u.tier === "none") return null;
  if (m.unsubState === "busy") return { cls: "busy", title: "Unsubscribing…", svg: UNSUB_SVG.spin };
  if (m.unsubState === "done") return { cls: "done", title: "Unsubscribed", svg: UNSUB_SVG.check };
  if (m.unsubState === "fail") return { cls: "fail", title: "Unsubscribe failed — click to retry", svg: UNSUB_SVG.minus };
  if (u.tier === "link") return { cls: "link", title: "Open unsubscribe page in browser", svg: UNSUB_SVG.ext };
  return { cls: "", title: "Unsubscribe", svg: UNSUB_SVG.minus };
}
function applyUnsubChip(row, m) {
  const line1 = row.querySelector(".msg-line1");
  if (!line1) return;
  let chip = line1.querySelector(".msg-unsub");
  const st = unsubChipState(m);
  if (!st) { if (chip) chip.remove(); return; }
  if (!chip) {
    chip = document.createElement("button");
    chip.className = "msg-unsub";
    chip.addEventListener("click", (e) => { e.stopPropagation(); onUnsubClick(m.id); });
    line1.insertBefore(chip, line1.querySelector(".msg-time")); // after sender, left of the time
  }
  chip.className = "msg-unsub" + (st.cls ? " " + st.cls : "");
  chip.title = st.title;
  chip.innerHTML = st.svg;
  chip.disabled = m.unsubState === "busy" || m.unsubState === "done";
}
function unsubRow(id) { return [...document.querySelectorAll("#message-list .msg-row")].find((r) => r.dataset.id === id); }
function refreshUnsubChip(m) { const row = unsubRow(m.id); if (row) applyUnsubChip(row, m); }

function onUnsubClick(id) {
  const m = findMsg(id);
  if (!m || !m.unsub) return;
  if (m.unsubState === "busy" || m.unsubState === "done") return;
  if (m.unsub.tier === "link") { api.openExternal(m.unsub.url); return; } // manual page — not headless
  const who = cleanName(m.fromName) || m.fromEmail || "this sender";
  toast(`Unsubscribe from ${who}?`, { warn: true, label: "Unsubscribe", fn: () => fireUnsub(m.id) });
}
async function fireUnsub(id) {
  const m = findMsg(id);
  if (!m || !m.unsub) return;
  m.unsubState = "busy"; refreshUnsubChip(m);
  let res;
  try {
    res = await api.unsubscribeOne({ accountId: m.account, tier: m.unsub.tier, postUrl: m.unsub.postUrl, mailto: m.unsub.mailto, vendor: cleanName(m.fromName) || m.fromEmail });
  } catch (e) { res = { ok: false, error: e.message }; }
  m.unsubState = res && res.ok ? "done" : "fail"; refreshUnsubChip(m);
  const who = cleanName(m.fromName) || m.fromEmail;
  if (res && res.ok) toast(`Unsubscribed from ${who}`);
  else toast(`Couldn't unsubscribe: ${(res && res.error) || "failed"}`, { error: true });
}

// Lazily probe the unsub tier for the rows on screen (Yahoo only). Debounced,
// batched (≤60), one request in flight; scanned rows are cached so they're never
// re-probed. m.unsub: undefined = unscanned, null = in flight, object = done.
let unsubScanTimer = null, unsubScanning = false;
function maybeScanUnsub() {
  if (state.view.type === "sent" || state.view.type === "cleanup") return; // unsub is meaningless here
  const acc = acctById(state.activeAccount);
  if (!acc || acc.provider !== "yahoo" || !api.unsubScan) return; // header-probe is IMAP-only
  clearTimeout(unsubScanTimer);
  unsubScanTimer = setTimeout(runUnsubScan, 300);
}
async function runUnsubScan() {
  if (unsubScanning) return;
  const acc = acctById(state.activeAccount);
  if (!acc || acc.provider !== "yahoo") return;
  const pending = [];
  for (const r of document.querySelectorAll("#message-list .msg-row")) {
    const m = findMsg(r.dataset.id);
    if (m && m.account === acc.id && m.unsub === undefined) pending.push(m);
    if (pending.length >= 60) break;
  }
  if (!pending.length) return;
  unsubScanning = true;
  pending.forEach((m) => { m.unsub = null; }); // in-flight: don't re-request
  try {
    const map = await api.unsubScan({ accountId: acc.id, messageIds: pending.map((m) => m.messageId) });
    pending.forEach((m) => {
      const u = map && map[m.messageId];
      m.unsub = u && u.tier && u.tier !== "none" ? u : { tier: "none" };
      refreshUnsubChip(m);
    });
  } catch {
    pending.forEach((m) => { if (m.unsub === null) m.unsub = undefined; }); // failed → allow retry
  } finally {
    unsubScanning = false;
    if (pending.length >= 60) maybeScanUnsub(); // more rows may remain
  }
}

// ── FLIP: animate rows gliding between the Unread/Read sections ───────────────
// Capture each visible row's position + a clone (the clone powers the falling
// "ghost" when a row's new home is hidden inside a collapsed section).
function captureRows() {
  const map = new Map();
  document.querySelectorAll("#message-list .msg-row").forEach((r) => {
    const rect = r.getBoundingClientRect();
    map.set(r.dataset.id, { top: rect.top, rect, node: r.cloneNode(true) });
  });
  return map;
}
// FLIP the list after a re-render. Rows present before+after glide to their new
// spot; rows that left the visible set (incl. `fallingId`, which always ghosts
// from its origin) get a viewport-fixed clone that drops and fades — so the
// fall is visible even when its destination is in a collapsed section.
function flipFrom(first, fallingId) {
  const listEl = $("#message-list");
  if (!listEl) return;
  const present = new Set();
  const moved = [];
  listEl.querySelectorAll(".msg-row").forEach((r) => {
    present.add(r.dataset.id);
    if (r.dataset.id === fallingId) return; // its motion is shown by the ghost
    const info = first.get(r.dataset.id);
    if (!info) return;
    const delta = info.top - r.getBoundingClientRect().top;
    if (Math.abs(delta) < 1) return;
    r.style.transition = "none";
    r.style.transform = `translateY(${delta}px)`;
    moved.push(r);
  });
  const ghosts = [];
  first.forEach((info, id) => {
    if (id !== fallingId && present.has(id)) return;
    const g = info.node, rc = info.rect;
    g.classList.add("msg-row-ghost");
    g.style.top = rc.top + "px"; g.style.left = rc.left + "px"; g.style.width = rc.width + "px";
    document.body.appendChild(g);
    ghosts.push(g);
  });
  if (!moved.length && !ghosts.length) return;
  void listEl.offsetHeight; // flush styles
  requestAnimationFrame(() => {
    moved.forEach((r) => {
      r.style.transition = "transform 0.55s cubic-bezier(0.33,0,0.2,1)";
      r.style.transform = "";
      r.addEventListener("transitionend", () => { r.style.transition = ""; r.style.transform = ""; }, { once: true });
    });
    ghosts.forEach((g) => {
      g.style.transition = "transform 0.62s cubic-bezier(0.33,0,0.25,1), opacity 0.62s ease";
      g.style.transform = "translateY(80px)";
      g.style.opacity = "0";
      g.addEventListener("transitionend", () => g.remove(), { once: true });
    });
  });
}
// Run a state mutation, re-render, and FLIP the list so rows glide to new spots.
function reflowList(mutate) {
  const first = captureRows();
  mutate();
  renderAll();
  flipFrom(first);
}

// ── Bulk selection ──────────────────────────────────────────────────────────
function toggleSelect(id, shift) {
  const idx = currentList.findIndex((m) => m.id === id);
  if (shift && lastIndex >= 0 && idx >= 0) {
    const [a, b] = [Math.min(lastIndex, idx), Math.max(lastIndex, idx)];
    for (let i = a; i <= b; i++) selection.add(currentList[i].id);
  } else {
    if (selection.has(id)) selection.delete(id); else selection.add(id);
    lastIndex = idx;
  }
  updateSelectionUI();
}
function toggleSelectAll() {
  const allSel = currentList.length > 0 && currentList.every((m) => selection.has(m.id));
  if (allSel) currentList.forEach((m) => selection.delete(m.id));
  else currentList.forEach((m) => selection.add(m.id));
  updateSelectionUI();
}
function clearSelection() { selection.clear(); lastIndex = -1; updateSelectionUI(); }

function updateSelectionUI() {
  const n = selection.size;
  document.body.classList.toggle("has-selection", n > 0);
  document.querySelectorAll("#message-list .msg-row").forEach((r) => {
    r.classList.toggle("selected", selection.has(r.dataset.id));
  });
  const bar = $("#selection-bar");
  if (n > 0) {
    bar.classList.remove("hidden");
    $("#list-header").classList.add("hidden");
    $("#sel-count").textContent = `${n} selected`;
    const allSel = currentList.length > 0 && currentList.every((m) => selection.has(m.id));
    $("#sel-all").textContent = allSel ? "Deselect all" : "Select all";
    $("#sel-toinbox").style.display = state.view.type === "folder" ? "" : "none";
  } else {
    bar.classList.add("hidden");
    $("#list-header").classList.remove("hidden");
  }
}

async function bulkAction(act) {
  const ids = [...selection];
  if (!ids.length) return;
  await applyAction(ids, act);
  clearSelection();
}

// Unified action over a set of message ids: archive/trash/inbox = real Zoho
// moves; "toinbox" inside a virtual (rule) folder = a local override pin.
async function applyAction(ids, act) {
  ids = ids.filter(Boolean);
  if (!ids.length) return;

  if (act === "read" || act === "unread") {
    const makeRead = act === "read";
    if (pendingReadId && ids.includes(pendingReadId)) pendingReadId = null; // explicit override wins
    const changeIds = ids.filter((id) => { const m = findMsg(id); return m && m.unread === makeRead; });
    reflowList(() => { ids.forEach((id) => { const m = findMsg(id); if (m) m.unread = !makeRead; }); });
    clearSelection();
    for (const [acct, mids] of groupMessageIds(changeIds)) {
      const res = await api.setRead({ accountId: acct, messageIds: mids, read: makeRead });
      if (!res.ok) { toast(`Marked ${makeRead ? "read" : "unread"} locally — server update failed: ${res.error}`); return; }
    }
    if (ids.length) toast(`Marked ${ids.length} ${makeRead ? "read" : "unread"}`);
    return;
  }

  if (act === "toinbox" && state.view.type === "folder") {
    for (const id of ids) { const m = findMsg(id); if (m) await api.addOverride(`${m.account}|${m.messageId}`); }
    await loadOverrides();
    if (ids.includes(state.activeId)) closeReader();
    renderAll();
    toast(`Moved ${ids.length} to inbox`);
    return;
  }

  const target = act === "toinbox" ? "inbox" : act; // archive | trash | inbox
  const groups = groupMessageIds(ids);
  const verb = target === "trash" ? "Deleted" : target === "archive" ? "Archived" : "Moved to inbox";
  const actWord = target === "trash" ? "delete" : target === "archive" ? "archive" : "move";

  // Optimistic: drop the rows from the UI immediately so the click feels instant.
  // The server move runs after; if it fails we restore the messages and report it.
  const snapMsgs = MESSAGES.filter((m) => ids.includes(m.id));
  const snapFolder = folderViewMessages.filter((m) => ids.includes(m.id));
  if (ids.includes(state.activeId)) closeReader();
  removeIdsLocally(ids);
  renderAll();

  for (const [acct, mids] of groups) {
    let ok = false, err = "";
    try { const res = await api.moveMessages({ accountId: acct, messageIds: mids, target }); ok = !!(res && res.ok); err = res && res.error; }
    catch (e) { err = e.message; }
    if (!ok) {
      if (snapMsgs.length) MESSAGES = [...MESSAGES, ...snapMsgs].sort((a, b) => b.dateMs - a.dateMs);
      if (snapFolder.length) folderViewMessages = [...folderViewMessages, ...snapFolder].sort((a, b) => b.dateMs - a.dateMs);
      renderAll();
      toast(`Couldn't ${actWord} — restored. ${err || "server error"}`, { error: true });
      return;
    }
  }
  toast(`${verb} ${ids.length}`);
}

async function copyCode(code, id) {
  navigator.clipboard.writeText(code).catch(() => {});
  const m = findMsg(id);
  let cleared = false;
  if (m) {
    const res = await api.moveMessages({ accountId: m.account, messageIds: [m.messageId], target: "trash" });
    if (res.ok) { removeIdsLocally([id]); cleared = true; }
  }
  if (state.activeId === id) closeReader();
  renderAll();
  toast(cleared ? `Copied ${code} · cleared` : `Copied ${code}`);
}

// ── Reader ──────────────────────────────────────────────────────────────────
function stripHtml(html) {
  const tmp = document.createElement("div");
  tmp.innerHTML = html;
  tmp.querySelectorAll("script,style,head").forEach((n) => n.remove());
  return (tmp.textContent || "").replace(/\n{3,}/g, "\n\n").trim();
}

function sanitizeUrl(u) {
  if (!u) return null;
  u = u.trim();
  return /^(https?:|mailto:)/i.test(u) ? u : null;
}

// Replace cid: references in the HTML with data URIs by fetching the matching
// inline attachment parts. Returns the rewritten HTML.
async function inlineCidImages(html, m, attachments) {
  const refs = (attachments || []).filter((a) => a.inline && a.contentId && html.includes("cid:" + a.contentId));
  if (!refs.length) return html;
  const pairs = await Promise.all(refs.map(async (a) => {
    try {
      let b64 = a.data ? a.data.replace(/-/g, "+").replace(/_/g, "/") : null; // gmail base64url → base64
      if (!b64) {
        const res = await api.fetchAttachment({ accountId: m.account, folderId: m.folderId, messageId: m.messageId, attachmentId: a.id });
        if (!res.ok) return null;
        b64 = res.base64;
      }
      return [a.contentId, `data:${a.mimeType || "image/png"};base64,${b64}`];
    } catch { return null; }
  }));
  pairs.filter(Boolean).forEach(([cid, uri]) => {
    const esc = cid.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    html = html.replace(new RegExp("cid:" + esc, "g"), uri);
  });
  return html;
}

// Baseline styling injected into the sandboxed email frame so plain/minimal
// emails read cleanly and nothing overflows the pane.
const EMAIL_RESET_CSS = `
  html,body{margin:0;padding:0;background:#fff;color:#1a1d21;
    font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Helvetica,Arial,sans-serif;
    font-size:14px;line-height:1.6;-webkit-text-size-adjust:100%;overflow-x:hidden;}
  img{max-width:100%;height:auto;border:0;}
  a{color:#2563eb;}
`;

// Sanitize raw email HTML (defense-in-depth on top of the iframe sandbox) and
// build a full srcdoc: strip scripts/objects/refresh + event handlers + js:
// URLs, force links to open in a new context, inject the baseline reset.
function buildEmailSrcdoc(html) {
  const doc = document.implementation.createHTMLDocument("");
  doc.documentElement.innerHTML = html || "";
  doc.querySelectorAll("script,noscript,iframe,object,embed,base,link[rel=import]").forEach((n) => n.remove());
  doc.querySelectorAll("meta").forEach((mt) => { if (/refresh/i.test(mt.getAttribute("http-equiv") || "")) mt.remove(); });
  doc.querySelectorAll("*").forEach((el) => {
    [...el.attributes].forEach((attr) => {
      const n = attr.name.toLowerCase();
      if (n.startsWith("on")) el.removeAttribute(attr.name);
      if ((n === "href" || n === "src" || n === "background" || n === "srcset") && /^\s*(javascript:|vbscript:|data:text\/html)/i.test(attr.value)) el.removeAttribute(attr.name);
    });
  });
  const base = doc.createElement("base"); base.setAttribute("target", "_blank"); doc.head.prepend(base);
  const style = doc.createElement("style"); style.textContent = EMAIL_RESET_CSS; doc.head.appendChild(style);
  return "<!doctype html>" + doc.documentElement.outerHTML;
}

// Size the email frame so it never shows its own scrollbars: give the content
// its natural width, scale the whole frame down to fit the pane, and reserve
// the scaled height on the host. Re-measured as images load / the pane resizes.
function sizeEmailFrame(iframe, host) {
  try {
    const d = iframe.contentDocument || iframe.contentWindow.document;
    const avail = host.clientWidth;
    if (!avail) return;
    // Lay out at pane width first, then see if anything is intrinsically wider.
    iframe.style.transform = "none";
    iframe.style.width = avail + "px";
    const natural = Math.max(d.body.scrollWidth, d.documentElement.scrollWidth, 1);
    let scale = 1;
    if (natural > avail + 1) { iframe.style.width = natural + "px"; scale = avail / natural; }
    const h = Math.max(d.body.scrollHeight, d.documentElement.scrollHeight, 40);
    iframe.style.height = h + "px";
    iframe.style.transformOrigin = "top left";
    iframe.style.transform = scale < 1 ? `scale(${scale})` : "none";
    host.style.height = Math.ceil(h * scale) + "px";
  } catch {}
}

const FILE_KB = (n) => n < 1024 ? `${n} B` : n < 1024 * 1024 ? `${(n / 1024).toFixed(0)} KB` : `${(n / 1024 / 1024).toFixed(1)} MB`;

function attachmentsHtml(attachments) {
  const files = (attachments || []).filter((a) => !a.inline);
  if (!files.length) return "";
  const rows = files.map((a, i) => `
    <div class="r-att" data-idx="${i}" title="Open ${escapeHtml(a.name)}">
      <span class="r-att-icon"><svg width="15" height="15" viewBox="0 0 16 16" fill="none"><path d="M4 2.5h5L12.5 6v7.5H4z" stroke="currentColor" stroke-width="1.2" stroke-linejoin="round"/><path d="M9 2.5V6h3.5" stroke="currentColor" stroke-width="1.2" stroke-linejoin="round"/></svg></span>
      <span class="r-att-meta"><span class="r-att-name">${escapeHtml(a.name)}</span><span class="r-att-size">${FILE_KB(a.size || 0)}</span></span>
      <button class="r-att-dl" data-idx="${i}" title="Download" type="button"><svg width="14" height="14" viewBox="0 0 16 16" fill="none"><path d="M8 3v7M8 10L5.5 7.5M8 10l2.5-2.5M3.5 12.5h9" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" stroke-linejoin="round"/></svg></button>
    </div>`).join("");
  return `<div class="r-attachments"><div class="r-att-head">${files.length} attachment${files.length > 1 ? "s" : ""}</div>${rows}</div>`;
}

async function downloadAttachment(m, a, openAfter) {
  const res = await api.fetchAttachment({ accountId: m.account, folderId: m.folderId, messageId: m.messageId, attachmentId: a.id });
  if (!res.ok) return;
  if (openAfter) await api.openFile({ name: a.name, base64: res.base64 });
  else await api.saveFile({ name: a.name, base64: res.base64 });
}

// ── In-app attachment preview (PDF / image / text) ───────────────────────────
function previewKind(mime, name) {
  const m = (mime || "").toLowerCase();
  const ext = (name || "").toLowerCase().split(".").pop();
  if (m.startsWith("image/") || ["png", "jpg", "jpeg", "gif", "webp", "bmp", "svg"].includes(ext)) return "image";
  if (m === "application/pdf" || ext === "pdf") return "pdf";
  if (m.startsWith("text/") || ["txt", "csv", "log", "md", "json", "xml", "ics"].includes(ext)) return "text";
  return null; // not natively previewable — fall back to Open/Download
}
function b64ToBytes(b64) {
  const bin = atob(b64 || "");
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return bytes;
}
let attPreviewUrl = null;
function attPreviewEsc(e) { if (e.key === "Escape") closeAttPreview(); }
function closeAttPreview() {
  const ov = document.getElementById("att-pv");
  if (ov) ov.remove();
  if (attPreviewUrl) { URL.revokeObjectURL(attPreviewUrl); attPreviewUrl = null; }
  document.removeEventListener("keydown", attPreviewEsc);
}
async function openAttachmentPreview(m, a) {
  closeAttPreview();
  const kind = previewKind(a.mimeType, a.name);
  const ov = document.createElement("div");
  ov.id = "att-pv";
  ov.className = "att-pv-overlay";
  ov.innerHTML = `
    <div class="att-pv-panel">
      <div class="att-pv-head">
        <div class="att-pv-title">${escapeHtml(a.name)}<span class="att-pv-size">${FILE_KB(a.size || 0)}</span></div>
        <div class="att-pv-actions">
          <button class="att-pv-btn" id="att-pv-open" type="button">Open in app</button>
          <button class="att-pv-btn" id="att-pv-dl" type="button">Download</button>
          <button class="att-pv-x" id="att-pv-close" type="button" aria-label="Close">✕</button>
        </div>
      </div>
      <div class="att-pv-body" id="att-pv-body"><div class="att-pv-msg">Loading…</div></div>
    </div>`;
  document.body.appendChild(ov);
  document.addEventListener("keydown", attPreviewEsc);
  ov.addEventListener("click", (e) => { if (e.target === ov) closeAttPreview(); });
  $("#att-pv-close").addEventListener("click", closeAttPreview);
  $("#att-pv-dl").addEventListener("click", () => downloadAttachment(m, a, false));
  $("#att-pv-open").addEventListener("click", () => downloadAttachment(m, a, true));

  const body = $("#att-pv-body");
  if (!kind) { body.innerHTML = `<div class="att-pv-msg">No inline preview for this file type.<br>Use <b>Open in app</b> or <b>Download</b>.</div>`; return; }
  try {
    const res = await api.fetchAttachment({ accountId: m.account, folderId: m.folderId, messageId: m.messageId, attachmentId: a.id });
    if (!document.getElementById("att-pv")) return; // closed while loading
    if (!res || !res.ok) { body.innerHTML = `<div class="att-pv-msg">Couldn’t load this attachment.</div>`; return; }
    const bytes = b64ToBytes(res.base64);
    if (kind === "text") {
      const pre = document.createElement("pre");
      pre.className = "att-pv-text";
      pre.textContent = new TextDecoder("utf-8").decode(bytes).slice(0, 200000);
      body.innerHTML = ""; body.appendChild(pre);
      return;
    }
    const blob = new Blob([bytes], { type: a.mimeType || (kind === "pdf" ? "application/pdf" : "application/octet-stream") });
    attPreviewUrl = URL.createObjectURL(blob);
    body.innerHTML = kind === "image"
      ? `<img class="att-pv-img" src="${attPreviewUrl}" alt="${escapeHtml(a.name)}"/>`
      : `<iframe class="att-pv-frame" src="${attPreviewUrl}" title="${escapeHtml(a.name)}"></iframe>`;
  } catch (e) {
    body.innerHTML = `<div class="att-pv-msg">Couldn’t preview: ${escapeHtml(e.message)}</div>`;
  }
}

function findUnsubscribe(html) {
  const tmp = document.createElement("div");
  tmp.innerHTML = html;
  let found = null;
  tmp.querySelectorAll("a[href]").forEach((a) => {
    if (found) return;
    const href = a.getAttribute("href") || "";
    const txt = a.textContent || "";
    if (/unsub|opt[-\s]?out|email[-\s]?preferenc|manage[-\s]?preferenc|notification[-\s]?setting/i.test(href + " " + txt)) {
      const u = sanitizeUrl(href);
      if (u) found = u;
    }
  });
  return found;
}

// ── Message-body cache ───────────────────────────────────────────────────────
// Fetching a body hits Yahoo IMAP (downloads the full MIME source + parses it),
// which is the slow "Loading…" you see. Cache results by messageId so re-opens are
// instant, dedupe in-flight requests, and let row hover warm the cache pre-click.
const BODY_CACHE_MAX = 120;
const bodyCache = new Map();     // messageId -> fetchBody result (successes only)
const bodyInflight = new Map();  // messageId -> in-flight Promise

function loadBody(m) {
  const key = m && m.messageId;
  const args = { accountId: m.account, folderId: m.folderId, messageId: m.messageId };
  if (!key) return api.fetchBody(args).catch((e) => ({ ok: false, error: e && e.message || String(e) }));
  const hit = bodyCache.get(key);
  if (hit) { bodyCache.delete(key); bodyCache.set(key, hit); return Promise.resolve(hit); } // LRU bump
  const flying = bodyInflight.get(key);
  if (flying) return flying;
  const p = api.fetchBody(args)
    .then((res) => {
      if (res && res.ok) {
        bodyCache.set(key, res);
        if (bodyCache.size > BODY_CACHE_MAX) bodyCache.delete(bodyCache.keys().next().value);
      }
      return res;
    })
    .catch((e) => ({ ok: false, error: e && e.message || String(e) }))
    .finally(() => bodyInflight.delete(key));
  bodyInflight.set(key, p);
  return p;
}
// Fire-and-forget warm-up (row hover). No-op if already cached or in flight.
function prefetchBody(m) {
  if (!m || !m.messageId || bodyCache.has(m.messageId) || bodyInflight.has(m.messageId)) return;
  loadBody(m);
}

async function openMessage(id) {
  const m = findMsg(id);
  if (!m) return;
  if (state.activeId === id) return;
  const first = captureRows();
  const fallingId = pendingReadId; // previously-open unread message, about to fall
  // Leaving the previously-open unread message commits its read → it falls down.
  commitPendingRead();
  // The newly-opened message: if unread, stay highlighted in Unread until we
  // move on (don't mark read yet).
  if (m.unread) pendingReadId = id;
  state.activeId = id;

  const c = $("#reader-content");
  c.innerHTML = readerHeaderHtml(m) + `<div class="r-body"><p style="color:var(--text-tertiary)">Loading…</p></div>`;
  $("#reader").classList.remove("hidden", "reader-idle");
  document.body.classList.add("reader-open");
  hydrateAvatars(c);
  renderRail();
  renderList();
  // Animate the just-committed message falling into Read (ghost if collapsed).
  flipFrom(first, fallingId);

  let html = "";
  let attachments = [];
  let loadError = false;
  const res = await loadBody(m);   // cached/deduped; never rejects
  if (res && res.ok) { html = res.body.html || escapeHtml(res.body.text || "").replace(/\n/g, "<br>"); attachments = res.body.attachments || []; }
  else { html = `<p>(Could not load message: ${escapeHtml(res ? res.error : "unknown")})</p>`; loadError = true; }
  if (state.activeId !== id) return;

  const plain = stripHtml(html);
  let code = m.code;
  if (m.category === "code" && !code) {
    const bm = plain.match(/\b(\d{4,8})\b/);
    if (bm) { code = bm[1]; m.code = code; }
  }

  const unsubUrl = findUnsubscribe(html);
  // Embed cid: images (logos/signatures) as data URIs before rendering.
  if (!loadError) { try { html = await inlineCidImages(html, m, attachments); } catch {} }
  if (state.activeId !== id) return;

  let inner = "";
  if (m.category === "code" && code) {
    inner += `<div class="r-code-block">
      <div class="r-code-label">Verification code</div>
      <div class="r-code-value">${code}</div>
      <button class="r-code-copy" data-copy="${code}" data-id="${m.id}">${copyIconSvg()} Copy code &amp; clear</button>
    </div>`;
  }
  if (unsubUrl) {
    inner += `<button class="r-unsub" data-url="${escapeHtml(unsubUrl)}"><svg width="13" height="13" viewBox="0 0 16 16" fill="none"><circle cx="8" cy="8" r="5.5" stroke="currentColor" stroke-width="1.3"/><path d="M5.5 8H10.5" stroke="currentColor" stroke-width="1.3" stroke-linecap="round"/></svg> Unsubscribe</button>`;
  }
  inner += attachmentsHtml(attachments);
  inner += `<div class="r-body" id="r-body-host"></div>`;

  c.innerHTML = readerHeaderHtml(m) + inner;
  hydrateAvatars(c);

  // Render the email HTML inside a sandboxed, auto-sized iframe (no scripts;
  // images load by default; links open externally via the window-open handler).
  const host = c.querySelector("#r-body-host");
  if (host) {
    const iframe = document.createElement("iframe");
    iframe.className = "r-frame";
    iframe.setAttribute("sandbox", "allow-same-origin allow-popups allow-popups-to-escape-sandbox");
    iframe.setAttribute("referrerpolicy", "no-referrer");
    iframe.setAttribute("scrolling", "no");
    const refit = () => sizeEmailFrame(iframe, host);
    iframe.addEventListener("load", () => {
      refit();
      try {
        const d = iframe.contentDocument;
        d.querySelectorAll("img").forEach((img) => { if (!img.complete) img.addEventListener("load", refit, { once: true }); });
        if (window.ResizeObserver) { const ro = new ResizeObserver(refit); ro.observe(d.body); ro.observe(host); }
      } catch {}
      setTimeout(refit, 250);
      setTimeout(refit, 900);
    });
    const isEmpty = !stripHtml(html).trim() && !/<img/i.test(html);
    iframe.srcdoc = buildEmailSrcdoc(isEmpty ? `<p style="color:#9aa0a8">(empty message)</p>` : html);
    host.appendChild(iframe);
  }

  // Attachment chips: click = open in default app, download glyph = save.
  const files = (attachments || []).filter((a) => !a.inline);
  c.querySelectorAll(".r-att").forEach((el) => {
    const a = files[Number(el.dataset.idx)];
    if (!a) return;
    el.addEventListener("click", (e) => { if (e.target.closest(".r-att-dl")) return; openAttachmentPreview(m, a); });
  });
  c.querySelectorAll(".r-att-dl").forEach((btn) => {
    const a = files[Number(btn.dataset.idx)];
    if (!a) return;
    btn.addEventListener("click", (e) => { e.stopPropagation(); downloadAttachment(m, a, false); });
  });

  const unsubBtn = c.querySelector(".r-unsub");
  if (unsubBtn) unsubBtn.addEventListener("click", () => api.openExternal(unsubBtn.getAttribute("data-url")));
  const copyBtn = c.querySelector(".r-code-copy");
  if (copyBtn) copyBtn.addEventListener("click", () => copyCode(copyBtn.getAttribute("data-copy"), copyBtn.getAttribute("data-id")));
}

function readerHeaderHtml(m) {
  return `
    <div class="r-subject">${escapeHtml(cleanName(m.subject))}</div>
    <div class="r-meta">
      ${avatarHtml(cleanName(m.fromName), m.fromEmail, "avatar-lg")}
      <div class="r-from">
        <div class="r-from-name">${escapeHtml(cleanName(m.fromName))}</div>
        <div class="r-from-addr">${escapeHtml(m.fromEmail)}</div>
      </div>
      <div class="r-time">${m.time}</div>
    </div>`;
}

function closeReader() {
  state.activeId = null;
  commitPendingRead();
  document.body.classList.remove("reader-open");
  document.querySelectorAll("#message-list .msg-row.active").forEach((r) => r.classList.remove("active"));
  syncReader();
}
// User-initiated deselect (close button / void click / Escape): commit the
// pending read and animate it falling to the Read section.
function deselectMessage() {
  if (state.activeId == null) return;
  const fallingId = pendingReadId; // the message about to be committed → falls to Read
  const first = captureRows();
  closeReader();
  renderAll();
  flipFrom(first, fallingId);
}

// Drawer is a persistent inline pane: when no email is selected it shows an
// empty state ("No email selected", or the Inbox-Zero line when the view is
// empty). The bottom Drawer stays hidden until a message is opened.
function readerEmptyMessage() {
  // Inbox Zero only on the actual Inbox, only when it's done loading AND truly empty.
  const trulyEmptyInbox = state.view.type === "inbox" && !state.loading && visibleMessages().length === 0;
  return trulyEmptyInbox
    ? "You have reached the holy state of Inbox Zero."
    : "No email selected";
}
function syncReader() {
  const reader = $("#reader");
  if (!reader) return;
  if (state.layout === "pane") { // Reading Pane: persistent inline pane with an idle state
    reader.classList.remove("hidden");
    if (state.activeId == null) {
      reader.classList.add("reader-idle");
      const t = $("#reader-empty-text"); if (t) t.textContent = readerEmptyMessage();
    } else {
      reader.classList.remove("reader-idle");
    }
  } else {
    reader.classList.remove("reader-idle");
    reader.classList.toggle("hidden", state.activeId == null);
  }
}

// ── View / render ───────────────────────────────────────────────────────────
function setView(v) {
  state.view = v;
  selection.clear(); lastIndex = -1;
  sectionExpanded.clear();
  folderCursor = { cursor: null, hasMore: false };   // each server-folder view starts fresh
  folderViewMessages = []; folderViewError = null;
  closeReader();
  renderAll();
  if (isServerFolderView()) loadFolderView();
  if (v.type === "cleanup" && (cleanup.account !== state.activeAccount || cleanup.phase === "idle")) cleanupIndex();
  savePrefs();
}
function renderAll() { renderRail(); renderList(); renderTriagePills(); }

// Pull up to LOAD_CHUNK messages from `cursor`, fetched in provider-safe
// sub-pages so we never trip a provider's per-call cap (which would otherwise
// look like "no more" and silently miss mail).
async function fetchChunk(accountId, scope, startCursor) {
  const out = [];
  let cursor = startCursor, error = null;
  do {
    const res = await api.fetchPage({ accountId, scope, cursor, limit: REQUEST_PAGE });
    if (res.error) { error = res.error; break; }
    out.push(...(res.messages || []));
    cursor = res.nextCursor || null;
  } while (cursor && out.length < LOAD_CHUNK);
  return { messages: out, cursor, hasMore: !!cursor, error };
}
async function loadFolderView() {
  const scope = viewServerScope();
  if (!scope) { folderViewMessages = []; folderCursor = { cursor: null, hasMore: false }; renderList(); return; }
  state.loading = true; renderList();
  try {
    const r = await fetchChunk(state.activeAccount, scope, null);
    folderCursor = { cursor: r.cursor, hasMore: r.hasMore };
    folderViewMessages = r.messages.map((m) => ({ ...m, ...classify(m) }));
    folderViewError = r.error || null;
    if (r.error) toast(r.error, { error: true });
    hydrateSnippets(folderViewMessages);
  } catch (err) {
    folderCursor = { cursor: null, hasMore: false };
    toast(`Couldn't load ${scope}: ${err.message}`, { error: true });
  } finally {
    state.loading = false; renderList();
  }
}
// Append the next chunk of the current server-folder view.
async function loadMoreFolder() {
  if (!folderCursor.hasMore) return;
  const r = await fetchChunk(state.activeAccount, viewServerScope(), folderCursor.cursor);
  folderCursor = { cursor: r.cursor, hasMore: r.hasMore };
  if (r.error) { toast(r.error, { error: true }); return; }
  const have = new Set(folderViewMessages.map((m) => m.id));
  const fresh = r.messages.map((m) => ({ ...m, ...classify(m) })).filter((m) => !have.has(m.id));
  folderViewMessages = [...folderViewMessages, ...fresh];
  hydrateSnippets(folderViewMessages);
}

// ── Data loading ────────────────────────────────────────────────────────────
async function loadAccounts() {
  accountsList = await api.listAccounts();
  if (!acctById(state.activeAccount)) state.activeAccount = accountsList[0] ? accountsList[0].id : null;
}

async function loadFolders() {
  FOLDERS = await api.listFolders(state.activeAccount);
}

async function loadOverrides() {
  OVERRIDES = new Set(await api.getOverrides());
}

// AI organize sweep (the spark button): deep-scan the mailbox, cluster senders
// into vendors, auto-build a folder per vendor. Undo reverts the new folders.
async function aiOrganize() {
  if (!accountsList.length) return;
  const btn = $("#ai-organize-btn");
  if (btn.classList.contains("busy")) return;
  btn.classList.add("busy");
  selection.clear(); lastIndex = -1;
  if (state.view.type !== "inbox") setView({ type: "inbox" });
  cinemaBegin();
  try {
    // Tally senders across the WHOLE server inbox so organize sees every repeat
    // vendor (not just what's loaded). Falls back to loaded mail if unsupported.
    let senders = null;
    try { const t = await api.senderTally({ accountId: state.activeAccount, limit: 4000, top: 150 }); senders = t && t.senders; } catch {}
    if (!senders || !senders.length) {
      if (activeMessages().length < 400) {
        const scan = await api.deepScan({ limit: 400 });
        if (scan.messages && scan.messages.length) MESSAGES = scan.messages.map((m) => ({ ...m, ...classify(m), box: "inbox" }));
      }
      senders = sendersWithCounts();
    }
    renderList(); // the scan head adapts to the loaded list
    const res = await api.autoOrganize({ senders, accountId: state.activeAccount });
    if (!res.ok) { cinemaEnd(); toast(`Organize failed: ${res.error}`); return; }
    const created = res.created || [];
    await loadFolders();
    state.foldersExpanded = true;   // reveal every new folder so each can light up
    renderRail();
    await cinemaReveal(created);     // Act 3: real vendor names + rows filing into folders
    cinemaEnd();
    // Mail was moved server-side — resync the inbox so the filed rows are gone.
    await loadInbox();
    await loadFolders(); renderRail();

    if (created.length === 0) { toast(res.filed ? `Filed ${res.filed} emails` : "No new vendor folders found"); return; }
    const summary = res.serverFiling
      ? `Filed ${res.filed} email${res.filed === 1 ? "" : "s"} into ${created.length} folder${created.length === 1 ? "" : "s"}`
      : `Built ${created.length} folder${created.length === 1 ? "" : "s"}`;
    toast(summary, {
      label: "Undo all",
      fn: async () => {
        for (const c of created) {
          if (res.serverFiling) await api.unfileFolder({ accountId: state.activeAccount, name: c.name, id: c.id });
          else await api.removeFolder(c.id);
        }
        if (state.view.type === "folder" && created.some((c) => c.id === state.view.id)) state.view = { type: "inbox" };
        await loadInbox(); await loadFolders(); renderAll();
        toast("Reverted");
      },
    });
  } catch (err) {
    cinemaEnd();
    toast(`Organize failed: ${err.message}`);
  } finally {
    btn.classList.remove("busy");
  }
}

// Collapse every folder back into the inbox and delete them (reverses
// auto-organize). Lossless — mail returns to Inbox, nothing trashed. Two-step
// confirm via the toast action, since it touches the whole mailbox.
async function collapseAllFolders() {
  const n = FOLDERS.length;
  if (!n) { toast("No folders to remove"); return; }
  toast(`Move ${n} folders’ mail back to Inbox and delete the folders?`, {
    warn: true,
    label: "Move & delete",
    fn: async () => {
      const btn = $("#collapse-folders-btn");
      if (btn) btn.classList.add("busy");
      if (state.view.type === "folder") setView({ type: "inbox" }); // don't sit on a folder being deleted
      const total0 = FOLDERS.length;
      toast(`Emptying folders into Inbox… 0 / ${total0} — don’t restart.`, { sticky: true });
      // Live progress: each tick drops the just-deleted folder from the sidebar.
      const off = api.onCollapseProgress((p) => {
        if (p.folder) { FOLDERS = FOLDERS.filter((f) => f.name !== p.folder); renderRail(); }
        toast(`Emptying folders into Inbox… ${p.done} / ${p.total} · moved ${p.moved.toLocaleString()} email${p.moved === 1 ? "" : "s"} — don’t restart.`, { sticky: true });
      });
      try {
        const r = await api.collapseFolders({ accountId: state.activeAccount });
        if (!r.ok) { toast(`Couldn’t remove folders: ${r.error}`, { error: true }); return; }
        await loadInbox(); await loadFolders(); renderAll();
        const tail = r.failed && r.failed.length ? ` · ${r.failed.length} couldn’t be deleted` : "";
        toast(`Moved ${r.moved.toLocaleString()} email${r.moved === 1 ? "" : "s"} to Inbox, deleted ${r.deleted} folder${r.deleted === 1 ? "" : "s"}${tail}`);
      } catch (e) {
        toast(`Couldn’t remove folders: ${e.message}`, { error: true });
      } finally {
        if (off) off();
        if (btn) btn.classList.remove("busy");
      }
    },
  });
}

// ── AI organize: cinematic sequence (scan beam + narration + filing reflow) ───
// Act 1: a "read head" sweeps down the list, illuminating each row in turn
//        (the list auto-scrolls to follow it) — looks like the AI reading.
// Act 2: a terminal-style caption narrates — generic while we wait, then the
//        real vendor names once Haiku returns.
// Act 3: rows that got filed slide off toward the sidebar, whose folders pulse.
const AI_CINEMA = { ROW_STEP_MS: 50, AMBIENT_DWELL_MS: 950, TYPE_MS: 16, FILE_STAGGER_MS: 55 };
const AI_AMBIENT_LINES = ["Analyzing senders…", "Clustering by vendor…", "Matching patterns…", "Grouping newsletters…", "Reading subjects…"];
let cinema = null;
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

function cinemaBegin() {
  const narr = document.createElement("div");
  narr.id = "ai-narration";
  narr.innerHTML = `<span class="ai-narr-spark">${sparkSvg()}</span><span class="ai-narr-text"></span><span class="ai-caret"></span>`;
  $("#list-header").insertAdjacentElement("afterend", narr);
  document.body.classList.add("ai-organizing");
  cinema = { running: true, scanning: true, ambient: true, idx: 0, queue: [], headTimer: null, typeTimer: null };
  cinemaPush(`Reading ${currentList.length || "your"} messages…`);
  cinemaTypeEngine();
  cinemaScanLoop();
}

function cinemaEnd() {
  if (!cinema) return;
  cinema.running = false;
  clearTimeout(cinema.headTimer); clearTimeout(cinema.typeTimer);
  const narr = $("#ai-narration"); if (narr) narr.remove();
  document.body.classList.remove("ai-organizing");
  document.querySelectorAll(".msg-row.ai-head, .msg-row.ai-scanned, .msg-row.ai-filing")
    .forEach((r) => r.classList.remove("ai-head", "ai-scanned", "ai-filing"));
  cinema = null;
}

// The sweeping read head (Act 1). Re-queries rows each tick so it adapts when
// the deep scan replaces the list with the full set.
function cinemaScanLoop() {
  const list = $("#message-list");
  const tick = () => {
    if (!cinema || !cinema.running) return;
    if (cinema.scanning) {
      const rows = [...list.querySelectorAll(".msg-row")];
      if (rows.length) {
        const i = cinema.idx % rows.length;
        rows.forEach((r, j) => {
          const d = i - j;
          r.classList.toggle("ai-head", j === i);
          r.classList.toggle("ai-scanned", d > 0 && d <= 5);
        });
        const row = rows[i];
        list.scrollTop = row.offsetTop - list.clientHeight / 2 + row.offsetHeight / 2;
        cinema.idx++;
        if (i === rows.length - 1) rows.forEach((r) => r.classList.remove("ai-head", "ai-scanned"));
      }
    }
    cinema.headTimer = setTimeout(tick, AI_CINEMA.ROW_STEP_MS);
  };
  tick();
}

// Terminal narration (Act 2). Pulls lines off a queue; refills with generic
// lines while ambient, then types the real results verbatim.
function cinemaPush(line) { if (cinema) cinema.queue.push(line); }
function cinemaTypeEngine() {
  if (!cinema || !cinema.running) return;
  const el = $("#ai-narration") && $("#ai-narration").querySelector(".ai-narr-text");
  if (!el) return;
  if (!cinema.queue.length) {
    if (cinema.ambient) cinema.queue.push(AI_AMBIENT_LINES[(cinema.idx >> 2) % AI_AMBIENT_LINES.length]);
    else { return; }
  }
  const text = cinema.queue.shift();
  let k = 0;
  el.textContent = "";
  const type = () => {
    if (!cinema || !cinema.running) return;
    el.textContent = text.slice(0, ++k);
    if (k < text.length) { cinema.typeTimer = setTimeout(type, AI_CINEMA.TYPE_MS); }
    else { cinema.typeTimer = setTimeout(cinemaTypeEngine, cinema.ambient ? AI_CINEMA.AMBIENT_DWELL_MS : 420); }
  };
  type();
}

// Act 3 reveal: switch narration to real vendors, freeze the head, then file
// the matching rows into their folders.
async function cinemaReveal(created) {
  if (!cinema) return;
  cinema.ambient = false;
  cinema.scanning = false;
  cinema.queue = [];
  document.querySelectorAll(".msg-row.ai-head, .msg-row.ai-scanned").forEach((r) => r.classList.remove("ai-head", "ai-scanned"));
  if (created.length) {
    created.forEach((c) => cinemaPush(`→ ${c.name}`));
    cinemaPush(`Filed into ${created.length} folder${created.length === 1 ? "" : "s"}.`);
  } else {
    cinemaPush("Already organized — nothing new.");
  }
  await wait(700);
  await cinemaFileRows(created);
}

function cinemaFileRows(created) {
  const ids = new Set(created.map((c) => c.id));
  const rows = [...$("#message-list").querySelectorAll(".msg-row")].filter((row) => {
    const m = findMsg(row.dataset.id); const f = m && folderForMessage(m);
    return f && ids.has(f.id);
  });
  if (!rows.length) return wait(400);
  rows.forEach((row, i) => setTimeout(() => {
    if (!cinema) return;
    row.classList.add("ai-filing");
    const f = folderForMessage(findMsg(row.dataset.id));
    if (f) cinemaPulseFolder(f.id);
  }, i * AI_CINEMA.FILE_STAGGER_MS));
  return wait(rows.length * AI_CINEMA.FILE_STAGGER_MS + 650);
}

function cinemaPulseFolder(id) {
  const el = document.querySelector('.rail-row[data-folder-id="' + CSS.escape(id) + '"]');
  if (!el) return;
  el.classList.remove("ai-filed"); void el.offsetWidth; el.classList.add("ai-filed");
}

function moveToInbox(id) { applyAction([id], "toinbox"); }

// ── Smart folder creation (Feature 1) ───────────────────────────────────────
// ── Theme folders: name → AI match → review → file ───────────────────────────
let themeFolder = null; // { step: "name"|"finding"|"review", name, progress, rows }
function openThemeModal() {
  themeFolder = { step: "name", name: "", progress: null, rows: [] };
  $("#folder-modal").classList.remove("hidden");
  renderThemeModal();
}
function closeThemeModal() { $("#folder-modal").classList.add("hidden"); themeFolder = null; closeSubjectPopover(); }

function renderThemeModal() {
  const card = $("#folder-card");
  if (!card || !themeFolder) return;
  const t = themeFolder;
  if (t.step === "name") {
    card.innerHTML = `
      <div class="folder-card-title">New theme folder</div>
      <p class="folder-card-hint">Name a theme — e.g. <b>Custody</b>, <b>School</b>, <b>Health</b> — and Claude finds which inbox senders fit. Or just <b>create an empty folder</b> and file mail into it yourself.</p>
      <input type="text" id="theme-name" placeholder="e.g. Custody, School, Health" autocomplete="off" />
      <div class="folder-card-foot">
        <button class="ghost-btn" id="theme-cancel" type="button">Cancel</button>
        <button class="ghost-btn" id="theme-empty" type="button">Create empty</button>
        <button class="send-btn" id="theme-find" type="button">Find matches →</button>
      </div>`;
    const input = $("#theme-name");
    input.value = t.name;
    setTimeout(() => input.focus(), 30);
    input.addEventListener("keydown", (e) => { if (e.key === "Enter") themeFind(); });
    $("#theme-find").addEventListener("click", themeFind);
    $("#theme-empty").addEventListener("click", themeCreateEmpty);
    $("#theme-cancel").addEventListener("click", closeThemeModal);
  } else if (t.step === "finding") {
    const p = t.progress; let sub = "Reading inbox…", pct = null;
    if (p && p.phase === "scan") sub = `${(p.done || 0).toLocaleString()} messages read`;
    else if (p && p.phase === "match") { sub = `matching senders… batch ${p.done} / ${p.total}`; pct = p.total ? Math.round(p.done / p.total * 100) : 0; }
    card.innerHTML = `
      <div class="folder-card-title">Finding “${escapeHtml(t.name)}” mail…</div>
      <div class="theme-finding"><div class="cu-spinner"></div><div class="folder-card-hint">${escapeHtml(sub)}${pct != null ? ` · ${pct}%` : ""}</div></div>`;
  } else if (t.step === "review") {
    const rows = t.rows.filter((r) => !r.dismissed);
    const sel = rows.filter((r) => r.selected);
    const totalMail = sel.reduce((n, r) => n + r.count, 0);
    const promoCount = rows.filter((r) => r.promo).length;
    card.innerHTML = `
      <div class="folder-card-title">${escapeHtml(t.name)} — ${rows.length} sender${rows.length === 1 ? "" : "s"} matched</div>
      <p class="folder-card-hint">${promoCount ? `${promoCount} likely-marketing sender${promoCount === 1 ? " is" : "s are"} pre-unchecked — re-check any you want. ` : ""}Uncheck anything else that doesn’t belong, then file. Click the eye to preview subjects.</p>
      <div class="theme-rows">${rows.length ? rows.map(themeRowHtml).join("") : `<div class="cu-empty">No matching senders found.</div>`}</div>
      <div class="folder-card-foot">
        <button class="ghost-btn" id="theme-cancel" type="button">Cancel</button>
        <button class="${rows.length ? "ghost-btn" : "send-btn"}" id="theme-empty" type="button">Create empty${rows.length ? "" : " folder →"}</button>
        ${rows.length ? `<button class="send-btn" id="theme-file" type="button" ${sel.length ? "" : "disabled"}>File ${totalMail.toLocaleString()} email${totalMail === 1 ? "" : "s"} →</button>` : ""}
      </div>`;
    $("#theme-cancel").addEventListener("click", closeThemeModal);
    const fileBtn = $("#theme-file"); if (fileBtn) fileBtn.addEventListener("click", themeFile);
    const emptyBtn = $("#theme-empty"); if (emptyBtn) emptyBtn.addEventListener("click", themeCreateEmpty);
    card.querySelectorAll(".theme-row").forEach((rowEl) => {
      const row = t.rows.find((r) => r.id === rowEl.getAttribute("data-id"));
      if (!row) return;
      rowEl.querySelector(".cu-check").addEventListener("change", (e) => { row.selected = e.target.checked; renderThemeModal(); });
      rowEl.querySelector(".cu-eye").addEventListener("click", (e) => { e.stopPropagation(); openSubjectPopover(e.currentTarget, row); });
    });
  }
}
function themeRowHtml(r) {
  return `<div class="theme-row${r.promo ? " theme-row-promo" : ""}" data-id="${r.id}">
    <input type="checkbox" class="cu-check" ${r.selected ? "checked" : ""}/>
    <div class="theme-row-main">
      <div class="theme-row-name"><span class="theme-row-label">${escapeHtml(cleanName(r.name || r.email))}</span>${r.promo ? `<span class="cu-badge theme-promo-badge">marketing</span>` : ""}</div>
      <div class="theme-row-addr">${escapeHtml(r.email)}</div>
    </div>
    <span class="cu-count">${r.count.toLocaleString()}<button class="cu-eye" type="button" title="Preview subjects" aria-label="Preview subjects"><svg width="14" height="14" viewBox="0 0 16 16" fill="none"><path d="M1.5 8S3.8 3.5 8 3.5 14.5 8 14.5 8 12.2 12.5 8 12.5 1.5 8 1.5 8Z" stroke="currentColor" stroke-width="1.2"/><circle cx="8" cy="8" r="1.8" stroke="currentColor" stroke-width="1.2"/></svg></button></span>
  </div>`;
}
async function themeFind() {
  const name = (($("#theme-name") || {}).value || "").trim();
  if (!name) return;
  themeFolder.name = name; themeFolder.step = "finding"; themeFolder.progress = null;
  renderThemeModal();
  const off = api.onThemeProgress((p) => { if (themeFolder && themeFolder.step === "finding") { themeFolder.progress = p; renderThemeModal(); } });
  try {
    const res = await api.matchThemeFolder({ accountId: state.activeAccount, name });
    if (!themeFolder) return; // cancelled mid-flight
    if (!res.ok) { closeThemeModal(); toast(`Couldn’t match theme: ${res.error}`, { error: true }); return; }
    themeFolder.rows = (res.rows || []).map((r) => ({ ...r, selected: !r.promo })); // marketing pre-unchecked, providers checked
    themeFolder.step = "review";
    renderThemeModal();
  } catch (e) { closeThemeModal(); toast(`Couldn’t match theme: ${e.message}`, { error: true }); }
  finally { if (off) off(); }
}
async function themeFile() {
  const name = themeFolder.name;
  const addresses = themeFolder.rows.filter((r) => r.selected && !r.dismissed).map((r) => r.email);
  if (!addresses.length) return;
  closeThemeModal();
  toast(`Filing ${addresses.length} sender${addresses.length === 1 ? "" : "s"} into “${name}”…`, { sticky: true });
  try {
    const res = await api.fileThemeFolder({ accountId: state.activeAccount, name, addresses });
    if (!res.ok) { toast(`Couldn’t create folder: ${res.error}`, { error: true }); return; }
    const id = res.folder && res.folder.id;
    await loadInbox(); await loadFolders(); renderAll();
    toast(`Filed ${res.filed} email${res.filed === 1 ? "" : "s"} into “${name}”`, { label: "Undo", fn: async () => {
      await api.unfileFolder({ accountId: state.activeAccount, name, id });
      if (state.view.type === "folder" && state.view.id === id) state.view = { type: "inbox" };
      await loadInbox(); await loadFolders(); renderAll();
      toast(`Removed “${name}” — mail returned to inbox`);
    } });
  } catch (e) { toast(`Couldn’t create folder: ${e.message}`, { error: true }); }
}
// Create an empty folder (no theme match, no filing) — a manual "file it later"
// folder. Reads the name from the input (name step) or the carried theme name (review).
async function themeCreateEmpty() {
  const name = ((($("#theme-name") || {}).value || (themeFolder && themeFolder.name) || "")).trim();
  if (!name) { const i = $("#theme-name"); if (i) i.focus(); return; }
  closeThemeModal();
  toast(`Creating folder “${name}”…`, { sticky: true });
  try {
    const res = await api.createEmptyFolder({ accountId: state.activeAccount, name });
    if (!res || !res.ok) { toast(`Couldn’t create folder: ${(res && res.error) || "unknown error"}`, { error: true }); return; }
    await loadFolders(); renderAll();
    toast(`Created “${name}” — drag mail into it anytime`);
  } catch (e) { toast(`Couldn’t create folder: ${e.message}`, { error: true }); }
}

// Drag-and-drop: move the dragged message(s) into a folder, then refresh counts.
async function dropToFolder(ids, folderName) {
  let moved = 0;
  for (const [acct, mids] of groupMessageIds(ids)) {
    try { const r = await api.moveToFolder({ accountId: acct, messageIds: mids, folderName }); if (r && r.ok) moved += mids.length; } catch {}
  }
  if (!moved) { toast("Couldn’t move those emails", { error: true }); return; }
  removeIdsLocally(ids);
  selection.clear(); lastIndex = -1;
  renderAll();
  loadFolders().then(renderRail); // refresh folder unread counts
  toast(`Moved ${moved} email${moved === 1 ? "" : "s"} to “${folderName}”`);
}
// Re-file: re-apply a folder's saved rules to sweep newly-arrived matching mail in.
async function refileFolder(id, name) {
  toast(`Re-filing “${name}”…`, { sticky: true });
  try {
    const res = await api.refileFolder({ accountId: state.activeAccount, id, name });
    if (!res.ok) { toast(`Re-file failed: ${res.error}`, { error: true }); return; }
    await loadInbox(); await loadFolders(); renderAll();
    toast(res.filed ? `Swept ${res.filed} email${res.filed === 1 ? "" : "s"} into “${name}”` : `“${name}” is already up to date`);
  } catch (e) { toast(`Re-file failed: ${e.message}`, { error: true }); }
}

async function loadInbox() {
  if (accountsList.length === 0) { MESSAGES = []; renderAll(); return; }
  selection.clear(); lastIndex = -1;
  state.loading = true;
  $("#refresh-btn").classList.add("spinning");
  renderList();
  try {
    inboxCursors = {};
    const pages = await Promise.all(accountsList.map(async (a) => {
      try {
        // Real server inbox unread count (non-blocking; updates the badge when it lands).
        api.inboxUnread({ accountId: a.id }).then((c) => { if (c && c.unread != null) { serverInboxUnread[a.id] = c.unread; renderRail(); } }).catch(() => {});
        const r = await fetchChunk(a.id, "inbox", null);
        inboxCursors[a.id] = { cursor: r.cursor, hasMore: r.hasMore };
        if (r.error) toast(`${a.address}: ${r.error}`, { error: true });
        return r.messages.map((m) => ({ ...m, ...classify(m), box: "inbox" }));
      } catch (e) { inboxCursors[a.id] = { cursor: null, hasMore: false }; toast(`${a.address}: ${e.message}`); return []; }
    }));
    MESSAGES = pages.flat().sort((a, b) => b.dateMs - a.dateMs);
    hydrateSnippets(MESSAGES);
  } catch (err) {
    toast(`Sync failed: ${err.message}`);
  } finally {
    state.loading = false;
    $("#refresh-btn").classList.remove("spinning");
    renderAll();
    classifyNewImportant(); // audit any new arrivals into the Important mailbox
  }
}
// Append the next chunk for the active account (never re-fetches).
async function loadMoreInbox() {
  const acc = state.activeAccount;
  const cur = inboxCursors[acc];
  if (!cur || !cur.hasMore) return;
  const r = await fetchChunk(acc, "inbox", cur.cursor);
  inboxCursors[acc] = { cursor: r.cursor, hasMore: r.hasMore };
  if (r.error) { toast(r.error, { error: true }); return; }
  const have = new Set(MESSAGES.map((m) => m.id));
  const fresh = r.messages.map((m) => ({ ...m, ...classify(m), box: "inbox" })).filter((m) => !have.has(m.id));
  MESSAGES = [...MESSAGES, ...fresh].sort((a, b) => b.dateMs - a.dateMs);
  hydrateSnippets(MESSAGES);
}

// ── Layout persistence (localStorage) ────────────────────────────────────────
const PREFS_KEY = "clearkeep.layout";
function loadPrefs() {
  try { return JSON.parse(localStorage.getItem(PREFS_KEY)) || {}; } catch { return {}; }
}
function savePrefs() {
  try {
    localStorage.setItem(PREFS_KEY, JSON.stringify({
      layout: state.layout,
      drawerDefaultApplied: true, // one-time Drawer-default migration has run
      pinned: document.body.classList.contains("nav-pinned"),
      compact: document.body.classList.contains("compact"),
      theme: document.documentElement.dataset.theme === "dark" ? "dark" : "light",
      sort: state.sort,
      categoryFilter: state.categoryFilter,
      readerWidth: document.documentElement.style.getPropertyValue("--reader-width") || null,
      listWidth: document.documentElement.style.getPropertyValue("--list-w") || null,
      listHeight: document.documentElement.style.getPropertyValue("--list-h") || null,
      readerHeight: document.documentElement.style.getPropertyValue("--reader-height") || null,
      view: state.view,
      activeAccount: state.activeAccount,
      foldersExpanded: state.foldersExpanded,
    }));
  } catch {}
}
// A persisted view is only valid if its target still exists for the active account.
function validView(v) {
  if (!v || !v.type) return false;
  if (["inbox", "all", "sent", "archive", "trash", "spam"].includes(v.type)) return true;
  if (v.type === "folder") return FOLDERS.some((f) => f.id === v.id);
  return false;
}

async function boot() {
  const prefs = loadPrefs();
  await loadAccounts();
  if (prefs.activeAccount && accountsList.some((a) => a.id === prefs.activeAccount)) {
    state.activeAccount = prefs.activeAccount;
  }
  await loadFolders();
  await loadOverrides();
  await loadNeeds();
  await loadImportant();
  await loadIdentities();
  loadContacts(); // address-book autocomplete (cached; non-blocking)
  // Auto-audit new inbox mail into the Important mailbox while the app is open.
  setInterval(classifyNewImportant, CFG.pollMs);
  // Deadline reminders: cheap date check every poll; body-reading refresh on a slow
  // cadence. Both survive a hidden window (Phase 2).
  setInterval(remindTick, CFG.pollMs);
  setInterval(maybeRefreshNeeds, CFG.needsRefreshCheckMs);
  remindTick();         // surface anything already due against today, right away
  maybeRefreshNeeds();  // refresh stale deadlines on launch (only if previously scanned)
  window.addEventListener("focus", () => { classifyNewImportant(); remindTick(); maybeRefreshNeeds(); });

  // Reading pane is the only layout now (drawer + compact removed).
  state.layout = "pane";
  if (prefs.readerWidth) document.documentElement.style.setProperty("--reader-width", prefs.readerWidth);
  if (prefs.listWidth) document.documentElement.style.setProperty("--list-w", prefs.listWidth);
  if (prefs.listHeight) document.documentElement.style.setProperty("--list-h", prefs.listHeight);
  if (typeof prefs.foldersExpanded === "boolean") state.foldersExpanded = prefs.foldersExpanded;
  if (SORT_LABELS[prefs.sort]) state.sort = prefs.sort;
  syncSortUI();
  populateFilterMenu();
  if (prefs.categoryFilter === "all" || CATEGORIES[prefs.categoryFilter]) state.categoryFilter = prefs.categoryFilter;
  syncFilterUI();
  setTheme(prefs.theme === "dark");    // light is the default; the head script already applied it pre-paint
  initUpdates();
  // Always open on Important — surface what matters before the inbox firehose.
  // (We intentionally don't restore the last view; Important is the landing screen.)
  state.view = { type: "keepers" };

  setLayout(state.layout);
  if (accountsList.length === 0) { renderAll(); openSettings(); }
  else {
    renderAll();
    loadInbox();
    if (isServerFolderView()) loadFolderView();
    // Kick the full Important scan automatically on open when nothing is flagged yet,
    // so a first-time user lands on a populated Important screen without clicking.
    // Returning users keep their flagged mail; classifyNewImportant refreshes it.
    if (state.view.type === "keepers" && importantItems.length === 0) runImpScan();
  }
}

// ── Toast ───────────────────────────────────────────────────────────────────
let toastTimer = null;
function hideToast() {
  const t = $("#toast");
  clearTimeout(toastTimer);
  t.classList.remove("show");
  setTimeout(() => t.classList.add("hidden"), 220);
}
const TOAST_ERR_RE = /(fail(s|ed|ure|ing)?|could ?n'?t|could not|\berrors?\b|can ?not|can'?t|unable|denied|invalid|went wrong)/i;
// toast(text)                    → success, auto-dismisses
// toast(text, { label, fn })     → action toast (e.g. Undo), auto-dismisses
// toast(text, { error: true })   → error, persists until dismissed
// Errors are also auto-detected from common phrasing.
function toast(text, opts) {
  const t = $("#toast");
  const action = opts && opts.label ? opts : null;
  const isError = !!(opts && opts.error) || (!action && TOAST_ERR_RE.test(text || ""));
  const isWarn = !!(opts && opts.warn);
  const icon = isError
    ? `<span class="toast-icon toast-err"><svg width="14" height="14" viewBox="0 0 16 16" fill="none"><circle cx="8" cy="8" r="6" stroke="currentColor" stroke-width="1.4"/><path d="M8 4.8V8.6M8 10.7V10.9" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/></svg></span>`
    : isWarn
    ? `<span class="toast-icon toast-warn"><svg width="15" height="15" viewBox="0 0 16 16" fill="none"><path d="M8 2.4L14.7 13.6H1.3L8 2.4Z" stroke="currentColor" stroke-width="1.4" stroke-linejoin="round"/><path d="M8 6.6V9.4M8 11.2V11.4" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/></svg></span>`
    : `<span class="toast-icon toast-check"><svg width="13" height="13" viewBox="0 0 16 16" fill="none"><path d="M3.5 8.5L6.5 11.5L12.5 4.5" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"/></svg></span>`;
  const dismissable = isError || isWarn;
  const dismiss = dismissable ? `<button class="toast-dismiss" title="Dismiss"><svg width="12" height="12" viewBox="0 0 16 16" fill="none"><path d="M4 4L12 12M12 4L4 12" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"/></svg></button>` : "";
  t.classList.toggle("toast-error", isError);
  t.classList.toggle("toast-warn-state", isWarn);
  t.innerHTML = icon + `<span class="toast-text">${escapeHtml(text)}</span>` + (action ? `<button class="toast-action">${escapeHtml(action.label)}</button>` : "") + dismiss;
  t.classList.remove("hidden");
  requestAnimationFrame(() => t.classList.add("show"));
  if (action) t.querySelector(".toast-action").addEventListener("click", () => { hideToast(); action.fn(); });
  if (dismissable) t.querySelector(".toast-dismiss").addEventListener("click", hideToast);
  clearTimeout(toastTimer);
  // errors, warnings, and sticky toasts stay until dismissed/replaced; others auto-hide
  if (!dismissable && !(opts && opts.sticky)) toastTimer = setTimeout(hideToast, action ? 6500 : 2200);
}

// ── "Needs you": proactive to-do list from important mail ─────────────────────
// Reads important mail (bodies, in the user's folders) and extracts a plain-English
// to-do list with deadlines. Only reads — never moves/changes mail. Status is
// persisted server-side so handled items don't reappear.
let needsItems = [];        // persisted to-dos for the active account
let needsSourceMsgs = [];   // source-email stubs so findMsg/openMessage work for "Open"
let needsUI = { phase: "idle", account: null, batchInfo: null, scanned: 0, loadedAccount: null };
let needsScanning = false;  // a silent background needs-refresh is running (IMAP-heavy; don't overlap the important poll)

// ── "Ask your mailbox" state ──────────────────────────────────────────────────
let askUI = { phase: "idle", progress: null, account: null }; // idle | thinking
let askHistory = [];        // [{question, found, answer, cites:[stub…]}] newest first
let askSourceMsgs = [];     // citation stubs so findMsg/openMessage resolve foldered mail
let askPending = "";        // the question currently being asked (kept in the input + thinking card)
const SUGGESTED_QUESTIONS = [
  "What needs my attention today?",
  "What bills or payments are due?",
  "When is my next appointment?",
  "Any custody or school emails I should see?",
  "What did the doctor’s office send?",
];

// ── Important smart mailbox ───────────────────────────────────────────────────
let importantItems = [];        // persisted AI-flagged important mail for the active account
let importantIds = new Set();    // messageIds → fast star lookup in the inbox list
let importantSourceMsgs = [];    // source stubs so findMsg/openMessage work on Important rows
let imp = { phase: "mailbox" };  // mailbox | scanning ("Search inbox for more"); Tidy uses the keepers state
let importantPolling = false;

function rebuildImportantIndex() {
  importantIds = new Set(importantItems.map((i) => i.messageId));
  importantSourceMsgs = importantItems.map((i) => i.source).filter(Boolean);
}
async function loadImportant() {
  const acc = acctById(state.activeAccount);
  if (!acc) { importantItems = []; rebuildImportantIndex(); return; }
  try { const r = await api.importantGet({ accountId: state.activeAccount }); if (r && r.ok) importantItems = r.items || []; } catch {}
  rebuildImportantIndex();
  renderRail();
  patchImportantStars();
}
// Incremental auto-classify of new arrivals (poll + on inbox load + on focus). Cheap
// when nothing's new (the backend does no AI work then). Yahoo only.
async function classifyNewImportant() {
  const acc = acctById(state.activeAccount);
  if (!acc || acc.provider !== "yahoo" || importantPolling || needsScanning || askUI.phase === "thinking" || imp.phase === "scanning" || !api.importantClassifyNew) return;
  importantPolling = true;
  try {
    const r = await api.importantClassifyNew({ accountId: state.activeAccount });
    if (r && r.ok) {
      importantItems = r.items || importantItems;
      rebuildImportantIndex();
      renderRail();
      patchImportantStars();
      if (state.view.type === "keepers" && imp.phase === "mailbox" && !["scanning", "review", "filing", "done"].includes(keepers.phase)) renderKeepers();
      if (r.newCount) {
        toast(`${r.newCount} new important email${r.newCount === 1 ? "" : "s"} flagged`);
        const src = r.newItems && r.newItems[0] && r.newItems[0].source;
        const who = src ? (cleanName(src.fromName) || src.fromEmail || "") : "";
        const subj = src ? cleanName(src.subject || "(no subject)") : "";
        notifyNew(
          r.newCount === 1 ? "Important email just arrived" : `${r.newCount} important emails just arrived`,
          src ? (who ? `${who} — ${subj}` : subj) : "Open ClearKeep to read.",
          "keepers",
        );
      }
    }
  } catch {} finally { importantPolling = false; }
}

// Toggle the star on a single rendered inbox row.
function applyRowImportant(row, m) {
  const on = importantIds.has(m.messageId);
  row.classList.toggle("is-important", on);
  let star = row.querySelector(".msg-imp-star");
  if (on && !star) {
    const line1 = row.querySelector(".msg-line1");
    if (line1) { star = document.createElement("span"); star.className = "msg-imp-star"; star.title = "Flagged important"; star.innerHTML = starSvg(); line1.insertBefore(star, line1.firstChild); }
  } else if (!on && star) star.remove();
}
function patchImportantStars() {
  document.querySelectorAll("#message-list .msg-row").forEach((row) => { const m = findMsg(row.dataset.id); if (m) applyRowImportant(row, m); });
}

function starSvg() { return '<svg width="11" height="11" viewBox="0 0 16 16" fill="currentColor"><path d="M8 1.7l1.8 4.1 4.4.4-3.3 2.9 1 4.3L8 11.2 4.1 13.4l1-4.3L1.8 6.2l4.4-.4L8 1.7Z"/></svg>'; }
function impDismissSvg() { return '<svg width="12" height="12" viewBox="0 0 16 16" fill="none"><path d="M4 4L12 12M12 4L4 12" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"/></svg>'; }

function impRowHtml(it) {
  const s = it.source || {};
  const who = cleanName(s.fromName) || s.fromEmail || "";
  return `<div class="imp-row${s.unread ? "" : " read"}" data-mid="${escapeHtml(it.messageId)}">
    <span class="imp-av">${avatarHtml(who, s.fromEmail || "", "msg-avatar")}</span>
    <div class="imp-main">
      <div class="imp-l1"><span class="imp-sender">${escapeHtml(who)}</span><span class="imp-time">${escapeHtml(s.time || "")}</span></div>
      <div class="imp-subject">${escapeHtml(cleanName(s.subject || "(no subject)"))}</div>
      <div class="imp-reason">${it.folder ? `<span class="imp-folder">${escapeHtml(it.folder)}</span>` : ""}${escapeHtml(it.reason || "")}</div>
    </div>
    <button class="imp-dismiss" data-mid="${escapeHtml(it.messageId)}" title="Not important">${impDismissSvg()}</button>
  </div>`;
}
function renderImpMailbox(el) {
  const acc = acctById(state.activeAccount);
  const supported = acc && acc.provider === "yahoo";
  const items = importantItems.slice().sort((a, b) => ((b.source && b.source.dateMs) || 0) - ((a.source && a.source.dateMs) || 0));
  el.innerHTML = `<div class="ki-pane">
    <div class="ki-header imp-header">
      <div class="ki-title">Important <span class="ki-sub">${items.length ? `${items.length} flagged · auto-updates as mail arrives` : "auto-updates as mail arrives"}</span></div>
      ${supported ? `<div class="imp-actions">
        <button class="cu-btn" id="imp-search" type="button">Search inbox for more</button>
        <button class="cu-btn" id="imp-tidy" type="button">Tidy up…</button>
      </div>` : ""}
    </div>
    <div class="ki-scroll">
      ${items.length
        ? items.map(impRowHtml).join("")
        : `<div class="ki-empty">${supported ? "Nothing flagged yet. New important mail appears here automatically — or hit <b>Search inbox for more</b> to check your whole inbox now." : "This works on Yahoo accounts right now."}</div>`}
    </div>
  </div>`;
  hydrateAvatars(el);
  el.querySelectorAll(".imp-row").forEach((r) => r.addEventListener("click", (e) => {
    if (e.target.closest(".imp-dismiss")) return;
    const it = importantItems.find((x) => x.messageId === r.dataset.mid);
    if (it && it.source) { setView({ type: "inbox" }); openMessage(it.source.id); } // show it in the inbox + reader
  }));
  el.querySelectorAll(".imp-dismiss").forEach((b) => b.addEventListener("click", (e) => { e.stopPropagation(); impDismiss(b.dataset.mid); }));
  const s = $("#imp-search"); if (s) s.addEventListener("click", runImpScan);
  const t = $("#imp-tidy"); if (t) t.addEventListener("click", () => { keepers = freshKeepers(); keepersScan(); }); // the existing file/clear flow
}
function renderImpScanning(el) {
  const si = imp.scanInfo;
  const sub = si && si.total ? `batch ${Math.min(si.done, si.total)} / ${si.total}` + (si.found ? ` · ${si.found} important found` : "")
    : (si && si.count ? `${si.count.toLocaleString()} emails to check…` : "Starting…");
  const bar = si && si.total ? `<div class="ki-bar"><b style="width:${Math.round(si.done / si.total * 100)}%"></b></div>` : `<div class="cu-bar"><span></span></div>`;
  el.innerHTML = `<div class="cu-wrap"><div class="cu-status">
    <div class="cu-spinner"></div>
    <div class="cu-status-title">Searching your inbox…</div>
    <div class="cu-status-sub">${escapeHtml(sub)}</div>
    ${bar}
  </div></div>`;
}
async function runImpScan() {
  imp.phase = "scanning"; imp.scanInfo = null; renderKeepers();
  const off = api.onImportantProgress((p) => {
    if (state.view.type !== "keepers") return;
    if (p.phase === "scan") imp.scanInfo = { count: p.count };
    else if (p.phase === "batch") imp.scanInfo = { done: p.done, total: p.total, found: p.found };
    if (imp.phase === "scanning") renderKeepers();
  });
  try {
    const r = await api.importantScanAll({ accountId: state.activeAccount });
    if (r && r.ok) { importantItems = r.items || []; rebuildImportantIndex(); }
    else toast("Scan failed: " + ((r && r.error) || "unknown"), { error: true });
  } catch (e) { toast("Scan failed: " + e.message, { error: true }); }
  finally { if (off) off(); imp.phase = "mailbox"; renderRail(); patchImportantStars(); renderKeepers(); }
}
async function impDismiss(mid) {
  try {
    const r = await api.importantUpdate({ accountId: state.activeAccount, messageId: mid, status: "dismissed" });
    if (r && r.ok) { importantItems = r.items || []; rebuildImportantIndex(); renderRail(); patchImportantStars(); renderKeepers(); }
  } catch (e) { toast("Couldn’t update: " + e.message, { error: true }); }
}


const NEEDS_GROUPS = [
  { key: "overdue", label: "Overdue" },
  { key: "soon", label: "This week" },
  { key: "later", label: "Later" },
  { key: "none", label: "No deadline" },
];
const PRIORITY_RANK = { high: 0, normal: 1, low: 2 };

function needsVisibleItems() {
  const now = Date.now();
  return needsItems.filter((it) =>
    it.status === "active" || (it.status === "snoozed" && (!it.snoozeUntil || it.snoozeUntil <= now)));
}
function needsBadgeCount() { return needsVisibleItems().length; }

// Workspace-header triage pills: "Important emails to read" (unread important) +
// "Things need you" (open to-dos). Counts mirror the rail rows / badge.
function renderTriagePills() {
  const kp = $("#pill-keepers"), nd = $("#pill-needs");
  if (!kp || !nd) return;
  const kn = $("#pill-keepers-n"), nn = $("#pill-needs-n");
  if (kn) kn.textContent = String(importantItems.length); // total flagged (matches the "N flagged" header), not just unread
  if (nn) nn.textContent = String(needsBadgeCount());
  kp.classList.toggle("active", state.view.type === "keepers");
  nd.classList.toggle("active", state.view.type === "needs");
  const cu = $("#pill-cleanup"), ak = $("#pill-ask");
  if (cu) cu.classList.toggle("active", state.view.type === "cleanup");
  if (ak) ak.classList.toggle("active", state.view.type === "ask");
}

// ── Proactive surfacing: dock badge + inbox banner + native notifications ─────
// Amanda's deepest fear is missing something important. These three signals reach
// OUT to her instead of waiting to be checked: the dock badge shows what's waiting
// without opening the app; the inbox banner makes the buried "Needs you" / Important
// lists discoverable from where she already is; and a native notification fires the
// moment new important mail is auto-flagged. All calm, surface-only — never act.
let bannerHiddenSig = "";   // signature of the banner the user last dismissed
let lastBadgeStr = null;    // avoid redundant setBadge IPC churn

function unreadImportantCount() {
  // Count against the LIVE inbox (not the stored snapshot) so the badge/banner
  // self-clear the moment she reads an important email.
  let n = 0;
  for (const m of MESSAGES) if (m.unread && importantIds.has(m.messageId)) n++;
  return n;
}
function attentionCount() { return unreadImportantCount() + needsBadgeCount(); }

function updateAttention() {
  const n = attentionCount();
  const str = String(n);
  if (str !== lastBadgeStr && api.setBadge) { lastBadgeStr = str; api.setBadge(n); }
  renderNeedsBanner();
  renderTriagePills();
}

function bellSvg() { return '<svg width="14" height="14" viewBox="0 0 16 16" fill="none"><path d="M8 2C5.8 2 4.2 3.7 4.2 5.9c0 3.1-1 4.1-1 4.1h9.6s-1-1-1-4.1C11.8 3.7 10.2 2 8 2Z" stroke="currentColor" stroke-width="1.3" stroke-linejoin="round"/><path d="M6.7 12.5a1.4 1.4 0 0 0 2.6 0" stroke="currentColor" stroke-width="1.3" stroke-linecap="round"/></svg>'; }
function nbCloseSvg() { return '<svg width="12" height="12" viewBox="0 0 16 16" fill="none"><path d="M4 4L12 12M12 4L4 12" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/></svg>'; }

function renderNeedsBanner() {
  const el = $("#needs-banner");
  if (!el) return;
  const impN = unreadImportantCount();
  const todo = needsBadgeCount();
  const sig = `${impN}|${todo}`;
  const show = state.view.type === "inbox" && (impN || todo) && sig !== bannerHiddenSig;
  if (!show) { el.classList.add("hidden"); el.innerHTML = ""; return; }
  const chips = [];
  if (impN) chips.push(`<button class="nb-chip" data-go="important" type="button">${impN} important email${impN === 1 ? "" : "s"} to read</button>`);
  if (todo) chips.push(`<button class="nb-chip" data-go="needs" type="button">${todo} thing${todo === 1 ? "" : "s"} need${todo === 1 ? "s" : ""} you</button>`);
  el.innerHTML = `<span class="nb-bell">${bellSvg()}</span><span class="nb-text">${chips.join('<span class="nb-dot">·</span>')}</span><button class="nb-x" type="button" title="Dismiss for now">${nbCloseSvg()}</button>`;
  el.classList.remove("hidden");
  el.querySelectorAll(".nb-chip").forEach((b) => b.addEventListener("click", () => {
    if (b.dataset.go === "important") { if (["done", "error"].includes(keepers.phase)) keepers = freshKeepers(); imp.phase = "mailbox"; setView({ type: "keepers" }); }
    else setView({ type: "needs" });
  }));
  el.querySelector(".nb-x").addEventListener("click", () => { bannerHiddenSig = sig; el.classList.add("hidden"); });
}

// Fire a native macOS notification — only when the window is NOT focused (if she's
// already looking, the toast + banner are enough; an OS notification would nag).
function notifyNew(title, body, go) {
  try {
    if (typeof Notification === "undefined" || document.hasFocus()) return;
    const n = new Notification(title, { body: body || "", silent: false });
    n.onclick = () => { try { api.focusWindow && api.focusWindow(); } catch {} if (go) setView({ type: go }); };
  } catch {}
}

async function loadNeeds() {
  if (!state.activeAccount) { needsItems = []; needsSourceMsgs = []; return; }
  const acct = state.activeAccount;
  try {
    const res = await api.needsGet({ accountId: acct });
    if (state.activeAccount !== acct) return; // switched mid-load
    needsItems = (res && res.items) || [];
  } catch { needsItems = []; }
  needsSourceMsgs = needsItems.map((it) => it.source).filter(Boolean);
  needsUI.loadedAccount = acct;
  renderRail();
  remindTick(); // surface any deadlines that are already due/overdue in the loaded set
  if (state.view.type === "needs") renderNeeds();
}

async function runNeedsScan() {
  if (!state.activeAccount) return;
  needsUI = { phase: "scanning", account: state.activeAccount, batchInfo: null, scanned: 0, loadedAccount: state.activeAccount };
  renderNeeds();
  const off = api.onNeedsProgress((p) => {
    if (needsUI.account !== state.activeAccount || needsUI.phase !== "scanning") return;
    if (p.phase === "scan") needsUI.scanned = p.count;
    else if (p.phase === "batch") needsUI.batchInfo = { done: p.done, total: p.total, found: p.found };
    renderNeeds();
  });
  try {
    const res = await api.needsScan({ accountId: needsUI.account });
    if (needsUI.account !== state.activeAccount) return;
    if (!res.ok) { needsUI.phase = "idle"; toast("Scan failed: " + res.error, { error: true }); renderNeeds(); return; }
    needsItems = res.items || [];
    needsSourceMsgs = needsItems.map((it) => it.source).filter(Boolean);
    needsUI.phase = "idle"; needsUI.loadedAccount = needsUI.account;
    try { localStorage.setItem(needsRefreshKey(needsUI.account), String(Date.now())); } catch {} // marks the opt-in → enables background refresh
    renderRail(); renderNeeds(); remindTick();
  } catch (e) {
    if (needsUI.account !== state.activeAccount) return;
    needsUI.phase = "idle"; toast("Scan failed: " + e.message, { error: true }); renderNeeds();
  } finally { if (off) off(); }
}

// ── Deadline reminders ────────────────────────────────────────────────────────
// The cheap, time-driven half of the proactive loop: notify when a to-do is due
// soon / overdue / when a snooze elapses. Pure date math on the already-stored
// items (no IMAP), so it's safe to run often. Each notified stage is persisted
// (remindStage) so a deadline never re-notifies. Runs even with the window hidden
// (Phase 2). The body-reading refresh that keeps the deadlines current is separate
// (silentNeedsRefresh) and only auto-runs once the user has opted into a first scan.

function todayLocalISO() {
  const d = new Date(); const p = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}
// Whole days from local midnight today to the item's due date (negative = past).
function dueDaysFromToday(dueISO) {
  if (!dueISO || !/^\d{4}-\d{2}-\d{2}$/.test(dueISO)) return null;
  const due = new Date(dueISO + "T00:00:00");
  if (isNaN(due.getTime())) return null;
  const n = new Date();
  const t0 = new Date(n.getFullYear(), n.getMonth(), n.getDate());
  return Math.round((due.getTime() - t0.getTime()) / 86400000);
}

// UI grouping bucket recomputed against today (matches main's temporalOf thresholds).
function freshTemporal(it) {
  const days = dueDaysFromToday(it && it.dueISO);
  return days == null ? "none" : days < 0 ? "overdue" : days <= 7 ? "soon" : "later";
}

const REMIND_RANK = { "": 0, soon: 1, overdue: 2 };
function remindTick() {
  const acc = acctById(state.activeAccount);
  if (!acc || acc.provider !== "yahoo" || !needsItems.length) return;
  const now = Date.now();
  const fired = [];
  for (const it of needsItems) {
    // a snooze that has elapsed → wake the item and remind once
    if (it.status === "snoozed" && it.snoozeUntil && it.snoozeUntil <= now) {
      it.status = "active"; it.snoozeUntil = null;
      api.needsUpdate({ accountId: acc.id, sourceMessageId: it.sourceMessageId, status: "active", snoozeUntil: null }).catch(() => {});
      fired.push({ it, kind: "wake" });
      continue;
    }
    if (it.status !== "active") continue;
    const days = dueDaysFromToday(it.dueISO);
    if (days == null) continue;
    const desired = days < 0 ? "overdue" : days <= CFG.remindLeadDays ? "soon" : ""; // notify within lead window, or once overdue
    if (!desired) continue;
    if (REMIND_RANK[desired] > REMIND_RANK[it.remindStage || ""]) {
      it.remindStage = desired;
      api.needsRemind({ accountId: acc.id, sourceMessageId: it.sourceMessageId, remindStage: desired }).catch(() => {});
      fired.push({ it, kind: desired, days });
    }
  }
  if (fired.length) {
    renderRail();
    if (state.view.type === "needs") renderNeeds();
    notifyReminders(fired);
  }
}

function notifyReminders(fired) {
  let title, body;
  if (fired.length === 1) {
    const { it, kind, days } = fired[0];
    title = kind === "wake" ? "Reminder" : kind === "overdue" ? "Overdue" : days <= 0 ? "Due today" : "Due tomorrow";
    body = it.action || it.summary || "Something needs you";
  } else {
    title = `${fired.length} things need you`;
    body = fired[0].it.action || fired[0].it.summary || "";
  }
  toast(body ? `${title} — ${body}` : title);   // in-app (visible when focused)
  notifyNew(title, body, "needs");               // OS notification (only when unfocused/hidden)
}

// Keep the to-do list (and its deadlines) current over long sessions by re-reading
// the foldered important mail in the background — but only after the user has run a
// first scan (respect the body-reading opt-in), and never while the important poll
// is mid-flight (Yahoo connection contention).
function needsRefreshKey(acctId) { return `clearkeep.needsRefresh.${acctId}`; }
async function silentNeedsRefresh() {
  const acc = acctById(state.activeAccount);
  if (!acc || acc.provider !== "yahoo") return;
  if (needsScanning || importantPolling || needsUI.phase === "scanning") return;
  needsScanning = true;
  const acctId = acc.id;
  try {
    const res = await api.needsScan({ accountId: acctId });
    if (state.activeAccount !== acctId || !res || !res.ok) return;
    needsItems = res.items || [];
    needsSourceMsgs = needsItems.map((it) => it.source).filter(Boolean);
    needsUI.loadedAccount = acctId;
    try { localStorage.setItem(needsRefreshKey(acctId), String(Date.now())); } catch {}
    renderRail();
    if (state.view.type === "needs" && needsUI.phase !== "scanning") renderNeeds();
    remindTick();
  } catch {} finally { needsScanning = false; }
}
function maybeRefreshNeeds() {
  const acc = acctById(state.activeAccount);
  if (!acc || acc.provider !== "yahoo") return;
  let last = 0; try { last = parseInt(localStorage.getItem(needsRefreshKey(acc.id)) || "0", 10) || 0; } catch {}
  if (!last) return;                               // never scanned → respect the opt-in; don't read bodies
  if (Date.now() - last > CFG.needsRefreshStaleMs) silentNeedsRefresh();
}

async function needsAct(sourceMessageId, status, snoozeUntil) {
  const it = needsItems.find((x) => x.sourceMessageId === sourceMessageId);
  if (it) { it.status = status; it.snoozeUntil = snoozeUntil || null; } // optimistic
  renderRail(); renderNeeds();
  try { await api.needsUpdate({ accountId: state.activeAccount, sourceMessageId, status, snoozeUntil: snoozeUntil || null }); }
  catch (e) { toast("Couldn't update: " + e.message, { error: true }); }
}
function needsOpen(it) {
  if (!it || !it.source) return;
  if (!needsSourceMsgs.find((m) => m.id === it.source.id)) needsSourceMsgs.push(it.source);
  openMessage(it.source.id);
}

function renderNeeds() {
  const el = $("#needs-view");
  if (!el || state.view.type !== "needs") return;
  if (needsUI.loadedAccount !== state.activeAccount && needsUI.phase !== "scanning") loadNeeds();
  if (needsUI.phase === "scanning") return renderNyScan(el);
  return renderNyList(el);
}

function renderNyScan(el) {
  const bi = needsUI.batchInfo;
  const sub = bi
    ? `reading ${bi.done} / ${bi.total}` + (bi.found ? ` · ${bi.found} to-do${bi.found === 1 ? "" : "s"} so far` : "")
    : (needsUI.scanned ? `${needsUI.scanned} important emails to read…` : "Starting…");
  const bar = bi && bi.total ? `<div class="ki-bar"><b style="width:${Math.round(bi.done / bi.total * 100)}%"></b></div>` : `<div class="cu-bar"><span></span></div>`;
  el.innerHTML = `<div class="cu-wrap"><div class="cu-status">
    <div class="cu-spinner"></div>
    <div class="cu-status-title">Looking for what needs you…</div>
    <div class="cu-status-sub">${escapeHtml(sub)}</div>
    ${bar}
  </div></div>`;
}

function renderNyList(el) {
  const acc = acctById(state.activeAccount);
  const supported = acc && acc.provider === "yahoo";
  if (!supported) {
    el.innerHTML = `<div class="cu-wrap"><div class="cu-status"><div class="cu-status-title">Needs you</div><div class="cu-status-sub">This works on Yahoo accounts right now.</div></div></div>`;
    return;
  }
  // Intro: nothing scanned yet (no stored items).
  if (!needsItems.length) {
    el.innerHTML = `<div class="cu-wrap"><div class="ki-intro">
      <div class="ki-intro-icon">${svgNeedsYou()}</div>
      <div class="cu-status-title">What needs you</div>
      <div class="ki-intro-text">ClearKeep will read your important mail — custody, school, health, bills — and pull out a simple to-do list of what you need to do and by when. It only reads; it never changes anything.</div>
      <button class="cu-btn cu-btn-primary" id="ny-scan" type="button">Find what needs me</button>
      <div class="ki-intro-note">Reads the important mail in your folders. Takes a couple of minutes.</div>
    </div></div>`;
    const b = $("#ny-scan"); if (b) b.addEventListener("click", runNeedsScan);
    return;
  }

  const visible = needsVisibleItems();
  const groups = {};
  for (const it of visible) {
    const k = freshTemporal(it); // recompute against TODAY so the list agrees with the reminders
    (groups[k] = groups[k] || []).push(it);
  }
  for (const k in groups) groups[k].sort((a, b) =>
    (a.dueISO || "9999").localeCompare(b.dueISO || "9999") || ((PRIORITY_RANK[a.priority] ?? 1) - (PRIORITY_RANK[b.priority] ?? 1)));

  const cardHtml = (it) => `<div class="ny-card pri-${escapeHtml(it.priority || "normal")} t-${escapeHtml(freshTemporal(it))}">
    <div class="ny-card-main">
      <div class="ny-summary">${escapeHtml(it.summary || "")}</div>
      <div class="ny-action">${escapeHtml(it.action || "")}</div>
      <div class="ny-meta">${it.deadline ? `<span class="ny-due">${escapeHtml(it.deadline)}</span>` : ""}<span class="ny-from">${escapeHtml((it.folder ? it.folder + " · " : "") + (cleanName(it.source && it.source.fromName) || (it.source && it.source.fromEmail) || ""))}</span></div>
    </div>
    <div class="ny-card-actions">
      <button class="ny-act" data-act="open" data-id="${escapeHtml(it.sourceMessageId)}" title="Open the email">${svgOpenMail()}</button>
      <button class="ny-act ny-done" data-act="done" data-id="${escapeHtml(it.sourceMessageId)}" title="Mark done">${checkSvg()}</button>
      <button class="ny-act" data-act="snooze" data-id="${escapeHtml(it.sourceMessageId)}" title="Snooze 3 days">${svgSnooze()}</button>
      <button class="ny-act" data-act="dismiss" data-id="${escapeHtml(it.sourceMessageId)}" title="Not relevant">${svgX()}</button>
    </div>
  </div>`;
  const sections = NEEDS_GROUPS.filter((g) => (groups[g.key] || []).length).map((g) =>
    `<div class="ny-group"><div class="ny-group-head ny-${g.key}">${g.label}<span class="ny-group-count">${groups[g.key].length}</span></div>${groups[g.key].map(cardHtml).join("")}</div>`).join("");

  el.innerHTML = `<div class="ki-pane">
    <div class="ki-header">
      <div class="ki-title">Needs you <span class="ki-sub">${visible.length ? `${visible.length} thing${visible.length === 1 ? "" : "s"} need you` : "you're all caught up"}</span></div>
      <button class="cu-btn ny-rescan" id="ny-rescan" type="button">Rescan</button>
    </div>
    <div class="ki-scroll">${visible.length ? sections : `<div class="ki-empty">You're all caught up — nothing needs you right now.</div>`}</div>
  </div>`;
  const rb = $("#ny-rescan"); if (rb) rb.addEventListener("click", runNeedsScan);
  el.querySelectorAll(".ny-act").forEach((b) => b.addEventListener("click", () => {
    const id = b.getAttribute("data-id"), act = b.getAttribute("data-act");
    const it = needsItems.find((x) => x.sourceMessageId === id);
    if (act === "open") return needsOpen(it);
    if (act === "done") return needsAct(id, "done");
    if (act === "dismiss") return needsAct(id, "dismissed");
    if (act === "snooze") return needsAct(id, "snoozed", Date.now() + CFG.snoozeMs);
  }));
}

// ── "Ask your mailbox" ────────────────────────────────────────────────────────
// A dedicated, calm Q&A view: suggested-question cards (never a blank box) + a
// question box → a cited answer card. The pipeline (retrieve → read a handful of
// bodies → answer) lives in main (ask:answer); here we just drive it and render
// the answer with clickable citation chips that open the source email. Yahoo only.

async function runAsk(question) {
  question = String(question || "").trim();
  if (!question || !state.activeAccount || askUI.phase === "thinking") return;
  askPending = question;
  askUI = { phase: "thinking", progress: null, account: state.activeAccount };
  renderAsk();
  const off = api.onAskProgress ? api.onAskProgress((p) => {
    if (askUI.phase === "thinking" && askUI.account === state.activeAccount) { askUI.progress = p; renderAsk(); }
  }) : null;
  // Conversation context: recent turns (so the model resolves "it"/"what time")
  // + the emails cited recently (carried forward so follow-ups can reference them).
  const history = askHistory.slice(-CFG.askHistoryTurns).map((h) => ({ q: h.question, a: h.found === false ? "(couldn’t find an answer)" : (h.answer || "") }));
  const priorRefs = []; const seenRef = new Set();
  askHistory.slice(-CFG.askPriorRefTurns).forEach((h) => (h.cites || []).forEach((c) => { if (c && c.id && !seenRef.has(c.id)) { seenRef.add(c.id); priorRefs.push(c); } }));
  try {
    const res = await api.askAnswer({ accountId: askUI.account, question, history, priorRefs: priorRefs.slice(0, CFG.askPriorRefCap) });
    if (askUI.account !== state.activeAccount) return;
    if (!res || !res.ok) { toast("Couldn’t answer: " + ((res && res.error) || "unknown"), { error: true }); }
    else {
      (res.cites || []).forEach((c) => { if (c && c.id && !askSourceMsgs.find((m) => m.id === c.id)) askSourceMsgs.push(c); });
      askHistory.push({ question, found: res.found, answer: res.answer, cites: res.cites || [] });
    }
  } catch (e) { toast("Couldn’t answer: " + e.message, { error: true }); }
  finally {
    if (off) off();
    if (askUI.account === state.activeAccount) { askUI.phase = "idle"; askPending = ""; renderAsk(); }
  }
}

function askOpen(id) {
  const stub = askSourceMsgs.find((m) => m.id === id);
  if (!stub) return;
  openMessage(id); // findMsg resolves via askSourceMsgs → reader overlay
}

function askReset() {
  if (askUI.phase === "thinking") return; // let an in-flight question finish
  askHistory = []; askSourceMsgs = []; askPending = "";
  askUI = { phase: "idle", progress: null, account: state.activeAccount };
  renderAsk();
}
function svgAskReset() {
  return '<svg width="13" height="13" viewBox="0 0 16 16" fill="none" aria-hidden="true"><path d="M8 3.5V12.5M3.5 8H12.5" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"/></svg>';
}

function askProgressLabel(p) {
  p = p || {};
  if (p.phase === "gather") return "Gathering your mail…";
  if (p.phase === "search") return "Finding the right emails…";
  if (p.phase === "read") return p.total ? `Reading the emails… ${p.done || 0} / ${p.total}` : "Reading the emails…";
  if (p.phase === "answer") return "Writing your answer…";
  return "Looking through your mail…";
}

function askBotAvatar() {
  return `<div class="ask-av">${svgAsk()}</div>`;
}
function askCitesHtml(cites) {
  if (!cites || !cites.length) return "";
  return `<div class="ask-cites"><div class="ask-cites-label">From your mail</div>${cites.map((c) =>
    `<button class="ask-cite" type="button" data-id="${escapeHtml(c.id)}"><span class="ask-cite-from">${escapeHtml(cleanName(c.fromName) || c.fromEmail || "")}</span><span class="ask-cite-subj">${escapeHtml(cleanName(c.subject || "(no subject)"))}</span></button>`).join("")}</div>`;
}

function renderAsk() {
  const el = $("#ask-view");
  if (!el || state.view.type !== "ask") return;
  const acc = acctById(state.activeAccount);
  const supported = acc && acc.provider === "yahoo";
  const thinking = askUI.phase === "thinking";
  const hasThread = askHistory.length || thinking;

  // Conversation bubbles (oldest → newest), then the in-flight question + typing.
  const thread = askHistory.map((a) => {
    const answer = a.found === false ? "I couldn’t find that one in your mail." : escapeHtml(a.answer || "");
    return `<div class="ask-row ask-row-me"><div class="ask-bub ask-bub-me">${escapeHtml(a.question)}</div></div>
      <div class="ask-row ask-row-bot">${askBotAvatar()}<div class="ask-bub ask-bub-bot${a.found === false ? " ask-bub-empty" : ""}">${answer}${askCitesHtml(a.cites)}</div></div>`;
  }).join("");
  const pending = thinking ? `<div class="ask-row ask-row-me"><div class="ask-bub ask-bub-me">${escapeHtml(askPending)}</div></div>
      <div class="ask-row ask-row-bot">${askBotAvatar()}<div class="ask-bub ask-bub-bot ask-bub-typing"><span class="ask-dots"><i></i><i></i><i></i></span><span class="ask-typing-label">${escapeHtml(askProgressLabel(askUI.progress))}</span></div></div>` : "";

  // Empty welcome (no conversation yet).
  const chips = SUGGESTED_QUESTIONS.map((q) => `<button class="ask-chip" type="button" data-q="${escapeHtml(q)}">${escapeHtml(q)}</button>`).join("");
  const welcome = `<div class="ask-welcome">
    <div class="ask-welcome-av">${svgAsk()}</div>
    <div class="ask-welcome-title">Ask me anything about your mail</div>
    <div class="ask-welcome-sub">I’ll read your email and answer in plain English — and show you exactly which messages it came from.</div>
    <div class="ask-chips">${chips}</div>
  </div>`;

  const unsupported = `<div class="ask-welcome"><div class="ask-welcome-av">${svgAsk()}</div><div class="ask-welcome-title">Ask works on Yahoo right now</div><div class="ask-welcome-sub">Switch to your Yahoo account to ask questions about your mail.</div></div>`;

  const resetBtn = (supported && askHistory.length) ? `<button class="ask-reset" id="ask-reset" type="button" title="Start a new conversation">${svgAskReset()}<span>New chat</span></button>` : "";

  el.innerHTML = `<div class="ask-chat">
    ${resetBtn}
    <div class="ask-thread" id="ask-thread">
      ${!supported ? unsupported : (hasThread ? `<div class="ask-msgs">${thread}${pending}</div>` : welcome)}
    </div>
    ${supported ? `<div class="ask-composer">
      <div class="ask-bar">
        <input id="ask-input" type="text" placeholder="Ask anything about your mail…" autocomplete="off" spellcheck="false" ${thinking ? "disabled" : ""} />
        <button class="ask-send" id="ask-go" type="button" title="Ask" ${thinking ? "disabled" : ""} aria-label="Ask">${svgAskSend()}</button>
      </div>
    </div>` : ""}
  </div>`;

  if (!supported) return;
  const input = $("#ask-input"), go = $("#ask-go"), thread2 = $("#ask-thread");
  const submit = () => { if (input) runAsk(input.value); };
  if (go) go.addEventListener("click", submit);
  if (input) input.addEventListener("keydown", (e) => { if (e.key === "Enter") { e.preventDefault(); submit(); } });
  el.querySelectorAll(".ask-chip").forEach((b) => b.addEventListener("click", () => runAsk(b.dataset.q)));
  el.querySelectorAll(".ask-cite").forEach((b) => b.addEventListener("click", () => askOpen(b.dataset.id)));
  const rb = $("#ask-reset"); if (rb) rb.addEventListener("click", askReset);
  if (thread2) thread2.scrollTop = thread2.scrollHeight; // pin to the newest message, like a chat
  if (input && !thinking) setTimeout(() => { try { input.focus(); } catch {} }, 20);
}

// ── Find important: AI keeper-finder ──────────────────────────────────────────
// Keepers-first. Reads sender+subject of the whole inbox (no bodies), sorts each
// into keep/junk/uncertain using her folders as examples, and offers to FILE the
// keepers. Step 1 NEVER trashes — worst case is a keeper filed to the wrong folder
// (recoverable). Phases: idle(intro) → scanning → review → filing → done | error.
function freshKeepers() {
  return { phase: "idle", account: null, keep: [], junkCount: 0, uncertainCount: 0, total: 0, batchInfo: null,
           junkIds: [], junkSample: [], clearJunk: true, filedCount: 0, trashedCount: 0, undo: null, error: null };
}
let keepers = freshKeepers();

async function keepersScan() {
  if (!state.activeAccount) return;
  keepers = freshKeepers();
  keepers.phase = "scanning";
  keepers.account = state.activeAccount;
  renderKeepers();
  const off = api.onKeepersProgress((p) => {
    if (keepers.account !== state.activeAccount || keepers.phase !== "scanning") return;
    if (p.phase === "scan") keepers.total = p.count;
    else if (p.phase === "batch") {
      keepers.batchInfo = { done: p.done, total: p.total };
      keepers.junkCount = p.junk || 0;
      keepers.uncertainCount = p.uncertain || 0;
      if (p.keep && p.keep.length) keepers.keep.push(...p.keep.map((r) => ({ ...r, selected: true })));
    }
    if (state.view.type === "keepers") renderKeepers();
  });
  try {
    const res = await api.keepersScan({ accountId: keepers.account });
    if (keepers.account !== state.activeAccount) return; // account switched mid-scan
    if (!res.ok) { keepers.phase = "error"; keepers.error = res.error; renderKeepers(); return; }
    if (keepers.keep.length === 0 && (res.keep || []).length) keepers.keep = res.keep.map((r) => ({ ...r, selected: true })); // safety net
    keepers.junkCount = res.junkCount || keepers.junkCount;
    keepers.uncertainCount = res.uncertainCount || keepers.uncertainCount;
    keepers.junkIds = res.junkIds || [];
    keepers.junkSample = res.junkSample || [];
    keepers.total = res.total || keepers.total;
    keepers.phase = "review";
    renderKeepers();
  } catch (e) {
    if (keepers.account !== state.activeAccount) return;
    keepers.phase = "error"; keepers.error = e.message; renderKeepers();
  } finally { if (off) off(); }
}

function keepersFiles() { return keepers.keep.filter((r) => r.selected && r.folder); } // selected + routed to a folder → will move
function keepersGroups() {
  const g = new Map();
  for (const r of keepers.keep) { const k = r.folder || ""; if (!g.has(k)) g.set(k, []); g.get(k).push(r); }
  return g;
}
// The one tidy action: file the ticked keepers AND (optionally) move the clutter
// to Trash. Behind a single confirm — this can trash thousands of metadata-judged
// emails, so it's never silent. Uncertain mail is never trashed.
function keepersTidyRun() {
  const fileSel = keepersFiles();
  const willClear = keepers.clearJunk && keepers.junkIds.length;
  if (!fileSel.length && !willClear) { toast("Nothing to do — tick some mail, or turn on clearing clutter."); return; }
  const parts = [];
  if (fileSel.length) parts.push(`file ${fileSel.length} into folder${fileSel.length === 1 ? "" : "s"}`);
  if (willClear) parts.push(`move ${keepers.junkIds.length.toLocaleString()} clutter email${keepers.junkIds.length === 1 ? "" : "s"} to Trash`);
  const stay = keepers.keep.filter((r) => !r.folder).length + keepers.uncertainCount;
  toast(`Tidy up: ${parts.join(" and ")}?${stay ? ` ${stay.toLocaleString()} stay in your inbox.` : ""} Trash is recoverable.`,
    { warn: true, label: "Tidy up", fn: keepersTidyExec });
}
async function keepersTidyExec() {
  keepers.phase = "filing"; renderKeepers();
  let filed = 0, trashed = 0, undo = null, err = null;
  try {
    const fileSel = keepersFiles();
    if (fileSel.length) {
      const fr = await api.keepersFile({ accountId: keepers.account, items: fileSel.map((r) => ({ messageId: r.messageId, folder: r.folder })) });
      if (!fr || !fr.ok) throw new Error((fr && fr.error) || "filing failed");
      filed = fr.filed || 0;
    }
    if (keepers.clearJunk && keepers.junkIds.length) {
      const tr = await api.keepersTrash({ accountId: keepers.account, messageIds: keepers.junkIds });
      if (!tr || !tr.ok) throw new Error((tr && tr.error) || "clearing clutter failed");
      trashed = tr.trashed || 0; undo = tr.undo || null;
    }
  } catch (e) { err = e.message; }
  keepers.filedCount = filed; keepers.trashedCount = trashed; keepers.undo = undo;
  keepers.phase = err ? "review" : "done";
  if (err) toast("Tidy up couldn’t finish: " + err, { error: true });
  renderKeepers();
  await loadInbox(); await loadFolders(); renderRail(); // mail moved server-side — refresh counts
}
async function keepersUndoClear() {
  if (!keepers.undo || !keepers.undo.uids || !keepers.undo.uids.length) return;
  const b = $("#ki-undo"); if (b) { b.disabled = true; b.textContent = "Restoring…"; }
  try {
    const r = await api.keepersRestore({ accountId: keepers.account, uids: keepers.undo.uids });
    if (r && r.ok) {
      toast(`Restored ${r.restored} email${r.restored === 1 ? "" : "s"} to your inbox`);
      keepers.undo = null; keepers.trashedCount = 0; renderKeepers();
      await loadInbox(); await loadFolders(); renderRail();
    } else { toast("Couldn’t restore: " + ((r && r.error) || "unknown"), { error: true }); if (b) { b.disabled = false; b.textContent = "Undo clear"; } }
  } catch (e) { toast("Couldn’t restore: " + e.message, { error: true }); if (b) { b.disabled = false; b.textContent = "Undo clear"; } }
}

function renderKeepers() {
  const el = $("#keepers-view");
  if (!el || state.view.type !== "keepers") return;
  if (keepers.account && keepers.account !== state.activeAccount && keepers.phase !== "scanning") keepers = freshKeepers();
  // The "Tidy up" (file/clear) flow takes over the pane while it's active…
  if (keepers.phase === "scanning") return renderKiScan(el);
  if (keepers.phase === "filing")   return renderKiFiling(el);
  if (keepers.phase === "done")     return renderKiDone(el);
  if (keepers.phase === "error")    return renderKiError(el);
  if (keepers.phase === "review")   return renderKiReview(el);
  // …otherwise this is the persistent Important mailbox (default).
  if (imp.phase === "scanning") return renderImpScanning(el);
  return renderImpMailbox(el);
}

function renderKiIntro(el) {
  const acc = acctById(state.activeAccount);
  const supported = acc && acc.provider === "yahoo";
  el.innerHTML = `<div class="cu-wrap"><div class="ki-intro">
    <div class="ki-intro-icon">${svgFindImportant()}</div>
    <div class="cu-status-title">Find what matters</div>
    <div class="ki-intro-text">ClearKeep will read through your whole inbox and pull out the emails that look important — custody, school, health, bills — and file them into your folders. Then it can sweep the leftover clutter into Trash, so what's left is the mail that matters. Nothing is deleted permanently — Trash can be undone.</div>
    ${supported
      ? `<button class="cu-btn cu-btn-primary" id="ki-start" type="button">Find important mail</button>
         <div class="ki-intro-note">Reads sender &amp; subject only — never the contents. Takes a few minutes.</div>`
      : `<div class="cu-status-sub">This works on Yahoo accounts right now. Switch to a Yahoo account to use it.</div>`}
  </div></div>`;
  if (supported) { const b = $("#ki-start"); if (b) b.addEventListener("click", keepersScan); }
}

function renderKiScan(el) {
  const bi = keepers.batchInfo;
  const found = keepers.keep.length;
  const sub = bi
    ? `batch ${Math.min(bi.done, bi.total)} / ${bi.total}` + (found ? ` · ${found} important found so far` : "")
    : (keepers.total ? `${keepers.total.toLocaleString()} emails to read…` : "Starting…");
  const bar = bi && bi.total
    ? `<div class="ki-bar"><b style="width:${Math.round(bi.done / bi.total * 100)}%"></b></div>`
    : `<div class="cu-bar"><span></span></div>`;
  el.innerHTML = `<div class="cu-wrap"><div class="cu-status">
    <div class="cu-spinner"></div>
    <div class="cu-status-title">Reading your inbox…</div>
    <div class="cu-status-sub">${escapeHtml(sub)}</div>
    ${bar}
  </div></div>`;
}

function renderKiReview(el) {
  const groups = keepersGroups();
  const folderNames = [...groups.keys()].filter((k) => k);
  const hasInboxKeep = groups.has("");
  const headBits = [`${keepers.keep.length} important`];
  if (keepers.junkCount) headBits.push(`${keepers.junkCount.toLocaleString()} look like clutter`);
  if (keepers.uncertainCount) headBits.push(`${keepers.uncertainCount} unsure`);
  const willFile = keepersFiles().length;
  const willClear = keepers.clearJunk && keepers.junkCount;
  const canTidy = willFile || willClear;

  const rowHtml = (r, fileable) => `<div class="ki-row${fileable ? "" : " ki-row-stay"}">
    ${fileable
      ? `<button class="ki-check${r.selected ? " on" : ""}" data-id="${escapeHtml(r.messageId)}">${checkSvg()}</button>`
      : `<span class="ki-dot"></span>`}
    <div class="ki-row-main">
      <div class="ki-sender">${escapeHtml(cleanName(r.fromName) || r.fromEmail)}</div>
      <div class="ki-subject">${escapeHtml(cleanName(r.subject))}</div>
    </div>
    <div class="ki-why">${escapeHtml(r.why)}</div>
  </div>`;
  const groupHtml = (folder, rows) => {
    const fileable = !!folder;
    const allSel = rows.every((r) => r.selected);
    return `<div class="ki-group">
      <div class="ki-group-head">
        ${fileable
          ? `<button class="ki-check ki-check-all${allSel ? " on" : ""}" data-folder="${escapeHtml(folder)}">${checkSvg()}</button>
             <span class="ki-group-name">→ ${escapeHtml(folder)}</span>`
          : `<span class="ki-group-name ki-group-stay">Staying in your inbox</span>`}
        <span class="ki-group-count">${rows.length}</span>
      </div>
      <div class="ki-rows">${rows.map((r) => rowHtml(r, fileable)).join("")}</div>
    </div>`;
  };

  const clutterHtml = keepers.junkCount ? `<div class="ki-group ki-clutter${keepers.clearJunk ? "" : " off"}">
    <div class="ki-group-head">
      <span class="ki-group-name ki-group-clutter">${keepers.clearJunk ? "Clutter → Trash" : "Clutter (kept)"}</span>
      <span class="ki-group-count">${keepers.junkCount.toLocaleString()}</span>
    </div>
    <div class="ki-rows">
      ${keepers.junkSample.map((s) => `<div class="ki-row ki-row-stay">
        <span class="ki-dot"></span>
        <div class="ki-row-main"><div class="ki-sender">${escapeHtml(cleanName(s.fromName) || "")}</div><div class="ki-subject">${escapeHtml(cleanName(s.subject))}</div></div>
      </div>`).join("")}
      ${keepers.junkCount > keepers.junkSample.length ? `<div class="ki-more">+ ${(keepers.junkCount - keepers.junkSample.length).toLocaleString()} more like these</div>` : ""}
    </div>
  </div>` : "";

  el.innerHTML = `<div class="ki-pane">
    <div class="ki-header"><div class="ki-title">Find important <span class="ki-sub">${escapeHtml(headBits.join(" · "))}</span></div></div>
    <div class="ki-scroll">
      ${keepers.keep.length === 0 && !keepers.junkCount
        ? `<div class="ki-empty">No important one-off mail found — your inbox looks like it's already in good shape.</div>`
        : folderNames.map((f) => groupHtml(f, groups.get(f))).join("") + (hasInboxKeep ? groupHtml("", groups.get("")) : "") + clutterHtml}
    </div>
    <div class="ki-footer">
      ${keepers.junkCount
        ? `<button class="ki-clear-toggle${keepers.clearJunk ? " on" : ""}" id="ki-clear" type="button">
             <span class="ki-check${keepers.clearJunk ? " on" : ""}">${checkSvg()}</span>
             <span class="ki-clear-label">Move <b>${keepers.junkCount.toLocaleString()}</b> clutter email${keepers.junkCount === 1 ? "" : "s"} to Trash <em>· recoverable</em></span>
           </button>`
        : `<span></span>`}
      <button class="cu-btn cu-btn-primary" id="ki-tidy" type="button"${canTidy ? "" : " disabled"}>Tidy up</button>
    </div>
  </div>`;

  el.querySelectorAll(".ki-check[data-id]").forEach((b) => b.addEventListener("click", () => {
    const r = keepers.keep.find((x) => x.messageId === b.getAttribute("data-id"));
    if (r) { r.selected = !r.selected; renderKiReview(el); }
  }));
  el.querySelectorAll(".ki-check-all[data-folder]").forEach((b) => b.addEventListener("click", () => {
    const f = b.getAttribute("data-folder");
    const rows = keepers.keep.filter((x) => (x.folder || "") === f);
    const allSel = rows.every((r) => r.selected);
    rows.forEach((r) => (r.selected = !allSel));
    renderKiReview(el);
  }));
  const clearToggle = $("#ki-clear");
  if (clearToggle) clearToggle.addEventListener("click", () => { keepers.clearJunk = !keepers.clearJunk; renderKiReview(el); });
  const tidyBtn = $("#ki-tidy");
  if (tidyBtn) tidyBtn.addEventListener("click", keepersTidyRun);
}

function renderKiFiling(el) {
  const f = keepersFiles().length;
  const c = keepers.clearJunk ? keepers.junkIds.length : 0;
  const bits = [];
  if (f) bits.push(`filing ${f}`);
  if (c) bits.push(`clearing ${c.toLocaleString()} to Trash`);
  el.innerHTML = `<div class="cu-wrap"><div class="cu-status">
    <div class="cu-spinner"></div>
    <div class="cu-status-title">Tidying your inbox…</div>
    <div class="cu-status-sub">${escapeHtml(bits.join(" · ") || "Working…")}${c ? " — this can take a minute" : ""}</div>
  </div></div>`;
}

function renderKiDone(el) {
  const stay = keepers.keep.filter((r) => !r.folder).length;
  const bits = [];
  if (keepers.filedCount) bits.push(`Filed ${keepers.filedCount}`);
  if (keepers.trashedCount) bits.push(`cleared ${keepers.trashedCount.toLocaleString()} to Trash`);
  const title = bits.length ? bits.join(" · ") : "All done";
  const inboxLeft = stay + keepers.uncertainCount;
  const canUndo = keepers.undo && keepers.undo.uids && keepers.undo.uids.length;
  el.innerHTML = `<div class="cu-wrap"><div class="cu-status">
    <div class="ki-done-check">${checkSvg()}</div>
    <div class="cu-status-title">${escapeHtml(title)}</div>
    <div class="cu-status-sub">Your inbox now shows the mail that matters.${inboxLeft ? ` ${inboxLeft.toLocaleString()} email${inboxLeft === 1 ? "" : "s"} kept in your inbox${keepers.uncertainCount ? ` (including ${keepers.uncertainCount} we weren't sure about)` : ""}.` : ""}</div>
    <div class="ki-done-actions">
      ${canUndo ? `<button class="cu-btn" id="ki-undo" type="button">Undo clear</button>` : ""}
      <button class="cu-btn cu-btn-primary" id="ki-back" type="button">Back to inbox</button>
    </div>
  </div></div>`;
  const u = $("#ki-undo"); if (u) u.addEventListener("click", keepersUndoClear);
  const b = $("#ki-back"); if (b) b.addEventListener("click", () => setView({ type: "inbox" }));
}

function renderKiError(el) {
  el.innerHTML = `<div class="cu-wrap"><div class="cu-status">
    <div class="cu-status-title">Couldn’t finish</div>
    <div class="cu-status-sub">${escapeHtml(keepers.error || "Unknown error")}</div>
    <button class="cu-btn cu-btn-primary" id="ki-retry" type="button">Try again</button>
  </div></div>`;
  const b = $("#ki-retry"); if (b) b.addEventListener("click", keepersScan);
}

// ── Clean up (bulk unsubscribe + purge to Trash) ──────────────────────────────
// Phases: idle → indexing → review → (confirm) → running → done | error.
// Selection lives on each row (r.selected/unsub/trash); the AI suggests defaults,
// the human approves, then we execute server-side. Everything goes to Trash
// (recoverable); the run returns an undo manifest.
function freshCleanup() {
  return { phase: "idle", account: null, rows: [], senderCount: 0, excluded: 0,
           error: null, sort: "spam", dir: "desc", filter: "all", skipUnsub: false, confirming: false, result: null, progress: null, batchInfo: null };
}
let cleanup = freshCleanup();

const CU_TIER = {
  "one-click": { dot: "ok", label: "1-click", auto: true },
  mailto:      { dot: "ok", label: "Email",   auto: true },
  link:        { dot: "warn", label: "Link only", auto: false },
  none:        { dot: "off", label: "No method", auto: false },
};

async function cleanupIndex() {
  if (!state.activeAccount) return;
  cleanup = freshCleanup();
  cleanup.phase = "indexing";
  cleanup.account = state.activeAccount;
  renderCleanup();
  // Live progress: scan (messages read) → per-batch (probe + cluster). Each "batch"
  // event with rows streams them into the review table as they're produced.
  const off = api.onCleanupProgress((p) => {
    if (cleanup.account !== state.activeAccount || cleanup.phase !== "indexing") return;
    if (p.phase === "scan") cleanup.progress = p;
    else if (p.phase === "batch") {
      cleanup.batchInfo = { done: p.done, total: p.total, sub: p.sub || 0, subTotal: p.subTotal || 0 };
      if (p.rows && p.rows.length) cuAppendRows(p.rows);
    }
    if (state.view.type === "cleanup") renderCleanup();
  });
  try {
    const res = await api.cleanupIndex({ accountId: cleanup.account });
    if (cleanup.account !== state.activeAccount) return; // account switched mid-scan
    if (!res.ok) { cleanup.phase = "error"; cleanup.error = res.error; renderCleanup(); return; }
    if (cleanup.rows.length === 0 && (res.rows || []).length) cuAppendRows(res.rows); // safety net if events were missed
    cleanup.senderCount = res.senderCount || 0;
    cleanup.excluded = res.excluded || 0;
    cleanup.phase = "review"; // streaming done — drops the "scanning more" banner
    renderCleanup();
  } catch (e) {
    if (cleanup.account !== state.activeAccount) return;
    cleanup.phase = "error"; cleanup.error = e.message; renderCleanup();
  } finally {
    if (off) off();
  }
}

// Append a batch's rows into the live table, merging by vendor so a vendor split
// across batches (its addresses land in different count-tiers) stays one row.
function cuMergeRow(into, r) {
  const rank = { "one-click": 3, mailto: 2, link: 1, none: 0 };
  into.count += r.count;
  into.addresses = [...new Set([...into.addresses, ...r.addresses])];
  into.domains = [...new Set([...into.domains, ...r.domains])];
  into.subjects = [...(into.subjects || []), ...(r.subjects || [])].slice(-12);
  into.spam = into.spam || r.spam;
  if ((rank[r.tier] || 0) > (rank[into.tier] || 0)) {
    into.tier = r.tier; into.postUrl = r.postUrl; into.mailto = r.mailto;
    if (!into.spam && (r.tier === "one-click" || r.tier === "mailto")) into.unsub = true;
  }
}
function cuAppendRows(batchRows) {
  for (const raw of batchRows) {
    const r = { ...raw, selected: true, unsub: !!raw.suggestUnsub, trash: !!raw.suggestTrash };
    const key = String(r.vendor).trim().toLowerCase();
    const existing = cleanup.rows.find((x) => !x.dismissed && String(x.vendor).trim().toLowerCase() === key);
    if (existing) cuMergeRow(existing, r);
    else cleanup.rows.push(r);
  }
}

function cuVisibleRows() {
  let rows = cleanup.rows.filter((r) => !r.dismissed);
  if (cleanup.filter === "safe") rows = rows.filter((r) => CU_TIER[r.tier] && CU_TIER[r.tier].auto && !r.spam);
  else if (cleanup.filter === "manual") rows = rows.filter((r) => !CU_TIER[r.tier] || !CU_TIER[r.tier].auto);
  else if (cleanup.filter === "spam") rows = rows.filter((r) => r.spam);
  const s = cleanup.sort;
  const dir = cleanup.dir === "asc" ? -1 : 1; // flips the primary key; count stays the secondary tiebreaker
  rows = rows.slice().sort((a, b) =>
    s === "vendor" ? dir * a.vendor.localeCompare(b.vendor)
    : s === "spam" ? (dir * (Number(b.spam) - Number(a.spam))) || (b.count - a.count)
    : dir * (b.count - a.count));
  return rows;
}
function cuSelected() { return cleanup.rows.filter((r) => r.selected && !r.dismissed); }
function cuWillUnsub(r) { return !cleanup.skipUnsub && !r.personal && r.selected && r.unsub && !r.spam && CU_TIER[r.tier] && CU_TIER[r.tier].auto; }
function cuTotals() {
  const sel = cuSelected();
  return {
    senders: sel.length,
    trash: sel.filter((r) => r.trash).reduce((n, r) => n + r.count, 0),
    unsub: sel.filter((r) => cuWillUnsub(r)).length,
  };
}

function renderCleanup() {
  const el = $("#cleanup-view");
  if (!el) return;
  if (state.view.type !== "cleanup") return;
  if (cleanup.phase === "running")  return renderCuStatus(el, "running");
  if (cleanup.phase === "error")    return renderCuError(el);
  if (cleanup.phase === "done")     return renderCuDone(el);
  // Stay on the full-screen progress until the scan is fully done — the review
  // (with checkboxes) only appears once the COMPLETE payload is ready, so the user
  // never makes selections on a partial list that then shifts under them.
  if (cleanup.phase === "indexing" || cleanup.phase === "idle") return renderCuStatus(el, "indexing");
  return renderCuReview(el);
}

// Segmented progress bar — one segment per batch; completed segments solid, the
// active one partially filled by the within-batch probe count.
function cuSegBar(bi) {
  if (!bi || !bi.total) return `<div class="cu-bar"><span></span></div>`;
  let segs = "";
  for (let i = 0; i < bi.total; i++) {
    if (i < bi.done) segs += `<i class="full"></i>`;
    else if (i === bi.done && bi.subTotal) segs += `<i class="partial"><b style="width:${Math.round(bi.sub / bi.subTotal * 100)}%"></b></i>`;
    else segs += `<i></i>`;
  }
  return `<div class="cu-segbar">${segs}</div>`;
}

function renderCuStatus(el, kind) {
  let title, sub, bar;
  if (kind === "indexing") {
    const bi = cleanup.batchInfo;
    if (bi) {
      title = "Detecting unsubscribe methods…";
      const found = cleanup.rows.length;
      sub = `batch ${Math.min(bi.done + 1, bi.total)} / ${bi.total}` + (found ? ` · ${found} senders found` : "");
      bar = cuSegBar(bi);
    } else {
      const p = cleanup.progress;
      title = "Reading messages…";
      sub = p && p.done ? `${p.done.toLocaleString()} scanned so far` : "Starting…";
      bar = `<div class="cu-bar"><span></span></div>`;
    }
  } else { // running (purge)
    const t = cuTotals();
    title = "Cleaning up…";
    sub = `Trashing ${t.trash.toLocaleString()} email${t.trash === 1 ? "" : "s"} from ${t.senders} sender${t.senders === 1 ? "" : "s"}${t.unsub ? ` · ${t.unsub} unsubscribe${t.unsub === 1 ? "" : "s"}` : ""}`;
    bar = `<div class="cu-bar"><span></span></div>`;
  }
  el.innerHTML =
    `<div class="cu-wrap"><div class="cu-status">
       <div class="cu-spinner"></div>
       <div class="cu-status-title">${escapeHtml(title)}</div>
       <div class="cu-status-sub">${escapeHtml(sub)}</div>
       ${bar}
     </div></div>`;
}

function renderCuError(el) {
  el.innerHTML =
    `<div class="cu-wrap"><div class="cu-status">
       <div class="cu-status-title">Couldn’t scan this account</div>
       <div class="cu-status-sub">${escapeHtml(cleanup.error || "Unknown error")}</div>
       <button class="cu-btn cu-btn-primary" id="cu-retry" type="button">Try again</button>
     </div></div>`;
  $("#cu-retry").addEventListener("click", cleanupIndex);
}

// Subject-preview popover — recent, deduped subject lines for a row so the user
// can judge keep-vs-trash at a glance.
let cuPopEl = null;
function closeSubjectPopover() {
  if (!cuPopEl) return;
  cuPopEl.remove(); cuPopEl = null;
  document.removeEventListener("mousedown", cuPopOutside, true);
  document.removeEventListener("keydown", cuPopKey, true);
}
function cuPopOutside(e) { if (cuPopEl && !cuPopEl.contains(e.target) && !e.target.closest(".cu-eye")) closeSubjectPopover(); }
function cuPopKey(e) { if (e.key === "Escape") closeSubjectPopover(); }
function openSubjectPopover(anchor, row) {
  closeSubjectPopover();
  if (!row) return;
  const seen = new Set(), subs = [];
  for (const s of (row.subjects || []).slice().reverse()) { // most recent first
    const c = cleanName(s).trim(), k = c.toLowerCase();
    if (c && !seen.has(k)) { seen.add(k); subs.push(c); }
  }
  const list = subs.length
    ? subs.slice(0, 10).map((s) => `<li>${escapeHtml(s)}</li>`).join("")
    : `<li class="cu-pop-empty">No subjects captured</li>`;
  const pop = document.createElement("div");
  pop.className = "cu-popover";
  pop.innerHTML = `<div class="cu-pop-head">${escapeHtml(cleanName(row.vendor))} · ${row.count.toLocaleString()} email${row.count === 1 ? "" : "s"}${subs.length > 10 ? ` · showing 10` : ""}</div><ul class="cu-pop-list">${list}</ul>`;
  document.body.appendChild(pop);
  const r = anchor.getBoundingClientRect();
  let left = Math.max(8, Math.min(r.left, window.innerWidth - pop.offsetWidth - 12));
  let top = r.bottom + 6;
  if (top + pop.offsetHeight > window.innerHeight - 8) top = Math.max(8, r.top - pop.offsetHeight - 6); // flip up if no room
  pop.style.left = `${left}px`; pop.style.top = `${top}px`;
  cuPopEl = pop;
  const rowsEl = anchor.closest(".cu-rows") || anchor.closest(".theme-rows"); // scroll container in either the review pane or the theme modal
  if (rowsEl) rowsEl.addEventListener("scroll", closeSubjectPopover, { once: true });
  setTimeout(() => { document.addEventListener("mousedown", cuPopOutside, true); document.addEventListener("keydown", cuPopKey, true); }, 0);
}

function renderCuReview(el) {
  closeSubjectPopover(); // don't leave a stale popover floating after a re-render
  const prevScroll = (el.querySelector(".cu-rows") || {}).scrollTop || 0; // preserve place across re-render
  const rows = cuVisibleRows();
  const t = cuTotals();
  const safeCount = cleanup.rows.filter((r) => !r.dismissed && CU_TIER[r.tier] && CU_TIER[r.tier].auto && !r.spam).length;
  const manualCount = cleanup.rows.filter((r) => !r.dismissed).length - safeCount;
  const allSelected = rows.length > 0 && rows.every((r) => r.selected);
  const streaming = cleanup.phase === "indexing"; // rows still arriving
  const bi = cleanup.batchInfo;
  const streamStrip = streaming
    ? `<div class="cu-stream">${cuSegBar(bi)}<span class="cu-stream-label">Scanning more… batch ${bi ? Math.min(bi.done + 1, bi.total) : 1} / ${bi ? bi.total : "…"}</span></div>`
    : "";

  const filterOpts = [["all", "All"], ["safe", "Safe-unsub"], ["manual", "Manual / none"], ["spam", "Spam"]];
  const sortOpts = [["spam", "Spam"], ["count", "Volume"], ["vendor", "Vendor"]];
  // direction tooltip describes what rises to the top for the current sort key
  const dirTitle = cleanup.sort === "spam"
    ? (cleanup.dir === "asc" ? "Valuable (non-spam) first — click for spam first" : "Spam first — click for valuable first")
    : cleanup.sort === "vendor"
    ? (cleanup.dir === "asc" ? "Z → A — click for A → Z" : "A → Z — click for Z → A")
    : (cleanup.dir === "asc" ? "Fewest first — click for most first" : "Most first — click for fewest first");
  const dirArrow = cleanup.dir === "asc"
    ? `<path d="M8 12.5V3.5M8 3.5L4.5 7M8 3.5L11.5 7" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round"/>`
    : `<path d="M8 3.5V12.5M8 12.5L4.5 9M8 12.5L11.5 9" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round"/>`;

  el.innerHTML = `
    <div class="cu-wrap">
      <div class="cu-head">
        <div class="cu-head-top">
          <div class="cu-title">Clean up</div>
          <div class="cu-summary-meta">${cleanup.rows.filter((r) => !r.dismissed).length} senders · ${cleanup.rows.reduce((n, r) => r.dismissed ? n : n + r.count, 0).toLocaleString()} emails${cleanup.excluded ? ` · ${cleanup.excluded} low-volume senders not shown` : ""}</div>
        </div>
        <div class="cu-controls">
          <label class="cu-selall"><input type="checkbox" id="cu-selall" ${allSelected ? "checked" : ""}/> Select all</label>
          <label class="cu-selall" title="Trash only — don't send any unsubscribe requests this run"><input type="checkbox" id="cu-skipunsub" ${cleanup.skipUnsub ? "checked" : ""}/> Skip unsubscribes</label>
          <span class="cu-controls-meta">Unsub: ${cleanup.skipUnsub ? "0 (skipped)" : `${safeCount} safe · ${manualCount} manual/none`}</span>
          <span class="cu-spacer"></span>
          <span class="cu-field">Sort <select id="cu-sort">${sortOpts.map(([v, l]) => `<option value="${v}" ${cleanup.sort === v ? "selected" : ""}>${l}</option>`).join("")}</select><button class="cu-dir" id="cu-dir" type="button" title="${dirTitle}" aria-label="${dirTitle}"><svg width="14" height="14" viewBox="0 0 16 16" fill="none" aria-hidden="true">${dirArrow}</svg></button></span>
          <span class="cu-field">Filter <select id="cu-filter">${filterOpts.map(([v, l]) => `<option value="${v}" ${cleanup.filter === v ? "selected" : ""}>${l}</option>`).join("")}</select></span>
        </div>
      </div>
      ${streamStrip}
      <div class="cu-rows">${rows.map(cuRowHtml).join("") || `<div class="cu-empty">${streaming ? "Scanning…" : "No senders match this filter."}</div>`}</div>
      ${cuFooterHtml(t)}
    </div>`;

  const rowsEl = el.querySelector(".cu-rows");
  if (rowsEl) rowsEl.scrollTop = prevScroll; // keep the user's scroll position

  // wire controls
  $("#cu-sort").addEventListener("change", (e) => { cleanup.sort = e.target.value; renderCuReview(el); });
  $("#cu-dir").addEventListener("click", () => { cleanup.dir = cleanup.dir === "asc" ? "desc" : "asc"; renderCuReview(el); });
  $("#cu-filter").addEventListener("change", (e) => { cleanup.filter = e.target.value; renderCuReview(el); });
  $("#cu-selall").addEventListener("change", (e) => { rows.forEach((r) => { r.selected = e.target.checked; }); renderCuReview(el); });
  $("#cu-skipunsub").addEventListener("change", (e) => { cleanup.skipUnsub = e.target.checked; renderCuReview(el); });
  el.querySelectorAll(".cu-row").forEach((rowEl) => {
    const id = rowEl.getAttribute("data-id");
    const row = cleanup.rows.find((r) => r.id === id);
    if (!row) return;
    rowEl.querySelector(".cu-check").addEventListener("change", (e) => { row.selected = e.target.checked; renderCuReview(el); });
    const u = rowEl.querySelector(".cu-toggle-unsub");
    if (u && !u.disabled) u.addEventListener("change", (e) => { row.unsub = e.target.checked; updateCuFooter(); });
    const tr = rowEl.querySelector(".cu-toggle-trash");
    if (tr && !tr.disabled) tr.addEventListener("change", (e) => { row.trash = e.target.checked; updateCuFooter(); });
    rowEl.querySelector(".cu-dismiss").addEventListener("click", () => { row.dismissed = true; renderCuReview(el); });
    rowEl.querySelector(".cu-eye").addEventListener("click", (e) => { e.stopPropagation(); openSubjectPopover(e.currentTarget, row); });
  });
  if (cleanup.confirming) wireCuConfirm(el); else wireCuRun(el);
}

function cuRowHtml(r) {
  const tier = CU_TIER[r.tier] || CU_TIER.none;
  const unsubDisabled = r.personal || cleanup.skipUnsub || r.spam || !tier.auto;
  const unsubChecked = r.unsub && !unsubDisabled;
  const trashDisabled = r.personal; // personal correspondence can't be trashed
  return `
    <div class="cu-row${r.selected ? "" : " cu-row-off"}${r.personal ? " cu-row-personal" : ""}" data-id="${r.id}">
      <input type="checkbox" class="cu-check" ${r.selected ? "checked" : ""} title="Include this sender"/>
      <span class="cu-dot cu-dot-${tier.dot}" title="${escapeHtml(tier.label)}"></span>
      <div class="cu-vendor">
        <div class="cu-vendor-name">${escapeHtml(cleanName(r.vendor))}${r.personal ? `<span class="cu-badge cu-badge-personal">personal</span>` : r.spam ? `<span class="cu-badge cu-badge-spam">spam</span>` : ""}</div>
        <div class="cu-vendor-addr">${escapeHtml((r.addresses[0] || r.domains[0] || ""))}${r.addresses.length > 1 ? ` +${r.addresses.length - 1}` : ""}</div>
      </div>
      <span class="cu-cat">${escapeHtml(r.category || "other")}</span>
      <span class="cu-count">${r.count.toLocaleString()}<button class="cu-eye" type="button" data-id="${r.id}" title="Preview subject lines" aria-label="Preview subject lines"><svg width="14" height="14" viewBox="0 0 16 16" fill="none"><path d="M1.5 8S3.8 3.5 8 3.5 14.5 8 14.5 8 12.2 12.5 8 12.5 1.5 8 1.5 8Z" stroke="currentColor" stroke-width="1.2"/><circle cx="8" cy="8" r="1.8" stroke="currentColor" stroke-width="1.2"/></svg></button></span>
      <span class="cu-sample" title="${escapeHtml(cleanName(r.sample || ""))}">${escapeHtml(cleanName(r.sample || ""))}</span>
      <label class="cu-toggle${unsubDisabled ? " cu-toggle-na" : ""}" title="${r.personal ? "Personal correspondence — protected" : cleanup.skipUnsub ? "Unsubscribes skipped this run" : unsubDisabled ? (r.spam ? "Spam — delete only, no unsubscribe" : "No automatic unsubscribe — manual") : "Send unsubscribe (" + tier.label + ")"}">
        <input type="checkbox" class="cu-toggle-unsub" ${unsubChecked ? "checked" : ""} ${unsubDisabled ? "disabled" : ""}/> ${unsubDisabled ? "—" : "Unsub"}
      </label>
      <label class="cu-toggle${trashDisabled ? " cu-toggle-na" : ""}" title="${r.personal ? "Personal correspondence — protected from deletion" : "Move all " + r.count + " to Trash"}">
        <input type="checkbox" class="cu-toggle-trash" ${r.trash && !trashDisabled ? "checked" : ""} ${trashDisabled ? "disabled" : ""}/> ${trashDisabled ? "Kept" : "Trash"}
      </label>
      <button class="cu-dismiss" type="button" title="Ignore this sender" aria-label="Ignore"><svg width="12" height="12" viewBox="0 0 16 16" fill="none"><path d="M4 4L12 12M12 4L4 12" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"/></svg></button>
    </div>`;
}

function cuFooterHtml(t) {
  if (cleanup.confirming) {
    return `<div class="cu-footer cu-footer-confirm">
      <div class="cu-confirm-text">Move <b>${t.trash.toLocaleString()}</b> email${t.trash === 1 ? "" : "s"} to Trash and send <b>${t.unsub}</b> unsubscribe request${t.unsub === 1 ? "" : "s"}? <span class="cu-confirm-note">Trash is recoverable. Unsubscribes can’t be undone.</span></div>
      <div class="cu-footer-actions"><button class="cu-btn" id="cu-back" type="button">Back</button><button class="cu-btn cu-btn-danger" id="cu-go" type="button">Run clean up</button></div>
    </div>`;
  }
  const streaming = cleanup.phase === "indexing"; // don't let them run on a partial set
  return `<div class="cu-footer">
    <div class="cu-footer-meta" id="cu-footer-meta">${cuFooterMeta(t)}</div>
    <div class="cu-footer-actions"><button class="cu-btn cu-btn-primary" id="cu-review" type="button" ${(t.senders && !streaming) ? "" : "disabled"}>${streaming ? "Scanning…" : "Review &amp; run →"}</button></div>
  </div>`;
}
function cuFooterMeta(t) {
  return `Selected: ${t.senders} sender${t.senders === 1 ? "" : "s"} · <b>${t.trash.toLocaleString()}</b> → Trash · ${t.unsub} unsubscribe${t.unsub === 1 ? "" : "s"}`;
}
function updateCuFooter() {
  const m = $("#cu-footer-meta");
  if (m) m.innerHTML = cuFooterMeta(cuTotals());
  const btn = $("#cu-review");
  if (btn) btn.disabled = !cuTotals().senders || cleanup.phase === "indexing";
}
function wireCuRun(el) {
  const b = $("#cu-review");
  if (b) b.addEventListener("click", () => { cleanup.confirming = true; renderCuReview(el); });
}
function wireCuConfirm(el) {
  $("#cu-back").addEventListener("click", () => { cleanup.confirming = false; renderCuReview(el); });
  $("#cu-go").addEventListener("click", cleanupExecute);
}

async function cleanupExecute() {
  const actions = cuSelected()
    .filter((r) => !r.personal && (r.trash || cuWillUnsub(r))) // personal correspondence is never acted on
    .map((r) => ({ vendor: r.vendor, addresses: r.addresses, domains: r.domains, spam: r.spam, personal: r.personal,
                   tier: r.tier, postUrl: r.postUrl, mailto: r.mailto,
                   unsub: cuWillUnsub(r), trash: r.trash }));
  if (!actions.length) { cleanup.confirming = false; renderCleanup(); return; }
  cleanup.confirming = false;
  cleanup.phase = "running";
  renderCleanup();
  try {
    const res = await api.cleanupExecute({ accountId: cleanup.account, actions });
    if (cleanup.account !== state.activeAccount) return;
    if (!res.ok) { cleanup.phase = "error"; cleanup.error = res.error; renderCleanup(); return; }
    cleanup.result = res;
    cleanup.phase = "done";
    renderCleanup();
    // Resync inbox + counts now that mail moved to Trash server-side.
    await loadInbox(); await loadFolders(); renderRail();
  } catch (e) {
    if (cleanup.account !== state.activeAccount) return;
    cleanup.phase = "error"; cleanup.error = e.message; renderCleanup();
  }
}

function renderCuDone(el) {
  const r = cleanup.result || {};
  const failed = r.failed || [];
  el.innerHTML = `
    <div class="cu-wrap"><div class="cu-status">
      <div class="cu-status-check"><svg width="22" height="22" viewBox="0 0 16 16" fill="none"><path d="M3.5 8.5L6.5 11.5L12.5 4.5" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"/></svg></div>
      <div class="cu-status-title">Trashed ${(r.trashed || 0).toLocaleString()} email${r.trashed === 1 ? "" : "s"} · ${r.unsubscribed || 0} unsubscribe request${r.unsubscribed === 1 ? "" : "s"} sent${failed.length ? ` · ${failed.length} failed` : ""}</div>
      <div class="cu-status-sub">Mail moved to Trash — recoverable in Yahoo for ~7 days. Unsubscribes can’t be reversed.</div>
      ${failed.length ? `<div class="cu-failed">${failed.slice(0, 6).map((f) => `${escapeHtml(f.vendor || "")} (${escapeHtml(f.step)}): ${escapeHtml(f.error || "")}`).join("<br>")}${failed.length > 6 ? `<br>…and ${failed.length - 6} more` : ""}</div>` : ""}
      <div class="cu-footer-actions">
        ${(r.undo && r.undo.length) ? `<button class="cu-btn" id="cu-undo" type="button">Undo Trash</button>` : ""}
        <button class="cu-btn cu-btn-primary" id="cu-done" type="button">Done</button>
      </div>
    </div></div>`;
  const undoBtn = $("#cu-undo");
  if (undoBtn) undoBtn.addEventListener("click", async () => {
    undoBtn.disabled = true; undoBtn.textContent = "Restoring…";
    try {
      const u = await api.cleanupUndo({ accountId: cleanup.account, undo: r.undo });
      toast(u.ok ? `Restored ${u.restored} email${u.restored === 1 ? "" : "s"} to Inbox` : `Undo failed: ${u.error}`, u.ok ? {} : { error: true });
      await loadInbox(); await loadFolders(); renderRail();
    } catch (e) { toast(`Undo failed: ${e.message}`, { error: true }); }
    setView({ type: "inbox" }); // return to the inbox (no surprise re-scan)
  });
  $("#cu-done").addEventListener("click", () => setView({ type: "inbox" })); // done = back to inbox; re-open Clean up to scan again
}

// ── Compose ─────────────────────────────────────────────────────────────────
let composeCtx = null;
let composeAttachments = []; // [{ name, mimeType, size, base64 }]

// ── Reply / Forward helpers ───────────────────────────────────────────────────
function replySubject(m) { return /^re:/i.test(m.subject) ? m.subject : "Re: " + m.subject; }
function fwdSubject(m) { return /^fwd?:/i.test(m.subject) ? m.subject : "Fwd: " + m.subject; }
function parseAddressList(s) {
  return String(s || "").split(/[,;]/).map((x) => firstAddress(x).email.trim().toLowerCase()).filter(Boolean);
}
// Reply-all: To = sender + original To (minus self); Cc = original Cc (minus self/dupes).
function replyAllFields(m) {
  const self = ((acctById(m.account) || {}).address || "").toLowerCase();
  const to = new Set();
  if (m.fromEmail) to.add(m.fromEmail.toLowerCase());
  parseAddressList(m.to).forEach((e) => to.add(e));
  to.delete(self);
  const cc = new Set();
  parseAddressList(m.cc).forEach((e) => { if (e !== self && !to.has(e)) cc.add(e); });
  return { to: [...to].join(", "), cc: [...cc].join(", ") };
}
// Plain text of the currently-open email (from the reader iframe), else snippet.
function currentReaderText() {
  const f = document.querySelector("#reader-content .r-frame");
  try {
    const t = f && f.contentDocument ? (f.contentDocument.body.innerText || "").trim() : "";
    return t;
  } catch { return ""; }
}
function quotedBody(m) {
  const who = m.fromName ? `${m.fromName} <${m.fromEmail}>` : m.fromEmail;
  let original = currentReaderText() || m.snippet || "";
  if (original.length > 5000) original = original.slice(0, 5000) + "…";
  const quoted = escapeHtml(original).replace(/\n/g, "<br>");
  return `<br><br>On ${escapeHtml(m.time || "")}, ${escapeHtml(who)} wrote:<blockquote class="reply-quote">${quoted}</blockquote><br>`;
}

// Zoho's connected token is read-only, so it can't send. (Yahoo SMTP + Gmail API can.)
function accountCanSend(a) { return !!a && a.provider !== "zoho"; }

function openCompose(prefill) {
  const sel = $("#compose-from");
  sel.innerHTML = accountsList.map((a) => { const dn = identityFor(a.id).displayName; const label = dn ? `${dn} <${a.address}>` : a.address; return `<option value="${a.id}"${accountCanSend(a) ? "" : " disabled"}>${escapeHtml(label)}${accountCanSend(a) ? "" : " — can’t send (read-only)"}</option>`; }).join("") || `<option value="">No account</option>`;
  // Default to a send-capable account (never land on a read-only one).
  let def = (prefill && prefill.fromAccount) || state.activeAccount;
  if (!accountCanSend(acctById(def))) { const ok = accountsList.find(accountCanSend); def = ok ? ok.id : def; }
  sel.value = def || "";
  $("#compose-title").textContent = (prefill && prefill.title) || "New message";
  $("#compose-to").value = prefill?.to || "";
  $("#compose-cc").value = prefill?.cc || "";
  $("#compose-bcc").value = "";
  $("#compose-subject").value = prefill?.subject || "";
  const bodyEl = $("#compose-body");
  bodyEl.innerHTML = prefill?.body || ""; // prefill.body is HTML (replies/forwards build a quoted block)
  // Append the sender's signature on a brand-new message (replies keep their prefilled body).
  const sig = identityFor(sel.value).signature;
  if (!prefill && sig) bodyEl.innerHTML = "<br><br>" + escapeHtml(sig).replace(/\n/g, "<br>");
  // Restore an unsent draft when opening a fresh compose (not a reply/forward).
  if (!prefill) {
    const d = loadDraft();
    if (d) {
      if (d.fromAccount && accountCanSend(acctById(d.fromAccount))) sel.value = d.fromAccount;
      $("#compose-to").value = d.to || ""; $("#compose-cc").value = d.cc || ""; $("#compose-bcc").value = d.bcc || "";
      $("#compose-subject").value = d.subject || ""; bodyEl.innerHTML = d.bodyHtml || "";
      if (d.cc) $("#cf-cc").classList.remove("hidden");
      if (d.bcc) $("#cf-bcc").classList.remove("hidden");
      const s = $("#compose-draft-status"); if (s) s.textContent = "Draft restored";
    }
  }
  // Reveal Cc/Bcc when a reply-all prefills Cc; otherwise keep them tucked away.
  const showCc = !!(prefill && prefill.cc);
  $("#cf-cc").classList.toggle("hidden", !showCc);
  $("#cf-bcc").classList.add("hidden");
  composeCtx = prefill || null;
  composeAttachments = [];
  renderComposeAttachments();
  $("#compose").classList.remove("hidden");
  const focusId = prefill && prefill.focus === "to" ? "#compose-to" : (prefill ? "#compose-body" : "#compose-to");
  setTimeout(() => { const el = $(focusId); if (el) el.focus(); }, 30);
}
function closeCompose() { $("#compose").classList.add("hidden"); composeCtx = null; composeAttachments = []; }
function composeHasContent() {
  return !!($("#compose-to").value.trim() || $("#compose-cc").value.trim() || $("#compose-bcc").value.trim() ||
    $("#compose-subject").value.trim() || $("#compose-body").innerText.trim() || composeAttachments.length);
}
// Close from the X / Discard: confirm if there's unsent content so a message isn't lost.
function discardCompose() {
  if (composeHasContent()) toast("Discard this message?", { warn: true, label: "Discard", fn: () => { clearDraft(); closeCompose(); } });
  else { clearDraft(); closeCompose(); }
}

// ── Local draft autosave (restores an unsent message after close/crash) ───────
const DRAFT_KEY = "clearkeep.draft";
let draftTimer = null;
function composeDraft() {
  return { fromAccount: $("#compose-from").value, to: $("#compose-to").value, cc: $("#compose-cc").value,
    bcc: $("#compose-bcc").value, subject: $("#compose-subject").value, bodyHtml: $("#compose-body").innerHTML };
}
function saveDraftNow() {
  if ($("#compose").classList.contains("hidden")) return;
  if (!composeHasContent()) { clearDraft(); return; }
  try { localStorage.setItem(DRAFT_KEY, JSON.stringify(composeDraft())); const s = $("#compose-draft-status"); if (s) s.textContent = "Draft saved"; } catch {}
}
function scheduleDraftSave() { clearTimeout(draftTimer); draftTimer = setTimeout(saveDraftNow, 800); }
function loadDraft() { try { return JSON.parse(localStorage.getItem(DRAFT_KEY)); } catch { return null; } }
function clearDraft() { try { localStorage.removeItem(DRAFT_KEY); } catch {} const s = $("#compose-draft-status"); if (s) s.textContent = ""; }

// Per-account sending identity (display name + signature).
let identities = {};
function identityFor(id) { return identities[id] || {}; }
async function loadIdentities() { try { const r = await api.identityAll(); if (r && r.ok) identities = r.identities || {}; } catch {} }

// ── Address book autocomplete (To/Cc/Bcc) ────────────────────────────────────
let contactsList = [];           // [{name, email, count}]
let acEl = null, acInput = null, acIndex = -1, acMatches = [];
async function loadContacts(force) {
  if (!state.activeAccount) { contactsList = []; return; }
  try { const r = await api.contactsList({ accountId: state.activeAccount, force }); if (r && r.ok) contactsList = r.items || []; } catch {}
}
function acClose() { if (acEl) { acEl.remove(); acEl = null; } acInput = null; acIndex = -1; acMatches = []; }
function acToken(input) { const v = input.value; const start = v.lastIndexOf(",") + 1; return { start, text: v.slice(start).trim().toLowerCase() }; }
function acFind(q) {
  const base = q ? contactsList.filter((c) => c.email.includes(q) || (c.name || "").toLowerCase().includes(q)) : contactsList;
  return base.slice(0, 6);
}
function acShow(input) {
  if (!contactsList.length) { acClose(); return; }
  acMatches = acFind(acToken(input).text);
  if (!acMatches.length) { acClose(); return; }
  if (!acEl) { acEl = document.createElement("div"); acEl.className = "ac-dropdown"; document.body.appendChild(acEl); }
  acEl.innerHTML = acMatches.map((c, i) => `<div class="ac-item${i === acIndex ? " active" : ""}" data-i="${i}"><span class="ac-name">${escapeHtml(c.name || c.email)}</span>${c.name ? `<span class="ac-email">${escapeHtml(c.email)}</span>` : ""}</div>`).join("");
  const r = input.getBoundingClientRect();
  acEl.style.left = `${r.left}px`; acEl.style.top = `${r.bottom + 4}px`; acEl.style.width = `${r.width}px`;
  acEl.querySelectorAll(".ac-item").forEach((el) => el.addEventListener("mousedown", (e) => { e.preventDefault(); acPick(input, Number(el.dataset.i)); }));
  acInput = input;
}
function acPick(input, i) {
  const c = acMatches[i]; if (!c) return;
  const { start } = acToken(input);
  const before = input.value.slice(0, start).replace(/,?\s*$/, "");
  input.value = (before ? before + ", " : "") + c.email + ", ";
  acClose(); input.focus();
}
function attachAutocomplete(input) {
  input.setAttribute("autocomplete", "off");
  input.addEventListener("input", () => { acIndex = -1; acShow(input); });
  input.addEventListener("focus", () => acShow(input));
  input.addEventListener("blur", () => setTimeout(acClose, 120));
  input.addEventListener("keydown", (e) => {
    if (!acEl) return;
    if (e.key === "ArrowDown") { e.preventDefault(); acIndex = Math.min(acMatches.length - 1, acIndex + 1); acShow(input); }
    else if (e.key === "ArrowUp") { e.preventDefault(); acIndex = Math.max(0, acIndex - 1); acShow(input); }
    else if ((e.key === "Enter" || e.key === "Tab") && acIndex >= 0) { e.preventDefault(); acPick(input, acIndex); }
    else if (e.key === "Escape") { acClose(); }
  });
}
// Parse a recipient field into bare email addresses (handles "Name <email>").
function parseAddrs(s) {
  return String(s || "").split(",").map((p) => p.trim()).filter(Boolean).map((p) => { const m = p.match(/<([^>]+)>/); return (m ? m[1] : p).trim(); });
}

function renderComposeAttachments() {
  const el = $("#compose-attachments");
  if (!composeAttachments.length) { el.innerHTML = ""; return; }
  el.innerHTML = composeAttachments.map((a, i) => `
    <span class="compose-chip" title="${escapeHtml(a.name)}">
      <span class="cc-name">${escapeHtml(a.name)}</span>
      <span class="cc-size">${FILE_KB(a.size || 0)}</span>
      <button class="cc-remove" data-idx="${i}" type="button" title="Remove"><svg width="11" height="11" viewBox="0 0 16 16" fill="none"><path d="M4 4L12 12M12 4L4 12" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"/></svg></button>
    </span>`).join("");
  el.querySelectorAll(".cc-remove").forEach((btn) => {
    btn.addEventListener("click", () => { composeAttachments.splice(Number(btn.dataset.idx), 1); renderComposeAttachments(); });
  });
}

function readFileAsBase64(file) {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => { const s = String(r.result); resolve(s.slice(s.indexOf(",") + 1)); };
    r.onerror = () => reject(r.error || new Error("read failed"));
    r.readAsDataURL(file);
  });
}
async function addComposeFiles(fileList) {
  const files = [...fileList];
  for (const f of files) {
    if (f.size > 20 * 1024 * 1024) { toast(`${f.name} is over 20 MB`); continue; }
    try {
      const base64 = await readFileAsBase64(f);
      composeAttachments.push({ name: f.name, mimeType: f.type || "application/octet-stream", size: f.size, base64 });
    } catch { toast(`Could not attach ${f.name}`); }
  }
  renderComposeAttachments();
}

async function sendCompose() {
  const accountId = $("#compose-from").value;
  const to = $("#compose-to").value.trim();
  const cc = $("#compose-cc").value.trim();
  const bcc = $("#compose-bcc").value.trim();
  const subject = $("#compose-subject").value.trim();
  const bodyEl = $("#compose-body");
  const bodyHtml = bodyEl.innerHTML;
  const body = bodyEl.innerText; // plain-text fallback
  if (!accountId) { toast("Add an account first"); return; }
  if (!accountCanSend(acctById(accountId))) { toast("This account is read-only and can’t send. Pick another in From.", { error: true }); return; }
  if (!to && !cc && !bcc) { toast("Add a recipient"); return; }
  const bad = [to, cc, bcc].flatMap(parseAddrs).find((a) => a && !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(a));
  if (bad) { toast(`Check this address: ${bad}`, { error: true }); return; }
  $("#compose-send").disabled = true;
  $("#compose-send").textContent = "Sending…";
  try {
    const res = await api.send({ accountId, to, cc, bcc, subject, body, html: bodyHtml, attachments: composeAttachments });
    if (res.ok) {
      // Remember these recipients so they autocomplete next time.
      const recips = [to, cc].flatMap((s) => s.split(",")).map((p) => p.trim()).filter(Boolean).map((p) => {
        const m = p.match(/^\s*"?([^"<]*?)"?\s*<([^>]+)>/); return m ? { name: (m[1] || "").trim(), email: m[2].trim() } : { name: "", email: p };
      });
      api.contactsAdd({ accountId, recipients: recips }).then((r) => { if (r && r.ok) contactsList = r.items; }).catch(() => {});
      clearDraft(); closeCompose(); toast("Sent");
    } else toast(`Send failed: ${res.error}`);
  } catch (err) {
    toast(`Send failed: ${err.message}`);
  } finally {
    $("#compose-send").disabled = false;
    $("#compose-send").textContent = "Send";
  }
}

// ── Settings ────────────────────────────────────────────────────────────────
function renderAccountList() {
  const el = $("#account-list");
  el.innerHTML = "";
  if (accountsList.length === 0) { el.innerHTML = `<div class="account-empty">No accounts connected yet.</div>`; return; }
  accountsList.forEach((a) => {
    const card = document.createElement("div");
    card.className = "account-card";
    const idy = identityFor(a.id);
    card.innerHTML = `
      <div class="ac-top">
        ${avatarHtml(a.address, a.address, "avatar-sm")}
        <div class="ac-main">
          <div class="ac-addr">${escapeHtml(a.address)}</div>
          <div class="ac-host">${a.provider === "gmail" ? "Gmail" : a.provider === "yahoo" ? "Yahoo" : "Zoho Mail"} · connected</div>
        </div>
        <button class="ac-remove" data-id="${a.id}" title="Remove">${svgMailbox("trash")}</button>
      </div>
      <div class="ac-identity">
        <input class="ac-name-input" type="text" placeholder="Display name (e.g. ${escapeHtml(a.address.split("@")[0])})" value="${escapeHtml(idy.displayName || "")}" />
        <textarea class="ac-sig-input" rows="2" placeholder="Signature (optional) — added to the bottom of new messages">${escapeHtml(idy.signature || "")}</textarea>
        <div class="ac-id-row"><span class="ac-id-saved" data-id="${a.id}"></span><button class="ghost-btn ac-id-save" type="button">Save identity</button></div>
      </div>`;
    card.querySelector(".ac-remove").addEventListener("click", async () => {
      await api.removeAccount(a.id);
      await loadAccounts();
      renderAccountList();
      MESSAGES = MESSAGES.filter((m) => m.account !== a.id);
      renderAll();
      toast("Account removed");
    });
    card.querySelector(".ac-id-save").addEventListener("click", async () => {
      const displayName = card.querySelector(".ac-name-input").value;
      const signature = card.querySelector(".ac-sig-input").value;
      const r = await api.identitySet({ accountId: a.id, displayName, signature });
      if (r && r.ok) { identities[a.id] = r.identity; const s = card.querySelector(".ac-id-saved"); if (s) { s.textContent = "Saved"; setTimeout(() => { s.textContent = ""; }, 1800); } renderRail(); }
      else toast("Couldn’t save identity", { error: true });
    });
    el.appendChild(card);
  });
  hydrateAvatars(el);
}

async function openSettings() {
  renderAccountList();
  const z = await api.getOAuth("zoho");
  $("#oauth-id").value = z.clientId || "";
  $("#oauth-secret").value = z.hasSecret ? "••••••••••••" : "";
  setStatus("#oauth-status", z.hasSecret ? "Client saved." : "", z.hasSecret ? "ok" : "");
  setStatus("#connect-status", "");
  $("#connect-code").value = "";
  const g = await api.getOAuth("gmail");
  $("#g-id").value = g.clientId || "";
  $("#g-secret").value = g.hasSecret ? "••••••••••••" : "";
  setStatus("#gmail-status", g.hasSecret ? "Google client saved." : "", g.hasSecret ? "ok" : "");
  $("#gmail-client").classList.toggle("hidden", g.hasSecret); // expand setup if not yet configured
  $("#y-email").value = ""; $("#y-pass").value = "";
  setStatus("#yahoo-status", "");
  $("#settings").classList.remove("hidden");
}
function closeSettings() { $("#settings").classList.add("hidden"); }

function setStatus(sel, text, kind) {
  const s = $(sel);
  s.innerHTML = text || "";
  s.className = "add-status" + (kind ? " " + kind : "");
}

async function saveOAuth() {
  const clientId = $("#oauth-id").value.trim();
  const secret = $("#oauth-secret").value;
  if (!clientId) { setStatus("#oauth-status", "Enter your Client ID.", "err"); return; }
  if (!secret || /^•+$/.test(secret)) { setStatus("#oauth-status", "Re-enter your Client Secret to save.", "err"); return; }
  setStatus("#oauth-status", "Saving…", "pending");
  $("#oauth-save").disabled = true;
  try {
    const res = await api.setOAuth({ provider: "zoho", clientId, clientSecret: secret });
    if (res.ok) { setStatus("#oauth-status", "✓ Client saved.", "ok"); $("#oauth-secret").value = "••••••••••••"; }
    else setStatus("#oauth-status", res.error, "err");
  } finally { $("#oauth-save").disabled = false; }
}

async function saveGoogleClient() {
  const clientId = $("#g-id").value.trim();
  const secret = $("#g-secret").value;
  if (!clientId) { setStatus("#gmail-status", "Enter your Google Client ID.", "err"); return; }
  if (!secret || /^•+$/.test(secret)) { setStatus("#gmail-status", "Re-enter your Google Client Secret to save.", "err"); return; }
  setStatus("#gmail-status", "Saving…", "pending");
  $("#g-save").disabled = true;
  try {
    const res = await api.setOAuth({ provider: "gmail", clientId, clientSecret: secret });
    if (res.ok) { setStatus("#gmail-status", "✓ Google client saved — now Sign in with Google.", "ok"); $("#g-secret").value = "••••••••••••"; }
    else setStatus("#gmail-status", res.error, "err");
  } finally { $("#g-save").disabled = false; }
}

async function connectGoogleAccount() {
  setStatus("#gmail-status", `<span class="palette-thinking">${sparkSvg()} Waiting for Google sign-in in your browser…</span>`);
  $("#gmail-signin").disabled = true;
  try {
    const res = await api.connectGoogle();
    if (!res.ok) { setStatus("#gmail-status", res.error, "err"); return; }
    setStatus("#gmail-status", `✓ Connected ${res.account.address}.`, "ok");
    await loadAccounts(); renderAccountList(); renderAll(); loadInbox();
  } catch (err) { setStatus("#gmail-status", err.message, "err"); }
  finally { $("#gmail-signin").disabled = false; }
}

async function connectYahooAccount() {
  const address = $("#y-email").value.trim();
  const password = $("#y-pass").value.trim();
  if (!address || !password) { setStatus("#yahoo-status", "Enter your Yahoo email and app password.", "err"); return; }
  setStatus("#yahoo-status", `<span class="palette-thinking">${sparkSvg()} Connecting to Yahoo…</span>`);
  $("#y-connect").disabled = true;
  try {
    const res = await api.connectYahoo({ address, password });
    if (!res.ok) { setStatus("#yahoo-status", res.error, "err"); return; }
    setStatus("#yahoo-status", `✓ Connected ${res.account.address}.`, "ok");
    $("#y-pass").value = "";
    await loadAccounts(); renderAccountList(); renderAll(); loadInbox();
  } catch (err) { setStatus("#yahoo-status", err.message, "err"); }
  finally { $("#y-connect").disabled = false; }
}

async function connectAccount() {
  const grantCode = $("#connect-code").value.trim();
  if (!grantCode) { setStatus("#connect-status", "Paste a grant code.", "err"); return; }
  setStatus("#connect-status", "Connecting…", "pending");
  $("#connect-btn").disabled = true;
  try {
    const res = await api.connectAccount({ grantCode });
    if (!res.ok) { setStatus("#connect-status", res.error, "err"); return; }
    $("#connect-code").value = "";
    const sc = (res.scope || "").toLowerCase();
    const hasFolders = sc.includes("folders");
    const hasWrite = sc.includes("messages.all") || sc.includes("messages.update") || sc.includes("messages.create");
    if (!hasFolders || !hasWrite) {
      setStatus("#connect-status", `Connected, but scope is read-only (${res.scope || "limited"}). Delete / Trash / Spam / send need ZohoMail.folders.ALL + ZohoMail.messages.ALL — regenerate the grant code with that exact scope and try again.`, "err");
    } else {
      setStatus("#connect-status", `✓ Connected ${res.account.address} — full read/write.`, "ok");
    }
    await loadAccounts();
    renderAccountList();
    renderAll();
    loadInbox();
  } finally { $("#connect-btn").disabled = false; }
}

// ── Command palette / search ────────────────────────────────────────────────
function isNLQuery(q) { const w = q.trim().split(/\s+/); return w.length >= 2 && q.trim().length >= 6; }
function sparkSvg() { return '<svg width="11" height="11" viewBox="0 0 16 16" fill="none"><path d="M6.5 2.2L7.6 5.4L10.8 6.5L7.6 7.6L6.5 10.8L5.4 7.6L2.2 6.5L5.4 5.4L6.5 2.2Z" stroke="currentColor" stroke-width="1.2" stroke-linejoin="round"/></svg>'; }
function setPaletteStatus(html) { $("#palette-status").innerHTML = html; }

function paletteItems(list) {
  return list.map((m, idx) => ({
    i: idx,
    from: m.fromName && m.fromName !== m.fromEmail ? `${m.fromName} <${m.fromEmail}>` : m.fromEmail,
    subject: m.subject,
    snippet: (m.snippet || "").slice(0, 120),
    cat: m.category,
    date: m.dateMs ? new Date(m.dateMs).toISOString().slice(0, 10) : "",
  }));
}
function localSearch(q) {
  const s = q.trim().toLowerCase();
  if (!s) return MESSAGES.slice(0, 40);
  return MESSAGES.filter((m) =>
    m.subject.toLowerCase().includes(s) || m.fromName.toLowerCase().includes(s) ||
    m.fromEmail.toLowerCase().includes(s) || (m.snippet || "").toLowerCase().includes(s));
}

function openPalette(prefill) {
  $("#palette-input").value = prefill || "";
  paletteResults = []; paletteActive = -1;
  $("#palette").classList.remove("hidden");
  setTimeout(() => $("#palette-input").focus(), 20);
  runPalette($("#palette-input").value, false);
}
function closePalette() { $("#palette").classList.add("hidden"); clearTimeout(paletteTimer); }
// Deep search: switch to the full screen view IMMEDIATELY with a loading state,
// then run the whole-mailbox search and fill in results when they arrive. Reuses the
// normal message list, so rows are selectable and draggable into folders to file them.
async function runDeepSearch(query) {
  searchViewMessages = [];
  searchViewMeta = { query, errors: [] };
  searchLoading = true;
  const mySeq = ++searchSeq;
  closePalette();
  setView({ type: "search", query }); // renders the loading state right away
  try {
    const scan = await api.searchAll({ accountId: state.activeAccount, query, cap: 600 });
    if (mySeq !== searchSeq || state.view.type !== "search") return; // superseded / navigated away
    searchViewMessages = (scan.messages || []).map((m) => ({ ...m, ...classify(m) }));
    searchViewMeta = { query, errors: scan.errors || [] };
    searchLoading = false;
    renderList();
    if (searchViewMessages.length) hydrateSnippets(searchViewMessages);
    else if (scan.errors && scan.errors.length) toast(scan.errors[0].error, { error: true });
  } catch (err) {
    if (mySeq !== searchSeq || state.view.type !== "search") return;
    searchLoading = false;
    renderList();
    toast(`Search failed: ${err.message}`, { error: true });
  }
}

async function runPalette(q, isEnter) {
  const seq = ++paletteSeq;
  clearTimeout(paletteTimer);

  if (isEnter && q.trim()) {
    runDeepSearch(q.trim()); // closes the palette + opens the screen view immediately
    return;
  }

  // Tier 1 — instant local
  paletteResults = localSearch(q);
  paletteActive = -1;
  renderPalette();
  setPaletteStatus(q.trim() ? `${paletteResults.length} match${paletteResults.length === 1 ? "" : "es"}` : "Recent");

  // Tier 2 — debounced AI assist, natural-language queries only
  if (isNLQuery(q)) {
    paletteTimer = setTimeout(async () => {
      const seq2 = paletteSeq;
      setPaletteStatus(`<span class="palette-thinking">${sparkSvg()} thinking…</span>`);
      try {
        const pool = MESSAGES.slice();
        const res = await api.searchEmails({ query: q, items: paletteItems(pool) });
        if (seq2 !== paletteSeq) return;
        const aiMsgs = (res.indices || []).map((i) => pool[i]).filter(Boolean);
        const seen = new Set(); const merged = [];
        [...aiMsgs, ...paletteResults].forEach((m) => { if (!seen.has(m.id)) { seen.add(m.id); merged.push(m); } });
        paletteResults = merged;
        renderPalette();
        setPaletteStatus(`${paletteResults.length} match${paletteResults.length === 1 ? "" : "es"} · ✦ AI-assisted`);
      } catch { setPaletteStatus(`${paletteResults.length} matches`); }
    }, 500);
  }
}

function renderPalette() {
  const el = $("#palette-results");
  el.innerHTML = "";
  if (!paletteResults.length) {
    el.innerHTML = `<div class="palette-empty">${$("#palette-input").value.trim() ? "No matches yet — press ↵ to search your whole mailbox." : "Type to search, or ask a question."}</div>`;
    return;
  }
  paletteResults.slice(0, 50).forEach((m, idx) => {
    const row = document.createElement("div");
    row.className = "palette-row" + (idx === paletteActive ? " active" : "");
    row.innerHTML = avatarHtml(cleanName(m.fromName), m.fromEmail, "msg-avatar") +
      `<div class="pr-main"><div class="pr-line1"><span class="pr-sender">${escapeHtml(cleanName(m.fromName))}</span><span class="pr-time">${m.time || ""}</span></div><div class="pr-subject">${escapeHtml(cleanName(m.subject))}</div></div>`;
    row.addEventListener("click", () => openPaletteResult(m));
    el.appendChild(row);
  });
  hydrateAvatars(el);
}

function openPaletteResult(m) {
  closePalette();
  if (m.account && m.account !== state.activeAccount) state.activeAccount = m.account;
  openMessage(m.id);
}

// ── Chrome wiring ───────────────────────────────────────────────────────────
function setLayout(mode) {
  state.layout = mode;
  document.body.setAttribute("data-layout", mode);
  document.querySelectorAll(".layout-seg").forEach((s) => s.classList.toggle("active", s.getAttribute("data-mode") === mode));
  syncReader();
  savePrefs();
}
document.querySelectorAll(".layout-seg").forEach((seg) => seg.addEventListener("click", () => setLayout(seg.getAttribute("data-mode"))));

// List sort / grouping: Timeline (flat) | Status (Unread/Read).
const SORT_LABELS = { timeline: "Timeline", status: "Status" };
function syncSortUI() {
  const lbl = $("#list-sort-label"); if (lbl) lbl.textContent = SORT_LABELS[state.sort] || "Status";
  document.querySelectorAll("#list-sort-menu .ls-option").forEach((o) => o.classList.toggle("active", o.getAttribute("data-sort") === state.sort));
}
function setSort(mode, persist) {
  if (!SORT_LABELS[mode]) return;
  state.sort = mode;
  sectionExpanded.clear();
  syncSortUI();
  renderList();
  if (persist) savePrefs();
}
function closeSortMenu() {
  $("#list-sort-menu").classList.add("hidden");
  $("#list-sort-btn").setAttribute("aria-expanded", "false");
}
$("#list-sort-btn").addEventListener("click", (e) => {
  e.stopPropagation();
  const open = $("#list-sort-menu").classList.toggle("hidden") === false;
  $("#list-sort-btn").setAttribute("aria-expanded", open ? "true" : "false");
});
document.querySelectorAll("#list-sort-menu .ls-option").forEach((o) =>
  o.addEventListener("click", () => { setSort(o.getAttribute("data-sort"), true); closeSortMenu(); }));
document.addEventListener("click", (e) => { const s = $("#list-sort"); if (s && !s.contains(e.target)) closeSortMenu(); });

// Category filter (header): narrows the list to one category; composes with sort.
function populateFilterMenu() {
  const menu = $("#list-filter-menu");
  const opt = (cat, label, dot) =>
    `<button class="ls-option" data-cat="${cat}" type="button"><span class="ls-dot" style="${dot}"></span>${escapeHtml(label)}</button>`;
  menu.innerHTML = opt("all", "All categories", "background:transparent;box-shadow:inset 0 0 0 1.4px var(--text-tertiary)") +
    Object.keys(CATEGORIES).map((k) => opt(k, CATEGORIES[k].label, `background:${CATEGORIES[k].color}`)).join("");
  menu.querySelectorAll(".ls-option").forEach((o) =>
    o.addEventListener("click", () => { setCategoryFilter(o.getAttribute("data-cat"), true); closeFilterMenu(); }));
}
function syncFilterUI() {
  const lbl = $("#list-filter-label");
  if (lbl) lbl.textContent = state.categoryFilter === "all" ? "All" : (CATEGORIES[state.categoryFilter] || {}).label || "All";
  $("#list-filter-btn").classList.toggle("filter-on", state.categoryFilter !== "all");
  document.querySelectorAll("#list-filter-menu .ls-option").forEach((o) => o.classList.toggle("active", o.getAttribute("data-cat") === state.categoryFilter));
}
function setCategoryFilter(cat, persist) {
  if (cat !== "all" && !CATEGORIES[cat]) cat = "all";
  state.categoryFilter = cat;
  sectionExpanded.clear();
  syncFilterUI();
  renderList();
  if (persist) savePrefs();
}
function closeFilterMenu() {
  $("#list-filter-menu").classList.add("hidden");
  $("#list-filter-btn").setAttribute("aria-expanded", "false");
}
$("#list-filter-btn").addEventListener("click", (e) => {
  e.stopPropagation();
  const open = $("#list-filter-menu").classList.toggle("hidden") === false;
  $("#list-filter-btn").setAttribute("aria-expanded", open ? "true" : "false");
});
document.addEventListener("click", (e) => { const f = $("#list-filter"); if (f && !f.contains(e.target)) closeFilterMenu(); });


// Theme: light (default) ↔ dark. Applied via <html data-theme>; persisted in prefs.
// The head boot script sets the attribute pre-paint; this just syncs the toggle + flips it.
function setTheme(dark, persist) {
  document.documentElement.dataset.theme = dark ? "dark" : "light";
  const t = $("#theme-toggle");
  if (t) t.setAttribute("aria-checked", dark ? "true" : "false");
  if (persist) savePrefs();
}
$("#theme-toggle").addEventListener("click", () => setTheme(document.documentElement.dataset.theme !== "dark", true));

// ── Self-update (custom updater; works for the unsigned build) ────────────────
let pendingUpdate = null;     // the available update info, once found
let updatePrompted = false;   // only nag once per session

async function initUpdates() {
  try { const v = await api.appVersion(); const el = $("#app-version"); if (el) el.textContent = "v" + v; } catch {}
  setTimeout(() => checkUpdates(false), 4000);   // quiet auto-check shortly after launch
}

async function checkUpdates(manual) {
  const btn = $("#update-btn");
  if (manual && btn) { btn.disabled = true; btn.textContent = "Checking…"; }
  let res = null;
  try { res = await api.checkUpdate(); } catch {}
  if (!res || !res.ok) {
    if (btn) { btn.disabled = false; btn.textContent = "Check for updates"; btn.classList.remove("update-ready"); }
    if (manual) toast("Couldn't check for updates.", { error: true });
    return;
  }
  if (res.available) {
    pendingUpdate = res;
    if (btn) { btn.disabled = false; btn.textContent = "Update to v" + res.latest; btn.classList.add("update-ready"); }
    if (!updatePrompted) { updatePrompted = true; toast(`ClearKeep v${res.latest} is available`, { label: "Update & Restart", sticky: true, fn: () => applyUpdate() }); }
  } else {
    if (btn) {
      btn.disabled = false; btn.classList.remove("update-ready"); btn.textContent = "Up to date";
      setTimeout(() => { if ($("#update-btn") && !pendingUpdate) $("#update-btn").textContent = "Check for updates"; }, 2500);
    }
    if (manual) toast("ClearKeep is up to date.");
  }
}

async function applyUpdate() {
  if (!pendingUpdate) return;
  toast("Downloading update…", { sticky: true });
  const off = api.onUpdateProgress((p) => {
    if (p.phase === "download") toast(`Downloading update… ${Math.round((p.pct || 0) * 100)}%`, { sticky: true });
    else if (p.phase === "install") toast("Installing — ClearKeep will restart…", { sticky: true });
  });
  let r = null;
  try { r = await api.applyUpdate(pendingUpdate); } catch (e) { r = { ok: false, error: e && e.message }; }
  if (off) off();
  // On success the app relaunches and this never returns; only failures land here.
  if (r && !r.ok) toast("Update failed: " + (r.error || "unknown"), { error: true });
}

$("#update-btn").addEventListener("click", () => { if (pendingUpdate) applyUpdate(); else checkUpdates(true); });

// Workspace-header triage pills → the same views as the rail rows.
$("#pill-keepers").addEventListener("click", () => {
  if (["done", "error"].includes(keepers.phase)) keepers = freshKeepers();
  imp.phase = "mailbox";
  setView({ type: "keepers" });
});
$("#pill-needs").addEventListener("click", () => setView({ type: "needs" }));
$("#pill-cleanup").addEventListener("click", () => setView({ type: "cleanup" }));
$("#pill-ask").addEventListener("click", () => setView({ type: "ask" }));

// Settings (prefs) dropdown
function closePrefsMenu() {
  $("#prefs-menu").classList.add("hidden");
  $("#prefs-btn").setAttribute("aria-expanded", "false");
}
$("#prefs-btn").addEventListener("click", (e) => {
  e.stopPropagation();
  const open = $("#prefs-menu").classList.toggle("hidden") === false;
  $("#prefs-btn").setAttribute("aria-expanded", open ? "true" : "false");
});
document.addEventListener("click", (e) => {
  const p = $(".prefs"); if (p && !p.contains(e.target)) closePrefsMenu();
});

// Reader resize: side-by-side drags the list's right edge (width); when the window
// is narrow the panes stack (see the @media block in main.css), so the same handle
// drags the list's bottom edge (height). We detect which by where the reader sits
// relative to the list — robust to the exact breakpoint.
(function () {
  const handle = $("#reader-resize");
  if (!handle) return;
  handle.addEventListener("mousedown", (e) => {
    e.preventDefault();
    const mainBox = $("#mail-main").getBoundingClientRect();
    const readerBox = $("#reader").getBoundingClientRect();
    const stacked = readerBox.top > mainBox.top + 2; // reader is below the list, not beside it
    handle.classList.add("dragging");
    document.body.style.cursor = stacked ? "ns-resize" : "ew-resize";
    document.body.style.userSelect = "none";
    const move = (ev) => {
      if (stacked) {
        // Resize the LIST row height (reader is flex:1 and fills the rest below).
        // Floor keeps a few rows visible; cap keeps the reader readable.
        const box = $("#mail").getBoundingClientRect();
        const h = Math.min(Math.max(ev.clientY - box.top, 140), box.height - 160);
        document.documentElement.style.setProperty("--list-h", h + "px");
      } else {
        // Resize the LIST column (reader is flex:1 and fills the rest). The list's
        // default 340px is the floor; cap so the reader keeps a comfortable width.
        const left = $("#mail-main").getBoundingClientRect().left;
        const max = Math.max(340, window.innerWidth - 660);
        const w = Math.min(Math.max(ev.clientX - left, 340), max);
        document.documentElement.style.setProperty("--list-w", w + "px");
      }
    };
    const up = () => {
      document.removeEventListener("mousemove", move);
      document.removeEventListener("mouseup", up);
      handle.classList.remove("dragging");
      document.body.style.cursor = "";
      document.body.style.userSelect = "";
      savePrefs();
    };
    document.addEventListener("mousemove", move);
    document.addEventListener("mouseup", up);
  });
})();

$("#refresh-btn").addEventListener("click", () => loadInbox());
$("#workspace-current").addEventListener("click", (e) => { e.stopPropagation(); toggleWorkspaceMenu(); });
document.addEventListener("click", (e) => { const ws = $("#workspace-group"); if (ws && !ws.contains(e.target)) closeWorkspaceMenu(); });
$("#settings-close").addEventListener("click", closeSettings);
$("#settings").addEventListener("click", (e) => { if (e.target.id === "settings") closeSettings(); });
$("#empty-add-btn").addEventListener("click", openSettings);
$("#add-folder-btn").addEventListener("click", openThemeModal);
$("#folders-fold-btn").addEventListener("click", () => { state.foldersExpanded = !state.foldersExpanded; renderRail(); savePrefs(); });
$("#folder-modal").addEventListener("click", (e) => { if (e.target.id === "folder-modal") closeThemeModal(); });

$("#oauth-save").addEventListener("click", saveOAuth);
$("#connect-btn").addEventListener("click", connectAccount);
$("#gmail-signin").addEventListener("click", connectGoogleAccount);
$("#y-connect").addEventListener("click", connectYahooAccount);
$("#g-save").addEventListener("click", saveGoogleClient);
$("#gmail-setup-toggle").addEventListener("click", () => $("#gmail-client").classList.toggle("hidden"));

$("#compose-btn").addEventListener("click", () => openCompose());
$("#compose-close").addEventListener("click", discardCompose);
$("#compose-discard").addEventListener("click", discardCompose);
$("#compose-send").addEventListener("click", sendCompose);
["#compose-to", "#compose-cc", "#compose-bcc"].forEach((sel) => { const el = $(sel); if (el) attachAutocomplete(el); });
// Autosave the draft as the user types.
["#compose-to", "#compose-cc", "#compose-bcc", "#compose-subject", "#compose-body"].forEach((sel) => { const el = $(sel); if (el) el.addEventListener("input", scheduleDraftSave); });
// Rich-text toolbar: keep the body's selection (mousedown preventDefault) then run the command.
$("#compose-toolbar").querySelectorAll(".ct-btn").forEach((btn) => {
  btn.addEventListener("mousedown", (e) => {
    e.preventDefault();
    const cmd = btn.getAttribute("data-cmd");
    $("#compose-body").focus();
    if (cmd === "createLink") {
      const url = sanitizeUrl(prompt("Link URL:", "https://") || "");
      if (url) document.execCommand("createLink", false, url);
    } else document.execCommand(cmd, false, null);
  });
});
// Cmd/Ctrl+Enter sends from anywhere in the composer.
$("#compose").addEventListener("keydown", (e) => { if ((e.metaKey || e.ctrlKey) && e.key === "Enter") { e.preventDefault(); sendCompose(); } });
// Drag-and-drop files anywhere onto the open composer to attach them.
$("#compose").addEventListener("dragover", (e) => { if (e.dataTransfer && [...e.dataTransfer.types].includes("Files")) { e.preventDefault(); $("#compose").classList.add("drag-over"); } });
$("#compose").addEventListener("dragleave", (e) => { if (e.target === $("#compose") || !$("#compose").contains(e.relatedTarget)) $("#compose").classList.remove("drag-over"); });
$("#compose").addEventListener("drop", (e) => { e.preventDefault(); $("#compose").classList.remove("drag-over"); if (e.dataTransfer && e.dataTransfer.files && e.dataTransfer.files.length) addComposeFiles(e.dataTransfer.files); });
$("#compose-attach").addEventListener("click", () => $("#compose-file").click());
$("#compose-file").addEventListener("change", (e) => { addComposeFiles(e.target.files); e.target.value = ""; });
$("#cc-toggle").addEventListener("click", () => {
  const ccHidden = $("#cf-cc").classList.toggle("hidden");
  $("#cf-bcc").classList.toggle("hidden", ccHidden);
  if (!ccHidden) $("#compose-cc").focus();
});
$("#compose").addEventListener("click", (e) => { if (e.target.id === "compose") closeCompose(); });

$("#reader-close").addEventListener("click", deselectMessage);

// Click the empty canvas (the void below/around the rows) to deselect.
$("#message-list").addEventListener("click", (e) => {
  if (state.activeId == null) return;
  if (e.target.closest(".msg-row") || e.target.closest(".list-more")) return;
  deselectMessage();
});
document.querySelectorAll(".reader-act").forEach((btn) => {
  btn.addEventListener("click", () => {
    const act = btn.getAttribute("data-act");
    if (!state.activeId) return;
    const m = findMsg(state.activeId);
    if (!m) return;
    if (act === "reply") { openCompose({ title: "Reply", to: m.fromEmail, subject: replySubject(m), body: quotedBody(m), fromAccount: m.account }); return; }
    if (act === "replyall") { const f = replyAllFields(m); openCompose({ title: "Reply all", to: f.to, cc: f.cc, subject: replySubject(m), body: quotedBody(m), fromAccount: m.account }); return; }
    if (act === "forward") { openCompose({ title: "Forward", to: "", subject: fwdSubject(m), body: quotedBody(m), fromAccount: m.account, focus: "to" }); return; }
    applyAction([state.activeId], act);
  });
});

$("#sel-clear").addEventListener("click", clearSelection);
$("#sel-all").addEventListener("click", toggleSelectAll);
$("#sel-read").addEventListener("click", () => bulkAction("read"));
$("#sel-toinbox").addEventListener("click", () => bulkAction("toinbox"));
$("#sel-archive").addEventListener("click", () => bulkAction("archive"));
$("#sel-trash").addEventListener("click", () => bulkAction("trash"));

// Search bar now triggers the command palette
$("#search-input").addEventListener("focus", () => { $("#search-input").blur(); openPalette(); });
$("#search-input").addEventListener("click", () => openPalette());

$("#palette").addEventListener("click", (e) => { if (e.target.id === "palette") closePalette(); });
$("#palette-input").addEventListener("input", (e) => runPalette(e.target.value, false));
$("#palette-input").addEventListener("keydown", (e) => {
  if (e.key === "ArrowDown") { e.preventDefault(); paletteActive = Math.min(paletteActive + 1, Math.min(paletteResults.length, 50) - 1); renderPalette(); scrollPaletteActive(); }
  else if (e.key === "ArrowUp") { e.preventDefault(); paletteActive = Math.max(paletteActive - 1, -1); renderPalette(); scrollPaletteActive(); }
  else if (e.key === "Enter") { e.preventDefault(); if (paletteActive >= 0 && paletteResults[paletteActive]) openPaletteResult(paletteResults[paletteActive]); else runPalette(e.target.value, true); }
  else if (e.key === "Escape") { e.preventDefault(); closePalette(); }
});
function scrollPaletteActive() {
  const row = $("#palette-results").children[paletteActive];
  if (row && row.scrollIntoView) row.scrollIntoView({ block: "nearest" });
}
document.addEventListener("keydown", (e) => {
  if ((e.metaKey || e.ctrlKey) && (e.key === "k" || e.key === "K")) { e.preventDefault(); openPalette(); }
});

document.addEventListener("keydown", (e) => {
  if (e.key === "Escape") {
    if (!$("#list-sort-menu").classList.contains("hidden")) closeSortMenu();
    else if (!$("#list-filter-menu").classList.contains("hidden")) closeFilterMenu();
    else if (!$("#prefs-menu").classList.contains("hidden")) closePrefsMenu();
    else if (!$("#workspace-menu").classList.contains("hidden")) closeWorkspaceMenu();
    else if (!$("#palette").classList.contains("hidden")) closePalette();
    else if (!$("#folder-modal").classList.contains("hidden")) closeThemeModal();
    else if (!$("#settings").classList.contains("hidden")) closeSettings();
    else if (!$("#compose").classList.contains("hidden")) closeCompose();
    else if (!$("#reader").classList.contains("hidden")) deselectMessage();
    else if (selection.size > 0) clearSelection();
  }
});

// ── Boot ────────────────────────────────────────────────────────────────────
boot();
