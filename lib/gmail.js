"use strict";

/* Gmail backend — Gmail REST API over OAuth2 ("Sign in with Google").
   Same interface shape as lib/zoho.js so the main dispatcher can treat
   providers uniformly. Pure Node (fetch). oauth = {clientId, clientSecret};
   account = {id, address, refreshToken}. */

const { parseUnsub, oneClickPost, buildSenderMatcher } = require("./unsub");

const BASE = "https://gmail.googleapis.com/gmail/v1/users/me";
const TOKEN_URL = "https://oauth2.googleapis.com/token";
const SCOPES = [
  "https://www.googleapis.com/auth/gmail.modify",
  "https://www.googleapis.com/auth/gmail.send",
  "https://www.googleapis.com/auth/userinfo.profile", // read the account's display photo (getAvatar)
];

const tokenCache = {};
const avatarCache = {}; // account.id -> dataUrl|null (the Google profile photo)

function decodeEntities(s) {
  return (s || "").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&amp;/g, "&");
}
function parseFrom(raw) {
  const s = decodeEntities(raw || "").trim();
  const m = s.match(/^"?([^"<]*?)"?\s*<([^>]+)>$/);
  if (m) { const email = m[2].toLowerCase().trim(); return { name: (m[1] || "").trim() || email, email }; }
  return { name: s, email: s.toLowerCase() };
}
function fmtTime(ms) {
  if (!ms) return "";
  const d = new Date(Number(ms)), now = new Date();
  if (d.toDateString() === now.toDateString()) return d.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
  const y = new Date(now); y.setDate(now.getDate() - 1);
  if (d.toDateString() === y.toDateString()) return "Yesterday";
  if ((now - d) / 86400000 < 7) return d.toLocaleDateString([], { weekday: "short" });
  return d.toLocaleDateString([], { month: "short", day: "numeric" });
}
async function mapLimit(items, limit, fn) {
  const out = new Array(items.length);
  let i = 0;
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (i < items.length) { const idx = i++; out[idx] = await fn(items[idx], idx); }
  }));
  return out;
}

// ── OAuth ───────────────────────────────────────────────────────────────────
function buildAuthUrl(oauth, redirectUri) {
  const p = new URLSearchParams({
    client_id: oauth.clientId, redirect_uri: redirectUri, response_type: "code",
    scope: SCOPES.join(" "), access_type: "offline", prompt: "consent", include_granted_scopes: "true",
  });
  return "https://accounts.google.com/o/oauth2/v2/auth?" + p.toString();
}
async function exchangeCode(oauth, code, redirectUri) {
  const body = new URLSearchParams({ code, client_id: oauth.clientId, client_secret: oauth.clientSecret, redirect_uri: redirectUri, grant_type: "authorization_code" });
  const r = await fetch(TOKEN_URL, { method: "POST", body });
  const j = await r.json().catch(() => ({}));
  if (!j.refresh_token) throw new Error("Google code exchange failed: " + (j.error_description || j.error || JSON.stringify(j)));
  return { refreshToken: j.refresh_token, accessToken: j.access_token, scope: j.scope || "" };
}
async function access(oauth, account) {
  const c = tokenCache[account.id];
  if (c && c.exp > Date.now() + 30000) return c.token;
  const body = new URLSearchParams({ grant_type: "refresh_token", client_id: oauth.clientId, client_secret: oauth.clientSecret, refresh_token: account.refreshToken });
  const r = await fetch(TOKEN_URL, { method: "POST", body });
  const j = await r.json().catch(() => ({}));
  if (!j.access_token) throw new Error("Google token refresh failed: " + (j.error || JSON.stringify(j)));
  tokenCache[account.id] = { token: j.access_token, exp: Date.now() + (j.expires_in || 3600) * 1000 };
  return j.access_token;
}
function clearAccountCache(id) { delete tokenCache[id]; delete avatarCache[id]; }
async function api(oauth, account, p, opts = {}) {
  const token = await access(oauth, account);
  return fetch(BASE + p, { ...opts, headers: { ...(opts.headers || {}), Authorization: "Bearer " + token } });
}
async function getProfile(oauth, account) {
  const r = await api(oauth, account, "/profile");
  const j = await r.json().catch(() => ({}));
  return { address: j.emailAddress };
}

