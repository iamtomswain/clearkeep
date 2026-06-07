"use strict";

/* Build the update manifest (dist/latest.json) from the electron-builder zip.
   Run after the mac build — `npm run release` does both:
       electron-builder --mac   (produces the .dmg AND the *-mac.zip update payload)
       node tools/release.js    (hashes the zip, writes latest.json)

   Then publish a GitHub release:
     1) tag it  v<version>   (matches package.json "version")
     2) upload TWO assets:  the  *-mac.zip   and   latest.json
   The app checks <releases/latest/download/latest.json> and self-updates.
   (Set the repo in lib/config.js -> update.manifestUrl / releaseBaseUrl.) */

const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const pkg = require("../package.json");
const CFG = require("../lib/config");

const version = pkg.version;
const distDir = path.join(__dirname, "..", "dist");

const zip = fs.readdirSync(distDir).find((f) => f.endsWith("-mac.zip"));
if (!zip) {
  console.error('No "*-mac.zip" in dist/. Build with the zip target first (npm run release).');
  process.exit(1);
}
const sha256 = crypto.createHash("sha256").update(fs.readFileSync(path.join(distDir, zip))).digest("hex");
const url = `${CFG.update.releaseBaseUrl}/v${version}/${encodeURIComponent(zip)}`;
const manifest = { version, url, sha256, notes: "" };

fs.writeFileSync(path.join(distDir, "latest.json"), JSON.stringify(manifest, null, 2) + "\n");

if (CFG.update.releaseBaseUrl.includes("OWNER/REPO")) {
  console.warn("\n⚠  lib/config.js still has the OWNER/REPO placeholder — edit update.manifestUrl + releaseBaseUrl before shipping.\n");
}
console.log("dist/latest.json:\n" + JSON.stringify(manifest, null, 2));
console.log(`\nPublish GitHub release  v${version}  and upload these two assets:`);
console.log("  • " + zip);
console.log("  • latest.json");
