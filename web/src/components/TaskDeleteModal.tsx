import { useEffect, useState } from 'react';
import { api } from '../lib/api';
import { formatSeconds } from '../lib/format';
import { Alert, Modal, Spinner } from './ui';

/**
 * BORRAR TAREA
 *
 * Borrar una tarea puede significar dos cosas MUY distintas para los registros
 * de tiempo, y la diferencia importa: un registro de tiempo es la evidencia del
 * trabajo hecho. Por eso el panel no borra "a secas": muestra primero qué se
 * pierde y deja elegir.
 *
 *   · «Borrar solo la tarea»  -> los tramos se conservan, sin tarea asignada.
 *   · «Borrar también los tramos» -> borrado DEFINITIVO de los registros.
 *
 * El servidor vuelve a comprobar todo (permiso, ajuste de borrado definitivo,
 * tramos en curso y `force=1`): esto es la confirmación, no la autorización.
 */

interface Impact {
  task: { id: string; title: string; projectName: string | null; clientName: string | null };
  entries: number;
  totalSeconds: number;
  runningEntries: number;
  foreignEntries: number;
  canDeleteEntries: boolean;
  hardDeleteEnabled: boolean;
  warning: string | null;
}

export function TaskDeleteModal({
  task,
  onClose,
  onDone,
}: {
  task: { id: string; title: string };
  onClose: () => void;
  onDone: (message: string) => void;
}) {
  const [impact, setImpact] = useState<Impact | null>(null);
  const [loading, setLoading] = useState(true);
  const [working, setWorking] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    void (async () => {
      try {
        setImpact(await api.get<Impact>(`/tasks/${task.id}/impact`));
      } catch (err) {
        setError((err as Error).message);
      } finally {
        setLoading(false);
      }
    })();
  }, [task.id]);

  const remove = async (withEntries: boolean) => {
    setWorking(true);
    setError(null);
    try {
      const res = await api.delete<{ message: string }>(
        `/tasks/${task.id}`,
        withEntries ? { withEntries: 1, force: 1 } : undefined,
      );
      onDone(res.message);
    } catch (err) {
      setError((err as Error).message);
      setWorking(false);
    }
  };

  const tramos = impact?.entries ?? 0;
  const puedeConTramos = Boolean(impact?.canDeleteEntries && impact?.hardDeleteEnabled && impact.runningEntries === 0);

  return (
    <Modal
      title={`Borrar «${task.title}»`}
      onClose={onClose}
      footer={
        <>
          <button className="btn btn-ghost" onClick={onClose} disabled={working}>
            Cancelar
          </button>
          <button className="btn" onClick={() => void remove(false)} disabled={working || loading}>
            {tramos ? 'Borrar solo la tarea' : 'Borrar tarea'}
          </button>
          {tramos ? (
            <button
              className="btn btn-danger"
              onClick={() => void remove(true)}
              disabled={working || loading || !puedeConTramos}
              title={puedeConTramos ? undefined : 'No disponible: revisa el aviso de abajo'}
            >
              {working ? 'Borrando…' : `Borrar tarea y sus ${tramos} registro(s)`}
            </button>
          ) : null}
        </>
      }
    >
      {loading ? (
        <Spinner label="Comprobando qué se pierde…" />
      ) : error && !impact ? (
        <Alert kind="error">{error}</Alert>
      ) : impact ? (
        <div className="stack-sm">
          {error ? <Alert kind="error">{error}</Alert> : null}

          <div className="card" style={{ padding: 14 }}>
            <div className="stack-sm" style={{ gap: 4 }}>
              <span className="small">
                {impact.task.projectName ?? 'sin proyecto'} · {impact.task.clientName ?? 'sin cliente'}
              </span>
              <span className="small">
                <b>{tramos}</b> registro(s) de tiempo · <b>{formatSeconds(impact.totalSeconds)}</b> acumulados
              </span>
            </div>
          </div>

          {impact.warning ? <Alert kind="warning">{impact.warning}</Alert> : null}

          {tramos ? (
            <>
              <Alert kind="info">
                <b>Borrar solo la tarea</b> conserva los {tramos} registro(s) de tiempo: seguirán contando en las horas y
                los reportes, pero quedarán sin tarea asignada (puedes volver a asignarlos desde «Registros de tiempo»).
              </Alert>
              {impact.canDeleteEntries ? (
                <Alert kind={impact.hardDeleteEnabled && impact.runningEntries === 0 ? 'warning' : 'error'}>
                  <b>Borrar tarea y sus registros</b> es <b>definitivo</b>: se pierden {tramos} registro(s) de tiempo y{' '}
                  {formatSeconds(impact.totalSeconds)} de trabajo. No se puede deshacer.
                  {!impact.hardDeleteEnabled ? (
                    <>
                      {' '}
                      Está desactivado en la configuración (<i>permitir borrado definitivo</i>), así que esta opción no
                      está disponible.
                    </>
                  ) : null}
                  {impact.runningEntries > 0 ? (
                    <> Hay {impact.runningEntries} registro(s) en curso: detenlos primero.</>
                  ) : null}
                </Alert>
              ) : (
                <Alert kind="info">
                  No tienes permiso de borrado definitivo de registros, así que solo puedes borrar la tarea (los tramos
                  se conservan).
                </Alert>
              )}
            </>
          ) : (
            <Alert kind="info">Esta tarea no tiene tiempo registrado: se borrará solo la tarea.</Alert>
          )}

          {impact.foreignEntries > 0 ? (
            <Alert kind="warning">
              {impact.foreignEntries} de estos registros son de otras personas (fuera de tu ámbito). Revísalos antes de
              borrarlos.
            </Alert>
          ) : null}
        </div>
      ) : null}
    </Modal>
  );
}
