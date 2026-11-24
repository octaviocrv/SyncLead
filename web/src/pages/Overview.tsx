import { useState } from 'react';
import { Link } from 'react-router-dom';
import { ArrowDown, ShieldCheck, CheckCircle2, AlertCircle } from 'lucide-react';
import type { Lead } from '../data';
import { isPending, useLeads } from '../leads';
import { PageHeader, Section } from '../components/ui';
import LeadTable from '../components/LeadTable';
import LeadDrawer from '../components/LeadDrawer';

export default function Overview() {
  const [selected, setSelected] = useState<Lead | null>(null);
  const { leads: allLeads, loading, syonetDelivery } = useLeads();
  // Métricas consideram só leads de anúncio; testes aparecem na lista com selo próprio.
  const leads = allLeads.filter((l) => !l.isTest);
  const tests = allLeads.length - leads.length;

  const validated = leads.filter((l) => l.metaProcessedAt !== '—').length;
  const sent = leads.filter((l) => l.status === 'enviado').length;
  const metrics = [
    { label: 'Leads recebidos', value: leads.length, hint: tests ? `De anúncios · ${tests} de teste fora da conta` : 'De anúncios', icon: ArrowDown, tone: 'blue' },
    { label: 'Validados na Meta', value: validated, hint: 'Dados completos lidos na Graph API', icon: ShieldCheck, tone: 'blue' },
    {
      label: 'Enviados ao Syonet',
      value: sent,
      hint: syonetDelivery === 'enabled' ? 'Eventos criados no CRM' : 'Envio ao Syonet desligado',
      icon: CheckCircle2,
      tone: 'green',
    },
    { label: 'Pendências', value: leads.filter(isPending).length, hint: 'Erros ou aguardando retry', icon: AlertCircle, tone: 'red' },
  ];

  return (
    <>
      <PageHeader title="Visão Geral" subtitle="Fluxo de leads entre o Meta Ads e o CRM Syonet." />

      <div className="metrics">
        {metrics.map(({ label, value, hint, icon: Icon, tone }) => (
          <div key={label} className="metric">
            <div className="metric-head">
              <span>{label}</span>
              <Icon size={16} className={`tone-${tone}`} />
            </div>
            <strong>{value}</strong>
            <small>{hint}</small>
          </div>
        ))}
      </div>

      <Section
        title="Últimos leads recebidos"
        subtitle="Atualizado automaticamente a cada 10 segundos."
        action={<Link to="/leads" className="link">Ver todos</Link>}
      >
        <LeadTable
          rows={allLeads.slice(0, 5)}
          onSelect={setSelected}
          emptyText={loading ? 'Carregando…' : 'Nenhum lead recebido ainda.'}
        />
      </Section>

      <LeadDrawer lead={selected} onClose={() => setSelected(null)} />
    </>
  );
}
