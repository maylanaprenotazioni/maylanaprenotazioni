/**
 * Processo schedulato (Netlify Scheduled Function): ogni 10 minuti
 *  1) accoda i promemoria dovuti (idempotente: dedupe_key per appuntamento/orario)
 *  2) invia le email in coda e ritenta quelle fallite con backoff
 * Gira solo sui deploy pubblicati (non in deploy preview).
 */
import type { Config } from '@netlify/functions';
import { createDb } from '../lib/db';
import { getServerEnv } from '../lib/env';
import { scheduledRun } from '../lib/handlers';

export default async () => {
  try {
    const env = getServerEnv();
    const { enqueued, results } = await scheduledRun({ env, db: createDb(env), ip: 'scheduler', fetch });
    const summary = results.reduce<Record<string, number>>((acc, r) => ((acc[r.status] = (acc[r.status] ?? 0) + 1), acc), {});
    console.log('[scheduled] promemoria accodati:', enqueued, 'esiti invio:', JSON.stringify(summary));
  } catch (err) {
    console.error('[scheduled] errore:', (err as Error).message);
  }
};

export const config: Config = {
  schedule: '*/10 * * * *',
};
