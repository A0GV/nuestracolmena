import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  Button, Card, Col, Drawer, Form, Input, InputNumber, Modal, Popconfirm, Row, Select, Space,
  Switch, Table, Tag, Tooltip, Typography, message,
} from 'antd';
import { DeleteOutlined, EditOutlined, PlusOutlined, ReloadOutlined, SendOutlined, ThunderboltOutlined } from '@ant-design/icons';
import { api, errorMessage } from '../lib/api';
import { useAuth } from '../lib/auth';
import { date } from '../lib/format';
import FunctionsPanel from './FunctionsPanel';
import SlaPanel from './SlaPanel';

const TRIGGERS = [
  'AnyEvent', 'AlertCreated', 'AlertImported', 'CaseCreated', 'CaseUpdated', 'CaseClosed',
  'CaseAssigneeChanged', 'TaskAssigned', 'TaskClosed', 'ObservableCreated', 'LogInMyTask',
  'CommentCreated', 'JobFinished', 'SlaWarning', 'SlaBreached', 'FilteredEvent',
];

const NOTIFIER_TYPES = ['webhook', 'slack', 'mattermost', 'teams', 'discord', 'email', 'function'];
const ENDPOINT_TYPES = ['webhook', 'slack', 'mattermost', 'teams', 'discord', 'smtp'];
const ENDPOINT_TYPE_FOR: Record<string, string> = {
  webhook: 'webhook', slack: 'slack', mattermost: 'mattermost', teams: 'teams', discord: 'discord', email: 'smtp',
};
const VARIABLES = '{{event.action}} · {{event.objectType}} · {{object.title}} · {{object._id}} · {{context.title}} · {{organisation}} · {{url}}';

function endpointTypeFor(type: string) {
  return ENDPOINT_TYPE_FOR[type] || type;
}

