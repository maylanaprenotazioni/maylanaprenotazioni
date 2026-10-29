import type { ReactNode } from 'react';
import { Spinner } from '../../components/ui';
import { Brand } from '../../components/Brand';

/** Il login mostra subito il modulo "Password dimenticata?" con questo frammento. */
export const FORGOT_HASH = '#password-dimenticata';

/** Contenitore delle schermate di accesso (login, recupero password). */
export function Shell({ children }: { children: ReactNode }) {
  return (
    <div className="mx-auto flex min-h-dvh max-w-sm flex-col justify-center gap-8 px-5 py-10">
      <Brand name="Maylana Coiffeur" />
      {children}
    </div>
  );
}

export function Loading() {
  return (
    <div className="flex min-h-dvh items-center justify-center text-taupe">
      <Spinner />
    </div>
  );
}
