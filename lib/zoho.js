"use strict";

/* Zoho Mail REST API client (free-plan compatible — no IMAP).
   Pure Node (no Electron deps) so it can be unit-tested directly.
   US data center. OAuth2: a shared self-client (clientId/secret) + a per-account
   refresh token → short-lived access tokens (cached in-memory, 1h). */

const { parseUnsub, oneClickPost, buildSenderMatcher } = require("./unsub");

const ACCOUNTS_DC = "https://accounts.zoho.com";
const MAIL_DC = "https://mail.zoho.com";

const tokenCache = {}; // account.id -> { accessToken, exp }

function decodeEntities(s) {
  return (s || "")
    .replace(/&lt;/g, "<").replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&amp;/g, "&");
}

function parseFrom(raw) {
  const s = decodeEntities(raw || "").trim();
  const m = s.match(/^"?([^"<]*?)"?\s*<([^>]+)>$/);
  if (m) { const email = m[2].toLowerCase().trim(); return { name: (m[1] || "").trim() || email, email }; }
  return { name: s, email: s.toLowerCase() };
}

function fmtTime(ms) {
  if (!ms) return "";
  const d = new Date(Number(ms));
  const now = new Date();
  if (d.toDateString() === now.toDateString()) return d.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
  const yest = new Date(now); yest.setDate(now.getDate() - 1);
  if (d.toDateString() === yest.toDateString()) return "Yesterday";
  if ((now - d) / 86400000 < 7) return d.toLocaleDateString([], { weekday: "short" });
  return d.toLocaleDateString([], { month: "short", day: "numeric" });
}

async function refreshAccessToken(oauth, account) {
  const cached = tokenCache[account.id];
  if (cached && cached.exp > Date.now() + 30000) return cached.accessToken;
  const body = new URLSearchParams({
    grant_type: "refresh_token",
    client_id: oauth.clientId,
    client_secret: oauth.clientSecret,
    refresh_token: account.refreshToken,
  });
  const r = await fetch(`${ACCOUNTS_DC}/oauth/v2/token`, { method: "POST", body });
  const j = await r.json().catch(() => ({}));
  if (!j.access_token) throw new Error("Token refresh failed: " + (j.error || JSON.stringify(j)));
  tokenCache[account.id] = { accessToken: j.access_token, exp: Date.now() + (j.expires_in || 3600) * 1000 };
  return j.access_token;
}

async function apiFetch(oauth, account, pathStr, opts = {}) {
  const token = await refreshAccessToken(oauth, account);
  return fetch(`${MAIL_DC}${pathStr}`, {
    ...opts,
    headers: { ...(opts.headers || {}), Authorization: `Zoho-oauthtoken ${token}` },
  });
}

// ── Onboarding helpers ──────────────────────────────────────────────────────
// Exchange a one-time grant code (from the Zoho self-client) for a refresh token.
async function exchangeGrant(oauth, grantCode) {
  const body = new URLSearchParams({
    grant_type: "authorization_code",
    client_id: oauth.clientId,
    client_secret: oauth.clientSecret,
    code: grantCode,
  });
  const r = await fetch(`${ACCOUNTS_DC}/oauth/v2/token`, { method: "POST", body });
  const j = await r.json().catch(() => ({}));
  if (!j.refresh_token) throw new Error("Grant exchange failed: " + (j.error || JSON.stringify(j)));
  return { refreshToken: j.refresh_token, accessToken: j.access_token, scope: j.scope || "" };
}

// Invalidate cached access token + folders for an account (e.g. after reconnect).
function clearAccountCache(accountId) {
  delete tokenCache[accountId];
  delete folderCache[accountId];
}

// Identify the Zoho account (id + address) for a freshly connected refresh token.
async function discoverAccount(oauth, account) {
  const r = await apiFetch(oauth, account, "/api/accounts");
  const j = await r.json().catch(() => ({}));
  if (!j.data) throw new Error("Could not read account details.");
  const a = Array.isArray(j.data) ? j.data[0] : j.data;
  return {
    zohoAccountId: a.accountId || a.account_id,
    address: a.primaryEmailAddress || a.mailboxAddress || a.incomingUserName,
  };
}

