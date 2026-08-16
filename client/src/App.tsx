import { NavLink, Route, Routes, Navigate } from 'react-router-dom';
import { useApiKey } from './lib/useApiKey';
import Submit from './pages/Submit';
import DocumentView from './pages/DocumentView';
import Replay from './pages/Replay';

export default function App() {
  const [apiKey, setApiKey] = useApiKey();

  return (
    <>
      <header className="app-header">
        <span className="brand">Conflict Resolution Engine</span>
        <nav className="app-nav">
          <NavLink to="/submit" className={({ isActive }) => (isActive ? 'active' : '')}>
            Submit
          </NavLink>
          <NavLink to="/document" className={({ isActive }) => (isActive ? 'active' : '')}>
            Document
          </NavLink>
          <NavLink to="/replay" className={({ isActive }) => (isActive ? 'active' : '')}>
            Replay
          </NavLink>
        </nav>
        <div className="api-key-field">
          <label htmlFor="api-key-input">X-API-Key</label>
          <input
            id="api-key-input"
            type="text"
            placeholder="paste demo key from server/.env"
            value={apiKey}
            onChange={(e) => setApiKey(e.target.value)}
            size={28}
          />
        </div>
      </header>
      <main className="app-main">
        <Routes>
          <Route path="/" element={<Navigate to="/submit" replace />} />
          <Route path="/submit" element={<Submit apiKey={apiKey} />} />
          <Route path="/document" element={<DocumentView />} />
          <Route path="/replay" element={<Replay apiKey={apiKey} />} />
        </Routes>
      </main>
    </>
  );
}
