"use strict";

/* Yahoo (and any IMAP/SMTP) backend — same interface shape as lib/gmail.js so
   the dispatcher treats providers uniformly. Yahoo has no Gmail-style REST API,
   so this speaks IMAP (imapflow) for reading + SMTP (nodemailer) for sending,
   authenticated with a Yahoo **app password** (not OAuth).
   oauth arg is ignored (null for this provider).
   account = { id, address, password, imapHost, imapPort, smtpHost, smtpPort }. */

const { ImapFlow } = require("imapflow");
const { simpleParser } = require("mailparser");
const nodemailer = require("nodemailer");
const MailComposer = require("nodemailer/lib/mail-composer");
const https = require("https");
const http = require("http");

const SEP = "␟"; // mailbox¦uid separator inside messageId (won't occur in paths)

function fmtTime(ms) {
  if (!ms) return "";
  const d = new Date(Number(ms)), now = new Date();
  if (d.toDateString() === now.toDateString()) return d.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
  const y = new Date(now); y.setDate(now.getDate() - 1);
  if (d.toDateString() === y.toDateString()) return "Yesterday";
  if ((now - d) / 86400000 < 7) return d.toLocaleDateString([], { weekday: "short" });
  return d.toLocaleDateString([], { month: "short", day: "numeric" });
}
function addrList(arr) {
  return (arr || []).map((a) => (a.name ? `${a.name} <${a.address}>` : a.address)).filter(Boolean).join(", ");
}
function oneAddr(arr) {
  const a = (arr || [])[0];
  return a ? { name: a.name || a.address || "", email: (a.address || "").toLowerCase() } : { name: "", email: "" };
}
function imapRef(messageId) {
  const i = String(messageId).lastIndexOf(SEP);
  return i < 0 ? { mailbox: "INBOX", uid: messageId } : { mailbox: messageId.slice(0, i), uid: messageId.slice(i + SEP.length) };
}

// ── Connection pool (one live IMAP client per account, reconnected if dropped) ─
const pool = {};
async function getClient(account) {
  const existing = pool[account.id];
  if (existing && existing.usable) return existing;
  const client = new ImapFlow({
    host: account.imapHost || "imap.mail.yahoo.com",
    port: account.imapPort || 993,
    secure: true,
    auth: { user: account.address, pass: account.password },
    logger: false,
    emitLogs: false,
  });
  client.on("error", () => {}); // swallow; we reconnect on next use
  await client.connect();
  pool[account.id] = client;
  return client;
}
async function withMailbox(account, mailbox, fn) {
  let client;
  try {
    client = await getClient(account);
    const lock = await client.getMailboxLock(mailbox);
    try { return await fn(client); }
    finally { lock.release(); }
  } catch (err) {
    // Drop a poisoned connection so the next call reconnects cleanly.
    try { if (client) await client.logout(); } catch {}
    delete pool[account.id];
    throw err;
  }
}
function clearAccountCache(id) {
  const c = pool[id];
  if (c) { try { c.logout(); } catch {} delete pool[id]; }
  delete folderCache[id];
}

// ── Folder resolution (special-use first, then common names) ──────────────────
const KIND_USE = { Archive: "\\Archive", Sent: "\\Sent", Trash: "\\Trash", Spam: "\\Junk", Drafts: "\\Drafts" };
const KIND_NAMES = {
  Archive: ["archive"],
  Sent: ["sent", "sent items", "sent mail"],
  Trash: ["trash", "deleted", "bin", "deleted items"],
  Spam: ["spam", "junk", "bulk", "bulk mail"],
  inbox: ["inbox"],
};
const folderCache = {};
async function listFolders(account) {
  if (folderCache[account.id]) return folderCache[account.id];
  const client = await getClient(account);
  const folders = await client.list();
  folderCache[account.id] = folders;
  return folders;
}
async function resolveMailbox(account, kind) {
  if (kind === "inbox" || kind === "INBOX") return "INBOX";
  const folders = await listFolders(account);
  const use = KIND_USE[kind];
  let f = use && folders.find((x) => x.specialUse === use);
  if (!f) {
    const names = KIND_NAMES[kind] || [String(kind).toLowerCase()];
    f = folders.find((x) => names.includes(String(x.path).toLowerCase()) || names.includes(String(x.name || "").toLowerCase()));
  }
  return f ? f.path : null;
}
// Create the mailbox if it doesn't exist; return its path.
async function ensureMailbox(account, name) {
  const existing = await resolveMailbox(account, name);
  if (existing) return existing;
  const client = await getClient(account);
  try { await client.mailboxCreate(name); } catch { /* race / already exists */ }
  delete folderCache[account.id];
  return (await resolveMailbox(account, name)) || name;
}

