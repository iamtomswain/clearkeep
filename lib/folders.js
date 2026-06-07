"use strict";

/* Persistent, rule-based folders (local overlay — Zoho is never modified).
   A folder routes mail by matching the sender's domain or exact address.
   AI (lib/ai) derives those rules; this module stores and applies them. */

const { app } = require("electron");
const fs = require("fs");
const path = require("path");

const FILE = () => path.join(app.getPath("userData"), "folders.json");

// Bulk-email providers where the root domain ≠ the vendor — for these we pin
// the exact address instead of the domain, so we don't grab every SendGrid sender.
const ESP = new Set([
  "sendgrid.net", "sendgrid.com", "mailgun.org", "sparkpostmail.com", "amazonses.com",
  "mcsv.net", "mailchimpapp.net", "rsgsv.net", "mcdlv.net", "sendinblue.com", "sendibm1.com",
  "mailjet.com", "postmarkapp.com", "mandrillapp.com", "exct.net", "icontact.com", "cmail19.com",
  "cmail20.com", "hubspotemail.net", "klaviyomail.com", "sparkpostmail1.com",
]);

function rootDomain(domain) {
  const p = String(domain || "").toLowerCase().split(".");
  return p.length >= 2 ? p.slice(-2).join(".") : (p[0] || "");
}

function read() { try { return JSON.parse(fs.readFileSync(FILE(), "utf8")); } catch { return { folders: [] }; } }
function write(d) { fs.writeFileSync(FILE(), JSON.stringify(d, null, 2), "utf8"); }

// Folder ids are namespaced by account so the same vendor (e.g. "GitHub") can
// exist independently under more than one account without colliding.
function makeId(name, account) {
  const slug = name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") || "f";
  return account ? `${account}::${slug}` : slug;
}

// Folders belong to a single account. With no account, return everything
// (used by maintenance paths); otherwise only that account's folders.
function list(account) {
  const all = read().folders;
  return account ? all.filter((f) => f.account === account) : all;
}

function create(name, account) {
  const d = read();
  const id = makeId(name, account);
  let f = d.folders.find((x) => x.id === id);
  if (!f) {
    f = { id, name: name.trim(), domains: [], addresses: [], vendor: name.trim(), account: account || null, createdBy: "user" };
    d.folders.push(f);
    write(d);
  }
  return f;
}

function setRules(id, { domains = [], addresses = [], vendor } = {}) {
  const d = read();
  const f = d.folders.find((x) => x.id === id);
  if (!f) return null;
  f.domains = [...new Set([...(f.domains || []), ...domains])];
  f.addresses = [...new Set([...(f.addresses || []), ...addresses])];
  if (vendor) f.vendor = vendor;
  write(d);
  return f;
}

function remove(id) {
  const d = read();
  d.folders = d.folders.filter((f) => f.id !== id);
  write(d);
}

// Turn AI-matched "address (Display)" strings into folder rules.
function deriveRules(matchedSenders) {
  const addresses = [];
  const domains = new Set();
  for (const s of matchedSenders) {
    const m = String(s).match(/([^\s<(]+@[^\s>)\]]+)/);
    if (!m) continue;
    const addr = m[1].toLowerCase();
    addresses.push(addr);
    const root = rootDomain(addr.split("@")[1] || "");
    if (root && !ESP.has(root)) domains.add(root);
  }
  return { domains: [...domains], addresses: [...new Set(addresses)] };
}

// Manual folder order (per account) — a list of folder ids in the user's chosen
// order. Empty = no manual order yet (fall back to activity sort).
function getOrder(account) { return (read().orders || {})[account] || []; }
function setOrder(account, ids) {
  const d = read();
  d.orders = d.orders || {};
  d.orders[account] = Array.isArray(ids) ? ids : [];
  write(d);
}

// Per-message overrides: keys "account|messageId" pinned back to the inbox,
// overriding rule-based routing (the manual fix for a mis-filed email).
function getOverrides() { return read().overrides || []; }
function addOverride(key) {
  const d = read();
  d.overrides = d.overrides || [];
  if (!d.overrides.includes(key)) d.overrides.push(key);
  write(d);
}
function removeOverride(key) {
  const d = read();
  d.overrides = (d.overrides || []).filter((k) => k !== key);
  write(d);
}

module.exports = { list, create, setRules, remove, deriveRules, getOrder, setOrder, getOverrides, addOverride, removeOverride };
