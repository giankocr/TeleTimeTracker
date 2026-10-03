import { useCallback, useEffect, useState } from 'react';
import { Bar, BarChart, CartesianGrid, Cell, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts';
import { api, downloadFile } from '../lib/api';
import { useAuth } from '../lib/auth';
import { CHART_COLORS, RANGE_OPTIONS, formatHours } from '../lib/format';
import { Card, Empty, RangeSelect, Spinner, StatCard, useToast } from '../components/ui';

/** Reportes de horas: equipo, clientes y proyectos + exportación. */
export default function ReportsPage() {
  const { can } = useAuth();
  const { push } = useToast();
  const [preset, setPreset] = useState('thisMonth');
  const [team, setTeam] = useState<any | null>(null);
  const [dashboard, setDashboard] = useState<any | null>(null);
  const [loading, setLoading] = useState(true);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const [dash, teamRes] = await Promise.all([
        api.get<any>('/reports/dashboard', { preset }),
        can('reports:team') ? api.get<any>('/reports/team', { preset }) : Promise.resolve(null),
      ]);
      setDashboard(dash);
      setTeam(teamRes);
    } catch (err) {
      push((err as Error).message, 'error');
    } finally {
      setLoading(false);
    }
  }, [preset, can, push]);

  useEffect(() => {
    void load();
  }, [load]);

  if (loading && !dashboard) return <Spinner label="Generando reporte…" />;

  const members = (team?.members ?? []).slice().sort((a: any, b: any) => b.hours - a.hours);
  const maxHours = members.length ? Math.max(...members.map((m: any) => m.hours)) : 0;

  return (
    <div className="stack">
      <div className="row-between">
        <div>
          <h1>Reportes</h1>
          <p className="page-sub">Horas por persona, cliente, proyecto y tipo de tarea.</p>
        </div>
        <div className="btn-row">
          <RangeSelect value={preset} onChange={setPreset} options={RANGE_OPTIONS} />
          <button className="btn btn-sm" onClick={() => void downloadFile('/reports/export.csv', `reporte_${preset}.csv`, { preset })}>
            ⬇ Exportar CSV
          </button>
        </div>
      </div>

      {dashboard ? (
        <div className="grid grid-4">
          <StatCard label="Horas del periodo" value={formatHours(dashboard.totals.totalHours)} icon="⏱" accent="#818cf8" />
          <StatCard label="Facturables" value={formatHours(dashboard.totals.billableHours)} icon="💵" accent="#4ade80" />
          <StatCard label="Registros" value={dashboard.totals.entries} icon="📌" accent="#22d3ee" />
          <StatCard label="Promedio/persona" value={formatHours(dashboard.totals.avgHoursPerUser)} icon="📊" />
        </div>
      ) : null}

      {members.length ? (
        <Card title="Ranking del equipo" hint={`${team?.range?.label ?? ''} · ${members.length} persona(s)`}>
          <div className="stack-sm">
            {members.map((m: any, i: number) => (
              <div key={m.id} className="row" style={{ gap: 12 }}>
                <span className="tiny muted-2" style={{ width: 22 }}>#{i + 1}</span>
                <span style={{ minWidth: 170 }}>
                  {m.fullName}
                  <span className="tiny muted-2"> · {m.role?.name ?? m.role?.key}</span>
                </span>
                <div style={{ flex: 1, height: 10, background: 'rgba(7,11,22,0.7)', borderRadius: 999, overflow: 'hidden' }}>
                  <div
                    style={{
                      width: `${maxHours ? (m.hours / maxHours) * 100 : 0}%`,
                      height: '100%',
                      background: CHART_COLORS[i % CHART_COLORS.length],
                    }}
                  />
                </div>
                <span className="mono nowrap">{formatHours(m.hours)}</span>
                <span className="tiny muted-2 nowrap">{m.entries} reg.</span>
              </div>
            ))}
          </div>
        </Card>
      ) : null}

      <div className="grid grid-2">
        <Card title="Horas por cliente">
          {dashboard?.byClient?.length ? (
            <ResponsiveContainer width="100%" height={260}>
              <BarChart data={dashboard.byClient} margin={{ left: -14, right: 8 }}>
                <CartesianGrid strokeDasharray="3 3" stroke="#1f2c47" vertical={false} />
                <XAxis dataKey="label" stroke="#64748b" fontSize={10} angle={-18} textAnchor="end" height={62} interval={0} />
                <YAxis stroke="#64748b" fontSize={11} unit="h" />
                <Tooltip contentStyle={{ background: '#111a2e', border: '1px solid #1f2c47', borderRadius: 10, fontSize: 12 }} formatter={(v: any) => [`${v} h`, 'Horas']} />
                <Bar dataKey="hours" radius={[6, 6, 0, 0]}>
                  {dashboard.byClient.map((_: any, i: number) => (
                    <Cell key={i} fill={CHART_COLORS[i % CHART_COLORS.length]} />
                  ))}
                </Bar>
              </BarChart>
            </ResponsiveContainer>
          ) : (
            <Empty>Sin datos.</Empty>
          )}
        </Card>

        <Card title="Horas por proyecto">
          {dashboard?.byProject?.length ? (
            <ResponsiveContainer width="100%" height={260}>
              <BarChart data={dashboard.byProject} margin={{ left: -14, right: 8 }}>
                <CartesianGrid strokeDasharray="3 3" stroke="#1f2c47" vertical={false} />
                <XAxis dataKey="label" stroke="#64748b" fontSize={10} angle={-18} textAnchor="end" height={62} interval={0} />
                <YAxis stroke="#64748b" fontSize={11} unit="h" />
                <Tooltip contentStyle={{ background: '#111a2e', border: '1px solid #1f2c47', borderRadius: 10, fontSize: 12 }} formatter={(v: any) => [`${v} h`, 'Horas']} />
                <Bar dataKey="hours" fill="#22d3ee" radius={[6, 6, 0, 0]} />
              </BarChart>
            </ResponsiveContainer>
          ) : (
            <Empty>Sin datos.</Empty>
          )}
        </Card>
      </div>

      <Card title="Detalle por cliente y tipo de tarea">
        <div className="grid grid-2">
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>Cliente</th>
                  <th className="right">Horas</th>
                  <th className="right">Registros</th>
                </tr>
              </thead>
              <tbody>
                {(dashboard?.byClient ?? []).map((c: any) => (
                  <tr key={c.key}>
                    <td>{c.label}</td>
                    <td className="right mono">{formatHours(c.hours)}</td>
                    <td className="right muted">{c.entries}</td>
                  </tr>
                ))}
                {!dashboard?.byClient?.length ? (
                  <tr>
                    <td colSpan={3}>
                      <Empty>Sin datos.</Empty>
                    </td>
                  </tr>
                ) : null}
              </tbody>
            </table>
          </div>
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>Tipo de tarea</th>
                  <th className="right">Horas</th>
                  <th className="right">Registros</th>
                </tr>
              </thead>
              <tbody>
                {(dashboard?.byTaskType ?? []).map((t: any) => (
                  <tr key={t.key}>
                    <td>{t.label}</td>
                    <td className="right mono">{formatHours(t.hours)}</td>
                    <td className="right muted">{t.entries}</td>
                  </tr>
                ))}
                {!dashboard?.byTaskType?.length ? (
                  <tr>
                    <td colSpan={3}>
                      <Empty>Sin datos.</Empty>
                    </td>
                  </tr>
                ) : null}
              </tbody>
            </table>
          </div>
        </div>
      </Card>
    </div>
  );
}