// ── Server-side filing: move matching INBOX mail into a real folder ───────────
// senders rule = { addresses[], domains[] }. We IMAP-SEARCH the INBOX FROM each
// term and MOVE the matches into the folder. Returns how many moved.
async function fileBySenders(_oauth, account, { name, addresses = [], domains = [] }) {
  const dest = await ensureMailbox(account, name);
  if (dest === "INBOX") return { filed: 0, folder: dest };
  const terms = [...new Set([...(addresses || []), ...(domains || [])])].filter(Boolean);
  if (!terms.length) return { filed: 0, folder: dest };
  let filed = 0;
  await withMailbox(account, "INBOX", async (client) => {
    const uids = new Set();
    for (const term of terms) {
      try { (await client.search({ from: term }, { uid: true }) || []).forEach((u) => uids.add(u)); } catch {}
    }
    const list = [...uids];
    if (list.length) filed = await moveInBatches(client, list, dest); // batched — Yahoo silently caps a single big MOVE
  });
  return { filed, folder: dest };
}
// Undo / remove: move everything back to INBOX, then delete the now-empty folder.
async function unfileToInbox(_oauth, account, { name }) {
  const src = await resolveMailbox(account, name);
  if (!src || src === "INBOX") return { moved: 0 };
  let moved = 0;
  await withMailbox(account, src, async (client) => {
    const uids = await client.search({ all: true }, { uid: true });
    if (uids && uids.length) { await client.messageMove(uids, "INBOX", { uid: true }); moved = uids.length; }
  });
  try { const c = await getClient(account); await c.mailboxDelete(src); delete folderCache[account.id]; } catch {}
  return { moved };
}

// Real user folders on the server (excludes Inbox + system/special-use folders).
const SYS_USE = new Set(["\\Sent", "\\Drafts", "\\Junk", "\\Trash", "\\Archive", "\\All", "\\Flagged", "\\Important"]);
// Yahoo doesn't always set special-use flags, so also exclude by common name.
const SYS_NAMES = new Set(["inbox", "sent", "sent messages", "draft", "drafts", "trash", "bulk mail", "bulk", "junk", "archive", "outbox", "notes"]);
async function listUserFolders(_oauth, account) {
  const client = await getClient(account);
  // LIST-STATUS (RFC 5819) fetches every folder's unread count in one round
  // trip; falls back to no counts if the server doesn't support it.
  let all;
  try { all = await client.list({ statusQuery: { unseen: true } }); }
  catch { all = await client.list(); }
  return all
    .filter((f) => !(f.specialUse && SYS_USE.has(f.specialUse)))
    .filter((f) => !(f.flags && f.flags.has && f.flags.has("\\Noselect")))
    .filter((f) => !SYS_NAMES.has(String(f.path).toLowerCase()) && !SYS_NAMES.has(String(f.name || "").toLowerCase()))
    .map((f) => ({ name: f.path, unread: (f.status && f.status.unseen) || 0 }));
}

// ── Clean up: account-wide sender tally + unsubscribe + purge-to-Trash ────────
// Mailboxes we never scan/purge (your own mail + the Trash we move into).
async function cleanupSkipSet(account) {
  const skip = new Set();
  for (const k of ["Trash", "Sent", "Drafts"]) {
    const p = await resolveMailbox(account, k);
    if (p) skip.add(p);
  }
  return skip;
}
async function scannableMailboxes(account) {
  const all = await listFolders(account);
  const skip = await cleanupSkipSet(account);
  return all
    .filter((f) => f.path && !skip.has(f.path))
    .filter((f) => !(f.flags && f.flags.has && f.flags.has("\\Noselect")))
    .map((f) => f.path);
}

// Tally senders in the INBOX ONLY. Clean up is scoped to the inbox on purpose:
// anything the user has filed into a folder (vendor or theme folders) is thereby
// protected from the purge — foldering = protecting. Keeps a sample (subject +
// mailbox + uid) per sender so we can probe its unsub header.
const CLEANUP_SCOPE = ["INBOX"];
async function accountSenderTally(_oauth, account, { minCount = 3, top = 400, onProgress } = {}) {
  const map = new Map(); // email -> { name, count, sampleSubject, sampleMailbox, sampleUid }
  let scanned = 0;
  for (const mailbox of CLEANUP_SCOPE) {
    await withMailbox(account, mailbox, async (client) => {
      const exists = client.mailbox.exists || 0;
      if (!exists) return;
      // headers:true (full block) — NOT the array form, which imapflow returns empty
      // on Yahoo (see probeUnsubscribe). Headers are cheap vs. bodies; no per-row body fetch.
      for await (const m of client.fetch(`1:${exists}`, { envelope: true, uid: true, headers: true })) {
        if (onProgress && (++scanned % 250 === 0)) onProgress(scanned);
        const env = m.envelope || {};
        const fr = (env.from || [])[0];
        const email = ((fr && fr.address) || "").toLowerCase();
        if (!email) continue;
        let e = map.get(email);
        if (!e) { e = { name: (fr && fr.name) || email, count: 0, sampleSubject: env.subject || "", sampleMailbox: mailbox, sampleUid: m.uid, subjects: [], hasUnsub: false }; map.set(email, e); }
        e.count++;
        // keep a rolling window of the most recent subjects (for the preview popover)
        if (env.subject) { e.subjects.push(env.subject); if (e.subjects.length > 8) e.subjects.shift(); }
        // A List-Unsubscribe header means bulk/marketing mail — the high-recall "this
        // is junk" signal. Mark the sender, point the sample at this message, and keep
        // the raw headers so we can classify the unsub tier without a second fetch.
        const ht = m.headers ? m.headers.toString() : "";
        if (/^list-unsubscribe:/im.test(ht)) {
          e.hasUnsub = true; e.sampleMailbox = mailbox; e.sampleUid = m.uid; e.unsubHeaders = ht;
          if (env.subject) e.sampleSubject = env.subject;
        }
      }
    });
  }
  if (onProgress) onProgress(scanned);
  // Keep a sender if it's a repeat sender (≥minCount) OR any of its mail carries a
  // List-Unsubscribe header (bulk/marketing — junk regardless of how few it sent).
  const arr = [...map.entries()].filter(([, e]) => e.count >= minCount || e.hasUnsub).sort((a, b) => b[1].count - a[1].count);
  const kept = arr.slice(0, top);
  return {
    // Classify the unsub tier from the headers we already pulled — no second probe.
    senders: kept.map(([email, e]) => ({ email, name: e.name, count: e.count, sampleSubject: e.sampleSubject, sampleMailbox: e.sampleMailbox, sampleUid: e.sampleUid, subjects: e.subjects, hasUnsub: e.hasUnsub, ...(e.unsubHeaders ? parseUnsub(e.unsubHeaders) : {}) })),
    excluded: Math.max(0, arr.length - kept.length), // senders with ≥minCount we didn't keep (logged in the UI)
  };
}

