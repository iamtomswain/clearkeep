"use strict";

// Shared, provider-agnostic unsubscribe helpers. Pure logic + one HTTP POST, used
// by the Zoho backend (lib/zoho.js). lib/imap.js carries its own equivalents for
// the Yahoo path; if you change the parsing rules here, mirror them there.

const http = require("http");
const https = require("https");

// Parse a raw header block for List-Unsubscribe / List-Unsubscribe-Post and
// classify the best available unsubscribe method.
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
  if (httpsUrl) return { tier: "link", url: httpsUrl };   // web page — opened in browser, no auto-bounce
  if (mailto) return { tier: "mailto", mailto: mailto.replace(/^mailto:\s*/i, "").trim() };
  return { tier: "none" };
}

// RFC 8058 one-click unsubscribe: POST "List-Unsubscribe=One-Click" to the URL.
function oneClickPost({ postUrl } = {}) {
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

// Build an exact-address (+ optional domain) matcher from cleanup rules.
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

module.exports = { parseUnsub, oneClickPost, buildSenderMatcher };
