import { useEffect, useState } from 'react';
import { api, ImportSummary } from './api';
import { useStore } from './store';
import { Err } from './ui';
import { fmtDateTime } from './lib';

function download(name: string, text: string, type: string) {
  const blob = new Blob([text], { type });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

type DriveStatus = {
  configured: boolean;
  connected: boolean;
  lastBackupAt: string | null;
  lastBackupError: string | null;
  autoBackup: boolean;
};

export function ImportExport({ onDone }: { onDone?: () => void }) {
  const { refresh, toast } = useStore();
  const [busy, setBusy] = useState('');
  const [err, setErr] = useState('');
  const [summary, setSummary] = useState<ImportSummary | null>(null);
  const [mode, setMode] = useState<'append' | 'replace'>('append');
  const [drive, setDrive] = useState<DriveStatus | null>(null);

  const loadDrive = () =>
    api
      .driveStatus()
      .then(setDrive)
      .catch(() => setDrive(null));
  useEffect(() => {
    loadDrive();
    // Reflect the redirect back from Google (see /api/drive/callback) in the URL.
    const params = new URLSearchParams(window.location.search);
    if (params.get('drive') === 'connected') toast('Google Drive connected');
    if (params.get('drive') === 'error') setErr('Google Drive connection was cancelled or failed.');
    if (params.has('drive')) {
      params.delete('drive');
      const qs = params.toString();
      window.history.replaceState(null, '', window.location.pathname + (qs ? `?${qs}` : ''));
    }
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  const doImport = async (text: string) => {
    setBusy('Importing…');
    setErr('');
    setSummary(null);
    try {
      const s = await api.importCsv(text, mode);
      setSummary(s);
      await refresh();
      toast('Import complete');
    } catch (e) {
      setErr(e instanceof Error ? e.message : 'Import failed');
    } finally {
      setBusy('');
    }
  };

  const onCsvFile = (f: File | null) => {
    if (!f) return;
    const r = new FileReader();
    r.onload = () => {
      const text = String(r.result || '');
      void doImport(text);
    };
    r.readAsText(f);
  };

  const onBackupFile = async (f: File | null) => {
    if (!f) return;
    setBusy('Restoring…');
    setErr('');
    try {
      const text = await f.text();
      const backup = JSON.parse(text);
      const res = await api.restoreBackup(backup);
      await refresh();
      setSummary(null);
      toast(`Restored ${res.restored} records`);
      onDone?.();
    } catch (e) {
      setErr(e instanceof Error ? e.message : 'Restore failed');
    } finally {
      setBusy('');
    }
  };

  const doDriveBackup = async () => {
    setBusy('Backing up to Drive…');
    setErr('');
    try {
      await api.driveBackup();
      await loadDrive();
      toast('Backed up to Google Drive');
    } catch (e) {
      setErr(e instanceof Error ? e.message : 'Drive backup failed');
    } finally {
      setBusy('');
    }
  };

  const doDriveRestore = async () => {
    if (!window.confirm('Restore from your Google Drive backup? This replaces all current data.'))
      return;
    setBusy('Restoring from Drive…');
    setErr('');
    try {
      const res = await api.driveRestore();
      await refresh();
      toast(`Restored ${res.restored} records from Drive`);
      onDone?.();
    } catch (e) {
      setErr(e instanceof Error ? e.message : 'Drive restore failed');
    } finally {
      setBusy('');
    }
  };

  const doDriveDisconnect = async () => {
    setBusy('Disconnecting…');
    try {
      await api.driveDisconnect();
      await loadDrive();
      toast('Google Drive disconnected');
    } catch (e) {
      setErr(e instanceof Error ? e.message : 'Unable to disconnect');
    } finally {
      setBusy('');
    }
  };

  const toggleAutoBackup = async (enabled: boolean) => {
    try {
      await api.driveSetAutoBackup(enabled);
      await loadDrive();
    } catch (e) {
      setErr(e instanceof Error ? e.message : 'Unable to update auto-backup');
    }
  };

  return (
    <div>
      {err && <Err msg={err} />}
      {summary && (
        <div className="summary">
          Imported {summary.inserted} transactions · {summary.accounts} accounts ·{' '}
          {summary.categories} categories · {summary.payees} payees · {summary.methods} methods
        </div>
      )}

      <section className="io">
        <h3>Export</h3>
        <div className="iorow">
          <button
            className="outline"
            onClick={async () => download('expenses.csv', await api.exportCsv(), 'text/csv')}
          >
            Download CSV
          </button>
          <button
            className="outline"
            onClick={async () =>
              download(
                'expense-manager-backup.json',
                JSON.stringify(await api.exportJson(), null, 2),
                'application/json'
              )
            }
          >
            Full backup (JSON)
          </button>
        </div>
      </section>

      <section className="io">
        <h3>Import</h3>
        <div className="iohint">Legacy CSV or the CSV this app exports.</div>
        <div className="segmented">
          <button className={mode === 'append' ? 'selected' : ''} onClick={() => setMode('append')}>
            Append
          </button>
          <button
            className={mode === 'replace' ? 'selected' : ''}
            onClick={() => setMode('replace')}
          >
            Replace all
          </button>
        </div>
        <div className="iorow">
          <input
            type="file"
            accept=".csv,text/csv"
            onChange={(e) => onCsvFile(e.target.files?.[0] || null)}
          />
        </div>
        {mode === 'replace' && (
          <div className="warn">"Replace all" permanently deletes existing data first.</div>
        )}
      </section>

      <section className="io">
        <h3>Restore backup</h3>
        <div className="iohint">Replaces everything with the contents of a full JSON backup.</div>
        <div className="iorow">
          <input
            type="file"
            accept="application/json,.json"
            onChange={(e) => onBackupFile(e.target.files?.[0] || null)}
          />
        </div>
      </section>

      <section className="io">
        <h3>Google Drive</h3>
        {!drive?.configured ? (
          <div className="iohint">
            Google Drive backup isn't set up on this deployment yet. Add GOOGLE_OAUTH_CLIENT_ID /
            GOOGLE_OAUTH_CLIENT_SECRET as Worker secrets to enable it.
          </div>
        ) : !drive.connected ? (
          <>
            <div className="iohint">
              Connect your own Google account. Backups are stored in a file only this app can see,
              in your Drive — Drive is never the live database.
            </div>
            <div className="iorow">
              <a className="outline" href="/api/drive/connect">
                Connect Google Drive
              </a>
            </div>
          </>
        ) : (
          <>
            <div className="iohint">
              Last backup:{' '}
              {drive.lastBackupAt ? fmtDateTime(drive.lastBackupAt) : 'never — run Backup now.'}
            </div>
            {drive.lastBackupError && (
              <div className="iohint" style={{ color: 'var(--danger, #c0392b)' }}>
                Last attempt failed: {drive.lastBackupError}
              </div>
            )}
            <div className="iorow">
              <button className="outline" onClick={doDriveBackup} disabled={!!busy}>
                Backup now
              </button>
              <button className="outline" onClick={doDriveRestore} disabled={!!busy}>
                Restore from Drive
              </button>
              <button className="outline" onClick={doDriveDisconnect} disabled={!!busy}>
                Disconnect
              </button>
            </div>
            <label className="confirmrow" style={{ marginTop: 10 }}>
              <input
                type="checkbox"
                checked={drive.autoBackup}
                onChange={(e) => toggleAutoBackup(e.target.checked)}
              />
              <span>Automatic daily backup</span>
            </label>
          </>
        )}
      </section>

      {onDone && (
        <div className="iorow close">
          <button className="primary" onClick={onDone} disabled={!!busy}>
            {busy || 'Done'}
          </button>
        </div>
      )}
    </div>
  );
}