// ── Account profile photo ───────────────────────────────────────────────────
// The account owner's photo (the one set in Zoho Mail). /api/accounts gives the
// zuid + isLogoExist; the image lives at the public Zoho Contacts file endpoint
// keyed by that zuid. Returns a data URL, or null when no photo is set.
const avatarCache = {}; // account.id -> dataUrl|null
async function getAvatar(oauth, account) {
  if (Object.prototype.hasOwnProperty.call(avatarCache, account.id)) return avatarCache[account.id];
  const r = await apiFetch(oauth, account, "/api/accounts");
  const j = await r.json().catch(() => ({}));
  const a = Array.isArray(j.data) ? j.data[0] : j.data;
  if (!a || !a.zuid || a.isLogoExist === false) { avatarCache[account.id] = null; return null; }
  const ir = await fetch(`https://contacts.zoho.com/file?ID=${a.zuid}&fs=thumb`);
  const type = ir.headers.get("content-type") || "";
  if (!ir.ok || !/^image\//i.test(type)) { avatarCache[account.id] = null; return null; }
  const buf = Buffer.from(await ir.arrayBuffer());
  if (buf.length < 100) { avatarCache[account.id] = null; return null; }
  const dataUrl = `data:${type.split(";")[0]};base64,${buf.toString("base64")}`;
  avatarCache[account.id] = dataUrl;
  return dataUrl;
}

// ── Mail ────────────────────────────────────────────────────────────────────
function mapMessage(account, m) {
  const f = parseFrom(m.fromAddress || m.sender);
  return {
    id: `${account.id}:${m.messageId}`,
    account: account.id,
    messageId: m.messageId,
    folderId: m.folderId,
    fromName: f.name,
    fromEmail: f.email,
    to: m.toAddress || "",
    cc: m.ccAddress || "",
    subject: decodeEntities(m.subject || "(no subject)"),
    snippet: decodeEntities(m.summary || ""),
    dateMs: Number(m.receivedTime) || Number(m.sentDateInGMT) || 0,
    time: fmtTime(m.receivedTime || m.sentDateInGMT),
    unread: String(m.status) === "0",
  };
}

// "Inbox" = the real /Inbox folder only. Zoho tags user folders (Notification,
// Newsletter, Vercel, …) as folderType "Inbox" too, but those are sidebar folders
// (see listUserFolders), not the inbox — scoping by the canonical inbox folderId
// keeps filing meaningful (filed mail leaves the inbox view).
async function listInbox(oauth, account, limit = 50) {
  const inboxId = await resolveFolder(oauth, account, "inbox");
  if (!inboxId) throw new Error("No Inbox folder found.");
  const r = await apiFetch(oauth, account, `/api/accounts/${account.zohoAccountId}/messages/view?folderId=${inboxId}&limit=${limit}`);
  const j = await r.json().catch(() => ({}));
  if (!j.data) throw new Error("Could not list messages: " + JSON.stringify(j).slice(0, 200));
  return j.data.map((m) => mapMessage(account, m));
}

// Deep paginated scan of the INBOX (for the AI back-scan). Inbox-scoped, like above.
async function listMany(oauth, account, total = 400) {
  const inboxId = await resolveFolder(oauth, account, "inbox");
  if (!inboxId) return [];
  const pageSize = 200;
  const out = [];
  for (let start = 1; out.length < total; start += pageSize) {
    const r = await apiFetch(oauth, account, `/api/accounts/${account.zohoAccountId}/messages/view?folderId=${inboxId}&limit=${pageSize}&start=${start}`);
    const j = await r.json().catch(() => ({}));
    if (!j.data || !j.data.length) break;
    out.push(...j.data.map((m) => mapMessage(account, m)));
    if (j.data.length < pageSize) break;
  }
  return out.slice(0, total);
}

// ── Folders + moves (write scope: ZohoMail.messages.ALL + folders.READ) ──────
const folderCache = {};
async function getFolders(oauth, account) {
  if (folderCache[account.id]) return folderCache[account.id];
  const r = await apiFetch(oauth, account, `/api/accounts/${account.zohoAccountId}/folders`);
  const j = await r.json().catch(() => ({}));
  const data = Array.isArray(j.data) ? j.data : [];
  if (data.length) folderCache[account.id] = data; // don't cache an empty (scope-denied) result
  return data;
}
const KIND_ALIASES = {
  trash: ["trash", "deleted", "deleted items"],
  spam: ["spam", "junk", "junk e-mail", "bulk mail"],
  archive: ["archive", "archived"],
  inbox: ["inbox"],
  sent: ["sent", "sent mail", "sent items"],
};
// A folder is "top-level" when its path has no nested segment (e.g. "/Inbox" yes,
// "/Trash/Vercel" no). Zoho marks MANY user folders as folderType "Inbox" and puts
// deleted folders under /Trash (folderType "Trash"), so we must resolve canonical
// system folders by their top-level name first, then type — never a nested folder.
function isTopLevel(f) {
  const p = String(f.path || ("/" + (f.folderName || "")));
  return !p.replace(/^\//, "").includes("/");
}
function folderIdByKind(folders, kind) {
  const names = KIND_ALIASES[kind.toLowerCase()] || [kind.toLowerCase()];
  const norm = (x) => String(x.folderName || x.path || "").toLowerCase().replace(/^\//, "");
  // 1) exact name match among top-level folders (the canonical /Inbox, /Trash, …)
  let f = folders.find((x) => isTopLevel(x) && names.includes(norm(x)));
  // 2) fall back to folderType, but only top-level (so /Trash/Vercel never wins "trash")
  if (!f) f = folders.find((x) => isTopLevel(x) && names.includes(String(x.folderType || "").toLowerCase()));
  return f ? f.folderId : null;
}
async function resolveFolder(oauth, account, kind) {
  return folderIdByKind(await getFolders(oauth, account), kind);
}
async function ensureFolder(oauth, account, name) {
  let id = await resolveFolder(oauth, account, name);
  if (id) return id;
  const r = await apiFetch(oauth, account, `/api/accounts/${account.zohoAccountId}/folders`, {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ folderName: name }),
  });
  const j = await r.json().catch(() => ({}));
  delete folderCache[account.id];
  if (j.data && j.data.folderId) return j.data.folderId;
  return resolveFolder(oauth, account, name);
}

// System folders whose mail should never appear in our inbox view.
const EXCLUDE = new Set(["trash", "deleted", "deleted items", "spam", "junk", "junk e-mail", "bulk mail", "sent", "drafts", "outbox", "templates", "archive", "archived"]);
async function excludedIds(oauth, account) {
  const folders = await getFolders(oauth, account);
  const s = new Set();
  folders.forEach((f) => {
    const t = String(f.folderType || "").toLowerCase();
    const n = String(f.folderName || f.path || "").toLowerCase().replace(/^\//, "");
    if (EXCLUDE.has(t) || EXCLUDE.has(n)) s.add(String(f.folderId));
  });
  return s;
}
// Zoho's /updatemessage rejects messageId arrays larger than 200 with HTTP 404
// "Invalid Input" (measured: 200 ok, 250 fails) — so chunk every bulk update.
const UPDATE_BATCH = 200;
async function updateMessages(oauth, account, extra, messageIds) {
  const ids = (messageIds || []).map(String);
  for (let i = 0; i < ids.length; i += UPDATE_BATCH) {
    const r = await apiFetch(oauth, account, `/api/accounts/${account.zohoAccountId}/updatemessage`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ ...extra, messageId: ids.slice(i, i + UPDATE_BATCH) }),
    });
    const j = await r.json().catch(() => ({}));
    if (j.status && j.status.code && Number(j.status.code) !== 200) throw new Error(j.status.description || `Update failed (${j.status.code})`);
  }
  return { ok: true };
}
async function moveMessages(oauth, account, messageIds, destFolderId) {
  if (!messageIds || !messageIds.length) return { ok: true };
  return updateMessages(oauth, account, { mode: "moveMessage", destfolderId: String(destFolderId) }, messageIds);
}
// Mark messages read/unread (needs write scope: ZohoMail.messages.ALL/UPDATE —
// fails on the read-only plan token).
async function markRead(oauth, account, messageIds, read) {
  if (!messageIds || !messageIds.length) return { ok: true };
  return updateMessages(oauth, account, { mode: read ? "markAsRead" : "markAsUnread" }, messageIds);
}

