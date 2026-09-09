import { useState } from 'react';
import { api, ApiError } from './api';
import { useStore } from './store';

export function Login() {
  const { refresh } = useStore();
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setErr('');
    try {
      await api.login(password);
      setPassword('');
      await refresh();
    } catch (ex) {
      setErr(ex instanceof ApiError ? ex.message : 'Unable to sign in.');
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="loginscreen">
      <form className="loginbox" onSubmit={submit}>
        <div className="mark loginmark">₹</div>
        <h1>Expenses</h1>
        <p>Enter the app password to continue.</p>
        {err && <div className="error">{err}</div>}
        <input
          type="password"
          autoFocus
          placeholder="Password"
          value={password}
          onChange={(e) => setPassword(e.target.value)}
        />
        <button type="submit" className="save" disabled={busy || !password}>
          {busy ? 'Checking…' : 'Unlock'}
        </button>
      </form>
    </div>
  );
}
