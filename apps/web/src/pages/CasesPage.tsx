import { useEffect, useMemo, useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  Button, Card, Col, DatePicker, Drawer, Empty, Form, Input, Popconfirm, Row, Select,
  Space, Statistic, Table, Tag, Tooltip, message,
} from 'antd';
import { DeleteOutlined, FlagOutlined, PlusOutlined, ReloadOutlined } from '@ant-design/icons';
import { api, errorMessage } from '../lib/api';
import { useAuth } from '../lib/auth';
import { SeverityTag, SlaCell, StatusBadge, TlpTag, date, fromNow, slaRank } from '../lib/format';

const SEVERITY_OPTIONS = [
  { value: 1, label: 'LOW' }, { value: 2, label: 'MEDIUM' }, { value: 3, label: 'HIGH' }, { value: 4, label: 'CRITICAL' },
];
const TLP_OPTIONS = [
  { value: 0, label: 'WHITE' }, { value: 1, label: 'GREEN' }, { value: 2, label: 'AMBER' }, { value: 3, label: 'RED' },
];

export default function CasesPage() {
  const navigate = useNavigate();
  const [params, setParams] = useSearchParams();
  const qc = useQueryClient();
  const { can } = useAuth();
  const [selected, setSelected] = useState<string[]>([]);
  const [createOpen, setCreateOpen] = useState(params.get('create') === '1');
  const [filters, setFilters] = useState<any>({ page: 0, pageSize: 30, sort: '-createdAt' });
  const [form] = Form.useForm();

  useEffect(() => {
    if (params.get('create') === '1') setCreateOpen(true);
  }, [params]);

  const casesQuery = useQuery({
    queryKey: ['cases', filters],
    queryFn: async () => (await api.get('/cases', { params: filters })).data,
  });
  const statsQuery = useQuery({ queryKey: ['stats'], queryFn: async () => (await api.get('/stats')).data });
  const templatesQuery = useQuery({ queryKey: ['templates'], queryFn: async () => (await api.get('/templates')).data });

  const createMutation = useMutation({
    mutationFn: async (values: any) => (await api.post('/cases', values)).data,
    onSuccess: (created) => {
      message.success(`Caso #${created.number} creado`);
      setCreateOpen(false);
      form.resetFields();
      setParams({});
      qc.invalidateQueries({ queryKey: ['cases'] });
      qc.invalidateQueries({ queryKey: ['stats'] });
      navigate(`/cases/${created.id}`);
    },
    onError: (e) => message.error(errorMessage(e)),
  });

  const bulkMutation = useMutation({
    mutationFn: async ({ ids, data }: any) => (await api.patch('/cases/_bulk', { ids, data })).data,
    onSuccess: () => {
      message.success('Casos actualizados');
      setSelected([]);
      qc.invalidateQueries({ queryKey: ['cases'] });
    },
    onError: (e) => message.error(errorMessage(e)),
  });

  const deleteMutation = useMutation({
    // force: borra el caso (sin force la API solo lo cierra, como TheHive 4).
    mutationFn: async (id: string) => (await api.delete(`/cases/${id}`, { params: { force: true } })).data,
    onSuccess: () => {
      message.success('Caso eliminado');
      qc.invalidateQueries({ queryKey: ['cases'] });
      qc.invalidateQueries({ queryKey: ['stats'] });
    },
    onError: (e) => message.error(errorMessage(e)),
  });

  const columns = useMemo(() => [
    {
      title: 'Estado', dataIndex: ['status', 'value'], width: 130,
      render: (_: any, row: any) => <StatusBadge value={row.status?.value || row.stage} stage={row.stage} colour={row.status?.colour} />,
    },
    {
      title: 'Severidad', dataIndex: 'severity', width: 110,
      render: (value: number) => <SeverityTag value={value} />,
    },
    {
      title: 'SLA', width: 230, sorter: (a: any, b: any) => slaRank(a.sla) - slaRank(b.sla),
      render: (_: any, row: any) => <SlaCell sla={row.sla} />,
    },
    {
      title: '# / Título', dataIndex: 'title',
      render: (_: any, row: any) => (
        <div>
          <a onClick={() => navigate(`/cases/${row.id}`)} style={{ fontWeight: 700 }}>
            #{row.number} · {row.title}
          </a>
          <div style={{ marginTop: 4 }}>
            {(row.tags || []).map((t: string) => <Tag key={t} color="cyan" style={{ marginBottom: 2 }}>{t}</Tag>)}
          </div>
        </div>
      ),
    },
    {
      title: 'Detalles', width: 230,
      render: (_: any, row: any) => (
        <Space size={12} wrap>
          <span><b>{row._count?.tasks ?? 0}</b> tareas</span>
          <span><b>{row._count?.observables ?? 0}</b> obs.</span>
          <span><b>{row._count?.procedures ?? 0}</b> TTP</span>
          <span><b>{row._count?.alerts ?? 0}</b> alertas</span>
        </Space>
      ),
    },
    {
      title: 'Cesionario', dataIndex: ['assignee', 'name'], width: 150,
      render: (value: string) => value || <span style={{ color: '#aaa' }}>Ninguno</span>,
    },
    {
      title: 'Fechas', width: 180,
      render: (_: any, row: any) => (
        <div style={{ fontSize: 12, color: '#64647c' }}>
          <div>C. {date(row.createdAt)}</div>
          <div>U. {fromNow(row.updatedAt)}</div>
        </div>
      ),
    },
    {
      title: '', width: 90, align: 'right' as const,
      render: (_: any, row: any) => (
        <Space>
          <Tooltip title={row.flag ? 'Quitar flag' : 'Flag'}><Button size="small" type={row.flag ? 'primary' : 'text'} icon={<FlagOutlined />} onClick={() => bulkMutation.mutate({ ids: [row.id], data: { flag: !row.flag } })} /></Tooltip>
          {can('manageCase/delete') && (
            <Popconfirm title="¿Eliminar caso?" onConfirm={() => deleteMutation.mutate(row.id)}>
              <Button size="small" danger type="text" icon={<DeleteOutlined />} />
            </Popconfirm>
          )}
        </Space>
      ),
    },
  ], [navigate, can, bulkMutation, deleteMutation]);

  const stats = statsQuery.data?.cases;
  const openCases = (stats?.byStage?.InProgress || 0) + (stats?.byStage?.New || 0);

  return (
    <div>
      <div className="page-header">
        <div>
          <h1 className="page-title">Casos</h1>
          <span style={{ color: '#8c8c9a' }}>{casesQuery.data?.total ?? 0} casos en la organización</span>
        </div>
        <Space wrap>
          {can('manageCase/create') && (
            <Button type="primary" icon={<PlusOutlined />} onClick={() => setCreateOpen(true)}>Crear caso</Button>
          )}
          <Button icon={<ReloadOutlined />} onClick={() => casesQuery.refetch()}>Actualizar</Button>
        </Space>
      </div>

      <Row gutter={12} style={{ marginBottom: 12 }}>
        <Col xs={12} md={6}><Card size="small"><Statistic title="Casos abiertos" value={openCases} /></Card></Col>
        <Col xs={12} md={6}><Card size="small"><Statistic title="Total" value={stats?.total ?? 0} /></Card></Col>
        <Col xs={12} md={6}><Card size="small"><Statistic title="Alta severidad" value={(stats?.bySeverity?.['3'] || 0) + (stats?.bySeverity?.['4'] || 0)} /></Card></Col>
        <Col xs={12} md={6}><Card size="small"><Statistic title="Tags" value={stats?.topTags?.length ?? 0} /></Card></Col>
      </Row>

      <Card size="small" style={{ marginBottom: 12 }}>
        <Space wrap>
          <Select
            allowClear placeholder="Estado" style={{ width: 160 }}
            options={[{ value: 'New', label: 'New' }, { value: 'InProgress', label: 'In progress' }, { value: 'Closed', label: 'Closed' }]}
            onChange={(value) => setFilters((f: any) => ({ ...f, stage: value, page: 0 }))}
          />
          <Select
            allowClear placeholder="Severidad" style={{ width: 150 }}
            options={SEVERITY_OPTIONS}
            onChange={(value) => setFilters((f: any) => ({ ...f, severity: value, page: 0 }))}
          />
          <Select
            allowClear placeholder="Orden" style={{ width: 190 }}
            options={[
              { value: '-createdAt', label: 'Más nuevos' }, { value: 'createdAt', label: 'Más antiguos' },
              { value: '-severity', label: 'Mayor severidad' }, { value: 'severity', label: 'Menor severidad' },
            ]}
            onChange={(value) => setFilters((f: any) => ({ ...f, sort: value, page: 0 }))}
          />
          <Input.Search
            placeholder="Buscar título, descripción o número" allowClear style={{ width: 320 }}
            onSearch={(value) => setFilters((f: any) => ({ ...f, search: value || undefined, page: 0 }))}
          />
          {selected.length > 0 && (
            <>
              <Tag color="cyan">{selected.length} seleccionados</Tag>
              <Button icon={<FlagOutlined />} onClick={() => bulkMutation.mutate({ ids: selected, data: { flag: true } })}>Flag</Button>
              <Button onClick={() => { setSelected([]); }}>Limpiar</Button>
            </>
          )}
        </Space>
      </Card>

      <Card size="small" styles={{ body: { padding: 0 } }}>
        <Table
          rowKey="id"
          loading={casesQuery.isLoading}
          dataSource={casesQuery.data?.items || []}
          columns={columns as any}
          rowSelection={{ selectedRowKeys: selected, onChange: (keys) => setSelected(keys as string[]) }}
          pagination={{
            current: (filters.page || 0) + 1,
            pageSize: filters.pageSize,
            total: casesQuery.data?.total || 0,
            showSizeChanger: true,
            pageSizeOptions: [10, 30, 100],
            onChange: (page, pageSize) => setFilters((f: any) => ({ ...f, page: page - 1, pageSize })),
          }}
          locale={{ emptyText: <Empty description="No se encontraron casos" /> }}
        />
      </Card>

      <Drawer
        title="Crear un caso"
        width={720}
        open={createOpen}
        onClose={() => { setCreateOpen(false); setParams({}); }}
        destroyOnClose
        extra={<Button type="primary" loading={createMutation.isPending} onClick={() => form.submit()}>Crear caso</Button>}
      >
        <Form
          form={form}
          layout="vertical"
          initialValues={{ severity: 2, tlp: 2, pap: 2, status: 'New' }}
          onFinish={(values) => {
            const payload = {
              ...values,
              startDate: values.startDate ? values.startDate.toISOString() : undefined,
            };
            createMutation.mutate(payload);
          }}
        >
          <Form.Item name="title" label="Título" rules={[{ required: true, message: 'El título es obligatorio' }]}>
            <Input placeholder="Resumen breve del incidente" />
          </Form.Item>
          <Form.Item name="description" label="Descripción" rules={[{ required: true, message: 'La descripción es obligatoria' }]}>
            <Input.TextArea rows={6} placeholder="Markdown permitido: contexto, hallazgos, próximos pasos" />
          </Form.Item>
          <Row gutter={12}>
            <Col span={8}><Form.Item name="severity" label="Severidad"><Select options={SEVERITY_OPTIONS} /></Form.Item></Col>
            <Col span={8}><Form.Item name="tlp" label="TLP"><Select options={TLP_OPTIONS} /></Form.Item></Col>
            <Col span={8}><Form.Item name="pap" label="PAP"><Select options={TLP_OPTIONS} /></Form.Item></Col>
          </Row>
          <Row gutter={12}>
            <Col span={12}><Form.Item name="status" label="Estado"><Select options={[{ value: 'New', label: 'New' }, { value: 'InProgress', label: 'In progress' }]} /></Form.Item></Col>
            <Col span={12}><Form.Item name="startDate" label="Fecha de inicio"><DatePicker showTime style={{ width: '100%' }} /></Form.Item></Col>
          </Row>
          <Form.Item name="tags" label="Tags"><Select mode="tags" placeholder="phishing, email, finance" /></Form.Item>
          <Form.Item name="caseTemplate" label="Plantilla">
            <Select allowClear placeholder="Aplicar plantilla (opcional)" options={(templatesQuery.data || []).map((t: any) => ({ value: t.name, label: t.displayName || t.name }))} />
          </Form.Item>
          <Form.Item name="assignee" label="Cesionario">
            <Input placeholder="login@myhive.local (opcional, por defecto tú)" />
          </Form.Item>
        </Form>
      </Drawer>
    </div>
  );
}
