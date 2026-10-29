/**
 * Template email transazionali Maylana (HTML compatibile con i client
 * di posta: tabelle e stili inline). Le email relative alle consulenze
 * Capelli For You sono discrete: nessun dettaglio sanitario, il servizio
 * compare come "Consulenza riservata".
 */
import { formatLongDate, formatTime, formatCalendarDate, formatPrice } from '../../../src/lib/time';

export interface NotificationContext {
  id: string;
  kind:
    | 'booking_confirmed'
    | 'request_received'
    | 'request_approved'
    | 'request_rejected'
    | 'request_proposal'
    | 'appointment_rescheduled'
    | 'appointment_cancelled'
    | 'reminder'
    | 'salon_customer_change';
  audience: 'customer' | 'salon';
  data: Record<string, unknown>;
  recipient: string | null;
  customer_first_name: string | null;
  appointment: {
    id: string;
    code: string;
    status: string;
    starts_at: string;
    ends_at: string;
    service_name: string;
    category: 'hair' | 'consultation';
    staff_name: string;
    total_price_cents?: number | null;
    price_is_estimate?: boolean;
  } | null;
  request: {
    id: string;
    code: string;
    status: string;
    service_name: string;
    category: 'hair' | 'consultation';
    preferred_date: string | null;
    preferred_time_window: string;
    proposed_starts_at: string | null;
    proposed_staff_name: string | null;
  } | null;
  valid: boolean;
  invalid_reason: string | null;
  needs_link: boolean;
  settings: {
    business_name: string;
    logo_url: string | null;
    address: string | null;
    contact_phone: string | null;
    contact_email: string | null;
    email_instructions: string | null;
    customer_change_min_hours: number;
  };
}

export interface RenderedEmail {
  subject: string;
  html: string;
  text: string;
}

const C = { ink: '#1D1A17', champagne: '#C8AD7F', deep: '#9C7F50', ivory: '#F7F2E8', paper: '#FFFDF8', taupe: '#8A7B6A', line: '#E3D8C6' };

export function esc(s: unknown): string {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);
}

const cap = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);
const when = (iso: string) => `${cap(formatLongDate(iso))}, ore ${formatTime(iso)}`;

function serviceLabel(name: string | undefined, category: string | undefined): string {
  return category === 'consultation' ? 'Consulenza riservata' : name ?? '';
}

interface Block {
  heading: string;
  intro: string[];
  rows: [string, string][];
  cta?: { label: string; url: string; note?: string };
  outro?: string[];
}

function layout(ctx: NotificationContext, b: Block, preheader: string): { html: string; text: string } {
  const s = ctx.settings;
  const logo =
    s.logo_url && /^https:\/\//.test(s.logo_url)
      ? `<img src="${esc(s.logo_url)}" alt="${esc(s.business_name)}" height="48" style="height:48px;width:auto;border:0;display:block;margin:0 auto">`
      : `<div style="font-family:Didot,'Bodoni 72',Georgia,serif;font-size:32px;letter-spacing:1px;color:${C.ink}">${esc(s.business_name)}</div>`;

  const rows = b.rows
    .filter(([, v]) => v)
    .map(
      ([k, v]) =>
        `<tr><td style="padding:8px 0;color:${C.taupe};font-size:13px;width:38%;vertical-align:top">${esc(k)}</td><td style="padding:8px 0;color:${C.ink};font-size:15px">${esc(v)}</td></tr>`,
    )
    .join('');

  const cta = b.cta
    ? `<table role="presentation" cellpadding="0" cellspacing="0" style="margin:28px auto 8px"><tr><td style="background:${C.ink};border-radius:999px"><a href="${esc(b.cta.url)}" style="display:inline-block;padding:14px 28px;color:${C.ivory};text-decoration:none;font-size:15px">${esc(b.cta.label)}</a></td></tr></table>${
        b.cta.note ? `<p style="margin:0;text-align:center;color:${C.taupe};font-size:12px">${esc(b.cta.note)}</p>` : ''
      }`
    : '';

  const para = (arr: string[] | undefined) => (arr ?? []).map((p) => `<p style="margin:0 0 12px;color:${C.ink};font-size:15px;line-height:1.55">${esc(p)}</p>`).join('');
  const instructions = s.email_instructions && ctx.audience === 'customer' && ctx.kind !== 'appointment_cancelled' && ctx.kind !== 'request_rejected'
    ? `<div style="margin-top:24px;padding:14px 16px;background:${C.ivory};border-radius:12px;color:${C.ink};font-size:14px;line-height:1.5">${esc(s.email_instructions).replace(/\n/g, '<br>')}</div>`
    : '';
  const contacts = [s.address, s.contact_phone, s.contact_email].filter(Boolean).map((x) => esc(x)).join('<br>');

  const html = `<!doctype html><html lang="it"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="color-scheme" content="light"><title>${esc(b.heading)}</title></head>
<body style="margin:0;padding:0;background:${C.ivory};font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif">
<div style="display:none;max-height:0;overflow:hidden;opacity:0">${esc(preheader)}</div>
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:${C.ivory}"><tr><td align="center" style="padding:32px 16px">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:560px">
<tr><td align="center" style="padding-bottom:24px">${logo}</td></tr>
<tr><td style="background:${C.paper};border:1px solid ${C.line};border-radius:20px;padding:32px 28px">
<h1 style="margin:0 0 16px;font-family:Didot,'Bodoni 72',Georgia,serif;font-weight:normal;font-size:26px;color:${C.ink}">${esc(b.heading)}</h1>
${para(b.intro)}
${rows ? `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="margin-top:12px;border-top:1px solid ${C.line};border-bottom:1px solid ${C.line}">${rows}</table>` : ''}
${cta}
${instructions}
${b.outro ? `<div style="margin-top:20px">${para(b.outro)}</div>` : ''}
</td></tr>
<tr><td align="center" style="padding:24px 8px;color:${C.taupe};font-size:12px;line-height:1.6">${esc(s.business_name)}${contacts ? '<br>' + contacts : ''}<br>Email di servizio relativa alla tua prenotazione.</td></tr>
</table></td></tr></table></body></html>`;

  const text = [
    s.business_name,
    '',
    b.heading,
    '',
    ...b.intro,
    '',
    ...b.rows.filter(([, v]) => v).map(([k, v]) => `${k}: ${v}`),
    ...(b.cta ? ['', `${b.cta.label}: ${b.cta.url}`, b.cta.note ?? ''] : []),
    ...(instructions && s.email_instructions ? ['', s.email_instructions] : []),
    ...(b.outro ? ['', ...b.outro] : []),
    '',
    '—',
    [s.business_name, s.address, s.contact_phone, s.contact_email].filter(Boolean).join('\n'),
  ].join('\n');

  return { html, text };
}

