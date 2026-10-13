import { useState } from 'react';

/**
 * SELECTOR DE VARIOS PROYECTOS
 *
 * Un `<select multiple>` obliga a usar Ctrl/Cmd para elegir más de uno y se
 * pierde la selección al primer clic fuera. Aquí el botón abre una lista de
 * casillas, que es lo que se espera cuando hay que marcar un grupo de proyectos
 * (por ejemplo, todos los de un cliente) para facturarlos de una vez.
 *
 * El control no incluye etiqueta: cada pantalla lo envuelve en su propio `Field`
 * o lo pone dentro de su fila de filtros.
 */
export interface ProjectOption {
  id: string;
  name: string;
  clientName?: string | null;
}

export function ProjectMultiSelect({
  projects,
  value,
  onChange,
  /** Texto del botón cuando no hay ninguno marcado. */
  emptyLabel = 'Todos los proyectos',
  /** Etiqueta del botón; con un solo proyecto elegido se muestra su nombre. */
  title = 'Proyectos',
}: {
  projects: ProjectOption[];
  value: string[];
  onChange: (ids: string[]) => void;
  emptyLabel?: string;
  title?: string;
}) {
  const [open, setOpen] = useState(false);

  const toggle = (id: string, checked: boolean) =>
    onChange(checked ? [...value, id] : value.filter((v) => v !== id));

  const etiqueta =
    value.length === 0
      ? emptyLabel
      : value.length === 1
        ? (projects.find((p) => p.id === value[0])?.name ?? '1 proyecto')
        : `${value.length} proyectos`;

  return (
    <div className="multiselect">
      <button
        type="button"
        className={`btn btn-sm ${value.length ? 'btn-primary' : ''}`}
        onClick={() => setOpen((v) => !v)}
        title={value.length ? `${title}: ${etiqueta}` : `${title}: ${emptyLabel.toLowerCase()}`}
        aria-expanded={open}
      >
        🗂 {etiqueta} <span className="tiny">{open ? '▲' : '▼'}</span>
      </button>

      {open ? (
        <div className="multiselect-panel">
          <div className="row-between" style={{ marginBottom: 8 }}>
            <span className="tiny muted-2">
              {value.length ? `${value.length} de ${projects.length} marcados` : `Sin filtro (${projects.length} disponibles)`}
            </span>
            <div className="btn-row">
              <button type="button" className="btn btn-sm btn-ghost" onClick={() => onChange(projects.map((p) => p.id))}>
                Todos
              </button>
              <button type="button" className="btn btn-sm btn-ghost" onClick={() => onChange([])} disabled={!value.length}>
                Limpiar
              </button>
            </div>
          </div>

          {projects.length === 0 ? (
            <span className="tiny muted-2">No hay proyectos que mostrar con los filtros actuales.</span>
          ) : (
            <div className="stack-sm">
              {projects.map((p) => (
                <label key={p.id} className="checkbox">
                  <input type="checkbox" checked={value.includes(p.id)} onChange={(e) => toggle(p.id, e.target.checked)} />
                  <span>
                    {p.name}
                    {/* El cliente solo se repite cuando la lista mezcla clientes. */}
                    {p.clientName ? <span className="tiny muted-2"> · {p.clientName}</span> : null}
                  </span>
                </label>
              ))}
            </div>
          )}
        </div>
      ) : null}
    </div>
  );
}
