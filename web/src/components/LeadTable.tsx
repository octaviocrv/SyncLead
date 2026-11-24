import type { Lead } from '../data';
import { StatusBadge } from './ui';

export default function LeadTable({ rows, onSelect, emptyText = 'Nenhum lead encontrado.' }: {
  rows: Lead[];
  onSelect: (lead: Lead) => void;
  emptyText?: string;
}) {
  if (rows.length === 0) return <p className="empty">{emptyText}</p>;

  return (
    <table className="table">
      <thead>
        <tr>
          <th>Lead</th>
          <th>Contato</th>
          <th>Cidade</th>
          <th>Destino</th>
          <th>Recebido</th>
          <th>Status</th>
        </tr>
      </thead>
      <tbody>
        {rows.map((lead) => (
          <tr key={lead.id} onClick={() => onSelect(lead)} className="clickable">
            <td>
              <div className="cell-title">
                {lead.name ?? lead.id}
                {lead.isTest && <span className="badge badge-test" title="Sem anúncio: ferramenta de teste da Meta ou orgânico. Fora das métricas.">Teste</span>}
                {lead.recovered && <span className="badge badge-recovered" title="O webhook não entregou; recuperado pela conferência com a Meta. Só é enviado ao Syonet após autorização de um administrador.">Recuperado</span>}
                {lead.recurrentCount > 0 && <span className="badge badge-recurrent" title="Este telefone ou e-mail já enviou lead(s) anterior(es) pelo SyncLead. Não indica cliente no Syonet.">Recorrente ({lead.recurrentCount})</span>}
              </div>
              <div className="cell-sub">
                {lead.name ? `${lead.id} · ` : ''}{lead.origin}
                {lead.customerCheck ? ` · Cliente: ${lead.customerCheck.result === 'new' ? 'novo' : lead.customerCheck.result === 'existing' ? 'existente' : 'não identificado'} (conferido)` : ''}
              </div>
            </td>
            <td>
              <div>{lead.phoneMasked ?? '—'}</div>
              <div className="cell-sub">{lead.emailMasked ?? (lead.hasPersonalData ? '—' : 'Sem dados guardados')}</div>
            </td>
            <td>{lead.city}</td>
            <td>{lead.store}</td>
            <td className="muted">{lead.receivedAt}</td>
            <td><StatusBadge status={lead.status} /></td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}
