import { PageHeader, Section } from '../components/ui';

const integrations = [
  {
    name: 'Meta Lead Ads',
    description: 'Webhook leadgen inscrito na Página; leads são validados pela Graph API.',
    status: 'Webhook ativo',
    fields: [
      ['Página', 'Grupo Cacel Consórcio · 372411372613737'],
      ['Formulário', 'Cacel | Forms | Lojas 2026 (17/08)'],
      ['ID do formulário', '1030408329895026'],
      ['Webhook', 'https://cacl-leads-200-141-21-218.sslip.io/api/webhooks/meta'],
    ],
  },
  {
    name: 'CRM Syonet',
    description: 'O YAML descreve a API Lead de produção; a chave de acesso ainda não foi fornecida.',
    status: 'Envio desligado',
    fields: [
      ['Endpoint documentado', 'POST https://api.syonet.com/crm/v1/lead/ (produção)'],
      ['Autenticação', 'Cabeçalho apikey — chave não configurada'],
      ['Grupo / tipo de evento', 'OPORTUNIDADE / CONSORCIO WEB (referência do PDF)'],
      ['Mídia do lead', 'Graph API platform fb/ig → FACEBOOK/INSTAGRAM'],
      ['Origem Syonet', 'A confirmar com a integração'],
      ['Reutilização de evento aberto', 'Período a definir antes de ativar o envio'],
    ],
  },
];

export default function Integrations() {
  return (
    <>
      <PageHeader
        title="Integrações"
        subtitle="Conexões com o Meta e o Syonet. Credenciais ficam somente no servidor."
      />

      {integrations.map((i) => (
        <Section
          key={i.name}
          title={i.name}
          subtitle={i.description}
          action={<span className="badge badge-pendente">{i.status}</span>}
        >
          <dl className="details padded">
            {i.fields.map(([k, v]) => (
              <div key={k} className="details-row">
                <dt>{k}</dt>
                <dd>{v}</dd>
              </div>
            ))}
          </dl>
          <div className="section-foot">
            <button className="button" disabled>Testar conexão</button>
          </div>
        </Section>
      ))}
    </>
  );
}