// ── Mail ────────────────────────────────────────────────────────────────────
function hdr(headers, name) { const h = (headers || []).find((x) => x.name.toLowerCase() === name.toLowerCase()); return h ? h.value : ""; }
function mapGmail(account, msg) {
  const headers = msg.payload ? msg.payload.headers : [];
  const f = parseFrom(hdr(headers, "From"));
  return {
    id: `${account.id}:${msg.id}`,
    account: account.id,
    messageId: msg.id,
    folderId: null,
    fromName: f.name,
    fromEmail: f.email,
    to: hdr(headers, "To") || "",
    cc: hdr(headers, "Cc") || "",
    subject: decodeEntities(hdr(headers, "Subject") || "(no subject)"),
    snippet: decodeEntities(msg.snippet || ""),
    dateMs: Number(msg.internalDate) || 0,
    time: fmtTime(msg.internalDate),
    unread: (msg.labelIds || []).includes("UNREAD"),
  };
}
async function hydrateIds(oauth, account, ids) {
  const metas = await mapLimit(ids, 12, async (id) => {
    const mr = await api(oauth, account, `/messages/${id}?format=metadata&metadataHeaders=From&metadataHeaders=To&metadataHeaders=Cc&metadataHeaders=Subject&metadataHeaders=Date`);
    const mj = await mr.json().catch(() => ({}));
    return mr.ok ? mapGmail(account, mj) : null;
  });
  return metas.filter(Boolean);
}
async function listByQuery(oauth, account, q, limit) {
  const r = await api(oauth, account, `/messages?q=${encodeURIComponent(q)}&maxResults=${limit}`);
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error("Gmail list failed: " + (j.error && j.error.message ? j.error.message : r.status));
  return hydrateIds(oauth, account, (j.messages || []).map((m) => m.id));
}
// Cursor pagination. cursor = Gmail pageToken; nextCursor = next pageToken|null.
async function listPage(oauth, account, { scope = "inbox", cursor, limit = 50 }) {
  // Known kinds map to a Gmail query; anything else is a folder = a label.
  const q = scope === "inbox" ? "in:inbox" : (FOLDER_Q[scope] || `label:"${scope}"`);
  let p = `/messages?q=${encodeURIComponent(q)}&maxResults=${Math.min(limit, 100)}`;
  if (cursor) p += `&pageToken=${encodeURIComponent(cursor)}`;
  const r = await api(oauth, account, p);
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error("Gmail list failed: " + (j.error && j.error.message ? j.error.message : r.status));
  const messages = await hydrateIds(oauth, account, (j.messages || []).map((m) => m.id));
  return { messages, nextCursor: j.nextPageToken || null };
}
async function listInbox(oauth, account, limit = 50) { return listByQuery(oauth, account, "in:inbox", limit); }
async function inboxUnread(oauth, account) {
  try { const r = await api(oauth, account, "/labels/INBOX"); const j = await r.json().catch(() => ({})); return j.messagesUnread || 0; }
  catch { return null; }
}
async function listMany(oauth, account, total = 400) { return listByQuery(oauth, account, "in:inbox", Math.min(total, 250)); }
// Whole-mailbox search — a bare Gmail query (no in:inbox) spans every label/folder.
async function searchAll(oauth, account, { query = "", cap = 500 } = {}) {
  const q = String(query).trim();
  if (!q) return [];
  return listByQuery(oauth, account, q, Math.min(cap, 250));
}

