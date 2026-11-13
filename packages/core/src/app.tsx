import { LoaderCircle } from "lucide-react";
import { Fragment, lazy, Suspense, useEffect, useState } from "react";
import type { ReactNode } from "react";
import { Navigate, Route, Routes } from "react-router";

import { SAML_LOGIN_PAGE } from "../shared/paths";
import { AuthCheckError } from "./auth/auth-check-error";
import { useAuth } from "./auth/auth-context";
import { AuthScreen } from "./auth/auth-screen";
import { clientModules, modulesPreloaded, preloadModules } from "./modules";
import { SettingsShell } from "./settings/settings-shell";

const AccessLinkScreen = lazy(() =>
  import("./auth/access-link-screen").then((module) => ({
    default: module.AccessLinkScreen,
  }))
);

const AdminPage = lazy(() =>
  import("./admin/admin-page").then((module) => ({ default: module.AdminPage }))
);

const HomePage = lazy(() =>
  import("./home-page").then((module) => ({ default: module.HomePage }))
);

const SettingsAppearancePage = lazy(() =>
  import("./settings/appearance-page").then((module) => ({
    default: module.AppearanceSettings,
  }))
);

const SettingsConnectedAppsPage = lazy(() =>
  import("./settings/connected-apps-page").then((module) => ({
    default: module.ConnectedAppsSettings,
  }))
);

const SettingsMcpPage = lazy(() =>
  import("./settings/mcp-page").then((module) => ({
    default: module.McpSettings,
  }))
);

const SettingsProfilePage = lazy(() =>
  import("./settings/profile-page").then((module) => ({
    default: module.ProfileSettings,
  }))
);

const SettingsSessionsPage = lazy(() =>
  import("./settings/sessions-page").then((module) => ({
    default: module.SessionsSettings,
  }))
);

const OidcConsentScreen = lazy(() =>
  import("./auth/oidc-consent-screen").then((module) => ({
    default: module.OidcConsentScreen,
  }))
);

const OidcLoginScreen = lazy(() =>
  import("./auth/oidc-login-screen").then((module) => ({
    default: module.OidcLoginScreen,
  }))
);

const OidcLogoutScreen = lazy(() =>
  import("./auth/oidc-logout-screen").then((module) => ({
    default: module.OidcLogoutScreen,
  }))
);

const SamlLoginScreen = lazy(() =>
  import("./auth/saml-login-screen").then((module) => ({
    default: module.SamlLoginScreen,
  }))
);

/** Shown while the session or a screen's code loads; it fades in late so quick loads don't flash. */
function LoadingScreen() {
  return (
    <main
      className="bg-background relative grid min-h-dvh place-items-center"
      role="status"
      aria-label="Loading"
    >
      <div
        aria-hidden="true"
        className="bg-dot-grid absolute inset-0 [animation:fade-in_0.25s_ease-out_0.3s_both] opacity-0"
      />
      <span className="relative [animation:fade-in_0.25s_ease-out_0.3s_both] opacity-0">
        <LoaderCircle className="text-muted-foreground animate-spin" />
      </span>
    </main>
  );
}

export function App() {
  const auth = useAuth();
  const [modulesReady, setModulesReady] = useState(modulesPreloaded);
  useEffect(() => {
    if (!modulesReady) void preloadModules().then(() => setModulesReady(true));
  }, [modulesReady]);

  // Signed-in screens wait for the modules' preloaded code (started with the
  // session check in main.tsx) so they render without a Suspense fallback.
  if (auth.loading || (auth.authenticated && !modulesReady)) {
    return <LoadingScreen />;
  }

  if (auth.error) return <AuthCheckError onRetry={auth.retry} />;
  const modules = clientModules();

  const Home =
    modules.find((module) => module.home)?.home?.Component ?? HomePage;

  const signedIn = (element: ReactNode) =>
    auth.authenticated ? element : <AuthScreen />;

  const settings = auth.authenticated ? (
    <SettingsShell />
  ) : (
    <Navigate to="/" replace />
  );

  // A different account (or none) starts the app afresh, with no screen state
  // left from the previous one.
  return (
    <Fragment key={auth.user?.id ?? "signed-out"}>
      {auth.authenticated
        ? modules.map(({ name, background: Background }) =>
            Background ? (
              <Suspense key={name} fallback={null}>
                <Background />
              </Suspense>
            ) : null
          )
        : null}
      <Suspense fallback={<LoadingScreen />}>
        <Routes>
          <Route
            path="/invite/:token"
            element={
              auth.authenticated ? (
                <Navigate to="/" replace />
              ) : (
                <AccessLinkScreen kind="invitation" />
              )
            }
          />
          <Route
            path="/recover/:token"
            element={
              auth.authenticated ? (
                <Navigate to="/" replace />
              ) : (
                <AccessLinkScreen kind="recovery" />
              )
            }
          />
          <Route path="/oidc/login/:requestId" element={<OidcLoginScreen />} />
          <Route
            path="/oidc/consent/:requestId"
            element={
              auth.authenticated ? <OidcConsentScreen /> : <AuthScreen />
            }
          />
          <Route
            path="/oidc/logout"
            element={
              auth.authenticated ? (
                <OidcLogoutScreen />
              ) : (
                <Navigate to="/" replace />
              )
            }
          />
          <Route
            path={`${SAML_LOGIN_PAGE}/:requestId`}
            element={<SamlLoginScreen />}
          />
          <Route
            path="/admin/:section?/:id?"
            element={
              auth.authenticated && auth.user?.permissions.length ? (
                <AdminPage />
              ) : (
                <Navigate to="/" replace />
              )
            }
          />
          <Route path="/settings" element={settings}>
            <Route
              index
              element={<Navigate to="/settings/profile" replace />}
            />
            <Route path="profile" element={<SettingsProfilePage />} />
            <Route path="appearance" element={<SettingsAppearancePage />} />
            {modules
              .flatMap((module) => module.settings ?? [])
              .map(({ id, Component }) => (
                <Route key={id} path={id} element={<Component />} />
              ))}
            <Route path="sessions" element={<SettingsSessionsPage />} />
            <Route path="mcp" element={<SettingsMcpPage />} />
            <Route
              path="connected-apps"
              element={<SettingsConnectedAppsPage />}
            />
          </Route>
          <Route path="/" element={signedIn(<Home />)} />
          {modules
            .flatMap((module) => module.routes ?? [])
            .map(({ path, Component }) => (
              <Route key={path} path={path} element={signedIn(<Component />)} />
            ))}
          <Route path="*" element={<Navigate to="/" replace />} />
        </Routes>
      </Suspense>
    </Fragment>
  );
}
