import { Navigate, NavLink, Route, Routes, useLocation } from "react-router-dom";
import { Home } from "./pages/Home";
import { Dashboard } from "./pages/Dashboard";
import { NewCase } from "./pages/NewCase";
import { DataLibrary } from "./pages/DataLibrary";
import { Intake } from "./pages/Intake";
import { Workbench } from "./pages/Workbench";
import { AnalysisWorkbench } from "./pages/AnalysisWorkbench";
import { Report } from "./pages/Report";
import { Diff } from "./pages/Diff";
import { Landing } from "./pages/Landing";
import { Tracks } from "./pages/Tracks";
import { AuthGate, UserChip } from "./auth";

export function App() {
  // "/welcome" is public — checked ahead of AuthGate so it never requires
  // sign-in, regardless of Clerk config. Plain pathname check (not a nested
  // <Routes>) to avoid RR v6 descendant-route path ambiguity. Strip a
  // trailing slash first — "/welcome/" (a trailing-slash bookmark, or a
  // browser/CDN normalizing the URL) must still match, or it falls through
  // to AuthedApp and Clerk redirects to its hosted sign-in instead.
  const location = useLocation();
  const path = location.pathname.length > 1 ? location.pathname.replace(/\/+$/, "") : location.pathname;
  if (path === "/welcome") {
    return <Landing />;
  }
  return <AuthedApp />;
}

function AuthedApp() {
  return (
    <AuthGate>
      <div className="app">
        <aside className="rail">
          <div className="wordmark">VariantGPT</div>
          <nav>
            <NavLink to="/" end>Home</NavLink>
            <NavLink to="/cases">Cases</NavLink>
            <NavLink to="/cases/new">New Case</NavLink>
            <NavLink to="/data">Data</NavLink>
            <NavLink to="/tracks">Tracks &amp; Settings</NavLink>
          </nav>
          <div style={{ marginTop: "auto", paddingTop: 16 }}>
            <UserChip />
          </div>
        </aside>
        <main className="main">
          <Routes>
            <Route path="/" element={<Home />} />
            <Route path="/cases" element={<Dashboard />} />
            <Route path="/cases/new" element={<NewCase />} />
            <Route path="/cases/new/intake" element={<Intake />} />
            <Route path="/data" element={<DataLibrary />} />
            <Route path="/cases/:caseId" element={<Workbench />} />
            <Route path="/cases/:caseId/analysis" element={<AnalysisWorkbench />} />
            <Route path="/cases/:caseId/report" element={<Report />} />
            <Route path="/cases/:caseId/diff" element={<Diff />} />
            <Route path="/tracks" element={<Tracks />} />
            {/* Catch-all: any unmatched path (e.g. a Clerk SSO callback route,
                a stale bookmark, or a hard refresh on an unknown URL) lands on
                Home instead of rendering a blank <main>. */}
            <Route path="*" element={<Navigate to="/" replace />} />
          </Routes>
        </main>
      </div>
    </AuthGate>
  );
}
