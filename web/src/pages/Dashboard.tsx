import { useCallback, useEffect, useState } from 'react';
import {
  Area,
  AreaChart,
  Bar,
  BarChart,
  CartesianGrid,
  Cell,
  Legend,
  Pie,
  PieChart,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts';
import { api, downloadFile } from '../lib/api';
import { useAuth } from '../lib/auth';
import { CHART_COLORS, RANGE_OPTIONS, STATUS_LABEL, formatDateTime, formatHours, formatSeconds, relativeFrom } from '../lib/format';
import { Card, Empty, RangeSelect, Spinner, StatCard, useToast } from '../components/ui';

/**
 * Dashboard: metricas del periodo, graficos por cliente/proyecto/usuario/tipo,
 * actividad en curso y horas por dia.
 */
export default function DashboardPage() {
  const { can, user } = useAuth();
  const { push } = useToast();
  const [preset, setPreset] = useState('last7');
  const [scope, setScope] = useState<'me' | 'team' | 'all'>('all');
  const [data, setData] = useState<any | null>(null);
  const [loading, setLoading] = useState(true);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const res = await api.get<any>('/reports/dashboard', { preset, scope });
      setData(res);
    } catch (err) {
      push((err as Error).message, 'error');
    } finally {
      setLoading(false);
    }
  }, [preset, scope, push]);

  useEffect(() => {
    void load();
    const interval = setInterval(() => void load(), 60_000); // refresco automatico
    return () => clearInterval(interval);
  }, [load]);

  if (loading && !data) return <Spinner label="Calculando métricas…" />;
  if (!data) return <Empty>Sin datos disponibles.</Empty>;

  const { totals, byClient, byProject, byUser, byTaskType, daily, active, counters } = data;

  return (
    <div className="stack">
      <div className="row-between">
        <div>
          <h1>Dashboard</h1>
          <p className="page-sub">
            {scope === 'me' ? 'Tus horas' : scope === 'team' ? 'Horas de tu equipo' : 'Horas de toda la organización'} ·
            actualizado {new Date().toLocaleTimeString('es-CO', { hour: '2-digit', minute: '2-digit' })}
          </p>
        </div>
        <div className="btn-row">
          {can('reports:team') || can('reports:all') ? (
            <select className="select" style={{ width: 'auto' }} value={scope} onChange={(e) => setScope(e.target.value as any)}>
              <option value="me">Solo yo</option>
              <option value="team">Mi equipo</option>
              {can('reports:all') ? <option value="all">Todos</option> : null}
            </select>
          ) : null}
          <RangeSelect value={preset} onChange={setPreset} options={RANGE_OPTIONS} />
          <button className="btn btn-sm" onClick={() => void downloadFile('/reports/export.csv', `tiempos_${preset}.csv`, { preset, scope })}>
            ⬇ CSV
          </button>
        </div>
      </div>

      <div className="grid grid-4">
        <StatCard label="Horas totales" value={formatHours(totals.totalHours)} sub={`${totals.entries} registros`} icon="⏱" accent="#818cf8" />
        <StatCard label="Facturables" value={formatHours(totals.billableHours)} sub={`${totals.totalHours ? Math.round((totals.billableHours / totals.totalHours) * 100) : 0}% del total`} icon="💵" accent="#4ade80" />
        <StatCard label="Promedio por persona" value={formatHours(totals.avgHoursPerUser)} sub={`${totals.users} persona(s) activa(s)`} icon="📊" accent="#22d3ee" />
        <StatCard
          label="En curso ahora"
          value={totals.runningNow}
          sub={`${counters.users} usuarios · ${counters.projects} proyectos · ${counters.pendingTasks} pendientes`}
          icon="🟢"
          accent={totals.runningNow ? '#22c55e' : undefined}
        />
      </div>

      <Card title="Horas por día" hint="Barras: total · linea: facturable">
        {daily.length ? (
          <ResponsiveContainer width="100%" height={260}>
            <AreaChart data={daily} margin={{ top: 6, right: 8, left: -18, bottom: 0 }}>
              <defs>
                <linearGradient id="gradHours" x1="0" y1="0" x2="0" y2="1">
                  <stop offset="0%" stopColor="#6366f1" stopOpacity={0.55} />
                  <stop offset="100%" stopColor="#6366f1" stopOpacity={0.03} />
                </linearGradient>
                <linearGradient id="gradBillable" x1="0" y1="0" x2="0" y2="1">
                  <stop offset="0%" stopColor="#22c55e" stopOpacity={0.45} />
                  <stop offset="100%" stopColor="#22c55e" stopOpacity={0.03} />
                </linearGradient>
              </defs>
              <CartesianGrid strokeDasharray="3 3" stroke="#1f2c47" vertical={false} />
              <XAxis dataKey="date" stroke="#64748b" fontSize={11} tickFormatter={(v) => v.slice(5)} />
              <YAxis stroke="#64748b" fontSize={11} unit="h" />
              <Tooltip
                contentStyle={{ background: '#111a2e', border: '1px solid #1f2c47', borderRadius: 10, fontSize: 12 }}
                formatter={(value: any, name: any) => [`${value} h`, name === 'hours' ? 'Total' : 'Facturable']}
              />
              <Area type="monotone" dataKey="hours" stroke="#6366f1" strokeWidth={2} fill="url(#gradHours)" name="Total" />
              <Area type="monotone" dataKey="billableHours" stroke="#22c55e" strokeWidth={2} fill="url(#gradBillable)" name="Facturable" />
            </AreaChart>
          </ResponsiveContainer>
        ) : (
          <Empty>No hay registros en el periodo seleccionado.</Empty>
        )}
      </Card>

      <div className="grid grid-2">
        <Card title="Horas por cliente">
          {byClient.length ? (
            <ResponsiveContainer width="100%" height={250}>
              <PieChart>
                <Pie data={byClient} dataKey="hours" nameKey="label" innerRadius={52} outerRadius={86} paddingAngle={2}>
                  {byClient.map((_: any, i: number) => (
                    <Cell key={i} fill={CHART_COLORS[i % CHART_COLORS.length]} stroke="none" />
                  ))}
                </Pie>
                <Legend wrapperStyle={{ fontSize: 12 }} />
                <Tooltip
                  contentStyle={{ background: '#111a2e', border: '1px solid #1f2c47', borderRadius: 10, fontSize: 12 }}
                  formatter={(value: any) => [`${value} h`, 'Horas']}
                />
              </PieChart>
            </ResponsiveContainer>
          ) : (
            <Empty>Sin datos.</Empty>
          )}
        </Card>

        <Card title="Horas por tipo de tarea">
          {byTaskType.length ? (
            <ResponsiveContainer width="100%" height={250}>
              <BarChart data={byTaskType.slice(0, 8)} layout="vertical" margin={{ left: 8, right: 16 }}>
                <CartesianGrid strokeDasharray="3 3" stroke="#1f2c47" horizontal={false} />
                <XAxis type="number" stroke="#64748b" fontSize={11} unit="h" />
                <YAxis type="category" dataKey="label" stroke="#64748b" fontSize={11} width={96} />
                <Tooltip
                  contentStyle={{ background: '#111a2e', border: '1px solid #1f2c47', borderRadius: 10, fontSize: 12 }}
                  formatter={(value: any) => [`${value} h`, 'Horas']}
                />
                <Bar dataKey="hours" radius={[0, 6, 6, 0]}>
                  {byTaskType.slice(0, 8).map((_: any, i: number) => (
                    <Cell key={i} fill={CHART_COLORS[i % CHART_COLORS.length]} />
                  ))}
                </Bar>
              </BarChart>
            </ResponsiveContainer>
          ) : (
            <Empty>Sin datos.</Empty>
          )}
        </Card>
      </div>

      <div className="grid grid-2">
        <Card title="Top proyectos" hint="Ordenado por horas del periodo">
          {byProject.length ? (
            <div className="table-wrap">
              <table>
                <thead>
                  <tr>
                    <th>Proyecto</th>
                    <th className="right">Horas</th>
                    <th className="right">Facturable</th>
                    <th className="right">Registros</th>
                  </tr>
                </thead>
                <tbody>
                  {byProject.slice(0, 10).map((p: any) => (
                    <tr key={p.key}>
                      <td>{p.label}</td>
                      <td className="right mono">{formatHours(p.hours)}</td>
                      <td className="right mono muted">{formatHours(p.billableHours)}</td>
                      <td className="right muted">{p.entries}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ) : (
            <Empty>Sin datos.</Empty>
          )}
        </Card>

        <Card title="Horas por persona">
          {byUser.length ? (
            <div className="table-wrap">
              <table>
                <thead>
                  <tr>
                    <th>Usuario</th>
                    <th className="right">Horas</th>
                    <th className="right">Registros</th>
                  </tr>
                </thead>
                <tbody>
                  {byUser.slice(0, 10).map((u: any, i: number) => (
                    <tr key={u.key}>
                      <td className="row" style={{ gap: 8 }}>
                        <span className="pill-dot" style={{ background: CHART_COLORS[i % CHART_COLORS.length] }} />
                        {u.label}
                        {u.key === user?.id ? <span className="badge badge-info tiny">tú</span> : null}
                      </td>
                      <td className="right mono">{formatHours(u.hours)}</td>
                      <td className="right muted">{u.entries}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ) : (
            <Empty>Sin datos.</Empty>
          )}
        </Card>
      </div>

      <Card title="Ahora mismo" hint="Cronómetros abiertos (se actualiza cada minuto)">
        {active.length ? (
          <div className="stack-sm">
            {active.map((e: any) => (
              <div key={e.id} className="row-between" style={{ padding: '10px 12px', background: 'rgba(7,11,22,0.5)', borderRadius: 10, border: '1px solid var(--border-soft)' }}>
                <div className="stack-sm" style={{ gap: 2 }}>
                  <div className="row" style={{ gap: 8 }}>
                    <span className={`badge ${e.status === 'RUNNING' ? 'badge-success' : 'badge-warning'}`}>
                      <span className={`pill-dot ${e.status === 'RUNNING' ? 'pulse' : ''}`} />
                      {STATUS_LABEL[e.status]}
                    </span>
                    <strong>{e.title ?? 'Tarea'}</strong>
                  </div>
                  <span className="small muted">
                    {e.userName} · {e.projectName ?? 'sin proyecto'} {e.clientName ? `(${e.clientName})` : ''} · desde {formatDateTime(e.startedAt)} ({relativeFrom(e.startedAt)})
                  </span>
                </div>
                <span className="mono" style={{ fontSize: '1.1rem' }}>{formatSeconds(e.liveSeconds)}</span>
              </div>
            ))}
          </div>
        ) : (
          <Empty>Nadie tiene una tarea corriendo en este momento.</Empty>
        )}
      </Card>

      <p className="tiny muted-2">
        Consejo: los trabajadores no necesitan entrar aquí — pueden reportar su tiempo enviando notas de voz al bot de Telegram.
      </p>
    </div>
  );
}
