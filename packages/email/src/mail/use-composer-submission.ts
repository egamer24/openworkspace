import { ApiError } from "@open-workspace/core/ui";
import { useEffect, useRef } from "react";
import { toast } from "sonner";

import { isComposerSessionBusy } from "./composer-session";
import type { ComposerSession, ComposerSessionPhase } from "./composer-session";
import { useMailSend, withMailSendRequestId } from "./use-mail-send";
import type { MailSendDraft, SubmittedMessage } from "./use-mail-send";

export type PreparedComposerSubmission = {
  assetIds: string[];
  command: MailSendDraft;
  submissionKey: string;
};

/**
 * Owns the shared preflight -> submit -> release/complete transition. Draft
 * preparation remains composer-specific, but transport ownership has one path.
 */
export function useComposerSubmission(input: {
  session: ComposerSession;
  phase: ComposerSessionPhase;
  validate: () => string | null;
  prepare: (signal: AbortSignal) => Promise<PreparedComposerSubmission>;
  failureLabel: string;
  onSuccess: (result: SubmittedMessage) => void;
}) {
  const { send } = useMailSend();
  const mounted = useRef(true);
  const preflightRequest = useRef<AbortController | null>(null);

  useEffect(() => {
    mounted.current = true;

    return () => {
      mounted.current = false;
      preflightRequest.current?.abort();
    };
  }, []);

  async function submit() {
    const validationError = input.validate();

    if (validationError) {
      toast.error(validationError);

      return;
    }

    if (!input.session.beginPreflight()) return;

    const controller = new AbortController();
    preflightRequest.current = controller;

    const preparation = await input.prepare(controller.signal).then(
      (prepared) => ({ prepared }),
      (cause: unknown) => ({ cause })
    );

    if (preflightRequest.current === controller) {
      preflightRequest.current = null;
    }

    if ("cause" in preparation) {
      if (!controller.signal.aborted) input.session.cancelPreflight();

      if (controller.signal.aborted || !mounted.current) return;
      const { cause } = preparation;
      toast.error(cause instanceof Error ? cause.message : input.failureLabel);

      return;
    }

    const { prepared } = preparation;

    if (controller.signal.aborted || !mounted.current) {
      input.session.cancelPreflight();

      return;
    }

    const requestId = input.session.beginSubmission(
      prepared.assetIds,
      prepared.submissionKey
    );

    if (!requestId) return;

    let result: SubmittedMessage;

    try {
      result = await send.mutateAsync(
        withMailSendRequestId(prepared.command, requestId)
      );
    } catch (error) {
      // The continuation can outlive React after a mailbox switch. Session
      // ownership still has to be released even when no UI remains.
      input.session.releaseSubmission(
        !(error instanceof ApiError) || error.status >= 500
      );

      if (!mounted.current) return;
      toast.error(error instanceof Error ? error.message : input.failureLabel);

      return;
    }

    input.session.completeSubmission();

    if (mounted.current) input.onSuccess(result);
  }

  return {
    busy: isComposerSessionBusy(input.phase),
    submit,
  };
}
