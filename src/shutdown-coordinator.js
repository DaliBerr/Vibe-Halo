"use strict";

class ShutdownCoordinator {
  constructor(options = {}) {
    this.steps = Array.isArray(options.steps) ? options.steps : [];
    this.logger = options.logger || { warn() {} };
    this.promise = null;
    this.complete = false;
    this.reason = null;
  }

  run(reason = "quit") {
    if (this.promise) return this.promise;
    this.reason = reason;
    this.promise = (async () => {
      for (const step of this.steps) {
        try {
          await step.run(reason);
        } catch (error) {
          this.logger.warn("Shutdown step failed", {
            step: typeof step.name === "string" ? step.name.slice(0, 80) : "unknown",
            code: typeof error?.code === "string" ? error.code.slice(0, 80) : "failed",
          });
        }
      }
      this.complete = true;
    })();
    return this.promise;
  }
}

module.exports = { ShutdownCoordinator };
