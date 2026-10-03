import { createContext, useCallback, useContext, useEffect, useState, type ReactNode } from 'react';

/* =========================================================================
   Componentes base reutilizables del panel.
   ========================================================================= */

// ------------------------------------------------------------------ Toasts
interface Toast {
  id: number;
  message: string;
  kind: 'success' | 'error' | 'info';
}

const ToastContext = createContext<{ push: (message: string, kind?: Toast['kind']) => void } | null>(null);

export function ToastProvider({ children }: { children: ReactNode }) {
  const [toasts, setToasts] = useState<Toast[]>([]);

  const push = useCallback((message: string, kind: Toast['kind'] = 'info') => {
    const id = Date.now() + Math.random();
    setToasts((prev) => [...prev, { id, message, kind }]);
    setTimeout(() => setToasts((prev) => prev.filter((t) => t.id !== id)), 4500);
  }, []);

  return (
    <ToastContext.Provider value={{ push }}>
      {children}
      <div className="toasts">
        {toasts.map((t) => (
          <div key={t.id} className={`toast toast-${t.kind}`}>
            {t.message}
          </div>
        ))}
      </div>
    </ToastContext.Provider>
  );
}

export function useToast() {
  const ctx = useContext(ToastContext);
  return ctx ?? { push: (m: string) => console.log(m) };
}

// ------------------------------------------------------------------- Modal
export function Modal({
  title,
  children,
  onClose,
  wide,
  footer,
}: {
  title: string;
  children: ReactNode;
  onClose: () => void;
  wide?: boolean;
  footer?: ReactNode;
}) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  return (
    <div className="modal-backdrop" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className={`modal ${wide ? 'modal-wide' : ''}`} role="dialog" aria-modal="true">
        <div className="card-title">
          <h3>{title}</h3>
          <button className="btn btn-ghost btn-sm" onClick={onClose} aria-label="Cerrar">
            ✕
          </button>
        </div>
        <div className="stack">{children}</div>
        {footer ? <div className="btn-row" style={{ justifyContent: 'flex-end', marginTop: 18 }}>{footer}</div> : null}
      </div>
    </div>
  );
}

// -------------------------------------------------------------------- Cards
export function StatCard({
  label,
  value,
  sub,
  icon,
  accent,
}: {
  label: string;
  value: ReactNode;
  sub?: ReactNode;
  icon?: string;
  accent?: string;
}) {
  return (
    <div className="card stat">
      <div className="row-between">
        <span className="stat-label">{label}</span>
        {icon ? <span className="stat-icon" style={accent ? { color: accent } : undefined}>{icon}</span> : null}
      </div>
      <div className="stat-value" style={accent ? { color: accent } : undefined}>{value}</div>
      {sub ? <div className="stat-sub">{sub}</div> : null}
    </div>
  );
}

export function Card({
  title,
  hint,
  actions,
  children,
  style,
}: {
  title?: string;
  hint?: string;
  actions?: ReactNode;
  children: ReactNode;
  style?: React.CSSProperties;
}) {
  return (
    <div className="card" style={style}>
      {title ? (
        <div className="card-title">
          <div>
            <h3>{title}</h3>
            {hint ? <div className="card-hint">{hint}</div> : null}
          </div>
          {actions}
        </div>
      ) : null}
      {children}
    </div>
  );
}

export function Empty({ children }: { children: ReactNode }) {
  return <div className="empty">{children}</div>;
}

export function Alert({ kind = 'info', children }: { kind?: 'info' | 'error' | 'success' | 'warning'; children: ReactNode }) {
  return <div className={`alert alert-${kind}`}>{children}</div>;
}

export function Spinner({ label }: { label?: string }) {
  return (
    <div className="row" style={{ padding: 24, justifyContent: 'center' }}>
      <span className="muted">{label ?? 'Cargando…'}</span>
    </div>
  );
}

export function Badge({ children, kind = '' }: { children: ReactNode; kind?: string }) {
  return <span className={kind ? `badge ${kind}` : 'badge'}>{children}</span>;
}

// -------------------------------------------------------------------- Fields
export function Field({ label, hint, children }: { label: string; hint?: string; children: ReactNode }) {
  return (
    <div className="field">
      <label>{label}</label>
      {children}
      {hint ? <span className="tiny muted-2">{hint}</span> : null}
    </div>
  );
}

/** Select de rango temporal usado en dashboard, reportes y registros. */
export function RangeSelect({
  value,
  onChange,
  options,
}: {
  value: string;
  onChange: (value: string) => void;
  options: Array<{ value: string; label: string }>;
}) {
  return (
    <select className="select" style={{ width: 'auto' }} value={value} onChange={(e) => onChange(e.target.value)}>
      {options.map((o) => (
        <option key={o.value} value={o.value}>
          {o.label}
        </option>
      ))}
    </select>
  );
}
