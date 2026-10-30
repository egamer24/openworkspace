import { z } from "zod";
import { branchPushPolicies, isValidRepositoryName } from "../../shared/code";

/** Conservative subset of `git check-ref-format --branch`. */
const BRANCH_NAME_PATTERN = /^(?!\/|.*(?:\/\/|\/$|\.\.|@\{|\.lock$|\/\.))[A-Za-z0-9._/-]{1,200}$/u;

export const branchNameSchema = z.string()
  .trim()
  .regex(BRANCH_NAME_PATTERN, "Enter a valid branch name");

export const repositoryNameSchema = z.string()
  .trim()
  .toLowerCase()
  .refine(
    isValidRepositoryName,
    "Use lowercase letters, digits, dots, hyphens, and underscores",
  );

export const createRepositorySchema = z.object({
  name: repositoryNameSchema,
  description: z.string().trim().max(500).nullish()
    .transform((value) => value || null),
  defaultBranch: branchNameSchema.default("main"),
});

const branchPatternSchema = z.string()
  .trim()
  .min(1)
  .max(200)
  .regex(/^[A-Za-z0-9._/*-]+$/u, "Use branch name characters and *");

export const branchProtectionsSchema = z.object({
  rules: z.array(z.object({
    pattern: branchPatternSchema,
    push: z.enum(branchPushPolicies),
    allowDeletion: z.boolean().default(false),
  }))
    .max(50)
    .refine(
      (rules) => new Set(rules.map((rule) => rule.pattern)).size === rules.length,
      "Each pattern may only appear once",
    ),
});

export const updateRepositorySchema = z.object({
  description: z.string().trim().max(500).nullable().optional()
    .transform((value) => (value === undefined ? undefined : value || null)),
});

export const createBranchSchema = z.object({
  name: branchNameSchema,
  from: z.string().trim().min(1).max(255),
});
