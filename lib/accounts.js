"use strict";

/* Provider-aware account config + secure credential storage.
   userData/accounts.json:
   {
     oauth: { zoho: {clientId, secretEnc}, google: {clientId, secretEnc} },
     accounts: [ { id, address, provider, swatch, ...providerAuth(encrypted) } ]
   }
   Secrets encrypted with Electron safeStorage (Keychain-backed).
   Backward-compatible: migrates the old single-oauth Zoho-only shape on read. */

const { app, safeStorage } = require("electron");
const fs = require("fs");
const path = require("path");

const FILE = () => path.join(app.getPath("userData"), "accounts.json");
const SWATCHES = ["#3b82f6", "#a855f7", "#22c55e", "#f59e0b", "#ef4444", "#14b8a6"];

function enc(plain) {
  if (!safeStorage.isEncryptionAvailable()) throw new Error("OS keychain encryption is not available.");
  return safeStorage.encryptString(plain).toString("base64");
}
function dec(b64) { return safeStorage.decryptString(Buffer.from(b64, "base64")); }
function makeId(address) { return address.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, ""); }

function readRaw() {
  let d;
  try { d = JSON.parse(fs.readFileSync(FILE(), "utf8")); } catch { return { oauth: {}, accounts: [] }; }
  // migrate old shape: oauth.{clientId,secretEnc} → oauth.zoho; accounts without provider → zoho
  if (d.oauth && (d.oauth.clientId || d.oauth.secretEnc) && !d.oauth.zoho) {
    d.oauth = { zoho: { clientId: d.oauth.clientId, secretEnc: d.oauth.secretEnc } };
  }
  if (!d.oauth) d.oauth = {};
  d.accounts = (d.accounts || []).map((a) =>
    a.provider ? a : { id: a.id, address: a.address, provider: "zoho", swatch: a.swatch, zohoAccountId: a.zohoAccountId, refreshTokenEnc: a.refreshTokenEnc }
  );
  return d;
}
function writeRaw(d) { fs.writeFileSync(FILE(), JSON.stringify(d, null, 2), "utf8"); }

// ── Per-provider OAuth client ───────────────────────────────────────────────
function getProviderOAuthPublic(provider) {
  const o = readRaw().oauth[provider];
  return { clientId: o ? o.clientId : "", hasSecret: !!(o && o.secretEnc) };
}
function getProviderOAuth(provider) {
  const o = readRaw().oauth[provider];
  if (!o || !o.secretEnc) return null;
  return { clientId: o.clientId, clientSecret: dec(o.secretEnc) };
}
function setProviderOAuth(provider, { clientId, clientSecret }) {
  const d = readRaw();
  d.oauth[provider] = { clientId: clientId.trim(), secretEnc: enc(clientSecret) };
  writeRaw(d);
}

// ── Accounts ────────────────────────────────────────────────────────────────
function publicRecord(a) { return { id: a.id, address: a.address, provider: a.provider, swatch: a.swatch }; }
function list() { return readRaw().accounts.map(publicRecord); }

function withSecret(id) {
  const a = readRaw().accounts.find((x) => x.id === id);
  if (!a) return null;
  const base = { id: a.id, address: a.address, provider: a.provider };
  if (a.provider === "zoho") return { ...base, zohoAccountId: a.zohoAccountId, refreshToken: dec(a.refreshTokenEnc) };
  if (a.provider === "gmail") return { ...base, refreshToken: dec(a.refreshTokenEnc) };
  if (a.provider === "yahoo") return { ...base, password: dec(a.passwordEnc), imapHost: a.imapHost, imapPort: a.imapPort, smtpHost: a.smtpHost, smtpPort: a.smtpPort };
  return base;
}

function addAccount(rec) {
  const d = readRaw();
  const id = makeId(rec.address);
  const idx = d.accounts.findIndex((x) => x.id === id);
  const swatch = idx >= 0 ? d.accounts[idx].swatch : SWATCHES[d.accounts.length % SWATCHES.length];
  const stored = { id, address: rec.address.trim(), provider: rec.provider, swatch };
  if (rec.provider === "zoho") { stored.zohoAccountId = rec.zohoAccountId; stored.refreshTokenEnc = enc(rec.refreshToken); }
  else if (rec.provider === "gmail") { stored.refreshTokenEnc = enc(rec.refreshToken); }
  else if (rec.provider === "yahoo") {
    stored.passwordEnc = enc(rec.password);
    stored.imapHost = rec.imapHost || "imap.mail.yahoo.com";
    stored.imapPort = rec.imapPort || 993;
    stored.smtpHost = rec.smtpHost || "smtp.mail.yahoo.com";
    stored.smtpPort = rec.smtpPort || 465;
  }
  if (idx >= 0) d.accounts[idx] = stored; else d.accounts.push(stored);
  writeRaw(d);
  return publicRecord(stored);
}

function remove(id) {
  const d = readRaw();
  d.accounts = d.accounts.filter((x) => x.id !== id);
  writeRaw(d);
}

// One-time dev bootstrap of the original Zoho account from tools files.
function importBootstrapIfEmpty(toolsDir) {
  const d = readRaw();
  if ((d.oauth && Object.keys(d.oauth).length) || d.accounts.length) return false;
  try {
    const creds = JSON.parse(fs.readFileSync(path.join(toolsDir, "zoho-creds.json"), "utf8"));
    const tok = JSON.parse(fs.readFileSync(path.join(toolsDir, "zoho-tokens.json"), "utf8"));
    if (!creds.clientId || !creds.clientSecret || !tok.refreshToken) return false;
    setProviderOAuth("zoho", { clientId: creds.clientId, clientSecret: creds.clientSecret });
    addAccount({ provider: "zoho", address: tok.address, zohoAccountId: tok.accountId, refreshToken: tok.refreshToken });
    return true;
  } catch { return false; }
}

module.exports = {
  getProviderOAuthPublic, getProviderOAuth, setProviderOAuth,
  list, withSecret, addAccount, remove, importBootstrapIfEmpty,
};
