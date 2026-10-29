import { useEffect, useState, type FormEvent } from 'react';
import { supabase, dbMessage } from '../../lib/supabase';
import { api } from '../../lib/api';
import type { AdminSettings } from '../../lib/types';
import { Alert, Button, Input, Spinner, Textarea } from '../../components/ui';

export default function SettingsPage() {
  const [s, setS] = useState<AdminSettings | null>(null);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ tone: 'ok' | 'error'; text: string } | null>(null);
  const [email, setEmail] = useState<{ configured: boolean; problem: string | null; provider: string | null; from: string | null } | null>(null);
  const [waCloud, setWaCloud] = useState<{ active: boolean; problems: string[] } | null>(null);
  const [siteUrl, setSiteUrl] = useState<string | null>(null);

  useEffect(() => {
    supabase!.auth.getSession().then(async ({ data }) => {
      try {
        const r = await api.adminStatus(data.session?.access_token ?? '');
        setEmail(r.email);
        setSiteUrl(r.site_url);
        setWaCloud(r.whatsapp_cloud);
      } catch {
        setEmail({ configured: false, problem: 'Funzioni server non raggiungibili', provider: null, from: null });
      }
    });
  }, []);

  useEffect(() => {
    supabase!
      .from('business_settings')
      .select('*')
      .eq('id', 1)
      .single()
      .then(({ data, error }) => {
        if (error) setMsg({ tone: 'error', text: dbMessage(error) });
        setS(data as AdminSettings);
      });
  }, []);

  if (!s) return msg ? <Alert>{msg.text}</Alert> : <Spinner />;

  const set = <K extends keyof AdminSettings>(k: K, v: AdminSettings[K]) => setS({ ...s, [k]: v });
  const nul = (v: string) => (v.trim() === '' ? null : v.trim());

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setMsg(null);
    const { error } = await supabase!
      .from('business_settings')
      .update({
        business_name: s.business_name.trim(),
        logo_url: s.logo_url,
        contact_phone: s.contact_phone,
        contact_email: s.contact_email,
        address: s.address,
        privacy_url: s.privacy_url,
        public_notice: s.public_notice,
        slot_interval_minutes: Number(s.slot_interval_minutes),
        min_notice_minutes: Number(s.min_notice_minutes),
        booking_horizon_days: Number(s.booking_horizon_days),
        online_booking_enabled: s.online_booking_enabled,
        notification_email: s.notification_email,
        email_instructions: s.email_instructions,
        customer_change_min_hours: Number(s.customer_change_min_hours),
        reminder_1_hours: s.reminder_1_hours === null ? null : Number(s.reminder_1_hours),
        reminder_2_hours: s.reminder_2_hours === null ? null : Number(s.reminder_2_hours),
        whatsapp_number: s.whatsapp_number,
        booking_buffer_minutes: Number(s.booking_buffer_minutes),
        smart_slots_enabled: s.smart_slots_enabled,
        min_useful_gap_minutes: Number(s.min_useful_gap_minutes),
        max_recommended_slots: Number(s.max_recommended_slots),
      })
      .eq('id', 1);
    setBusy(false);
    setMsg(error ? { tone: 'error', text: dbMessage(error) } : { tone: 'ok', text: 'Impostazioni salvate.' });
  };

  return (
    <form onSubmit={submit} className="max-w-xl space-y-4">
      <label className="flex items-center gap-3 rounded-xl border border-line bg-paper px-4 py-3">
        <input type="checkbox" checked={s.online_booking_enabled} onChange={(e) => set('online_booking_enabled', e.target.checked)} className="size-5 accent-ink" />
        Prenotazioni online attive
      </label>
      <Input label="Nome del salone" value={s.business_name} onChange={(e) => set('business_name', e.target.value)} required />
      <Input label="URL del logo (https://…)" hint="Immagine PNG/SVG pubblicata sul sito vetrina o su Supabase Storage. Vuoto = marchio tipografico." value={s.logo_url ?? ''} onChange={(e) => set('logo_url', nul(e.target.value))} />
      <Input label="Telefono pubblico" value={s.contact_phone ?? ''} onChange={(e) => set('contact_phone', nul(e.target.value))} />
      <Input label="Email pubblica" type="email" value={s.contact_email ?? ''} onChange={(e) => set('contact_email', nul(e.target.value))} />
      <Input label="Indirizzo" value={s.address ?? ''} onChange={(e) => set('address', nul(e.target.value))} />
      <Input label="Link informativa privacy" hint="Pagina privacy del sito esistente." value={s.privacy_url ?? ''} onChange={(e) => set('privacy_url', nul(e.target.value))} />
      <Textarea label="Avviso in pagina (facoltativo)" maxLength={500} value={s.public_notice ?? ''} onChange={(e) => set('public_notice', nul(e.target.value))} />
      <div className="grid grid-cols-3 gap-3">
        <Input label="Intervallo slot (min)" inputMode="numeric" value={String(s.slot_interval_minutes)} onChange={(e) => set('slot_interval_minutes', Number(e.target.value))} />
        <Input label="Preavviso minimo (min)" inputMode="numeric" value={String(s.min_notice_minutes)} onChange={(e) => set('min_notice_minutes', Number(e.target.value))} />
        <Input label="Prenotabile fino a (giorni)" inputMode="numeric" value={String(s.booking_horizon_days)} onChange={(e) => set('booking_horizon_days', Number(e.target.value))} />
      </div>
      <h2 className="pt-6 font-display text-xl">Orari e disponibilità</h2>
      <Input
        label="Tempo aggiuntivo per ogni appuntamento (minuti)"
        inputMode="numeric"
        hint="Aggiunto in coda a ogni appuntamento, oltre ai tempi di preparazione dei singoli servizi. 0 = nessuno."
        value={String(s.booking_buffer_minutes)}
        onChange={(e) => set('booking_buffer_minutes', Number(e.target.value))}
      />
      <label className="flex items-center gap-3 rounded-xl border border-line bg-paper px-4 py-3">
        <input type="checkbox" checked={s.smart_slots_enabled} onChange={(e) => set('smart_slots_enabled', e.target.checked)} className="size-5 accent-ink" />
        Mostra prima gli orari consigliati (riducono gli spazi vuoti in agenda)
      </label>
      <div className="grid grid-cols-2 gap-3">
        <Input
          label="Spazio minimo utile (minuti)"
          inputMode="numeric"
          hint="Un orario che lascia un buco più corto di così non viene consigliato."
          value={String(s.min_useful_gap_minutes)}
          onChange={(e) => set('min_useful_gap_minutes', Number(e.target.value))}
        />
        <Input label="Quanti orari consigliare" inputMode="numeric" hint="0 = nessuno" value={String(s.max_recommended_slots)} onChange={(e) => set('max_recommended_slots', Number(e.target.value))} />
      </div>
      <p className="text-xs text-taupe">
        Regola degli orari consigliati: prima quelli che riempiono esattamente uno spazio libero, poi quelli attaccati a un appuntamento o all'inizio/fine turno senza lasciare buchi inutilizzabili. Tutti gli altri orari validi restano prenotabili; gli appuntamenti confermati non vengono mai spostati.
      </p>

      <h2 className="pt-6 font-display text-xl">WhatsApp</h2>
      <Input
        label="Numero WhatsApp del salone"
        type="tel"
        hint="Mostra ai clienti il pulsante per scrivere al salone (link wa.me). Formato: +39 …"
        value={s.whatsapp_number ?? ''}
        onChange={(e) => set('whatsapp_number', nul(e.target.value))}
      />
      <Alert tone="info">
        I pulsanti WhatsApp aprono la chat con un messaggio già scritto: l'invio lo fa sempre una persona. Non partono notifiche automatiche.
        {waCloud && !waCloud.active && ' Invio automatico tramite WhatsApp Business Platform: non attivo (modulo predisposto, vedi documentazione).'}
      </Alert>

      <h2 className="pt-6 font-display text-xl">Email e promemoria</h2>
      {email && (
        <Alert tone={email.configured ? 'ok' : 'error'}>
          {email.configured
            ? `Servizio email attivo (${email.provider}), mittente ${email.from}.`
            : `Servizio email NON configurato: nessuna email viene inviata. ${email.problem ?? ''}`}
          {siteUrl ? '' : ' Manca PUBLIC_SITE_URL: le email non conterranno il link per gestire l\'appuntamento.'}
        </Alert>
      )}
      <Input
        label="Email del salone per gli avvisi"
        type="email"
        hint="Riceve gli avvisi quando un cliente annulla o sposta tramite il link."
        value={s.notification_email ?? ''}
        onChange={(e) => set('notification_email', nul(e.target.value))}
      />
      <Textarea
        label="Istruzioni nelle email (facoltative)"
        hint="Es. come raggiungere il salone. Non inserire indicazioni sanitarie."
        maxLength={1000}
        value={s.email_instructions ?? ''}
        onChange={(e) => set('email_instructions', nul(e.target.value))}
      />
      <div className="grid grid-cols-3 gap-3">
        <Input label="Primo promemoria (ore prima)" inputMode="numeric" hint="Vuoto = disattivato" value={s.reminder_1_hours === null ? '' : String(s.reminder_1_hours)} onChange={(e) => set('reminder_1_hours', e.target.value === '' ? null : Number(e.target.value))} />
        <Input label="Secondo promemoria (ore prima)" inputMode="numeric" hint="Facoltativo, minore del primo" value={s.reminder_2_hours === null ? '' : String(s.reminder_2_hours)} onChange={(e) => set('reminder_2_hours', e.target.value === '' ? null : Number(e.target.value))} />
        <Input label="Modifiche cliente fino a (ore prima)" inputMode="numeric" hint="Annullo/spostamento online" value={String(s.customer_change_min_hours)} onChange={(e) => set('customer_change_min_hours', Number(e.target.value))} />
      </div>
      {msg && <Alert tone={msg.tone}>{msg.text}</Alert>}
      <Button type="submit" busy={busy} className="w-full">
        Salva impostazioni
      </Button>
    </form>
  );
}