// Unified-interface wrappers (match lib/gmail.js).
async function move(oauth, account, messageIds, target) {
  const kind = target === "inbox" ? "Inbox" : target === "archive" ? "Archive" : target === "spam" ? "Spam" : "Trash";
  const destId = kind === "Archive" ? await ensureFolder(oauth, account, "Archive") : await resolveFolder(oauth, account, kind);
  if (!destId) throw new Error(`No "${kind}" folder found — reconnect the account with folder + write scope.`);
  return moveMessages(oauth, account, messageIds, destId);
}
async function listFolderByKind(oauth, account, kind, limit = 100) {
  const id = await resolveFolder(oauth, account, kind);
  if (!id) return { messages: [], error: `No "${kind}" folder` };
  return { messages: await listFolder(oauth, account, id, limit) };
}

// Cursor pagination. cursor = 1-based `start` offset; nextCursor = start+limit
// while full pages come back (verified contiguous + terminating), else null.
async function listPage(oauth, account, { scope = "inbox", cursor, limit = 50 }) {
  const start = Number(cursor) || 1;
  // Always scope to a folderId — "inbox" resolves to the canonical /Inbox folder
  // (not the merged Inbox-type stream), every other scope to its named folder.
  const fid = await resolveFolder(oauth, account, scope === "inbox" ? "inbox" : scope);
  if (!fid) return { messages: [], nextCursor: null, error: `No "${scope}" folder` };
  const qs = `start=${start}&limit=${limit}&folderId=${fid}`;
  const r = await apiFetch(oauth, account, `/api/accounts/${account.zohoAccountId}/messages/view?${qs}`);
  const j = await r.json().catch(() => ({}));
  const messages = (j.data || []).map((m) => mapMessage(account, m));
  const nextCursor = messages.length >= limit ? start + limit : null;
  return { messages, nextCursor };
}