export function renderEmail(ctx: NotificationContext, opts: { manageUrl: string | null; adminUrl: string | null }): RenderedEmail {
  const s = ctx.settings;
  const a = ctx.appointment;
  const r = ctx.request;
  const hi = ctx.customer_first_name ? `Ciao ${ctx.customer_first_name},` : 'Gentile cliente,';
  const contactLine = s.contact_phone ? `Per qualsiasi necessità puoi chiamarci al ${s.contact_phone}.` : 'Per qualsiasi necessità rispondi a questa email.';
  const manage = opts.manageUrl
    ? {
        label: 'Gestisci appuntamento',
        url: opts.manageUrl,
        note:
          s.customer_change_min_hours > 0
            ? `Puoi annullare o spostare fino a ${s.customer_change_min_hours} ore prima. Link personale: non inoltrarlo.`
            : 'Link personale: non inoltrarlo.',
      }
    : undefined;

  const apptRows = (): [string, string][] =>
    a
      ? [
          ['Servizio', serviceLabel(a.service_name, a.category)],
          ['Data e ora', when(a.starts_at)],
          ['Con', a.staff_name],
          // prezzo indicativo solo per i servizi parrucchiere e solo se pubblicato
          ['Prezzo indicativo', a.category !== 'consultation' && a.total_price_cents != null ? formatPrice(a.total_price_cents, !!a.price_is_estimate) : ''],
          ['Indirizzo', s.address ?? ''],
          ['Riferimento', a.code],
        ]
      : [];

  const subj = (t: string) => `${t} – ${s.business_name}`;
  let block: Block;
  let subject: string;

  switch (ctx.kind) {
    case 'booking_confirmed':
      subject = subj('Appuntamento confermato');
      block = { heading: 'Appuntamento confermato', intro: [hi, 'ti confermiamo il tuo appuntamento. Ti aspettiamo!'], rows: apptRows(), cta: manage, outro: [contactLine] };
      break;
    case 'request_approved':
      subject = subj('Appuntamento confermato');
      block = { heading: 'Appuntamento confermato', intro: [hi, 'la tua richiesta è stata accolta: ecco i dettagli del tuo appuntamento.'], rows: apptRows(), cta: manage, outro: [contactLine] };
      break;
    case 'request_received': {
      const isRes = ctx.data.is_reschedule === true;
      subject = subj(isRes ? 'Richiesta di spostamento ricevuta' : 'Richiesta ricevuta');
      const pref = r
        ? [r.preferred_date ? cap(formatCalendarDate(r.preferred_date, { weekday: 'long', day: 'numeric', month: 'long' })) : 'Qualsiasi giorno', r.preferred_time_window].join(', ')
        : '';
      block = {
        heading: isRes ? 'Richiesta di spostamento ricevuta' : 'Richiesta ricevuta',
        intro: isRes
          ? [hi, 'abbiamo ricevuto la tua richiesta di spostamento. Il tuo appuntamento attuale resta valido finché non ti confermiamo il nuovo orario.']
          : [hi, 'abbiamo ricevuto la tua richiesta. Non è ancora una prenotazione: ti contatteremo per fissare insieme l\'appuntamento.'],
        rows: [
          ['Servizio', serviceLabel(r?.service_name, r?.category)],
          ['Preferenza', pref],
          ...(isRes && a ? ([['Appuntamento attuale', when(a.starts_at)]] as [string, string][]) : []),
          ['Riferimento', r?.code ?? ''],
        ],
        outro: [contactLine],
      };
      break;
    }
    case 'request_rejected': {
      const isRes = ctx.data.is_reschedule === true;
      subject = subj(isRes ? 'Spostamento non disponibile' : 'Aggiornamento sulla tua richiesta');
      block = {
        heading: isRes ? 'Spostamento non disponibile' : 'Aggiornamento sulla tua richiesta',
        intro: isRes
          ? [hi, 'purtroppo non è stato possibile spostare il tuo appuntamento. L\'appuntamento attuale resta confermato.']
          : [hi, 'purtroppo non possiamo confermare la tua richiesta. Contattaci per trovare insieme un\'alternativa.'],
        rows: [
          ['Servizio', serviceLabel(r?.service_name, r?.category)],
          ...(isRes && a && a.status === 'confirmed' ? ([['Appuntamento', when(a.starts_at)]] as [string, string][]) : []),
          ['Riferimento', r?.code ?? ''],
        ],
        outro: [contactLine],
      };
      break;
    }
    case 'request_proposal': {
      subject = subj('Ti proponiamo un orario');
      const proposed = r?.proposed_starts_at ?? String(ctx.data.proposed_starts_at ?? '');
      block = {
        heading: 'Ti proponiamo un orario',
        intro: [hi, 'per la tua richiesta ti proponiamo il seguente orario. Non è ancora confermato: rispondi a questa email o chiamaci per accettarlo o chiedere un\'alternativa.'],
        rows: [
          ['Servizio', serviceLabel(r?.service_name, r?.category)],
          ['Proposta', proposed ? when(proposed) : ''],
          ['Con', r?.proposed_staff_name ?? ''],
          ['Indirizzo', s.address ?? ''],
          ['Riferimento', r?.code ?? ''],
        ],
        outro: [contactLine],
      };
      break;
    }
    case 'appointment_rescheduled': {
      subject = subj('Appuntamento spostato');
      const prev = typeof ctx.data.previous_starts_at === 'string' ? ctx.data.previous_starts_at : null;
      block = {
        heading: 'Appuntamento spostato',
        intro: [hi, 'il tuo appuntamento è stato spostato. Ecco il nuovo orario.'],
        rows: [...apptRows().slice(0, 2), ...(prev ? ([['Orario precedente', when(prev)]] as [string, string][]) : []), ...apptRows().slice(2)],
        cta: manage,
        outro: [contactLine],
      };
      break;
    }
    case 'appointment_cancelled':
      subject = subj('Appuntamento annullato');
      block = {
        heading: 'Appuntamento annullato',
        intro:
          ctx.data.by === 'customer'
            ? [hi, 'come richiesto, abbiamo annullato il tuo appuntamento.']
            : [hi, 'il tuo appuntamento è stato annullato. Contattaci se desideri fissarne uno nuovo.'],
        rows: a ? [['Servizio', serviceLabel(a.service_name, a.category)], ['Data e ora', when(a.starts_at)], ['Riferimento', a.code]] : [],
        outro: [contactLine],
      };
      break;
    case 'reminder':
      subject = subj(`Promemoria: ${a ? cap(formatLongDate(a.starts_at)) + ' alle ' + formatTime(a.starts_at) : 'il tuo appuntamento'}`);
      block = { heading: 'Promemoria appuntamento', intro: [hi, 'ti ricordiamo il tuo prossimo appuntamento.'], rows: apptRows(), cta: manage, outro: [contactLine] };
      break;
    case 'salon_customer_change': {
      const action = String(ctx.data.action ?? '');
      const label = action === 'cancel' ? 'Annullato dal cliente' : action === 'reschedule' ? 'Spostato dal cliente' : 'Richiesta di spostamento';
      subject = `${label}: ${a?.code ?? ''}`;
      const prev = typeof ctx.data.previous_starts_at === 'string' ? ctx.data.previous_starts_at : null;
      const next = typeof ctx.data.starts_at === 'string' ? ctx.data.starts_at : null;
      block = {
        heading: label,
        intro: [
          action === 'reschedule_request'
            ? 'Un cliente ha chiesto di spostare il suo appuntamento. La richiesta è in attesa nella dashboard.'
            : 'Un cliente ha modificato il proprio appuntamento tramite il link personale.',
        ],
        rows: [
          ['Cliente', ctx.customer_first_name ?? ''],
          ['Servizio', serviceLabel(a?.service_name, a?.category)],
          ['Orario precedente', prev ? when(prev) : ''],
          ['Nuovo orario', next ? when(next) : ''],
          ['Con', a?.staff_name ?? ''],
          ['Riferimento', a?.code ?? ''],
        ],
        cta: opts.adminUrl ? { label: 'Apri la dashboard', url: opts.adminUrl } : undefined,
      };
      break;
    }
    default:
      throw new Error(`Tipo notifica sconosciuto: ${(ctx as { kind: string }).kind}`);
  }

  const { html, text } = layout(ctx, block, block.intro.join(' ').slice(0, 120));
  return { subject, html, text };
}
