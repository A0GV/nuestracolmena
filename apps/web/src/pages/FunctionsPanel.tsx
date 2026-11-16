import { useRef, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  Alert, Button, Card, Drawer, Form, Input, Popconfirm, Select, Space, Switch, Table, Tabs, Tag,
  Tooltip, Typography, message,
} from 'antd';
import {
  DeleteOutlined, EditOutlined, HistoryOutlined, PlayCircleOutlined, PlusOutlined, ReloadOutlined,
} from '@ant-design/icons';
import { API_URL, api, errorMessage } from '../lib/api';
import { useAuth } from '../lib/auth';
import { date } from '../lib/format';
import { FUNCTION_TEMPLATES } from '../lib/functionTemplates';

const KIND_OPTIONS = [
  { value: 'api', label: 'api · invocada por HTTP' },
  { value: 'action:case', label: 'action:case · acción de caso' },
  { value: 'action:alert', label: 'action:alert · acción de alerta' },
  { value: 'notification', label: 'notification · notificador' },
];

const MODE_COLOURS: Record<string, string> = { Enabled: 'green', DryRun: 'orange', Disabled: 'red' };

const API_ORIGIN = API_URL.replace(/\/api\/v1\/?$/, '');

const MONO = { fontFamily: "'JetBrains Mono', 'Fira Code', Consolas, monospace", fontSize: 12, lineHeight: 1.5 };

function buildPayload(values: any) {
  return {
    name: values.name,
    description: values.description || '',
    kind: values.kind || 'api',
    mode: values.mode || 'Enabled',
    code: values.code || '',
  };
}