// Paginated — Zoho's messages/view caps at ~200 per request, so loop to honour a
// larger `limit`. Callers (unfileToInbox, undoMany) rely on getting the WHOLE
// folder, or deleting it would trash the overflow.
async function listFolder(oauth, account, folderId, limit = 100) {
  const out = [];
  const pageSize = 200;
  for (let start = 1; out.length < limit; start += pageSize) {
    const want = Math.min(pageSize, limit - out.length);
    const r = await apiFetch(oauth, account, `/api/accounts/${account.zohoAccountId}/messages/view?folderId=${folderId}&limit=${want}&start=${start}`);
    const j = await r.json().catch(() => ({}));
    if (!j.data || !j.data.length) break;
    out.push(...j.data.map((m) => mapMessage(account, m)));
    if (j.data.length < want) break;
  }
  return out;
}

const MIME_BY_EXT = {
  png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg", gif: "image/gif", webp: "image/webp",
  svg: "image/svg+xml", bmp: "image/bmp", ico: "image/x-icon",
  pdf: "application/pdf", zip: "application/zip", ics: "text/calendar",
  doc: "application/msword", docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  xls: "application/vnd.ms-excel", xlsx: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  ppt: "application/vnd.ms-powerpoint", pptx: "application/vnd.openxmlformats-officedocument.presentationml.presentation",
  txt: "text/plain", csv: "text/csv", html: "text/html", mp4: "video/mp4", mp3: "audio/mpeg",
};
function mimeFromName(name) {
  const ext = (name || "").split(".").pop().toLowerCase();
  return MIME_BY_EXT[ext] || "application/octet-stream";
}

async function getAttachmentInfo(oauth, account, folderId, messageId) {
  try {
    const r = await apiFetch(oauth, account, `/api/accounts/${account.zohoAccountId}/folders/${folderId}/messages/${messageId}/attachmentinfo`);
    const j = await r.json().catch(() => ({}));
    const list = (j.data && j.data.attachments) || [];
    return list.map((a) => {
      const cid = a.cid || a.contentId || a.contentReference || null;
      return {
        id: a.attachmentId,
        name: a.attachmentName || "attachment",
        size: Number(a.attachmentSize) || 0,
        mimeType: mimeFromName(a.attachmentName),
        contentId: cid ? String(cid).replace(/^<|>$/g, "") : null,
        // inline = embeddable cid image only; cid-bearing non-images still list.
        inline: !!cid && mimeFromName(a.attachmentName).startsWith("image/"),
      };
    });
  } catch { return []; }
}

