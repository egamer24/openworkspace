import type { EmailEnv } from "../alchemy/index";
import type { OfficePreviewContainer } from "./mail/office-preview-container";
import type { MailboxDO } from "./mailbox/index";

/** The classes behind the namespaces, which Alchemy's side does not import. */
type EmailClassBindings = {
  MAILBOX: DurableObjectNamespace<MailboxDO>;
  OFFICE_PREVIEW_CONTAINER: DurableObjectNamespace<OfficePreviewContainer>;
};

declare global {
  /** The mail module's bindings, derived from what `Email()` declares (`EmailEnv`). */
  interface Env
    extends Omit<EmailEnv, keyof EmailClassBindings>, EmailClassBindings {}
}
