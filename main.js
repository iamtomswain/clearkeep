const { app, BrowserWindow, ipcMain, shell, dialog } = require("electron");
const path = require("path");
const os = require("os");
const fs = require("fs");
const http = require("http");
const crypto = require("crypto");
const accounts = require("./lib/accounts");
const zoho = require("./lib/zoho");
const gmail = require("./lib/gmail");
const imap = require("./lib/imap");
const folders = require("./lib/folders");
const needs = require("./lib/needs");
const important = require("./lib/important");
const contacts = require("./lib/contacts");
const identity = require("./lib/identity");
const ai = require("./lib/ai");
const config = require("./lib/config");
const updater = require("./lib/updater");

// ── Important classifier shared helpers ───────────────────────────────────────
async function impFolderExamples(acct, backend, accountId) {
  const fe = {};
  for (const f of (folders.list(accountId) || [])) {
    try {
      const r = await backend.listPage(oauthFor(acct.provider), acct, { scope: f.name, cursor: null, limit: 8 });
      fe[f.name] = (r.messages || []).map((m) => `${m.fromName} <${m.fromEmail}>: ${m.subject}`.slice(0, 90));
    } catch {}
  }
  return fe;
}
function impStub(m) {
  return { id: m.id, account: m.account, folderId: m.folderId, messageId: m.messageId, fromName: m.fromName, fromEmail: m.fromEmail, subject: m.subject, dateMs: m.dateMs, time: m.time, unread: m.unread };
}
// Run findKeepers over messages (metadata only) → keeper rows for the store.
// Skips ids the user has dismissed. onBatch(done,total,found) for progress.
async function impClassify(accountId, folderExamples, messages, onBatch) {
  const dismissed = important.dismissedSet(accountId);
  const keepers = [];
  const BATCH = 40;
  const total = Math.ceil(messages.length / BATCH) || 1;
  for (let b = 0; b < total; b++) {
    const slice = messages.slice(b * BATCH, b * BATCH + BATCH);
    const items = slice.map((m, j) => ({ i: j, from: `${m.fromName} <${m.fromEmail}>`, subject: m.subject || "" }));
    let verdicts = [];
    try { verdicts = await ai.findKeepers(items, folderExamples); } catch {}
    const vmap = new Map(verdicts.map((v) => [v.i, v]));
    slice.forEach((m, j) => {
      const v = vmap.get(j);
      if (v && v.action === "keep" && !dismissed.has(m.messageId)) {
        keepers.push({ messageId: m.messageId, reason: v.why, folder: folderExamples[v.folder] ? v.folder : "", source: impStub(m) });
      }
    });
    if (onBatch) onBatch(b + 1, total, keepers.length);
  }
  return keepers;
}

// Small helpers for the "Needs you" scan.
function stripHtml(html) {
  return String(html || "")
    .replace(/<style[\s\S]*?<\/style>/gi, " ").replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<[^>]+>/g, " ").replace(/&nbsp;/gi, " ").replace(/&amp;/gi, "&").replace(/&#\d+;/g, " ")
    .replace(/\s+/g, " ").trim();
}
function raceTimeout(p, ms) { let t; return Promise.race([p, new Promise((_, r) => { t = setTimeout(() => r(new Error("timeout")), ms); })]).finally(() => clearTimeout(t)); }
function temporalOf(dueISO, todayISO) {
  if (!dueISO) return "none";
  const due = Date.parse(dueISO + "T00:00:00"), t0 = Date.parse(todayISO + "T00:00:00");
  if (isNaN(due) || isNaN(t0)) return "none";
  const days = Math.round((due - t0) / 86400000);
  return days < 0 ? "overdue" : days <= 7 ? "soon" : "later";
}

const BACKENDS = { zoho, gmail, yahoo: imap };
function backendFor(provider) { const b = BACKENDS[provider]; if (!b) throw new Error("Unsupported provider: " + provider); return b; }
function oauthFor(provider) { return accounts.getProviderOAuth(provider); } // null for yahoo (password-based)

// Per-account feature capabilities — derived from each backend's method surface
// plus, for Zoho, the granted OAuth scope. The renderer gates its AI/write UI on
// these instead of hardcoding `provider === "yahoo"`, so every backend lights up
// exactly the features it actually supports.
function scopeHasWrite(provider, scope) {
  if (provider === "yahoo" || provider === "gmail") return true; // native write (IMAP / Gmail API)
  if (provider === "zoho") return /ZohoMail\.(messages|folders)\.(ALL|UPDATE|CREATE)/i.test(scope || "");
  return false;
}
function capsFor(rec) {
  const b = BACKENDS[rec.provider] || {};
  const write = scopeHasWrite(rec.provider, rec.scope);
  return {
    search: !!b.searchAll,                                    // whole-mailbox search
    important: !!b.inboxForScan,                              // Find important
    needs: !!b.listPage && !!b.getContent,                    // Needs you
    ask: !!b.inboxForScan && !!b.getContent,                  // Ask / chat
    write,                                                    // file / move / trash
    send: write,                                              // compose + send
    organize: write && !!b.fileBySenders && !!b.accountSenderTally, // AI auto-organize
    cleanup: !!b.accountSenderTally && !!b.probeUnsubscribe && !!b.purgeMany, // Clean up view (bulk unsubscribe + purge)
    unsubChips: !!b.unsubScan,                               // inline per-row List-Unsubscribe chips (IMAP-only)
  };
}

let mainWindow;

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1200,
    height: 800,
    minWidth: 760,
    minHeight: 540,
    backgroundColor: "#f6f7f9",
    titleBarStyle: "hiddenInset",
    trafficLightPosition: { x: 16, y: 15 },
    icon: path.join(__dirname, "assets", "icon.png"),
    // backgroundThrottling off so the proactive poll keeps firing on schedule
    // while the window is hidden (Phase 2: stay watching with the window closed).
    // plugins: true enables Chromium's built-in PDF viewer so attachments can be
    // previewed inline (in an <iframe>) instead of being downloaded to disk first.
    webPreferences: { preload: path.join(__dirname, "preload.js"), backgroundThrottling: false, plugins: true },
  });
  mainWindow.loadFile(path.join(__dirname, "index.html"));

  // Closing the window HIDES it instead of destroying it, so the renderer (and its
  // important-mail poll + notifications) keeps running in the background. The dock
  // icon + badge remain the "still watching" presence; Cmd-Q / dock-menu Quit still
  // really quits (app.isQuitting is set in before-quit). Reopen via the dock icon.
  mainWindow.on("close", (e) => {
    if (app.isQuitting) return;
    e.preventDefault();
    mainWindow.hide();
  });

  // Links clicked inside the email-body iframe (target=_blank) open externally,
  // never in a new Electron window.
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (/^(https?:|mailto:)/i.test(url || "")) shell.openExternal(url);
    return { action: "deny" };
  });
  // Belt-and-suspenders: block any top-level navigation away from the app shell.
  mainWindow.webContents.on("will-navigate", (e, url) => {
    if (!url.startsWith("file://")) { e.preventDefault(); if (/^(https?:|mailto:)/i.test(url)) shell.openExternal(url); }
  });
}

// ── IPC: OAuth client + accounts ────────────────────────────────────────────
ipcMain.handle("oauth:get", (_e, provider) => accounts.getProviderOAuthPublic(provider));
ipcMain.handle("oauth:set", (_e, { provider, clientId, clientSecret }) => {
  try { accounts.setProviderOAuth(provider, { clientId, clientSecret }); return { ok: true }; }
  catch (err) { return { ok: false, error: err.message }; }
});

ipcMain.handle("accounts:list", () => accounts.list().map((a) => ({ ...a, caps: capsFor(a) })));
ipcMain.handle("accounts:remove", (_e, id) => {
  const a = accounts.list().find((x) => x.id === id);
  accounts.remove(id);
  try { if (a && BACKENDS[a.provider] && BACKENDS[a.provider].clearAccountCache) BACKENDS[a.provider].clearAccountCache(id); } catch {}
  return { ok: true };
});

// Connect a Zoho account via a self-client grant code.
ipcMain.handle("accounts:connect", async (_e, { grantCode }) => {
  try {
    const oauth = accounts.getProviderOAuth("zoho");
    if (!oauth) return { ok: false, error: "Set your Zoho Client ID & Secret first." };
    const { refreshToken, scope } = await zoho.exchangeGrant(oauth, grantCode.trim());
    const info = await zoho.discoverAccount(oauth, { id: "probe", refreshToken });
    if (!info.address) return { ok: false, error: "Connected, but could not read the account address." };
    const rec = accounts.addAccount({ provider: "zoho", address: info.address, zohoAccountId: info.zohoAccountId, refreshToken, scope: scope || "" });
    zoho.clearAccountCache(rec.id);
    zoho.clearAccountCache("probe");
    return { ok: true, account: rec, scope: scope || "" };
  } catch (err) { return { ok: false, error: err.message }; }
});

