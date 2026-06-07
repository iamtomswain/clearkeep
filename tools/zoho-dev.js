"use strict";

/* Dev experiment using the SAVED refresh token (no grant code needed).
   Confirms refresh flow + infers the read/unread field mapping. */

const fs = require("fs");
const path = require("path");
const ACCOUNTS_DC = "https://accounts.zoho.com";
const MAIL_DC = "https://mail.zoho.com";

async function main() {
  const creds = JSON.parse(fs.readFileSync(path.join(__dirname, "zoho-creds.json"), "utf8"));
  const tokens = JSON.parse(fs.readFileSync(path.join(__dirname, "zoho-tokens.json"), "utf8"));

  // refresh → access token
  const body = new URLSearchParams({
    grant_type: "refresh_token",
    client_id: creds.clientId,
    client_secret: creds.clientSecret,
    refresh_token: tokens.refreshToken,
  });
  const tJson = await (await fetch(`${ACCOUNTS_DC}/oauth/v2/token`, { method: "POST", body })).json();
  if (!tJson.access_token) { console.error("Refresh failed:", JSON.stringify(tJson)); process.exit(1); }
  console.log("✓ refresh token works → got a fresh access token (expires_in", tJson.expires_in, ")\n");
  const H = { Authorization: `Zoho-oauthtoken ${tJson.access_token}` };

  const url = `${MAIL_DC}/api/accounts/${tokens.accountId}/messages/view?limit=12`;
  const msgs = await (await fetch(url, { headers: H })).json();
  console.log("status status2 flagid          folderId            date        from / subject");
  (msgs.data || []).forEach((m) => {
    const d = new Date(Number(m.receivedTime)).toISOString().slice(5, 16).replace("T", " ");
    console.log(
      `  ${m.status}      ${m.status2}      ${(m.flagid || "").padEnd(14)} ${m.folderId}  ${d}  ${m.fromAddress} — ${(m.subject || "").slice(0, 34)}`
    );
  });
  const folderIds = [...new Set((msgs.data || []).map((m) => m.folderId))];
  console.log("\ndistinct folderIds in this 'view' result:", folderIds.join(", "));
}
main().catch((e) => { console.error("Error:", e.message); process.exit(1); });
