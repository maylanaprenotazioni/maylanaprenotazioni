import { useEffect, useState } from 'react';
import { api, ApiError } from '../lib/api';
import type { Catalog, PublicGroup, Service } from '../lib/types';
import { formatDuration, formatPrice } from '../lib/time';
import { GROUPS } from '../lib/bundle';
import { customerMessages } from '../lib/whatsapp';
import { Alert, Spinner } from '../components/ui';
import { Brand } from '../components/Brand';
import { WhatsAppButton } from '../components/BookingBits';

const groupLink = (g: PublicGroup) => (g === 'consulenze' ? '/prenota?sezione=capelli-for-you' : `/prenota?sezione=${g}`);

/** Home pubblica: presentazione del salone, listino per categoria e accesso rapido alla prenotazione. */
export default function HomePage() {
  const [catalog, setCatalog] = useState<Catalog | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    document.title = 'Maylana Coiffeur — Prenota il tuo appuntamento';
    api
      .catalog()
      .then(setCatalog)
      .catch((e: ApiError) => setError(e.message));
  }, []);

  const s = catalog?.settings;
  const byGroup = new Map<PublicGroup, Service[]>();
  for (const sv of catalog?.services ?? []) byGroup.set(sv.public_group, [...(byGroup.get(sv.public_group) ?? []), sv]);
  const groups = GROUPS.filter((g) => byGroup.has(g.key));
  const bookingOn = s ? s.online_booking_enabled && (catalog?.services.length ?? 0) > 0 : true;

  return (
    <div className="min-h-dvh">
      <section className="border-b border-line bg-paper">
        <div className="mx-auto flex max-w-3xl flex-col items-center px-5 pb-14 pt-14 text-center sm:pt-20">
          <Brand name={s?.business_name ?? 'Maylana Coiffeur'} logoUrl={s?.logo_url} />
          <p className="mt-8 max-w-md font-display text-3xl leading-tight sm:text-4xl">Il tuo momento, su misura.</p>
          <p className="mt-4 max-w-md text-[15px] leading-relaxed text-taupe">
            Taglio, colore, trattamenti e consulenze Capelli For You. Scegli il servizio e l'orario che preferisci: la conferma arriva subito.
          </p>
          <a
            href="/prenota"
            className="mt-8 inline-flex min-h-12 items-center justify-center rounded-full bg-ink px-8 text-[15px] tracking-wide text-ivory hover:bg-ink-soft"
          >
            Prenota ora
          </a>
          {s && !bookingOn && (
            <p className="mt-4 text-sm text-taupe">
              Le prenotazioni online sono momentaneamente sospese{s.contact_phone ? `: chiama il ${s.contact_phone}` : ''}.
            </p>
          )}
          {s?.address && <p className="mt-6 text-sm text-taupe">{s.address}</p>}
        </div>
      </section>

      <main className="mx-auto max-w-3xl px-5 py-12">
        {s?.public_notice && (
          <div className="mb-8">
            <Alert tone="info">{s.public_notice}</Alert>
          </div>
        )}

        <h2 className="mb-6 text-center text-xs uppercase tracking-[0.3em] text-taupe">I nostri servizi</h2>

        {!catalog && !error && (
          <div className="flex justify-center py-10 text-taupe">
            <Spinner />
          </div>
        )}
        {error && <Alert>{error}</Alert>}

        <div className="grid gap-4 sm:grid-cols-2">
          {(groups.length ? groups : catalog ? GROUPS : []).map((g) => {
            const list = byGroup.get(g.key) ?? [];
            return (
              <a key={g.key} href={groupLink(g.key)} className="group block rounded-2xl border border-line bg-paper p-5 transition hover:border-champagne-deep">
                <div className="flex items-baseline justify-between gap-3">
                  <h3 className="font-display text-xl">{g.label}</h3>
                  <span className="text-sm text-champagne-deep group-hover:underline">Prenota →</span>
                </div>
                <p className="mt-1 text-sm text-taupe">{g.hint}</p>
                {list.length > 0 && (
                  <ul className="mt-4 space-y-1.5 text-sm">
                    {list.slice(0, 5).map((sv) => (
                      <li key={sv.id} className="flex items-baseline gap-2">
                        <span>{sv.name}</span>
                        <span className="leader" />
                        <span className="whitespace-nowrap text-taupe">
                          {sv.price_cents !== null ? formatPrice(sv.price_cents, sv.price_from) : formatDuration(sv.duration_minutes)}
                        </span>
                      </li>
                    ))}
                    {list.length > 5 && <li className="text-taupe">e altri {list.length - 5}…</li>}
                  </ul>
                )}
              </a>
            );
          })}
        </div>

        {catalog && catalog.staff.length > 0 && (
          <section className="mt-14 text-center">
            <h2 className="mb-6 text-xs uppercase tracking-[0.3em] text-taupe">Il team</h2>
            <div className="flex flex-wrap justify-center gap-3">
              {catalog.staff.map((p) => (
                <div key={p.id} className="rounded-2xl border border-line bg-paper px-5 py-3">
                  <p className="font-display text-lg">{p.display_name}</p>
                  {p.bio && <p className="mt-1 max-w-[16rem] text-xs text-taupe">{p.bio}</p>}
                </div>
              ))}
            </div>
          </section>
        )}

        <section className="mt-14 grid gap-4 text-center sm:grid-cols-3">
          {[
            ['Prenoti in un minuto', "Scegli servizio, operatore e orario libero."],
            ['Conferma immediata', 'Ricevi il riepilogo e puoi aggiungerlo al calendario.'],
            ['Modifichi quando vuoi', 'Con il link personale sposti o annulli in autonomia.'],
          ].map(([t, d]) => (
            <div key={t} className="rounded-2xl bg-champagne-wash/50 px-4 py-5">
              <p className="font-display text-lg">{t}</p>
              <p className="mt-1 text-sm text-taupe">{d}</p>
            </div>
          ))}
        </section>
      </main>

      <footer className="border-t border-line px-5 py-8 text-center text-xs leading-relaxed text-taupe">
        <div className="space-y-3">
          {s && <WhatsAppButton number={s.whatsapp_number} text={customerMessages.general()} />}
          {s?.contact_phone && (
            <p>
              <a className="underline-offset-4 hover:underline" href={`tel:${s.contact_phone.replace(/\s/g, '')}`}>
                {s.contact_phone}
              </a>
            </p>
          )}
          {s?.privacy_url && (
            <p>
              <a className="underline underline-offset-4" href={s.privacy_url} target="_blank" rel="noreferrer">
                Informativa privacy
              </a>
            </p>
          )}
          <p>
            <a href="/admin" className="underline-offset-4 hover:underline">
              Area riservata
            </a>
          </p>
        </div>
      </footer>
    </div>
  );
}