// Connect Gmail via "Sign in with Google" (loopback OAuth in the system browser).
function googleLogin(oauth) {
  return new Promise((resolve, reject) => {
    const server = http.createServer();
    server.on("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const port = server.address().port;
      const redirectUri = `http://127.0.0.1:${port}`;
      const timer = setTimeout(() => { try { server.close(); } catch {} reject(new Error("Sign-in timed out — try again.")); }, 180000);
      server.on("request", async (req, res) => {
        try {
          const u = new URL(req.url, redirectUri);
          const code = u.searchParams.get("code");
          const err = u.searchParams.get("error");
          if (!code && !err) { res.writeHead(204); res.end(); return; } // favicon etc.
          res.writeHead(200, { "Content-Type": "text/html" });
          res.end("<html><body style='font-family:-apple-system;background:#0a0a0b;color:#e4e4e7;text-align:center;padding-top:80px'><h2>ClearKeep</h2><p>Signed in. You can close this tab and return to the app.</p></body></html>");
          clearTimeout(timer); server.close();
          if (err) return reject(new Error("Google sign-in denied: " + err));
          const tokens = await gmail.exchangeCode(oauth, code, redirectUri);
          resolve(tokens);
        } catch (e) { clearTimeout(timer); try { server.close(); } catch {} reject(e); }
      });
      shell.openExternal(gmail.buildAuthUrl(oauth, redirectUri));
    });
  });
}
ipcMain.handle("accounts:connectGoogle", async () => {
  try {
    const oauth = accounts.getProviderOAuth("gmail");
    if (!oauth) return { ok: false, error: "Add your Google OAuth Client ID & Secret first." };
    const tokens = await googleLogin(oauth);
    const info = await gmail.getProfile(oauth, { id: "probe-google", refreshToken: tokens.refreshToken });
    gmail.clearAccountCache("probe-google");
    if (!info.address) return { ok: false, error: "Signed in, but couldn't read the Gmail address." };
    const rec = accounts.addAccount({ provider: "gmail", address: info.address, refreshToken: tokens.refreshToken });
    gmail.clearAccountCache(rec.id);
    return { ok: true, account: rec };
  } catch (err) { return { ok: false, error: err.message }; }
});

// Yahoo (IMAP/SMTP, app-password). Verify the login before saving the account.
ipcMain.handle("accounts:connectYahoo", async (_e, { address, password } = {}) => {
  try {
    address = (address || "").trim();
    password = (password || "").trim();
    if (!address || !password) return { ok: false, error: "Enter your Yahoo email and app password." };
    const probe = { id: "probe-yahoo", address, password };
    try { await imap.verify(probe); }
    catch (e) { return { ok: false, error: "Couldn't sign in — check the email and app password. " + (e.message || "") }; }
    finally { imap.clearAccountCache("probe-yahoo"); }
    const rec = accounts.addAccount({ provider: "yahoo", address, password });
    imap.clearAccountCache(rec.id);
    return { ok: true, account: rec };
  } catch (err) { return { ok: false, error: err.message }; }
});

// ── IPC: mail (dispatched by each account's provider) ───────────────────────
async function gatherInbox(method, limit) {
  const list = accounts.list();
  if (!list.length) return { messages: [], errors: [] };
  const results = await Promise.allSettled(list.map(async (a) =>
    backendFor(a.provider)[method](oauthFor(a.provider), accounts.withSecret(a.id), limit)));
  const messages = [], errors = [];
  results.forEach((r, i) => {
    if (r.status === "fulfilled") messages.push(...r.value);
    else errors.push({ account: list[i].address, error: String((r.reason && r.reason.message) || r.reason) });
  });
  messages.sort((a, b) => b.dateMs - a.dateMs);
  return { messages, errors };
}
ipcMain.handle("mail:inbox", async (_e, opts = {}) => {
  try { return await gatherInbox("listInbox", opts.limit || 50); }
  catch (err) { return { messages: [], errors: [{ account: "", error: err.message }] }; }
});
ipcMain.handle("mail:scan", async (_e, opts = {}) => {
  try { return await gatherInbox("listMany", opts.limit || 400); }
  catch (err) { return { messages: [], errors: [{ account: "", error: err.message }] }; }
});
// Whole-mailbox search: every account, every folder (not just the inbox). Providers
// that implement searchAll get full coverage; others fall back to an inbox scan.
ipcMain.handle("mail:searchAll", async (_e, { accountId, query = "", cap = 500 } = {}) => {
  // Scope to the ACTIVE account ONLY — never fan out across accounts (that would
  // surface another mailbox's private mail). And NEVER fall back to an unfiltered
  // inbox dump: a search must return query matches or nothing.
  try {
    const acct = accountId ? accounts.withSecret(accountId) : null;
    if (!acct) return { messages: [], errors: [{ account: "", error: "No active account." }] };
    let b; try { b = backendFor(acct.provider); } catch { b = null; }
    if (!b || !b.searchAll) return { messages: [], errors: [{ account: acct.address, error: `Whole-mailbox search isn’t supported on ${acct.provider} yet.` }] };
    const messages = await b.searchAll(oauthFor(acct.provider), acct, { query, cap });
    messages.sort((x, y) => y.dateMs - x.dateMs);
    return { messages: messages.slice(0, cap), errors: [] };
  } catch (err) { return { messages: [], errors: [{ account: accountId || "", error: String((err && err.message) || err) }] }; }
});

ipcMain.handle("mail:body", async (_e, { accountId, folderId, messageId }) => {
  try {
    const acct = accounts.withSecret(accountId);
    if (!acct) return { ok: false, error: "Unknown account" };
    const body = await backendFor(acct.provider).getContent(oauthFor(acct.provider), acct, folderId, messageId);
    return { ok: true, body };
  } catch (err) { return { ok: false, error: err.message }; }
});

// Cursor-paginated page of a scope ("inbox" or a folder kind) for one account.
ipcMain.handle("mail:page", async (_e, { accountId, scope = "inbox", cursor = null, limit = 50 }) => {
  try {
    const acct = accounts.withSecret(accountId);
    if (!acct) return { messages: [], nextCursor: null, error: "Unknown account" };
    return await backendFor(acct.provider).listPage(oauthFor(acct.provider), acct, { scope, cursor, limit });
  } catch (err) { return { messages: [], nextCursor: null, error: err.message }; }
});

// Server-side sender tally across the whole inbox → input for the AI organizer.
// Null when the provider can't do a cheap bulk tally (renderer falls back).
ipcMain.handle("mail:senderTally", async (_e, { accountId, limit, top } = {}) => {
  try {
    const acct = accounts.withSecret(accountId);
    const backend = acct && BACKENDS[acct.provider];
    if (backend && backend.inboxSenderTally) return { senders: await backend.inboxSenderTally(oauthFor(acct.provider), acct, { limit, top }) };
  } catch (e) { return { senders: null, error: e.message }; }
  return { senders: null };
});

// Real server-side unread count for the account's inbox (not the loaded subset).
ipcMain.handle("mail:inboxUnread", async (_e, { accountId }) => {
  try {
    const acct = accounts.withSecret(accountId);
    const backend = acct && BACKENDS[acct.provider];
    if (backend && backend.inboxUnread) return { unread: await backend.inboxUnread(oauthFor(acct.provider), acct) };
  } catch {}
  return { unread: null };
});

// Lazy body previews for messages that arrived without one (IMAP). Other
// providers already include snippets, so they have no .snippets method → null.
ipcMain.handle("mail:snippets", async (_e, { accountId, messageIds = [] } = {}) => {
  try {
    const acct = accounts.withSecret(accountId);
    const backend = acct && BACKENDS[acct.provider];
    if (backend && backend.snippets && messageIds.length)
      return { snippets: await backend.snippets(oauthFor(acct.provider), acct, messageIds) };
  } catch (e) { return { snippets: null, error: e.message }; }
  return { snippets: null };
});

