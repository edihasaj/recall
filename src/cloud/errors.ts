export type CloudErrorCode =
  | "unavailable"
  | "invalid"
  | "opt-in-required"
  | "legacy-active"
  | "legacy-missing"
  | "legacy-unsupported"
  | "migration-blocked"
  | "encryption-required"
  | "token-missing"
  | "config-invalid"
  | "engine-missing";

/** Error whose message is safe to show in the UI and logs (never carries secrets). */
export class CloudError extends Error {
  constructor(
    message: string,
    readonly code: CloudErrorCode,
    readonly status: number = 400,
  ) {
    super(message);
    this.name = "CloudError";
  }
}
