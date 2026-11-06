import { z } from "zod";
import {
  driveLinkAccess,
  driveRoles,
  driveSorts,
  MAX_DRIVE_NAME_LENGTH,
  MAX_DRIVE_UPLOAD_BYTES,
} from "../../shared/drive";

export const driveIdSchema = z.string().trim().min(1).max(64);

// Names become path segments in breadcrumbs and Content-Disposition headers.
export const driveNameSchema = z
  .string()
  .trim()
  .min(1)
  .max(MAX_DRIVE_NAME_LENGTH)
  .refine((value) => value !== "." && value !== ".." && !/[/\\\u0000-\u001f]/u.test(value), {
    message: "Name cannot contain slashes or control characters",
  });

export const driveListQuerySchema = z.object({
  view: z.enum(["files", "trash", "shared"]).default("files"),
  parentId: driveIdSchema.optional(),
  search: z.string().trim().max(200).optional(),
  sort: z.enum(driveSorts).default("name"),
  order: z.enum(["asc", "desc"]).default("asc"),
});

export const createDriveFolderSchema = z.object({
  parentId: driveIdSchema.nullable().default(null),
  name: driveNameSchema,
});

export const createDriveUploadSchema = z.object({
  parentId: driveIdSchema.nullable().default(null),
  name: driveNameSchema,
  contentType: z.string().trim().max(255).default(""),
  size: z.number().int().positive().max(MAX_DRIVE_UPLOAD_BYTES),
});

export const updateDriveItemSchema = z.object({
  name: driveNameSchema.optional(),
  // null moves to the owner's root.
  parentId: driveIdSchema.nullable().optional(),
}).refine((value) => value.name !== undefined || value.parentId !== undefined, {
  message: "Nothing to update",
});

export const driveShareSchema = z.object({
  email: z.string().trim().min(3).max(320),
  role: z.enum(driveRoles),
});

export const createDriveLinkSchema = z.object({
  access: z.enum(driveLinkAccess).default("download"),
  expiresAt: z.number().int().positive().nullable().default(null),
  password: z.string().min(4).max(128).nullable().default(null),
});

export const saveAttachmentToDriveSchema = z.object({
  mailboxId: z.string().min(1),
  messageId: z.string().min(1),
  attachmentId: z.string().min(1),
  parentId: driveIdSchema.nullable().default(null),
});

export const driveToggleSchema = z.object({
  enabled: z.boolean(),
});

export const driveQuotaSchema = z.object({
  // null resets the user to the default quota.
  quotaBytes: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER).nullable(),
});
