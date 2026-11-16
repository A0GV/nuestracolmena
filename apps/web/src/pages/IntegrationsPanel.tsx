import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  Alert, Badge, Button, Card, Col, Form, Input, InputNumber, Modal, Popconfirm, Row, Select, Space, Switch, Table, Tag, Typography, message,
} from 'antd';
import { DeleteOutlined, EditOutlined, PlayCircleOutlined, PlusOutlined, ReloadOutlined } from '@ant-design/icons';
import { api, errorMessage } from '../lib/api';
import { useAuth } from '../lib/auth';
import { date } from '../lib/format';

export default function IntegrationsPanel() {
  const qc = useQueryClient();
  const { can } = useAuth();
  const canManage = can('manageConfig');
  const [editing, setEditing] = useState<any>(null);
  const [feederEditing, setFeederEditing] = useState<any>(null);
  const [form] = Form.useForm();
  const [feederForm] = Form.useForm();

  const status = useQuery({ queryKey: ['connectors-status'], queryFn: async () => (await api.get('/connectors/status')).data });
  const feeders = useQuery({ queryKey: ['misp-feeders'], queryFn: async () => (await api.get('/misp/feeders')).data });
  const mispServers = (status.data || []).filter((c: any) => c.type === 'misp');

  const refresh = () => {
    qc.invalidateQueries({ queryKey: ['connectors-status'] });
    qc.invalidateQueries({ queryKey: ['connectors'] });
    qc.invalidateQueries({ queryKey: ['misp-feeders'] });
  };

  const save = useMutation({
    mutationFn: async (values: any) =>
      editing?.id ? (await api.patch(`/connectors/${editing.id}`, values)).data : (await api.post('/connectors', values)).data,
    onSuccess: () => { message.success('Servidor guardado'); setEditing(null); refresh(); },
    onError: (e) => message.error(errorMessage(e)),
  });
  const remove = useMutation({
    mutationFn: async (id: string) => (await api.delete(`/connectors/${id}`)).data,
    onSuccess: () => { message.success('Servidor eliminado'); refresh(); },
    onError: (e) => message.error(errorMessage(e)),
  });
  const saveFeeder = useMutation({
    mutationFn: async (values: any) =>
      feederEditing?.id ? (await api.patch(`/misp/feeders/${feederEditing.id}`, values)).data : (await api.post('/misp/feeders', values)).data,
    onSuccess: () => { message.success('Feeder guardado'); setFeederEditing(null); refresh(); },
    onError: (e) => message.error(errorMessage(e)),
  });
  const removeFeeder = useMutation({
    mutationFn: async (id: string) => (await api.delete(`/misp/feeders/${id}`)).data,
    onSuccess: () => { message.success('Feeder eliminado'); refresh(); },
    onError: (e) => message.error(errorMessage(e)),
  });
  const runFeeder = useMutation({
    mutationFn: async (id: string) => (await api.post(`/misp/feeders/${id}/run`)).data,
    onSuccess: (f) => {
      const r = f.config?.lastResult;
      if (r?.ok) message.success(`${r.events} evento(s): ${r.created} alerta(s) nueva(s), ${r.updated} actualizada(s)`);
      else message.error(r?.error || 'Error');
      refresh();
    },
    onError: (e) => message.error(errorMessage(e)),
  });

  const openServer = (row?: any) => {
    setEditing(row || {});
    form.resetFields();
    form.setFieldsValue(row ? { name: row.name, url: row.url, verifyTls: row.verifyTls, distribution: row.distribution } : { type: 'cortex', verifyTls: true });
  };
  const openFeeder = (row?: any) => {
    setFeederEditing(row || {});
    feederForm.resetFields();
    const cfg = row?.config || {};
    feederForm.setFieldsValue(row
      ? { name: row.name, enabled: row.enabled, connectorId: cfg.connectorId, intervalMinutes: cfg.intervalMinutes, last: cfg.last, limit: cfg.limit, publishedOnly: cfg.publishedOnly, tags: cfg.tags }
      : { name: 'MISP feeder', enabled: true, connectorId: mispServers[0]?.id, intervalMinutes: 15, last: '1d', limit: 100, publishedOnly: false, tags: [] });
  };

  return (
    <div>
      <Card
        size="small"
        title="Servidores Cortex y MISP"
        style={{ marginBottom: 12 }}
        extra={
          <Space>
            <Button size="small" icon={<ReloadOutlined />} onClick={() => status.refetch()} loading={status.isFetching}>Probar conexión</Button>
            {canManage && <Button size="small" type="primary" icon={<PlusOutlined />} onClick={() => openServer()}>Añadir servidor</Button>}
          </Space>
        }
      >
        <Table
          rowKey="id" size="small" pagination={false} loading={status.isLoading} dataSource={status.data || []}
          locale={{ emptyText: 'Sin servidores. Añade tu Cortex y tu MISP para habilitar análisis, responders e intercambio de IOCs.' }}
          columns={[
            { title: 'Tipo', dataIndex: 'type', width: 90, render: (v: string) => <Tag color={v === 'cortex' ? 'purple' : 'geekblue'}>{v.toUpperCase()}</Tag> },
            { title: 'Nombre', dataIndex: 'name' },
            { title: 'URL', dataIndex: 'url', render: (v: string) => <code>{v}</code> },
            { title: 'API key', dataIndex: 'apiKeyPreview', width: 120, render: (v: string) => <code>{v}</code> },
            {
              title: 'Estado', width: 330,
              render: (_: any, r: any) => r.status?.ok ? (
                <Space size={4} wrap>
                  <Badge status="success" text={`OK v${r.status.version || '?'}`} />
                  {r.type === 'cortex' && <Tag>{r.status.analyzers} analizadores · org {r.status.organisation}</Tag>}
                  <Typography.Text type="secondary">{r.status.latencyMs} ms</Typography.Text>
                </Space>
              ) : <Badge status="error" text={r.status?.error || 'Sin respuesta'} />,
            },
            {
              title: '', width: 90,
              render: (_: any, r: any) => canManage && (
                <Space>
                  <Button size="small" type="text" icon={<EditOutlined />} onClick={() => openServer(r)} />
                  <Popconfirm title="¿Eliminar servidor?" onConfirm={() => remove.mutate(r.id)}>
                    <Button size="small" type="text" danger icon={<DeleteOutlined />} />
                  </Popconfirm>
                </Space>
              ),
            },
          ]}
        />
      </Card>

      <Card
        size="small"
        title="Feeders MISP → alertas (importación automática)"
        extra={canManage && <Button size="small" type="primary" icon={<PlusOutlined />} disabled={!mispServers.length} onClick={() => openFeeder()}>Nuevo feeder</Button>}
      >
        {!mispServers.length && <Alert type="info" showIcon style={{ marginBottom: 8 }} message="Añade primero un servidor MISP." />}
        <Table
          rowKey="id" size="small" pagination={false} loading={feeders.isLoading} dataSource={feeders.data || []}
          columns={[
            { title: 'Nombre', dataIndex: 'name' },
            { title: 'Activo', dataIndex: 'enabled', width: 80, render: (v: boolean) => (v ? <Tag color="green">Sí</Tag> : <Tag>No</Tag>) },
            { title: 'Cada', width: 90, render: (_: any, f: any) => `${f.config?.intervalMinutes} min` },
            { title: 'Ventana', width: 90, render: (_: any, f: any) => f.config?.last },
            { title: 'Última ejecución', width: 160, render: (_: any, f: any) => (f.config?.lastRunAt ? date(f.config.lastRunAt) : '—') },
            {
              title: 'Resultado',
              render: (_: any, f: any) => {
                const r = f.config?.lastResult;
                if (!r) return '—';
                return r.ok ? <span>{r.events} eventos · <b>{r.created}</b> nuevas · {r.updated} actualizadas{r.errors?.length ? ` · ${r.errors.length} errores` : ''}</span> : <Typography.Text type="danger">{r.error}</Typography.Text>;
              },
            },
            {
              title: '', width: 130,
              render: (_: any, f: any) => (
                <Space>
                  {can('manageAlert/create') && <Button size="small" icon={<PlayCircleOutlined />} loading={runFeeder.isPending && runFeeder.variables === f.id} onClick={() => runFeeder.mutate(f.id)} />}
                  {canManage && <Button size="small" type="text" icon={<EditOutlined />} onClick={() => openFeeder(f)} />}
                  {canManage && (
                    <Popconfirm title="¿Eliminar feeder?" onConfirm={() => removeFeeder.mutate(f.id)}>
                      <Button size="small" type="text" danger icon={<DeleteOutlined />} />
                    </Popconfirm>
                  )}
                </Space>
              ),
            },
          ]}
        />
      </Card>

      <Modal
        title={editing?.id ? `Editar ${editing.name}` : 'Añadir servidor'}
        open={!!editing} onCancel={() => setEditing(null)} onOk={() => form.submit()} confirmLoading={save.isPending}
      >
        <Form form={form} layout="vertical" onFinish={(v) => save.mutate(v)}>
          {!editing?.id && (
            <Form.Item name="type" label="Tipo" rules={[{ required: true }]}>
              <Select options={[{ value: 'cortex', label: 'Cortex (analizadores y responders)' }, { value: 'misp', label: 'MISP (threat intelligence)' }]} />
            </Form.Item>
          )}
          <Form.Item name="name" label="Nombre" rules={[{ required: true }]}><Input placeholder="Cortex local" /></Form.Item>
          <Form.Item name="url" label="URL" rules={[{ required: true }]} extra="Cortex: http://host:9001 · MISP: https://misp.example">
            <Input placeholder="http://192.0.2.10:9001" />
          </Form.Item>
          <Form.Item name="apiKey" label="API key" rules={editing?.id ? [] : [{ required: true }]} extra={editing?.id ? 'Déjalo vacío para conservar la actual' : undefined}>
            <Input.Password />
          </Form.Item>
          <Row gutter={12}>
            <Col span={12}>
              <Form.Item name="verifyTls" label="Verificar certificado TLS" valuePropName="checked"><Switch /></Form.Item>
            </Col>
            <Col span={12}>
              <Form.Item noStyle shouldUpdate>
                {() => (form.getFieldValue('type') === 'misp' || editing?.type === 'misp') && (
                  <Form.Item name="distribution" label="Distribución al exportar">
                    <Select allowClear placeholder="Solo tu organización" options={[
                      { value: 0, label: 'Solo tu organización' }, { value: 1, label: 'Esta comunidad' },
                      { value: 2, label: 'Comunidades conectadas' }, { value: 3, label: 'Todas las comunidades' },
                    ]} />
                  </Form.Item>
                )}
              </Form.Item>
            </Col>
          </Row>
        </Form>
      </Modal>

      <Modal
        title={feederEditing?.id ? `Editar ${feederEditing.name}` : 'Nuevo feeder MISP'}
        open={!!feederEditing} onCancel={() => setFeederEditing(null)} onOk={() => feederForm.submit()} confirmLoading={saveFeeder.isPending}
      >
        <Form form={feederForm} layout="vertical" onFinish={(v) => saveFeeder.mutate(v)}>
          <Form.Item name="name" label="Nombre" rules={[{ required: true }]}><Input /></Form.Item>
          <Form.Item name="connectorId" label="Servidor MISP" rules={[{ required: true }]}>
            <Select options={mispServers.map((c: any) => ({ value: c.id, label: c.name }))} />
          </Form.Item>
          <Row gutter={12}>
            <Col span={8}><Form.Item name="intervalMinutes" label="Cada (min)"><InputNumber min={1} style={{ width: '100%' }} /></Form.Item></Col>
            <Col span={8}>
              <Form.Item name="last" label="Ventana">
                <Select options={['1h', '12h', '1d', '7d', '30d'].map((v) => ({ value: v, label: v }))} />
              </Form.Item>
            </Col>
            <Col span={8}><Form.Item name="limit" label="Máx. eventos"><InputNumber min={1} max={500} style={{ width: '100%' }} /></Form.Item></Col>
          </Row>
          <Form.Item name="tags" label="Solo eventos con estos tags (opcional)"><Select mode="tags" /></Form.Item>
          <Space size="large">
            <Form.Item name="publishedOnly" label="Solo publicados" valuePropName="checked"><Switch /></Form.Item>
            <Form.Item name="enabled" label="Activo" valuePropName="checked"><Switch /></Form.Item>
          </Space>
        </Form>
      </Modal>
    </div>
  );
}
