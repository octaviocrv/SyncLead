import { Fragment, useEffect, useState } from 'react';
import { X } from 'lucide-react';
import type { Lead } from '../data';
import { fetchLeadDetail, formatDateTime, type LeadDetail } from '../api';
import { StatusBadge } from './ui';

function formatValues(values: unknown[] | undefined): string {
  return values?.length ? values.map(String).join(', ') : '—';
}

function PersonalData({ detail }: { detail: LeadDetail }) {
  const data = detail.personalData;
  if (detail.personalDataRestricted) {
    return <p className="muted">Dados pessoais completos e payload do CRM disponíveis apenas para administradores.</p>;
  }
  if (!data) {
    return <p className="muted">Nenhum dado pessoal guardado para este lead (recebido antes da captura ou já expurgado).</p>;
  }
  const n = data.normalized;

  return (
    <>
      <h3>Dados recebidos da Meta (field_data)</h3>
      <dl className="details">
        {data.fieldData.map((f, i) => (<Fragment key={`${f.name}-${i}`}><dt>{f.name}</dt><dd>{formatValues(f.values)}</dd></Fragment>))}
      </dl>

      <h3>Normalização</h3>
      {n ? (
        <dl className="details">
          <dt>Nome</dt><dd>{n.name}</dd>
          <dt>Telefone</dt><dd>{n.phone}</dd>
          <dt>E-mail</dt><dd>{n.email}</dd>
          <dt>Loja (resposta)</dt><dd>{n.storeAnswer}</dd>
          <dt>Mídia</dt><dd>{n.media ?? (n.organicWithoutPlatform ? 'Sem plataforma (orgânico/teste)' : '—')}</dd>
        </dl>
      ) : (
        <p className="error-text">Falha na normalização: {data.normalizationError}</p>
      )}

      <h3>Roteamento Syonet</h3>
      <dl className="details">
        <dt>Loja mapeada</dt><dd>{data.store ? `${data.store.answer}${data.store.active ? '' : ' (inativa)'}` : '—'}</dd>
        <dt>companyId</dt><dd>{data.store?.companyId ?? '—'}</dd>
        <dt>Envio</dt><dd>{detail.syonetDelivery === 'enabled' ? 'Ligado' : 'Desligado (nada é enviado)'}</dd>
      </dl>

      <h3>Preview do payload para o Syonet</h3>
      {data.syonetBlockers.length > 0 && (
        <ul className="warn-list">{data.syonetBlockers.map((b) => <li key={b}>{b}</li>)}</ul>
      )}
      {data.missingConfig.length > 0 && (
        <p className="muted">Configuração pendente: {data.missingConfig.join(', ')}</p>
      )}
      {data.syonetPreview ? <pre className="json">{JSON.stringify(data.syonetPreview, null, 2)}</pre> : <p className="muted">Sem preview.</p>}

      <p className="note">
        Dados pessoais capturados em {formatDateTime(data.capturedAt)}; expurgo automático previsto para {formatDateTime(data.purgeAfter)}.
        Este acesso foi registrado.
      </p>
    </>
  );
}

export default function LeadDrawer({ lead, onClose }: { lead: Lead | null; onClose: () => void }) {
  const [detail, setDetail] = useState<LeadDetail | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    setDetail(null);
    setError(null);
    if (!lead) return;
    const controller = new AbortController();
    fetchLeadDetail(lead.id, controller.signal)
      .then(setDetail)
      .catch((e: unknown) => {
        if (!controller.signal.aborted) setError(e instanceof Error ? e.message : 'Falha ao carregar o detalhe.');
      });
    return () => controller.abort();
  }, [lead?.id]);

  if (!lead) return null;

  return (
    <div className="drawer-backdrop" onClick={onClose}>
      <aside className="drawer" onClick={(e) => e.stopPropagation()}>
        <div className="drawer-head">
          <div>
            <h2>{lead.name ?? `Lead ${lead.id}`}</h2>
            <span className="muted">{lead.id} · {lead.origin}</span>
          </div>
          <button className="icon-button" onClick={onClose} title="Fechar"><X size={18} /></button>
        </div>

        <div className="drawer-body">
          <dl className="details">
            <dt>Status</dt><dd><StatusBadge status={lead.status} /> <span className="muted">({lead.rawStatus})</span></dd>
            <dt>Formulário</dt><dd>{lead.form}</dd>
            <dt>ID do formulário</dt><dd>{lead.formId}</dd>
            <dt>Página</dt><dd>{lead.pageId}</dd>
            <dt>Anúncio</dt><dd>{lead.adId ?? '—'}</dd>
            <dt>Plataforma</dt><dd>{lead.platform ?? 'Não informada pela Meta'}</dd>
            <dt>Criado na Meta</dt><dd>{lead.metaCreatedAt}</dd>
            <dt>Webhook recebido</dt><dd>{lead.receivedAt}</dd>
            <dt>Dados lidos na Meta</dt><dd>{lead.metaProcessedAt}</dd>
          </dl>

          <h3>Roteamento</h3>
          <dl className="details">
            <dt>Loja escolhida</dt><dd>{lead.storeAnswer}</dd>
            <dt>Destino</dt><dd>{lead.store}</dd>
            <dt>Regra aplicada</dt><dd>{lead.rule}</dd>
            <dt>Evento Syonet</dt><dd>{lead.syonetEventId ?? '—'}</dd>
            {lead.lastError ? (<><dt>Última mensagem</dt><dd>{lead.lastError}</dd></>) : null}
          </dl>

          {error ? <p className="error-text">{error}</p> : detail ? <PersonalData detail={detail} /> : <p className="muted">Carregando dados do lead…</p>}

          <h3>Histórico de processamento</h3>
          {lead.attempts.length === 0 ? (
            <p className="muted">Aguardando processamento.</p>
          ) : (
            <ol className="timeline">
              {lead.attempts.map((a, i) => (
                <li key={i} className={a.result === 'sucesso' ? 'ok' : 'fail'}>
                  <span className="muted">{a.at} · {a.stage}</span>
                  <span>{a.message}</span>
                </li>
              ))}
            </ol>
          )}
        </div>
      </aside>
    </div>
  );
}
