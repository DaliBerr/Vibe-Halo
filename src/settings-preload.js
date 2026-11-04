"use strict";

const { contextBridge, ipcRenderer } = require("electron");

function listen(channel, callback) {
  if (typeof callback !== "function") return () => {};
  const handler = (_event, value) => callback(value);
  ipcRenderer.on(channel, handler);
  return () => ipcRenderer.removeListener(channel, handler);
}

contextBridge.exposeInMainWorld("settingsAPI", {
  state: () => ipcRenderer.invoke("settings:state"),
  action: input => ipcRenderer.invoke("settings:action", input),
  onChanged: callback => listen("settings:changed", callback),
  onNavigate: callback => listen("settings:navigate", callback),
});
