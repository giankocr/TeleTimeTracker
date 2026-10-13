import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { prisma } from '../db/prisma';
import { PERMISSIONS } from '../../../shared/types';
import { hasPermission, requirePermission } from '../middleware/auth';
import {
  billingCurrency,
  billingOverview,
  buildClientStatement,
  markTasksBilling,
  statementToCsv,
} from '../services/billing.service';
import { resolveRange } from '../utils/time';
import { audit } from '../utils/audit';

/**
 * FACTURACIÓN
 *
 * Dos objetivos:
 *  1. Control de cobro: marcar tiquetes (uno o un grupo) como facturado/pagado,
 *     agruparlos con un nº de factura e ir viendo qué queda por cobrar.
 *  2. Reporte entregable al cliente: horas del periodo con el detalle de los
 *     tiquetes realizados, listo para imprimir (PDF) o exportar a CSV.
 *
 * ALCANCE (deliberado): estas rutas NO filtran por el alcance de usuarios del
 * solicitante, a diferencia de /api/reports. Quien tiene `billing:read` está
 * gestionando dinero, y una factura al cliente a la que le faltaran las horas de
 * otro equipo estaría mal por defecto: un error caro y además invisible. El
 * acceso queda protegido por el permiso explícito (MANAGER y ADMIN), y se puede
 * acotar a una persona con `userId`.
 */
/**
 * Tope de tiquetes por marcado masivo. Existe para que un filtro demasiado
 * amplio (todos los proyectos, todo el historial) no dispare una operacion
 * enorme por accidente: mejor un error que diga como acotarlo que un minuto de
 * espera sin saber que esta pasando.
 */
const MAX_MASS_MARK = 1000;

