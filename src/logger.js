"use strict";

const fs = require("fs");
const path = require("path");

function createLogger(logDir, options = {}) {
  const maxBytes = options.maxBytes || 1024 * 1024;
  const generations = options.generations || 3;
  const filePath = path.join(logDir, "main.log");

  function rotate() {
    try {
      if (!fs.existsSync(filePath) || fs.statSync(filePath).size < maxBytes) return;
      for (let i = generations - 1; i >= 1; i--) {
        const from = `${filePath}.${i}`;
        const to = `${filePath}.${i + 1}`;
        if (fs.existsSync(from)) fs.renameSync(from, to);
      }
      fs.renameSync(filePath, `${filePath}.1`);
    } catch {}
  }

  function write(level, message, meta) {
    try {
      fs.mkdirSync(logDir, { recursive: true });
      rotate();
      const suffix = meta && typeof meta === "object" ? ` ${JSON.stringify(meta)}` : "";
      fs.appendFileSync(filePath, `${new Date().toISOString()} ${level} ${String(message)}${suffix}\n`, "utf8");
    } catch {}
  }

  return {
    info: (message, meta) => write("INFO", message, meta),
    warn: (message, meta) => write("WARN", message, meta),
    error: (message, meta) => write("ERROR", message, meta),
    filePath,
  };
}

module.exports = { createLogger };
