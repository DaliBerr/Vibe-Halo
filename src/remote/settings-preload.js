"use strict";
const { contextBridge, ipcRenderer } = require("electron");
contextBridge.exposeInMainWorld("mobileSettings", {
  action: input => ipcRenderer.invoke("mobile-settings:action", input),
  onChanged: callback => { const listener = (_event, value) => callback(value); ipcRenderer.on("mobile-settings:changed", listener); return () => ipcRenderer.removeListener("mobile-settings:changed", listener); },
});