// Walk the MIME tree: pull the best html/text body, and collect every part
// that is an attachment or an inline (cid) image.
function findBody(payload) {
  let html = "", text = "";
  const attachments = [];
  (function walk(p) {
    if (!p) return;
    const mt = (p.mimeType || "").toLowerCase();
    const filename = p.filename || "";
    const cidRaw = hdr(p.headers, "Content-Id") || hdr(p.headers, "X-Attachment-Id") || "";
    const contentId = cidRaw.replace(/^<|>$/g, "").trim() || null;
    const disp = (hdr(p.headers, "Content-Disposition") || "").toLowerCase();
    const isAttachment = (p.body && p.body.attachmentId) || filename || (contentId && mt.startsWith("image/"));
    // A leaf body part that's the actual message text (no filename, text/*).
    if (p.body && p.body.data && !filename && (mt === "text/html" || mt === "text/plain")) {
      const decoded = Buffer.from(p.body.data, "base64url").toString("utf8");
      if (mt === "text/html" && !html) html = decoded;
      else if (mt === "text/plain" && !text) text = decoded;
    } else if (isAttachment && (mt !== "text/html" && mt !== "text/plain" || filename)) {
      attachments.push({
        id: (p.body && p.body.attachmentId) || null,
        // tiny inline parts sometimes arrive as data directly, no attachmentId
        data: (p.body && p.body.data) || null,
        name: filename || (contentId ? `${contentId}` : "attachment"),
        size: (p.body && p.body.size) || 0,
        mimeType: mt || "application/octet-stream",
        contentId,
        // inline = embeddable cid image only; a non-image or cid-less part is a real
        // attachment even when marked Content-Disposition: inline (e.g. iPhone PDFs).
        inline: mt.startsWith("image/") && !!contentId,
      });
    }
    (p.parts || []).forEach(walk);
  })(payload);
  return { html, text, attachments };
}
async function getContent(oauth, account, _folderId, messageId) {
  const r = await api(oauth, account, `/messages/${messageId}?format=full`);
  const j = await r.json().catch(() => ({}));
  const { html, text, attachments } = findBody(j.payload);
  return {
    html: html || (text ? `<p>${text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/\n/g, "<br>")}</p>` : ""),
    subject: hdr(j.payload ? j.payload.headers : [], "Subject"),
    attachments,
  };
}
// Fetch one attachment's bytes. Gmail returns base64url; normalize to base64.
async function getAttachment(oauth, account, { messageId, attachmentId }) {
  const r = await api(oauth, account, `/messages/${messageId}/attachments/${attachmentId}`);
  const j = await r.json().catch(() => ({}));
  if (!r.ok || !j.data) throw new Error("Gmail attachment fetch failed: " + (j.error && j.error.message ? j.error.message : r.status));
  const base64 = Buffer.from(j.data, "base64url").toString("base64");
  return { base64 };
}

// RFC 2822 message; multipart/mixed when there are attachments.
function buildMime({ from, to, cc, bcc, subject, body, attachments }) {
  const headers = [`From: ${from}`, `To: ${to}`];
  if (cc) headers.push(`Cc: ${cc}`);
  if (bcc) headers.push(`Bcc: ${bcc}`);
  headers.push(`Subject: ${subject || ""}`, "MIME-Version: 1.0");
  if (!attachments || !attachments.length) {
    return headers.join("\r\n") + `\r\nContent-Type: text/plain; charset=UTF-8\r\n\r\n${body || ""}`;
  }
  const boundary = "=_clearkeep_" + Date.now().toString(36);
  let out = headers.join("\r\n") + `\r\nContent-Type: multipart/mixed; boundary="${boundary}"\r\n\r\n`;
  out += `--${boundary}\r\nContent-Type: text/plain; charset=UTF-8\r\n\r\n${body || ""}\r\n`;
  for (const a of attachments) {
    const name = String(a.name || "attachment").replace(/"/g, "'");
    const b64 = String(a.base64 || "").replace(/\s+/g, "").replace(/(.{76})/g, "$1\r\n");
    out += `--${boundary}\r\n`;
    out += `Content-Type: ${a.mimeType || "application/octet-stream"}; name="${name}"\r\n`;
    out += `Content-Disposition: attachment; filename="${name}"\r\n`;
    out += `Content-Transfer-Encoding: base64\r\n\r\n${b64}\r\n`;
  }
  out += `--${boundary}--`;
  return out;
}
async function send(oauth, account, { to, cc, bcc, subject, body, attachments }) {
  const mime = buildMime({ from: account.address, to, cc, bcc, subject, body, attachments });
  const r = await api(oauth, account, "/messages/send", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ raw: Buffer.from(mime, "utf8").toString("base64url") }) });
  if (!r.ok) { const j = await r.json().catch(() => ({})); throw new Error("Send failed: " + (j.error && j.error.message ? j.error.message : r.status)); }
  return { ok: true };
}

