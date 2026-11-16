import { useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  Alert, Badge, Button, Checkbox, Collapse, Descriptions, Drawer, Dropdown, Empty, Form, Input, List, Modal, Popover, Select, Space, Spin, Table, Tag, Tooltip, Typography, Upload, message,
} from 'antd';
import {
  CloudUploadOutlined, DownloadOutlined, ExperimentOutlined, FileAddOutlined, InboxOutlined, LoadingOutlined, SearchOutlined, ThunderboltOutlined, HistoryOutlined, SyncOutlined,
} from '@ant-design/icons';
import { api, errorMessage } from './api';
import { date } from './format';

export const OBSERVABLE_TYPES = [
  'ip', 'domain', 'fqdn', 'url', 'mail', 'mail_subject', 'hash', 'filename', 'registry',
  'user-agent', 'uri_path', 'autonomous-system', 'other',
];

const LEVEL_COLOUR: Record<string, string> = { info: 'blue', safe: 'green', suspicious: 'orange', malicious: 'red' };

export function formatBytes(value?: number) {
  const bytes = Number(value || 0);
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

export function attachmentSha256(observable: any): string | undefined {
  const hashes = observable?.attachment?.hashes || [];
  const found = hashes.find((h: any) => /256/i.test(String(h.algorithm || '')));
  return found?.hash || observable?.attachment?.sha256;
}

export async function downloadObservableFile(observable: any) {
  const res = await api.get(`/observables/${observable.id}/download`, { params: { zip: 1 }, responseType: 'blob' });
  const url = URL.createObjectURL(res.data);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = `${String(observable.data || 'observable').replace(/[^a-zA-Z0-9._-]/g, '_')}.zip`;
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  URL.revokeObjectURL(url);
}

export function FileObservableCell({ observable, onOpen }: { observable: any; onOpen?: () => void }) {
  const attachment = observable?.attachment;
  const sha256 = attachmentSha256(observable);
  return (
    <Space direction="vertical" size={2}>
      <a style={{ fontFamily: 'monospace', wordBreak: 'break-all' }} onClick={onOpen} title="Ver análisis e inteligencia">{observable.data}</a>
      {attachment && (
        <Space size={8} wrap>
          <Typography.Text type="secondary" style={{ fontSize: 12 }}>{formatBytes(attachment.size)}</Typography.Text>
          {sha256 && (
            <Typography.Text copyable={{ text: sha256 }} style={{ fontFamily: 'monospace', fontSize: 12 }}>
              {sha256.slice(0, 16)}…
            </Typography.Text>
          )}
          <Button
            size="small"
            type="link"
            icon={<DownloadOutlined />}
            onClick={(event) => {
              event.stopPropagation();
              downloadObservableFile(observable).catch((e) => message.error(errorMessage(e)));
            }}
          >
            Descargar
          </Button>
        </Space>
      )}
    </Space>
  );
}

/** Drag & drop uploader that creates file observables (+ hashes) on a case or alert. */
export function FileUploadButton({ endpoint, onDone }: { endpoint: string; onDone?: () => void }) {
  const [open, setOpen] = useState(false);
  const [files, setFiles] = useState<any[]>([]);
  const [form] = Form.useForm();
  const upload = useMutation({
    mutationFn: async (values: any) => {
      const formData = new FormData();
      for (const file of files) formData.append('file', file);
      formData.append('message', values.message || '');
      formData.append('tlp', String(values.tlp ?? 2));
      formData.append('pap', String(values.pap ?? 2));
      formData.append('ioc', String(!!values.ioc));
      formData.append('addHashes', String(values.addHashes !== false));
      if (values.tags?.length) formData.append('tags', JSON.stringify(values.tags));
      return (await api.post(endpoint, formData)).data;
    },
    onSuccess: (res: any) => {
      message.success(`${res.files?.length || 0} fichero(s) añadido(s)`);
      setOpen(false);
      setFiles([]);
      form.resetFields();
      onDone?.();
    },
    onError: (e) => message.error(errorMessage(e)),
  });
  return (
    <>
      <Button size="small" icon={<FileAddOutlined />} onClick={() => setOpen(true)}>Añadir fichero</Button>
      <Modal
        title="Añadir fichero como observable"
        open={open}
        onCancel={() => setOpen(false)}
        onOk={() => form.submit()}
        okText="Subir"
        confirmLoading={upload.isPending}
        width={620}
      >
        <Upload.Dragger
          multiple
          fileList={files}
          beforeUpload={(file) => { setFiles((current) => [...current, file]); return false; }}
          onRemove={(file) => setFiles((current) => current.filter((item) => item.uid !== file.uid))}
        >
          <p className="ant-upload-drag-icon"><InboxOutlined /></p>
          <p className="ant-upload-text">Arrastra ficheros aquí o haz clic para seleccionarlos</p>
          <p className="ant-upload-hint">Se calculan md5, sha1 y sha256; los hashes se añaden como observables.</p>
        </Upload.Dragger>
        <Form form={form} layout="vertical" initialValues={{ tlp: 2, pap: 2, ioc: false, addHashes: true }} onFinish={(values) => {
          if (!files.length) { message.warning('Selecciona al menos un fichero'); return; }
          upload.mutate(values);
        }} style={{ marginTop: 16 }}>
          <Form.Item name="message" label="Mensaje"><Input placeholder="Contexto del fichero" /></Form.Item>
          <Space size={12} wrap>
            <Form.Item name="tlp" label="TLP"><Select style={{ width: 110 }} options={[0, 1, 2, 3].map((v) => ({ value: v, label: String(v) }))} /></Form.Item>
            <Form.Item name="pap" label="PAP"><Select style={{ width: 110 }} options={[0, 1, 2, 3].map((v) => ({ value: v, label: String(v) }))} /></Form.Item>
            <Form.Item name="ioc" label="IOC" valuePropName="checked"><Checkbox /></Form.Item>
            <Form.Item name="addHashes" label="Añadir hashes" valuePropName="checked"><Checkbox /></Form.Item>
          </Space>
          <Form.Item name="tags" label="Tags"><Select mode="tags" /></Form.Item>
        </Form>
      </Modal>
    </>
  );
}
const PENDING = ['Waiting', 'InProgress'];
export const isPending = (status?: string) => PENDING.includes(status || '');

export function TaxonomyTags({ taxonomies }: { taxonomies?: any[] }) {
  if (!taxonomies?.length) return null;
  return (
    <Space size={[4, 4]} wrap>
      {taxonomies.map((t: any, i: number) => (
        <Tag key={i} color={LEVEL_COLOUR[t.level] || 'default'} style={{ margin: 0 }}>
          {t.namespace}:{t.predicate}=&quot;{String(t.value)}&quot;
        </Tag>
      ))}
    </Space>
  );
}

export function ReportStatus({ status }: { status: string }) {
  if (isPending(status)) return <Tag icon={<LoadingOutlined />} color="processing">{status}</Tag>;
  return <Tag color={status === 'Success' ? 'success' : 'error'}>{status}</Tag>;
}

function stageColour(stage?: string) {
  if (stage === 'Closed') return 'default';
  if (stage === 'InProgress') return 'orange';
  return 'blue';
}

export function SightingsList({ observable }: { observable: any }) {
  const navigate = useNavigate();
  const sightings = useQuery({
    queryKey: ['observable-sightings', observable?.id],
    queryFn: async () => (await api.get(`/observables/${observable.id}/sightings`)).data,
    enabled: !!observable?.id,
  });

  if (sightings.isLoading) return <Spin size="small" />;
  const items = sightings.data || [];
  if (!items.length) return <Typography.Text type="secondary">Todavía no aparece en otros casos ni alertas.</Typography.Text>;

  return (
    <List
      size="small"
      dataSource={items}
      style={{ minWidth: 320, maxWidth: 560 }}
      renderItem={(item: any) => (
        <List.Item style={{ padding: '6px 0' }}>
          <Space direction="vertical" size={2} style={{ width: '100%' }}>
            <Space wrap size={6}>
              <Tag color={item.kind === 'case' ? 'blue' : 'orange'} style={{ margin: 0 }}>{item.kind === 'case' ? 'Caso' : 'Alerta'}</Tag>
              {item.kind === 'case' ? (
                <a onClick={() => navigate(`/cases/${item.id}`)}>#{item.number} {item.title}</a>
              ) : (
                <span>{item.title}</span>
              )}
              <Tag color={stageColour(item.stage)} style={{ margin: 0 }}>{item.stage}</Tag>
              {item.ioc && <Tag color="red" style={{ margin: 0 }}>IOC</Tag>}
              {item.sighted && <Tag color="green" style={{ margin: 0 }}>Sighted</Tag>}
            </Space>
            <Typography.Text type="secondary" style={{ fontSize: 12 }}>{date(item.date)}</Typography.Text>
          </Space>
        </List.Item>
      )}
    />
  );
}

export function SightingsPopover({ observable, compact }: { observable: any; compact?: boolean }) {
  const count = observable?.seenCount || 0;
  if (compact) {
    return (
      <Popover title="Visto en" trigger="click" content={<SightingsList observable={observable} />}>
        <Badge
          count={count}
          showZero
          size="small"
          color={count ? '#4a90e2' : '#d9d9d9'}
          style={{ cursor: 'pointer' }}
        />
      </Popover>
    );
  }
  return (
    <Popover title="Visto en" trigger="click" content={<SightingsList observable={observable} />}>
      <Badge count={count} showZero size="small" color={count ? '#4a90e2' : '#d9d9d9'}>
        <a style={{ fontSize: 12 }}>Visto en</a>
      </Badge>
    </Popover>
  );
}

/** Latest report per analyzer, as returned inside case.observables[].reports */
export function AnalysisSummary({ reports }: { reports?: any[] }) {
  const latest = useMemo(() => {
    const byAnalyzer = new Map<string, any>();
    for (const r of reports || []) if (!byAnalyzer.has(r.analyzer)) byAnalyzer.set(r.analyzer, r);
    return [...byAnalyzer.values()];
  }, [reports]);
  if (!latest.length) return <Typography.Text type="secondary">—</Typography.Text>;
  return (
    <Space size={[4, 4]} wrap>
      {latest.map((r) =>
        isPending(r.status) ? (
          <Tag key={r.id} icon={<LoadingOutlined />} color="processing">{r.analyzer}</Tag>
        ) : r.status !== 'Success' ? (
          <Tooltip key={r.id} title={`${r.analyzer}: fallo`}><Tag color="error">{r.analyzer}</Tag></Tooltip>
        ) : (r.taxonomies || []).length ? (
          <TaxonomyTags key={r.id} taxonomies={r.taxonomies} />
        ) : (
          <Tag key={r.id}>{r.analyzer}: sin resultados</Tag>
        ),
      )}
    </Space>
  );
}

// ------------------------------------------------------------------ analyzers

export function AnalyzeModal({ observable, open, onClose, onDone }: { observable: any; open: boolean; onClose: () => void; onDone?: () => void }) {
  const [selected, setSelected] = useState<string[]>([]);
  const analyzers = useQuery({
    queryKey: ['cortex-analyzers', observable?.dataType],
    queryFn: async () => (await api.get('/cortex/analyzers', { params: { dataType: observable.dataType } })).data,
    enabled: open && !!observable,
  });
  const run = useMutation({
    mutationFn: async () =>
      (await api.post(`/observables/${observable.id}/analyze`, {
        analyzers: selected.map((key) => {
          const [connectorId, analyzerId] = key.split('::');
          return { connectorId, analyzerId };
        }),
      })).data,
    onSuccess: (res) => {
      message.success(`${res.reports.length} análisis lanzado(s)${res.errors?.length ? `, ${res.errors.length} con error` : ''}`);
      setSelected([]);
      onDone?.();
      onClose();
    },
    onError: (e) => message.error(errorMessage(e)),
  });
  const list = analyzers.data?.analyzers || [];
  return (
    <Modal
      title={<span><ExperimentOutlined /> Analizar {observable?.dataType}: <code>{observable?.data}</code></span>}
      open={open}
      onCancel={onClose}
      onOk={() => run.mutate()}
      okText="Ejecutar"
      okButtonProps={{ disabled: !selected.length }}
      confirmLoading={run.isPending}
      width={640}
    >
      {analyzers.isLoading ? <Spin /> : (
        <>
          {analyzers.data?.servers === 0 && <Alert type="warning" showIcon message="No hay ningún servidor Cortex configurado (Administración → Cortex & MISP)." />}
          {(analyzers.data?.errors || []).map((e: any) => <Alert key={e.connectorId} type="error" showIcon style={{ marginBottom: 8 }} message={`${e.connectorName}: ${e.error}`} />)}
          {analyzers.data?.servers > 0 && !list.length && <Empty description={`Ningún analizador habilitado acepta el tipo "${observable?.dataType}"`} />}
          {list.length > 0 && (
            <>
              <Space style={{ marginBottom: 8 }}>
                <Button size="small" onClick={() => setSelected(list.map((a: any) => `${a.connectorId}::${a.id}`))}>Todos</Button>
                <Button size="small" onClick={() => setSelected([])}>Ninguno</Button>
              </Space>
              <Checkbox.Group value={selected} onChange={(v) => setSelected(v as string[])} style={{ width: '100%' }}>
                <Space direction="vertical" style={{ width: '100%' }}>
                  {list.map((a: any) => (
                    <Checkbox key={`${a.connectorId}::${a.id}`} value={`${a.connectorId}::${a.id}`}>
                      <b>{a.name}</b> <Typography.Text type="secondary">v{a.version} · {a.connectorName}</Typography.Text>
                      <div style={{ fontSize: 12, color: '#8c8c9a' }}>{a.description}</div>
                    </Checkbox>
                  ))}
                </Space>
              </Checkbox.Group>
            </>
          )}
        </>
      )}
    </Modal>
  );
}

/** Drawer with every Cortex report of an observable + MISP lookup. */
export function ObservableIntelDrawer({ observable, onClose, onChanged }: { observable: any | null; onClose: () => void; onChanged?: () => void }) {
  const qc = useQueryClient();
  const [analyzeOpen, setAnalyzeOpen] = useState(false);
  const reports = useQuery({
    queryKey: ['observable-reports', observable?.id],
    queryFn: async () => (await api.get(`/observables/${observable.id}/reports`)).data,
    enabled: !!observable,
    refetchInterval: (q) => ((q.state.data as any[]) || []).some((r) => isPending(r.status)) ? 3000 : false,
  });
  const misp = useMutation({
    mutationFn: async () => (await api.post(`/observables/${observable.id}/misp-search`, {})).data,
    onSuccess: (res) => { if (res.total) onChanged?.(); },
    onError: (e) => message.error(errorMessage(e)),
  });
  const importArtifacts = useMutation({
    mutationFn: async ({ reportId, indexes }: { reportId: string; indexes?: number[] }) =>
      (await api.post(`/observables/${observable.id}/reports/${reportId}/artifacts`, { indexes })).data,
    onSuccess: (res) => { message.success(`${res.created} observable(s) importado(s), ${res.skipped} omitido(s)`); onChanged?.(); },
    onError: (e) => message.error(errorMessage(e)),
  });

  const refresh = () => {
    qc.invalidateQueries({ queryKey: ['observable-reports', observable?.id] });
    onChanged?.();
  };

  return (
    <Drawer
      title={observable ? <span><Tag color="blue">{observable.dataType}</Tag><code>{observable.data}</code></span> : 'Observable'}
      open={!!observable}
      onClose={onClose}
      width={820}
      destroyOnClose
      extra={observable && (
        <Space>
          <Button icon={<ExperimentOutlined />} type="primary" onClick={() => setAnalyzeOpen(true)}>Analizar con Cortex</Button>
          <Button icon={<SearchOutlined />} loading={misp.isPending} onClick={() => misp.mutate()}>Buscar en MISP</Button>
        </Space>
      )}
    >
      {observable && (
        <>
          {misp.data && (
            <div style={{ marginBottom: 16 }}>
              <Typography.Title level={5}>MISP: {misp.data.total} coincidencia(s)</Typography.Title>
              {misp.data.results.map((r: any) => (
                <div key={r.connectorId} style={{ marginBottom: 8 }}>
                  {r.error && <Alert type="error" showIcon message={`${r.connectorName}: ${r.error}`} />}
                  {r.hits.length > 0 && (
                    <Table
                      size="small" rowKey={(h: any) => `${h.eventId}-${h.type}-${h.value}`} pagination={false} dataSource={r.hits}
                      columns={[
                        { title: 'Evento', render: (_: any, h: any) => <a href={h.url} target="_blank" rel="noreferrer">#{h.eventId} {h.eventInfo}</a> },
                        { title: 'Org', dataIndex: 'org', width: 120 },
                        { title: 'Tipo', render: (_: any, h: any) => `${h.category} / ${h.type}`, width: 200 },
                        { title: 'IDS', dataIndex: 'toIds', width: 60, render: (v: boolean) => (v ? 'Sí' : 'No') },
                        { title: 'Fecha', dataIndex: 'eventDate', width: 110 },
                      ]}
                    />
                  )}
                  {!r.error && !r.hits.length && <Typography.Text type="secondary">{r.connectorName}: sin coincidencias</Typography.Text>}
                </div>
              ))}
            </div>
          )}
          {observable.attachment && (
            <div style={{ marginBottom: 16 }}>
              <Typography.Title level={5}>Fichero adjunto</Typography.Title>
              <Descriptions size="small" column={1} bordered>
                <Descriptions.Item label="Nombre">{observable.attachment.filename || observable.data}</Descriptions.Item>
                <Descriptions.Item label="Tamaño">{formatBytes(observable.attachment.size)}</Descriptions.Item>
                <Descriptions.Item label="Tipo">{observable.attachment.contentType || '—'}</Descriptions.Item>
                <Descriptions.Item label="SHA-256">
                  {attachmentSha256(observable)
                    ? <Typography.Text copyable={{ text: attachmentSha256(observable) }} style={{ fontFamily: 'monospace' }}>{attachmentSha256(observable)}</Typography.Text>
                    : '—'}
                </Descriptions.Item>
              </Descriptions>
              <Button
                style={{ marginTop: 8 }}
                icon={<DownloadOutlined />}
                onClick={() => downloadObservableFile(observable).catch((e) => message.error(errorMessage(e)))}
              >
                Descargar ZIP protegido
              </Button>
            </div>
          )}
          <Typography.Title level={5}>Avistamientos en Nuestracolmena</Typography.Title>
          <SightingsList observable={observable} />
          <Typography.Title level={5} style={{ marginTop: 18 }}>Reportes de Cortex <Button size="small" type="text" icon={<SyncOutlined />} onClick={refresh} /></Typography.Title>
          {reports.isLoading ? <Spin /> : !(reports.data || []).length ? (
            <Empty description="Todavía no se ha analizado este observable" />
          ) : (
            <Collapse
              items={(reports.data || []).map((r: any) => ({
                key: r.id,
                label: (
                  <Space wrap>
                    <ReportStatus status={r.status} />
                    <b>{r.analyzer}</b>
                    <Typography.Text type="secondary">{date(r.createdAt)}</Typography.Text>
                    <TaxonomyTags taxonomies={r.taxonomies} />
                  </Space>
                ),
                children: (
                  <div>
                    {r.errorMessage && <Alert type="error" showIcon message={r.errorMessage} style={{ marginBottom: 8 }} />}
                    {(r.artifacts || []).length > 0 && (
                      <div style={{ marginBottom: 12 }}>
                        <Space style={{ marginBottom: 6 }}>
                          <b>Artefactos extraídos ({r.artifacts.length})</b>
                          <Button size="small" loading={importArtifacts.isPending} onClick={() => importArtifacts.mutate({ reportId: r.id })}>Importar todos como observables</Button>
                        </Space>
                        <Table
                          size="small" rowKey={(_: any, i?: number) => String(i)} pagination={{ pageSize: 10 }} dataSource={r.artifacts}
                          columns={[
                            { title: 'Tipo', dataIndex: 'dataType', width: 120 },
                            { title: 'Valor', dataIndex: 'data', render: (v: string) => <code>{v}</code> },
                            {
                              title: '', width: 90,
                              render: (_: any, __: any, i: number) => <Button size="small" type="link" onClick={() => importArtifacts.mutate({ reportId: r.id, indexes: [i] })}>Importar</Button>,
                            },
                          ]}
                        />
                      </div>
                    )}
                    {r.status === 'Success' && (
                      <pre style={{ maxHeight: 420, overflow: 'auto', background: '#f6f6f9', padding: 10, fontSize: 12, borderRadius: 6 }}>
                        {JSON.stringify(r.report, null, 2)}
                      </pre>
                    )}
                  </div>
                ),
              }))}
            />
          )}
          <AnalyzeModal observable={observable} open={analyzeOpen} onClose={() => setAnalyzeOpen(false)} onDone={refresh} />
        </>
      )}
    </Drawer>
  );
}

// ------------------------------------------------------------------ responders

export function RespondersButton({ target, objectId, size }: { target: 'case' | 'task' | 'observable' | 'alert'; objectId: string; size?: 'small' | 'middle' }) {
  const [enabled, setEnabled] = useState(false);
  const [historyOpen, setHistoryOpen] = useState(false);
  const qc = useQueryClient();
  const responders = useQuery({
    queryKey: ['cortex-responders', target],
    queryFn: async () => (await api.get(`/cortex/responders/${target}`)).data,
    enabled,
  });
  const actions = useQuery({
    queryKey: ['cortex-actions', target, objectId],
    queryFn: async () => (await api.get(`/cortex/actions/${target}/${objectId}`)).data,
    enabled: historyOpen,
    refetchInterval: (q) => ((q.state.data as any[]) || []).some((a) => isPending(a.status)) ? 3000 : false,
  });
  const run = useMutation({
    mutationFn: async (r: any) => (await api.post(`/cortex/responders/${target}/${objectId}`, { connectorId: r.connectorId, responderId: r.id, responderName: r.name })).data,
    onSuccess: (job) => {
      message.success(`Responder ${job.payload?.responderName} lanzado (${job.status})`);
      qc.invalidateQueries({ queryKey: ['cortex-actions', target, objectId] });
      setHistoryOpen(true);
    },
    onError: (e) => message.error(errorMessage(e)),
  });
  const list = responders.data?.responders || [];
  const menuItems = responders.isLoading
    ? [{ key: 'loading', label: <Spin size="small" />, disabled: true }]
    : list.length
      ? list.map((r: any) => ({ key: `${r.connectorId}::${r.id}`, label: <span><b>{r.name}</b> <span style={{ color: '#8c8c9a' }}>· {r.connectorName}</span></span>, onClick: () => run.mutate(r) }))
      : [{ key: 'none', disabled: true, label: responders.data?.servers === 0 ? 'Sin servidor Cortex configurado' : 'Ningún responder habilitado para este objeto' }];

  return (
    <>
      <Dropdown.Button
        size={size}
        menu={{ items: [...menuItems, { type: 'divider' as const }, { key: 'history', icon: <HistoryOutlined />, label: 'Historial de acciones', onClick: () => setHistoryOpen(true) }] }}
        onOpenChange={(o) => o && setEnabled(true)}
        onClick={() => setHistoryOpen(true)}
        loading={run.isPending}
      >
        <ThunderboltOutlined /> Responders
      </Dropdown.Button>
      <Modal title="Acciones de Cortex" open={historyOpen} onCancel={() => setHistoryOpen(false)} footer={null} width={760}>
        <Table
          size="small" rowKey="id" loading={actions.isLoading} dataSource={actions.data || []} pagination={{ pageSize: 10 }}
          expandable={{ expandedRowRender: (a: any) => <pre style={{ fontSize: 12, maxHeight: 300, overflow: 'auto' }}>{JSON.stringify(a.result, null, 2)}</pre> }}
          columns={[
            { title: 'Responder', render: (_: any, a: any) => a.payload?.responderName },
            { title: 'Estado', dataIndex: 'status', width: 130, render: (v: string) => <ReportStatus status={v} /> },
            { title: 'Mensaje', render: (_: any, a: any) => a.result?.message || a.result?.errorMessage || '—' },
            { title: 'Fecha', dataIndex: 'createdAt', width: 150, render: (v: string) => date(v) },
          ]}
        />
      </Modal>
    </>
  );
}

// ------------------------------------------------------------------ MISP

export function MispExportButton({ caseData, onDone }: { caseData: any; onDone?: () => void }) {
  const connectors = useQuery({ queryKey: ['connectors', 'misp'], queryFn: async () => (await api.get('/connectors', { params: { type: 'misp' } })).data });
  const [open, setOpen] = useState(false);
  const [connectorId, setConnectorId] = useState<string | undefined>();
  const [iocOnly, setIocOnly] = useState(false);
  const exported = (caseData.exports || []).filter((e: any) => e.type === 'misp');
  const run = useMutation({
    mutationFn: async () => (await api.post(`/cases/${caseData.id}/misp-export`, { connectorId: connectorId || connectors.data?.[0]?.id, iocOnly })).data,
    onSuccess: (res) => {
      message.success(`Exportado a MISP: evento #${res.eventId} (${res.attributesAdded} atributo(s) nuevo(s))`);
      setOpen(false);
      onDone?.();
    },
    onError: (e) => message.error(errorMessage(e)),
  });
  return (
    <>
      <Button icon={<CloudUploadOutlined />} onClick={() => setOpen(true)}>MISP</Button>
      <Modal title="Exportar caso a MISP" open={open} onCancel={() => setOpen(false)} onOk={() => run.mutate()} okText="Exportar" confirmLoading={run.isPending} okButtonProps={{ disabled: !connectors.data?.length }}>
        {!connectors.data?.length ? (
          <Alert type="warning" showIcon message="No hay ningún servidor MISP configurado (Administración → Cortex & MISP)." />
        ) : (
          <Space direction="vertical" style={{ width: '100%' }}>
            {connectors.data.length > 1 && (
              <Space>Servidor:
                <select value={connectorId || connectors.data[0].id} onChange={(e) => setConnectorId(e.target.value)}>
                  {connectors.data.map((c: any) => <option key={c.id} value={c.id}>{c.name}</option>)}
                </select>
              </Space>
            )}
            <Checkbox checked={iocOnly} onChange={(e) => setIocOnly(e.target.checked)}>Exportar solo observables marcados como IOC</Checkbox>
            <Typography.Paragraph type="secondary" style={{ margin: 0 }}>
              Se crea un evento con los observables como atributos, el TLP como tag y los tags del caso. Si el caso ya se exportó, se añaden solo los atributos nuevos al mismo evento.
            </Typography.Paragraph>
            {exported.length > 0 && (
              <Descriptions size="small" column={1} bordered>
                {exported.map((e: any) => (
                  <Descriptions.Item key={e.connectorId} label={e.connectorName}>
                    Evento #{e.eventId} · {date(e.exportedAt)} · {e.attributes} atributos
                  </Descriptions.Item>
                ))}
              </Descriptions>
            )}
          </Space>
        )}
      </Modal>
    </>
  );
}

export function MispSyncButton({ onDone }: { onDone?: () => void }) {
  const connectors = useQuery({ queryKey: ['connectors', 'misp'], queryFn: async () => (await api.get('/connectors', { params: { type: 'misp' } })).data });
  const [open, setOpen] = useState(false);
  const [last, setLast] = useState('7d');
  const [publishedOnly, setPublishedOnly] = useState(false);
  const run = useMutation({
    mutationFn: async () => (await api.post('/misp/sync', { last, publishedOnly, connectorId: connectors.data?.[0]?.id })).data,
    onSuccess: (r) => {
      message.success(`MISP: ${r.events} evento(s) → ${r.created} alerta(s) nueva(s), ${r.updated} actualizada(s)`);
      if (r.errors?.length) message.warning(r.errors.slice(0, 3).join(' | '));
      setOpen(false);
      onDone?.();
    },
    onError: (e) => message.error(errorMessage(e)),
  });
  return (
    <>
      <Button icon={<CloudUploadOutlined rotate={180} />} onClick={() => setOpen(true)}>Importar de MISP</Button>
      <Modal title="Importar eventos de MISP como alertas" open={open} onCancel={() => setOpen(false)} onOk={() => run.mutate()} okText="Importar" confirmLoading={run.isPending} okButtonProps={{ disabled: !connectors.data?.length }}>
        {!connectors.data?.length ? (
          <Alert type="warning" showIcon message="No hay ningún servidor MISP configurado (Administración → Cortex & MISP)." />
        ) : (
          <Space direction="vertical">
            <Space>Eventos modificados en los últimos
              <select value={last} onChange={(e) => setLast(e.target.value)}>
                {['1h', '12h', '1d', '7d', '30d', '365d'].map((v) => <option key={v} value={v}>{v}</option>)}
              </select>
            </Space>
            <Checkbox checked={publishedOnly} onChange={(e) => setPublishedOnly(e.target.checked)}>Solo eventos publicados</Checkbox>
            <Typography.Text type="secondary">Las alertas se deduplican por evento: volver a importar actualiza la alerta y añade los atributos nuevos.</Typography.Text>
          </Space>
        )}
      </Modal>
    </>
  );
}