ipcMain.handle("mail:attachment", async (_e, { accountId, folderId, messageId, attachmentId }) => {
  try {
    const acct = accounts.withSecret(accountId);
    if (!acct) return { ok: false, error: "Unknown account" };
    const out = await backendFor(acct.provider).getAttachment(oauthFor(acct.provider), acct, { folderId, messageId, attachmentId });
    return { ok: true, base64: out.base64 };
  } catch (err) { return { ok: false, error: err.message }; }
});

ipcMain.handle("mail:move", async (_e, { accountId, messageIds, target }) => {
  try {
    const acct = accounts.withSecret(accountId);
    if (!acct) return { ok: false, error: "Unknown account" };
    await backendFor(acct.provider).move(oauthFor(acct.provider), acct, messageIds, target);
    return { ok: true };
  } catch (err) { return { ok: false, error: err.message }; }
});

// Drag-and-drop: move specific messages into a named user folder.
ipcMain.handle("mail:moveToFolder", async (_e, { accountId, messageIds, folderName } = {}) => {
  try {
    const acct = accounts.withSecret(accountId);
    const backend = acct && BACKENDS[acct.provider];
    if (!backend || !backend.moveToFolder) return { ok: false, error: "Not supported on this account." };
    await backend.moveToFolder(oauthFor(acct.provider), acct, messageIds, folderName);
    return { ok: true };
  } catch (err) { return { ok: false, error: err.message }; }
});
// Probe unsubscribe tiers for a batch of visible rows (List-Unsubscribe header).
// IMAP-only; other backends have no per-row header probe → return {} so the UI
// simply shows no chips there.
ipcMain.handle("mail:unsubScan", async (_e, { accountId, messageIds = [] } = {}) => {
  try {
    const acct = accounts.withSecret(accountId);
    const backend = acct && BACKENDS[acct.provider];
    if (!backend || !backend.unsubScan) return {};
    return await backend.unsubScan(oauthFor(acct.provider), acct, { messageIds });
  } catch { return {}; }
});
// Fire one headless unsubscribe (one-click POST or single pooled mailto).
ipcMain.handle("mail:unsubscribeOne", async (_e, { accountId, tier, postUrl, mailto, vendor } = {}) => {
  try {
    const acct = accounts.withSecret(accountId);
    const backend = acct && BACKENDS[acct.provider];
    if (!backend || !backend.unsubscribeOne) return { ok: false, error: "Not supported on this account." };
    return await backend.unsubscribeOne(oauthFor(acct.provider), acct, { tier, postUrl, mailto, vendor });
  } catch (err) { return { ok: false, error: err.message }; }
});

// ── Find important: AI keeper-finder ──────────────────────────────────────────
// Reads sender + subject of the WHOLE inbox (no bodies), uses examples of what
// she already files as routing context, and sorts each into keep/junk/uncertain.
// Step 1 is keepers-first: this NEVER trashes — it only proposes mail to FILE.
ipcMain.handle("keepers:scan", async (e, { accountId } = {}) => {
  try {
    const acct = accounts.withSecret(accountId);
    const backend = acct && BACKENDS[acct.provider];
    if (!backend || !backend.inboxForScan) return { ok: false, error: "Not supported on this account." };
    const send = (p) => { try { e.sender.send("keepers:scanProgress", p); } catch {} };

    // Examples of what she already keeps → the context that lets the AI route by topic.
    const folderList = folders.list(accountId) || [];
    const folderExamples = {};
    for (const f of folderList) {
      try {
        const r = await backend.listPage(oauthFor(acct.provider), acct, { scope: f.name, cursor: null, limit: 8 });
        folderExamples[f.name] = (r.messages || []).map((m) => `${m.fromName} <${m.fromEmail}>: ${m.subject}`.slice(0, 90));
      } catch {}
    }

    const msgs = await backend.inboxForScan(oauthFor(acct.provider), acct, { limit: config.keepers.scanLimit });
    send({ phase: "scan", count: msgs.length });

    const BATCH = config.keepers.batchSize;
    const total = Math.ceil(msgs.length / BATCH) || 1;
    const keep = [];
    const junkIds = [];   // messageIds of the confident-junk pile → the clutter-clear acts on these
    const junkSample = []; // a few examples to show her before she clears
    let junk = 0, uncertain = 0;
    for (let b = 0; b < total; b++) {
      const slice = msgs.slice(b * BATCH, b * BATCH + BATCH);
      const items = slice.map((m, j) => ({ i: j, from: `${m.fromName} <${m.fromEmail}>`, subject: m.subject || "" }));
      let verdicts = [];
      try { verdicts = await ai.findKeepers(items, folderExamples); } catch {}
      const vmap = new Map(verdicts.map((v) => [v.i, v]));
      const rows = [];
      slice.forEach((m, j) => {
        const v = vmap.get(j) || { action: "uncertain", folder: "", why: "" };
        if (v.action === "keep") {
          const folder = folderExamples[v.folder] ? v.folder : ""; // only accept a folder that actually exists
          const row = { messageId: m.messageId, fromName: m.fromName, fromEmail: m.fromEmail, subject: m.subject, folder, why: v.why };
          keep.push(row); rows.push(row);
        } else if (v.action === "junk") {
          junk++; junkIds.push(m.messageId);
          if (junkSample.length < 14) junkSample.push({ fromName: m.fromName, subject: m.subject });
        } else uncertain++; // uncertain is NEVER trashed — it stays in the inbox
      });
      send({ phase: "batch", done: b + 1, total, keep: rows, junk, uncertain });
    }
    return { ok: true, total: msgs.length, keep, junkIds, junkSample, junkCount: junk, uncertainCount: uncertain };
  } catch (err) { return { ok: false, error: err.message }; }
});

// File the confirmed keepers into their folders (exact messages, server-side).
// Keepers with folder "" stay in the inbox (deliberately kept) and aren't moved.
ipcMain.handle("keepers:file", async (_e, { accountId, items = [] } = {}) => {
  try {
    const acct = accounts.withSecret(accountId);
    const backend = acct && BACKENDS[acct.provider];
    if (!backend || !backend.moveToFolder) return { ok: false, error: "Not supported on this account." };
    const byFolder = new Map();
    for (const it of items) {
      if (!it || !it.folder || !it.messageId) continue;
      if (!byFolder.has(it.folder)) byFolder.set(it.folder, []);
      byFolder.get(it.folder).push(it.messageId);
    }
    let filed = 0;
    const failed = [];
    for (const [folder, ids] of byFolder) {
      try { await backend.moveToFolder(oauthFor(acct.provider), acct, ids, folder); filed += ids.length; }
      catch (err) { failed.push({ folder, error: err.message }); }
    }
    return { ok: true, filed, failed };
  } catch (err) { return { ok: false, error: err.message }; }
});

// Clear the clutter: move the confident-junk messages to Trash (recoverable).
// Never touches keepers or the uncertain pile. Returns undo UIDs for a precise restore.
ipcMain.handle("keepers:trash", async (_e, { accountId, messageIds = [] } = {}) => {
  try {
    const acct = accounts.withSecret(accountId);
    const backend = acct && BACKENDS[acct.provider];
    if (!backend || !backend.trashByIds) return { ok: false, error: "Not supported on this account." };
    const r = await backend.trashByIds(oauthFor(acct.provider), acct, { messageIds });
    return { ok: true, trashed: r.trashed || 0, undo: r.undo || { uids: [] } };
  } catch (err) { return { ok: false, error: err.message }; }
});
ipcMain.handle("keepers:restore", async (_e, { accountId, uids = [] } = {}) => {
  try {
    const acct = accounts.withSecret(accountId);
    const backend = acct && BACKENDS[acct.provider];
    if (!backend || !backend.restoreIds) return { ok: false, error: "Not supported." };
    const r = await backend.restoreIds(oauthFor(acct.provider), acct, { uids });
    return { ok: true, restored: r.restored || 0 };
  } catch (err) { return { ok: false, error: err.message }; }
});

