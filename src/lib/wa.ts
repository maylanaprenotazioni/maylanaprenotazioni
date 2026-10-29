/** Numero in formato internazionale per wa.me (prefisso Italia se assente). */
export function waNumber(phone: string, defaultCountry = '39'): string {
  let d = phone.replace(/[^\d+]/g, '');
  if (d.startsWith('+')) d = d.slice(1);
  else if (d.startsWith('00')) d = d.slice(2);
  else if (!d.startsWith(defaultCountry) || d.length <= 10) d = defaultCountry + d;
  return d;
}

/** Link wa.me con testo precompilato: apre WhatsApp, l'invio lo fa la persona. */
export function waLink(phone: string, text: string): string {
  return `https://wa.me/${waNumber(phone)}?text=${encodeURIComponent(text)}`;
}
