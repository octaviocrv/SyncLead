import { readFile, statfs } from 'node:fs/promises';
import type { Pool } from 'pg';
import { syncAlert } from './monitoring.js';

export type StorageLevel = 'ok' | 'warning' | 'critical';

export interface StorageConfiguration {
  // Caminho cujo sistema de arquivos é medido (no container, o disco que hospeda o Docker da VPS).
  path: string;
  // Relatório gravado no host por deploy/storage-report.sh (backups, logs e imagens do Docker).
  reportFile: string;
  warnPercent: number;
  criticalPercent: number;
}

export interface StorageStatus {
  checkedAt: string;
  level: StorageLevel;
  percent: number;
  totalBytes: number;
  usedBytes: number;
  freeBytes: number;
  warnPercent: number;
  criticalPercent: number;
  postgresBytes: number | null;
  // Itens abaixo vêm do relatório do host; ficam nulos quando ele não existe ou está desatualizado.
  backupsBytes: number | null;
  dockerLogsBytes: number | null;
  dockerImagesBytes: number | null;
  dockerVolumesBytes: number | null;
  dockerBuildCacheBytes: number | null;
  reportAt: string | null;
}

const reportMaxAgeMs = 2 * 60 * 60 * 1000;

export function storageLevel(percent: number, warnPercent: number, criticalPercent: number): StorageLevel {
  if (percent > criticalPercent) return 'critical';
  if (percent >= warnPercent) return 'warning';
  return 'ok';
}

interface HostReport {
  generatedAt: string;
  backupsBytes: number | null;
  dockerLogsBytes: number | null;
  dockerImagesBytes: number | null;
  dockerVolumesBytes: number | null;
  dockerBuildCacheBytes: number | null;
}

const bytesOrNull = (value: unknown): number | null =>
  typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : null;

export async function readHostReport(file: string, now = Date.now()): Promise<HostReport | undefined> {
  try {
    const raw = JSON.parse(await readFile(file, 'utf8')) as Record<string, unknown>;
    const generatedAt = typeof raw.generatedAt === 'string' ? raw.generatedAt : '';
    const age = now - Date.parse(generatedAt);
    if (!Number.isFinite(age) || age > reportMaxAgeMs) return undefined;
    return {
      generatedAt,
      backupsBytes: bytesOrNull(raw.backupsBytes),
      dockerLogsBytes: bytesOrNull(raw.dockerLogsBytes),
      dockerImagesBytes: bytesOrNull(raw.dockerImagesBytes),
      dockerVolumesBytes: bytesOrNull(raw.dockerVolumesBytes),
      dockerBuildCacheBytes: bytesOrNull(raw.dockerBuildCacheBytes),
    };
  } catch {
    return undefined;
  }
}

export async function getStorageStatus(pool: Pool, configuration: StorageConfiguration): Promise<StorageStatus> {
  const fs = await statfs(configuration.path);
  const totalBytes = fs.blocks * fs.bsize;
  const usedBytes = (fs.blocks - fs.bfree) * fs.bsize;
  const freeBytes = fs.bavail * fs.bsize;
  // Mesma conta do `df`: usado / (usado + disponível para usuários).
  const percent = usedBytes + freeBytes > 0 ? (usedBytes / (usedBytes + freeBytes)) * 100 : 0;

  let postgresBytes: number | null = null;
  try {
    const size = await pool.query<{ bytes: string }>('SELECT pg_database_size(current_database())::text AS bytes');
    postgresBytes = Number(size.rows[0]?.bytes);
    if (!Number.isFinite(postgresBytes)) postgresBytes = null;
  } catch {
    postgresBytes = null;
  }

  const report = await readHostReport(configuration.reportFile);
  return {
    checkedAt: new Date().toISOString(),
    level: storageLevel(percent, configuration.warnPercent, configuration.criticalPercent),
    percent: Math.round(percent * 10) / 10,
    totalBytes,
    usedBytes,
    freeBytes,
    warnPercent: configuration.warnPercent,
    criticalPercent: configuration.criticalPercent,
    postgresBytes,
    backupsBytes: report?.backupsBytes ?? null,
    dockerLogsBytes: report?.dockerLogsBytes ?? null,
    dockerImagesBytes: report?.dockerImagesBytes ?? null,
    dockerVolumesBytes: report?.dockerVolumesBytes ?? null,
    dockerBuildCacheBytes: report?.dockerBuildCacheBytes ?? null,
    reportAt: report?.generatedAt ?? null,
  };
}

const gb = (bytes: number) => `${(bytes / 1024 ** 3).toLocaleString('pt-BR', { maximumFractionDigits: 1 })} GB`;

// Um alerta aberto por vez. count = 1 (aviso) ou 2 (crítico): só notifica ao abrir e ao piorar de nível.
export async function syncStorageAlert(
  pool: Pool,
  status: StorageStatus,
  notify?: (text: string) => Promise<void>,
): Promise<'opened' | 'worsened' | 'updated' | 'resolved' | 'none'> {
  const detail = `Disco da VPS: ${gb(status.usedBytes)} de ${gb(status.totalBytes)} (${status.percent.toLocaleString('pt-BR')}%).`;
  return syncAlert(pool, 'disk_usage', status.level === 'ok' ? undefined : status.level === 'critical' ? {
    kind: 'disk_usage', severity: 'critical', count: 2,
    title: 'Armazenamento crítico da VPS',
    message: `${detail} Risco de falha no banco e na aplicação: libere espaço (backups antigos, logs, imagens do Docker).`,
  } : {
    kind: 'disk_usage', severity: 'warning', count: 1,
    title: 'Armazenamento da VPS em atenção',
    message: `${detail} Acompanhe o que está consumindo espaço antes que chegue a ${status.criticalPercent}%.`,
  }, notify);
}
