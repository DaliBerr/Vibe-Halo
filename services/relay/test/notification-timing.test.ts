import { describe, it, expect, vi } from "vitest";
import { notificationTiming } from "../src/notification-timing";

describe("notification timing", () => {
  it("logs only scalar correlation fields and remains fail-open", () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    try {
      notificationTiming("relay_fcm_accepted", "evt_test", 1, 12);
      const row = JSON.parse(log.mock.calls[0][0]);
      expect(row.elapsedMs).toBe(12);
      expect(Object.keys(row).sort()).toEqual(["atMs", "code", "elapsedMs", "eventId", "host", "revision", "stage"]);
      notificationTiming("relay_fcm_accepted", { token: "private" }, 1);
      expect(log).toHaveBeenCalledTimes(1);
      log.mockImplementation(() => { throw new Error("unavailable"); });
      expect(() => notificationTiming("relay_fcm_accepted", "evt_test", 1)).not.toThrow();
    } finally { log.mockRestore(); }
  });
});
