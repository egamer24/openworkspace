import { LoaderCircle } from "lucide-react";
import { lazy, Suspense } from "react";
import {
  Navigate,
  Route,
  Routes,
  useParams,
} from "react-router";
import { AuthScreen } from "@/auth/auth-screen";
import { AuthCheckError } from "@/auth/auth-check-error";
import { useAuth } from "@/auth/auth-context";
import { MailboxRealtimeConnections } from "@/mail/mailbox-realtime";
import { UnreadDocumentIndicator } from "@/mail/unread-document-indicator";
import { SettingsShell } from "@/settings/settings-shell";

const AccessLinkScreen = lazy(() =>
  import("@/auth/access-link-screen").then((module) => ({ default: module.AccessLinkScreen })),
);
const AdminPage = lazy(() =>
  import("@/admin/admin-page").then((module) => ({ default: module.AdminPage })),
);
const MailShell = lazy(() =>
  import("@/mail/mail-shell").then((module) => ({ default: module.MailShell })),
);
const OriginalMessagePage = lazy(() =>
  import("@/mail/original-message-page").then((module) => ({
    default: module.OriginalMessagePage,
  })),
);
const SettingsAppearancePage = lazy(() =>
  import("@/settings/appearance-page").then((module) => ({
    default: module.AppearanceSettings,
  })),
);
const SettingsMcpPage = lazy(() =>
  import("@/settings/mcp-page").then((module) => ({
    default: module.McpSettings,
  })),
);
const SettingsNotificationsPage = lazy(() =>
  import("@/settings/notifications-page").then((module) => ({
    default: module.NotificationsSettings,
  })),
);
const SettingsProfilePage = lazy(() =>
  import("@/settings/profile-page").then((module) => ({
    default: module.ProfileSettings,
  })),
);
const SettingsRulesPage = lazy(() =>
  import("@/settings/rules-page").then((module) => ({
    default: module.RuleSettings,
  })),
);
const SettingsSessionsPage = lazy(() =>
  import("@/settings/sessions-page").then((module) => ({
    default: module.SessionsSettings,
  })),
);
const OidcConsentScreen = lazy(() =>
  import("@/auth/oidc-consent-screen").then((module) => ({
    default: module.OidcConsentScreen,
  })),
);
const OidcLoginScreen = lazy(() =>
  import("@/auth/oidc-login-screen").then((module) => ({
    default: module.OidcLoginScreen,
  })),
);
const OidcLogoutScreen = lazy(() =>
  import("@/auth/oidc-logout-screen").then((module) => ({
    default: module.OidcLogoutScreen,
  })),
);
const SamlLoginScreen = lazy(() =>
  import("@/auth/saml-login-screen").then((module) => ({
    default: module.SamlLoginScreen,
  })),
);

function MailboxRoute() {
  const { mailboxId } = useParams();
  return <MailShell key={mailboxId ?? "default"} mailboxId={mailboxId} />;
}

function LoadingScreen() {
  return <main className="grid min-h-dvh place-items-center"><LoaderCircle className="animate-spin text-muted-foreground" /></main>;
}

export function App() {
  const auth = useAuth();
  if (auth.loading) return <LoadingScreen />;
  if (auth.error) return <AuthCheckError onRetry={auth.retry} />;
  const mail = auth.authenticated ? <MailboxRoute /> : <AuthScreen />;
  const originalMessage = auth.authenticated
    ? <OriginalMessagePage />
    : <Navigate to="/" replace />;
  const settings = auth.authenticated ? <SettingsShell /> : <Navigate to="/" replace />;
  return (
    <>
      {auth.authenticated ? <MailboxRealtimeConnections /> : null}
      {auth.authenticated ? <UnreadDocumentIndicator /> : null}
      <Suspense fallback={<LoadingScreen />}>
        <Routes>
          <Route path="/invite/:token" element={auth.authenticated ? <Navigate to="/" replace /> : <AccessLinkScreen kind="invitation" />} />
          <Route path="/recover/:token" element={auth.authenticated ? <Navigate to="/" replace /> : <AccessLinkScreen kind="recovery" />} />
          <Route path="/oidc/login/:requestId" element={<OidcLoginScreen />} />
          <Route path="/oidc/consent/:requestId" element={auth.authenticated ? <OidcConsentScreen /> : <AuthScreen />} />
          <Route path="/oidc/logout" element={auth.authenticated ? <OidcLogoutScreen /> : <Navigate to="/" replace />} />
          <Route path="/saml/login/:requestId" element={<SamlLoginScreen />} />
          <Route path="/admin" element={auth.authenticated && auth.user?.role === "admin" ? <AdminPage /> : <Navigate to="/" replace />} />
          <Route path="/settings" element={settings}>
            <Route index element={<Navigate to="/settings/profile" replace />} />
            <Route path="profile" element={<SettingsProfilePage />} />
            <Route path="appearance" element={<SettingsAppearancePage />} />
            <Route path="notifications" element={<SettingsNotificationsPage />} />
            <Route path="rules" element={<SettingsRulesPage />} />
            <Route path="sessions" element={<SettingsSessionsPage />} />
            <Route path="mcp" element={<SettingsMcpPage />} />
          </Route>
          <Route path="/" element={mail} />
          <Route path="/mail/:mailboxId" element={mail} />
          <Route
            path="/mail/:mailboxId/messages/:messageId/original"
            element={originalMessage}
          />
          <Route path="*" element={<Navigate to="/" replace />} />
        </Routes>
      </Suspense>
    </>
  );
}