async function getContent(oauth, account, folderId, messageId) {
  const r = await apiFetch(oauth, account, `/api/accounts/${account.zohoAccountId}/folders/${folderId}/messages/${messageId}/content`);
  const j = await r.json().catch(() => ({}));
  const attachments = await getAttachmentInfo(oauth, account, folderId, messageId);
  return { html: (j.data && j.data.content) || "", subject: (j.data && j.data.subject) || "", attachments };
}

// Fetch one attachment's raw bytes → base64. folderId+messageId required.
async function getAttachment(oauth, account, { folderId, messageId, attachmentId }) {
  const r = await apiFetch(oauth, account, `/api/accounts/${account.zohoAccountId}/folders/${folderId}/messages/${messageId}/attachments/${attachmentId}`);
  if (!r.ok) throw new Error("Zoho attachment fetch failed: " + r.status);
  const buf = Buffer.from(await r.arrayBuffer());
  return { base64: buf.toString("base64") };
}

// Upload one attachment to Zoho's staging area; returns the ref the send API
// needs. (Untested end-to-end: blocked on the read-only token, same as send.)
async function uploadAttachment(oauth, account, a) {
  const r = await apiFetch(oauth, account, `/api/accounts/${account.zohoAccountId}/messages/attachments?fileName=${encodeURIComponent(a.name || "attachment")}`, {
    method: "POST",
    headers: { "Content-Type": a.mimeType || "application/octet-stream" },
    body: Buffer.from(a.base64 || "", "base64"),
  });
  const j = await r.json().catch(() => ({}));
  const d = Array.isArray(j.data) ? j.data[0] : j.data;
  if (!d || !d.storeName) throw new Error("Attachment upload failed: " + JSON.stringify(j).slice(0, 160));
  return { storeName: d.storeName, attachmentPath: d.attachmentPath, attachmentName: d.attachmentName || a.name };
}

async function sendMail(oauth, account, { to, cc, bcc, subject, body, attachments }) {
  const payload = {
    fromAddress: account.address,
    toAddress: to,
    subject: subject || "",
    content: body || "",
    mailFormat: "plaintext",
    askReceipt: "no",
  };
  if (cc) payload.ccAddress = cc;
  if (bcc) payload.bccAddress = bcc;
  if (attachments && attachments.length) {
    payload.attachments = await Promise.all(attachments.map((a) => uploadAttachment(oauth, account, a)));
  }
  const r = await apiFetch(oauth, account, `/api/accounts/${account.zohoAccountId}/messages`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });
  const j = await r.json().catch(() => ({}));
  if (j.status && j.status.code && j.status.code !== 200) throw new Error(j.status.description || "Send failed");
  if (j.data === undefined && j.status === undefined) throw new Error("Send failed: " + JSON.stringify(j).slice(0, 200));
  return { ok: true };
}

// ── AI read-side methods (no write scope needed) ─────────────────────────────
// Full INBOX scan, newest-first, each row carrying a monotonic numeric `uid` for
// the Important poll cursor — mirrors lib/imap.js inboxForScan. Zoho messageIds
// increase monotonically per account; if one ever exceeds the safe-integer range
// we fall back to receivedTime (the cursor only needs monotonicity, and scanAll
// covers any same-ms backlog). Used by important:classifyNew/scanAll + ask:answer.
async function inboxForScan(oauth, account, { limit = 2000 } = {}) {
  const inboxId = await resolveFolder(oauth, account, "inbox");
  if (!inboxId) return [];
  const pageSize = 200;
  const out = [];
  for (let start = 1; out.length < limit; start += pageSize) {
    const r = await apiFetch(oauth, account, `/api/accounts/${account.zohoAccountId}/messages/view?folderId=${inboxId}&start=${start}&limit=${pageSize}`);
    const j = await r.json().catch(() => ({}));
    if (!j.data || !j.data.length) break;
    for (const m of j.data) {
      const row = mapMessage(account, m);
      const n = Number(m.messageId);
      row.uid = Number.isSafeInteger(n) ? n : row.dateMs;
      out.push(row);
    }
    if (j.data.length < pageSize) break;
  }
  out.sort((a, b) => b.dateMs - a.dateMs);
  return out.slice(0, limit);
}

