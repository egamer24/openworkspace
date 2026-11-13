import { required } from "@open-workspace/core/shared";
import { useDebouncedValue, responseJson } from "@open-workspace/core/ui";
import { useEffect, useEffectEvent } from "react";

import type { ReplyActionMode } from "../../shared/mail";
import { mailApi } from "../lib/mail-api";
import type { ComposerAsset, ComposerSession } from "./composer-session";

const textEncoder = new TextEncoder();

export type PreflightContext =
  | {
      kind: "compose";
      mailboxId: string;
      subject: string;
      bodyText: string;
      bodyHtml?: string;
    }
  | {
      kind: "forward";
      mailboxId: string;
      sourceEmailId: string;
      bodyText: string;
      bodyHtml?: string;
    }
  | {
      kind: "reply";
      mailboxId: string;
      sourceEmailId: string;
      mode: ReplyActionMode;
      cc: string[];
      bcc: string[];
      bodyText: string;
      bodyHtml?: string;
    };

function byteLength(value: string | undefined) {
  return value ? textEncoder.encode(value).byteLength : 0;
}

function preflightContextSignature(context: PreflightContext) {
  const content = [
    byteLength(context.bodyText),
    byteLength(context.bodyText.trimEnd()),
    byteLength(context.bodyHtml),
  ];

  if (context.kind === "compose") {
    return [
      "compose",
      context.mailboxId,
      byteLength(context.subject.trim()),
      ...content,
    ];
  }

  if (context.kind === "forward") {
    return ["forward", context.mailboxId, context.sourceEmailId, ...content];
  }

  return [
    "reply",
    context.mailboxId,
    context.sourceEmailId,
    context.mode,
    context.cc,
    context.bcc,
    ...content,
  ];
}

function composerPlanKey(
  context: PreflightContext,
  assets: readonly ComposerAsset[]
) {
  return JSON.stringify([
    preflightContextSignature(context),
    assets.map((asset) => [
      asset.id,
      asset.uploadId,
      asset.intent,
      asset.contentId,
    ]),
  ]);
}

async function preflightComposerAttachments(
  context: PreflightContext,
  assets: readonly ComposerAsset[],
  signal?: AbortSignal
) {
  return responseJson(
    await mailApi.api.mail["attachment-preflight"].$post(
      {
        json: {
          ...context,
          attachments: assets.map((asset) => ({
            uploadId: required(
              asset.uploadId,
              "Attachments are preflighted once uploaded"
            ),
            disposition: asset.intent,
            // JSON leaves an undefined content ID out.
            contentId: asset.contentId || undefined,
          })),
        },
      },
      { init: { signal } }
    )
  );
}

/**
 * Fetches and publishes one revision-tagged plan. Both the debounced preview
 * and the final send check use this path, so they cannot drift apart.
 */
export async function resolveComposerAttachmentPlan(
  session: ComposerSession,
  context: PreflightContext,
  assets: readonly ComposerAsset[],
  signal?: AbortSignal
) {
  const planKey = composerPlanKey(context, assets);
  session.beginPlan(planKey);

  if (!assets.length) {
    session.resolvePlan(planKey, []);

    return;
  }

  try {
    const result = await preflightComposerAttachments(context, assets, signal);
    const linkedUploadIds = new Set(result.linkedUploadIds);
    session.resolvePlan(
      planKey,
      assets.flatMap((asset) =>
        asset.uploadId && linkedUploadIds.has(asset.uploadId) ? [asset.id] : []
      )
    );
  } catch (error) {
    if (!signal?.aborted) session.failPlan(planKey);
    throw error;
  }
}

/**
 * Preflight only publishes a revision-tagged delivery plan to the session.
 * ProseMirror subscribes to that plan directly, so React never rewrites nodes.
 */
export function useComposerAttachmentPreflight(
  session: ComposerSession,
  context: PreflightContext,
  assets: readonly ComposerAsset[],
  active = true
) {
  const requestKey = composerPlanKey(context, assets);
  const debouncedRequestKey = useDebouncedValue(requestKey, 750);

  // Reads this render's context and assets, which requestKey names.
  const resolvePlan = useEffectEvent((signal: AbortSignal) => {
    if (!assets.length || assets.some((asset) => !asset.uploadId)) return;
    void resolveComposerAttachmentPlan(session, context, assets, signal).catch(
      () => {
        // Background preflight is advisory. Final submission reports failures.
      }
    );
  });

  useEffect(() => {
    if (!active) return;
    session.beginPlan(requestKey);

    if (!assets.length) session.resolvePlan(requestKey, []);
  }, [active, assets.length, requestKey, session]);

  useEffect(() => {
    if (!active || requestKey !== debouncedRequestKey) return;
    const controller = new AbortController();
    resolvePlan(controller.signal);

    return () => controller.abort();
  }, [active, debouncedRequestKey, requestKey]);
}