export default function FunctionsPanel() {
  const qc = useQueryClient();
  const { can } = useAuth();
  const canManage = can('manageConfig');
  const canInvoke = can('manageConfig') || can('manageFunction/invoke');

  const [editing, setEditing] = useState<any>(null);
  const [templateKey, setTemplateKey] = useState<string | undefined>(undefined);
  const [runsFor, setRunsFor] = useState<any>(null);
  const [testInput, setTestInput] = useState('{\n  "title": "Prueba desde la consola"\n}');
  const [testDryRun, setTestDryRun] = useState(true);
  const [testResult, setTestResult] = useState<any>(null);
  const [testing, setTesting] = useState(false);
  const [form] = Form.useForm();
  const codeRef = useRef<any>(null);
  const watchedName = Form.useWatch('name', form);

  const functions = useQuery({ queryKey: ['functions'], queryFn: async () => (await api.get('/functions')).data });
  const runs = useQuery({
    queryKey: ['function-runs', runsFor?.id],
    queryFn: async () => (await api.get(`/functions/${runsFor.id}/runs`, { params: { limit: 100 } })).data,
    enabled: !!runsFor,
  });

  const save = useMutation({
    mutationFn: async (values: any) => {
      const payload = buildPayload(values);
      return editing?.id
        ? (await api.patch(`/functions/${editing.id}`, payload)).data
        : (await api.post('/functions', payload)).data;
    },
    onSuccess: (data) => {
      message.success('Función guardada');
      setEditing(data);
      form.setFieldsValue(data);
      qc.invalidateQueries({ queryKey: ['functions'] });
    },
    onError: (e) => message.error(errorMessage(e)),
  });

  const remove = useMutation({
    mutationFn: async (id: string) => (await api.delete(`/functions/${id}`)).data,
    onSuccess: () => {
      message.success('Función eliminada');
      setEditing(null);
      setRunsFor(null);
      qc.invalidateQueries({ queryKey: ['functions'] });
    },
    onError: (e) => message.error(errorMessage(e)),
  });

  const openCreate = () => {
    const template = FUNCTION_TEMPLATES[0];
    setEditing({});
    setTestResult(null);
    form.resetFields();
    setTemplateKey(template?.key);
    form.setFieldsValue({
      kind: template?.kind || 'api',
      mode: 'Enabled',
      code: template?.code || '',
    });
  };

  const openEdit = (row: any) => {
    setEditing(row);
    setTemplateKey(undefined);
    setTestResult(null);
    form.resetFields();
    form.setFieldsValue({
      name: row.name,
      description: row.description,
      kind: row.kind,
      mode: row.mode,
      code: row.code,
    });
  };

  const applyTemplate = (key: string) => {
    const template = FUNCTION_TEMPLATES.find((item) => item.key === key);
    if (!template) return;
    const name = form.getFieldValue('name');
    form.setFieldsValue({ code: template.code, kind: template.kind, ...(name ? {} : { name: template.key }) });
  };

  const handleCodeKeyDown = (event: any) => {
    if (event.key !== 'Tab') return;
    event.preventDefault();
    const element = event.currentTarget;
    const start = element.selectionStart ?? 0;
    const end = element.selectionEnd ?? 0;
    const value = String(form.getFieldValue('code') || '');
    const next = `${value.slice(0, start)}  ${value.slice(end)}`;
    form.setFieldValue('code', next);
    requestAnimationFrame(() => {
      element.selectionStart = element.selectionEnd = start + 2;
    });
  };

  const runTest = async () => {
    let input: any;
    try {
      input = JSON.parse(testInput || '{}');
    } catch {
      message.error('La entrada de prueba no es JSON válido');
      return;
    }
    setTesting(true);
    try {
      let id = editing?.id;
      if (!id) {
        const values = await form.validateFields();
        const created = (await api.post('/functions', buildPayload(values))).data;
        id = created.id;
        setEditing(created);
        form.setFieldsValue(created);
        qc.invalidateQueries({ queryKey: ['functions'] });
      } else if (form.isFieldsTouched()) {
        const values = await form.validateFields();
        await save.mutateAsync(values);
      }
      const result = (await api.post(`/functions/${id}/test`, { input, dryRun: testDryRun })).data;
      setTestResult(result);
      qc.invalidateQueries({ queryKey: ['function-runs', id] });
      qc.invalidateQueries({ queryKey: ['functions'] });
    } catch (e: any) {
      if (e?.errorFields) return;
      setTestResult({ error: errorMessage(e), logs: e?.response?.data?.logs });
    } finally {
      setTesting(false);
    }
  };

  const functionName = watchedName || editing?.name || '<nombre>';
  const invocationUrl = `${API_ORIGIN}/api/v1/function/${functionName}`;
  const curl = [
    `curl -X POST '${invocationUrl}' \\`,
    `  -H 'Authorization: Bearer <API key>' \\`,
    `  -H 'Content-Type: application/json' \\`,
    `  -d '{"title":"Ejemplo","severity":2}'`,
  ].join('\n');

  return (
    <div>
      <Card
        size="small"
        title="Functions"
        style={{ marginBottom: 12 }}
        extra={
          <Space>
            <Button size="small" icon={<ReloadOutlined />} onClick={() => functions.refetch()}>Actualizar</Button>
            {canManage && <Button size="small" type="primary" icon={<PlusOutlined />} onClick={openCreate}>Nueva función</Button>}
          </Space>
        }
      >
        <Table
          rowKey="id"
          size="small"
          pagination={false}
          loading={functions.isLoading}
          dataSource={functions.data || []}
          locale={{ emptyText: 'Sin funciones. Crea una para procesar el JSON de Wazuh, Suricata o n8n.' }}
          columns={[
            {
              title: 'Nombre',
              dataIndex: 'name',
              render: (value: string, row: any) => (
                <div>
                  <b>{value}</b>
                  {row.description ? <div style={{ color: '#8c8c9a', fontSize: 12 }}>{row.description}</div> : null}
                </div>
              ),
            },
            { title: 'Tipo', dataIndex: 'kind', width: 130, render: (value: string) => <Tag color="blue">{value}</Tag> },
            {
              title: 'Modo',
              dataIndex: 'mode',
              width: 100,
              render: (value: string) => <Tag color={MODE_COLOURS[value] || 'default'}>{value}</Tag>,
            },
            {
              title: 'Última ejecución',
              width: 210,
              render: (_: any, row: any) =>
                row.lastRun ? (
                  <Space size={4}>
                    <Tag color={row.lastRun.status === 'Success' ? 'green' : 'red'}>{row.lastRun.status}</Tag>
                    <span style={{ fontSize: 12 }}>{date(row.lastRun.createdAt)}</span>
                    {row.lastRun.durationMs !== undefined && <span style={{ color: '#8c8c9a', fontSize: 12 }}>{row.lastRun.durationMs} ms</span>}
                  </Space>
                ) : (
                  <span style={{ color: '#8c8c9a' }}>—</span>
                ),
            },
            {
              title: '',
              width: 180,
              render: (_: any, row: any) => (
                <Space>
                  <Tooltip title="Ejecuciones"><Button size="small" icon={<HistoryOutlined />} onClick={() => setRunsFor(row)} /></Tooltip>
                  {canManage && <Tooltip title="Editar y probar"><Button size="small" type="text" icon={<EditOutlined />} onClick={() => openEdit(row)} /></Tooltip>}
                  {canManage && (
                    <Popconfirm title="¿Eliminar la función y sus ejecuciones?" onConfirm={() => remove.mutate(row.id)}>
                      <Button size="small" type="text" danger icon={<DeleteOutlined />} />
                    </Popconfirm>
                  )}
                </Space>
              ),
            },
          ]}
        />
      </Card>

      <Drawer
        title={editing?.id ? `Función · ${editing.name}` : 'Nueva función'}
        width={Math.min(1080, typeof window === 'undefined' ? 1080 : Math.round(window.innerWidth * 0.9))}
        open={!!editing}
        onClose={() => setEditing(null)}
        destroyOnClose={false}
        extra={editing?.id && canManage && (
          <Button icon={<PlayCircleOutlined />} onClick={runTest} loading={testing}>Probar</Button>
        )}
      >
        <Form form={form} layout="vertical" onFinish={(values) => save.mutate(values)}>
          <Space style={{ width: '100%' }} align="start" wrap>
            <Form.Item name="name" label="Nombre" rules={[{ required: true }, { pattern: /^[a-zA-Z0-9_-]{1,64}$/, message: 'Solo letras, números, guion y guion bajo (1-64)' }]} style={{ width: 240 }}>
              <Input placeholder="wazuh-alert" />
            </Form.Item>
            <Form.Item name="kind" label="Tipo" style={{ width: 240 }}>
              <Select options={KIND_OPTIONS} />
            </Form.Item>
            <Form.Item name="mode" label="Modo" style={{ width: 150 }}>
              <Select options={['Enabled', 'DryRun', 'Disabled'].map((value) => ({ value, label: value }))} />
            </Form.Item>
            <Form.Item label="Plantilla" style={{ width: 240 }}>
              <Select
                allowClear
                placeholder="Cargar plantilla"
                value={templateKey}
                options={FUNCTION_TEMPLATES.map((template) => ({ value: template.key, label: template.label }))}
                onChange={(key) => { setTemplateKey(key); applyTemplate(key); }}
              />
            </Form.Item>
          </Space>
          <Form.Item name="description" label="Descripción">
            <Input placeholder="Qué hace esta función" />
          </Form.Item>
          <Form.Item
            name="code"
            label="Código (JavaScript)"
            rules={[{ required: true, message: 'El código es obligatorio' }]}
            extra="Define function handle(input, context). El código se ejecuta aislado, sin require ni process."
          >
            <Input.TextArea ref={codeRef} rows={20} style={MONO} onKeyDown={handleCodeKeyDown} spellCheck={false} />
          </Form.Item>
          <Space>
            {canManage && (
              <Button type="primary" onClick={() => form.submit()} loading={save.isPending}>
                {editing?.id ? 'Guardar cambios' : 'Crear función'}
              </Button>
            )}
            {editing?.id && canManage && (
              <Popconfirm title="¿Eliminar la función y sus ejecuciones?" onConfirm={() => remove.mutate(editing.id)}>
                <Button danger icon={<DeleteOutlined />}>Eliminar</Button>
              </Popconfirm>
            )}
          </Space>
        </Form>

        {editing?.id && canInvoke && (
          <Card size="small" title="Invocación HTTP" style={{ marginTop: 16 }}>
            <Typography.Paragraph style={{ marginBottom: 8 }}>
              URL: <Typography.Text copyable code>{invocationUrl}</Typography.Text>
            </Typography.Paragraph>
            <Typography.Paragraph type="secondary" style={{ marginBottom: 8 }}>
              Los usuarios con API key necesitan el permiso <code>manageFunction/invoke</code> (o <code>manageConfig</code>).
            </Typography.Paragraph>
            <Typography.Paragraph copyable={{ text: curl }} style={{ marginBottom: 0 }} type="secondary">
              Ejemplo de invocación (pulsa el icono para copiar):
            </Typography.Paragraph>
            <pre style={{ ...MONO, background: '#f7f7f9', padding: 10, borderRadius: 6, whiteSpace: 'pre-wrap' }}>{curl}</pre>
          </Card>
        )}

        {editing?.id && canManage && (
          <Card size="small" title="Probar" style={{ marginTop: 16 }}>
            <Space direction="vertical" style={{ width: '100%' }}>
              <div style={{ display: 'flex', gap: 12, alignItems: 'center' }}>
                <Typography.Text strong>DryRun</Typography.Text>
                <Switch checked={testDryRun} onChange={setTestDryRun} />
                <Typography.Text type="secondary">No ejecuta escrituras; solo registra las llamadas.</Typography.Text>
              </div>
              <Input.TextArea
                rows={6}
                value={testInput}
                onChange={(event) => setTestInput(event.target.value)}
                style={MONO}
                placeholder='{"title":"..."}'
              />
              <Button type="primary" icon={<PlayCircleOutlined />} onClick={runTest} loading={testing}>
                Ejecutar prueba
              </Button>
              {testResult && <TestResult result={testResult} />}
            </Space>
          </Card>
        )}
      </Drawer>

      <Drawer
        title={`Ejecuciones · ${runsFor?.name || ''}`}
        width={900}
        open={!!runsFor}
        onClose={() => setRunsFor(null)}
        extra={<Button size="small" icon={<ReloadOutlined />} onClick={() => runs.refetch()}>Actualizar</Button>}
      >
        <Table
          rowKey="id"
          size="small"
          loading={runs.isFetching}
          dataSource={runs.data || []}
          pagination={{ pageSize: 20 }}
          expandable={{
            expandedRowRender: (row: any) => (
              <div>
                <Typography.Text strong>Entrada</Typography.Text>
                <pre style={{ ...MONO, maxHeight: 220, overflow: 'auto' }}>{JSON.stringify(row.payload?.input, null, 2)}</pre>
                <Typography.Text strong>Salida</Typography.Text>
                <pre style={{ ...MONO, maxHeight: 220, overflow: 'auto' }}>{JSON.stringify(row.result?.output, null, 2)}</pre>
                {Array.isArray(row.result?.logs) && row.result.logs.length > 0 && (
                  <>
                    <Typography.Text strong>Logs</Typography.Text>
                    <pre style={{ ...MONO, maxHeight: 180, overflow: 'auto' }}>{row.result.logs.join('\n')}</pre>
                  </>
                )}
                {Array.isArray(row.result?.calls) && row.result.calls.length > 0 && (
                  <>
                    <Typography.Text strong>Llamadas registradas (DryRun)</Typography.Text>
                    <pre style={{ ...MONO, maxHeight: 180, overflow: 'auto' }}>{JSON.stringify(row.result.calls, null, 2)}</pre>
                  </>
                )}
              </div>
            ),
          }}
          columns={[
            { title: 'Fecha', dataIndex: 'createdAt', width: 170, render: (value: string) => date(value) },
            { title: 'Estado', dataIndex: 'status', width: 100, render: (value: string) => <Tag color={value === 'Success' ? 'green' : 'red'}>{value}</Tag> },
            { title: 'DryRun', width: 90, render: (_: any, row: any) => (row.payload?.dryRun ? <Tag color="orange">Sí</Tag> : 'No') },
            { title: 'Duración', width: 100, render: (_: any, row: any) => (row.result?.durationMs !== undefined ? `${row.result.durationMs} ms` : '—') },
            { title: 'Error', render: (_: any, row: any) => (row.result?.error ? <Typography.Text type="danger">{String(row.result.error).split('\n')[0]}</Typography.Text> : '—') },
          ]}
        />
      </Drawer>
    </div>
  );
}

