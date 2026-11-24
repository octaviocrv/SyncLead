import { useEffect, useMemo, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { stores, statusLabel, type Lead, type LeadStatus } from '../data';
import { useLeads } from '../leads';
import { PageHeader, Section } from '../components/ui';
import LeadTable from '../components/LeadTable';
import LeadDrawer from '../components/LeadDrawer';

const dayMs = 86_400_000;

export default function Leads() {
  const [params] = useSearchParams();
  const { leads, loading } = useLeads();
  const [query, setQuery] = useState(params.get('q') ?? '');
  const [status, setStatus] = useState<LeadStatus | ''>('');
  const [store, setStore] = useState('');
  const [days, setDays] = useState('30');
  const [selectedId, setSelectedId] = useState<string | null>(null);

  useEffect(() => setQuery(params.get('q') ?? ''), [params]);

  const rows = useMemo(() => {
    const q = query.trim();
    const since = days ? Date.now() - Number(days) * dayMs : 0;
    return leads.filter(
      (l) =>
        (!q || l.id.includes(q) || (l.name ?? '').toLowerCase().includes(q.toLowerCase())) &&
        (!status || l.status === status) &&
        (!store || l.store === store) &&
        new Date(l.receivedAtIso).getTime() >= since,
    );
  }, [leads, query, status, store, days]);

  const selected: Lead | null = leads.find((l) => l.id === selectedId) ?? null;

  return (
    <>
      <PageHeader title="Leads" subtitle="Todos os leads recebidos do Meta e o resultado do processamento." />

      <div className="filters">
        <input placeholder="ID do lead (leadgen_id) ou nome" value={query} onChange={(e) => setQuery(e.target.value)} />
        <select value={status} onChange={(e) => setStatus(e.target.value as LeadStatus | '')}>
          <option value="">Todos os status</option>
          {Object.entries(statusLabel).map(([value, label]) => (
            <option key={value} value={value}>{label}</option>
          ))}
        </select>
        <select value={store} onChange={(e) => setStore(e.target.value)}>
          <option value="">Todas as lojas</option>
          {stores.map((s) => <option key={s.id} value={s.name}>{s.name}</option>)}
        </select>
        <select value={days} onChange={(e) => setDays(e.target.value)}>
          <option value="1">Últimas 24 horas</option>
          <option value="7">Últimos 7 dias</option>
          <option value="30">Últimos 30 dias</option>
          <option value="">Todo o período</option>
        </select>
      </div>

      <Section title={`${rows.length} lead(s)`}>
        <LeadTable rows={rows} onSelect={(l) => setSelectedId(l.id)} emptyText={loading ? 'Carregando…' : 'Nenhum lead encontrado.'} />
      </Section>

      <LeadDrawer lead={selected} onClose={() => setSelectedId(null)} />
    </>
  );
}
