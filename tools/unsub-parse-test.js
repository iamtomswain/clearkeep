// Throwaway: unit-test parseUnsub against real-world List-Unsubscribe headers.
// Pure logic, no network/IMAP — safe to run anytime. `node tools/unsub-parse-test.js`
const { parseUnsub } = require("../lib/imap");

const cases = [
  {
    name: "one-click (https + post)",
    raw: "List-Unsubscribe: <https://email.nike.com/u?id=abc>\r\nList-Unsubscribe-Post: List-Unsubscribe=One-Click\r\n",
    expect: { tier: "one-click", postUrl: "https://email.nike.com/u?id=abc" },
  },
  {
    name: "mailto + https, NO one-click → prefer mailto (safe)",
    raw: "List-Unsubscribe: <mailto:unsub@list.example.com?subject=unsubscribe>, <https://example.com/u/123>\r\n",
    expect: { tier: "mailto", mailto: "unsub@list.example.com?subject=unsubscribe" },
  },
  {
    name: "https only, no post → link (manual)",
    raw: "List-Unsubscribe: <https://example.com/unsub/xyz>\r\n",
    expect: { tier: "link", url: "https://example.com/unsub/xyz" },
  },
  {
    name: "folded header across lines",
    raw: "List-Unsubscribe: <https://a.example.com/very/long/url>,\r\n <mailto:u@example.com>\r\nList-Unsubscribe-Post: List-Unsubscribe=One-Click\r\n",
    expect: { tier: "one-click", postUrl: "https://a.example.com/very/long/url" },
  },
  {
    name: "mailto only",
    raw: "List-Unsubscribe: <mailto:leave-123@bounces.example.org>\r\n",
    expect: { tier: "mailto", mailto: "leave-123@bounces.example.org" },
  },
  {
    name: "no header → none",
    raw: "From: someone@example.com\r\nSubject: hi\r\n",
    expect: { tier: "none" },
  },
  {
    name: "case-insensitive header name + one-click",
    raw: "list-unsubscribe: <https://x.io/out>\r\nLIST-UNSUBSCRIBE-POST: list-unsubscribe=one-click\r\n",
    expect: { tier: "one-click", postUrl: "https://x.io/out" },
  },
];

let pass = 0, fail = 0;
for (const c of cases) {
  const got = parseUnsub(c.raw);
  const ok = JSON.stringify(got) === JSON.stringify(c.expect);
  console.log(`${ok ? "PASS" : "FAIL"}  ${c.name}`);
  if (!ok) { console.log("   expected", JSON.stringify(c.expect)); console.log("   got     ", JSON.stringify(got)); fail++; }
  else pass++;
}
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