export default function AutomationPanel() {
  const qc = useQueryClient();
  const { can } = useAuth();
  const canManage = can('manageConfig');

  const [endpointEditing, setEndpointEditing] = useState<any>(null);
  const [notificationEditing, setNotificationEditing] = useState<any>(null);
  const [deliveriesFor, setDeliveriesFor] = useState<any>(null);
  const [endpointForm] = Form.useForm();
  const [notificationForm] = Form.useForm();

  const endpoints = useQuery({ queryKey: ['endpoints'], queryFn: async () => (await api.get('/endpoints')).data });
  const notifications = useQuery({ queryKey: ['notifications'], queryFn: async () => (await api.get('/notifications')).data });
  const functions = useQuery({ queryKey: ['functions'], queryFn: async () => (await api.get('/functions')).data });
  const deliveries = useQuery({
    queryKey: ['notification-deliveries', deliveriesFor?.id],
    queryFn: async () => (await api.get('/notifications/deliveries', { params: { notificationId: deliveriesFor?.id, limit: 50 } })).data,
    enabled: !!deliveriesFor,
  });

  const refresh = () => {
    qc.invalidateQueries({ queryKey: ['endpoints'] });
    qc.invalidateQueries({ queryKey: ['notifications'] });
  };

  const saveEndpoint = useMutation({
    mutationFn: async (values: any) => {
      const payload = { name: values.name, type: values.type, config: endpointConfig(values) };
      return endpointEditing?.id
        ? (await api.patch(`/endpoints/${endpointEditing.id}`, payload)).data
        : (await api.post('/endpoints', payload)).data;
    },
    onSuccess: () => { message.success('Endpoint guardado'); setEndpointEditing(null); refresh(); },
    onError: (e) => message.error(errorMessage(e)),
  });
  const removeEndpoint = useMutation({
    mutationFn: async (id: string) => (await api.delete(`/endpoints/${id}`)).data,
    onSuccess: () => { message.success('Endpoint eliminado'); refresh(); },
    onError: (e) => message.error(errorMessage(e)),
  });
  const testEndpoint = useMutation({
    mutationFn: async (row: any) => (await api.post(`/endpoints/${row.id}/test`, {})).data,
    onSuccess: (r) => (r.ok ? message.success(`Prueba correcta${r.status ? ` (HTTP ${r.status})` : ''}`) : message.error(`Fallo: ${r.error || 'sin respuesta'}`)),
    onError: (e) => message.error(errorMessage(e)),
  });

  const saveNotification = useMutation({
    mutationFn: async (values: any) => {
      const payload = { name: values.name, enabled: values.enabled !== false, config: notificationConfig(values) };
      return notificationEditing?.id
        ? (await api.patch(`/notifications/${notificationEditing.id}`, payload)).data
        : (await api.post('/notifications', payload)).data;
    },
    onSuccess: () => { message.success('Notificación guardada'); setNotificationEditing(null); refresh(); },
    onError: (e) => message.error(errorMessage(e)),
  });
  const toggleNotification = useMutation({
    mutationFn: async ({ id, enabled }: any) => (await api.patch(`/notifications/${id}`, { enabled })).data,
    onSuccess: () => refresh(),
    onError: (e) => message.error(errorMessage(e)),
  });
  const removeNotification = useMutation({
    mutationFn: async (id: string) => (await api.delete(`/notifications/${id}`)).data,
    onSuccess: () => { message.success('Notificación eliminada'); refresh(); },
    onError: (e) => message.error(errorMessage(e)),
  });
  const testNotification = useMutation({
    mutationFn: async (row: any) => (await api.post(`/notifications/${row.id}/test`)).data,
    onSuccess: (r) => {
      const failed = (r.results || []).filter((x: any) => !x.ok);
      if (r.ok) message.success(`Prueba correcta (${r.results?.length || 0} notificador(es))`);
      else message.error(`Fallaron ${failed.length}: ${failed.map((x: any) => `${x.type}: ${x.error || x.status || 'error'}`).join('; ')}`);
      qc.invalidateQueries({ queryKey: ['notification-deliveries'] });
    },
    onError: (e) => message.error(errorMessage(e)),
  });

  const openEndpoint = (row?: any) => {
    setEndpointEditing(row || {});
    endpointForm.resetFields();
    const cfg = row?.config || {};
    endpointForm.setFieldsValue(
      row
        ? {
            name: row.name, type: row.type,
            url: cfg.url, method: cfg.method || 'POST', headers: cfg.headers ? JSON.stringify(cfg.headers, null, 2) : '',
            authType: cfg.auth?.type || 'none', token: '', username: cfg.auth?.username || '', password: '',
            verifyTls: cfg.verifyTls !== false, format: cfg.format || 'thehive', webhookUrl: cfg.webhookUrl,
            host: cfg.host, port: cfg.port, secure: !!cfg.secure, user: cfg.user, from: cfg.from,
          }
        : { name: '', type: 'webhook', method: 'POST', authType: 'none', verifyTls: true, format: 'thehive', secure: false, port: 25 },
    );
  };

  const openNotification = (row?: any) => {
    setNotificationEditing(row || {});
    notificationForm.resetFields();
    const cfg = row?.config || {};
    notificationForm.setFieldsValue(
      row
        ? {
            name: row.name, enabled: row.enabled, trigger: cfg.trigger,
            filterObjectType: cfg.filter?.objectType, filterAction: cfg.filter?.action,
            minSeverity: cfg.filter?.minSeverity, tagsAny: cfg.filter?.tagsAny,
            notifiers: (cfg.notifiers || []).map((n: any) => ({ ...n })),
          }
        : { name: '', enabled: true, trigger: 'AnyEvent', notifiers: [{ type: 'webhook' }] },
    );
  };

  const endpointName = (id: string) => (endpoints.data || []).find((e: any) => e.id === id)?.name || id;
  const functionName = (id: string) => (functions.data || []).find((f: any) => f.id === id)?.name || id;

  return (
    <div>
      <SlaPanel />
      <FunctionsPanel />

      <Card
        size="small" title="Endpoints" style={{ marginBottom: 12 }}
        extra={
          <Space>
            <Button size="small" icon={<ReloadOutlined />} onClick={() => endpoints.refetch()}>Actualizar</Button>
            {canManage && <Button size="small" type="primary" icon={<PlusOutlined />} onClick={() => openEndpoint()}>Nuevo endpoint</Button>}
          </Space>
        }
      >
        <Table
          rowKey="id" size="small" pagination={false} loading={endpoints.isLoading} dataSource={endpoints.data || []}
          locale={{ emptyText: 'Sin endpoints. Crea uno para enviar webhooks, mensajes o correos.' }}
          columns={[
            { title: 'Nombre', dataIndex: 'name' },
            { title: 'Tipo', dataIndex: 'type', width: 110, render: (v: string) => <Tag color={v === 'smtp' ? 'orange' : 'blue'}>{v}</Tag> },
            { title: 'Destino', render: (_: any, r: any) => <code>{r.config?.url || r.config?.webhookUrl || (r.config?.host ? `${r.config.host}:${r.config.port}` : '—')}</code> },
            {
              title: '', width: 150,
              render: (_: any, r: any) => canManage && (
                <Space>
                  <Tooltip title="Probar"><Button size="small" icon={<ThunderboltOutlined />} loading={testEndpoint.isPending && testEndpoint.variables?.id === r.id} onClick={() => testEndpoint.mutate(r)} /></Tooltip>
                  <Button size="small" type="text" icon={<EditOutlined />} onClick={() => openEndpoint(r)} />
                  <Popconfirm title="¿Eliminar endpoint?" onConfirm={() => removeEndpoint.mutate(r.id)}>
                    <Button size="small" type="text" danger icon={<DeleteOutlined />} />
                  </Popconfirm>
                </Space>
              ),
            },
          ]}
        />
      </Card>

      <Card
        size="small" title="Notificaciones"
        extra={canManage && <Button size="small" type="primary" icon={<PlusOutlined />} onClick={() => openNotification()}>Nueva notificación</Button>}
      >
        <Table
          rowKey="id" size="small" pagination={false} loading={notifications.isLoading} dataSource={notifications.data || []}
          locale={{ emptyText: 'Sin notificaciones. Crea un disparador y añade notificadores.' }}
          columns={[
            { title: 'Nombre', dataIndex: 'name' },
            { title: 'Disparador', dataIndex: 'config', width: 190, render: (cfg: any) => <Tag color="purple">{cfg?.trigger || '—'}</Tag> },
            {
              title: 'Notificadores', dataIndex: 'config',
              render: (cfg: any) => (
                <Space wrap size={4}>
                  {(cfg?.notifiers || []).map((n: any, i: number) => (
                    <Tag key={i}>{n.type === 'function' ? `function: ${functionName(n.functionId)}` : `${n.type}: ${endpointName(n.endpointId)}`}</Tag>
                  ))}
                </Space>
              ),
            },
            {
              title: 'Activa', dataIndex: 'enabled', width: 80,
              render: (v: boolean, r: any) => <Switch size="small" checked={v} disabled={!canManage} onChange={(enabled) => toggleNotification.mutate({ id: r.id, enabled })} />,
            },
            {
              title: '', width: 210,
              render: (_: any, r: any) => canManage && (
                <Space>
                  <Tooltip title="Probar"><Button size="small" icon={<SendOutlined />} loading={testNotification.isPending && testNotification.variables?.id === r.id} onClick={() => testNotification.mutate(r)} /></Tooltip>
                  <Button size="small" onClick={() => setDeliveriesFor(r)}>Entregas</Button>
                  <Button size="small" type="text" icon={<EditOutlined />} onClick={() => openNotification(r)} />
                  <Popconfirm title="¿Eliminar notificación?" onConfirm={() => removeNotification.mutate(r.id)}>
                    <Button size="small" type="text" danger icon={<DeleteOutlined />} />
                  </Popconfirm>
                </Space>
              ),
            },
          ]}
        />
      </Card>

      <Modal
        title={endpointEditing?.id ? `Editar ${endpointEditing.name}` : 'Nuevo endpoint'}
        open={!!endpointEditing} onCancel={() => setEndpointEditing(null)} onOk={() => endpointForm.submit()} confirmLoading={saveEndpoint.isPending}
        width={640}
      >
        <Form form={endpointForm} layout="vertical" onFinish={(v) => saveEndpoint.mutate(v)}>
          <Row gutter={12}>
            <Col span={12}>
              <Form.Item name="name" label="Nombre" rules={[{ required: true }]}><Input /></Form.Item>
            </Col>
            <Col span={12}>
              <Form.Item name="type" label="Tipo" rules={[{ required: true }]}>
                <Select disabled={!!endpointEditing?.id} options={ENDPOINT_TYPES.map((v) => ({ value: v, label: v }))} />
              </Form.Item>
            </Col>
          </Row>
          <Form.Item noStyle shouldUpdate={(prev, cur) => prev.type !== cur.type || prev.id !== cur.id}>
            {() => {
              const type = endpointForm.getFieldValue('type');
              if (type === 'webhook') return (
                <>
                  <Form.Item name="url" label="URL" rules={[{ required: true }]}><Input placeholder="https://hooks.example/webhook" /></Form.Item>
                  <Row gutter={12}>
                    <Col span={8}>
                      <Form.Item name="method" label="Método">
                        <Select options={['POST', 'PUT', 'PATCH', 'GET'].map((v) => ({ value: v, label: v }))} />
                      </Form.Item>
                    </Col>
                    <Col span={8}>
                      <Form.Item name="authType" label="Autenticación">
                        <Select options={[{ value: 'none', label: 'Ninguna' }, { value: 'bearer', label: 'Bearer token' }, { value: 'basic', label: 'Basic' }]} />
                      </Form.Item>
                    </Col>
                    <Col span={8}>
                      <Form.Item name="format" label="Formato">
                        <Select options={[{ value: 'thehive', label: 'TheHive 5 (n8n)' }, { value: 'raw', label: 'Raw' }]} />
                      </Form.Item>
                    </Col>
                  </Row>
                  <Form.Item name="headers" label="Cabeceras (JSON)"><Input.TextArea rows={2} placeholder='{"X-Custom":"value"}' /></Form.Item>
                  <Form.Item noStyle shouldUpdate={(prev, cur) => prev.authType !== cur.authType}>
                    {() => {
                      const auth = endpointForm.getFieldValue('authType');
                      if (auth === 'bearer') return <Form.Item name="token" label="Token (write-only)" extra="Déjalo vacío para conservar el actual"><Input.Password /></Form.Item>;
                      if (auth === 'basic') return (
                        <Row gutter={12}>
                          <Col span={12}><Form.Item name="username" label="Usuario"><Input /></Form.Item></Col>
                          <Col span={12}><Form.Item name="password" label="Contraseña (write-only)" extra="Déjala vacía para conservar la actual"><Input.Password /></Form.Item></Col>
                        </Row>
                      );
                      return null;
                    }}
                  </Form.Item>
                  <Form.Item name="verifyTls" label="Verificar certificado TLS" valuePropName="checked"><Switch /></Form.Item>
                </>
              );
              if (['slack', 'mattermost', 'teams', 'discord'].includes(type)) return (
                <Form.Item name="webhookUrl" label="Webhook URL" rules={[{ required: true }]}><Input placeholder="https://hooks.slack.com/services/..." /></Form.Item>
              );
              if (type === 'smtp') return (
                <>
                  <Row gutter={12}>
                    <Col span={16}><Form.Item name="host" label="Servidor SMTP" rules={[{ required: true }]}><Input placeholder="smtp.example.com" /></Form.Item></Col>
                    <Col span={8}><Form.Item name="port" label="Puerto" rules={[{ required: true }]}><InputNumber min={1} max={65535} style={{ width: '100%' }} /></Form.Item></Col>
                  </Row>
                  <Row gutter={12}>
                    <Col span={12}><Form.Item name="user" label="Usuario"><Input /></Form.Item></Col>
                    <Col span={12}><Form.Item name="password" label="Contraseña (write-only)" extra="Déjala vacía para conservar la actual"><Input.Password /></Form.Item></Col>
                  </Row>
                  <Form.Item name="from" label="Remitente (from)" rules={[{ required: true }]}><Input placeholder="Nuestracolmena <nuestracolmena@example.com>" /></Form.Item>
                  <Form.Item name="secure" label="TLS directo (puerto 465)" valuePropName="checked"><Switch /></Form.Item>
                </>
              );
              return null;
            }}
          </Form.Item>
        </Form>
      </Modal>

      <Modal
        title={notificationEditing?.id ? `Editar ${notificationEditing.name}` : 'Nueva notificación'}
        open={!!notificationEditing} onCancel={() => setNotificationEditing(null)} onOk={() => notificationForm.submit()} confirmLoading={saveNotification.isPending}
        width={820}
      >
        <Form form={notificationForm} layout="vertical" onFinish={(v) => saveNotification.mutate(v)}>
          <Row gutter={12}>
            <Col span={14}><Form.Item name="name" label="Nombre" rules={[{ required: true }]}><Input /></Form.Item></Col>
            <Col span={5}>
              <Form.Item name="trigger" label="Disparador" rules={[{ required: true }]}>
                <Select showSearch options={TRIGGERS.map((v) => ({ value: v, label: v }))} />
              </Form.Item>
            </Col>
            <Col span={5}><Form.Item name="enabled" label="Activa" valuePropName="checked"><Switch /></Form.Item></Col>
          </Row>
          <Card size="small" title="Filtro (opcional)" style={{ marginBottom: 12 }}>
            <Row gutter={12}>
              <Col span={6}>
                <Form.Item name="filterObjectType" label="Tipo de objeto">
                  <Select allowClear options={['Alert', 'Case', 'Task', 'Log', 'Observable', 'Comment', 'Page', 'Procedure', 'Attachment', 'Job'].map((v) => ({ value: v, label: v }))} />
                </Form.Item>
              </Col>
              <Col span={6}><Form.Item name="filterAction" label="Acción"><Input placeholder="create, update, close…" /></Form.Item></Col>
              <Col span={6}><Form.Item name="minSeverity" label="Severidad mínima"><InputNumber min={0} max={4} style={{ width: '100%' }} /></Form.Item></Col>
              <Col span={6}><Form.Item name="tagsAny" label="Tags (alguno)"><Select mode="tags" placeholder="phishing" /></Form.Item></Col>
            </Row>
          </Card>
          <Typography.Paragraph type="secondary" style={{ marginBottom: 8 }}>
            Variables disponibles: <code>{VARIABLES}</code>
          </Typography.Paragraph>
          <Form.List name="notifiers">
            {(fields, { add, remove }) => (
              <>
                {fields.map((field) => (
                  <Card
                    key={field.key} size="small" style={{ marginBottom: 8 }}
                    title={`Notificador ${field.name + 1}`}
                    extra={<Button size="small" type="text" danger icon={<DeleteOutlined />} onClick={() => remove(field.name)} />}
                  >
                    <Row gutter={12}>
                      <Col span={8}>
                        <Form.Item {...field} name={[field.name, 'type']} label="Tipo" rules={[{ required: true }]}>
                          <Select options={NOTIFIER_TYPES.map((v) => ({ value: v, label: v }))} />
                        </Form.Item>
                      </Col>
                      <Col span={16}>
                        <Form.Item noStyle shouldUpdate>
                          {() => {
                            const type = notificationForm.getFieldValue(['notifiers', field.name, 'type']);
                            if (type === 'function') {
                              return (
                                <Form.Item {...field} name={[field.name, 'functionId']} label="Función" rules={[{ required: true }]}>
                                  <Select
                                    showSearch optionFilterProp="label"
                                    options={(functions.data || []).filter((f: any) => f.kind === 'notification').map((f: any) => ({ value: f.id, label: `${f.name} (${f.mode})` }))}
                                    placeholder="Función de tipo notification"
                                  />
                                </Form.Item>
                              );
                            }
                            const wanted = endpointTypeFor(type);
                            return (
                              <Form.Item {...field} name={[field.name, 'endpointId']} label="Endpoint" rules={[{ required: true }]}>
                                <Select
                                  showSearch optionFilterProp="label"
                                  options={(endpoints.data || []).filter((e: any) => e.type === wanted).map((e: any) => ({ value: e.id, label: `${e.name} (${e.type})` }))}
                                  placeholder={`Endpoint de tipo ${wanted}`}
                                />
                              </Form.Item>
                            );
                          }}
                        </Form.Item>
                      </Col>
                    </Row>
                    <Form.Item noStyle shouldUpdate>
                      {() => {
                        const type = notificationForm.getFieldValue(['notifiers', field.name, 'type']);
                        if (type === 'email') return (
                          <>
                            <Row gutter={12}>
                              <Col span={12}><Form.Item {...field} name={[field.name, 'to']} label="Destinatarios" rules={[{ required: true }]}><Select mode="tags" placeholder="soc@example.com" /></Form.Item></Col>
                              <Col span={12}><Form.Item {...field} name={[field.name, 'subject']} label="Asunto"><Input placeholder="[Nuestracolmena] {{event.objectType}} {{event.action}}" /></Form.Item></Col>
                            </Row>
                            <Form.Item {...field} name={[field.name, 'template']} label="Plantilla (cuerpo)"><Input.TextArea rows={3} placeholder="Se usa un texto por defecto si se deja vacío" /></Form.Item>
                          </>
                        );
                        if (type === 'webhook' || type === 'function') return null;
                        return <Form.Item {...field} name={[field.name, 'template']} label="Plantilla del mensaje"><Input.TextArea rows={2} placeholder="{{object.title}} — {{url}}" /></Form.Item>;
                      }}
                    </Form.Item>
                  </Card>
                ))}
                <Button type="dashed" block icon={<PlusOutlined />} onClick={() => add({ type: 'webhook' })}>Añadir notificador</Button>
              </>
            )}
          </Form.List>
        </Form>
      </Modal>

      <Drawer
        title={`Entregas · ${deliveriesFor?.name || ''}`} width={720} open={!!deliveriesFor} onClose={() => setDeliveriesFor(null)}
        extra={<Button size="small" icon={<ReloadOutlined />} onClick={() => deliveries.refetch()}>Actualizar</Button>}
      >
        <Table
          rowKey="id" size="small" loading={deliveries.isFetching} dataSource={deliveries.data || []} pagination={{ pageSize: 20 }}
          columns={[
            { title: 'Fecha', dataIndex: 'createdAt', width: 150, render: (v: string) => date(v) },
            { title: 'Estado', dataIndex: 'status', width: 90, render: (v: string) => <Tag color={v === 'Success' ? 'green' : 'red'}>{v}</Tag> },
            { title: 'Notificador', width: 120, render: (_: any, r: any) => r.payload?.notifierType },
            { title: 'Evento', render: (_: any, r: any) => `${r.payload?.event?.objectType || ''} ${r.payload?.event?.action || ''}` },
            { title: 'Intento', width: 70, render: (_: any, r: any) => r.payload?.attempt },
            { title: 'HTTP', width: 70, render: (_: any, r: any) => r.result?.httpStatus ?? '—' },
            { title: 'Error', render: (_: any, r: any) => r.result?.error ? <Typography.Text type="danger">{r.result.error}</Typography.Text> : '—' },
          ]}
        />
      </Drawer>
    </div>
  );
}

