"use strict";

const fs = require("node:fs");
const path = require("node:path");
const wait = ms => new Promise(resolve => setTimeout(resolve, ms));

// Only the explicitly requested demo/smoke path uses these helpers.
function createSmokeTasks(timeoutMs = 15000) {
  const tasks = [];
  return {
    schedule(delay, run) {
      // Observe errors immediately, even before finish() starts waiting.
      tasks.push(wait(delay).then(run).then(() => ({ ok: true }), error => ({ error })));
    },
    async finish() {
      let timer;
      try {
        const results = await Promise.race([
          Promise.all(tasks),
          new Promise((_, reject) => { timer = setTimeout(() => reject(new Error("Smoke tasks timed out")), timeoutMs); }),
        ]);
        const failure = results.find(result => !result.ok);
        if (failure) throw failure.error;
      } finally { clearTimeout(timer); }
    },
  };
}

async function captureSmokeWindow(win, destination, readyExpression = "true") {
  const deadline = Date.now() + 10000;
  while (Date.now() < deadline) {
    if (win.isDestroyed()) throw new Error("Smoke window was destroyed before capture");
    if (!win.webContents.isLoadingMainFrame() && await win.webContents.executeJavaScript(`document.readyState === 'complete' && (${readyExpression})`)) {
      const image = await win.webContents.capturePage();
      if (!image.isEmpty()) {
        const png = image.toPNG();
        if (png.length) {
          fs.mkdirSync(path.dirname(destination), { recursive: true });
          fs.writeFileSync(destination, png);
          return;
        }
      }
    }
    await wait(80);
  }
  throw new Error("Smoke window did not produce a loaded, nonempty screenshot");
}

module.exports = { createSmokeTasks, captureSmokeWindow };
