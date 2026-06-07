"use strict";

/* "Needs you" store — the proactive to-do list extracted from important mail.
   Each item is derived from one source email (keyed by account + sourceMessageId).
   User status (done/dismissed/snoozed) is PRESERVED across re-scans so handled
   items never reappear. Content (summary/action/deadline) is refreshed each scan. */

const { app } = require("electron");
const fs = require("fs");
const path = require("path");

const FILE = () => path.join(app.getPath("userData"), "needs.json");

function read() { try { return JSON.parse(fs.readFileSync(FILE(), "utf8")); } catch { return { items: [] }; } }
function write(d) { fs.writeFileSync(FILE(), JSON.stringify(d, null, 2), "utf8"); }

function list(account) {
  const all = read().items || [];
  return account ? all.filter((i) => i.account === account) : all;
}

// Upsert fresh scan items. Existing items keep their status/snoozeUntil/createdAt;
// only their content is refreshed. New items start "active".
function merge(account, fresh = []) {
  const d = read();
  d.items = d.items || [];
  const now = Date.now();
  for (const f of fresh) {
    const ex = d.items.find((i) => i.account === account && i.sourceMessageId === f.sourceMessageId);
    if (ex) {
      if (ex.dueISO !== f.dueISO) ex.remindStage = ""; // deadline moved → re-arm reminders
      ex.summary = f.summary; ex.action = f.action; ex.deadline = f.deadline; ex.dueISO = f.dueISO;
      ex.priority = f.priority; ex.temporalStatus = f.temporalStatus; ex.source = f.source; ex.folder = f.folder;
      ex.updatedAt = now;
    } else {
      d.items.push({ account, ...f, status: "active", snoozeUntil: null, remindStage: "", createdAt: now, updatedAt: now });
    }
  }
  write(d);
  return list(account);
}

function setStatus(account, sourceMessageId, status, snoozeUntil = null) {
  const d = read();
  const it = (d.items || []).find((i) => i.account === account && i.sourceMessageId === sourceMessageId);
  if (!it) return null;
  it.status = status;
  it.snoozeUntil = snoozeUntil || null;
  it.updatedAt = Date.now();
  write(d);
  return it;
}

// Record that we've already fired a deadline reminder for this item at a given
// stage ("" | "soon" | "overdue"), so the background tick never re-notifies the
// same deadline. Persisted so it survives relaunch.
function markReminded(account, sourceMessageId, remindStage) {
  const d = read();
  const it = (d.items || []).find((i) => i.account === account && i.sourceMessageId === sourceMessageId);
  if (!it) return null;
  it.remindStage = remindStage || "";
  it.updatedAt = Date.now();
  write(d);
  return it;
}

module.exports = { list, merge, setStatus, markReminded };
