"use strict";

/* "Important" smart-mailbox store. The AI classifies inbox mail; the keepers are
   remembered here (by account + messageId) so the Important view is a persistent,
   auto-populated list — WITHOUT moving any mail. Dismissed ids are remembered so a
   user-corrected false-positive never comes back. A per-account UID high-water
   cursor lets incremental classification only look at genuinely new arrivals. */

const { app } = require("electron");
const fs = require("fs");
const path = require("path");

const FILE = () => path.join(app.getPath("userData"), "important.json");

function read() { try { return JSON.parse(fs.readFileSync(FILE(), "utf8")); } catch { return { items: [], cursors: {} }; } }
function write(d) { fs.writeFileSync(FILE(), JSON.stringify(d, null, 2), "utf8"); }

function list(account) {
  return (read().items || []).filter((i) => i.account === account && i.status === "important");
}
function dismissedSet(account) {
  return new Set((read().items || []).filter((i) => i.account === account && i.status === "dismissed").map((i) => i.messageId));
}
function cursor(account) {
  const c = (read().cursors || {})[account];
  return typeof c === "number" ? c : 0;
}

// Add freshly-classified keepers. keepers = [{messageId, reason, folder, source}].
// Skips ids the user already dismissed. Bumps the account's UID cursor.
function addImportant(account, keepers = [], newCursor = null) {
  const d = read();
  d.items = d.items || [];
  d.cursors = d.cursors || {};
  const now = Date.now();
  for (const k of keepers) {
    const ex = d.items.find((i) => i.account === account && i.messageId === k.messageId);
    if (ex && ex.status === "dismissed") continue; // user said not-important — never re-add
    if (ex) {
      ex.reason = k.reason; ex.folder = k.folder; ex.source = k.source; ex.status = "important"; ex.updatedAt = now;
    } else {
      d.items.push({ account, messageId: k.messageId, reason: k.reason, folder: k.folder, source: k.source, status: "important", createdAt: now, updatedAt: now });
    }
  }
  if (typeof newCursor === "number") d.cursors[account] = Math.max(d.cursors[account] || 0, newCursor);
  write(d);
  return list(account);
}

// Drop important items whose mail is no longer present in the inbox (moved/deleted),
// so the smart mailbox never shows stale rows. Keeps dismissed records (they must
// keep suppressing). Only call with a COMPLETE inbox id set.
function reconcile(account, presentIds) {
  const set = presentIds instanceof Set ? presentIds : new Set(presentIds || []);
  const d = read();
  d.items = (d.items || []).filter((i) => i.account !== account || i.status === "dismissed" || set.has(i.messageId));
  write(d);
  return list(account);
}

// Mark a single item important | dismissed (the "Not important" / undo control).
function setStatus(account, messageId, status) {
  const d = read();
  d.items = d.items || [];
  let it = d.items.find((i) => i.account === account && i.messageId === messageId);
  if (!it) { it = { account, messageId, status, createdAt: Date.now() }; d.items.push(it); }
  it.status = status; it.updatedAt = Date.now();
  write(d);
  return it;
}

module.exports = { list, dismissedSet, cursor, addImportant, reconcile, setStatus };