// ── "Important" smart mailbox: persistent, auto-classified important mail ──────
ipcMain.handle("important:get", (_e, { accountId } = {}) => {
  try { return { ok: true, items: important.list(accountId) }; } catch (err) { return { ok: false, error: err.message, items: [] }; }
});
// Incremental: classify only NEW inbox arrivals (uid > cursor). Cheap — does no AI
// work when nothing new. On first run it seeds from the newest mail (cap 80); the
// older backlog is left for "Search inbox for more" (important:scanAll).
ipcMain.handle("important:classifyNew", async (_e, { accountId } = {}) => {
  try {
    const acct = accounts.withSecret(accountId);
    const backend = acct && BACKENDS[acct.provider];
    if (!backend || !backend.inboxForScan) return { ok: false, items: important.list(accountId), newCount: 0 };
    const cur = important.cursor(accountId);
    const all = await backend.inboxForScan(oauthFor(acct.provider), acct, { limit: config.important.pollScanLimit });
    const fresh = all.filter((m) => (m.uid || 0) > cur).sort((a, b) => (b.uid || 0) - (a.uid || 0)); // newest first
    if (!fresh.length) return { ok: true, items: important.list(accountId), newCount: 0 };
    const capped = fresh.slice(0, config.important.seedCap);
    const fe = await impFolderExamples(acct, backend, accountId);
    const keepers = await impClassify(accountId, fe, capped);
    const newCursor = Math.max(cur, ...fresh.map((m) => m.uid || 0)); // skip the backlog on future polls — scanAll covers it
    important.addImportant(accountId, keepers, newCursor);
    const items = all.length < config.important.pollScanLimit ? important.reconcile(accountId, new Set(all.map((m) => m.messageId))) : important.list(accountId);
    return { ok: true, items, newCount: keepers.length, newItems: keepers };
  } catch (err) { return { ok: false, error: err.message, items: important.list(accountId), newCount: 0 }; }
});
// "Search inbox for more": full-inbox classify → store (surface-only). With progress.
ipcMain.handle("important:scanAll", async (e, { accountId } = {}) => {
  try {
    const acct = accounts.withSecret(accountId);
    const backend = acct && BACKENDS[acct.provider];
    if (!backend || !backend.inboxForScan) return { ok: false, error: "Not supported on this account." };
    const send = (p) => { try { e.sender.send("important:scanProgress", p); } catch {} };
    const all = await backend.inboxForScan(oauthFor(acct.provider), acct, { limit: config.important.fullScanLimit });
    send({ phase: "scan", count: all.length });
    const fe = await impFolderExamples(acct, backend, accountId);
    const keepers = await impClassify(accountId, fe, all, (done, total, found) => send({ phase: "batch", done, total, found }));
    const newCursor = all.length ? Math.max(0, ...all.map((m) => m.uid || 0)) : null;
    important.addImportant(accountId, keepers, newCursor);
    const items = all.length < config.important.fullScanLimit ? important.reconcile(accountId, new Set(all.map((m) => m.messageId))) : important.list(accountId);
    return { ok: true, items, found: keepers.length, scanned: all.length };
  } catch (err) { return { ok: false, error: err.message }; }
});
ipcMain.handle("important:update", (_e, { accountId, messageId, status } = {}) => {
  try { important.setStatus(accountId, messageId, status); return { ok: true, items: important.list(accountId) }; }
  catch (err) { return { ok: false, error: err.message }; }
});

// ── "Needs you": extract a to-do list from important mail ─────────────────────
// Scans recent mail in the user's folders (where the important stuff lives after
// filing), reads bodies, and extracts actions + deadlines. Reads BODIES — bounded
// to foldered (already-curated-important) + recent + capped. Never moves mail.
ipcMain.handle("needs:scan", async (e, { accountId } = {}) => {
  try {
    const acct = accounts.withSecret(accountId);
    const backend = acct && BACKENDS[acct.provider];
    if (!backend || !backend.listPage || !backend.getContent) return { ok: false, error: "Not supported on this account." };
    const send = (p) => { try { e.sender.send("needs:scanProgress", p); } catch {} };

    const PER_FOLDER = config.needs.perFolder, CAND_CAP = config.needs.candidateCap, RECENT_DAYS = config.needs.recentDays, BATCH = config.needs.batchSize;
    const todayISO = new Date().toISOString().slice(0, 10);
    const cutoff = Date.now() - RECENT_DAYS * 86400000;

    // Gather candidates: recent mail from each of the user's folders.
    const folderList = folders.list(accountId) || [];
    let cands = [];
    for (const f of folderList) {
      try {
        const r = await backend.listPage(oauthFor(acct.provider), acct, { scope: f.name, cursor: null, limit: PER_FOLDER });
        (r.messages || []).forEach((m) => cands.push({ ...m, folder: f.name }));
      } catch {}
    }
    // Recent first, dedupe by messageId, cap.
    const seen = new Set();
    cands = cands
      .filter((m) => m.dateMs >= cutoff)
      .sort((a, b) => b.dateMs - a.dateMs)
      .filter((m) => (seen.has(m.messageId) ? false : (seen.add(m.messageId), true)))
      .slice(0, CAND_CAP);
    send({ phase: "scan", count: cands.length });

    const total = Math.ceil(cands.length / BATCH) || 1;
    const todos = [];
    for (let b = 0; b < total; b++) {
      const slice = cands.slice(b * BATCH, b * BATCH + BATCH);
      const items = [];
      for (let j = 0; j < slice.length; j++) {
        const m = slice[j];
        let body = "";
        try { const c = await raceTimeout(backend.getContent(oauthFor(acct.provider), acct, m.folderId, m.messageId), config.needs.bodyTimeoutMs); body = stripHtml(c.html).slice(0, config.needs.bodyChars); } catch {}
        items.push({ i: j, from: `${m.fromName} <${m.fromEmail}>`, subject: m.subject || "", body });
      }
      let verdicts = [];
      try { verdicts = await ai.extractActions(items, todayISO); } catch {}
      const vmap = new Map(verdicts.map((v) => [v.i, v]));
      slice.forEach((m, j) => {
        const v = vmap.get(j);
        if (!v || !v.hasAction) return;
        todos.push({
          sourceMessageId: m.messageId, folder: m.folder,
          summary: v.summary, action: v.action, deadline: v.deadline, dueISO: v.dueISO,
          priority: v.priority, temporalStatus: temporalOf(v.dueISO, todayISO),
          source: { id: m.id, account: m.account, folderId: m.folderId, messageId: m.messageId, fromName: m.fromName, fromEmail: m.fromEmail, subject: m.subject, dateMs: m.dateMs, time: m.time, unread: m.unread, to: m.to || "", cc: m.cc || "", snippet: "" },
        });
      });
      send({ phase: "batch", done: b + 1, total, found: todos.length });
    }
    const all = needs.merge(accountId, todos);
    return { ok: true, items: all, scanned: cands.length };
  } catch (err) { return { ok: false, error: err.message }; }
});
ipcMain.handle("needs:get", (_e, { accountId } = {}) => {
  try { return { ok: true, items: needs.list(accountId) }; } catch (err) { return { ok: false, error: err.message, items: [] }; }
});
ipcMain.handle("needs:update", (_e, { accountId, sourceMessageId, status, snoozeUntil } = {}) => {
  try { const it = needs.setStatus(accountId, sourceMessageId, status, snoozeUntil); return { ok: !!it, item: it }; }
  catch (err) { return { ok: false, error: err.message }; }
});
ipcMain.handle("needs:remind", (_e, { accountId, sourceMessageId, remindStage } = {}) => {
  try { const it = needs.markReminded(accountId, sourceMessageId, remindStage); return { ok: !!it, item: it }; }
  catch (err) { return { ok: false, error: err.message }; }
});

