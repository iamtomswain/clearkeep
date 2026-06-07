"use strict";

/* Operational tuning constants for the MAIN process — the behavioral "magic
   numbers" (scan caps, batch sizes, body limits, timeouts) gathered in one place
   so they're documented and adjustable without hunting through handlers.
   NOTE: renderer-side knobs (poll cadence, snooze, Ask history windows) live in
   the CFG block in renderer.js — the two processes can't share a module. */

module.exports = {
  // "Important" smart-mailbox auto-classify
  important: {
    seedCap: 80,           // first run: classify only the newest N inbox messages
    pollScanLimit: 2000,   // headers pulled per incremental poll
    fullScanLimit: 6000,   // "Search inbox for more" full scan
  },
  // "Find important" keeper-finder (Step 1)
  keepers: {
    scanLimit: 6000,       // whole-inbox header scan
    batchSize: 40,         // emails per AI classify call
  },
  // "Needs you" action/deadline extraction (reads bodies of foldered mail)
  needs: {
    perFolder: 40,         // recent messages pulled per folder
    candidateCap: 120,     // max candidates to body-read
    recentDays: 120,       // only consider mail newer than this
    batchSize: 8,          // emails per AI extract call
    bodyChars: 1500,       // body text sent to the model (truncated)
    bodyTimeoutMs: 12000,  // per-message fetch timeout
  },
  // "Ask your mailbox" RAG
  ask: {
    gatherInbox: 400,      // recent inbox headers gathered
    gatherPerFolder: 60,   // recent headers per folder
    candidateCap: 250,     // metadata candidates after dedupe
    retrieveTop: 12,       // top search hits to read
    readCap: 14,           // total bodies read (hits + carried citations)
    bodyChars: 1800,       // body text sent to the model (truncated)
    bodyTimeoutMs: 12000,  // per-message fetch timeout
  },
  // Self-update (custom updater that works for the unsigned build — see lib/updater.js).
  // EDIT THESE before shipping: point them at your GitHub repo's releases.
  // The app reads latest.json from the *latest* release; the release script
  // (tools/release.js) builds the zip download URL from releaseBaseUrl.
  update: {
    manifestUrl: "https://github.com/iamtomswain/clearkeep/releases/latest/download/latest.json",
    releaseBaseUrl: "https://github.com/iamtomswain/clearkeep/releases/download",
  },
};