const LABEL_MOVES = {
  trash: { add: ["TRASH"], remove: ["INBOX"] },
  archive: { add: [], remove: ["INBOX"] },
  spam: { add: ["SPAM"], remove: ["INBOX"] },
  inbox: { add: ["INBOX"], remove: ["TRASH", "SPAM"] },
};
async function move(oauth, account, messageIds, target) {
  const m = LABEL_MOVES[target] || LABEL_MOVES.trash;
  const r = await api(oauth, account, "/messages/batchModify", {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ ids: messageIds.map(String), addLabelIds: m.add, removeLabelIds: m.remove }),
  });
  if (!r.ok) { const j = await r.json().catch(() => ({})); throw new Error("Move failed: " + (j.error && j.error.message ? j.error.message : r.status)); }
  return { ok: true };
}

// ── Server-side filing via labels ────────────────────────────────────────────
async function ensureLabel(oauth, account, name) {
  const r = await api(oauth, account, "/labels");
  const j = await r.json().catch(() => ({}));
  const found = (j.labels || []).find((l) => l.name.toLowerCase() === name.toLowerCase());
  if (found) return found.id;
  const cr = await api(oauth, account, "/labels", {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ name, labelListVisibility: "labelShow", messageListVisibility: "show" }),
  });
  const cj = await cr.json().catch(() => ({}));
  if (!cr.ok) throw new Error("Label create failed: " + (cj.error && cj.error.message ? cj.error.message : cr.status));
  return cj.id;
}
// Page every id matching a Gmail query. `cap` bounds the scan (default unbounded —
// fileBySenders/unfileToInbox need the WHOLE match set; the AI scans pass a ceiling).
async function searchIds(oauth, account, q, cap = Infinity) {
  const ids = []; let pageToken = null;
  do {
    let p = `/messages?q=${encodeURIComponent(q)}&maxResults=500`;
    if (pageToken) p += `&pageToken=${pageToken}`;
    const r = await api(oauth, account, p);
    const j = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error("Search failed: " + (j.error && j.error.message ? j.error.message : r.status));
    (j.messages || []).forEach((m) => ids.push(m.id));
    pageToken = j.nextPageToken || null;
  } while (pageToken && ids.length < cap);
  return ids.length > cap ? ids.slice(0, cap) : ids;
}
async function batchModify(oauth, account, ids, addLabelIds, removeLabelIds) {
  for (let i = 0; i < ids.length; i += 1000) {
    const r = await api(oauth, account, "/messages/batchModify", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ ids: ids.slice(i, i + 1000), addLabelIds, removeLabelIds }),
    });
    if (!r.ok) { const j = await r.json().catch(() => ({})); throw new Error("batchModify failed: " + (j.error && j.error.message ? j.error.message : r.status)); }
  }
}
// Label all matching INBOX mail and archive it (remove INBOX) → "filed".
async function fileBySenders(oauth, account, { name, addresses = [], domains = [] }) {
  const terms = [...new Set([...(addresses || []), ...(domains || [])])].filter(Boolean);
  if (!terms.length) return { filed: 0 };
  const labelId = await ensureLabel(oauth, account, name);
  const ids = await searchIds(oauth, account, `in:inbox from:(${terms.join(" OR ")})`);
  if (ids.length) await batchModify(oauth, account, ids, [labelId], ["INBOX"]);
  return { filed: ids.length, labelId };
}
// Undo / remove: pull everything back into the inbox, then delete the label.
async function unfileToInbox(oauth, account, { name }) {
  const labelId = await ensureLabel(oauth, account, name);
  const ids = await searchIds(oauth, account, `label:"${name}"`);
  if (ids.length) await batchModify(oauth, account, ids, ["INBOX"], [labelId]);
  try { await api(oauth, account, `/labels/${labelId}`, { method: "DELETE" }); } catch {}
  return { moved: ids.length };
}
// Real user folders on the server = user-created labels (not system/categories),
// each with its unread count.
async function listUserFolders(oauth, account) {
  const r = await api(oauth, account, "/labels");
  const j = await r.json().catch(() => ({}));
  const labels = (j.labels || []).filter((l) => l.type === "user");
  return mapLimit(labels, 12, async (l) => {
    let unread = 0;
    try {
      const lr = await api(oauth, account, `/labels/${l.id}`);
      const lj = await lr.json().catch(() => ({}));
      unread = lj.messagesUnread || 0;
    } catch {}
    return { name: l.name, unread };
  });
}

