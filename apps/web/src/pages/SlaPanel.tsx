import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  Button, Card, Col, Form, Input, InputNumber, Modal, Popconfirm, Row, Select, Space, Switch, Table, Tag, Typography, message,
} from 'antd';
import { DeleteOutlined, EditOutlined, EyeOutlined, PlusOutlined, ReloadOutlined } from '@ant-design/icons';
import { api, errorMessage } from '../lib/api';
import { useAuth } from '../lib/auth';
import { SEVERITY, date } from '../lib/format';

const APPLIES_TO = [
  { value: 'case', label: 'Casos' },
  { value: 'alert', label: 'Alertas' },
  { value: 'task', label: 'Tareas' },
];
const SEVERITY_OPTIONS = Object.entries(SEVERITY).map(([value, severity]) => ({ value: Number(value), label: severity.label }));
const UNIT_OPTIONS = [{ value: 'minutes', label: 'minutos' }, { value: 'hours', label: 'horas' }];

export default function SlaPanel() {
  const qc = useQueryClient();
  const { can } = useAuth();
  const canManage = can('manageConfig');
  const [editing, setEditing] = useState<any>(null);
  const [preview, setPreview] = useState<any>(null);
  const [form] = Form.useForm();

  const rules = useQuery({ queryKey: ['sla-rules'], queryFn: async () => (await api.get('/sla-rules')).data });

  const refresh = () => qc.invalidateQueries({ queryKey: ['sla-rules'] });

  const save = useMutation({
    mutationFn: async (values: any) => {
      const payload = { name: values.name, enabled: values.enabled !== false, order: values.order ?? 0, config: buildConfig(values) };
      return editing?.id
        ? (await api.patch(`/sla-rules/${editing.id}`, payload)).data
        : (await api.post('/sla-rules', payload)).data;
    },
    onSuccess: () => { message.success('Regla SLA guardada'); setEditing(null); refresh(); },
    onError: (e) => message.error(errorMessage(e)),
  });

  const toggle = useMutation({
    mutationFn: async ({ id, enabled }: any) => (await api.patch(`/sla-rules/${id}`, { enabled })).data,
    onSuccess: () => refresh(),
    onError: (e) => message.error(errorMessage(e)),
  });

  const remove = useMutation({
    mutationFn: async (id: string) => (await api.delete(`/sla-rules/${id}`)).data,
    onSuccess: () => { message.success('Regla SLA eliminada'); refresh(); },
    onError: (e) => message.error(errorMessage(e)),
  });

  const runPreview = useMutation({
    mutationFn: async (row: any) => (await api.post(`/sla-rules/${row.id}/preview`)).data,
    onSuccess: (result) => setPreview(result),
    onError: (e) => message.error(errorMessage(e)),
  });

  const openEditor = (row?: any) => {
    setEditing(row || {});
    form.resetFields();
    if (!row) {
      form.setFieldsValue({ appliesTo: 'case', enabled: true, warnPercent: 80, order: 0, ackUnit: 'minutes', resUnit: 'minutes' });
      return;
    }
    const config = row.config || {};
    const objectives = config.objectives || {};
    const ack = durationFields(objectives.acknowledgeMinutes);
    const res = durationFields(objectives.resolveMinutes);
    form.setFieldsValue({
      name: row.name,
      enabled: row.enabled,
      order: row.order ?? 0,
      appliesTo: config.appliesTo || 'case',
      severityIn: config.match?.severityIn || [],
      tagsAny: config.match?.tagsAny || [],
      alertTypeIn: config.match?.alertTypeIn || [],
      sourceIn: config.match?.sourceIn || [],
      templateIn: config.match?.templateIn || [],
      warnPercent: config.warnPercent ?? 80,
      ackAmount: ack.amount,
      ackUnit: ack.unit,
      resAmount: res.amount,
      resUnit: res.unit,
    });
  };

  return (
    <Card
      size="small" title="SLA" style={{ marginBottom: 12 }}
      extra={
        <Space>
          <Button size="small" icon={<ReloadOutlined />} onClick={() => rules.refetch()}>Actualizar</Button>
          {canManage && <Button size="small" type="primary" icon={<PlusOutlined />} onClick={() => openEditor()}>Nueva regla SLA</Button>}
        </Space>
      }
    >
      <Table
        rowKey="id" size="small" pagination={false} loading={rules.isLoading} dataSource={rules.data || []}
        locale={{ emptyText: 'Sin reglas SLA. Crea una para medir acuse y resolución.' }}
        columns={[
          { title: 'Nombre', dataIndex: 'name', render: (value: string, row: any) => <Space><span>{value}</span>{!row.enabled && <Tag>desactivada</Tag>}</Space> },
          { title: 'Aplica a', dataIndex: 'config', width: 100, render: (config: any) => <Tag color="blue">{APPLIES_TO.find((x) => x.value === config?.appliesTo)?.label || config?.appliesTo || '—'}</Tag> },
          { title: 'Coincidencia', dataIndex: 'config', render: (config: any) => <Typography.Text type="secondary">{matchSummary(config?.match)}</Typography.Text> },
          { title: 'Objetivos', dataIndex: 'config', width: 220, render: (config: any) => objectivesSummary(config?.objectives) },
          {
            title: 'Activa', dataIndex: 'enabled', width: 80,
            render: (enabled: boolean, row: any) => <Switch size="small" checked={enabled} disabled={!canManage} onChange={(value) => toggle.mutate({ id: row.id, enabled: value })} />,
          },
          {
            title: '', width: 150, align: 'right' as const,
            render: (_: any, row: any) => canManage && (
              <Space>
                <Button size="small" icon={<EyeOutlined />} loading={runPreview.isPending && runPreview.variables?.id === row.id} onClick={() => runPreview.mutate(row)}>Vista previa</Button>
                <Button size="small" type="text" icon={<EditOutlined />} onClick={() => openEditor(row)} />
                <Popconfirm title="¿Eliminar regla SLA?" onConfirm={() => remove.mutate(row.id)}>
                  <Button size="small" type="text" danger icon={<DeleteOutlined />} />
                </Popconfirm>
              </Space>
            ),
          },
        ]}
      />

      <Modal
        title={editing?.id ? `Editar ${editing.name}` : 'Nueva regla SLA'}
        open={!!editing} onCancel={() => setEditing(null)} onOk={() => form.submit()} confirmLoading={save.isPending}
        width={780}
      >
        <Form form={form} layout="vertical" onFinish={(values) => save.mutate(values)}>
          <Row gutter={12}>
            <Col span={12}><Form.Item name="name" label="Nombre" rules={[{ required: true, message: 'El nombre es obligatorio' }]}><Input placeholder="Casos de alta severidad" /></Form.Item></Col>
            <Col span={6}>
              <Form.Item name="appliesTo" label="Aplica a" rules={[{ required: true }]}>
                <Select options={APPLIES_TO} />
              </Form.Item>
            </Col>
            <Col span={3}><Form.Item name="order" label="Orden"><InputNumber min={0} style={{ width: '100%' }} /></Form.Item></Col>
            <Col span={3}><Form.Item name="enabled" label="Activa" valuePropName="checked"><Switch /></Form.Item></Col>
          </Row>

          <Form.Item noStyle shouldUpdate={(prev, cur) => prev.appliesTo !== cur.appliesTo}>
            {() => {
              const appliesTo = form.getFieldValue('appliesTo');
              return (
                <Card size="small" title="Coincidencia" style={{ marginBottom: 12 }}>
                  <Row gutter={12}>
                    <Col span={8}><Form.Item name="severityIn" label="Severidades"><Select mode="multiple" allowClear options={SEVERITY_OPTIONS} placeholder="Todas" /></Form.Item></Col>
                    <Col span={8}><Form.Item name="tagsAny" label="Tags (alguno)"><Select mode="tags" placeholder="phishing" /></Form.Item></Col>
                    {appliesTo === 'alert' && <Col span={8}><Form.Item name="alertTypeIn" label="Tipos de alerta"><Select mode="tags" placeholder="sla-test" /></Form.Item></Col>}
                    {appliesTo === 'alert' && <Col span={12}><Form.Item name="sourceIn" label="Fuentes"><Select mode="tags" placeholder="Email Gateway" /></Form.Item></Col>}
                    {appliesTo === 'case' && <Col span={12}><Form.Item name="templateIn" label="Plantillas"><Select mode="tags" placeholder="phishing-investigation" /></Form.Item></Col>}
                  </Row>
                </Card>
              );
            }}
          </Form.Item>

          <Card size="small" title="Objetivos" style={{ marginBottom: 12 }}>
            <Row gutter={12}>
              <Col span={9}>
                <Form.Item label="Acuse (primera respuesta)">
                  <Space.Compact style={{ width: '100%' }}>
                    <Form.Item name="ackAmount" noStyle><InputNumber min={0} style={{ width: '60%' }} placeholder="—" /></Form.Item>
                    <Form.Item name="ackUnit" noStyle><Select style={{ width: '40%' }} options={UNIT_OPTIONS} /></Form.Item>
                  </Space.Compact>
                </Form.Item>
              </Col>
              <Col span={9}>
                <Form.Item label="Resolución">
                  <Space.Compact style={{ width: '100%' }}>
                    <Form.Item name="resAmount" noStyle><InputNumber min={0} style={{ width: '60%' }} placeholder="—" /></Form.Item>
                    <Form.Item name="resUnit" noStyle><Select style={{ width: '40%' }} options={UNIT_OPTIONS} /></Form.Item>
                  </Space.Compact>
                </Form.Item>
              </Col>
              <Col span={6}><Form.Item name="warnPercent" label="Aviso al (%)"><InputNumber min={0} max={100} style={{ width: '100%' }} /></Form.Item></Col>
            </Row>
            <Typography.Text type="secondary">Deja un objetivo vacío para no medirlo. El aviso se muestra cuando queda el porcentaje indicado del plazo.</Typography.Text>
          </Card>
        </Form>
      </Modal>

      <Modal
        title={`Vista previa · ${preview?.ruleName || ''}`}
        open={!!preview} onCancel={() => setPreview(null)} footer={<Button onClick={() => setPreview(null)}>Cerrar</Button>}
        width={760}
      >
        {preview && (
          <>
            <Typography.Paragraph>
              <b>{preview.count}</b> objeto(s) abiertos coinciden ahora con esta regla ({APPLIES_TO.find((x) => x.value === preview.appliesTo)?.label}).
            </Typography.Paragraph>
            <Table
              rowKey="objectId" size="small" dataSource={preview.items || []} pagination={{ pageSize: 10 }}
              columns={[
                { title: 'Objeto', render: (_: any, row: any) => `${row.number ? `#${row.number} · ` : ''}${row.title || row.objectId}` },
                { title: 'Estado', dataIndex: 'status', width: 120 },
                { title: 'Acuse', width: 150, render: (_: any, row: any) => objectiveTag(row.acknowledge) },
                { title: 'Resolución', width: 150, render: (_: any, row: any) => objectiveTag(row.resolve) },
              ]}
            />
          </>
        )}
      </Modal>
    </Card>
  );
}

function durationFields(minutes: any) {
  if (minutes === undefined || minutes === null) return { amount: undefined, unit: 'minutes' };
  const value = Number(minutes);
  if (value >= 60 && value % 60 === 0) return { amount: value / 60, unit: 'hours' };
  return { amount: value, unit: 'minutes' };
}

function toMinutes(amount: any, unit: string) {
  if (amount === undefined || amount === null || amount === '') return undefined;
  const value = Number(amount);
  return unit === 'hours' ? value * 60 : value;
}

function buildConfig(values: any) {
  const match: any = {};
  if (Array.isArray(values.severityIn) && values.severityIn.length) match.severityIn = values.severityIn;
  if (Array.isArray(values.tagsAny) && values.tagsAny.length) match.tagsAny = values.tagsAny;
  if (values.appliesTo === 'alert') {
    if (Array.isArray(values.alertTypeIn) && values.alertTypeIn.length) match.alertTypeIn = values.alertTypeIn;
    if (Array.isArray(values.sourceIn) && values.sourceIn.length) match.sourceIn = values.sourceIn;
  }
  if (values.appliesTo === 'case' && Array.isArray(values.templateIn) && values.templateIn.length) match.templateIn = values.templateIn;
  const objectives: any = {};
  const acknowledgeMinutes = toMinutes(values.ackAmount, values.ackUnit);
  const resolveMinutes = toMinutes(values.resAmount, values.resUnit);
  if (acknowledgeMinutes !== undefined) objectives.acknowledgeMinutes = acknowledgeMinutes;
  if (resolveMinutes !== undefined) objectives.resolveMinutes = resolveMinutes;
  return {
    appliesTo: values.appliesTo,
    match,
    objectives,
    warnPercent: values.warnPercent ?? 80,
    businessHours: false,
  };
}

function matchSummary(match: any) {
  if (!match) return 'Todos';
  const parts: string[] = [];
  if (match.severityIn?.length) parts.push(`severidad: ${match.severityIn.map((v: number) => SEVERITY[v]?.label || v).join(', ')}`);
  if (match.tagsAny?.length) parts.push(`tags: ${match.tagsAny.join(', ')}`);
  if (match.alertTypeIn?.length) parts.push(`tipo: ${match.alertTypeIn.join(', ')}`);
  if (match.sourceIn?.length) parts.push(`fuente: ${match.sourceIn.join(', ')}`);
  if (match.templateIn?.length) parts.push(`plantilla: ${match.templateIn.join(', ')}`);
  return parts.length ? parts.join(' · ') : 'Todos';
}

function objectivesSummary(objectives: any) {
  if (!objectives) return '—';
  const parts: string[] = [];
  if (objectives.acknowledgeMinutes !== undefined) parts.push(`Acuse ${durationLabel(objectives.acknowledgeMinutes)}`);
  if (objectives.resolveMinutes !== undefined) parts.push(`Resolución ${durationLabel(objectives.resolveMinutes)}`);
  return parts.length ? parts.join(' · ') : '—';
}

function durationLabel(minutes: number) {
  const value = Number(minutes);
  if (value >= 60 && value % 60 === 0) return `${value / 60} h`;
  return `${value} min`;
}

function objectiveTag(value: any) {
  if (!value) return '—';
  const colour = value.state === 'met' ? 'default' : value.state === 'warning' ? 'orange' : value.state === 'breached' ? 'red' : value.state === 'ok' ? 'green' : 'default';
  return <Tag color={colour} title={date(value.dueAt)}>{value.state}</Tag>;
}
