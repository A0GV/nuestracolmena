import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  Button, Card, Col, Form, Input, InputNumber, Modal, Popconfirm, Row, Select, Space, Switch, Table, Tag, Typography, message,
} from 'antd';
import { DeleteOutlined, EditOutlined, MailOutlined, PlayCircleOutlined, PlusOutlined, ReloadOutlined } from '@ant-design/icons';
import { api, errorMessage } from '../lib/api';
import { useAuth } from '../lib/auth';
import { date } from '../lib/format';

const SEVERITY_OPTIONS = [{ value: 1, label: 'LOW' }, { value: 2, label: 'MEDIUM' }, { value: 3, label: 'HIGH' }, { value: 4, label: 'CRITICAL' }];
const TLP_OPTIONS = [{ value: 0, label: 'WHITE' }, { value: 1, label: 'GREEN' }, { value: 2, label: 'AMBER' }, { value: 3, label: 'RED' }];

export default function EmailFeedersPanel() {
  const qc = useQueryClient();
  const { can } = useAuth();
  const canManage = can('manageConfig');
  const [editing, setEditing] = useState<any>(null);
  const [form] = Form.useForm();

  const feeders = useQuery({ queryKey: ['email-feeders'], queryFn: async () => (await api.get('/email/feeders')).data });

  const refresh = () => qc.invalidateQueries({ queryKey: ['email-feeders'] });

  const save = useMutation({
    mutationFn: async (values: any) =>
      editing?.id ? (await api.patch(`/email/feeders/${editing.id}`, values)).data : (await api.post('/email/feeders', values)).data,
    onSuccess: () => { message.success('Buzón guardado'); setEditing(null); refresh(); },
    onError: (e) => message.error(errorMessage(e)),
  });
  const remove = useMutation({
    mutationFn: async (id: string) => (await api.delete(`/email/feeders/${id}`)).data,
    onSuccess: () => { message.success('Buzón eliminado'); refresh(); },
    onError: (e) => message.error(errorMessage(e)),
  });
  const toggle = useMutation({
    mutationFn: async ({ id, enabled }: any) => (await api.patch(`/email/feeders/${id}`, { enabled })).data,
    onSuccess: () => refresh(),
    onError: (e) => message.error(errorMessage(e)),
  });
  const test = useMutation({
    mutationFn: async (id: string) => (await api.post(`/email/feeders/${id}/test`)).data,
    onSuccess: (r) => message.success(`Conexión correcta · ${r.mailbox}: ${r.messages} mensaje(s), ${r.unseen} sin leer`),
    onError: (e) => message.error(errorMessage(e)),
  });
  const run = useMutation({
    mutationFn: async (id: string) => (await api.post(`/email/feeders/${id}/run`)).data,
    onSuccess: (feeder) => {
      const r = feeder?.config?.lastResult;
      if (r?.ok) message.success(`${r.fetched} leído(s): ${r.created} alerta(s) nueva(s), ${r.unchanged} sin cambios`);
      else message.error(r?.errors?.[0] || r?.error || 'Error al ejecutar el buzón');
      refresh();
    },
    onError: (e) => message.error(errorMessage(e)),
  });

  const open = (row?: any) => {
    setEditing(row || {});
    form.resetFields();
    if (row) {
      const cfg = row.config || {};
      form.setFieldsValue({ ...cfg, password: undefined });
    } else {
      form.setFieldsValue({
        port: 993, secure: true, verifyTls: true, mailbox: 'INBOX', intervalMinutes: 5,
        markSeen: true, maxPerRun: 50, tlp: 2, severity: 2, tags: [], enabled: true,
      });
    }
  };

  return (
    <Card
      size="small"
      title={<span><MailOutlined /> Buzones de correo (IMAP)</span>}
      style={{ marginTop: 12 }}
      extra={
        <Space>
          <Button size="small" icon={<ReloadOutlined />} onClick={() => feeders.refetch()} loading={feeders.isFetching}>Actualizar</Button>
          {canManage && <Button size="small" type="primary" icon={<PlusOutlined />} onClick={() => open()}>Nuevo buzón</Button>}
        </Space>
      }
    >
      <Typography.Paragraph type="secondary" style={{ marginBottom: 8 }}>
        Sondea un buzón IMAP (por ejemplo el de reportes de phishing) y convierte cada correo no leído en una alerta.
      </Typography.Paragraph>
      <Table
        rowKey="id" size="small" pagination={false} loading={feeders.isLoading} dataSource={feeders.data || []}
        locale={{ emptyText: 'Sin buzones. Añade uno para importar el correo de reportes de phishing.' }}
        columns={[
          { title: 'Nombre', dataIndex: 'name' },
          {
            title: 'Servidor',
            render: (_: any, f: any) => <code>{f.config?.host}:{f.config?.port}</code>,
          },
          {
            title: 'Usuario / carpeta',
            render: (_: any, f: any) => <span>{f.config?.user}<br /><Typography.Text type="secondary">{f.config?.mailbox}</Typography.Text></span>,
          },
          { title: 'Cada', width: 80, render: (_: any, f: any) => `${f.config?.intervalMinutes} min` },
          { title: 'Última ejecución', width: 150, render: (_: any, f: any) => (f.config?.lastRunAt ? date(f.config.lastRunAt) : '—') },
          {
            title: 'Resultado',
            render: (_: any, f: any) => {
              const r = f.config?.lastResult;
              if (!r) return '—';
              if (r.ok) {
                return <span>{r.fetched} leídos · <b>{r.created}</b> nuevas · {r.unchanged} sin cambios{r.errors?.length ? ` · ${r.errors.length} errores` : ''}</span>;
              }
              return <Typography.Text type="danger">{r.errors?.[0] || r.error || 'Error'}</Typography.Text>;
            },
          },
          {
            title: 'Activo', width: 80,
            render: (_: any, f: any) => (
              <Switch size="small" checked={f.enabled} disabled={!canManage} loading={toggle.isPending && toggle.variables?.id === f.id}
                onChange={(enabled) => toggle.mutate({ id: f.id, enabled })} />
            ),
          },
          {
            title: '', width: 160,
            render: (_: any, f: any) => canManage && (
              <Space>
                <Button size="small" icon={<ReloadOutlined />} loading={test.isPending && test.variables === f.id} onClick={() => test.mutate(f.id)} title="Probar conexión" />
                <Button size="small" icon={<PlayCircleOutlined />} loading={run.isPending && run.variables === f.id} onClick={() => run.mutate(f.id)} title="Ejecutar ahora" />
                <Button size="small" type="text" icon={<EditOutlined />} onClick={() => open(f)} />
                <Popconfirm title="¿Eliminar buzón?" onConfirm={() => remove.mutate(f.id)}>
                  <Button size="small" type="text" danger icon={<DeleteOutlined />} />
                </Popconfirm>
              </Space>
            ),
          },
        ]}
      />

      <Modal
        title={editing?.id ? `Editar ${editing.name}` : 'Nuevo buzón IMAP'}
        open={!!editing} onCancel={() => setEditing(null)} onOk={() => form.submit()} confirmLoading={save.isPending}
        width={640}
      >
        <Form form={form} layout="vertical" onFinish={(values) => save.mutate(values)}>
          <Form.Item name="name" label="Nombre" rules={[{ required: true }]}><Input placeholder="Buzón de reportes de phishing" /></Form.Item>
          <Row gutter={12}>
            <Col span={16}><Form.Item name="host" label="Servidor IMAP" rules={[{ required: true }]}><Input placeholder="mail.soc.example" /></Form.Item></Col>
            <Col span={8}><Form.Item name="port" label="Puerto"><InputNumber min={1} max={65535} style={{ width: '100%' }} /></Form.Item></Col>
          </Row>
          <Row gutter={12}>
            <Col span={12}><Form.Item name="user" label="Usuario" rules={[{ required: true }]}><Input placeholder="soc@example.com" /></Form.Item></Col>
            <Col span={12}>
              <Form.Item name="password" label="Contraseña" extra={editing?.id ? 'Déjala vacía para conservar la actual' : undefined}>
                <Input.Password autoComplete="new-password" />
              </Form.Item>
            </Col>
          </Row>
          <Row gutter={12}>
            <Col span={8}><Form.Item name="mailbox" label="Carpeta"><Input placeholder="INBOX" /></Form.Item></Col>
            <Col span={8}><Form.Item name="intervalMinutes" label="Cada (min)"><InputNumber min={1} style={{ width: '100%' }} /></Form.Item></Col>
            <Col span={8}><Form.Item name="maxPerRun" label="Máx. por ejecución"><InputNumber min={1} max={500} style={{ width: '100%' }} /></Form.Item></Col>
          </Row>
          <Row gutter={12}>
            <Col span={12}><Form.Item name="moveTo" label="Mover procesados a (opcional)"><Input placeholder="Processed" /></Form.Item></Col>
            <Col span={6}><Form.Item name="tlp" label="TLP"><Select options={TLP_OPTIONS} /></Form.Item></Col>
            <Col span={6}><Form.Item name="severity" label="Severidad"><Select options={SEVERITY_OPTIONS} /></Form.Item></Col>
          </Row>
          <Form.Item name="tags" label="Tags de las alertas"><Select mode="tags" /></Form.Item>
          <Space size="large" wrap>
            <Form.Item name="secure" label="TLS" valuePropName="checked"><Switch /></Form.Item>
            <Form.Item name="verifyTls" label="Verificar certificado" valuePropName="checked"><Switch /></Form.Item>
            <Form.Item name="markSeen" label="Marcar como leído" valuePropName="checked"><Switch /></Form.Item>
            <Form.Item name="enabled" label="Activo" valuePropName="checked"><Switch /></Form.Item>
          </Space>
        </Form>
      </Modal>
    </Card>
  );
}