// Mark messages read/unread by toggling the UNREAD label.
async function markRead(oauth, account, messageIds, read) {
  const key = read ? "removeLabelIds" : "addLabelIds";
  const r = await api(oauth, account, "/messages/batchModify", {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ ids: messageIds.map(String), [key]: ["UNREAD"] }),
  });
  if (!r.ok) { const j = await r.json().catch(() => ({})); throw new Error("Read-state update failed: " + (j.error && j.error.message ? j.error.message : r.status)); }
  return { ok: true };
}

const FOLDER_Q = { Trash: "in:trash", Spam: "in:spam", Sent: "in:sent", Archive: "-in:inbox -in:trash -in:spam -in:sent -in:draft -in:chats" };
async function listFolderByKind(oauth, account, kind, limit = 100) {
  const q = FOLDER_Q[kind] || "in:trash";
  return { messages: await listByQuery(oauth, account, q, limit) };
}

// ── AI read-side methods (parity with lib/zoho.js / lib/imap.js) ─────────────
// Full INBOX scan, newest-first, each row carrying a monotonic numeric `uid` for
// the Important poll cursor. Gmail message ids are hex, so — exactly like Zoho fell
// back to dateMs — we use internalDate ms (already in row.dateMs) as the uid; the
// cursor only needs monotonicity and scanAll covers any same-ms backlog. Feeds
// important:classifyNew/scanAll, the keepers scan, and ask:answer.
async function inboxForScan(oauth, account, { limit = 2000 } = {}) {
  const ids = await searchIds(oauth, account, "in:inbox", limit);
  const rows = await hydrateIds(oauth, account, ids);
  for (const r of rows) r.uid = r.dateMs;
  rows.sort((a, b) => b.dateMs - a.dateMs);
  return rows;
}

