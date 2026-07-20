"use strict";

const { contextBridge, ipcRenderer } = require("electron");

function listen(channel, callback) {
  if (typeof callback !== "function") return () => {};
  const handler = (_event, value) => callback(value);
  ipcRenderer.on(channel, handler);
  return () => ipcRenderer.removeListener(channel, handler);
}

contextBridge.exposeInMainWorld("historyAPI", {
  list: () => ipcRenderer.invoke("history:list"),
  get: id => ipcRenderer.invoke("history:get", { id }),
  delete: id => ipcRenderer.invoke("history:delete", { id }),
  clear: () => ipcRenderer.invoke("history:clear"),
  copy: (id, section) => ipcRenderer.invoke("history:copy", { id, section }),
  pointer: inside => ipcRenderer.send("history:pointer", { inside: inside === true }),
  close: () => ipcRenderer.send("history:close"),
  onChanged: callback => listen("history:changed", callback),
  onReset: callback => listen("history:reset", callback),
  onFade: callback => listen("history:fade", callback),
});
