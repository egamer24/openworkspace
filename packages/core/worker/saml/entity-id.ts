import { sql } from "drizzle-orm";

import { violatesConstraintOn } from "../db/errors";
import { samlApplications, samlPairwiseSubjects } from "../db/schema";

/**
 * The value to set a SAML app's Entity ID to in an update (or an upsert's
 * update). Once the app has issued a persistent NameID, the pairwise
 * subjects are bound to its Entity ID, so a different one becomes NULL and
 * the NOT NULL column fails the statement, and the batch around it, atomically.
 * `entityIdLocked` recognizes that failure.
 */
export function lockedEntityId(entityId: string) {
  return sql`CASE
    WHEN ${samlApplications.entityId} = ${entityId}
      OR NOT EXISTS (
        SELECT 1 FROM ${samlPairwiseSubjects}
        WHERE ${samlPairwiseSubjects.applicationId} = ${samlApplications.id}
      )
    THEN ${entityId}
  END`;
}

/** Whether a write failed because it tried to change a locked Entity ID (`lockedEntityId`). */
export function entityIdLocked(cause: unknown) {
  return violatesConstraintOn(cause, "saml_applications.entity_id", "NOT NULL");
}

export const ENTITY_ID_LOCKED_MESSAGE =
  "SAML Entity ID cannot change after a persistent NameID has been issued";