// Parse List-Unsubscribe / List-Unsubscribe-Post into an actionable tier.
// one-click (RFC 8058, safe POST) > link (open the web page — never bounces) >
// mailto (last resort: dead vendor addresses bounce a Failure Notice back) > none.
function parseUnsub(rawHeaders) {
  const text = String(rawHeaders || "");
  const lu = text.match(/^list-unsubscribe:\s*((?:.*(?:\r?\n[ \t].*)*))/im);
  const oneClick = /^list-unsubscribe-post:\s*list-unsubscribe=one-click/im.test(text);
  if (!lu) return { tier: "none" };
  const val = lu[1].replace(/\r?\n[ \t]+/g, " ").trim();
  const urls = [...val.matchAll(/<([^>]+)>/g)].map((m) => m[1].trim());
  const httpsUrl = urls.find((u) => /^https?:\/\//i.test(u));
  const mailto = urls.find((u) => /^mailto:/i.test(u));
  if (httpsUrl && oneClick) return { tier: "one-click", postUrl: httpsUrl };
  if (httpsUrl) return { tier: "link", url: httpsUrl };   // web page, opened in browser — no bounce
  if (mailto) return { tier: "mailto", mailto: mailto.replace(/^mailto:\s*/i, "").trim() };
  return { tier: "none" };
}
// Reject a promise if it doesn't settle in `ms`. Used to bound per-probe fetches
// so one slow Yahoo response can't wedge the whole scan (withMailbox drops the
// poisoned connection on the thrown error, so the next call reconnects cleanly).
function withTimeout(promise, ms, label) {
  let t;
  const timer = new Promise((_, rej) => { t = setTimeout(() => rej(new Error((label || "op") + " timeout")), ms); });
  return Promise.race([promise, timer]).finally(() => clearTimeout(t));
}
// Fetch only the unsubscribe headers of one sample message (one fetch per
// sender, not per message) and classify the tier. Bounded to 8s per probe.
async function probeUnsubscribe(_oauth, account, { mailbox, uid }) {
  try {
    return await withMailbox(account, mailbox, async (client) => {
      // imapflow's `headers: [field…]` array form returns empty on Yahoo, so pull
      // the full header block (PEEK, cheap for one sample) and parse from that.
      const msg = await withTimeout(client.fetchOne(String(uid), { headers: true }, { uid: true }), 8000, "probe");
      const raw = msg && msg.headers ? msg.headers.toString() : "";
      return parseUnsub(raw);
    });
  } catch { return { tier: "none" }; }
}

// One-click unsubscribe (RFC 8058): POST "List-Unsubscribe=One-Click" to the URL.
// We can record that we attempted it — not that it succeeded (no machine receipt).
function unsubscribeOneClick(_oauth, _account, { postUrl } = {}) {
  return new Promise((resolve) => {
    let u; try { u = new URL(postUrl); } catch { return resolve({ ok: false, error: "bad url" }); }
    const mod = u.protocol === "http:" ? http : https;
    const body = "List-Unsubscribe=One-Click";
    const req = mod.request(u, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded", "Content-Length": Buffer.byteLength(body) },
      timeout: 15000,
    }, (res) => { res.resume(); resolve({ ok: res.statusCode >= 200 && res.statusCode < 400, status: res.statusCode }); });
    req.on("error", (e) => resolve({ ok: false, error: e.message }));
    req.on("timeout", () => { req.destroy(); resolve({ ok: false, error: "timeout" }); });
    req.write(body); req.end();
  });
}
// Send MANY mailto-unsubscribes over ONE pooled SMTP connection (single login,
// paced) instead of a fresh login per email. Yahoo rejects rapid per-email logins
// with "535 …Too many bad auth attempts" — pooling avoids that. items = [{vendor, mailto}].
async function sendUnsubscribeMailtos(_oauth, account, items = []) {
  if (!items.length) return { sent: 0, failed: [] };
  const transport = nodemailer.createTransport({
    host: account.smtpHost || "smtp.mail.yahoo.com",
    port: account.smtpPort || 465,
    secure: (account.smtpPort || 465) === 465,
    auth: { user: account.address, pass: account.password },
    pool: true, maxConnections: 1, // one connection, one login, reused for every send
  });
  let sent = 0;
  const failed = [];
  for (let i = 0; i < items.length; i++) {
    const it = items[i];
    const [addr, query] = String(it.mailto || "").split("?");
    if (!addr) { failed.push({ vendor: it.vendor, error: "no address" }); continue; }
    const subject = new URLSearchParams(query || "").get("subject") || "unsubscribe";
    try { await transport.sendMail({ from: account.address, to: addr, subject, text: "unsubscribe" }); sent++; }
    catch (e) {
      failed.push({ vendor: it.vendor, error: e.message });
      // Yahoo auth throttle: stop now — every further login attempt deepens the
      // penalty (and they'd all fail anyway). Mark the rest skipped.
      if (/auth005|too many bad auth/i.test(e.message || "")) {
        for (let j = i + 1; j < items.length; j++) failed.push({ vendor: items[j].vendor, error: "skipped — Yahoo SMTP throttled" });
        break;
      }
    }
    await new Promise((r) => setTimeout(r, 1500)); // gentle pace to stay under Yahoo's rate limit
  }
  try { transport.close(); } catch {}
  return { sent, failed };
}

