import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  Button, Card, Col, DatePicker, Descriptions, Drawer, Form, Input, List, Modal, Popconfirm,
  Row, Select, Space, Table, Tag, Typography, Upload, message,
} from 'antd';
import { DeleteOutlined, ExperimentOutlined, EyeOutlined, ImportOutlined, InboxOutlined, MailOutlined, MergeCellsOutlined, PlusOutlined, ReloadOutlined } from '@ant-design/icons';
import { api, errorMessage } from '../lib/api';
import { useAuth } from '../lib/auth';
import { Markdown, SeverityTag, SlaCell, StatusBadge, TlpTag, date, fromNow, slaRank } from '../lib/format';
import { AnalysisSummary, AnalyzeModal, FileObservableCell, FileUploadButton, MispSyncButton, ObservableIntelDrawer, RespondersButton, OBSERVABLE_TYPES, isPending } from '../lib/integrations';
import { FunctionActionsButton } from '../lib/functionActions';

const SEVERITY_OPTIONS = [{ value: 1, label: 'LOW' }, { value: 2, label: 'MEDIUM' }, { value: 3, label: 'HIGH' }, { value: 4, label: 'CRITICAL' }];
const TLP_OPTIONS = [{ value: 0, label: 'WHITE' }, { value: 1, label: 'GREEN' }, { value: 2, label: 'AMBER' }, { value: 3, label: 'RED' }];
const OBS_TYPES = OBSERVABLE_TYPES;

