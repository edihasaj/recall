import { describe, expect, it } from "vitest";
import {
  dispatchBatchNeedsContinuation,
  maintenanceCreatedDispatchableTasks,
} from "../src/maintenance/dispatch-scheduling.js";

describe("maintenance dispatcher scheduling", () => {
  it("wakes only when backlog caps leave new tasks pending", () => {
    expect(maintenanceCreatedDispatchableTasks({
      maintenance_tasks_enqueued: 129,
      maintenance_tasks_dropped: 129,
      maintenance_tasks_invalid: 0,
    })).toBe(false);
    expect(maintenanceCreatedDispatchableTasks({
      maintenance_tasks_enqueued: 109,
      maintenance_tasks_dropped: 99,
      maintenance_tasks_invalid: 0,
    })).toBe(true);
  });

  it("continues a full successful batch but pauses after transient releases", () => {
    expect(dispatchBatchNeedsContinuation({ attempted: 5, released: 0 }, 5)).toBe(true);
    expect(dispatchBatchNeedsContinuation({ attempted: 4, released: 0 }, 5)).toBe(false);
    expect(dispatchBatchNeedsContinuation({ attempted: 5, released: 1 }, 5)).toBe(false);
  });
});
