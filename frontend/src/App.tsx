import { FormEvent, useEffect, useState } from "react";
import { NavLink, Route, Routes } from "react-router-dom";
import { clearApiKey, getApiKey, saveApiKey } from "./apiKey";
import { AttentionPage } from "./pages/AttentionPage";
import { BoardPage } from "./pages/BoardPage";
import { ProjectsPage } from "./pages/ProjectsPage";

export default function App() {
  const [apiKey, setApiKey] = useState(() => getApiKey());
  const [showAccessKey, setShowAccessKey] = useState(false);

  useEffect(() => {
    const syncKey = () => setApiKey(getApiKey());
    window.addEventListener("storage", syncKey);
    return () => window.removeEventListener("storage", syncKey);
  }, []);

  function handleKeySaved(key: string) {
    setApiKey(key);
    setShowAccessKey(false);
  }

  function handleKeyCleared() {
    clearApiKey();
    setApiKey(null);
    setShowAccessKey(false);
  }

  return (
    <div className="app-shell">
      <header className="topbar">
        <NavLink className="brand" to="/" aria-label="Relay home">
          <span className="brand-mark">R</span>
          <span>relay</span>
        </NavLink>
        {apiKey && <nav aria-label="Main navigation">
          <NavLink end to="/">Board</NavLink>
          <NavLink to="/projects">Projects</NavLink>
          <NavLink to="/attention">Attention queue</NavLink>
        </nav>}
        <span className="topbar-note">AI work, in motion</span>
        {apiKey && <button className="access-key-button" type="button" onClick={() => setShowAccessKey(true)}>Access key</button>}
      </header>
      <main>
        {apiKey ? <Routes>
          <Route path="/" element={<BoardPage />} />
          <Route path="/projects" element={<ProjectsPage />} />
          <Route path="/attention" element={<AttentionPage />} />
        </Routes> : <ApiKeyOnboarding onSave={handleKeySaved} />}
      </main>
      {showAccessKey && <ApiKeyDialog onClose={() => setShowAccessKey(false)} onSave={handleKeySaved} onClear={handleKeyCleared} />}
    </div>
  );
}

interface ApiKeyFormProps {
  onSave: (key: string) => void;
}

function ApiKeyForm({ onSave }: ApiKeyFormProps) {
  const [key, setKey] = useState("");
  const [error, setError] = useState("");

  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError("");
    try {
      onSave(saveApiKey(key));
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "Could not save the API key.");
    }
  }

  return <form className="api-key-form" onSubmit={submit}>
    <label htmlFor="api-key">API key
      <input id="api-key" value={key} onChange={(event) => setKey(event.target.value)} autoComplete="off" autoFocus placeholder="Paste the key here" />
    </label>
    {error && <div className="error-banner" role="alert">{error}</div>}
    <button className="button button-primary" type="submit">Save key and continue</button>
  </form>;
}

function ApiKeyOnboarding({ onSave }: ApiKeyFormProps) {
  return <section className="api-key-onboarding">
    <div className="api-key-intro">
      <p className="eyebrow">One-time setup</p>
      <h1>Your workspace,<br /><em>connected.</em></h1>
      <p className="lede">Relay needs the API key for your local tracker before it can show your work.</p>
      <div className="key-instructions">
        <span className="instruction-number">01</span>
        <p>Start the backend. It prints an <strong>Initial API key</strong> once in the terminal.</p>
        <span className="instruction-number">02</span>
        <p>Copy that key and paste it here. It is saved only in this browser, not in the built app.</p>
      </div>
    </div>
    <div className="api-key-card surface">
      <div className="form-heading"><div><span className="section-kicker">Connect Relay</span><p>Paste the key from the backend terminal.</p></div><span className="form-star">✦</span></div>
      <ApiKeyForm onSave={onSave} />
      <p className="key-footnote">You can replace or clear this key later from the Access key menu.</p>
    </div>
  </section>;
}

interface ApiKeyDialogProps extends ApiKeyFormProps {
  onClose: () => void;
  onClear: () => void;
}

function ApiKeyDialog({ onClose, onSave, onClear }: ApiKeyDialogProps) {
  return <div className="modal-backdrop access-key-backdrop" role="presentation" onMouseDown={onClose}>
    <section className="access-key-dialog" role="dialog" aria-modal="true" aria-label="Access key settings" onMouseDown={(event) => event.stopPropagation()}>
      <div className="detail-topline"><div><span className="section-kicker">Access key</span><h2>Connection settings</h2></div><button className="icon-button" type="button" onClick={onClose} aria-label="Close access key settings">×</button></div>
      <p className="dialog-copy">Replace the saved key if the backend key was rotated. The key stays in this browser only.</p>
      <ApiKeyForm onSave={onSave} />
      <div className="clear-key-row"><div><strong>Forget this browser</strong><p>Clear the saved key and return to setup.</p></div><button className="button button-quiet" type="button" onClick={onClear}>Clear key</button></div>
    </section>
  </div>;
}
