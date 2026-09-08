import { useEffect, useState } from 'react';
import { api, ImportSummary } from './api';
import { useStore } from './store';
import { Err } from './ui';

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

export function ImportExport({ onDone }: { onDone?: () => void }) {
  const { refresh, toast } = useStore();
  const [busy, setBusy] = useState('');
  const [err, setErr] = useState('');
  const [summary, setSummary] = useState<ImportSummary | null>(null);
  const [mode, setMode] = useState<'append' | 'replace'>('append');
  const [csvText, setCsvText] = useState('');
  const [driveConfigured, setDriveConfigured] = useState(false);

  useEffect(() => {
    api.driveStatus().then((s) => setDriveConfigured(s.configured)).catch(() => setDriveConfigured(false));
  }, []);

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
      setCsvText(text);
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

  const doDrive = async () => {
    setBusy('Syncing to Drive…');
    setErr('');
    try {
      const res = await api.driveSync();
      toast(`Saved to Drive${res.url ? '' : ''}`);
    } catch (e) {
      setErr(e instanceof Error ? e.message : 'Drive sync failed');
    } finally {
      setBusy('');
    }
  };

  return (
    <div>
      {err && <Err msg={err} />}
      {summary && (
        <div className="summary">
          Imported {summary.inserted} transactions · {summary.accounts} accounts · {summary.categories} categories · {summary.payees} payees · {summary.methods} methods
        </div>
      )}

      <section className="io">
        <h3>Export</h3>
        <div className="iorow">
          <button className="outline" onClick={async () => download('expenses.csv', await api.exportCsv(), 'text/csv')}>
            Download CSV
          </button>
          <button className="outline" onClick={async () => download('expense-manager-backup.json', JSON.stringify(await api.exportJson(), null, 2), 'application/json')}>
            Full backup (JSON)
          </button>
        </div>
      </section>

      <section className="io">
        <h3>Import</h3>
        <div className="iohint">Legacy CSV or the CSV this app exports.</div>
        <div className="segmented mini">
          <button className={mode === 'append' ? 'selected' : ''} onClick={() => setMode('append')}>
            Append
          </button>
          <button className={mode === 'replace' ? 'selected' : ''} onClick={() => setMode('replace')}>
            Replace all
          </button>
        </div>
        <div className="iorow">
          <input type="file" accept=".csv,text/csv" onChange={(e) => onCsvFile(e.target.files?.[0] || null)} />
        </div>
        {mode === 'replace' && <div className="warn">"Replace all" permanently deletes existing data first.</div>}
      </section>

      <section className="io">
        <h3>Restore backup</h3>
        <div className="iohint">Replaces everything with the contents of a full JSON backup.</div>
        <div className="iorow">
          <input type="file" accept="application/json,.json" onChange={(e) => onBackupFile(e.target.files?.[0] || null)} />
        </div>
      </section>

      {driveConfigured && (
        <section className="io">
          <h3>Google Drive</h3>
          <div className="iohint">Push the latest full backup to your Drive.</div>
          <div className="iorow">
            <button className="outline" onClick={doDrive}>
              Sync to Drive
            </button>
          </div>
        </section>
      )}

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
