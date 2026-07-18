"use strict";

const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("islandAPI", {
  onState: callback => {
    if (typeof callback !== "function") return () => {};
    const handler = (_event, state) => callback(state);
    ipcRenderer.on("island:state", handler);
    return () => ipcRenderer.removeListener("island:state", handler);
  },
  decide: (approvalId, optionId, answers) => ipcRenderer.send("island:decision", { approvalId, optionId, answers }),
  close: id => ipcRenderer.send("island:close", { id }),
  copy: text => ipcRenderer.send("island:copy", { text }),
  view: (id, action, width, height) => ipcRenderer.send("island:view", { id, action, width, height }),
});
