import { NavLink, Route, Routes, Navigate } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import { api } from "./lib/api";
import { MemoriesPage } from "./pages/MemoriesPage";
import { GraphPage } from "./pages/GraphPage";
import { TimelinePage } from "./pages/TimelinePage";
import { SessionsPage } from "./pages/SessionsPage";
import { ContradictionsPage } from "./pages/ContradictionsPage";

export function App() {
  const health = useQuery({
    queryKey: ["health"],
    queryFn: () => api.health(),
    refetchInterval: 15_000,
  });

  return (
    <div className="layout">
      <aside className="sidebar">
        <div className="brand">
          <img src="/recall-icon.png" alt="" className="brand-logo" />
          <span className="brand-name">Recall</span>
        </div>
        <nav className="nav">
          <NavLink to="/memories" className="nav-link">Memories</NavLink>
          <NavLink to="/graph" className="nav-link">Graph</NavLink>
          <NavLink to="/timeline" className="nav-link">Timeline</NavLink>
          <NavLink to="/sessions" className="nav-link">Sessions</NavLink>
          <NavLink to="/contradictions" className="nav-link">Contradictions</NavLink>
        </nav>
        <footer className="sidebar-footer">
          <div className="health">
            <span className={`health-dot ${health.data ? "ok" : "stale"}`} />
            <span className="health-text">
              {health.data ? `daemon ${health.data.version}` : "no daemon"}
            </span>
          </div>
        </footer>
      </aside>
      <main className="content">
        <Routes>
          <Route path="/" element={<Navigate to="/memories" replace />} />
          <Route path="/memories" element={<MemoriesPage />} />
          <Route path="/memories/:id" element={<MemoriesPage />} />
          <Route path="/graph" element={<GraphPage />} />
          <Route path="/timeline" element={<TimelinePage />} />
          <Route path="/sessions" element={<SessionsPage />} />
          <Route path="/contradictions" element={<ContradictionsPage />} />
        </Routes>
      </main>
    </div>
  );
}
