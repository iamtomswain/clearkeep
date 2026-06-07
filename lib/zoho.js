"use strict";

/* Zoho Mail REST API client (free-plan compatible — no IMAP).
   Pure Node (no Electron deps) so it can be unit-tested directly.
   US data center. OAuth2: a shared self-client (clientId/secret) + a per-account
   refresh token → short-lived access tokens (cached in-memory, 1h). */

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

async function listInbox(oauth, account, limit = 50) {
  const r = await apiFetch(oauth, account, `/api/accounts/${account.zohoAccountId}/messages/view?limit=${limit}`);
  const j = await r.json().catch(() => ({}));
  if (!j.data) throw new Error("Could not list messages: " + JSON.stringify(j).slice(0, 200));
  const ex = await excludedIds(oauth, account);
  let msgs = j.data.map((m) => mapMessage(account, m));
  if (ex.size) msgs = msgs.filter((m) => !ex.has(String(m.folderId)));
  return msgs;
}

// Deep paginated scan across the mailbox (for the AI organize / back-scan).
async function listMany(oauth, account, total = 400) {
  const pageSize = 200;
  const out = [];
  for (let start = 1; out.length < total + 200; start += pageSize) {
    const r = await apiFetch(oauth, account, `/api/accounts/${account.zohoAccountId}/messages/view?limit=${pageSize}&start=${start}`);
    const j = await r.json().catch(() => ({}));
    if (!j.data || !j.data.length) break;
    out.push(...j.data.map((m) => mapMessage(account, m)));
    if (j.data.length < pageSize) break;
  }
  const ex = await excludedIds(oauth, account);
  let res = ex.size ? out.filter((m) => !ex.has(String(m.folderId))) : out;
  return res.slice(0, total);
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
function folderIdByKind(folders, kind) {
  const names = KIND_ALIASES[kind.toLowerCase()] || [kind.toLowerCase()];
  const f = folders.find((x) => {
    const name = String(x.folderName || x.path || "").toLowerCase().replace(/^\//, "");
    const type = String(x.folderType || "").toLowerCase();
    return names.includes(name) || names.includes(type);
  });
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
async function moveMessages(oauth, account, messageIds, destFolderId) {
  const r = await apiFetch(oauth, account, `/api/accounts/${account.zohoAccountId}/updatemessage`, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ mode: "moveMessage", messageId: messageIds.map(String), destfolderId: String(destFolderId) }),
  });
  const j = await r.json().catch(() => ({}));
  if (j.status && j.status.code && Number(j.status.code) !== 200) throw new Error(j.status.description || `Move failed (${j.status.code})`);
  return { ok: true };
}
// Mark messages read/unread (needs write scope: ZohoMail.messages.ALL/UPDATE —
// fails on the read-only plan token).
async function markRead(oauth, account, messageIds, read) {
  const r = await apiFetch(oauth, account, `/api/accounts/${account.zohoAccountId}/updatemessage`, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ mode: read ? "markAsRead" : "markAsUnread", messageId: messageIds.map(String) }),
  });
  const j = await r.json().catch(() => ({}));
  if (j.status && j.status.code && Number(j.status.code) !== 200) throw new Error(j.status.description || `Read-state update failed (${j.status.code})`);
  return { ok: true };
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
  let qs = `start=${start}&limit=${limit}`;
  if (scope !== "inbox") {
    const fid = await resolveFolder(oauth, account, scope);
    if (!fid) return { messages: [], nextCursor: null, error: `No "${scope}" folder` };
    qs += `&folderId=${fid}`;
  }
  const r = await apiFetch(oauth, account, `/api/accounts/${account.zohoAccountId}/messages/view?${qs}`);
  const j = await r.json().catch(() => ({}));
  const messages = (j.data || []).map((m) => mapMessage(account, m));
  const nextCursor = messages.length >= limit ? start + limit : null;
  return { messages, nextCursor };
}

async function listFolder(oauth, account, folderId, limit = 100) {
  const r = await apiFetch(oauth, account, `/api/accounts/${account.zohoAccountId}/messages/view?folderId=${folderId}&limit=${limit}`);
  const j = await r.json().catch(() => ({}));
  return (j.data || []).map((m) => mapMessage(account, m));
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

module.exports = { exchangeGrant, discoverAccount, clearAccountCache, getAvatar, listInbox, listMany, listPage, getContent, getAttachment, sendMail, send: sendMail, move, markRead, listFolderByKind, resolveFolder, ensureFolder, moveMessages, listFolder, parseFrom, fmtTime };
