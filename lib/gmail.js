"use strict";

/* Gmail backend — Gmail REST API over OAuth2 ("Sign in with Google").
   Same interface shape as lib/zoho.js so the main dispatcher can treat
   providers uniformly. Pure Node (fetch). oauth = {clientId, clientSecret};
   account = {id, address, refreshToken}. */

const BASE = "https://gmail.googleapis.com/gmail/v1/users/me";
const TOKEN_URL = "https://oauth2.googleapis.com/token";
const SCOPES = ["https://www.googleapis.com/auth/gmail.modify", "https://www.googleapis.com/auth/gmail.send"];

const tokenCache = {};

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
function clearAccountCache(id) { delete tokenCache[id]; }
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
        inline: disp.startsWith("inline") || (!!contentId && !disp.startsWith("attachment")),
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
async function searchIds(oauth, account, q) {
  const ids = []; let pageToken = null;
  do {
    let p = `/messages?q=${encodeURIComponent(q)}&maxResults=500`;
    if (pageToken) p += `&pageToken=${pageToken}`;
    const r = await api(oauth, account, p);
    const j = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error("Search failed: " + (j.error && j.error.message ? j.error.message : r.status));
    (j.messages || []).forEach((m) => ids.push(m.id));
    pageToken = j.nextPageToken || null;
  } while (pageToken);
  return ids;
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

// No account-photo source yet (the granted scope is gmail.modify + gmail.send,
// which can't read the Google profile photo). Null → generic avatar fallback.
async function getAvatar() { return null; }

module.exports = {
  buildAuthUrl, exchangeCode, getProfile, clearAccountCache, getAvatar,
  listInbox, listMany, listPage, getContent, getAttachment, send, move, markRead, listFolderByKind,
  fileBySenders, unfileToInbox, ensureLabel, listUserFolders, inboxUnread,
};