function endpointConfig(values: any) {
  const type = values.type;
  if (type === 'webhook') {
    const config: any = {
      url: values.url,
      method: values.method || 'POST',
      verifyTls: values.verifyTls !== false,
      format: values.format || 'thehive',
      auth: { type: values.authType || 'none' },
    };
    if (values.headers?.trim()) {
      try {
        config.headers = JSON.parse(values.headers);
      } catch {
        throw new Error('Las cabeceras deben ser JSON válido');
      }
    }
    if (values.token) config.auth.token = values.token;
    if (values.username) config.auth.username = values.username;
    if (values.password) config.auth.password = values.password;
    return config;
  }
  if (['slack', 'mattermost', 'teams', 'discord'].includes(type)) return { webhookUrl: values.webhookUrl };
  return {
    host: values.host,
    port: Number(values.port),
    secure: !!values.secure,
    user: values.user || undefined,
    password: values.password || undefined,
    from: values.from,
  };
}

function notificationConfig(values: any) {
  const filter: any = {};
  if (values.filterObjectType) filter.objectType = values.filterObjectType;
  if (values.filterAction) filter.action = values.filterAction;
  if (values.minSeverity !== undefined && values.minSeverity !== null) filter.minSeverity = Number(values.minSeverity);
  if (Array.isArray(values.tagsAny) && values.tagsAny.length) filter.tagsAny = values.tagsAny;
  const notifiers = (values.notifiers || []).map((n: any) => {
    if (n.type === 'function') return { type: 'function', functionId: n.functionId };
    const out: any = { type: n.type, endpointId: n.endpointId };
    if (n.type === 'email') {
      out.to = n.to || [];
      if (n.subject) out.subject = n.subject;
    }
    if (n.template) out.template = n.template;
    return out;
  });
  return {
    trigger: values.trigger,
    ...(Object.keys(filter).length ? { filter } : {}),
    notifiers,
  };
}