// Scan the unsubscribe tier for a BATCH of already-listed messages (e.g. the
// rows visible in the UI), one header fetch per mailbox. The list fetch only
// pulls envelopes, so this is how a row learns whether it can be unsubscribed.
// Returns { [messageId]: {tier, postUrl?|mailto?|url?} } — tier "none" included
// so the caller can mark a row scanned and not re-probe it.
async function unsubScan(_oauth, account, { messageIds = [] } = {}) {
  const out = {};
  for (const [mailbox, uids] of groupByMailbox(messageIds)) {
    if (!uids.length) continue;
    try {
      await withMailbox(account, mailbox, async (client) => {
        // headers:true (full block) — the `headers:[field]` array form returns
        // empty on Yahoo (see probeUnsubscribe). PEEK, so rows stay unread.
        for await (const msg of client.fetch(uids, { uid: true, headers: true }, { uid: true })) {
          const raw = msg && msg.headers ? msg.headers.toString() : "";
          out[`${mailbox}${SEP}${msg.uid}`] = parseUnsub(raw);
        }
      });
    } catch {} // a bad mailbox/connection just leaves those rows unscanned
  }
  return out;
}

// Fire a single headless unsubscribe for one row. one-click = RFC 8058 POST;
// mailto = one pooled SMTP send (best-effort — Yahoo may throttle). The "link"
// tier is intentionally NOT headless (the UI opens it in a browser instead).
async function unsubscribeOne(_oauth, account, { tier, postUrl, mailto, vendor } = {}) {
  if (tier === "one-click" && postUrl) return unsubscribeOneClick(_oauth, account, { postUrl });
  if (tier === "mailto" && mailto) {
    const r = await sendUnsubscribeMailtos(_oauth, account, [{ vendor: vendor || "sender", mailto }]);
    return { ok: (r.sent || 0) > 0, error: (r.failed && r.failed[0] && r.failed[0].error) || null };
  }
  return { ok: false, error: "not a headless unsubscribe tier" };
}

// Build a fast local sender-matcher from many vendor rules at once. Matching is
// done on the parsed From *address* (exact address, or its domain / a subdomain
// of a rule domain) — more precise than an IMAP substring SEARCH, which also hit
// display names. Returns { match(email), empty }.
function buildSenderMatcher(rules) {
  const addrs = new Set(), domains = new Set();
  for (const r of rules || []) {
    (r.addresses || []).forEach((a) => a && addrs.add(String(a).toLowerCase()));
    (r.domains || []).forEach((d) => d && domains.add(String(d).toLowerCase()));
  }
  const domList = [...domains];
  const match = (email) => {
    if (!email) return false;
    email = email.toLowerCase();
    if (addrs.has(email)) return true;
    const at = email.lastIndexOf("@");
    if (at < 0) return false;
    const dom = email.slice(at + 1);
    for (const d of domList) if (dom === d || dom.endsWith("." + d)) return true;
    return false;
  };
  return { match, empty: !addrs.size && !domains.size };
}
// Move matched UIDs to `dest` in provider-safe batches (one big list can overrun
// the command-line limit). Returns how many moved.
async function moveInBatches(client, uids, dest) {
  for (let i = 0; i < uids.length; i += 200) {
    await client.messageMove(uids.slice(i, i + 200), dest, { uid: true });
  }
  return uids.length;
}

