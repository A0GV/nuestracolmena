import { useMemo } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { Card, Empty, Input, Space, Table, Tag, Tabs, Typography } from 'antd';
import { api } from '../lib/api';
import { SeverityTag, StatusBadge, date } from '../lib/format';

export default function SearchPage() {
  const [params, setParams] = useSearchParams();
  const q = params.get('q') || '';
  const navigate = useNavigate();

  const cases = useQuery({ queryKey: ['search', 'cases', q], queryFn: async () => (await api.get('/cases', { params: { search: q, pageSize: 50 } })).data, enabled: !!q });
  const alerts = useQuery({ queryKey: ['search', 'alerts', q], queryFn: async () => (await api.get('/alerts', { params: { search: q, pageSize: 50 } })).data, enabled: !!q });
  const observables = useQuery({ queryKey: ['search', 'observables', q], queryFn: async () => (await api.get('/observables', { params: { search: q, pageSize: 50 } })).data, enabled: !!q });
  const tasks = useQuery({ queryKey: ['search', 'tasks', q], queryFn: async () => (await api.get('/tasks', { params: { search: q, pageSize: 50 } })).data, enabled: !!q });

  const total = (cases.data?.total || 0) + (alerts.data?.total || 0) + (observables.data?.total || 0) + (tasks.data?.total || 0);

  const tabs = useMemo(() => [
    {
      key: 'cases', label: `Casos (${cases.data?.total || 0})`,
      children: (
        <Table rowKey="id" size="small" dataSource={cases.data?.items || []} pagination={false}
          columns={[
            { title: 'Estado', render: (_: any, r: any) => <StatusBadge value={r.status?.value || r.stage} stage={r.stage} colour={r.status?.colour} />, width: 130 },
            { title: 'Severidad', dataIndex: 'severity', width: 100, render: (v: number) => <SeverityTag value={v} /> },
            { title: 'Caso', render: (_: any, r: any) => <a onClick={() => navigate(`/cases/${r.id}`)}>#{r.number} · {r.title}</a> },
            { title: 'Fecha', dataIndex: 'createdAt', width: 160, render: (v: string) => date(v) },
          ]} />
      ),
    },
    {
      key: 'alerts', label: `Alertas (${alerts.data?.total || 0})`,
      children: (
        <Table rowKey="id" size="small" dataSource={alerts.data?.items || []} pagination={false}
          columns={[
            { title: 'Severidad', dataIndex: 'severity', width: 100, render: (v: number) => <SeverityTag value={v} /> },
            { title: 'Alerta', render: (_: any, r: any) => <a onClick={() => navigate('/alerts')}>{r.title}</a> },
            { title: 'Fuente', dataIndex: 'source', width: 180 },
            { title: 'Fecha', dataIndex: 'date', width: 160, render: (v: string) => date(v) },
          ]} />
      ),
    },
    {
      key: 'observables', label: `Observables (${observables.data?.total || 0})`,
      children: (
        <Table rowKey="id" size="small" dataSource={observables.data?.items || []} pagination={false}
          columns={[
            { title: 'Tipo', dataIndex: 'dataType', width: 110, render: (v: string) => <Tag color="blue">{v}</Tag> },
            { title: 'Valor', dataIndex: 'data', render: (v: string) => <Typography.Text copyable>{v}</Typography.Text> },
            { title: 'Mensaje', dataIndex: 'message' },
            { title: 'Caso', render: (_: any, r: any) => r.caseId ? <a onClick={() => navigate(`/cases/${r.caseId}`)}>Ver caso</a> : '—', width: 110 },
          ]} />
      ),
    },
    {
      key: 'tasks', label: `Tareas (${tasks.data?.total || 0})`,
      children: (
        <Table rowKey="id" size="small" dataSource={tasks.data?.items || []} pagination={false}
          columns={[
            { title: 'Estado', dataIndex: 'status', width: 120, render: (v: string) => <StatusBadge value={v} /> },
            { title: 'Tarea', dataIndex: 'title' },
            { title: 'Caso', render: (_: any, r: any) => r.case ? <a onClick={() => navigate(`/cases/${r.case.id}`)}>#{r.case.number}</a> : '—', width: 100 },
            { title: 'Cesionario', dataIndex: ['assignee', 'name'], width: 150 },
          ]} />
      ),
    },
  ], [cases.data, alerts.data, observables.data, tasks.data]);

  return (
    <div>
      <div className="page-header">
        <div>
          <h1 className="page-title">Búsqueda</h1>
          <span style={{ color: '#8c8c9a' }}>{q ? `${total} resultados para “${q}”` : 'Busca casos, alertas, observables y tareas'}</span>
        </div>
      </div>
      <Card size="small" style={{ marginBottom: 12 }}>
        <Input.Search
          defaultValue={q}
          placeholder="Buscar en toda la organización"
          enterButton
          onSearch={(value) => setParams(value ? { q: value } : {})}
          style={{ maxWidth: 640 }}
        />
      </Card>
      {!q ? <Empty description="Introduce un término de búsqueda" /> : <Card size="small"><Tabs items={tabs} /></Card>}
    </div>
  );
}
