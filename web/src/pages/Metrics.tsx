import { useEffect, useMemo, useState } from 'react';
import { fetchStats, platformLabel, storeLabel, type StatsData } from '../api';
import { PageHeader, Section } from '../components/ui';

type Granularity = 'dia' | 'semana' | 'mes';

const today = () => new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Sao_Paulo' }).format(new Date());

function shift(date: string, days: number): string {
  const d = new Date(`${date}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

const presets = [
  { label: '7 dias', days: 7 },
  { label: '30 dias', days: 30 },
  { label: '90 dias', days: 90 },
];

const months = ['jan', 'fev', 'mar', 'abr', 'mai', 'jun', 'jul', 'ago', 'set', 'out', 'nov', 'dez'];
const dayLabel = (date: string) => `${date.slice(8, 10)}/${date.slice(5, 7)}`;

// Datas já vêm no fuso de São Paulo (AAAA-MM-DD); semanas começam na segunda-feira.
function group(daily: StatsData['daily'], granularity: Granularity) {
  if (granularity === 'dia') return daily.map((d) => ({ key: d.date, label: dayLabel(d.date), count: d.count }));
  const buckets = new Map<string, { key: string; label: string; count: number }>();
  for (const d of daily) {
    let key: string;
    let label: string;
    if (granularity === 'mes') {
      key = d.date.slice(0, 7);
      label = `${months[Number(d.date.slice(5, 7)) - 1]}/${d.date.slice(2, 4)}`;
    } else {
      const weekday = (new Date(`${d.date}T00:00:00Z`).getUTCDay() + 6) % 7;
      key = shift(d.date, -weekday);
      label = `sem. ${dayLabel(key)}`;
    }
    const bucket = buckets.get(key) ?? { key, label, count: 0 };
    bucket.count += d.count;
    buckets.set(key, bucket);
  }
  return [...buckets.values()];
}

function VolumeChart({ bars }: { bars: Array<{ key: string; label: string; count: number }> }) {
  const max = Math.max(1, ...bars.map((b) => b.count));
  const every = Math.ceil(bars.length / 15);
  return (
    <div className="chart" role="img" aria-label="Leads por período">
      {bars.map((b, i) => (
        <div key={b.key} className="chart-col" title={`${b.label}: ${b.count} lead(s)`}>
          <span className="chart-value">{b.count || ''}</span>
          <div className="chart-bar" style={{ height: `${(b.count / max) * 100}%` }} />
          <span className="chart-label">{i % every === 0 ? b.label : ''}</span>
        </div>
      ))}
    </div>
  );
}

function Breakdown({ rows, empty }: { rows: Array<{ key: string; label: string; hint?: string; count: number }>; empty: string }) {
  const total = rows.reduce((sum, r) => sum + r.count, 0);
  if (!rows.length) return <p className="empty">{empty}</p>;
  return (
    <ul className="breakdown">
      {rows.map((r) => (
        <li key={r.key}>
          <div className="breakdown-head">
            <span>
              {r.label}
              {r.hint ? <small> · {r.hint}</small> : null}
            </span>
            <strong>
              {r.count} <small>({Math.round((r.count / total) * 100)}%)</small>
            </strong>
          </div>
          <div className="breakdown-track"><div style={{ width: `${(r.count / total) * 100}%` }} /></div>
        </li>
      ))}
    </ul>
  );
}

export default function Metrics() {
  const [to, setTo] = useState(today);
  const [from, setFrom] = useState(() => shift(today(), -29));
  const [granularity, setGranularity] = useState<Granularity>('dia');
  const [data, setData] = useState<StatsData | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!from || !to) return;
    const controller = new AbortController();
    fetchStats(from, to, controller.signal)
      .then((d) => { setData(d); setError(null); })
      .catch((e: Error) => { if (e.name !== 'AbortError') setError(e.message); });
    return () => controller.abort();
  }, [from, to]);

  const bars = useMemo(() => (data ? group(data.daily, granularity) : []), [data, granularity]);
  const days = data?.daily.length ?? 0;

  return (
    <>
      <PageHeader
        title="Métricas"
        subtitle="Leads de anúncios por período. Leads de teste ficam fora das contas. Datas no horário de Brasília."
      />

      <div className="metric-filters">
        <div className="segmented">
          {presets.map((p) => {
            const active = to === today() && from === shift(today(), -(p.days - 1));
            return (
              <button key={p.days} className={active ? 'active' : ''} onClick={() => { setTo(today()); setFrom(shift(today(), -(p.days - 1))); }}>
                {p.label}
              </button>
            );
          })}
        </div>
        <label>De <input type="date" value={from} max={to} onChange={(e) => setFrom(e.target.value)} /></label>
        <label>Até <input type="date" value={to} min={from} max={today()} onChange={(e) => setTo(e.target.value)} /></label>
        <div className="segmented">
          {(['dia', 'semana', 'mes'] as const).map((g) => (
            <button key={g} className={granularity === g ? 'active' : ''} onClick={() => setGranularity(g)}>
              {g === 'dia' ? 'Por dia' : g === 'semana' ? 'Por semana' : 'Por mês'}
            </button>
          ))}
        </div>
      </div>

      {error ? <p className="empty">{error}</p> : null}
      {!data ? (
        !error && <p className="empty">Carregando…</p>
      ) : (
        <>
          <div className="metrics">
            <div className="metric">
              <div className="metric-head"><span>Leads de anúncios no período</span></div>
              <strong>{data.total}</strong>
              <small>{data.testsExcluded ? `${data.testsExcluded} de teste fora da conta` : 'Nenhum lead de teste no período'}</small>
            </div>
            <div className="metric">
              <div className="metric-head"><span>Média por dia</span></div>
              <strong>{days ? (data.total / days).toLocaleString('pt-BR', { maximumFractionDigits: 1 }) : '—'}</strong>
              <small>{days} dia(s) no período</small>
            </div>
            <div className="metric">
              <div className="metric-head"><span>Melhor dia</span></div>
              <strong>{data.total ? Math.max(...data.daily.map((d) => d.count)) : '—'}</strong>
              <small>
                {data.total
                  ? dayLabel(data.daily.reduce((best, d) => (d.count > best.count ? d : best)).date)
                  : 'Sem leads no período'}
              </small>
            </div>
          </div>

          <Section title="Volume de leads" subtitle={granularity === 'dia' ? 'Leads por dia' : granularity === 'semana' ? 'Leads por semana (segunda a domingo)' : 'Leads por mês'}>
            <div className="chart-wrap">
              {data.total ? <VolumeChart bars={bars} /> : <p className="empty">Nenhum lead de anúncio no período.</p>}
            </div>
          </Section>

          <div className="grid-2">
            <Section title="Por loja">
              <Breakdown
                empty="Sem leads no período."
                rows={data.byStore.map((s) => ({ key: `${s.answer}-${s.companyId}`, label: storeLabel(s.answer, s.companyId), count: s.count }))}
              />
            </Section>
            <Section title="Por plataforma">
              <Breakdown
                empty="Sem leads no período."
                rows={data.byPlatform.map((p) => ({ key: String(p.platform), label: platformLabel(p.platform), count: p.count }))}
              />
            </Section>
          </div>

          <Section
            title="Por anúncio"
            subtitle="Os 20 anúncios com mais leads. Nomes aparecem quando o token da Meta tiver permissão de leitura de anúncios (ads_read); hoje mostramos o ID."
          >
            <Breakdown
              empty="Sem leads no período."
              rows={data.byAd.map((a) => ({
                key: String(a.adId),
                label: a.adName ?? (a.adId ? `Anúncio ${a.adId}` : 'Sem anúncio identificado'),
                hint: [a.campaignName, a.adsetName].filter(Boolean).join(' › ') || undefined,
                count: a.count,
              }))}
            />
          </Section>
        </>
      )}
    </>
  );
}
