import type { BranchProtectionRule } from "../../shared/code";
import type { SessionUser } from "../env";
import { ZERO_OID, type RefUpdateCommand } from "./pkt-line";

const BRANCH_PREFIX = "refs/heads/";
const TAG_PREFIX = "refs/tags/";

/** `*` matches within one path segment, `**` across segments. */
function globToRegExp(pattern: string) {
  let source = "";
  for (let index = 0; index < pattern.length; index += 1) {
    const character = pattern[index]!;
    if (character === "*") {
      if (pattern[index + 1] === "*") {
        source += ".*";
        index += 1;
      } else {
        source += "[^/]*";
      }
    } else {
      source += character.replace(/[.+?^${}()|[\]\\]/u, "\\$&");
    }
  }
  return new RegExp(`^${source}$`, "u");
}

export function matchingRules(branch: string, rules: BranchProtectionRule[]) {
  return rules.filter((rule) => globToRegExp(rule.pattern).test(branch));
}

function branchRejection(
  user: SessionUser,
  command: RefUpdateCommand,
  branch: string,
  rules: BranchProtectionRule[],
) {
  const deleting = ZERO_OID.test(command.newOid);
  for (const rule of matchingRules(branch, rules)) {
    if (deleting && !rule.allowDeletion) return "protected branch cannot be deleted";
    if (rule.push === "integration") {
      return "protected branch is updated only by the integration queue";
    }
    if (rule.push === "admins" && user.role !== "admin") {
      return "protected branch requires an administrator";
    }
  }
  return null;
}

/**
 * Decides which ref updates in a push are allowed before Artifacts receives
 * any objects. Returns a reason for every rejected ref; an empty map allows the
 * push. Pushes are all-or-nothing so a partial result never lands.
 *
 * Force-push detection needs object ancestry, which the proxy does not see;
 * branches that must not be rewritten use the `integration` or `admins` policy.
 */
export function authorizeRefUpdates(
  user: SessionUser,
  commands: RefUpdateCommand[],
  rules: BranchProtectionRule[],
) {
  const reasons = new Map<string, string>();
  for (const command of commands) {
    if (command.ref.startsWith(BRANCH_PREFIX)) {
      const reason = branchRejection(
        user,
        command,
        command.ref.slice(BRANCH_PREFIX.length),
        rules,
      );
      if (reason) reasons.set(command.ref, reason);
    } else if (command.ref.startsWith(TAG_PREFIX)) {
      if (!ZERO_OID.test(command.oldOid) && user.role !== "admin") {
        reasons.set(command.ref, "only administrators may move or delete tags");
      }
    } else {
      reasons.set(command.ref, "refs outside branches and tags are reserved");
    }
  }
  if (reasons.size > 0) {
    for (const command of commands) {
      if (!reasons.has(command.ref)) {
        reasons.set(command.ref, "atomic push failed");
      }
    }
  }
  return reasons;
}
