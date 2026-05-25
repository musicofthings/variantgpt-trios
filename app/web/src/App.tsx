import { NavLink, Route, Routes } from "react-router-dom";
import { Dashboard } from "./pages/Dashboard";
import { Intake } from "./pages/Intake";
import { Workbench } from "./pages/Workbench";
import { Report } from "./pages/Report";

export function App() {
  return (
    <div className="app">
      <aside className="rail">
        <div className="wordmark">VariantGPT</div>
        <nav>
          <NavLink to="/" end>Cases</NavLink>
          <NavLink to="/cases/new">New Case</NavLink>
          <NavLink to="/tracks">Tracks &amp; Settings</NavLink>
        </nav>
      </aside>
      <main className="main">
        <Routes>
          <Route path="/" element={<Dashboard />} />
          <Route path="/cases/new" element={<Intake />} />
          <Route path="/cases/:caseId" element={<Workbench />} />
          <Route path="/cases/:caseId/report" element={<Report />} />
          <Route path="/tracks" element={<TracksStub />} />
        </Routes>
      </main>
    </div>
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
