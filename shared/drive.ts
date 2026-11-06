/** Single-request uploads only; matches the Worker request body limit on most plans. */
export const MAX_DRIVE_UPLOAD_BYTES = 100_000_000;
export const DEFAULT_DRIVE_QUOTA_BYTES = 5_000_000_000;
export const MAX_DRIVE_NAME_LENGTH = 255;

export const driveRoles = ["viewer", "editor"] as const;
export type DriveRole = (typeof driveRoles)[number];
export const driveLinkAccess = ["view", "download"] as const;
export const driveSorts = ["name", "date", "size"] as const;