export default async function billingRoutes(app: FastifyInstance): Promise<void> {
  const timezoneOf = async (userId: string): Promise<string> => {
    const user = await prisma.user.findUnique({ where: { id: userId }, select: { timezone: true } });
    return user?.timezone ?? 'UTC';
  };

  // `all` = todo el historial (sin fechas). Solo tiene sentido en el control de
  // cobro; el reporte del cliente siempre se emite sobre un periodo concreto.
  const PRESETS = ['today', 'yesterday', 'last7', 'last30', 'thisMonth', 'lastMonth', 'custom', 'all'] as const;

  const filterSchema = z.object({
    preset: z.enum(PRESETS).optional(),
    from: z.string().optional(),
    to: z.string().optional(),
    clientId: z.string().optional(),
    /** Un proyecto (compatibilidad) o varios: `projectIds=a,b,c`. */
    projectId: z.string().optional(),
    projectIds: z.string().optional(),
    userId: z.string().optional(),
    billingStatus: z.enum(['ALL', 'PENDING', 'BILLED', 'PAID']).optional(),
    invoiceRef: z.string().max(60).optional(),
    search: z.string().max(120).optional(),
    take: z.coerce.number().int().min(1).max(1000).optional(),
    skip: z.coerce.number().int().min(0).optional(),
  });

  type Filters = z.infer<typeof filterSchema>;

  const parseDate = (value?: string): Date | undefined => {
    if (!value) return undefined;
    const date = new Date(value);
    return Number.isNaN(date.getTime()) ? undefined : date;
  };

  /** Periodo pedido. `from`/`to` quedan sin definir cuando se pide todo. */
  function resolveWindow(f: Filters, tz: string): { from?: Date; to?: Date; label: string } {
    if (f.preset === 'all') return { label: 'Todo el historial' };
    if (f.preset === 'custom' && f.from && f.to) {
      return { from: parseDate(f.from), to: parseDate(f.to), label: 'Personalizado' };
    }
    // Sin preset se asume "todo": es lo que evita perder tiquetes sin cobrar de
    // meses anteriores al abrir la pantalla de facturación.
    if (!f.preset) return { label: 'Todo el historial' };
    const range = resolveRange(f.preset, tz);
    return { from: range.from, to: range.to, label: range.label };
  }

  /** Periodo obligatorio y acotado, para documentos que se entregan a un tercero. */
  function resolveStatementWindow(f: Filters, tz: string): { from: Date; to: Date; label: string } {
    if (f.preset === 'custom' && f.from && f.to) {
      const from = parseDate(f.from);
      const to = parseDate(f.to);
      if (from && to) return { from, to, label: 'Personalizado' };
    }
    const preset = !f.preset || f.preset === 'all' ? 'thisMonth' : f.preset;
    const range = resolveRange(preset, tz);
    return { from: range.from, to: range.to, label: range.label };
  }

  /** Filtro opcional por persona (sobre el responsable del tiquete). */
  const assigneeFilter = (f: Filters): string[] | undefined => (f.userId ? [f.userId] : undefined);

  /**
   * Proyectos del filtro. Acepta `projectId` (uno) y `projectIds` (varios,
   * separados por coma) porque el panel permite marcar un GRUPO de proyectos de
   * una vez, y la API mantiene el parametro antiguo para los enlaces guardados.
   */
  const projectFilter = (f: Filters): string[] | undefined => {
    const lista = [
      ...(f.projectIds ? f.projectIds.split(',') : []),
      ...(f.projectId ? [f.projectId] : []),
    ]
      .map((id) => id.trim())
      .filter(Boolean);
    return lista.length ? [...new Set(lista)] : undefined;
  };

  // -------------------------------------------------------------------------
  // GET /api/billing/overview — cola de trabajo de cobro
  // -------------------------------------------------------------------------
  app.get('/overview', { preHandler: [requirePermission(PERMISSIONS.BILLING_READ)] }, async (request, reply) => {
    const auth = request.auth!;
    const q = filterSchema.safeParse(request.query);
    if (!q.success) return reply.code(400).send({ error: q.error.issues[0]?.message ?? 'Filtros invalidos' });
    const f = q.data;

    const tz = await timezoneOf(auth.userId);
    const window = resolveWindow(f, tz);

    const overview = await billingOverview({
      from: window.from,
      to: window.to,
      userIds: assigneeFilter(f),
      clientId: f.clientId,
      projectIds: projectFilter(f),
      billingStatus: f.billingStatus && f.billingStatus !== 'ALL' ? f.billingStatus : undefined,
      invoiceRef: f.invoiceRef,
      search: f.search,
      take: f.take ?? 300,
      skip: f.skip ?? 0,
      scope: 'all',
    });

    return reply.send({
      ...overview,
      range: { from: window.from?.toISOString() ?? '', to: window.to?.toISOString() ?? '', label: window.label },
      // `billing:read` sin `billing:write` = solo consulta (el panel esconde los botones).
      canWrite: hasPermission(auth, PERMISSIONS.BILLING_WRITE),
    });
  });

  // -------------------------------------------------------------------------
  // POST /api/billing/mark — facturar / cobrar / devolver a pendiente
  //
  // Acepta un grupo de tiquetes (`taskIds`) o todos los de una factura
  // (`invoiceRef`), que es la forma natural de "marcar un grupo de tareas".
  // -------------------------------------------------------------------------
  app.post('/mark', { preHandler: [requirePermission(PERMISSIONS.BILLING_WRITE)] }, async (request, reply) => {
    const parsed = z
      .object({
        taskIds: z.array(z.string()).max(1000).optional(),
        invoiceRef: z.string().min(1).max(60).optional(),
        /**
         * Marcar TODOS los tiquetes de uno o varios proyectos. El grupo se
         * resuelve en el servidor (no con lo que el panel tenga en pantalla), asi
         * que un proyecto con mas tiquetes de los que caben en la lista se marca
         * entero y no a medias.
         */
        projectIds: z.array(z.string()).min(1).max(50).optional(),
        status: z.enum(['PENDING', 'BILLED', 'PAID']),
        /** Nº de factura a asignar al grupo (lo que agrupa varias tareas). */
        invoiceRefNew: z.string().max(60).nullable().optional(),
        billedAt: z.string().nullable().optional(),
        paidAt: z.string().nullable().optional(),
        /** Importe POR TIQUETE; si se omite se calcula horas x tarifa. */
        amount: z.number().nonnegative().nullable().optional(),
      })
      .refine((d) => (d.taskIds?.length ?? 0) > 0 || Boolean(d.invoiceRef) || (d.projectIds?.length ?? 0) > 0, {
        message: 'Indica al menos un tiquete (taskIds), un nº de factura (invoiceRef) o uno o varios proyectos (projectIds)',
      })
      .safeParse(request.body ?? {});
    if (!parsed.success) return reply.code(400).send({ error: parsed.error.issues[0]?.message ?? 'Datos invalidos' });
    const d = parsed.data;

    const isoDate = (value: string | null | undefined, campo: string): Date | null | undefined => {
      if (value === undefined) return undefined;
      if (value === null || value === '') return null;
      const date = new Date(value);
      if (Number.isNaN(date.getTime())) throw new Error(`Fecha de ${campo} inválida`);
      return date;
    };

    let billedAt: Date | null | undefined;
    let paidAt: Date | null | undefined;
    try {
      billedAt = isoDate(d.billedAt, 'facturación');
      paidAt = isoDate(d.paidAt, 'pago');
    } catch (err) {
      return reply.code(400).send({ error: (err as Error).message });
    }

    // Los tiquetes se resuelven antes de tocar nada: un id inventado no debe
    // reportarse como "actualizado".
    let ids: string[];
    if (d.projectIds?.length) {
      // Al marcar por proyecto solo se tocan los tiquetes que van por el camino
      // natural del proceso: facturar mira los PENDIENTES, cobrar los FACTURADOS
      // y "volver a pendiente" los que tienen cobro. Sin este filtro, un marcado
      // masivo desharia pagos ya registrados o volveria a emitir facturas.
      const NATURAL: Record<string, string[]> = {
        BILLED: ['PENDING'],
        PAID: ['BILLED'],
        PENDING: ['BILLED', 'PAID'],
      };
      const encontrados = await prisma.task.findMany({
        where: { projectId: { in: d.projectIds }, billingStatus: { in: NATURAL[d.status] ?? ['PENDING'] } },
        select: { id: true },
      });
      ids = encontrados.map((t) => t.id);
      if (ids.length > MAX_MASS_MARK) {
        return reply.code(400).send({
          error: `El grupo tiene ${ids.length} tiquetes (máximo ${MAX_MASS_MARK} por operación). Acota por cliente o por periodo.`,
          code: 'TOO_MANY_TASKS',
        });
      }
    } else if (d.invoiceRef) {
      ids = (await prisma.task.findMany({ where: { invoiceRef: d.invoiceRef }, select: { id: true } })).map((t) => t.id);
    } else {
      ids = [...new Set(d.taskIds ?? [])];
    }
    if (!ids.length) return reply.code(404).send({ error: 'No hay tiquetes que marcar', code: 'NO_TASKS' });

    const existentes = await prisma.task.count({ where: { id: { in: ids } } });
    if (existentes !== ids.length) {
      return reply.code(400).send({ error: 'Alguno de los tiquetes indicados no existe', code: 'TASK_NOT_FOUND' });
    }

    const result = await markTasksBilling({
      taskIds: ids,
      status: d.status,
      invoiceRefNew: d.invoiceRefNew === undefined ? undefined : d.invoiceRefNew?.trim() || null,
      billedAt: billedAt ?? undefined,
      paidAt: paidAt ?? undefined,
      amount: d.amount,
    });

    await audit(request, {
      action: `billing.mark_${d.status.toLowerCase()}`,
      entity: 'task',
      entityId: result.taskIds.length === 1 ? result.taskIds[0] : undefined,
      metadata: {
        tiquetes: result.taskIds.length,
        factura: d.invoiceRefNew ?? d.invoiceRef ?? null,
        importePorTiquete: d.amount ?? null,
        seleccion: d.projectIds?.length
          ? `proyectos:${d.projectIds.join(',')}`
          : d.invoiceRef
            ? `factura:${d.invoiceRef}`
            : 'tiquetes',
      },
    });

    return reply.send({
      ok: true,
      updated: result.updated,
      status: result.status,
      invoiceRef: result.invoiceRef,
      currency: billingCurrency(),
      taskIds: result.taskIds,
    });
  });

  // -------------------------------------------------------------------------
  // GET /api/billing/statement — reporte de horas y tiquetes para el cliente
  // -------------------------------------------------------------------------
  app.get('/statement', { preHandler: [requirePermission(PERMISSIONS.BILLING_READ)] }, async (request, reply) => {
    const auth = request.auth!;
    const q = filterSchema
      .extend({
        clientId: z.string().min(1, 'Elige un cliente'),
        includeBilled: z.enum(['true', 'false']).optional(),
        withEntries: z.enum(['true', 'false']).optional(),
      })
      .safeParse(request.query);
    if (!q.success) return reply.code(400).send({ error: q.error.issues[0]?.message ?? 'Filtros invalidos' });
    const f = q.data;

    const tz = await timezoneOf(auth.userId);
    const window = resolveStatementWindow(f, tz);

    try {
      const statement = await buildClientStatement({
        clientId: f.clientId,
        from: window.from,
        to: window.to,
        label: window.label,
        userIds: assigneeFilter(f),
        projectIds: projectFilter(f),
        billingStatus: f.billingStatus ?? 'ALL',
        includeBilled: f.includeBilled !== 'false',
        withEntries: f.withEntries === 'true',
        scope: 'all',
      });
      return reply.send({ ...statement, canWrite: hasPermission(auth, PERMISSIONS.BILLING_WRITE) });
    } catch (err) {
      const status = (err as { statusCode?: number }).statusCode ?? 500;
      return reply.code(status).send({ error: (err as Error).message });
    }
  });

  // -------------------------------------------------------------------------
  // GET /api/billing/statement.csv — el mismo reporte, para Excel
  // -------------------------------------------------------------------------
  app.get('/statement.csv', { preHandler: [requirePermission(PERMISSIONS.BILLING_READ)] }, async (request, reply) => {
    const auth = request.auth!;
    const q = filterSchema
      .extend({ clientId: z.string().min(1, 'Elige un cliente'), includeBilled: z.enum(['true', 'false']).optional() })
      .safeParse(request.query);
    if (!q.success) return reply.code(400).send({ error: q.error.issues[0]?.message ?? 'Filtros invalidos' });
    const f = q.data;

    const tz = await timezoneOf(auth.userId);
    const window = resolveStatementWindow(f, tz);

    try {
      const statement = await buildClientStatement({
        clientId: f.clientId,
        from: window.from,
        to: window.to,
        label: window.label,
        userIds: assigneeFilter(f),
        projectIds: projectFilter(f),
        billingStatus: f.billingStatus ?? 'ALL',
        includeBilled: f.includeBilled !== 'false',
        scope: 'all',
      });
      const csv = statementToCsv(statement, tz);
      const nombre = statement.client.name.replace(/[^\w-]+/g, '_').slice(0, 40);
      reply
        .header('Content-Type', 'text/csv; charset=utf-8')
        .header(
          'Content-Disposition',
          `attachment; filename="horas_${nombre}_${new Date().toISOString().slice(0, 10)}.csv"`,
        );
      return reply.send(`\uFEFF${csv}`); // BOM para Excel
    } catch (err) {
      const status = (err as { statusCode?: number }).statusCode ?? 500;
      return reply.code(status).send({ error: (err as Error).message });
    }
  });
}