export default function AlertsPage() {
  const navigate = useNavigate();
  const qc = useQueryClient();
  const { can } = useAuth();
  const [createOpen, setCreateOpen] = useState(false);
  const [previewId, setPreviewId] = useState<string | null>(null);
  const [importOpen, setImportOpen] = useState(false);
  const [mergeOpen, setMergeOpen] = useState(false);
  const [emlOpen, setEmlOpen] = useState(false);
  const [emlFiles, setEmlFiles] = useState<any[]>([]);
  const [obsOpen, setObsOpen] = useState(false);
  const [ttpOpen, setTtpOpen] = useState(false);
  const [filters, setFilters] = useState<any>({ page: 0, pageSize: 30, sort: '-date' });
  const [intelObsId, setIntelObsId] = useState<string | null>(null);
  const [analyzeObs, setAnalyzeObs] = useState<any>(null);
  const [createForm] = Form.useForm();
  const [importForm] = Form.useForm();
  const [mergeForm] = Form.useForm();
  const [obsForm] = Form.useForm();
  const [ttpForm] = Form.useForm();

  const alertsQuery = useQuery({
    queryKey: ['alerts', filters],
    queryFn: async () => (await api.get('/alerts', { params: filters })).data,
  });
  const previewQuery = useQuery({
    queryKey: ['alert', previewId],
    queryFn: async () => (await api.get(`/alerts/${previewId}`)).data,
    enabled: !!previewId,
    refetchInterval: (q) => ((q.state.data as any)?.observables || []).some((o: any) => (o.reports || []).some((r: any) => isPending(r.status))) ? 4000 : false,
  });
  const casesQuery = useQuery({ queryKey: ['cases', 'alert-merge'], queryFn: async () => (await api.get('/cases', { params: { pageSize: 100 } })).data });
  const similarQuery = useQuery({
    queryKey: ['alert', previewId, 'similar'],
    queryFn: async () => (await api.get(`/alerts/${previewId}/similar`)).data,
    enabled: !!previewId,
  });
  const templatesQuery = useQuery({ queryKey: ['templates'], queryFn: async () => (await api.get('/templates')).data });

  const createMutation = useMutation({
    mutationFn: async (values: any) => {
      const payload = {
        ...values,
        observables: String(values.observablesText || '').split('\n').map((l) => l.trim()).filter(Boolean).map((data: string) => ({
          dataType: values.dataType || 'ip', data, message: values.observableMessage, tlp: values.tlp, ioc: true,
        })),
        procedures: values.patternId ? [{ patternId: values.patternId, tactic: values.tactic || 'initial-access', description: '' }] : [],
      };
      delete payload.observablesText;
      delete payload.dataType;
      delete payload.observableMessage;
      delete payload.patternId;
      delete payload.tactic;
      return (await api.post('/alerts', payload)).data;
    },
    onSuccess: () => { message.success('Alerta creada'); setCreateOpen(false); createForm.resetFields(); qc.invalidateQueries({ queryKey: ['alerts'] }); },
    onError: (e) => message.error(errorMessage(e)),
  });
  const markMutation = useMutation({
    mutationFn: async ({ id, data }: any) => (await api.post(`/alerts/${id}/read`, data)).data,
    onSuccess: () => { qc.invalidateQueries({ queryKey: ['alerts'] }); qc.invalidateQueries({ queryKey: ['alert', previewId] }); },
    onError: (e) => message.error(errorMessage(e)),
  });
  const addObservable = useMutation({
    mutationFn: async (values: any) => (await api.post(`/alerts/${previewId}/observables`, values)).data,
    onSuccess: () => { message.success('Observable añadido'); setObsOpen(false); obsForm.resetFields(); qc.invalidateQueries({ queryKey: ['alert', previewId] }); qc.invalidateQueries({ queryKey: ['alerts'] }); },
    onError: (e) => message.error(errorMessage(e)),
  });
  const addTtp = useMutation({
    mutationFn: async (values: any) => (await api.post(`/alerts/${previewId}/procedures`, { ...values, occurDate: values.occurDate ? values.occurDate.toISOString() : new Date().toISOString() })).data,
    onSuccess: () => { message.success('TTP añadido'); setTtpOpen(false); ttpForm.resetFields(); qc.invalidateQueries({ queryKey: ['alert', previewId] }); qc.invalidateQueries({ queryKey: ['alerts'] }); },
    onError: (e) => message.error(errorMessage(e)),
  });

  const importEml = useMutation({
    mutationFn: async (files: any[]) => {
      const form = new FormData();
      for (const file of files) form.append('file', file.originFileObj || file, file.name);
      return (await api.post('/alerts/import-eml', form)).data;
    },
    onSuccess: (result) => {
      const errors = Number(result?.errors || 0);
      message.success(`${result?.created ?? 0} alerta(s) creada(s), ${result?.unchanged ?? 0} sin cambios${errors ? ` · ${errors} error(es)` : ''}`);
      setEmlOpen(false);
      setEmlFiles([]);
      qc.invalidateQueries({ queryKey: ['alerts'] });
    },
    onError: (e) => message.error(errorMessage(e)),
  });

  const deleteMutation = useMutation({
    mutationFn: async (id: string) => (await api.delete(`/alerts/${id}`)).data,
    onSuccess: () => { message.success('Alerta eliminada'); setPreviewId(null); qc.invalidateQueries({ queryKey: ['alerts'] }); },
    onError: (e) => message.error(errorMessage(e)),
  });
  const importMutation = useMutation({
    mutationFn: async (values: any) => (await api.post(`/alerts/${previewId}/case`, values)).data,
    onSuccess: (created) => { message.success('Caso creado desde alerta'); setImportOpen(false); setPreviewId(null); navigate(`/cases/${created.id}`); },
    onError: (e) => message.error(errorMessage(e)),
  });
  const mergeMutation = useMutation({
    mutationFn: async (caseId: string) => (await api.post(`/alerts/${previewId}/merge/${caseId}`)).data,
    onSuccess: (created) => {
      message.success('Alerta fusionada');
      setMergeOpen(false);
      setPreviewId(null);
      qc.invalidateQueries({ queryKey: ['alerts'] });
      qc.invalidateQueries({ queryKey: ['alert', previewId] });
      qc.invalidateQueries({ queryKey: ['case', created.id] });
      navigate(`/cases/${created.id}`);
    },
    onError: (e) => message.error(errorMessage(e)),
  });

  const columns = [
    { title: 'Severidad', dataIndex: 'severity', width: 110, render: (v: number) => <SeverityTag value={v} /> },
    { title: 'SLA', width: 230, sorter: (a: any, b: any) => slaRank(a.sla) - slaRank(b.sla), render: (_: any, row: any) => <SlaCell sla={row.sla} /> },
    { title: 'Leída', dataIndex: 'read', width: 75, render: (v: boolean) => v ? <Tag color="green">Leída</Tag> : <Tag>Nueva</Tag> },
    {
      title: 'Título', dataIndex: 'title',
      render: (v: string, row: any) => (
        <div>
          <a onClick={() => { setPreviewId(row.id); if (!row.read) markMutation.mutate({ id: row.id, data: { read: true } }); }} style={{ fontWeight: 700 }}>{v}</a>
          <div style={{ fontSize: 12, color: '#8c8c9a' }}>{row.type} · {row.source} · {row.sourceRef}</div>
        </div>
      ),
    },
    { title: 'Caso', width: 120, render: (_: any, row: any) => row.case ? <a onClick={() => navigate(`/cases/${row.case.id}`)}>#{row.case.number}</a> : <Tag>Sin caso</Tag> },
    { title: 'Observables', width: 110, render: (_: any, row: any) => row._count?.observables ?? 0 },
    {
      title: 'Similares', width: 110,
      render: (_: any, row: any) => (row.similarCaseCount
        ? <Tag color="orange">{row.similarCaseCount} caso(s)</Tag>
        : <Typography.Text type="secondary">—</Typography.Text>),
    },
    { title: 'TTPs', width: 80, render: (_: any, row: any) => row._count?.procedures ?? 0 },
    { title: 'Fecha', dataIndex: 'date', width: 170, render: (v: string) => <div style={{ fontSize: 12 }}>{date(v)}<br /><span style={{ color: '#8c8c9a' }}>{fromNow(v)}</span></div> },
    {
      title: '', width: 180, align: 'right' as const,
      render: (_: any, row: any) => (
        <Space>
          <Button size="small" icon={<EyeOutlined />} onClick={() => setPreviewId(row.id)} />
          {can('manageAlert/import') && !row.case && <Button size="small" type="primary" ghost icon={<ImportOutlined />} onClick={() => { setPreviewId(row.id); setImportOpen(true); }} />}
          {can('manageAlert/delete') && (
            <Popconfirm title="¿Eliminar alerta?" onConfirm={() => deleteMutation.mutate(row.id)}>
              <Button size="small" danger type="text" icon={<DeleteOutlined />} />
            </Popconfirm>
          )}
        </Space>
      ),
    },
  ];

  const alert = previewQuery.data;

  return (
    <div>
      <div className="page-header">
        <div>
          <h1 className="page-title">Alertas</h1>
          <span style={{ color: '#8c8c9a' }}>{alertsQuery.data?.total ?? 0} alertas</span>
        </div>
        <Space>
          {can('manageAlert/create') && <MispSyncButton onDone={() => qc.invalidateQueries({ queryKey: ['alerts'] })} />}
          {can('manageAlert/create') && <Button icon={<MailOutlined />} onClick={() => setEmlOpen(true)}>Importar .eml</Button>}
          {can('manageAlert/create') && <Button type="primary" icon={<PlusOutlined />} onClick={() => setCreateOpen(true)}>Nueva alerta</Button>}
          <Button icon={<ReloadOutlined />} onClick={() => alertsQuery.refetch()}>Actualizar</Button>
        </Space>
      </div>

      <Card size="small" style={{ marginBottom: 12 }}>
        <Space wrap>
          <Select allowClear placeholder="Estado" style={{ width: 150 }} options={['New', 'InProgress', 'Imported', 'Closed'].map((v) => ({ value: v, label: v }))}
            onChange={(v) => setFilters((f: any) => ({ ...f, stage: v, page: 0 }))} />
          <Select allowClear placeholder="Severidad" style={{ width: 140 }} options={SEVERITY_OPTIONS}
            onChange={(v) => setFilters((f: any) => ({ ...f, severity: v, page: 0 }))} />
          <Select allowClear placeholder="Leída" style={{ width: 130 }} options={[{ value: 'false', label: 'No leídas' }, { value: 'true', label: 'Leídas' }]}
            onChange={(v) => setFilters((f: any) => ({ ...f, read: v, page: 0 }))} />
          <Input.Search placeholder="Buscar alertas" allowClear style={{ width: 320 }} onSearch={(v) => setFilters((f: any) => ({ ...f, search: v || undefined, page: 0 }))} />
        </Space>
      </Card>

      <Card size="small" styles={{ body: { padding: 0 } }}>
        <Table
          rowKey="id" loading={alertsQuery.isLoading} dataSource={alertsQuery.data?.items || []} columns={columns as any}
          pagination={{
            current: (filters.page || 0) + 1, pageSize: filters.pageSize, total: alertsQuery.data?.total || 0,
            showSizeChanger: true, onChange: (page, pageSize) => setFilters((f: any) => ({ ...f, page: page - 1, pageSize })),
          }}
        />
      </Card>

      <Drawer title="Nueva alerta" width={700} open={createOpen} onClose={() => setCreateOpen(false)}
        extra={<Button type="primary" loading={createMutation.isPending} onClick={() => createForm.submit()}>Crear</Button>}>
        <Form form={createForm} layout="vertical" initialValues={{ severity: 2, tlp: 2, pap: 2, status: 'New', dataType: 'ip', ioc: true }} onFinish={(values) => createMutation.mutate(values)}>
          <Row gutter={12}>
            <Col span={12}><Form.Item name="type" label="Tipo" rules={[{ required: true }]}><Input placeholder="external" /></Form.Item></Col>
            <Col span={12}><Form.Item name="source" label="Fuente" rules={[{ required: true }]}><Input placeholder="Email Gateway" /></Form.Item></Col>
          </Row>
          <Row gutter={12}>
            <Col span={12}><Form.Item name="sourceRef" label="Referencia" rules={[{ required: true }]}><Input placeholder="MSG-2026-..." /></Form.Item></Col>
            <Col span={12}><Form.Item name="externalLink" label="Enlace externo"><Input /></Form.Item></Col>
          </Row>
          <Form.Item name="title" label="Título" rules={[{ required: true }]}><Input /></Form.Item>
          <Form.Item name="description" label="Descripción" rules={[{ required: true }]}><Input.TextArea rows={4} /></Form.Item>
          <Row gutter={12}>
            <Col span={8}><Form.Item name="severity" label="Severidad"><Select options={SEVERITY_OPTIONS} /></Form.Item></Col>
            <Col span={8}><Form.Item name="tlp" label="TLP"><Select options={TLP_OPTIONS} /></Form.Item></Col>
            <Col span={8}><Form.Item name="pap" label="PAP"><Select options={TLP_OPTIONS} /></Form.Item></Col>
          </Row>
          <Form.Item name="tags" label="Tags"><Select mode="tags" /></Form.Item>
          <Typography.Title level={5}>Observables</Typography.Title>
          <Row gutter={12}>
            <Col span={8}><Form.Item name="dataType" label="Tipo"><Select options={OBS_TYPES.map((v) => ({ value: v, label: v }))} /></Form.Item></Col>
            <Col span={16}><Form.Item name="observableMessage" label="Mensaje"><Input /></Form.Item></Col>
          </Row>
          <Form.Item name="observablesText" label="Valores (uno por línea)"><Input.TextArea rows={4} /></Form.Item>
          <Typography.Title level={5}>TTP</Typography.Title>
          <Row gutter={12}>
            <Col span={12}><Form.Item name="patternId" label="Técnica"><Input placeholder="T1566" /></Form.Item></Col>
            <Col span={12}><Form.Item name="tactic" label="Táctica"><Input placeholder="initial-access" /></Form.Item></Col>
          </Row>
        </Form>
      </Drawer>

      <Drawer title="Alerta" width={760} open={!!previewId} onClose={() => setPreviewId(null)} destroyOnClose>
        {alert && (
          <div>
            <Typography.Title level={4} style={{ margin: 0, whiteSpace: 'normal' }}>{alert.title}</Typography.Title>
            <Space wrap style={{ marginTop: 10, marginBottom: 16 }}>
              {can('manageAlert/update') && <Button onClick={() => markMutation.mutate({ id: alert.id, data: { read: !alert.read } })}>{alert.read ? 'Marcar no leída' : 'Marcar leída'}</Button>}
              {can('manageAlert/update') && <Button onClick={() => markMutation.mutate({ id: alert.id, data: { follow: !alert.follow } })}>{alert.follow ? 'Dejar de seguir' : 'Seguir'}</Button>}
              {can('manageAlert/import') && !alert.case && <Button type="primary" icon={<ImportOutlined />} onClick={() => setImportOpen(true)}>Importar a caso</Button>}
              {can('manageAlert/import') && !alert.case && <Button icon={<MergeCellsOutlined />} onClick={() => setMergeOpen(true)}>Merge a caso</Button>}
              <RespondersButton target="alert" objectId={alert.id} />
              <FunctionActionsButton target="alert" objectId={alert.id} onDone={() => qc.invalidateQueries()} />
            </Space>
            <Descriptions column={2} size="small" bordered style={{ marginBottom: 16 }}>
              <Descriptions.Item label="Severidad"><SeverityTag value={alert.severity} /></Descriptions.Item>
              <Descriptions.Item label="Estado"><StatusBadge value={alert.status?.value || alert.stage} stage={alert.stage} colour={alert.status?.colour} /></Descriptions.Item>
              <Descriptions.Item label="TLP / PAP"><Space><TlpTag value={alert.tlp} prefix="TLP" /><TlpTag value={alert.pap} prefix="PAP" /></Space></Descriptions.Item>
              <Descriptions.Item label="Leída">{alert.read ? 'Sí' : 'No'}</Descriptions.Item>
              <Descriptions.Item label="Tipo">{alert.type}</Descriptions.Item>
              <Descriptions.Item label="Fuente">{alert.source}</Descriptions.Item>
              <Descriptions.Item label="Referencia">{alert.sourceRef}</Descriptions.Item>
              <Descriptions.Item label="Fecha">{date(alert.date)}</Descriptions.Item>
              <Descriptions.Item label="Caso">{alert.case ? <a onClick={() => navigate(`/cases/${alert.case.id}`)}>#{alert.case.number} {alert.case.title}</a> : 'Sin caso'}</Descriptions.Item>
            </Descriptions>
            {can('manageAlert/update') && (
              <Space style={{ marginBottom: 12 }} wrap>
                <Button size="small" onClick={async () => { await api.patch(`/alerts/${alert.id}`, { status: 'InProgress' }); qc.invalidateQueries({ queryKey: ['alert', previewId] }); qc.invalidateQueries({ queryKey: ['alerts'] }); }}>En progreso</Button>
                <Button size="small" onClick={async () => { await api.patch(`/alerts/${alert.id}`, { status: 'Ignored' }); qc.invalidateQueries({ queryKey: ['alert', previewId] }); qc.invalidateQueries({ queryKey: ['alerts'] }); }}>Ignorar</Button>
                <Button size="small" danger onClick={async () => { await api.patch(`/alerts/${alert.id}`, { status: 'FalsePositive' }); qc.invalidateQueries({ queryKey: ['alert', previewId] }); qc.invalidateQueries({ queryKey: ['alerts'] }); }}>Falso positivo</Button>
                <Button size="small" onClick={async () => { await api.patch(`/alerts/${alert.id}`, { status: 'New' }); qc.invalidateQueries({ queryKey: ['alert', previewId] }); qc.invalidateQueries({ queryKey: ['alerts'] }); }}>Reabrir</Button>
              </Space>
            )}
            <Markdown>{alert.description}</Markdown>
            {alert.externalLink && <div style={{ margin: '8px 0' }}><a href={alert.externalLink} target="_blank" rel="noreferrer">{alert.externalLink}</a></div>}
            {(alert.tags || []).map((t: string) => <Tag key={t} color="cyan">{t}</Tag>)}
            <Typography.Title level={5} style={{ marginTop: 18 }}>Casos similares</Typography.Title>
            {similarQuery.isLoading ? null : !(similarQuery.data?.cases || []).length ? (
              <Typography.Text type="secondary">Ningún caso comparte observables con esta alerta.</Typography.Text>
            ) : (
              <List
                size="small"
                dataSource={similarQuery.data.cases}
                renderItem={(item: any) => (
                  <List.Item style={{ display: 'block' }}>
                    <Space wrap size={6}>
                      <a onClick={() => navigate(`/cases/${item.case.id}`)} style={{ fontWeight: 600 }}>
                        #{item.case.number} {item.case.title}
                      </a>
                      <StatusBadge value={item.case.status} stage={item.case.stage} />
                      {item.case.closed && <Tag color="default">Cerrado</Tag>}
                      <Tag color="cyan">{item.sharedCount}/{item.observableCount} observables</Tag>
                      {can('manageAlert/import') && !alert.case && (
                        <Button
                          size="small" type="primary" ghost loading={mergeMutation.isPending}
                          onClick={() => mergeMutation.mutate(item.case.id)}
                        >
                          Fusionar en este caso
                        </Button>
                      )}
                    </Space>
                    <div style={{ marginTop: 4 }}>
                      {(item.sharedObservables || []).map((observable: any) => (
                        <Tag key={`${observable.dataType}:${observable.data}`} color={observable.ioc ? 'red' : undefined}>
                          {observable.dataType}: {observable.data}
                        </Tag>
                      ))}
                    </div>
                  </List.Item>
                )}
              />
            )}
            <Typography.Title level={5} style={{ marginTop: 18 }}>Alertas similares</Typography.Title>
            {similarQuery.isLoading ? null : !(similarQuery.data?.alerts || []).length ? (
              <Typography.Text type="secondary">Ninguna alerta comparte observables con esta alerta.</Typography.Text>
            ) : (
              <List
                size="small"
                dataSource={similarQuery.data.alerts}
                renderItem={(item: any) => (
                  <List.Item>
                    <Space wrap size={6}>
                      <span style={{ fontWeight: 600 }}>{item.alert.title}</span>
                      <Tag>{item.alert.type} · {item.alert.source}</Tag>
                      <Tag color={item.alert.stage === 'Closed' ? 'default' : 'blue'}>{item.alert.stage}</Tag>
                      <Tag color="cyan">{item.sharedCount}/{item.observableCount} observables</Tag>
                    </Space>
                  </List.Item>
                )}
              />
            )}
            <Typography.Title level={5} style={{ marginTop: 18 }}>
              Observables
              <Space size={8} style={{ marginLeft: 8 }}>
                <Button size="small" type="link" onClick={() => setObsOpen(true)}>+ Añadir</Button>
                <FileUploadButton endpoint={`/alerts/${previewId}/observables/file`} onDone={() => { qc.invalidateQueries({ queryKey: ['alert', previewId] }); qc.invalidateQueries({ queryKey: ['alerts'] }); }} />
              </Space>
            </Typography.Title>
            <Table rowKey="id" size="small" pagination={false} dataSource={alert.observables || []}
              columns={[
                { title: 'Tipo', dataIndex: 'dataType', width: 100 },
                {
                  title: 'Valor', dataIndex: 'data',
                  render: (v: string, o: any) => o.dataType === 'file'
                    ? <FileObservableCell observable={o} onOpen={() => setIntelObsId(o.id)} />
                    : <a style={{ fontFamily: 'monospace' }} onClick={() => setIntelObsId(o.id)}>{v}</a>,
                },
                { title: 'Mensaje', dataIndex: 'message' },
                { title: 'IOC', dataIndex: 'ioc', width: 60, render: (v: boolean) => v ? 'Sí' : 'No' },
                { title: 'Análisis', width: 220, render: (_: any, o: any) => <AnalysisSummary reports={o.reports} /> },
                {
                  title: '', width: 50,
                  render: (_: any, o: any) => can('manageAnalyse') && <Button size="small" type="text" icon={<ExperimentOutlined />} onClick={() => setAnalyzeObs(o)} />,
                },
              ]} />
            <Typography.Title level={5} style={{ marginTop: 18 }}>TTPs <Button size="small" type="link" onClick={() => setTtpOpen(true)}>+ Añadir</Button></Typography.Title>
            <Table rowKey="id" size="small" pagination={false} dataSource={alert.procedures || []}
              columns={[
                {
                  title: 'Técnica',
                  render: (_: any, r: any) => (
                    <span>
                      <a href={`https://attack.mitre.org/techniques/${String(r.patternId).replace(/\./g, '/')}/`} target="_blank" rel="noreferrer"><b>{r.patternId}</b></a>
                      {' · '}{r.patternName || ''}
                    </span>
                  ),
                },
                { title: 'Táctica', dataIndex: 'tactic', render: (v: string) => v ? <Tag>{v}</Tag> : '—' },
                { title: 'Fecha', dataIndex: 'occurDate', render: (v: string) => date(v) },
              ]} />
          </div>
        )}
      </Drawer>

      <ObservableIntelDrawer
        observable={(alert?.observables || []).find((o: any) => o.id === intelObsId) || null}
        onClose={() => setIntelObsId(null)}
        onChanged={() => qc.invalidateQueries({ queryKey: ['alert', previewId] })}
      />
      <AnalyzeModal observable={analyzeObs} open={!!analyzeObs} onClose={() => setAnalyzeObs(null)} onDone={() => qc.invalidateQueries({ queryKey: ['alert', previewId] })} />

      <Modal title="Importar alerta a un caso nuevo" open={importOpen} onCancel={() => setImportOpen(false)} onOk={() => importForm.submit()} confirmLoading={importMutation.isPending}>
        <Form form={importForm} layout="vertical" onFinish={(values) => importMutation.mutate(values)}>
          <Form.Item name="title" label="Título del caso"><Input placeholder={alert?.title} /></Form.Item>
          <Form.Item name="caseTemplate" label="Plantilla">
            <Select allowClear options={(templatesQuery.data || []).map((t: any) => ({ value: t.name, label: t.displayName || t.name }))} />
          </Form.Item>
          <Typography.Paragraph type="secondary">Los observables y TTPs se moverán al caso nuevo.</Typography.Paragraph>
        </Form>
      </Modal>

      <Modal title="Añadir observable a la alerta" open={obsOpen} onCancel={() => setObsOpen(false)} onOk={() => obsForm.submit()} confirmLoading={addObservable.isPending}>
        <Form form={obsForm} layout="vertical" initialValues={{ dataType: 'ip', tlp: 2, ioc: true }} onFinish={(v) => addObservable.mutate(v)}>
          <Row gutter={12}>
            <Col span={8}><Form.Item name="dataType" label="Tipo"><Select options={OBS_TYPES.map((v) => ({ value: v, label: v }))} /></Form.Item></Col>
            <Col span={8}><Form.Item name="tlp" label="TLP"><Select options={TLP_OPTIONS} /></Form.Item></Col>
            <Col span={8}><Form.Item name="ioc" label="IOC" valuePropName="checked"><input type="checkbox" /></Form.Item></Col>
          </Row>
          <Form.Item name="data" label="Valor" rules={[{ required: true }]}><Input /></Form.Item>
          <Form.Item name="message" label="Mensaje"><Input /></Form.Item>
          <Form.Item name="tags" label="Tags"><Select mode="tags" /></Form.Item>
        </Form>
      </Modal>

      <Modal title="Añadir TTP a la alerta" open={ttpOpen} onCancel={() => setTtpOpen(false)} onOk={() => ttpForm.submit()} confirmLoading={addTtp.isPending}>
        <Form form={ttpForm} layout="vertical" initialValues={{ tactic: 'initial-access' }} onFinish={(v) => addTtp.mutate(v)}>
          <Form.Item name="patternId" label="Técnica" rules={[{ required: true }]}><Input placeholder="T1566" /></Form.Item>
          <Form.Item name="tactic" label="Táctica"><Input /></Form.Item>
          <Form.Item name="occurDate" label="Fecha"><DatePicker showTime style={{ width: '100%' }} /></Form.Item>
          <Form.Item name="description" label="Procedimiento"><Input.TextArea rows={3} /></Form.Item>
        </Form>
      </Modal>

      <Modal
        title="Importar correos .eml"
        open={emlOpen}
        onCancel={() => { setEmlOpen(false); setEmlFiles([]); }}
        onOk={() => {
          if (!emlFiles.length) { message.warning('Selecciona al menos un fichero .eml'); return; }
          importEml.mutate(emlFiles);
        }}
        confirmLoading={importEml.isPending}
        okText="Importar"
      >
        <Upload.Dragger
          multiple
          accept=".eml,message/rfc822"
          beforeUpload={() => false}
          fileList={emlFiles}
          onChange={({ fileList }) => setEmlFiles(fileList)}
        >
          <p className="ant-upload-drag-icon"><InboxOutlined /></p>
          <p className="ant-upload-text">Arrastra aquí los correos .eml o haz clic para seleccionarlos</p>
          <p className="ant-upload-hint">Cada fichero genera una alerta de tipo email. Los reenvíos con el correo sospechoso adjunto se analizan sobre el mensaje interno.</p>
        </Upload.Dragger>
      </Modal>

      <Modal title="Fusionar alerta en un caso existente" open={mergeOpen} onCancel={() => setMergeOpen(false)} onOk={() => mergeForm.submit()} confirmLoading={mergeMutation.isPending}>
        <Form form={mergeForm} layout="vertical" onFinish={(values) => mergeMutation.mutate(values.caseId)}>
          <Form.Item name="caseId" label="Caso" rules={[{ required: true }]}>
            <Select options={(casesQuery.data?.items || []).map((c: any) => ({ value: c.id, label: `#${c.number} · ${c.title}` }))} />
          </Form.Item>
        </Form>
      </Modal>
    </div>
  );
}