// Whole-mailbox search (all folders) via Zoho's server-side search. Returns query
// matches or nothing — never an inbox dump (same contract as the IMAP backend).
// searchKey uses the documented "entire:<term>" form (subject + content + people);
// the colon stays literal, only the term is URL-encoded.
async function searchAll(oauth, account, { query = "", cap = 500 } = {}) {
  const q = String(query || "").trim();
  if (!q) return [];
  const pageSize = 200;
  const out = [];
  for (let start = 1; out.length < cap; start += pageSize) {
    const r = await apiFetch(oauth, account, `/api/accounts/${account.zohoAccountId}/messages/search?searchKey=entire:${encodeURIComponent(q)}&start=${start}&limit=${pageSize}`);
    const j = await r.json().catch(() => ({}));
    if (!j.data || !j.data.length) break;
    out.push(...j.data.map((m) => mapMessage(account, m)));
    if (j.data.length < pageSize) break;
  }
  out.sort((a, b) => b.dateMs - a.dateMs);
  return out.slice(0, cap);
}

// ── Write wrappers (match lib/imap.js signatures; need ZohoMail write scope) ──
// Drag-and-drop / filing: move specific messages into a named user folder.
async function moveToFolder(oauth, account, messageIds, folderName) {
  const dest = await ensureFolder(oauth, account, folderName);
  if (!dest) throw new Error(`Could not resolve folder "${folderName}".`);
  if (messageIds && messageIds.length) await moveMessages(oauth, account, messageIds, dest);
  return { ok: true };
}

// File matching senders' INBOX mail into `name`. INBOX-only (like the IMAP backend,
// CLEANUP_SCOPE = ["INBOX"]) — filing organizes the inbox, it never reaches back
// into mail you've already foldered elsewhere. Matches by exact address or domain.
async function fileBySenders(oauth, account, { name, addresses = [], domains = [] }) {
  const dest = await ensureFolder(oauth, account, name);
  if (!dest) return { filed: 0, folder: name };
  const addr = new Set((addresses || []).map((a) => String(a).toLowerCase()).filter(Boolean));
  const doms = (domains || []).map((d) => String(d).toLowerCase().replace(/^@/, "")).filter(Boolean);
  if (!addr.size && !doms.length) return { filed: 0, folder: name };
  const inbox = await inboxForScan(oauth, account, { limit: 4000 });
  const ids = inbox.filter((m) => {
    const e = String(m.fromEmail || "").toLowerCase();
    if (!e) return false;
    if (addr.has(e)) return true;
    const dom = e.split("@")[1] || "";
    return doms.some((d) => dom === d || dom.endsWith("." + d));
  }).map((m) => m.messageId);
  let filed = 0;
  if (ids.length) { await moveMessages(oauth, account, ids, dest); filed = ids.length; }
  return { filed, folder: name };
}

// Undo an auto-file: move everything in `name` back to INBOX, then delete the
// (now-empty, auto-created) folder. Lossless — nothing is trashed.
async function unfileToInbox(oauth, account, { name }) {
  const src = await resolveFolder(oauth, account, name);
  const inboxId = await resolveFolder(oauth, account, "inbox");
  if (!src || !inboxId || src === inboxId) return { moved: 0 };
  // Drain the folder COMPLETELY before deleting it — re-fetch each round, because
  // deleting a non-empty folder sends the leftover mail to Trash. Stop only when a
  // round returns nothing.
  let moved = 0;
  for (let guard = 0; guard < 500; guard++) {
    const msgs = await listFolder(oauth, account, src, 200);
    if (!msgs.length) break;
    await moveMessages(oauth, account, msgs.map((m) => m.messageId), inboxId);
    moved += msgs.length;
  }
  try {
    await apiFetch(oauth, account, `/api/accounts/${account.zohoAccountId}/folders/${src}`, { method: "DELETE" });
    delete folderCache[account.id];
  } catch {}
  return { moved };
}