function TestResult({ result }: { result: any }) {
  return (
    <div style={{ width: '100%' }}>
      {result.error ? <Alert type="error" showIcon message={result.error} style={{ marginBottom: 8 }} /> : null}
      {result.timedOut ? <Alert type="warning" showIcon message="La ejecución agotó el tiempo máximo (30 s)" style={{ marginBottom: 8 }} /> : null}
      <Space size={16} style={{ marginBottom: 8 }}>
        <Tag color="blue">{result.durationMs ?? 0} ms</Tag>
        {result.dryRun ? <Tag color="orange">DryRun</Tag> : <Tag color="green">Real</Tag>}
      </Space>
      <Tabs
        size="small"
        items={[
          {
            key: 'output',
            label: 'Salida',
            children: <pre style={{ ...MONO, maxHeight: 260, overflow: 'auto' }}>{JSON.stringify(result.output ?? null, null, 2)}</pre>,
          },
          {
            key: 'logs',
            label: `Logs (${result.logs?.length || 0})`,
            children: <pre style={{ ...MONO, maxHeight: 260, overflow: 'auto' }}>{(result.logs || []).join('\n') || 'Sin logs'}</pre>,
          },
          {
            key: 'calls',
            label: `Llamadas (${result.calls?.length || 0})`,
            children: <pre style={{ ...MONO, maxHeight: 260, overflow: 'auto' }}>{JSON.stringify(result.calls || [], null, 2)}</pre>,
          },
        ]}
      />
    </div>
  );
}