// Account-wide sender tally for the AI organizer + Clean up. INBOX-only (matches
// the IMAP backend's CLEANUP_SCOPE = ["INBOX"]) — filing/cleanup organize the inbox,
// so they must not surface senders whose mail already lives in another label. No
// List-Unsubscribe data here (that needs a per-message header fetch) → hasUnsub:false;
// the cleanup flow probes each kept sender separately via probeUnsubscribe.
async function accountSenderTally(oauth, account, { minCount = 3, top = 400, onProgress } = {}) {
  const MAX = 6000, CHUNK = 200;
  const ids = await searchIds(oauth, account, "in:inbox", MAX);
  const map = new Map();
  let scanned = 0;
  for (let i = 0; i < ids.length; i += CHUNK) {
    const rows = await hydrateIds(oauth, account, ids.slice(i, i + CHUNK));
    for (const m of rows) {
      scanned++;
      const email = String(m.fromEmail || "").toLowerCase();
      if (!email) continue;
      let e = map.get(email);
      if (!e) { e = { name: m.fromName || email, count: 0, sampleSubject: m.subject || "", sampleMailbox: "INBOX", sampleUid: m.messageId, subjects: [] }; map.set(email, e); }
      e.count++;
      if (m.subject) { e.subjects.push(m.subject); if (e.subjects.length > 8) e.subjects.shift(); }
    }
    if (onProgress) onProgress(scanned);
  }
  const arr = [...map.entries()].filter(([, e]) => e.count >= minCount).sort((a, b) => b[1].count - a[1].count);
  const kept = arr.slice(0, top);
  return {
    senders: kept.map(([email, e]) => ({ email, name: e.name, count: e.count, sampleSubject: e.sampleSubject, sampleMailbox: e.sampleMailbox, sampleUid: e.sampleUid, subjects: e.subjects, hasUnsub: false })),
    excluded: Math.max(0, arr.length - kept.length),
  };
}

// ── Clean up: bulk unsubscribe + purge-to-Trash (needs write scope) ───────────
// Probe one sample message's headers for List-Unsubscribe. The cleanup flow calls
// this per sender with {mailbox: sampleMailbox, uid: sampleUid}; Gmail needs only the
// message id (uid), so mailbox is ignored. format=metadata returns the headers as a
// {name,value} array, which we rebuild into a raw block for the shared parseUnsub.
async function probeUnsubscribe(oauth, account, { uid } = {}) {
  try {
    if (!uid) return { tier: "none" };
    const r = await api(oauth, account, `/messages/${uid}?format=metadata&metadataHeaders=List-Unsubscribe&metadataHeaders=List-Unsubscribe-Post`);
    const j = await r.json().catch(() => ({}));
    const headers = (j.payload && j.payload.headers) || [];
    const raw = headers.map((h) => `${h.name}: ${h.value}`).join("\r\n");
    return parseUnsub(raw);
  } catch { return { tier: "none" }; }
}

// RFC 8058 one-click unsubscribe — provider-agnostic HTTP POST.
function unsubscribeOneClick(_oauth, _account, { postUrl } = {}) {
  return oneClickPost({ postUrl });
}

// Mailto unsubscribes — sent through the account's own Gmail send API.
async function sendUnsubscribeMailtos(oauth, account, items = []) {
  if (!items.length) return { sent: 0, failed: [] };
  let sent = 0;
  const failed = [];
  for (const it of items) {
    const [addr, query] = String(it.mailto || "").split("?");
    if (!addr) { failed.push({ vendor: it.vendor, error: "no address" }); continue; }
    const subject = new URLSearchParams(query || "").get("subject") || "unsubscribe";
    try { await send(oauth, account, { to: addr, subject, body: "unsubscribe" }); sent++; }
    catch (e) { failed.push({ vendor: it.vendor, error: e.message }); }
  }
  return { sent, failed };
}

// Purge: move INBOX mail from the ruled senders (exact address or domain) to Trash.
async function purgeMany(oauth, account, { rules = [] } = {}) {
  const { match, empty } = buildSenderMatcher(rules);
  if (empty) return { trashed: 0, perMailbox: [] };
  const inbox = await inboxForScan(oauth, account, { limit: 6000 });
  const ids = inbox.filter((m) => match(m.fromEmail)).map((m) => m.messageId);
  if (!ids.length) return { trashed: 0, perMailbox: [] };
  await batchModify(oauth, account, ids, ["TRASH"], ["INBOX"]);
  return { trashed: ids.length, perMailbox: [`INBOX:${ids.length}`] };
}

