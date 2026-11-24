import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { Activity, CheckCircle2, AlertTriangle, XCircle } from 'lucide-react';
import { fetchHealth, formatDateTime, type HealthAlert, type HealthData } from '../api';
import { PageHeader, Section } from '../components/ui';

const windowLabel = { '24h': 'Últimas 24 horas', '7d': 'Últimos 7 dias', desde_webhook: 'Desde que o webhook foi ligado' } as const;

const queueLabel: Record<string, string> = {
  received: 'Na fila',
  processing: 'Processando',
  retry: 'Aguardando nova tentativa',
  waiting_config: 'Processado (Syonet desligado)',
  sent: 'Enviado ao Syonet',
  failed: 'Falhou',
  blocked: 'Bloqueado',
  ambiguous: 'Resultado incerto',
};

type Tone = 'ok' | 'warn' | 'bad' | 'idle';

function deliveryTone(rate: number | null, missing: number): Tone {
  if (rate === null) return 'idle';
  if (missing > 0 || rate < 90) return 'bad';
  if (rate < 100) return 'warn';
  return 'ok';
}

function ago(iso: string | null): string {
  if (!iso) return 'nunca';
  const minutes = Math.round((Date.now() - Date.parse(iso)) / 60_000);
  if (minutes < 1) return 'agora há pouco';
  if (minutes < 60) return `há ${minutes} min`;
  const hours = Math.round(minutes / 60);
  return hours < 48 ? `há ${hours} h` : `há ${Math.round(hours / 24)} dias`;
}

function ToneIcon({ tone }: { tone: Tone }) {
  if (tone === 'ok') return <CheckCircle2 size={16} className="tone-green" />;
  if (tone === 'warn') return <AlertTriangle size={16} className="tone-amber" />;
  if (tone === 'bad') return <XCircle size={16} className="tone-red" />;
  return <Activity size={16} className="tone-muted" />;
}

function AlertRow({ alert }: { alert: HealthAlert }) {
  const resolved = Boolean(alert.resolvedAt);
  return (
    <li className={`alert-row ${resolved ? 'alert-resolved' : `alert-${alert.severity}`}`}>
      <div>
        <strong>{alert.title}</strong>
        {alert.message && !resolved ? <p>{alert.message}</p> : null}
        {!resolved && ['ambiguous_results', 'processing_errors', 'webhook_missed'].includes(alert.kind) ? <p><Link to="/pendencias">Abrir Pendências</Link></p> : null}
      </div>
      <small>
        {resolved ? `Resolvido ${formatDateTime(alert.resolvedAt ?? null)}` : `Aberto desde ${formatDateTime(alert.openedAt)}`}
      </small>
    </li>
  );
}

