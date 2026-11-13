// Core's styles first, so modules' stylesheets follow them.
import "./styles.css";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { BrowserRouter } from "react-router";

import { required } from "../shared/invariant";
import { App } from "./app";
import { AuthProvider } from "./auth/auth-context";
import { Toaster } from "./components/ui/sonner";
import { preloadModules } from "./modules";
import { registerServiceWorker } from "./pwa/register-service-worker";

registerServiceWorker();

// Most visits are signed in: fetch the modules' first screens alongside the
// session check instead of after it.
void preloadModules();

const queryClient = new QueryClient({
  defaultOptions: { queries: { staleTime: 15_000, retry: 1 } },
});

createRoot(
  required(document.querySelector("#root"), "index.html has no #root element")
).render(
  <StrictMode>
    <QueryClientProvider client={queryClient}>
      <BrowserRouter>
        <AuthProvider>
          <App />
          <Toaster position="bottom-right" />
        </AuthProvider>
      </BrowserRouter>
    </QueryClientProvider>
  </StrictMode>
);
