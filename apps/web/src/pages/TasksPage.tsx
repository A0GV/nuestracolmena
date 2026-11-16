import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Button, Card, Descriptions, Drawer, Input, List, Segmented, Select, Space, Spin, Table, message } from 'antd';
import { ReloadOutlined } from '@ant-design/icons';
import { api, errorMessage } from '../lib/api';
import { useAuth } from '../lib/auth';
import { Markdown, SlaCell, StatusBadge, date, slaRank } from '../lib/format';

export default function TasksPage() {
  const navigate = useNavigate();
  const qc = useQueryClient();
  const { can } = useAuth();
  const [scope, setScope] = useState('all');
  const [filters, setFilters] = useState<any>({ page: 0, pageSize: 30 });
  const [taskId, setTaskId] = useState<string | null>(null);

  const params = { ...filters, scope: scope === 'all' ? undefined : scope };
  const tasksQuery = useQuery({
    queryKey: ['tasks', params],
    queryFn: async () => (await api.get('/tasks', { params })).data,
  });

  const columns = [
    { title: 'Estado', dataIndex: 'status', width: 120, render: (v: string) => <StatusBadge value={v} stage={v === 'Completed' ? 'Closed' : 'InProgress'} /> },
    { title: 'SLA', width: 230, sorter: (a: any, b: any) => slaRank(a.sla) - slaRank(b.sla), render: (_: any, row: any) => <SlaCell sla={row.sla} /> },
    { title: 'Grupo', dataIndex: 'group', width: 150, render: (v: string) => v || '—' },
    {
      title: 'Tarea', dataIndex: 'title',
      render: (v: string, row: any) => (
        <div>
          <a onClick={() => setTaskId(row.id)} style={{ fontWeight: 600 }}>{v}</a>
          {row.case && <div style={{ fontSize: 12 }}><a onClick={() => navigate(`/cases/${row.case.id}`)} style={{ color: '#2f9e9f' }}>#{row.case.number} · {row.case.title}</a></div>}
        </div>
      ),
    },
    { title: 'Cesionario', dataIndex: ['assignee', 'name'], width: 150, render: (v: string) => v || '—' },
    { title: 'Due date', dataIndex: 'dueDate', width: 150, render: (v: string) => v ? date(v) : '—' },
    { title: 'Logs', width: 80, render: (_: any, row: any) => row._count?.logs ?? 0 },
  ];

  return (
    <div>
      <div className="page-header">
        <div>
          <h1 className="page-title">Tareas</h1>
          <span style={{ color: '#8c8c9a' }}>{tasksQuery.data?.total ?? 0} tareas</span>
        </div>
        <Button icon={<ReloadOutlined />} onClick={() => tasksQuery.refetch()}>Actualizar</Button>
      </div>
      <Card size="small" style={{ marginBottom: 12 }}>
        <Space wrap>
          <Segmented
            value={scope}
            onChange={(v) => { setScope(String(v)); setFilters((f: any) => ({ ...f, page: 0 })); }}
            options={[{ value: 'all', label: 'Todas' }, { value: 'mine', label: 'Mis tareas' }, { value: 'waiting', label: 'En espera' }]}
          />
          <Select allowClear placeholder="Estado" style={{ width: 150 }} options={['Waiting', 'InProgress', 'Completed', 'Cancel'].map((v) => ({ value: v, label: v }))}
            onChange={(v) => setFilters((f: any) => ({ ...f, status: v, page: 0 }))} />
          <Input.Search placeholder="Buscar tarea" allowClear style={{ width: 300 }} onSearch={(v) => setFilters((f: any) => ({ ...f, search: v || undefined, page: 0 }))} />
        </Space>
      </Card>
      <Card size="small" styles={{ body: { padding: 0 } }}>
        <Table
          rowKey="id" loading={tasksQuery.isLoading} dataSource={tasksQuery.data?.items || []} columns={columns as any}
          pagination={{ current: (filters.page || 0) + 1, pageSize: filters.pageSize, total: tasksQuery.data?.total || 0, onChange: (page, pageSize) => setFilters((f: any) => ({ ...f, page: page - 1, pageSize })) }}
        />
      </Card>
      <TaskDrawer id={taskId} onClose={() => setTaskId(null)} canManage={can('manageTask')} onChange={() => { qc.invalidateQueries({ queryKey: ['tasks'] }); }} />
    </div>
  );
}

function TaskDrawer({ id, onClose, canManage, onChange }: { id: string | null; onClose: () => void; canManage: boolean; onChange: () => void }) {
  const qc = useQueryClient();
  const [log, setLog] = useState('');
  const taskQuery = useQuery({ queryKey: ['task', id], queryFn: async () => (await api.get(`/tasks/${id}`)).data, enabled: !!id });
  const addLog = useMutation({
    mutationFn: async () => (await api.post(`/tasks/${id}/logs`, { message: log })).data,
    onSuccess: () => { setLog(''); qc.invalidateQueries({ queryKey: ['task', id] }); onChange(); message.success('Log añadido'); },
    onError: (e) => message.error(errorMessage(e)),
  });
  const patch = useMutation({
    mutationFn: async (data: any) => (await api.patch(`/tasks/${id}`, data)).data,
    onSuccess: () => { qc.invalidateQueries({ queryKey: ['task', id] }); onChange(); },
    onError: (e) => message.error(errorMessage(e)),
  });
  const t = taskQuery.data;
  return (
    <Drawer title={t?.title || 'Tarea'} open={!!id} onClose={onClose} width={620} destroyOnClose>
      {taskQuery.isLoading ? <Spin /> : t && (
        <div>
          <Descriptions column={2} size="small" bordered style={{ marginBottom: 16 }}>
            <Descriptions.Item label="Estado"><StatusBadge value={t.status} /></Descriptions.Item>
            <Descriptions.Item label="Grupo">{t.group || '—'}</Descriptions.Item>
            <Descriptions.Item label="Cesionario">{t.assignee?.name || '—'}</Descriptions.Item>
            <Descriptions.Item label="Due date">{t.dueDate ? date(t.dueDate) : '—'}</Descriptions.Item>
          </Descriptions>
          <Markdown>{t.description}</Markdown>
          {canManage && (
            <Space style={{ margin: '12px 0' }}>
              {t.status === 'Waiting' && <Button onClick={() => patch.mutate({ status: 'InProgress', startDate: new Date().toISOString() })}>Iniciar</Button>}
              {t.status !== 'Completed' && <Button type="primary" onClick={() => patch.mutate({ status: 'Completed', endDate: new Date().toISOString() })}>Completar</Button>}
              {t.status === 'Completed' && <Button onClick={() => patch.mutate({ status: 'InProgress', endDate: null })}>Reabrir</Button>}
            </Space>
          )}
          <List
            header={<b>Logs</b>}
            dataSource={t.logs || []}
            locale={{ emptyText: 'Sin logs' }}
            renderItem={(l: any) => (
              <List.Item style={{ display: 'block' }}>
                <div style={{ fontSize: 12, color: '#8c8c9a' }}><b>{l.createdBy?.name}</b> · {date(l.date)}</div>
                <Markdown>{l.message}</Markdown>
              </List.Item>
            )}
          />
          {canManage && (
            <div style={{ marginTop: 12 }}>
              <Input.TextArea rows={3} value={log} onChange={(e) => setLog(e.target.value)} placeholder="Añadir un log…" />
              <Button type="primary" style={{ marginTop: 8 }} disabled={!log.trim()} loading={addLog.isPending} onClick={() => addLog.mutate()}>Añadir log</Button>
            </div>
          )}
        </div>
      )}
    </Drawer>
  );
}