// Account-wide sender tally for the AI organizer. Excludes system folders
// (trash/spam/sent/etc.). No List-Unsubscribe data — Zoho's message view omits
// headers — so hasUnsub is always false, which is why the header-driven Clean-up
// feature stays Yahoo-only by design (the renderer gates it on that capability).
// INBOX-only sender tally (matches the IMAP backend's CLEANUP_SCOPE = ["INBOX"]).
// Feeds the theme-folder matcher and Clean up — both organize the inbox, so they
// must not surface senders whose mail is already foldered elsewhere.
async function accountSenderTally(oauth, account, { minCount = 3, top = 400, onProgress } = {}) {
  const inboxId = await resolveFolder(oauth, account, "inbox");
  if (!inboxId) return { senders: [], excluded: 0 };
  const map = new Map();
  let scanned = 0;
  const pageSize = 200, MAX = 6000;
  for (let start = 1; scanned < MAX; start += pageSize) {
    const r = await apiFetch(oauth, account, `/api/accounts/${account.zohoAccountId}/messages/view?folderId=${inboxId}&start=${start}&limit=${pageSize}`);
    const j = await r.json().catch(() => ({}));
    if (!j.data || !j.data.length) break;
    for (const raw of j.data) {
      scanned++;
      const m = mapMessage(account, raw);
      const email = String(m.fromEmail || "").toLowerCase();
      if (!email) continue;
      let e = map.get(email);
      if (!e) { e = { name: m.fromName || email, count: 0, sampleSubject: m.subject || "", sampleMailbox: String(m.folderId || ""), sampleUid: m.messageId, subjects: [] }; map.set(email, e); }
      e.count++;
      if (m.subject) { e.subjects.push(m.subject); if (e.subjects.length > 8) e.subjects.shift(); }
    }
    if (onProgress) onProgress(scanned);
    if (j.data.length < pageSize) break;
  }
  const arr = [...map.entries()].filter(([, e]) => e.count >= minCount).sort((a, b) => b[1].count - a[1].count);
  const kept = arr.slice(0, top);
  return {
    senders: kept.map(([email, e]) => ({ email, name: e.name, count: e.count, sampleSubject: e.sampleSubject, sampleMailbox: e.sampleMailbox, sampleUid: e.sampleUid, subjects: e.subjects, hasUnsub: false })),
    excluded: Math.max(0, arr.length - kept.length),
  };
}

// Sidebar folders = every top-level, non-system folder. Zoho tags user folders as
// folderType "Inbox", so we exclude the canonical system folders by NAME (plus any
// nested/system-typed folder, e.g. trashed ones under /Trash). No cheap per-folder
// unread count on Zoho → unread:0.
const SYS_FOLDER_NAMES = new Set(["inbox", "drafts", "templates", "snoozed", "sent", "spam", "junk", "trash", "outbox", "archive"]);
async function listUserFolders(oauth, account) {
  const folders = await getFolders(oauth, account);
  return folders
    .filter((f) => isTopLevel(f) && !f.HIDE)
    .filter((f) => !SYS_FOLDER_NAMES.has(String(f.folderName || "").toLowerCase()))
    .filter((f) => !["trash", "spam", "sent", "drafts", "outbox", "archive", "templates", "snoozed"].includes(String(f.folderType || "").toLowerCase()))
    .map((f) => ({ name: f.folderName, unread: 0 }));
}

// Real unread count for the /Inbox folder (sampled — caps at 200, enough for a badge).
async function inboxUnread(oauth, account) {
  try {
    const inboxId = await resolveFolder(oauth, account, "inbox");
    if (!inboxId) return null;
    const r = await apiFetch(oauth, account, `/api/accounts/${account.zohoAccountId}/messages/view?folderId=${inboxId}&limit=200`);
    const j = await r.json().catch(() => ({}));
    return (j.data || []).filter((m) => String(m.status) === "0").length;
  } catch { return null; }
}

// Keeper-flow junk sweep: move ids to Trash, returning them for a precise undo.
async function trashByIds(oauth, account, { messageIds = [] } = {}) {
  if (!messageIds.length) return { trashed: 0, undo: { uids: [] } };
  const trash = await resolveFolder(oauth, account, "trash");
  if (!trash) throw new Error('No "Trash" folder found — reconnect with folder write scope.');
  await moveMessages(oauth, account, messageIds, trash);
  return { trashed: messageIds.length, undo: { uids: messageIds.map(String) } };
}
// Undo a junk sweep: move the same ids back to INBOX.
async function restoreIds(oauth, account, { uids = [] } = {}) {
  if (!uids.length) return { restored: 0 };
  const inbox = await resolveFolder(oauth, account, "inbox");
  if (!inbox) throw new Error('No "Inbox" folder found.');
  await moveMessages(oauth, account, uids, inbox);
  return { restored: uids.length };
}

