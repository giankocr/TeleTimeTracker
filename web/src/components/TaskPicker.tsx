import { Field } from './ui';

/**
 * SELECTOR DE TAREA PARA UN REGISTRO DE TIEMPO
 *
 * Un registro de tiempo SIEMPRE pertenece (o puede pertenecer) a una tarea, y
 * una tarea acumula varios registros. Aquí se elige a cuál:
 *
 *   · «Sin tarea»        -> el registro queda suelto (no recomendado: no cuenta
 *                           en el acumulado de ninguna tarea).
 *   · una tarea existente -> se muestra con sus registros y su tiempo acumulado.
 *   · «+ Nueva tarea…»    -> se escribe el título y el servidor la crea dentro
 *                           del proyecto elegido (`newTaskTitle`).
 *
 * El filtro por proyecto evita asignar a mano una tarea de otro proyecto: el
 * registro y su tarea quedarían en sitios distintos de la jerarquía.
 */

const NEW_TASK = '__nueva__';

export interface TaskOption {
  id: string;
  title: string;
  projectId?: string | null;
  projectName?: string | null;
  entryCount?: number;
  totalSeconds?: number;
}

export function TaskPicker({
  tasks,
  value,
  newTitle,
  projectId,
  onChange,
  onNewTitleChange,
  hint,
}: {
  tasks: TaskOption[];
  /** '' = sin tarea, '__nueva__' = crear una nueva, otro = id de tarea. */
  value: string;
  newTitle: string;
  /** Proyecto elegido en el mismo formulario: filtra las tareas ofrecidas. */
  projectId: string;
  onChange: (value: string) => void;
  onNewTitleChange: (title: string) => void;
  hint?: string;
}) {
  const delProyecto = tasks.filter((t) => !projectId || t.projectId === projectId);
  const otras = tasks.filter((t) => projectId && t.projectId !== projectId);
  const creando = value === NEW_TASK;

  return (
    <>
      <Field
        label="Tarea a la que pertenece"
        hint={
          hint ??
          'El tiempo se acumula en la tarea. Una tarea puede tener varios registros: al retomarla se añade otro.'
        }
      >
        <select className="select" value={value} onChange={(e) => onChange(e.target.value)}>
          <option value="">Sin tarea</option>
          {delProyecto.length ? (
            <optgroup label={projectId ? 'Tareas de este proyecto' : 'Tareas'}>
              {delProyecto.map((t) => (
                <option key={t.id} value={t.id}>
                  {t.title}
                  {t.entryCount ? ` · ${t.entryCount} registro(s)` : ''}
                </option>
              ))}
            </optgroup>
          ) : null}
          {otras.length ? (
            <optgroup label="Tareas de otros proyectos">
              {otras.map((t) => (
                <option key={t.id} value={t.id}>
                  {t.title}
                  {t.projectName ? ` · ${t.projectName}` : ''}
                </option>
              ))}
            </optgroup>
          ) : null}
          <option value={NEW_TASK}>＋ Nueva tarea…</option>
        </select>
      </Field>

      {creando ? (
        <Field
          label="Título de la tarea nueva"
          hint="Si ya existe una tarea con ese título en el mismo proyecto, se reutiliza en lugar de duplicarla."
        >
          <input
            className="input"
            value={newTitle}
            onChange={(e) => onNewTitleChange(e.target.value)}
            placeholder="Maquetación del login"
          />
        </Field>
      ) : null}
    </>
  );
}

export { NEW_TASK };