// Move SPECIFIC messages (by id) to Trash, batched (Yahoo silently caps big
// MOVEs). Captures the destination Trash UIDs from the server's COPYUID map so we
// can undo exactly these messages later (not an address re-match). Used by the
// "Find important" clutter-clear. messageIds = ["INBOX␟uid", …].
async function trashByIds(_oauth, account, { messageIds = [] } = {}) {
  const trash = await resolveMailbox(account, "Trash");
  if (!trash) throw new Error("No Trash folder on this account.");
  let trashed = 0;
  const undoUids = []; // destination (Trash) UIDs, for a precise undo
  for (const [mailbox, uids] of groupByMailbox(messageIds)) {
    if (mailbox === trash || !uids.length) continue;
    await withMailbox(account, mailbox, async (client) => {
      for (let i = 0; i < uids.length; i += 200) {
        const batch = uids.slice(i, i + 200);
        const res = await client.messageMove(batch, trash, { uid: true });
        trashed += batch.length;
        const map = res && res.uidMap;
        if (map) {
          if (typeof map.values === "function") for (const v of map.values()) undoUids.push(String(v));
          else for (const k of Object.keys(map)) undoUids.push(String(map[k]));
        }
      }
    });
  }
  delete folderCache[account.id];
  return { trashed, undo: { uids: undoUids } };
}
// Undo a clutter-clear: move exactly those Trash UIDs back to the INBOX.
async function restoreIds(_oauth, account, { uids = [] } = {}) {
  if (!uids.length) return { restored: 0 };
  const trash = await resolveMailbox(account, "Trash");
  if (!trash) return { restored: 0 };
  let restored = 0;
  await withMailbox(account, trash, async (client) => {
    restored = await moveInBatches(client, uids.map(String), "INBOX");
  });
  delete folderCache[account.id];
  return { restored };
}
// ONE-PASS purge for MANY vendors, scoped to the INBOX only (foldered mail is
// protected — see CLEANUP_SCOPE). Sweeps the inbox once (bulk envelope fetch),
// matches every message against the combined rule set locally, and moves the hits
// to Trash. rules = array of { addresses, domains }. Returns { trashed, perMailbox }.
async function purgeMany(_oauth, account, { rules = [] } = {}) {
  const trash = await resolveMailbox(account, "Trash");
  if (!trash) throw new Error("No Trash folder on this account.");
  const { match, empty } = buildSenderMatcher(rules);
  if (empty) return { trashed: 0, perMailbox: [] };
  let trashed = 0;
  const perMailbox = [];
  for (const mailbox of CLEANUP_SCOPE) {
    if (mailbox === trash) continue;
    await withMailbox(account, mailbox, async (client) => {
      const exists = client.mailbox.exists || 0;
      if (!exists) return;
      const toMove = [];
      for await (const m of client.fetch(`1:${exists}`, { envelope: true, uid: true })) {
        const fr = ((m.envelope && m.envelope.from) || [])[0];
        if (match((fr && fr.address) || "")) toMove.push(m.uid);
      }
      if (toMove.length) { await moveInBatches(client, toMove, trash); trashed += toMove.length; perMailbox.push(`${mailbox}:${toMove.length}`); }
    });
  }
  delete folderCache[account.id];
  return { trashed, perMailbox };
}
// Undo: one pass over Trash, move matched mail back to the inbox.
async function undoMany(_oauth, account, { rules = [] } = {}) {
  const trash = await resolveMailbox(account, "Trash");
  if (!trash) return { restored: 0 };
  const { match, empty } = buildSenderMatcher(rules);
  if (empty) return { restored: 0 };
  let restored = 0;
  await withMailbox(account, trash, async (client) => {
    const exists = client.mailbox.exists || 0;
    if (!exists) return;
    const toMove = [];
    for await (const m of client.fetch(`1:${exists}`, { envelope: true, uid: true })) {
      const fr = ((m.envelope && m.envelope.from) || [])[0];
      if (match((fr && fr.address) || "")) toMove.push(m.uid);
    }
    if (toMove.length) restored = await moveInBatches(client, toMove, "INBOX");
  });
  return { restored };
}

