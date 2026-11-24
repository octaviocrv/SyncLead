import { Fragment, useEffect, useState } from 'react';
import { X } from 'lucide-react';
import type { Lead } from '../data';
import { fetchLeadDetail, formatDateTime, postReview, type LeadDetail } from '../api';
import { useAuth } from '../auth';
import { useLeads } from '../leads';
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


const reviewLabel: Record<string, string> = {
  event_confirmed: 'Evento confirmado no CRM',
  resend_authorized: 'Reenvio autorizado',
  unverified: 'Conferência sem conclusão',
  send_authorized: 'Envio autorizado',
  customer_check: 'Cliente conferido',
};
const customerLabel: Record<string, string> = { new: 'Cliente novo', existing: 'Cliente já existente', unknown: 'Não identificado' };

// Resumo em linguagem simples do que aconteceu com o lead; detalhes técnicos ficam recolhidos.
function SendResult({ lead, detail }: { lead: Lead; detail: LeadDetail | null }) {
  let tone: 'ok' | 'warn' | 'bad' = 'warn';
  let text: string;
  switch (lead.rawStatus) {
    case 'sent':
      tone = 'ok';
      text = `Enviado ao Syonet. Evento ${lead.syonetEventId ?? '—'} · ${lead.store}.`;
      break;
    case 'ambiguous':
      tone = 'bad';
      text = 'Resultado incerto: o Syonet pode ou não ter criado o evento. Confira no CRM antes de reenviar.';
      break;
    case 'failed':
    case 'blocked':
      tone = 'bad';
      text = lead.lastError ?? 'O lead não foi enviado.';
      break;
    case 'waiting_config':
      if (lead.status === 'revisao') text = 'Em revisão manual: não será enviado ao Syonet sem autorização de um administrador.';
      else if (lead.sendAuthorized) text = 'Envio autorizado. Sai quando o envio ao Syonet estiver ligado.';
      else text = detail?.syonetDelivery === 'enabled' ? 'Validado. Na fila para envio ao Syonet.' : 'Validado e roteado. O envio ao Syonet está desligado.';
      break;
    default:
      text = 'Em processamento.';
  }
  const exchange = detail?.syonetExchange;
  return (
    <>
      <div className={`health-banner health-${tone}`}><span>{text}</span></div>
      {exchange ? (
        <details className="tech-details">
          <summary>Detalhes técnicos do envio</summary>
          <dl className="details">
            <dt>Data</dt><dd>{formatDateTime(exchange.at)}</dd>
            <dt>HTTP</dt><dd>{exchange.httpStatus ?? 'sem resposta (rede/timeout)'}</dd>
          </dl>
          {exchange.response !== undefined ? <pre className="json">{JSON.stringify(exchange.response, null, 2)}</pre> : null}
        </details>
      ) : null}
    </>
  );
}

function Recurrence({ lead, detail }: { lead: Lead; detail: LeadDetail | null }) {
  if (lead.recurrentCount === 0) return null;
  const earlier = detail?.earlierLeads ?? [];
  return (
    <>
      <h3>Contato recorrente</h3>
      <p className="muted">
        Este telefone ou e-mail já enviou {lead.recurrentCount} lead(s) anterior(es) pelo SyncLead (dentro do período de retenção).
        Isso <strong>não</strong> indica que o cliente já existe no Syonet.
      </p>
      {earlier.length ? (
        <ul className="review-list">
          {earlier.map((e) => (
            <li key={e.leadgenId}>{e.leadgenId} · {formatDateTime(e.receivedAt)} · {e.storeAnswer ?? '—'} · {e.eventId ? `evento ${e.eventId}` : e.status}</li>
          ))}
        </ul>
      ) : null}
    </>
  );
}

