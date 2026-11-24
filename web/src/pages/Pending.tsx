import { useState } from 'react';
import type { Lead, LeadStatus } from '../data';
import { isPending, useLeads } from '../leads';
import { PageHeader, Section, StatusBadge } from '../components/ui';
import LeadDrawer from '../components/LeadDrawer';

export default function Pending() {
  const { leads } = useLeads();
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [filter, setFilter] = useState<'todas' | LeadStatus>('todas');
  const all = leads.filter(isPending);
  const rank = (l: Lead) => (['incerto', 'erro', 'revisao', 'pendente'] as LeadStatus[]).indexOf(l.status);
  const pending = all.filter((l) => filter === 'todas' || l.status === filter).sort((a, b) => rank(a) - rank(b));
  const count = (s: LeadStatus) => all.filter((l) => l.status === s).length;
  const chips: Array<['todas' | LeadStatus, string, number]> = [
    ['todas', 'Todas', all.length],
    ['incerto', 'Resultado incerto', count('incerto')],
    ['erro', 'Recusados / erro', count('erro')],
    ['revisao', 'Em revisão', count('revisao')],
    ['pendente', 'Nova tentativa', count('pendente')],
  ];
  const selected: Lead | null = leads.find((l) => l.id === selectedId) ?? null;

  return (
    <>
      <PageHeader
        title="Pendências"
        subtitle="Leads que precisam de atenção: resultado incerto, recusados, em revisão ou aguardando nova tentativa. Nenhum lead é descartado."
      />

      <div className="segmented chips">
        {chips.map(([value, label, n]) => (
          <button key={value} className={filter === value ? 'active' : ''} onClick={() => setFilter(value)}>{label} ({n})</button>
        ))}
      </div>

      <Section title={`${pending.length} pendência(s)`}>
        {pending.length === 0 ? (
          <p className="empty">Nenhuma pendência no momento.</p>
        ) : (
          <table className="table">
            <thead>
              <tr>
                <th>Lead (Meta)</th>
                <th>Destino</th>
                <th>Última mensagem</th>
                <th>Etapas</th>
                <th>Status</th>
              </tr>
            </thead>
            <tbody>
              {pending.map((lead) => (
                <tr key={lead.id} className="clickable" onClick={() => setSelectedId(lead.id)}>
                  <td>
                    <div className="cell-title">{lead.id}</div>
                    <div className="cell-sub">{lead.receivedAt}</div>
                  </td>
                  <td>{lead.store}</td>
                  <td className="muted">{lead.lastError ?? lead.attempts.at(-1)?.message ?? '—'}</td>
                  <td>{lead.attempts.length}</td>
                  <td><StatusBadge status={lead.status} /></td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </Section>

      <LeadDrawer lead={selected} onClose={() => setSelectedId(null)} />
    </>
  );
}