// ── Clean up: bulk unsubscribe + purge-to-Trash (needs write scope) ───────────
// Probe one sample message's headers for List-Unsubscribe. The cleanup flow calls
// this per sender with the sender's sample {mailbox: folderId, uid: messageId}.
// Zoho's `messages/view` omits headers, but the per-message /header endpoint
// returns the full raw header block in data.headerContent — so we parse that.
async function probeUnsubscribe(oauth, account, { mailbox, uid } = {}) {
  try {
    if (!mailbox || !uid) return { tier: "none" };
    const r = await apiFetch(oauth, account, `/api/accounts/${account.zohoAccountId}/folders/${mailbox}/messages/${uid}/header`);
    const j = await r.json().catch(() => ({}));
    const raw = (j.data && j.data.headerContent) || "";
    return parseUnsub(raw);
  } catch { return { tier: "none" }; }
}

// RFC 8058 one-click unsubscribe — provider-agnostic HTTP POST.
function unsubscribeOneClick(_oauth, _account, { postUrl } = {}) {
  return oneClickPost({ postUrl });
}

// Mailto unsubscribes — sent through the account's own Zoho send API (no SMTP, so
// none of the Yahoo auth-throttle handling the IMAP path needs).
async function sendUnsubscribeMailtos(oauth, account, items = []) {
  if (!items.length) return { sent: 0, failed: [] };
  let sent = 0;
  const failed = [];
  for (const it of items) {
    const [addr, query] = String(it.mailto || "").split("?");
    if (!addr) { failed.push({ vendor: it.vendor, error: "no address" }); continue; }
    const subject = new URLSearchParams(query || "").get("subject") || "unsubscribe";
    try { await sendMail(oauth, account, { to: addr, subject, body: "unsubscribe" }); sent++; }
    catch (e) { failed.push({ vendor: it.vendor, error: e.message }); }
  }
  return { sent, failed };
}

// Purge: move INBOX mail from the ruled senders (exact address) to Trash.
async function purgeMany(oauth, account, { rules = [] } = {}) {
  const { match, empty } = buildSenderMatcher(rules);
  if (empty) return { trashed: 0, perMailbox: [] };
  const trash = await resolveFolder(oauth, account, "trash");
  if (!trash) throw new Error("No Trash folder on this account.");
  const inbox = await inboxForScan(oauth, account, { limit: 6000 });
  const ids = inbox.filter((m) => match(m.fromEmail)).map((m) => m.messageId);
  if (!ids.length) return { trashed: 0, perMailbox: [] };
  await moveMessages(oauth, account, ids, trash);
  return { trashed: ids.length, perMailbox: [`INBOX:${ids.length}`] };
}

// Undo a purge: move the ruled senders' mail from Trash back to INBOX.
async function undoMany(oauth, account, { rules = [] } = {}) {
  const { match, empty } = buildSenderMatcher(rules);
  if (empty) return { restored: 0 };
  const trash = await resolveFolder(oauth, account, "trash");
  const inbox = await resolveFolder(oauth, account, "inbox");
  if (!trash || !inbox) return { restored: 0 };
  const msgs = await listFolder(oauth, account, trash, 6000);
  const ids = msgs.filter((m) => match(m.fromEmail)).map((m) => m.messageId);
  if (!ids.length) return { restored: 0 };
  await moveMessages(oauth, account, ids, inbox);
  return { restored: ids.length };
}

module.exports = { exchangeGrant, discoverAccount, clearAccountCache, getAvatar, listInbox, listMany, listPage, getContent, getAttachment, sendMail, send: sendMail, move, markRead, listFolderByKind, resolveFolder, ensureFolder, moveMessages, listFolder, parseFrom, fmtTime, inboxForScan, searchAll, moveToFolder, fileBySenders, unfileToInbox, accountSenderTally, trashByIds, restoreIds, probeUnsubscribe, unsubscribeOneClick, sendUnsubscribeMailtos, purgeMany, undoMany, listUserFolders, inboxUnread };