// ── "Ask your mailbox": read-side RAG ─────────────────────────────────────────
// retrieve (metadata) → read a small set of bodies → answer with citations. Never
// dumps the whole mailbox into the model. Reads BODIES only for the retrieved
// handful (the privacy escalation point, tightly bounded). Yahoo/IMAP only.
ipcMain.handle("ask:answer", async (e, { accountId, question, history = [], priorRefs = [] } = {}) => {
  try {
    const acct = accounts.withSecret(accountId);
    const backend = acct && BACKENDS[acct.provider];
    if (!backend || !backend.inboxForScan || !backend.getContent) return { ok: false, error: "Not supported on this account." };
    if (!String(question || "").trim()) return { ok: false, error: "Empty question." };
    const send = (p) => { try { e.sender.send("ask:progress", p); } catch {} };
    const todayISO = new Date().toISOString().slice(0, 10);

    // 1. Gather candidates: recent inbox + foldered mail (metadata only).
    send({ phase: "gather" });
    let cands = [];
    try { (await backend.inboxForScan(oauthFor(acct.provider), acct, { limit: config.ask.gatherInbox })).forEach((m) => cands.push({ ...m, folder: m.folder || "Inbox" })); } catch {}
    for (const f of (folders.list(accountId) || [])) {
      try {
        const r = await backend.listPage(oauthFor(acct.provider), acct, { scope: f.name, cursor: null, limit: config.ask.gatherPerFolder });
        (r.messages || []).forEach((m) => cands.push({ ...m, folder: f.name }));
      } catch {}
    }
    const seen = new Set();
    cands = cands
      .filter((m) => m.messageId && !seen.has(m.messageId) && (seen.add(m.messageId), true))
      .sort((a, b) => (b.dateMs || 0) - (a.dateMs || 0))
      .slice(0, config.ask.candidateCap);

    // 2. Retrieve: rewrite the follow-up into a standalone query (conversation-aware),
    //    then semantic-search the metadata. Carry forward the emails cited earlier in
    //    this conversation so a follow-up can reference them even if search misses them.
    send({ phase: "search", count: cands.length });
    const standalone = await ai.rewriteQuery(history, question);
    const items = cands.map((m, i) => ({ i, from: `${m.fromName || ""} <${m.fromEmail || ""}>`, subject: m.subject || "", snippet: String(m.snippet || "").slice(0, 160), date: m.time || "" }));
    let idx = [];
    try { idx = await ai.searchEmails(standalone, items); } catch {}
    const retrieved = idx.filter((n) => n >= 0 && n < cands.length).slice(0, config.ask.retrieveTop).map((n) => cands[n]);
    const carried = (priorRefs || []).filter((r) => r && r.messageId && r.folderId);
    const byId = new Map();
    [...retrieved, ...carried].forEach((m) => { if (m.messageId && !byId.has(m.messageId)) byId.set(m.messageId, m); });
    const chosenAll = Array.from(byId.values()).slice(0, config.ask.readCap);
    if (!chosenAll.length) { send({ phase: "done" }); return { ok: true, found: false, answer: "", cites: [] }; }

    // 3. Read bodies of the chosen set.
    send({ phase: "read", done: 0, total: chosenAll.length });
    const withBody = [];
    for (let j = 0; j < chosenAll.length; j++) {
      const m = chosenAll[j];
      let body = "";
      try { const c = await raceTimeout(backend.getContent(oauthFor(acct.provider), acct, m.folderId, m.messageId), config.ask.bodyTimeoutMs); body = stripHtml(c.html).slice(0, config.ask.bodyChars); } catch {}
      withBody.push({ i: j, from: `${m.fromName || ""} <${m.fromEmail || ""}>`, subject: m.subject || "", date: m.time || "", body });
      send({ phase: "read", done: j + 1, total: chosenAll.length });
    }

    // 4. Synthesize the cited answer, in the context of the conversation.
    send({ phase: "answer" });
    const res = await ai.answerQuestion(question, withBody, todayISO, history);
    const cites = (res.cites || []).map((j) => chosenAll[j]).filter(Boolean).map((m) => ({
      id: m.id, account: m.account, folderId: m.folderId, messageId: m.messageId,
      fromName: m.fromName, fromEmail: m.fromEmail, subject: m.subject, time: m.time, dateMs: m.dateMs, folder: m.folder, unread: m.unread,
    }));
    send({ phase: "done" });
    return { ok: true, found: res.found, answer: res.answer, cites };
  } catch (err) { return { ok: false, error: err.message }; }
});

// Re-file: re-apply a folder's saved rules to sweep new matching inbox mail in.
ipcMain.handle("folders:refile", async (_e, { accountId, id, name } = {}) => {
  try {
    const acct = accounts.withSecret(accountId);
    const backend = acct && BACKENDS[acct.provider];
    if (!backend || !backend.fileBySenders) return { ok: false, error: "Not supported on this account." };
    const f = folders.list(accountId).find((x) => x.id === id || x.name === name);
    if (!f) return { ok: false, error: "No saved rules for this folder." };
    const filed = (await backend.fileBySenders(oauthFor(acct.provider), acct, { name: f.name, addresses: f.addresses || [], domains: f.domains || [] })).filed || 0;
    return { ok: true, filed };
  } catch (err) { return { ok: false, error: err.message }; }
});

ipcMain.handle("mail:read", async (_e, { accountId, messageIds, read }) => {
  try {
    const acct = accounts.withSecret(accountId);
    if (!acct) return { ok: false, error: "Unknown account" };
    await backendFor(acct.provider).markRead(oauthFor(acct.provider), acct, messageIds, read);
    return { ok: true };
  } catch (err) { return { ok: false, error: err.message }; }
});

ipcMain.handle("mail:folder", async (_e, { accountId, kind, limit = 100 }) => {
  try {
    const acct = accounts.withSecret(accountId);
    if (!acct) return { messages: [] };
    return await backendFor(acct.provider).listFolderByKind(oauthFor(acct.provider), acct, kind, limit);
  } catch (err) { return { messages: [], error: err.message }; }
});

// Address book: cached auto-harvested contacts (refresh if stale > 6h or forced).
ipcMain.handle("contacts:list", async (_e, { accountId, force } = {}) => {
  try {
    const acct = accounts.withSecret(accountId);
    const backend = acct && BACKENDS[acct.provider];
    const cached = contacts.get(accountId);
    const fresh = cached && Date.now() - (cached.updatedAt || 0) < 6 * 3600 * 1000;
    if (cached && fresh && !force) return { ok: true, items: cached.items || [] };
    if (!backend || !backend.harvestContacts) return { ok: true, items: (cached && cached.items) || [] };
    const items = await backend.harvestContacts(oauthFor(acct.provider), acct, { limit: 1500 });
    contacts.save(accountId, items);
    return { ok: true, items };
  } catch (err) { const c = contacts.get(accountId); return { ok: false, error: err.message, items: (c && c.items) || [] }; }
});
ipcMain.handle("contacts:add", (_e, { accountId, recipients = [] } = {}) => {
  try { return { ok: true, items: contacts.addRecipients(accountId, recipients) }; }
  catch (err) { return { ok: false, error: err.message }; }
});

ipcMain.handle("identity:all", () => { try { return { ok: true, identities: identity.all() }; } catch (err) { return { ok: false, identities: {} }; } });
ipcMain.handle("identity:set", (_e, { accountId, displayName, signature } = {}) => {
  try { return { ok: true, identity: identity.set(accountId, { displayName, signature }) }; }
  catch (err) { return { ok: false, error: err.message }; }
});

ipcMain.handle("mail:send", async (_e, { accountId, ...msg }) => {
  try {
    const acct = accounts.withSecret(accountId);
    if (!acct) return { ok: false, error: "Unknown account" };
    const id = identity.get(accountId); // attach the display name for the From header
    if (id && id.displayName) acct.displayName = id.displayName;
    await backendFor(acct.provider).send(oauthFor(acct.provider), acct, msg);
    return { ok: true };
  } catch (err) { return { ok: false, error: err.message }; }
});

// The account owner's own profile photo (provider-specific: Zoho serves it,
// Gmail can't with the current scope). Falls through to the generic avatar.
ipcMain.handle("account:avatar", async (_e, accountId) => {
  try {
    const acct = accounts.withSecret(accountId);
    if (!acct) return { dataUrl: null };
    const dataUrl = await backendFor(acct.provider).getAvatar(oauthFor(acct.provider), acct);
    return { dataUrl: dataUrl || null };
  } catch { return { dataUrl: null }; }
});

// Save an attachment (base64) to a user-chosen location.
ipcMain.handle("file:save", async (_e, { name, base64 }) => {
  try {
    const res = await dialog.showSaveDialog(mainWindow, { defaultPath: name || "attachment" });
    if (res.canceled || !res.filePath) return { ok: false, canceled: true };
    fs.writeFileSync(res.filePath, Buffer.from(base64 || "", "base64"));
    return { ok: true, path: res.filePath };
  } catch (err) { return { ok: false, error: err.message }; }
});

// Write an attachment to a temp file and open it with the OS default app.
ipcMain.handle("file:open", async (_e, { name, base64 }) => {
  try {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "clearkeep-"));
    const safe = (name || "attachment").replace(/[/\\]/g, "_");
    const fp = path.join(dir, safe);
    fs.writeFileSync(fp, Buffer.from(base64 || "", "base64"));
    const err = await shell.openPath(fp);
    return err ? { ok: false, error: err } : { ok: true, path: fp };
  } catch (err) { return { ok: false, error: err.message }; }
});

// Open a link in the system browser (only http/https/mailto).
ipcMain.handle("shell:open", (_e, url) => {
  if (typeof url === "string" && /^(https?:|mailto:)/i.test(url.trim())) shell.openExternal(url.trim());
  return { ok: true };
});

