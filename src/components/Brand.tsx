import { useState } from 'react';

/** Logo configurabile (business_settings.logo_url) con ripiego sul marchio tipografico. */
export function Brand({ name, logoUrl, size = 'lg' }: { name: string; logoUrl?: string | null; size?: 'lg' | 'sm' }) {
  const [broken, setBroken] = useState(false);
  if (logoUrl && !broken) {
    return <img src={logoUrl} alt={name} onError={() => setBroken(true)} className={size === 'lg' ? 'mx-auto h-16 w-auto object-contain' : 'h-8 w-auto object-contain'} />;
  }
  const [first, ...rest] = name.split(' ');
  return (
    <div className={size === 'lg' ? 'text-center leading-none' : 'leading-none'}>
      <span className={size === 'lg' ? 'font-display text-[44px] tracking-[0.04em]' : 'font-display text-2xl tracking-[0.04em]'}>{first}</span>
      {rest.length > 0 && (
        <span className={size === 'lg' ? 'mt-1 block text-[13px] tracking-[0.42em] text-taupe' : 'ml-2 text-[11px] tracking-[0.3em] text-taupe'}>
          {rest.join(' ').toLowerCase()}
        </span>
      )}
    </div>
  );
}
