import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { AlertTriangle, XCircle } from 'lucide-react';
import { fetchStorage, formatBytes, type StorageData } from '../api';

// Faixa no topo só quando há risco: aviso a partir de 70% e crítico acima de 85% do disco da VPS.
export default function StorageBanner() {
  const [storage, setStorage] = useState<StorageData | null>(null);

  useEffect(() => {
    const controller = new AbortController();
    const load = () => fetchStorage(controller.signal).then(setStorage).catch(() => undefined);
    void load();
    const timer = setInterval(() => void load(), 60_000);
    return () => { controller.abort(); clearInterval(timer); };
  }, []);

  if (!storage || storage.level === 'ok') return null;
  const critical = storage.level === 'critical';
  return (
    <div className={`storage-banner storage-${storage.level}`} role={critical ? 'alert' : 'status'}>
      {critical ? <XCircle size={16} /> : <AlertTriangle size={16} />}
      <span>
        {critical
          ? `Armazenamento crítico (${storage.percent.toLocaleString('pt-BR')}%). Risco de falha no banco e na aplicação.`
          : `Armazenamento da VPS em ${storage.percent.toLocaleString('pt-BR')}%`}
        {' '}· {formatBytes(storage.usedBytes)} de {formatBytes(storage.totalBytes)}
      </span>
      <Link to="/saude">Ver detalhes</Link>
    </div>
  );
}