// Undo a purge: move the ruled senders' mail from Trash back to INBOX.
async function undoMany(oauth, account, { rules = [] } = {}) {
  const { match, empty } = buildSenderMatcher(rules);
  if (empty) return { restored: 0 };
  const ids = await searchIds(oauth, account, "in:trash", 6000);
  const rows = await hydrateIds(oauth, account, ids);
  const restore = rows.filter((m) => match(m.fromEmail)).map((m) => m.messageId);
  if (!restore.length) return { restored: 0 };
  await batchModify(oauth, account, restore, ["INBOX"], ["TRASH"]);
  return { restored: restore.length };
}

// ── Keeper-flow junk sweep + drag-to-folder (needs write scope) ──────────────
// Move ids to Trash, returning them for a precise undo.
async function trashByIds(oauth, account, { messageIds = [] } = {}) {
  if (!messageIds.length) return { trashed: 0, undo: { uids: [] } };
  const ids = messageIds.map(String);
  await batchModify(oauth, account, ids, ["TRASH"], ["INBOX"]);
  return { trashed: ids.length, undo: { uids: ids } };
}
// Undo a junk sweep: move the same ids back to INBOX.
async function restoreIds(oauth, account, { uids = [] } = {}) {
  if (!uids.length) return { restored: 0 };
  const ids = uids.map(String);
  await batchModify(oauth, account, ids, ["INBOX"], ["TRASH"]);
  return { restored: ids.length };
}
// Drag-and-drop / keepers:file — label specific messages and archive them (remove
// INBOX) into a named user folder = label.
async function moveToFolder(oauth, account, messageIds, folderName) {
  if (!messageIds || !messageIds.length) return { ok: true };
  const labelId = await ensureLabel(oauth, account, folderName);
  await batchModify(oauth, account, messageIds.map(String), [labelId], ["INBOX"]);
  return { ok: true };
}

// The account owner's Google profile photo. Needs the userinfo.profile scope
// (in SCOPES) — accounts connected before that scope was added return null until
// reconnected. The OIDC userinfo endpoint hands back the photo URL; we fetch the
// bytes server-side and return a data URL (matches lib/zoho.js getAvatar). Null →
// the renderer falls through to the generic Google-logo/initials avatar.
async function getAvatar(oauth, account) {
  if (Object.prototype.hasOwnProperty.call(avatarCache, account.id)) return avatarCache[account.id];
  try {
    const token = await access(oauth, account);
    const ur = await fetch("https://www.googleapis.com/oauth2/v3/userinfo", { headers: { Authorization: "Bearer " + token } });
    const uj = await ur.json().catch(() => ({}));
    let url = uj.picture; // present only when the profile scope was granted
    if (!url) { avatarCache[account.id] = null; return null; }
    url = url.replace(/=s\d+(-c)?$/, "") + "=s96-c"; // normalize to a crisp 96px square crop
    const ir = await fetch(url);
    const type = ir.headers.get("content-type") || "";
    if (!ir.ok || !/^image\//i.test(type)) { avatarCache[account.id] = null; return null; }
    const buf = Buffer.from(await ir.arrayBuffer());
    if (buf.length < 100) { avatarCache[account.id] = null; return null; }
    const dataUrl = `data:${type.split(";")[0]};base64,${buf.toString("base64")}`;
    avatarCache[account.id] = dataUrl;
    return dataUrl;
  } catch { avatarCache[account.id] = null; return null; }
}

module.exports = {
  buildAuthUrl, exchangeCode, getProfile, clearAccountCache, getAvatar,
  listInbox, listMany, listPage, getContent, getAttachment, send, move, markRead, listFolderByKind,
  fileBySenders, unfileToInbox, ensureLabel, listUserFolders, inboxUnread, searchAll,
  inboxForScan, accountSenderTally, probeUnsubscribe, unsubscribeOneClick, sendUnsubscribeMailtos,
  purgeMany, undoMany, trashByIds, restoreIds, moveToFolder,
};
