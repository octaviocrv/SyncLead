import { stores } from '../data';
import { PageHeader, Section } from '../components/ui';

export default function Stores() {
  return (
    <>
      <PageHeader
        title="Lojas"
        subtitle="Unidades identificadas no Syonet e disponíveis para roteamento."
      />

      <Section title={`${stores.length} loja(s)`}>
        <table className="table">
          <thead>
            <tr>
              <th>Loja</th>
              <th>Marca</th>
              <th>Cidade</th>
              <th>ID no Syonet</th>
              <th>Situação</th>
            </tr>
          </thead>
          <tbody>
            {stores.map((s) => (
              <tr key={s.id}>
                <td className="cell-title">{s.name}</td>
                <td>{s.brand}</td>
                <td>{s.city}</td>
                <td className="muted">{s.syonetId}</td>
                <td><span className={`badge ${s.active ? 'badge-novo' : 'badge-neutral'}`}>{s.active ? 'Ativa' : 'Inativa'}</span></td>
              </tr>
            ))}
          </tbody>
        </table>
      </Section>
      <p className="note">
        Os IDs são os companyId informados na documentação do Syonet. A GM Ubá (ID 8) está inativa
        nessa referência e não deve receber novos leads até ser confirmada como ativa.
      </p>
    </>
  );
}