// ── IPC: dock badge + window focus (proactive "needs you" surfacing) ─────────
// The renderer keeps a running "attention" count (unread important + active
// to-dos) on the dock icon so Amanda sees what's waiting without opening the app.
ipcMain.handle("app:setBadge", (_e, count) => {
  try {
    const n = Math.max(0, parseInt(count, 10) || 0);
    if (process.platform === "darwin" && app.dock) app.dock.setBadge(n ? String(n) : "");
    else if (typeof app.setBadgeCount === "function") app.setBadgeCount(n); // win/linux
  } catch {}
  return { ok: true };
});
// Bring the app forward when the user clicks a native notification.
ipcMain.handle("app:focus", () => {
  try {
    if (process.platform === "darwin" && app.dock) app.dock.show();
    if (mainWindow) {
      if (mainWindow.isMinimized()) mainWindow.restore();
      mainWindow.show();
      mainWindow.focus();
    }
  } catch {}
  return { ok: true };
});

// ── IPC: self-update (custom updater for the unsigned build) ────────────────
ipcMain.handle("app:version", () => app.getVersion());
ipcMain.handle("update:check", async () => {
  try { return { ok: true, ...(await updater.check()) }; }
  catch (e) { return { ok: false, error: e && e.message ? e.message : String(e) }; }
});
ipcMain.handle("update:apply", async (e, info) => {
  try {
    await updater.apply(info, (p) => { try { e.sender.send("update:progress", p); } catch {} });
    return { ok: true }; // usually unreached — apply() relaunches + exits on success
  } catch (err) { return { ok: false, error: err && err.message ? err.message : String(err) }; }
});

// ── IPC: sender/account avatars ─────────────────────────────────────────────
// Resolve an avatar server-side (no CORS), validate it's a real image, and
// return a data URL — or null so the UI shows clean initials. Order:
//   1. Gravatar by email (the person's own photo, if they set one)
//   2. domain favicon (brand/vendor logo)
// Per-run caches: by identity key, and a shared per-domain cache so multiple
// senders on the same domain only hit the favicon service once.
const avatarCache = new Map();   // key (email|domain) -> dataUrl|null
const domainIconCache = new Map(); // domain -> dataUrl|null

// Fetch a URL and return a validated image data URL, or null.
async function fetchImageDataUrl(url) {
  const r = await fetch(url);
  if (!r.ok) return null; // Gravatar d=404 / DDG miss both 404 here
  const type = r.headers.get("content-type") || "";
  if (!/^image\//i.test(type)) return null;
  const buf = Buffer.from(await r.arrayBuffer());
  if (buf.length < 100) return null;
  return `data:${type};base64,${buf.toString("base64")}`;
}

ipcMain.handle("avatar:fetch", async (_e, payload) => {
  // Back-compat: payload may be a bare domain string or { email, domain }.
  const email = (typeof payload === "object" && payload ? payload.email : "").toLowerCase().trim();
  const domain = (typeof payload === "object" && payload ? payload.domain : payload) || "";
  const key = email || domain;
  if (!key) return { dataUrl: null };
  if (avatarCache.has(key)) return { dataUrl: avatarCache.get(key) };
  let dataUrl = null;
  try {
    if (email) {
      const hash = crypto.createHash("md5").update(email).digest("hex");
      dataUrl = await fetchImageDataUrl(`https://www.gravatar.com/avatar/${hash}?d=404&s=80`);
    }
    if (!dataUrl && domain) {
      if (domainIconCache.has(domain)) dataUrl = domainIconCache.get(domain);
      else { dataUrl = await fetchImageDataUrl(`https://icons.duckduckgo.com/ip3/${domain}.ico`); domainIconCache.set(domain, dataUrl); }
    }
    avatarCache.set(key, dataUrl);
    return { dataUrl };
  } catch {
    avatarCache.set(key, null);
    return { dataUrl: null };
  }
});

// ── IPC: folders (AI-assisted) ──────────────────────────────────────────────
// Folders come from the SERVER (real labels/IMAP folders), not the local file,
// so the sidebar always reflects reality. Providers that can't list folders
// (e.g. read-only Zoho) fall back to the local rule list.
ipcMain.handle("folders:list", async (_e, accountId) => {
  try {
    const acct = accounts.withSecret(accountId);
    const backend = acct && BACKENDS[acct.provider];
    if (backend && backend.listUserFolders) {
      const sf = await backend.listUserFolders(oauthFor(acct.provider), acct);
      const order = folders.getOrder(accountId);
      const idx = new Map(order.map((id, i) => [id, i]));
      return sf.map((f) => { const id = `${accountId}::${f.name}`; return { id, name: f.name, account: accountId, unread: f.unread || 0, pos: idx.has(id) ? idx.get(id) : null }; });
    }
  } catch { /* fall through to local */ }
  return folders.list(accountId);
});
// Save the user's manual folder order (drag-to-reorder in the rail).
ipcMain.handle("folders:setOrder", (_e, { accountId, order = [] } = {}) => {
  try { folders.setOrder(accountId, order); return { ok: true }; } catch (err) { return { ok: false, error: err.message }; }
});
ipcMain.handle("folders:remove", (_e, id) => { folders.remove(id); return { ok: true }; });

// Collapse ALL user folders back into the inbox and delete them (reverses
// auto-organize). Lossless: mail returns to INBOX, nothing is trashed.
ipcMain.handle("folders:collapseAll", async (e, { accountId } = {}) => {
  try {
    const acct = accounts.withSecret(accountId);
    const backend = acct && BACKENDS[acct.provider];
    if (!backend || !backend.collapseAllFolders) return { ok: false, error: "Not supported on this account." };
    const onProgress = (p) => { try { e.sender.send("folders:collapseProgress", p); } catch {} };
    const r = await backend.collapseAllFolders(oauthFor(acct.provider), acct, { onProgress });
    folders.list(accountId).forEach((f) => folders.remove(f.id)); // drop stale local rule entries too
    return { ok: true, ...r };
  } catch (err) { return { ok: false, error: err.message }; }
});

// Create a folder, then use Haiku to find every sender for that vendor and
// turn the matches into routing rules. `senders` = "addr (Display)" strings.
ipcMain.handle("folders:createAndFill", async (_e, { name, senders = [], accountId }) => {
  try {
    const acct = accounts.withSecret(accountId);
    const backend = acct && BACKENDS[acct.provider];
    const folder = folders.create(name, accountId);
    let matched = [];
    try { matched = await ai.matchVendor(folder.vendor || name, senders); } catch (e) { matched = []; }
    const rules = folders.deriveRules(matched);
    folders.setRules(folder.id, rules);
    let filed = 0;
    if (backend && backend.fileBySenders) {
      try { filed = (await backend.fileBySenders(oauthFor(acct.provider), acct, { name: folder.name, addresses: rules.addresses, domains: rules.domains })).filed || 0; }
      catch (e) { return { ok: false, error: "Folder created, but filing failed: " + e.message }; }
    }
    return { ok: true, folder: folders.list().find((f) => f.id === folder.id), matchedCount: matched.length, filed, serverFiling: !!(backend && backend.fileBySenders) };
  } catch (err) {
    return { ok: false, error: err.message };
  }
});

// ── Theme folders: name-first, thematic match, review-then-file ──────────────
// Step 1: match. Tally inbox senders (≥2, with subjects), ask the AI which fit the
// theme name, return them as reviewable rows. No folder created, no mail moved yet.
ipcMain.handle("folders:matchTheme", async (e, { accountId, name } = {}) => {
  try {
    const acct = accounts.withSecret(accountId);
    const backend = acct && BACKENDS[acct.provider];
    if (!backend || !backend.accountSenderTally) return { ok: false, error: "Not supported on this account." };
    const send = (p) => { try { e.sender.send("theme:progress", p); } catch {} };
    send({ phase: "scan", done: 0 });
    // minCount:1 — a theme is about TOPIC, not volume. A single email (e.g. an EBT
    // deposit, a one-time legal notice) must be eligible, so consider every sender.
    const { senders } = await backend.accountSenderTally(oauthFor(acct.provider), acct,
      { minCount: 1, top: Infinity, onProgress: (n) => send({ phase: "scan", done: n }) });
    const meta = senders.map((s) => `${s.email} (${s.name}) :: ${(s.subjects || []).slice(-3).join(" | ").replace(/\s+/g, " ").slice(0, 120)}`);
    const matched = new Map(); // email -> promo
    const total = Math.max(1, Math.ceil(meta.length / 60));
    for (let i = 0, b = 0; i < meta.length; i += 60, b++) {
      let part = [];
      try { part = await ai.matchTheme(name, meta.slice(i, i + 60)); } catch {}
      for (const o of part) { const m = String(o.sender).match(/([^\s<(]+@[^\s>)\]]+)/); if (m) matched.set(m[1].toLowerCase(), !!o.promo); }
      send({ phase: "match", done: b + 1, total });
    }
    const byEmail = new Map(senders.map((s) => [s.email, s]));
    const rows = [...matched.keys()].filter((em) => byEmail.has(em)).map((em, i) => {
      const s = byEmail.get(em);
      return { id: "t" + i, email: s.email, name: s.name, count: s.count, sample: s.sampleSubject || "", subjects: s.subjects || [], promo: matched.get(em) };
    }).sort((a, b) => (Number(a.promo) - Number(b.promo)) || (b.count - a.count)); // providers first, then by volume
    return { ok: true, rows };
  } catch (err) { return { ok: false, error: err.message }; }
});
// Step 2: file. Create the folder and move the (reviewer-approved) senders' inbox
// mail into it — by EXACT address only (no domain over-reach). Reversible via unfile.
ipcMain.handle("folders:fileTheme", async (_e, { accountId, name, addresses = [] } = {}) => {
  try {
    const acct = accounts.withSecret(accountId);
    const backend = acct && BACKENDS[acct.provider];
    if (!backend || !backend.fileBySenders) return { ok: false, error: "Not supported on this account." };
    const folder = folders.create(name, accountId);
    folders.setRules(folder.id, { addresses, domains: [] });
    const filed = (await backend.fileBySenders(oauthFor(acct.provider), acct, { name, addresses, domains: [] })).filed || 0;
    return { ok: true, folder, filed };
  } catch (err) { return { ok: false, error: err.message }; }
});
// Create an EMPTY folder — no theme match, no rules, no filing. For a manual
// "file it myself later" folder (e.g. archiving past-life docs). Creates the local
// record AND the real server mailbox/label so it's a drop target right away. With no
// rules, auto-classification never routes mail into it — it stays exactly as filed.
ipcMain.handle("folders:createEmpty", async (_e, { accountId, name } = {}) => {
  try {
    const nm = String(name || "").trim();
    if (!nm) return { ok: false, error: "Folder needs a name." };
    const acct = accounts.withSecret(accountId);
    if (!acct) return { ok: false, error: "Unknown account." };
    const backend = BACKENDS[acct.provider];
    const folder = folders.create(nm, accountId);
    try {
      if (backend && backend.ensureMailbox) await backend.ensureMailbox(acct, folder.name);
      else if (backend && backend.ensureLabel) await backend.ensureLabel(oauthFor(acct.provider), acct, folder.name);
      else if (backend && backend.ensureFolder) await backend.ensureFolder(oauthFor(acct.provider), acct, folder.name);
    } catch (e) { return { ok: false, error: "Couldn’t create the server folder: " + e.message }; }
    return { ok: true, folder: folders.list().find((f) => f.id === folder.id) || folder };
  } catch (err) { return { ok: false, error: err.message }; }
});

