import { useState } from 'react';
import type { Lead } from '../data';
import { isPending, useLeads } from '../leads';
import { PageHeader, Section, StatusBadge } from '../components/ui';
import LeadDrawer from '../components/LeadDrawer';

export default function Pending() {
  const { leads } = useLeads();
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const pending = leads.filter(isPending);
  const selected: Lead | null = leads.find((l) => l.id === selectedId) ?? null;

  return (
    <>
      <PageHeader
        title="Pendências"
        subtitle="Leads com erro ou aguardando nova tentativa. Nenhum lead é descartado."
      />

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
