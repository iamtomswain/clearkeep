"use strict";

/* Per-account sending identity: display name (for "Name <addr>") + signature.
   Non-secret, so kept separate from the encrypted accounts store. */

const { app } = require("electron");
const fs = require("fs");
const path = require("path");

const FILE = () => path.join(app.getPath("userData"), "identity.json");

function read() { try { return JSON.parse(fs.readFileSync(FILE(), "utf8")); } catch { return { accounts: {} }; } }
function write(d) { fs.writeFileSync(FILE(), JSON.stringify(d, null, 2), "utf8"); }

function all() { return read().accounts || {}; }
function get(account) { return (read().accounts || {})[account] || {}; }
function set(account, { displayName, signature } = {}) {
  const d = read(); d.accounts = d.accounts || {};
  d.accounts[account] = { displayName: (displayName || "").trim(), signature: signature || "" };
  write(d);
  return d.accounts[account];
}

module.exports = { all, get, set };
