import { NavLink, Route, Routes } from "react-router-dom";
import { Home } from "./pages/Home";
import { Dashboard } from "./pages/Dashboard";
import { Intake } from "./pages/Intake";
import { Workbench } from "./pages/Workbench";
import { AnalysisWorkbench } from "./pages/AnalysisWorkbench";
import { Report } from "./pages/Report";
import { Diff } from "./pages/Diff";
import { AuthGate, UserChip } from "./auth";

export function App() {
  return (
    <AuthGate>
      <div className="app">
        <aside className="rail">
          <div className="wordmark">VariantGPT</div>
          <nav>
            <NavLink to="/" end>Home</NavLink>
            <NavLink to="/cases">Cases</NavLink>
            <NavLink to="/cases/new">New Case</NavLink>
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
            <Route path="/cases/new" element={<Intake />} />
            <Route path="/cases/:caseId" element={<Workbench />} />
            <Route path="/cases/:caseId/analysis" element={<AnalysisWorkbench />} />
            <Route path="/cases/:caseId/report" element={<Report />} />
            <Route path="/cases/:caseId/diff" element={<Diff />} />
            <Route path="/tracks" element={<TracksStub />} />
          </Routes>
        </main>
      </div>
    </AuthGate>
  );
}

function TracksStub() {
  return (
    <>
      <div className="topbar"><h1>Tracks &amp; Settings</h1></div>
      <div className="card">Population tracks (IndiGenomes, GenomeAsia, GenomeIndia), predictor versions, ACMG threshold overrides.</div>
    </>
  );
}