// AI organize sweep: cluster the mailbox's senders into vendors and auto-build
// a folder per vendor. Only NEW folders are reported (so Undo won't touch
// pre-existing ones); existing folders just get their rules augmented.
ipcMain.handle("folders:autoOrganize", async (_e, { senders = [], accountId }) => {
  try {
    const acct = accounts.withSecret(accountId);
    const backend = acct && BACKENDS[acct.provider];
    const canFile = !!(backend && backend.fileBySenders);
    const clusters = await ai.clusterVendors(senders);
    const before = new Set(folders.list(accountId).map((f) => f.id));
    const created = [];
    let filed = 0;
    for (const c of clusters) {
      if (!c.vendor || !Array.isArray(c.senders) || !c.senders.length) continue;
      const folder = folders.create(c.vendor, accountId);
      const rules = folders.deriveRules(c.senders);
      folders.setRules(folder.id, rules);
      const isNew = !before.has(folder.id);
      let n = 0;
      if (canFile) {
        try { n = (await backend.fileBySenders(oauthFor(acct.provider), acct, { name: folder.name, addresses: rules.addresses, domains: rules.domains })).filed || 0; filed += n; }
        catch (e) { /* keep going; report per-folder */ }
      }
      if (isNew) created.push({ id: folder.id, name: folder.name, filed: n });
    }
    return { ok: true, created, filed, serverFiling: canFile };
  } catch (err) {
    return { ok: false, error: err.message, created: [] };
  }
});

// Undo server filing: pull a folder's mail back to the inbox (and forget the rule).
ipcMain.handle("folders:unfile", async (_e, { accountId, name, id }) => {
  try {
    const acct = accounts.withSecret(accountId);
    const backend = acct && BACKENDS[acct.provider];
    let moved = 0;
    if (backend && backend.unfileToInbox) moved = (await backend.unfileToInbox(oauthFor(acct.provider), acct, { name })).moved || 0;
    if (id) folders.remove(id);
    return { ok: true, moved };
  } catch (err) { return { ok: false, error: err.message }; }
});

// ── Clean up: index → review → bulk unsubscribe + purge to Trash ─────────────
// Turn the tallied senders + AI clusters into review rows. Best (safest) unsub
// tier wins per cluster; suggested toggles follow the rules (legit+safe → unsub;
// everything → trash). Unclustered senders become their own rows (nothing dropped).
const TIER_RANK = { "one-click": 3, mailto: 2, link: 1, none: 0 };
// Role/bulk address patterns — anything matching is automated, NOT an individual.
const ROLE_RE = /(^|[._-])(no-?reply|do-?not-?reply|noreply|donotreply|notif|notify|mailer|bounce|market|news|info|hello|support|update|alert|team|sales|contact|automat|system|postmaster|admin|service|member|account|billing|help|order|store|shop|deal|offer|email|reply|inbox|hi|care)/i;
function looksRole(email) {
  const local = String(email || "").split("@")[0] || "";
  return ROLE_RE.test(local) || local.includes("+") || /\d{4,}/.test(local); // role word, plus-addressing, or long digit runs
}
// Heuristic backstop for the AI's `personal` flag: a non-role address writing a
// reply/forward is person-to-person correspondence → protect it.
function heuristicPersonal(members) {
  return members.some((m) => !looksRole(m.email) && /^\s*(re|fwd?)\s*:/i.test(m.sampleSubject || ""));
}
function buildCleanupRows(senders, clusters, idBase = "c") {
  const byEmail = new Map(senders.map((s) => [s.email, s]));
  const used = new Set();
  const rows = [];
  let seq = 0;
  const makeRow = (vendor, members, category, spam, personalFlag) => {
    const rules = folders.deriveRules(members.map((m) => m.email));
    if (!rules.addresses.length && !rules.domains.length) return null;
    const count = members.reduce((n, m) => n + m.count, 0);
    let best = members[0];
    for (const m of members) if ((TIER_RANK[m.tier] || 0) > (TIER_RANK[best.tier] || 0)) best = m;
    const tier = best.tier || "none";
    const safe = tier === "one-click" || tier === "mailto";
    const personal = !!personalFlag || heuristicPersonal(members); // AI flag OR heuristic
    return {
      id: idBase + (seq++),
      vendor: vendor || members[0].name || members[0].email,
      addresses: rules.addresses, domains: rules.domains,
      count, sample: members[0].sampleSubject || "",
      subjects: members.flatMap((m) => m.subjects || []).slice(-12), // recent subjects for the preview popover
      category: category || "other", spam: !!spam, personal,
      tier, postUrl: best.postUrl || null, mailto: best.mailto || null,
      // Personal correspondence is protected: never pre-checked, never unsubbed.
      suggestUnsub: !spam && !personal && safe,
      suggestTrash: !personal,
    };
  };
  for (const c of clusters) {
    const members = [];
    for (const str of (c.senders || [])) {
      const m = String(str).match(/([^\s<(]+@[^\s>)\]]+)/);
      const email = m ? m[1].toLowerCase() : String(str).toLowerCase();
      if (byEmail.has(email) && !used.has(email)) { members.push(byEmail.get(email)); used.add(email); }
    }
    if (members.length) { const r = makeRow(c.vendor, members, c.category, c.spam, c.personal); if (r) rows.push(r); }
  }
  for (const s of senders) {
    if (used.has(s.email)) continue;
    const r = makeRow(s.name || s.email, [s], "other", false, false);
    if (r) rows.push(r);
  }
  return rows.sort((a, b) => b.count - a.count);
}

