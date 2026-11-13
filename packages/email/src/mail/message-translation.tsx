import { responseJson } from "@open-workspace/core/ui";
import { useMutation } from "@tanstack/react-query";
import { Languages, LoaderCircle } from "lucide-react";
import { useMemo, useState } from "react";
import { toast } from "sonner";

import {
  MAX_TRANSLATION_CHARACTERS,
  MAX_TRANSLATION_SEGMENTS,
} from "../../shared/mail-translation";
import { mailApi } from "../lib/mail-api";
import { EmailHtmlBody, messageTextClassName } from "./email-html-body";
import { emailHtmlTextSegments } from "./translation-html";
import { browserLanguage, COMMON_LANGUAGES } from "./translation-language";
import type { MessageDetail } from "./types";
import { useSanitizedEmailHtml } from "./use-sanitized-email-html";

type TranslationResult = {
  messageId: string;
  language: string;
  translations: string[];
};

export function languageName(code: string) {
  return (
    new Intl.DisplayNames([browserLanguage()], { type: "language" }).of(code) ??
    code
  );
}

export type MessageTranslationState = ReturnType<typeof useMessageTranslation>;

/**
 * Translation state for one message: which language was requested, the cached
 * result, and whether the translated text is currently shown.
 */
export function useMessageTranslation(
  message: MessageDetail,
  mailboxId?: string
) {
  const [language, setLanguage] = useState(browserLanguage);
  const [result, setResult] = useState<TranslationResult | null>(null);
  const [showTranslation, setShowTranslation] = useState(false);
  const html = useSanitizedEmailHtml(mailboxId ?? "", message);

  const sourceHtml =
    message.direction === "incoming"
      ? html.data?.renderAsHtml
        ? html.data.srcDoc
        : null
      : html.data?.composerHtml || null;

  const segments = useMemo(
    () =>
      sourceHtml
        ? emailHtmlTextSegments(sourceHtml)
        : [message.bodyText || message.preview].filter((text) =>
            Boolean(text.trim())
          ),
    [message.bodyText, message.preview, sourceHtml]
  );

  const mutation = useMutation({
    mutationFn: async ({
      targetLanguage,
      textSegments,
    }: {
      targetLanguage: string;
      textSegments: string[];
    }) => {
      const response = await mailApi.api.mail.messages[":id"].translate.$post({
        param: { id: message.id },
        query: { mailboxId: mailboxId ?? "" },
        json: { language: targetLanguage, segments: textSegments },
      });

      return responseJson(response);
    },
  });

  const cached = result?.messageId === message.id ? result : null;
  const visible = showTranslation && cached?.language === language;

  const languages = COMMON_LANGUAGES.includes(language)
    ? COMMON_LANGUAGES
    : [language, ...COMMON_LANGUAGES];

  async function translate(targetLanguage = language) {
    setLanguage(targetLanguage);

    if (cached?.language === targetLanguage) {
      setShowTranslation(true);

      return;
    }

    setShowTranslation(false);

    if (!segments.length) {
      toast.error("Message has no text to translate");

      return;
    }

    if (
      segments.length > MAX_TRANSLATION_SEGMENTS ||
      segments.join("").length > MAX_TRANSLATION_CHARACTERS
    ) {
      toast.error("Message is too long to translate");

      return;
    }

    try {
      const response = await mutation.mutateAsync({
        targetLanguage,
        textSegments: segments,
      });

      setResult({
        messageId: message.id,
        language: targetLanguage,
        translations: response.translations,
      });
      setShowTranslation(true);
    } catch (error) {
      toast.error(
        error instanceof Error
          ? error.message
          : "Could not translate this message"
      );
    }
  }

  return {
    available: Boolean(mailboxId && (message.bodyText || message.bodyHtml)),
    ready: !(message.bodyHtml && html.isPending),
    pending: mutation.isPending,
    language,
    languages,
    /** Translated text is cached for the current language. */
    hasResult: cached?.language === language,
    visible,
    translations: visible ? cached.translations : undefined,
    sourceHtml,
    translate,
    showOriginal: () => setShowTranslation(false),
  };
}

/** Slim status line shown above a message body while translating or translated. */
export function TranslationBar({
  translation,
}: {
  translation: MessageTranslationState;
}) {
  if (!translation.pending && !translation.visible) return null;

  return (
    <div
      role="status"
      className="bg-surface-sunken text-muted-foreground ring-border mb-3 flex min-h-8 max-w-[72ch] items-center gap-2 rounded-md px-2.5 py-1.5 text-xs ring-1"
    >
      {translation.pending ? (
        <LoaderCircle className="size-3.5 shrink-0 animate-spin" />
      ) : (
        <Languages className="text-primary size-3.5 shrink-0" />
      )}
      <span className="min-w-0 flex-1 truncate">
        {translation.pending
          ? `Translating to ${languageName(translation.language)}…`
          : `Translated to ${languageName(translation.language)}`}
      </span>
      {translation.visible && (
        <button
          type="button"
          className="text-foreground focus-visible:ring-ring shrink-0 rounded-sm font-medium outline-none hover:underline focus-visible:ring-2"
          onClick={translation.showOriginal}
        >
          Show original
        </button>
      )}
    </div>
  );
}

/** Message body: sanitized HTML, composer HTML or plain text, translated in place when requested. */
export function MessageBody({
  message,
  mailboxId,
  translation,
}: {
  message: MessageDetail;
  mailboxId?: string;
  translation: MessageTranslationState;
}) {
  if (!mailboxId || !(message.bodyText || message.bodyHtml)) {
    return (
      <div className={messageTextClassName}>
        {message.bodyText ||
          (message.quotedText
            ? "No new text"
            : message.preview || "No text body")}
      </div>
    );
  }

  const { translations } = translation;

  if (message.bodyHtml && (!translations || translation.sourceHtml)) {
    return (
      <EmailHtmlBody
        mailboxId={mailboxId}
        message={message}
        translations={translations}
      />
    );
  }

  return (
    <div className={messageTextClassName}>
      {translations ? translations[0] : message.bodyText}
    </div>
  );
}
