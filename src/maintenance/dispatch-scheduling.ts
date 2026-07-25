interface MaintenanceQueueDelta {
  maintenance_tasks_enqueued: number;
  maintenance_tasks_dropped: number;
  maintenance_tasks_invalid: number;
}

interface DispatchBatch {
  attempted: number;
  released: number;
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
