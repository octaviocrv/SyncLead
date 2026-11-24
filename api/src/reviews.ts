import type { Pool, PoolClient } from 'pg';
import type { SessionUser } from './auth.js';

// Ações de revisão manual do painel (somente admin; a checagem de perfil fica na rota).
// Cada ação trava a linha do lead (FOR UPDATE), valida o estado atual e grava o resultado, o histórico
// de processamento e o registro da revisão na mesma transação: cliques duplos ou dois admins não conflitam.

export type ReviewAction = 'resolve' | 'authorize-send' | 'customer-check';

export type ReviewResult =
  | { ok: true; message: string }
  | { ok: false; status: 400 | 404 | 409; error: string };

const eventIdPattern = /^\d{1,15}$/;
const noteMaxLength = 200;

interface LockedLead {
  leadgen_id: string;
  status: string;
  source: string;
  send_hold: boolean;
  send_authorized_at: Date | null;
  meta_processed_at: Date | null;
}

const fail = (status: 400 | 404 | 409, error: string): ReviewResult => ({ ok: false, status, error });

function readNote(value: unknown): string | null | undefined {
  if (value === undefined || value === null || value === '') return null;
  if (typeof value !== 'string') return undefined;
  const note = value.trim();
  return note.length <= noteMaxLength ? note : undefined;
}

async function record(
  client: PoolClient,
  leadgenId: string,
  user: SessionUser,
  review: { action: string; eventId?: string; customerResult?: string; note?: string | null },
  history?: { status: string; message: string },
): Promise<void> {
  await client.query(
    `INSERT INTO lead_reviews (leadgen_id, user_id, user_name, action, event_id, customer_result, note)
     VALUES ($1, $2, $3, $4, $5, $6, $7)`,
    [leadgenId, user.id, user.name.slice(0, 120), review.action, review.eventId ?? null, review.customerResult ?? null, review.note ?? null],
  );
  if (history) {
    await client.query(
      `INSERT INTO processing_attempts (leadgen_id, stage, status, message) VALUES ($1, 'review', $2, $3)`,
      [leadgenId, history.status, history.message],
    );
  }
}

export async function reviewLead(
  pool: Pool,
  leadgenId: string,
  action: ReviewAction,
  body: Record<string, unknown>,
  user: SessionUser,
): Promise<ReviewResult> {
  if (user.role !== 'admin') return fail(409, 'Apenas administradores podem revisar leads.');

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const locked = await client.query<LockedLead>(
      `SELECT leadgen_id, status, source, send_hold, send_authorized_at, meta_processed_at
       FROM leads WHERE leadgen_id = $1 FOR UPDATE`,
      [leadgenId],
    );
    const lead = locked.rows[0];
    if (!lead) {
      await client.query('ROLLBACK');
      return fail(404, 'Lead não encontrado.');
    }

    const result = await apply(client, lead, action, body, user);
    await client.query(result.ok ? 'COMMIT' : 'ROLLBACK');
    return result;
  } catch (error) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}

async function apply(
  client: PoolClient,
  lead: LockedLead,
  action: ReviewAction,
  body: Record<string, unknown>,
  user: SessionUser,
): Promise<ReviewResult> {
  const id = lead.leadgen_id;
  const note = readNote(body.note);
  if (note === undefined) return fail(400, `A observação deve ter até ${noteMaxLength} caracteres.`);

  if (action === 'resolve') {
    if (lead.status !== 'ambiguous') return fail(409, 'Só leads com resultado incerto podem ser resolvidos por aqui.');

    if (body.outcome === 'event_exists') {
      const eventId = typeof body.eventId === 'string' ? body.eventId.trim() : '';
      if (!eventIdPattern.test(eventId)) return fail(400, 'Informe o número do evento do Syonet (somente dígitos).');
      const duplicate = await client.query(
        `SELECT 1 FROM leads WHERE syonet_event_id = $1 AND leadgen_id <> $2 LIMIT 1`,
        [eventId, id],
      );
      if (duplicate.rowCount) return fail(409, 'Este número de evento já está registrado em outro lead.');
      await client.query(
        `UPDATE leads
         SET status = 'sent', syonet_event_id = $2, last_error = NULL, locked_at = NULL, updated_at = NOW()
         WHERE leadgen_id = $1`,
        [id, eventId],
      );
      await record(client, id, user, { action: 'event_confirmed', eventId, note }, {
        status: 'sent',
        message: `Evento ${eventId} confirmado manualmente no CRM por ${user.name}.`,
      });
      return { ok: true, message: `Evento ${eventId} registrado. Pendência resolvida.` };
    }

    if (body.outcome === 'not_created') {
      if (body.confirm !== true) return fail(400, 'Confirme explicitamente que o evento não existe no CRM.');
      await client.query(
        `UPDATE leads
         SET status = 'waiting_config', send_authorized_at = NOW(), send_authorized_by = $2,
             last_error = 'Reenvio autorizado manualmente após conferência no CRM.', locked_at = NULL, updated_at = NOW()
         WHERE leadgen_id = $1`,
        [id, user.id],
      );
      await record(client, id, user, { action: 'resend_authorized', note }, {
        status: 'waiting_config',
        message: `Evento não encontrado no CRM; reenvio autorizado por ${user.name}.`,
      });
      return { ok: true, message: 'Reenvio autorizado. O lead sai quando o envio ao Syonet estiver ligado.' };
    }

    if (body.outcome === 'unverified') {
      await record(client, id, user, { action: 'unverified', note }, {
        status: 'ambiguous',
        message: `Conferência no CRM sem conclusão (${user.name}); lead mantido como pendente.`,
      });
      return { ok: true, message: 'Conferência registrada. O lead continua pendente.' };
    }
    return fail(400, 'Resultado da conferência inválido.');
  }

  if (action === 'authorize-send') {
    if (lead.status !== 'waiting_config' || !lead.meta_processed_at) {
      return fail(409, 'O lead precisa estar processado e aguardando envio para ser autorizado.');
    }
    if (lead.send_authorized_at) return fail(409, 'O envio deste lead já foi autorizado.');
    if (!lead.send_hold) return fail(409, 'Este lead não está retido: ele sai automaticamente.');
    await client.query(
      `UPDATE leads SET send_authorized_at = NOW(), send_authorized_by = $2, updated_at = NOW() WHERE leadgen_id = $1`,
      [id, user.id],
    );
    await record(client, id, user, { action: 'send_authorized', note }, {
      status: 'waiting_config',
      message: `Envio ao Syonet autorizado por ${user.name}.`,
    });
    return { ok: true, message: 'Envio autorizado. O lead sai quando o envio ao Syonet estiver ligado.' };
  }

  // customer-check: classificação manual do cliente no Syonet; não altera o estado do lead.
  if (lead.status !== 'sent') return fail(409, 'A conferência do cliente só vale para leads já enviados.');
  const result = body.result;
  if (result !== 'new' && result !== 'existing' && result !== 'unknown') return fail(400, 'Resultado inválido (novo, existente ou não identificado).');
  await record(client, id, user, { action: 'customer_check', customerResult: result, note });
  return { ok: true, message: 'Conferência do cliente registrada.' };
}
