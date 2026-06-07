"use strict";

/* Auto-harvested address book (per account). Contacts come from who you've emailed
   (Sent recipients — strongest signal) and who's emailed you (inbox senders). Cached
   in contacts.json; refreshed on a timer or after sending. No manual management. */

const { app } = require("electron");
const fs = require("fs");
const path = require("path");

const FILE = () => path.join(app.getPath("userData"), "contacts.json");

function read() { try { return JSON.parse(fs.readFileSync(FILE(), "utf8")); } catch { return { accounts: {} }; } }
function write(d) { fs.writeFileSync(FILE(), JSON.stringify(d, null, 2), "utf8"); }

function get(account) { return (read().accounts || {})[account] || null; }
function save(account, items) {
  const d = read(); d.accounts = d.accounts || {};
  d.accounts[account] = { items, updatedAt: Date.now() };
  write(d);
  return items;
}
// Merge just-used recipients to the top so a fresh contact is usable immediately.
function addRecipients(account, recips = []) {
  const d = read(); d.accounts = d.accounts || {};
  const a = d.accounts[account] || { items: [], updatedAt: 0 };
  for (const r of recips) {
    if (!r || !r.email) continue;
    const email = String(r.email).toLowerCase();
    let it = a.items.find((x) => x.email === email);
    if (it) { it.count = (it.count || 0) + 3; if (r.name && !it.name) it.name = r.name; }
    else a.items.push({ name: r.name || "", email, count: 3 });
  }
  a.items.sort((x, y) => (y.count || 0) - (x.count || 0));
  d.accounts[account] = a; write(d);
  return a.items;
}

module.exports = { get, save, addRecipients };
