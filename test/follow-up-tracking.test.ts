import { describe, expect, it } from "vitest";
import {
  checkTrackedFollowUps,
  followUpTaskId,
  parseTaskRegister,
} from "../src/follow-up-tracking.js";

const register = JSON.stringify({
  schemaVersion: 1,
  tasks: [
    { id: "PC-006", status: "ready" },
    { id: "PC-007", status: "blocked" },
    { id: "H07-003", status: "in_progress" },
    { id: "PC-005", status: "completed" },
  ],
});

describe("tracked follow-ups", () => {
  it("reads the leading task ID", () => {
    expect(followUpTaskId("PC-006: Deploy Paperclip on the host")).toBe(
      "PC-006",
    );
    expect(followUpTaskId("H07-003: Verify the installer")).toBe("H07-003");
    expect(followUpTaskId("Deploy Paperclip on the host")).toBeUndefined();
    expect(followUpTaskId("PC-006 Deploy")).toBeUndefined();
    expect(followUpTaskId("PC-006:")).toBeUndefined();
  });

  it("accepts follow-ups that name open tasks", () => {
    expect(() =>
      checkTrackedFollowUps(
        ["PC-006: Deploy", "PC-007: Qualify", "H07-003: Verify"],
        register,
      ),
    ).not.toThrow();
    expect(() => checkTrackedFollowUps([], undefined)).not.toThrow();
  });

  it("refuses untracked, unknown and completed references", () => {
    expect(() => checkTrackedFollowUps(["Deploy it"], register)).toThrow(
      "must start with the ID of the open task",
    );
    expect(() => checkTrackedFollowUps(["PC-006: Deploy"], undefined)).toThrow(
      "Ask the user where to track the action",
    );
    expect(() => checkTrackedFollowUps(["PC-999: Deploy"], register)).toThrow(
      "PC-999, which is not a task",
    );
    expect(() => checkTrackedFollowUps(["PC-005: Deploy"], register)).toThrow(
      "PC-005, which is completed",
    );
  });

  it("rejects an unreadable register", () => {
    expect(() => parseTaskRegister("{")).toThrow("not valid JSON");
    expect(() => parseTaskRegister("{}")).toThrow("no tasks list");
  });
});