export default function Health() {
  const [data, setData] = useState<HealthData | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const controller = new AbortController();
    const load = () =>
      fetchHealth(controller.signal)
        .then((d) => { setData(d); setError(null); })
        .catch((e: Error) => { if (e.name !== 'AbortError') setError(e.message); });
    load();
    const timer = setInterval(load, 30_000);
    return () => { controller.abort(); clearInterval(timer); };
  }, []);

  if (!data) {
    return (
      <>
        <PageHeader title="Saúde" subtitle="Os leads da Meta estão chegando?" />
        <p className="empty">{error ?? 'Carregando…'}</p>
      </>
    );
  }

  const rec = data.reconciliation;
  const token = data.token;
  const recTone: Tone = !rec ? 'idle' : rec.ok ? 'ok' : 'bad';
  const tokenTone: Tone = !token ? 'idle' : token.ok ? 'ok' : 'bad';
  const overall: Tone = data.openAlerts.some((a) => a.severity === 'critical') ? 'bad' : data.openAlerts.length ? 'warn' : 'ok';

  return (
    <>
      <PageHeader
        title="Saúde"
        subtitle="Os leads da Meta estão chegando? Atualizado a cada 30 segundos. Horários de Brasília."
      />

      <div className={`health-banner health-${overall}`}>
        <ToneIcon tone={overall} />
        <span>
          {overall === 'ok'
            ? 'Tudo funcionando. Nenhum alerta aberto.'
            : `${data.openAlerts.length} alerta(s) aberto(s). Veja abaixo o que fazer.`}
        </span>
      </div>

      <div className="metrics">
        {data.delivery.map((w) => {
          const tone = deliveryTone(w.rate, w.missing);
          return (
            <div key={w.label} className={`metric metric-${tone}`}>
              <div className="metric-head">
                <span>Taxa de entrega · {windowLabel[w.label]}</span>
                <ToneIcon tone={tone} />
              </div>
              <strong>{w.rate === null ? '—' : `${w.rate.toLocaleString('pt-BR')}%`}</strong>
              <small>
                {w.metaTotal === 0
                  ? 'Nenhum lead registrado na Meta no período'
                  : `${w.viaWebhook} de ${w.metaTotal} chegaram na hora pelo webhook` +
                    (w.recovered ? ` · ${w.recovered} recuperado(s)` : '') +
                    (w.missing ? ` · ${w.missing} faltando` : '')}
              </small>
            </div>
          );
        })}
      </div>

      <Section title="Alertas abertos" subtitle="Vermelho é urgente; amarelo merece atenção.">
        {data.openAlerts.length ? (
          <ul className="alert-list">{data.openAlerts.map((a) => <AlertRow key={a.id} alert={a} />)}</ul>
        ) : (
          <p className="empty">Nenhum alerta aberto.</p>
        )}
      </Section>

      <Section title="Verificações automáticas">
        <ul className="check-list">
          <li>
            <ToneIcon tone={data.lastWebhookAt ? 'ok' : 'idle'} />
            <span>Último lead recebido pelo webhook</span>
            <small>{formatDateTime(data.lastWebhookAt)} ({ago(data.lastWebhookAt)})</small>
          </li>
          <li>
            <ToneIcon tone={recTone} />
            <span>Conferência com a Meta (a cada 15 min)</span>
            <small>
              {!rec
                ? 'Ainda não rodou'
                : rec.ok
                  ? `${formatDateTime(rec.at)} (${ago(rec.at)}) · ${rec.recovered?.length ?? 0} recuperado(s)`
                  : `Falhou ${ago(rec.at)}: ${rec.error ?? 'erro desconhecido'}`}
            </small>
          </li>
          <li>
            <ToneIcon tone={tokenTone} />
            <span>Token de acesso da Meta (diário)</span>
            <small>
              {!token
                ? 'Ainda não verificado'
                : token.ok
                  ? `Válido${token.expiresAt ? ` até ${formatDateTime(token.expiresAt)}` : ', sem data de expiração'} · verificado ${ago(token.checkedAt)}`
                  : token.error ?? 'Com problema'}
            </small>
          </li>
          <li>
            <ToneIcon tone="idle" />
            <span>Envio ao Syonet</span>
            <small>{data.syonetDelivery === 'enabled' ? 'Ligado' : 'Desligado (aguardando homologação com a Cacel)'}</small>
          </li>
        </ul>
      </Section>

      <Section title="Fila de processamento" subtitle="Situação atual de todos os leads guardados.">
        <ul className="check-list">
          {data.queue.map((q) => (
            <li key={q.status}>
              <ToneIcon tone={['failed', 'blocked', 'ambiguous'].includes(q.status) ? 'bad' : q.status === 'retry' ? 'warn' : 'ok'} />
              <span>{queueLabel[q.status] ?? q.status}</span>
              <small>{q.count}</small>
            </li>
          ))}
        </ul>
        <div className="section-foot">
          <small className="muted">
            {data.historicalBeforeWebhook} lead(s) anteriores a {formatDateTime(data.recoverSince)} existem só na Meta
            (guardamos apenas o identificador, sem dados pessoais).
          </small>
        </div>
      </Section>

      {data.recentAlerts.length ? (
        <Section title="Alertas resolvidos recentemente">
          <ul className="alert-list">{data.recentAlerts.map((a) => <AlertRow key={a.id} alert={a} />)}</ul>
        </Section>
      ) : null}
    </>
  );
}
