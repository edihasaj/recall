interface MaintenanceQueueDelta {
  maintenance_tasks_enqueued: number;
  maintenance_tasks_dropped: number;
  maintenance_tasks_invalid: number;
}

interface DispatchBatch {
  attempted: number;
  released: number;
}

export const DISPATCHER_STARTUP_DELAY_MS = 3_000;

/** Drain work left pending across daemon restarts without waiting for the daily fallback tick. */
export function scheduleDispatcherStartupWake(
  dispatch: () => void,
  delayMs = DISPATCHER_STARTUP_DELAY_MS,
): NodeJS.Timeout {
  const timer = setTimeout(dispatch, delayMs);
  timer.unref?.();
  return timer;
}

export function maintenanceCreatedDispatchableTasks(
  result: MaintenanceQueueDelta,
): boolean {
  return result.maintenance_tasks_enqueued
    > result.maintenance_tasks_dropped + result.maintenance_tasks_invalid;
}

export function dispatchBatchNeedsContinuation(
  report: DispatchBatch,
  maxTasksPerRun: number,
): boolean {
  return report.released === 0 && report.attempted >= maxTasksPerRun;
}
