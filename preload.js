const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("clearkeep", {
  // OAuth client + accounts
  getOAuth: (provider) => ipcRenderer.invoke("oauth:get", provider),
  setOAuth: (payload) => ipcRenderer.invoke("oauth:set", payload),
  listAccounts: () => ipcRenderer.invoke("accounts:list"),
  connectAccount: (payload) => ipcRenderer.invoke("accounts:connect", payload),
  connectGoogle: () => ipcRenderer.invoke("accounts:connectGoogle"),
  connectYahoo: (payload) => ipcRenderer.invoke("accounts:connectYahoo", payload),
  removeAccount: (id) => ipcRenderer.invoke("accounts:remove", id),
  // mail
  fetchInbox: (opts) => ipcRenderer.invoke("mail:inbox", opts),
  deepScan: (opts) => ipcRenderer.invoke("mail:scan", opts),
  searchAll: (opts) => ipcRenderer.invoke("mail:searchAll", opts),
  fetchPage: (args) => ipcRenderer.invoke("mail:page", args),
  inboxUnread: (args) => ipcRenderer.invoke("mail:inboxUnread", args),
  senderTally: (args) => ipcRenderer.invoke("mail:senderTally", args),
  fetchBody: (args) => ipcRenderer.invoke("mail:body", args),
  fetchAttachment: (args) => ipcRenderer.invoke("mail:attachment", args),
  moveMessages: (payload) => ipcRenderer.invoke("mail:move", payload),
  moveToFolder: (payload) => ipcRenderer.invoke("mail:moveToFolder", payload),
  refileFolder: (payload) => ipcRenderer.invoke("folders:refile", payload),
  unsubScan: (payload) => ipcRenderer.invoke("mail:unsubScan", payload),
  unsubscribeOne: (payload) => ipcRenderer.invoke("mail:unsubscribeOne", payload),
  setRead: (payload) => ipcRenderer.invoke("mail:read", payload),
  fetchFolderView: (payload) => ipcRenderer.invoke("mail:folder", payload),
  send: (payload) => ipcRenderer.invoke("mail:send", payload),
  contactsList: (payload) => ipcRenderer.invoke("contacts:list", payload),
  contactsAdd: (payload) => ipcRenderer.invoke("contacts:add", payload),
  identityAll: () => ipcRenderer.invoke("identity:all"),
  identitySet: (payload) => ipcRenderer.invoke("identity:set", payload),
  // attachments → disk
  saveFile: (payload) => ipcRenderer.invoke("file:save", payload),
  openFile: (payload) => ipcRenderer.invoke("file:open", payload),
  // self-update
  appVersion: () => ipcRenderer.invoke("app:version"),
  checkUpdate: () => ipcRenderer.invoke("update:check"),
  applyUpdate: (info) => ipcRenderer.invoke("update:apply", info),
  onUpdateProgress: (cb) => {
    const h = (_e, p) => cb(p);
    ipcRenderer.on("update:progress", h);
    return () => ipcRenderer.removeListener("update:progress", h);
  },
  // misc
  openExternal: (url) => ipcRenderer.invoke("shell:open", url),
  setBadge: (count) => ipcRenderer.invoke("app:setBadge", count),
  focusWindow: () => ipcRenderer.invoke("app:focus"),
  // avatars
  fetchAvatar: (payload) => ipcRenderer.invoke("avatar:fetch", payload),
  fetchAccountAvatar: (accountId) => ipcRenderer.invoke("account:avatar", accountId),
  // folders (AI-assisted)
  listFolders: (accountId) => ipcRenderer.invoke("folders:list", accountId),
  setFolderOrder: (payload) => ipcRenderer.invoke("folders:setOrder", payload),
  createFolder: (payload) => ipcRenderer.invoke("folders:createAndFill", payload),
  createEmptyFolder: (payload) => ipcRenderer.invoke("folders:createEmpty", payload),
  autoOrganize: (payload) => ipcRenderer.invoke("folders:autoOrganize", payload),
  unfileFolder: (payload) => ipcRenderer.invoke("folders:unfile", payload),
  // Clean up (bulk unsubscribe + purge)
  cleanupIndex: (payload) => ipcRenderer.invoke("cleanup:index", payload),
  onCleanupProgress: (cb) => {
    const h = (_e, p) => cb(p);
    ipcRenderer.on("cleanup:indexProgress", h);
    return () => ipcRenderer.removeListener("cleanup:indexProgress", h);
  },
  cleanupExecute: (payload) => ipcRenderer.invoke("cleanup:execute", payload),
  cleanupUndo: (payload) => ipcRenderer.invoke("cleanup:undo", payload),
  // Find important (AI keeper-finder; files keepers, never trashes)
  keepersScan: (payload) => ipcRenderer.invoke("keepers:scan", payload),
  onKeepersProgress: (cb) => {
    const h = (_e, p) => cb(p);
    ipcRenderer.on("keepers:scanProgress", h);
    return () => ipcRenderer.removeListener("keepers:scanProgress", h);
  },
  keepersFile: (payload) => ipcRenderer.invoke("keepers:file", payload),
  keepersTrash: (payload) => ipcRenderer.invoke("keepers:trash", payload),
  keepersRestore: (payload) => ipcRenderer.invoke("keepers:restore", payload),
  // Important (smart mailbox of AI-classified important mail)
  importantGet: (payload) => ipcRenderer.invoke("important:get", payload),
  importantClassifyNew: (payload) => ipcRenderer.invoke("important:classifyNew", payload),
  importantScanAll: (payload) => ipcRenderer.invoke("important:scanAll", payload),
  importantUpdate: (payload) => ipcRenderer.invoke("important:update", payload),
  onImportantProgress: (cb) => {
    const h = (_e, p) => cb(p);
    ipcRenderer.on("important:scanProgress", h);
    return () => ipcRenderer.removeListener("important:scanProgress", h);
  },
  // Needs you (proactive action/deadline to-do list)
  needsScan: (payload) => ipcRenderer.invoke("needs:scan", payload),
  onNeedsProgress: (cb) => {
    const h = (_e, p) => cb(p);
    ipcRenderer.on("needs:scanProgress", h);
    return () => ipcRenderer.removeListener("needs:scanProgress", h);
  },
  needsGet: (payload) => ipcRenderer.invoke("needs:get", payload),
  needsUpdate: (payload) => ipcRenderer.invoke("needs:update", payload),
  needsRemind: (payload) => ipcRenderer.invoke("needs:remind", payload),
  // Ask your mailbox (read-side RAG with citations)
  askAnswer: (payload) => ipcRenderer.invoke("ask:answer", payload),
  onAskProgress: (cb) => {
    const h = (_e, p) => cb(p);
    ipcRenderer.on("ask:progress", h);
    return () => ipcRenderer.removeListener("ask:progress", h);
  },
  classifyMessages: (payload) => ipcRenderer.invoke("ai:classify", payload),
  snippets: (payload) => ipcRenderer.invoke("mail:snippets", payload),
  searchEmails: (payload) => ipcRenderer.invoke("ai:search", payload),
  removeFolder: (id) => ipcRenderer.invoke("folders:remove", id),
  collapseFolders: (payload) => ipcRenderer.invoke("folders:collapseAll", payload),
  matchThemeFolder: (payload) => ipcRenderer.invoke("folders:matchTheme", payload),
  fileThemeFolder: (payload) => ipcRenderer.invoke("folders:fileTheme", payload),
  onThemeProgress: (cb) => {
    const h = (_e, p) => cb(p);
    ipcRenderer.on("theme:progress", h);
    return () => ipcRenderer.removeListener("theme:progress", h);
  },
  onCollapseProgress: (cb) => {
    const h = (_e, p) => cb(p);
    ipcRenderer.on("folders:collapseProgress", h);
    return () => ipcRenderer.removeListener("folders:collapseProgress", h);
  },
  // per-message overrides
  getOverrides: () => ipcRenderer.invoke("overrides:get"),
  addOverride: (key) => ipcRenderer.invoke("overrides:add", key),
  removeOverride: (key) => ipcRenderer.invoke("overrides:remove", key),
});
