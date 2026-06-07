"use strict";

/* Custom self-updater for the UNSIGNED macOS build.
   Why custom (not electron-updater): Squirrel.Mac validates an Apple Developer
   signature before swapping the app — impossible without a $99 cert. But the only
   thing that actually blocks an unsigned app is the macOS *quarantine* flag, and
   that flag is added by browsers/Mail/AirDrop — NOT by files an app downloads
   itself over HTTPS. So: the app fetches a manifest, downloads the new build with
   Node (no quarantine), verifies a sha256 (our stand-in for code signing), swaps
   its own .app bundle in place, and relaunches. No Gatekeeper "damaged" prompt.

   Manifest (latest.json): { "version": "0.0.2", "url": "...zip", "sha256": "...", "notes": "" }
   Built by tools/release.js; hosted on a GitHub release (see lib/config.js). */

const { app } = require("electron");
const https = require("https");
const fs = require("fs");
const os = require("os");
const path = require("path");
const crypto = require("crypto");
const { execFile } = require("child_process");
const CFG = require("./config");

const MANIFEST_URL = process.env.CLEARKEEP_UPDATE_URL || CFG.update.manifestUrl;

// GET with redirect-following (GitHub release downloads redirect to a CDN).
function httpGet(url, redirects = 0) {
  return new Promise((resolve, reject) => {
    const req = https.get(url, { headers: { "User-Agent": "ClearKeep-Updater" } }, (res) => {
      const code = res.statusCode;
      if ([301, 302, 303, 307, 308].includes(code) && res.headers.location && redirects < 6) {
        res.resume();
        return resolve(httpGet(new URL(res.headers.location, url).toString(), redirects + 1));
      }
      if (code !== 200) { res.resume(); return reject(new Error("HTTP " + code)); }
      resolve(res);
    });
    req.on("error", reject);
    req.setTimeout(25000, () => req.destroy(new Error("network timeout")));
  });
}

function getJson(url) {
  return httpGet(url).then((res) => new Promise((resolve, reject) => {
    let buf = ""; res.setEncoding("utf8");
    res.on("data", (c) => (buf += c));
    res.on("end", () => { try { resolve(JSON.parse(buf)); } catch (e) { reject(new Error("bad manifest JSON")); } });
    res.on("error", reject);
  }));
}

// true if version a is newer than b (numeric dot-segments, e.g. "0.1.0" > "0.0.9")
function isNewer(a, b) {
  const pa = String(a).split(".").map((n) => parseInt(n, 10) || 0);
  const pb = String(b).split(".").map((n) => parseInt(n, 10) || 0);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const x = pa[i] || 0, y = pb[i] || 0;
    if (x !== y) return x > y;
  }
  return false;
}

async function check() {
  const m = await getJson(MANIFEST_URL);
  const current = app.getVersion();
  return {
    current,
    latest: m.version || null,
    available: !!m.version && isNewer(m.version, current),
    url: m.url || null,
    sha256: String(m.sha256 || "").toLowerCase(),
    notes: m.notes || "",
  };
}

function download(url, dest, onProgress) {
  return httpGet(url).then((res) => new Promise((resolve, reject) => {
    const total = parseInt(res.headers["content-length"] || "0", 10);
    let got = 0;
    const hash = crypto.createHash("sha256");
    const out = fs.createWriteStream(dest);
    res.on("data", (c) => { got += c.length; hash.update(c); if (onProgress && total) onProgress(got / total); });
    res.pipe(out);
    out.on("finish", () => out.close(() => resolve(hash.digest("hex"))));
    out.on("error", reject);
    res.on("error", reject);
  }));
}

function exec(cmd, args) {
  return new Promise((resolve, reject) =>
    execFile(cmd, args, (err, _so, se) => (err ? reject(new Error(se || err.message)) : resolve())));
}

// /Applications/ClearKeep.app from the running executable
function bundlePath() {
  // exe = …/ClearKeep.app/Contents/MacOS/ClearKeep
  return path.resolve(path.dirname(app.getPath("exe")), "..", "..");
}

async function apply(info, onProgress) {
  if (!app.isPackaged) throw new Error("Updates only apply to the installed app.");
  if (process.platform !== "darwin") throw new Error("The updater supports macOS only.");
  const meta = info && info.url ? info : await check();
  if (!meta.url) throw new Error("No update URL available.");

  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "clearkeep-upd-"));
  const cleanup = () => { try { fs.rmSync(tmp, { recursive: true, force: true }); } catch {} };
  try {
    const zip = path.join(tmp, "update.zip");
    const gotSha = await download(meta.url, zip, (p) => onProgress && onProgress({ phase: "download", pct: p }));
    const want = String(meta.sha256 || "").toLowerCase();
    if (want && gotSha.toLowerCase() !== want) throw new Error("integrity check failed (sha256 mismatch)");

    onProgress && onProgress({ phase: "install" });
    const ex = path.join(tmp, "x");
    fs.mkdirSync(ex);
    await exec("ditto", ["-x", "-k", zip, ex]); // ditto unpacks the .app preserving its bundle + signature
    const appName = fs.readdirSync(ex).find((e) => e.endsWith(".app"));
    if (!appName) throw new Error("no .app inside the update package");
    const newApp = path.join(ex, appName);

    const cur = bundlePath();
    const backup = cur + ".old-" + process.pid;
    fs.renameSync(cur, backup); // move the running bundle aside (the live process keeps running)
    try {
      await exec("ditto", [newApp, cur]); // copy the new bundle into place
    } catch (e) {
      try { fs.rmSync(cur, { recursive: true, force: true }); } catch {}
      try { fs.renameSync(backup, cur); } catch {} // restore on failure
      throw e;
    }
    try { fs.rmSync(backup, { recursive: true, force: true }); } catch {}
    cleanup();

    app.relaunch();
    app.exit(0);
    return { ok: true };
  } catch (e) {
    cleanup();
    throw e;
  }
}

module.exports = { check, apply, manifestUrl: MANIFEST_URL };
