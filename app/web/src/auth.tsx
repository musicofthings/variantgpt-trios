/** Clerk OAuth integration — single source of truth for the SPA's auth state.
 *
 * Setup:
 *   1. Create a Clerk application at https://dashboard.clerk.com
 *   2. In the app's API Keys panel, copy the "Publishable key"
 *   3. Set the environment variable VITE_CLERK_PUBLISHABLE_KEY in:
 *        - app/web/.env.local (local dev)
 *        - the Cloudflare Pages deploy environment vars (production)
 *      Both should hold the same key (publishable keys are public; the
 *      secret key never leaves the Worker).
 *   4. Configure allowed redirect URLs in Clerk:
 *        http://localhost:5173  (Vite dev)
 *        https://<your-pages-app>.pages.dev
 *
 * Behavior:
 *   - If VITE_CLERK_PUBLISHABLE_KEY is NOT set, AuthGate is a pass-through
 *     (the app loads unauthenticated). This keeps dev/local builds working
 *     until the user provisions Clerk.
 *   - If the key IS set, signed-out users see Clerk's hosted sign-in UI;
 *     signed-in users see the app shell with their avatar in the sidebar.
 *
 * Token passing to the Worker is wired separately in apiBase.ts (next step
 * — Clerk's `useAuth().getToken()` JWT goes into the Authorization header
 * so the Worker can validate against Clerk's JWKS).
 */
import { ReactNode, useEffect } from "react";
import {
  ClerkProvider,
  RedirectToSignIn,
  SignedIn,
  SignedOut,
  UserButton,
  useAuth,
  useUser,
} from "@clerk/clerk-react";
import { setTokenProvider } from "./apiBase";

const PUBLISHABLE_KEY = (import.meta.env.VITE_CLERK_PUBLISHABLE_KEY as string | undefined) || "";

/** Root auth wrapper. When Clerk is configured, signed-out users get
 *  redirected to the hosted sign-in page; signed-in users see `children`. */
export function AuthGate({ children }: { children: ReactNode }) {
  // Dev/local fallback — when no Clerk key is set, render the app
  // unauthenticated so local development isn't blocked.
  if (!PUBLISHABLE_KEY) {
    return (
      <>
        <DevModeNotice />
        {children}
      </>
    );
  }

  return (
    <ClerkProvider publishableKey={PUBLISHABLE_KEY}>
      <SignedIn>
        <TokenBridge />
        {children}
      </SignedIn>
      <SignedOut>
        <RedirectToSignIn />
      </SignedOut>
    </ClerkProvider>
  );
}

/** Bridges Clerk's `useAuth().getToken()` into the apiBase module so any
 *  `apiFetch(...)` call (anywhere in the app) automatically picks up a
 *  fresh JWT. Mounted inside <SignedIn> so the hook is guaranteed to be
 *  authenticated when this component renders. */
function TokenBridge() {
  const { getToken } = useAuth();
  useEffect(() => {
    setTokenProvider(async () => {
      try {
        return await getToken();
      } catch {
        return null;
      }
    });
    return () => setTokenProvider(null);
  }, [getToken]);
  return null;
}

/** Small chip rendered at the bottom of the sidebar. Shows the user's
 *  avatar + name when signed in (via Clerk's UserButton) or a muted
 *  "dev mode — auth disabled" label when no Clerk key is configured. */
export function UserChip() {
  if (!PUBLISHABLE_KEY) {
    return (
      <div
        style={{
          fontSize: 11,
          color: "var(--ink-soft)",
          padding: "8px 4px",
          borderTop: "1px solid var(--border)",
        }}
        title="Set VITE_CLERK_PUBLISHABLE_KEY to enable Clerk auth"
      >
        Dev mode<br />
        <span style={{ opacity: 0.7 }}>auth disabled</span>
      </div>
    );
  }
  return <ClerkUserChip />;
}

function ClerkUserChip() {
  const { user, isLoaded } = useUser();
  if (!isLoaded) return null;
  return (
    <div
      style={{
        display: "flex",
        alignItems: "center",
        gap: 8,
        padding: "8px 4px",
        borderTop: "1px solid var(--border)",
        fontSize: 12,
      }}
    >
      <UserButton afterSignOutUrl="/" />
      <div style={{ overflow: "hidden", whiteSpace: "nowrap", textOverflow: "ellipsis" }}>
        <div style={{ fontWeight: 500 }}>
          {user?.firstName ?? user?.username ?? "—"}
        </div>
        <div style={{ color: "var(--ink-soft)", fontSize: 11 }}>
          {user?.primaryEmailAddress?.emailAddress ?? ""}
        </div>
      </div>
    </div>
  );
}

/** Tiny banner shown when running without Clerk configured. Keeps the
 *  unauthenticated dev experience while making it obvious auth is off. */
function DevModeNotice() {
  return (
    <div
      style={{
        position: "fixed",
        bottom: 8,
        right: 12,
        fontSize: 10,
        color: "var(--ink-soft)",
        background: "var(--surface)",
        border: "1px solid var(--border)",
        borderRadius: 4,
        padding: "3px 8px",
        zIndex: 1000,
        letterSpacing: "0.04em",
        textTransform: "uppercase",
      }}
    >
      Auth disabled · dev mode
    </div>
  );
}
