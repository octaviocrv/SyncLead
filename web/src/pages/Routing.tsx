import { formStoreMappings, leadForm, stores } from '../data';
import { PageHeader, Section } from '../components/ui';

export default function Routing() {
  return (
    <>
      <PageHeader
        title="Regras de Roteamento"
        subtitle="A loja escolhida no formulário determina a empresa de destino no Syonet."
      />

      <Section
        title={leadForm.name}
        subtitle={`Formulário Meta ${leadForm.id} · pergunta: “${leadForm.storeQuestion}”`}
      >
        <table className="table">
          <thead>
            <tr>
              <th>Resposta no formulário</th>
              <th>Empresa no Syonet</th>
              <th>companyId</th>
              <th>Situação</th>
            </tr>
          </thead>
          <tbody>
            {formStoreMappings.map((mapping) => {
              const store = stores.find((item) => item.id === mapping.storeId);
              if (!store) {
                throw new Error(`Loja não encontrada para a resposta "${mapping.answer}".`);
              }

              return (
                <tr key={mapping.answer}>
                  <td className="cell-title">{mapping.answer}</td>
                  <td>{store.name}</td>
                  <td className="muted">{store.syonetId}</td>
                  <td>
                    <span className={`badge ${store.active ? 'badge-novo' : 'badge-neutral'}`}>
                      {store.active ? 'Mapeada' : 'Bloqueada — unidade inativa'}
                    </span>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </Section>

      <p className="note">
        O formulário já pergunta qual loja deve atender o lead, portanto o roteamento não usa a cidade.
        A opção “GM Ubá” está bloqueada porque o companyId 8 aparece como inativo na documentação
        recebida. Confirme a situação antes de habilitar o envio para essa unidade.
      </p>
    </>
  );
}