// Cluster senders in chunks (a single 400-sender Claude call times out / overruns
// and returns nothing). Merge clusters across chunks by vendor name so a vendor
// split across two chunks still ends up as one row.
async function clusterInChunks(meta, size = 60, onProgress) {
  const byVendor = new Map();
  const total = Math.max(1, Math.ceil(meta.length / size));
  let idx = 0;
  for (let i = 0; i < meta.length; i += size) {
    let part = [];
    try { part = await ai.clusterForUnsub(meta.slice(i, i + size)); } catch { /* skip this chunk; senders fall back to per-sender rows */ }
    for (const c of part) {
      const key = String(c.vendor || "").trim().toLowerCase();
      if (!key || !Array.isArray(c.senders)) continue;
      const ex = byVendor.get(key);
      if (ex) { ex.senders = [...new Set([...ex.senders, ...c.senders])]; ex.spam = ex.spam || !!c.spam; ex.personal = ex.personal || !!c.personal; }
      else byVendor.set(key, { vendor: c.vendor, senders: [...c.senders], category: c.category || "other", spam: !!c.spam, personal: !!c.personal });
    }
    if (onProgress) onProgress(++idx, total);
  }
  return [...byVendor.values()];
}

// Full-coverage scan: tally EVERY repeat sender, then process them in batches of
// 100 (probe + cluster each batch) so rows stream into the UI as each batch lands
// and the progress is a real segmented bar. No top-N cap.
const CLEANUP_BATCH = 100;
ipcMain.handle("cleanup:index", async (e, { accountId } = {}) => {
  try {
    const acct = accounts.withSecret(accountId);
    const backend = acct && BACKENDS[acct.provider];
    // Needs BOTH the tally AND the per-sender List-Unsubscribe probe. Zoho has the
    // tally but no header probe, so guarding on accountSenderTally alone would let
    // it through and then crash on backend.probeUnsubscribe.
    if (!backend || !backend.accountSenderTally || !backend.probeUnsubscribe) return { ok: false, error: "Clean up isn't supported on this account." };
    const send = (p) => { try { e.sender.send("cleanup:indexProgress", p); } catch {} };
    send({ phase: "scan", done: 0 });
    const { senders } = await backend.accountSenderTally(oauthFor(acct.provider), acct,
      { minCount: 3, top: Infinity, onProgress: (n) => send({ phase: "scan", done: n }) });
    if (!senders.length) return { ok: true, rows: [], senderCount: 0, excluded: 0 };

    const total = Math.ceil(senders.length / CLEANUP_BATCH);
    const allRows = [];
    for (let b = 0; b < total; b++) {
      const batch = senders.slice(b * CLEANUP_BATCH, (b + 1) * CLEANUP_BATCH);
      // probe each sender in the batch (8s ceiling each, inside probeUnsubscribe)
      for (let i = 0; i < batch.length; i++) {
        // The tally already classified senders carrying a List-Unsubscribe header;
        // only probe the rest (repeat senders with no header) — avoids a slow re-fetch.
        if (!batch[i].tier) Object.assign(batch[i], await backend.probeUnsubscribe(oauthFor(acct.provider), acct, { mailbox: batch[i].sampleMailbox, uid: batch[i].sampleUid }));
        if (i % 10 === 0) send({ phase: "batch", done: b, total, sub: i + 1, subTotal: batch.length });
      }
      const meta = batch.map((s) => `${s.email} (${s.name}) ×${s.count} :: ${String(s.sampleSubject || "").replace(/\s+/g, " ").slice(0, 80)}`);
      const clusters = await clusterInChunks(meta, 60);
      const rows = buildCleanupRows(batch, clusters, `b${b}_`);
      allRows.push(...rows);
      send({ phase: "batch", done: b + 1, total, rows }); // rows stream into the review table
    }
    return { ok: true, rows: allRows, senderCount: senders.length, excluded: 0 };
  } catch (err) { return { ok: false, error: err.message }; }
});

ipcMain.handle("cleanup:execute", async (_e, { accountId, actions = [] } = {}) => {
  try {
    const acct = accounts.withSecret(accountId);
    const backend = acct && BACKENDS[acct.provider];
    if (!backend || !backend.purgeMany) return { ok: false, error: "Not supported on this account." };
    let unsubscribed = 0;
    const failed = [];
    // 1a) One-click unsubscribes — HTTP POST, no SMTP throttle, fine per-vendor.
    const mailtos = [];
    for (const a of actions) {
      if (!a.unsub || a.spam) continue;
      if (a.tier === "one-click" && a.postUrl) {
        try {
          const r = await backend.unsubscribeOneClick(oauthFor(acct.provider), acct, { postUrl: a.postUrl });
          if (r.ok) unsubscribed++; else failed.push({ vendor: a.vendor, step: "unsubscribe", error: r.error || ("HTTP " + r.status) });
        } catch (e) { failed.push({ vendor: a.vendor, step: "unsubscribe", error: e.message }); }
      } else if (a.tier === "mailto" && a.mailto) {
        mailtos.push({ vendor: a.vendor, mailto: a.mailto });
      }
    }
    // 1b) Mailto unsubscribes — all over ONE pooled SMTP connection (single login,
    //     paced), so Yahoo doesn't reject them with "too many bad auth attempts".
    if (mailtos.length) {
      const r = await backend.sendUnsubscribeMailtos(oauthFor(acct.provider), acct, mailtos);
      unsubscribed += r.sent || 0;
      (r.failed || []).forEach((f) => failed.push({ vendor: f.vendor, step: "unsubscribe", error: f.error }));
    }
    // 2) Purge — ONE pass over the inbox. Match by EXACT ADDRESS only (no domain),
    //    so trashing one vendor can't sweep other senders sharing its domain, and
    //    NEVER touch personal correspondence. undo = the same exact-address rules.
    const rules = actions.filter((a) => a.trash && !a.personal).map((a) => ({ addresses: a.addresses }));
    let trashed = 0;
    if (rules.length) {
      try { trashed = (await backend.purgeMany(oauthFor(acct.provider), acct, { rules })).trashed || 0; }
      catch (e) { failed.push({ vendor: "(purge)", step: "trash", error: e.message }); }
    }
    return { ok: true, trashed, unsubscribed, failed, undo: trashed ? rules : [] };
  } catch (err) { return { ok: false, error: err.message }; }
});

ipcMain.handle("cleanup:undo", async (_e, { accountId, undo = [] } = {}) => {
  try {
    const acct = accounts.withSecret(accountId);
    const backend = acct && BACKENDS[acct.provider];
    if (!backend || !backend.undoMany) return { ok: false, error: "Not supported." };
    const restored = (await backend.undoMany(oauthFor(acct.provider), acct, { rules: undo })).restored || 0;
    return { ok: true, restored };
  } catch (err) { return { ok: false, error: err.message }; }
});

// Semantic email search — returns indices of matching emails.
ipcMain.handle("ai:search", async (_e, { query = "", items = [] }) => {
  try { return { ok: true, indices: await ai.searchEmails(query, items) }; }
  catch (err) { return { ok: false, error: err.message, indices: [] }; }
});

// Batch-classify emails into category buckets (replaces the local heuristic).
ipcMain.handle("ai:classify", async (_e, { items = [] }) => {
  try { return { ok: true, categories: await ai.classifyEmails(items) }; }
  catch (err) { return { ok: false, error: err.message, categories: [] }; }
});

// Per-message overrides (the "back to inbox" fix).
ipcMain.handle("overrides:get", () => folders.getOverrides());
ipcMain.handle("overrides:add", (_e, key) => { folders.addOverride(key); return { ok: true }; });
ipcMain.handle("overrides:remove", (_e, key) => { folders.removeOverride(key); return { ok: true }; });

// ── Lifecycle ───────────────────────────────────────────────────────────────
app.whenReady().then(() => {
  // One-time dev seed from the verified probe creds, so the connected account
  // is live without re-onboarding. No-op once accounts exist.
  try { accounts.importBootstrapIfEmpty(path.join(__dirname, "tools")); } catch {}
  createWindow();
  // Dock-icon click (or app re-activate): recreate if gone, otherwise re-show the
  // hidden window — it was only hidden on close, never destroyed.
  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
    else if (mainWindow) { mainWindow.show(); mainWindow.focus(); }
  });
});

// A real quit (Cmd-Q, dock menu, app.quit()) must bypass the hide-on-close guard.
app.on("before-quit", () => { app.isQuitting = true; });
app.on("window-all-closed", () => { if (process.platform !== "darwin") app.quit(); });
