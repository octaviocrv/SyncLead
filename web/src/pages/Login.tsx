import { useState, type FormEvent } from 'react';
import { Navigate } from 'react-router-dom';
import { Workflow } from 'lucide-react';
import { useAuth } from '../auth';

export default function Login() {
  const { user, login } = useAuth();
  const [identifier, setIdentifier] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  if (user) return <Navigate to="/" replace />;

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await login(identifier.trim(), password);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Falha no login.');
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="login-page">
      <form className="login-box" onSubmit={submit}>
        <div className="brand login-brand">
          <span className="brand-mark"><Workflow size={16} /></span>
          SyncLead
        </div>
        <h1>Entrar</h1>
        <p className="muted">Acompanhamento dos leads Meta Ads</p>

        <label className="field">
          <span>E-mail ou usuário</span>
          <input type="text" autoComplete="username" autoCapitalize="none" spellCheck={false} required value={identifier} onChange={(e) => setIdentifier(e.target.value)} />
        </label>
        <label className="field">
          <span>Senha</span>
          <input type="password" autoComplete="current-password" required value={password} onChange={(e) => setPassword(e.target.value)} />
        </label>

        {error && <p className="error-text" role="alert">{error}</p>}
        <button className="button primary full" type="submit" disabled={busy}>{busy ? 'Entrando…' : 'Entrar'}</button>
        <p className="hint">Acesso restrito. Todo login e consulta a dados pessoais é registrado.</p>
      </form>
    </div>
  );
}