// Collapse ALL user folders back into the inbox: move each folder's mail to
// INBOX, then delete the (now-empty) folder. Lossless reversal of auto-organize.
// Deletes deepest-first so a parent isn't removed before its children. Per-folder
// try/catch so one failure doesn't abort the sweep.
async function collapseAllFolders(_oauth, account, { onProgress } = {}) {
  const userFolders = await listUserFolders(null, account); // [{ name, unread }]
  const depth = (p) => (String(p).match(/\//g) || []).length; // "/" is the IMAP hierarchy delimiter
  const ordered = userFolders.slice().sort((a, b) => depth(b.name) - depth(a.name));
  const total = ordered.length;
  let moved = 0, deleted = 0, i = 0;
  const failed = [];
  for (const f of ordered) {
    i++;
    let ok = false;
    try {
      await withMailbox(account, f.name, async (client) => {
        const uids = await client.search({ all: true }, { uid: true });
        if (uids && uids.length) moved += await moveInBatches(client, uids, "INBOX");
      });
      const c = await getClient(account);
      await c.mailboxDelete(f.name);
      deleted++; ok = true;
    } catch (e) { failed.push({ folder: f.name, error: e.message }); }
    // Report after each folder so the UI can shrink the sidebar + show a count.
    // `folder` is the name just removed (null if it failed, so the UI keeps it).
    if (onProgress) { try { onProgress({ done: i, total, moved, deleted, folder: ok ? f.name : null }); } catch {} }
  }
  delete folderCache[account.id];
  return { deleted, moved, failed, total };
}

// ── Mapping ───────────────────────────────────────────────────────────────────
function mapMsg(account, mailbox, msg) {
  const env = msg.envelope || {};
  const f = oneAddr(env.from);
  const dateMs = msg.internalDate ? new Date(msg.internalDate).getTime()
    : (env.date ? new Date(env.date).getTime() : 0);
  const flags = msg.flags || new Set();
  return {
    id: `${account.id}:${mailbox}:${msg.uid}`,
    account: account.id,
    messageId: `${mailbox}${SEP}${msg.uid}`,
    folderId: mailbox,
    fromName: f.name || f.email,
    fromEmail: f.email,
    to: addrList(env.to),
    cc: addrList(env.cc),
    subject: env.subject || "(no subject)",
    snippet: "", // IMAP previews are costly to fetch per-row; the reader shows the full body
    dateMs,
    time: fmtTime(dateMs),
    unread: !flags.has("\\Seen"),
  };
}

// ── Listing / pagination ──────────────────────────────────────────────────────
// Newest-first by sequence number; cursor = how many we've already taken off the
// top. nextCursor advances until we reach sequence 1.
async function listPage(_oauth, account, { scope = "inbox", cursor, limit = 50 }) {
  const mailbox = await resolveMailbox(account, scope);
  if (!mailbox) return { messages: [], nextCursor: null, error: `No "${scope}" folder` };
  return withMailbox(account, mailbox, async (client) => {
    const total = client.mailbox.exists || 0;
    const offset = Number(cursor) || 0;
    const hi = total - offset;
    if (hi < 1) return { messages: [], nextCursor: null };
    const lo = Math.max(1, hi - limit + 1);
    const out = [];
    for await (const msg of client.fetch(`${lo}:${hi}`, { envelope: true, flags: true, internalDate: true, uid: true })) {
      out.push(mapMsg(account, mailbox, msg));
    }
    out.sort((a, b) => b.dateMs - a.dateMs); // newest first
    const taken = hi - lo + 1;
    return { messages: out, nextCursor: lo > 1 ? offset + taken : null };
  });
}
async function listInbox(_oauth, account, limit = 50) {
  return (await listPage(null, account, { scope: "inbox", cursor: null, limit })).messages;
}
async function inboxUnread(_oauth, account) {
  try { const client = await getClient(account); return (await client.status("INBOX", { unseen: true })).unseen || 0; }
  catch { return null; }
}
// Tally senders across the WHOLE server inbox (one bulk envelope fetch), so the
// AI organizer sees every repeat vendor — not just what's loaded in the UI.
// Returns "email (Name) ×N" strings for the top senders with ≥2 emails.
async function inboxSenderTally(_oauth, account, { limit = 4000, top = 150 } = {}) {
  const map = new Map();
  await withMailbox(account, "INBOX", async (client) => {
    const exists = client.mailbox.exists || 0;
    if (!exists) return;
    const lo = Math.max(1, exists - limit + 1);
    for await (const m of client.fetch(`${lo}:${exists}`, { envelope: true })) {
      const f = ((m.envelope && m.envelope.from) || [])[0];
      const email = ((f && f.address) || "").toLowerCase();
      if (!email) continue;
      const e = map.get(email) || { name: (f.name || email), count: 0 };
      e.count++; map.set(email, e);
    }
  });
  return [...map.entries()]
    .filter(([, e]) => e.count >= 2)
    .sort((a, b) => b[1].count - a[1].count)
    .slice(0, top)
    .map(([email, e]) => `${email} (${e.name}) ×${e.count}`);
}
// One bulk envelope pass over the whole INBOX → lightweight rows for the
// "Find important" keeper-finder (sender + subject only; no bodies, no per-row
// fetch). Newest first. Cheap: a single fetch like inboxSenderTally.
async function inboxForScan(_oauth, account, { limit = 6000 } = {}) {
  const out = [];
  await withMailbox(account, "INBOX", async (client) => {
    const exists = client.mailbox.exists || 0;
    if (!exists) return;
    const lo = Math.max(1, exists - limit + 1);
    for await (const m of client.fetch(`${lo}:${exists}`, { envelope: true, internalDate: true, flags: true, uid: true })) {
      out.push({ ...mapMsg(account, "INBOX", m), uid: m.uid }); // full row + raw uid (for the Important UID cursor)
    }
  });
  out.sort((a, b) => b.dateMs - a.dateMs);
  return out;
}
async function listMany(_oauth, account, total = 400) {
  // Pull up to `total` newest inbox messages across as many pages as needed.
  const all = [];
  let cursor = null;
  do {
    const page = await listPage(null, account, { scope: "inbox", cursor, limit: Math.min(100, total - all.length) });
    all.push(...page.messages);
    cursor = page.nextCursor;
  } while (cursor && all.length < total);
  return all;
}
// Whole-mailbox search: server-side IMAP SEARCH across EVERY selectable mailbox
// (Inbox, Sent, Archive, Spam, Trash, and every user folder), all dates — not just
// the inbox. TEXT matches headers+body; multi-word queries also union per-word hits
// for recall. Returns mapped message metadata (folder-tagged), newest first, capped.
async function searchAll(_oauth, account, { query = "", perFolder = 200, cap = 500 } = {}) {
  const q = String(query).trim();
  if (!q) return [];
  const words = [...new Set(q.toLowerCase().split(/[^\p{L}\p{N}@._-]+/u).filter((w) => w.length >= 4))].slice(0, 6);
  const client = await getClient(account);
  let boxes = [];
  try { boxes = await client.list(); } catch { boxes = []; }
  const out = [];
  const seen = new Set();
  for (const box of boxes) {
    if (!box || !box.path) continue;
    if (box.flags && (box.flags.has("\\Noselect") || box.flags.has("\\NonExistent"))) continue;
    let lock;
    try {
      lock = await client.getMailboxLock(box.path);
      const uids = new Set();
      const runs = [{ text: q }];                                   // the phrase, anywhere
      if (words.length > 1) runs.push({ or: words.map((w) => ({ text: w })) }); // any word, for recall
      for (const crit of runs) {
        let r = [];
        try { r = (await client.search(crit, { uid: true })) || []; } catch {}
        for (const u of r) uids.add(u);
      }
      if (uids.size) {
        const take = [...uids].sort((a, b) => b - a).slice(0, perFolder); // newest matches per folder
        for await (const m of client.fetch(take, { envelope: true, flags: true, internalDate: true, uid: true }, { uid: true })) {
          const msg = mapMsg(account, box.path, m);
          if (seen.has(msg.id)) continue;
          seen.add(msg.id);
          out.push(msg);
        }
      }
    } catch {} finally { if (lock) lock.release(); }
    if (out.length >= cap * 3) break; // backstop on pathological mailboxes
  }
  out.sort((a, b) => b.dateMs - a.dateMs);
  return out.slice(0, cap);
}

// Harvest an address book: Sent recipients (To/Cc — people you write to, weighted
// highest) + inbox senders (From). Returns [{name, email, count}] newest-relevance first.
async function harvestContacts(_oauth, account, { limit = 1500 } = {}) {
  const map = new Map();
  const self = String(account.address || "").toLowerCase();
  const add = (addr, weight) => {
    const email = (addr && addr.address || "").toLowerCase();
    if (!email || !email.includes("@") || email === self) return;
    const e = map.get(email) || { name: "", email, count: 0 };
    if (addr.name && (!e.name || addr.name.length > e.name.length)) e.name = addr.name;
    e.count += weight; map.set(email, e);
  };
  try {
    const sent = await resolveMailbox(account, "Sent");
    if (sent) await withMailbox(account, sent, async (client) => {
      const exists = client.mailbox.exists || 0; if (!exists) return;
      const lo = Math.max(1, exists - limit + 1);
      for await (const m of client.fetch(`${lo}:${exists}`, { envelope: true })) {
        ((m.envelope && m.envelope.to) || []).forEach((a) => add(a, 3));
        ((m.envelope && m.envelope.cc) || []).forEach((a) => add(a, 2));
      }
    });
  } catch {}
  try {
    await withMailbox(account, "INBOX", async (client) => {
      const exists = client.mailbox.exists || 0; if (!exists) return;
      const lo = Math.max(1, exists - limit + 1);
      for await (const m of client.fetch(`${lo}:${exists}`, { envelope: true })) {
        ((m.envelope && m.envelope.from) || []).forEach((a) => add(a, 1));
      }
    });
  } catch {}
  return [...map.values()].sort((a, b) => b.count - a.count);
}
async function listFolderByKind(_oauth, account, kind, limit = 100) {
  const res = await listPage(null, account, { scope: kind, cursor: null, limit });
  return { messages: res.messages, error: res.error || null };
}

// ── Body + attachments (parse the full MIME with mailparser) ──────────────────
async function fetchParsed(account, messageId) {
  const { mailbox, uid } = imapRef(messageId);
  return withMailbox(account, mailbox, async (client) => {
    const msg = await client.fetchOne(String(uid), { source: true }, { uid: true });
    if (!msg || !msg.source) throw new Error("Message not found");
    return simpleParser(msg.source);
  });
}
async function getContent(_oauth, account, _folderId, messageId) {
  const p = await fetchParsed(account, messageId);
  const attachments = (p.attachments || []).map((a, i) => {
    // "inline" means an embeddable inline image (a cid-referenced image swapped into
    // the body HTML). A non-image part, or any part without a Content-ID, is a real
    // downloadable attachment even when the sender set Content-Disposition: inline —
    // iPhone Mail does exactly that for PDFs — so it must still appear in the list.
    const isImage = (a.contentType || "").toLowerCase().startsWith("image/");
    const inline = isImage && !!a.cid;
    return {
      id: String(i),
      name: a.filename || (a.cid ? a.cid : `attachment-${i + 1}`),
      size: a.size || (a.content ? a.content.length : 0),
      mimeType: a.contentType || "application/octet-stream",
      contentId: a.cid ? String(a.cid).replace(/^<|>$/g, "") : null,
      inline,
      // Inline (cid) images carry their bytes so the reader can embed them with
      // no extra round-trip; regular attachments are fetched on demand.
      data: inline && a.content ? a.content.toString("base64") : null,
    };
  });
  return { html: p.html || (p.textAsHtml || "") || "", subject: p.subject || "", attachments };
}
// Lightweight body previews for a set of messages (IMAP carries none in the list
// fetch). One source-fetch per mailbox, parsed to plain text, first ~200 chars.
// Called lazily/in the background by the renderer, cached per messageId.
async function snippets(_oauth, account, messageIds) {
  const byBox = new Map();
  for (const id of messageIds || []) {
    let ref; try { ref = imapRef(id); } catch { continue; }
    if (!ref || !ref.mailbox) continue;
    if (!byBox.has(ref.mailbox)) byBox.set(ref.mailbox, []);
    byBox.get(ref.mailbox).push({ uid: String(ref.uid), id });
  }
  const out = {};
  for (const [mailbox, items] of byBox) {
    const byUid = new Map(items.map((it) => [it.uid, it.id]));
    const range = items.map((it) => it.uid).join(",");
    try {
      await withMailbox(account, mailbox, async (client) => {
        for await (const msg of client.fetch(range, { uid: true, source: true }, { uid: true })) {
          if (!msg.source) continue;
          const id = byUid.get(String(msg.uid));
          if (!id) continue;
          try {
            const p = await simpleParser(msg.source);
            let text = p.text || "";
            if (!text && (p.html || p.textAsHtml)) {
              // HTML-only email (most marketing mail): strip to a plain-text preview.
              text = String(p.html || p.textAsHtml)
                .replace(/<style[\s\S]*?<\/style>/gi, " ")
                .replace(/<script[\s\S]*?<\/script>/gi, " ")
                .replace(/<[^>]+>/g, " ")
                .replace(/&(nbsp|amp|lt|gt|quot|apos|#39|#\d+);/gi, " ");
            }
            text = String(text).replace(/\s+/g, " ").trim();
            if (text) out[id] = text.slice(0, 200);
          } catch {}
        }
      });
    } catch {}
  }
  return out;
}
async function getAttachment(_oauth, account, { messageId, attachmentId }) {
  const p = await fetchParsed(account, messageId);
  const a = (p.attachments || [])[Number(attachmentId)];
  if (!a || !a.content) throw new Error("Attachment not found");
  return { base64: a.content.toString("base64") };
}

// ── Flags + moves ─────────────────────────────────────────────────────────────
function groupByMailbox(messageIds) {
  const m = new Map();
  messageIds.forEach((id) => { const { mailbox, uid } = imapRef(id); if (!m.has(mailbox)) m.set(mailbox, []); m.get(mailbox).push(String(uid)); });
  return m;
}
async function markRead(_oauth, account, messageIds, read) {
  for (const [mailbox, uids] of groupByMailbox(messageIds)) {
    await withMailbox(account, mailbox, async (client) => {
      if (read) await client.messageFlagsAdd(uids, ["\\Seen"], { uid: true });
      else await client.messageFlagsRemove(uids, ["\\Seen"], { uid: true });
    });
  }
  return { ok: true };
}
async function move(_oauth, account, messageIds, target) {
  const kind = target === "inbox" ? "inbox" : target === "archive" ? "Archive" : target === "spam" ? "Spam" : "Trash";
  const dest = await resolveMailbox(account, kind);
  if (!dest) throw new Error(`No "${kind}" folder on this account.`);
  for (const [mailbox, uids] of groupByMailbox(messageIds)) {
    if (mailbox === dest) continue;
    await withMailbox(account, mailbox, async (client) => {
      await client.messageMove(uids, dest, { uid: true });
    });
  }
  folderCache[account.id] && delete folderCache[account.id];
  return { ok: true };
}
// Move specific messages into a named user folder (drag-and-drop filing).
async function moveToFolder(_oauth, account, messageIds, folderName) {
  const dest = (await resolveMailbox(account, folderName)) || folderName;
  for (const [mailbox, uids] of groupByMailbox(messageIds)) {
    if (mailbox === dest) continue;
    await withMailbox(account, mailbox, async (client) => { await moveInBatches(client, uids, dest); });
  }
  delete folderCache[account.id];
  return { ok: true };
}

// ── Sending (SMTP) ────────────────────────────────────────────────────────────
async function send(_oauth, account, { to, cc, bcc, subject, body, html, attachments }) {
  const transport = nodemailer.createTransport({
    host: account.smtpHost || "smtp.mail.yahoo.com",
    port: account.smtpPort || 465,
    secure: (account.smtpPort || 465) === 465,
    auth: { user: account.address, pass: account.password },
  });
  const mailOptions = {
    from: account.displayName ? { name: account.displayName, address: account.address } : account.address,
    to: to || undefined,
    cc: cc || undefined,
    bcc: bcc || undefined,
    subject: subject || "",
    text: body || "",
    ...(html ? { html } : {}),
    attachments: (attachments || []).map((a) => ({
      filename: a.name,
      content: Buffer.from(a.base64 || "", "base64"),
      contentType: a.mimeType || undefined,
    })),
  };
  await transport.sendMail(mailOptions);
  // Raw SMTP does NOT file a copy to the Sent folder — APPEND one ourselves so
  // sent mail actually shows in Sent. Best-effort: the send already succeeded.
  try {
    const sentBox = await resolveMailbox(account, "Sent");
    if (sentBox) {
      const raw = await new Promise((res, rej) => new MailComposer(mailOptions).compile().build((e, msg) => (e ? rej(e) : res(msg))));
      await withMailbox(account, sentBox, async (client) => { await client.append(sentBox, raw, ["\\Seen"]); });
    }
  } catch { /* couldn't file the Sent copy; the message was still sent */ }
  return { ok: true };
}

// Verify credentials at connect time (used by the onboarding flow).
async function verify(account) {
  const client = await getClient(account);
  await client.getMailboxLock("INBOX").then((l) => l.release());
  return { ok: true };
}

async function getAvatar() { return null; }

module.exports = {
  verify, clearAccountCache, getAvatar,
  listInbox, listMany, listPage, getContent, getAttachment, send, move, markRead, listFolderByKind,
  fileBySenders, unfileToInbox, ensureMailbox, listUserFolders, inboxUnread, inboxSenderTally, collapseAllFolders, moveToFolder,
  accountSenderTally, probeUnsubscribe, unsubscribeOneClick, sendUnsubscribeMailtos, purgeMany, undoMany,
  unsubScan, unsubscribeOne, inboxForScan, trashByIds, restoreIds, harvestContacts, snippets, searchAll,
  parseUnsub, // exported for unit testing
};
