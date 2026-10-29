import { useEffect, useId, useRef, type ButtonHTMLAttributes, type InputHTMLAttributes, type ReactNode, type SelectHTMLAttributes, type TextareaHTMLAttributes } from 'react';

export function cx(...c: (string | false | null | undefined)[]) {
  return c.filter(Boolean).join(' ');
}

type Variant = 'primary' | 'secondary' | 'ghost' | 'danger';

export function Button({
  variant = 'primary',
  busy,
  className,
  children,
  disabled,
  ...rest
}: ButtonHTMLAttributes<HTMLButtonElement> & { variant?: Variant; busy?: boolean }) {
  const styles: Record<Variant, string> = {
    primary: 'bg-ink text-ivory hover:bg-ink-soft disabled:bg-taupe/50',
    secondary: 'border border-ink/80 text-ink bg-transparent hover:bg-ink hover:text-ivory disabled:opacity-40',
    ghost: 'text-ink-soft hover:bg-champagne-wash disabled:opacity-40',
    danger: 'border border-danger/60 text-danger hover:bg-danger hover:text-white disabled:opacity-40',
  };
  return (
    <button
      {...rest}
      disabled={disabled || busy}
      aria-busy={busy || undefined}
      className={cx(
        'inline-flex min-h-12 items-center justify-center gap-2 rounded-full px-6 text-[15px] font-medium transition-colors disabled:cursor-not-allowed',
        styles[variant],
        className,
      )}
    >
      {busy && <Spinner small />}
      {children}
    </button>
  );
}

export function Spinner({ small }: { small?: boolean }) {
  return (
    <span
      role="status"
      aria-label="Caricamento"
      className={cx('inline-block animate-spin rounded-full border-2 border-current border-t-transparent', small ? 'size-4' : 'size-6')}
    />
  );
}

export function Field({ label, hint, error, children, htmlFor }: { label: string; hint?: string; error?: string; children: ReactNode; htmlFor?: string }) {
  return (
    <div className="flex flex-col gap-1.5">
      <label htmlFor={htmlFor} className="text-sm font-medium text-ink-soft">
        {label}
      </label>
      {children}
      {hint && !error && <p className="text-xs text-taupe">{hint}</p>}
      {error && <p className="text-xs text-danger">{error}</p>}
    </div>
  );
}

const inputCls =
  'w-full rounded-xl border border-line bg-paper px-4 py-3 text-ink placeholder:text-taupe/70 focus:border-champagne-deep focus:outline-none focus:ring-2 focus:ring-champagne/40 disabled:opacity-60';

export function Input({ label, hint, error, className, ...rest }: InputHTMLAttributes<HTMLInputElement> & { label: string; hint?: string; error?: string }) {
  const id = useId();
  return (
    <Field label={label} hint={hint} error={error} htmlFor={id}>
      <input id={id} {...rest} aria-invalid={!!error || undefined} className={cx(inputCls, className)} />
    </Field>
  );
}

export function Select({ label, hint, className, children, ...rest }: SelectHTMLAttributes<HTMLSelectElement> & { label: string; hint?: string }) {
  const id = useId();
  return (
    <Field label={label} hint={hint} htmlFor={id}>
      <select id={id} {...rest} className={cx(inputCls, className)}>
        {children}
      </select>
    </Field>
  );
}

export function Textarea({ label, hint, className, ...rest }: TextareaHTMLAttributes<HTMLTextAreaElement> & { label: string; hint?: string }) {
  const id = useId();
  return (
    <Field label={label} hint={hint} htmlFor={id}>
      <textarea id={id} rows={3} {...rest} className={cx(inputCls, 'resize-y', className)} />
    </Field>
  );
}

export function Alert({ tone = 'error', children }: { tone?: 'error' | 'info' | 'ok'; children: ReactNode }) {
  const t = {
    error: 'border-danger/30 bg-danger/5 text-danger',
    info: 'border-line bg-paper text-ink-soft',
    ok: 'border-ok/30 bg-ok/5 text-ok',
  }[tone];
  return (
    <div role={tone === 'error' ? 'alert' : 'status'} className={cx('rounded-xl border px-4 py-3 text-sm leading-relaxed', t)}>
      {children}
    </div>
  );
}

export function Badge({ children, tone = 'neutral' }: { children: ReactNode; tone?: 'neutral' | 'gold' | 'ok' | 'danger' | 'muted' }) {
  const t = {
    neutral: 'bg-ivory text-ink-soft border-line',
    gold: 'bg-champagne-wash text-champagne-deep border-champagne/40',
    ok: 'bg-ok/10 text-ok border-ok/20',
    danger: 'bg-danger/10 text-danger border-danger/20',
    muted: 'bg-line/40 text-taupe border-line',
  }[tone];
  return <span className={cx('inline-flex items-center rounded-full border px-2.5 py-0.5 text-xs font-medium', t)}>{children}</span>;
}

/** Finestra modale accessibile (dialog nativo): a schermo intero su smartphone. */
export function Modal({ open, onClose, title, children }: { open: boolean; onClose: () => void; title: string; children: ReactNode }) {
  const ref = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    const d = ref.current;
    if (!d) return;
    if (open && !d.open) d.showModal();
    if (!open && d.open) d.close();
  }, [open]);
  return (
    <dialog
      ref={ref}
      onClose={onClose}
      onCancel={(e) => {
        e.preventDefault();
        onClose();
      }}
      className="m-0 h-dvh max-h-none w-full max-w-none bg-ivory p-0 text-ink backdrop:bg-ink/50 sm:m-auto sm:h-auto sm:max-h-[90dvh] sm:max-w-lg sm:rounded-2xl"
    >
      {open && (
        <div className="flex h-full flex-col">
          <div className="sticky top-0 z-10 flex items-center justify-between border-b border-line bg-ivory px-5 py-4">
            <h2 className="font-display text-xl">{title}</h2>
            <button onClick={onClose} className="rounded-full px-3 py-1 text-sm text-taupe hover:bg-champagne-wash" aria-label="Chiudi">
              Chiudi
            </button>
          </div>
          <div className="flex-1 overflow-y-auto px-5 py-5">{children}</div>
        </div>
      )}
    </dialog>
  );
}

export function EmptyState({ children }: { children: ReactNode }) {
  return <p className="rounded-xl border border-dashed border-line px-4 py-8 text-center text-sm text-taupe">{children}</p>;
}