// Ações de revisão: somente admin (a API também bloqueia o gestor).
function ReviewPanel({ lead, onDone }: { lead: Lead; onDone: () => void }) {
  const [mode, setMode] = useState<'event' | 'notcreated' | null>(null);
  const [eventId, setEventId] = useState('');
  const [confirmed, setConfirmed] = useState(false);
  const [busy, setBusy] = useState(false);
  const [feedback, setFeedback] = useState<{ ok: boolean; text: string } | null>(null);

  const run = async (action: 'resolve' | 'authorize-send' | 'customer-check', body: Record<string, unknown>) => {
    setBusy(true);
    setFeedback(null);
    try {
      const message = await postReview(lead.id, action, body);
      setFeedback({ ok: true, text: message });
      setMode(null);
      setConfirmed(false);
      setEventId('');
      onDone();
    } catch (e) {
      setFeedback({ ok: false, text: e instanceof Error ? e.message : 'Falha ao registrar.' });
    } finally {
      setBusy(false);
    }
  };

  const ambiguous = lead.rawStatus === 'ambiguous';
  const inReview = lead.status === 'revisao';
  const sent = lead.rawStatus === 'sent';
  if (!ambiguous && !inReview && !sent) return null;

  return (
    <>
      <h3>Revisão</h3>
      <div className="review-panel">
        {ambiguous && (
          <>
            <p>No CRM, pesquise o cliente pelo telefone ou e-mail e procure a observação “Lead ID {lead.id}”.</p>
            <div className="review-actions">
              <button className="button small" onClick={() => { setMode('event'); setFeedback(null); }}>Evento existe</button>
              <button className="button small" onClick={() => { setMode('notcreated'); setFeedback(null); }}>Não foi criado</button>
              <button className="button small" disabled={busy} onClick={() => void run('resolve', { outcome: 'unverified' })}>Não consegui confirmar</button>
            </div>
            {mode === 'event' && (
              <div className="review-form">
                <input placeholder="Número do evento no Syonet" inputMode="numeric" value={eventId} onChange={(e) => setEventId(e.target.value)} />
                <button className="button small primary" disabled={busy || !eventId.trim()} onClick={() => void run('resolve', { outcome: 'event_exists', eventId })}>Registrar evento</button>
              </div>
            )}
            {mode === 'notcreated' && (
              <div className="review-form">
                <label className="switch">
                  <input type="checkbox" checked={confirmed} onChange={(e) => setConfirmed(e.target.checked)} />
                  Conferi no CRM e o evento não existe. Entendo que o reenvio pode duplicar se eu estiver errado.
                </label>
                <button className="button small primary" disabled={busy || !confirmed} onClick={() => void run('resolve', { outcome: 'not_created', confirm: true })}>Autorizar reenvio</button>
              </div>
            )}
          </>
        )}
        {inReview && (
          <div className="review-form">
            <label className="switch">
              <input type="checkbox" checked={confirmed} onChange={(e) => setConfirmed(e.target.checked)} />
              Conferi a loja e os dados e autorizo o envio deste lead ao Syonet.
            </label>
            <button className="button small primary" disabled={busy || !confirmed} onClick={() => void run('authorize-send', {})}>Autorizar envio</button>
          </div>
        )}
        {sent && (
          <>
            <p>
              Cliente no Syonet: <strong>{lead.customerCheck ? customerLabel[lead.customerCheck.result] : 'Não identificado'}</strong>
              {lead.customerCheck ? <span className="muted"> · conferido por {lead.customerCheck.by} em {formatDateTime(lead.customerCheck.at)}</span> : null}
            </p>
            <p className="muted">O Syonet não informa isso pela API. Registre a conferência feita no CRM.</p>
            <div className="review-actions">
              {(['new', 'existing', 'unknown'] as const).map((result) => (
                <button key={result} className="button small" disabled={busy} onClick={() => void run('customer-check', { result })}>{customerLabel[result]}</button>
              ))}
            </div>
          </>
        )}
        {feedback ? <p className={feedback.ok ? 'muted' : 'error-text'}>{feedback.text}</p> : null}
      </div>
    </>
  );
}

export default function LeadDrawer({ lead, onClose }: { lead: Lead | null; onClose: () => void }) {
  const { user } = useAuth();
  const { refresh } = useLeads();
  const [detail, setDetail] = useState<LeadDetail | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [reload, setReload] = useState(0);

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
  }, [lead?.id, reload]);

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
          <SendResult lead={lead} detail={detail} />
          <Recurrence lead={lead} detail={detail} />
          {user?.role === 'admin' ? <ReviewPanel lead={lead} onDone={() => { refresh(); setReload((n) => n + 1); }} /> : null}

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

          {detail?.reviews?.length ? (
            <>
              <h3>Revisões registradas</h3>
              <ul className="review-list">
                {detail.reviews.map((r, i) => (
                  <li key={i}>
                    <strong>{reviewLabel[r.action] ?? r.action}</strong>
                    {r.eventId ? ` · evento ${r.eventId}` : ''}{r.customerResult ? ` · ${customerLabel[r.customerResult]}` : ''}
                    <span className="muted"> · {r.by} · {formatDateTime(r.createdAt)}</span>
                    {r.note ? <div className="muted">{r.note}</div> : null}
                  </li>
                ))}
              </ul>
            </>
          ) : null}

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
