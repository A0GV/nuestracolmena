import { useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  Alert, Button, Card, Col, DatePicker, Descriptions, Drawer, Dropdown, Form, Input, List,
  Modal, Popconfirm, Row, Select, Space, Spin, Table, Tabs, Tag, Timeline, Tooltip, Typography, Upload, message,
} from 'antd';
import {
  CheckCircleOutlined, CloseCircleOutlined, DeleteOutlined, EditOutlined, FlagOutlined,
  MergeCellsOutlined, PlusOutlined, ReloadOutlined, SendOutlined, UploadOutlined, FileTextOutlined, ShareAltOutlined,
  ExperimentOutlined, DownloadOutlined, PrinterOutlined,
} from '@ant-design/icons';
import { api, errorMessage } from '../lib/api';
import { useAuth } from '../lib/auth';
import { Markdown, SeverityTag, SlaCell, StatusBadge, TlpTag, date, fromNow, humanDuration } from '../lib/format';
import { AnalysisSummary, AnalyzeModal, FileObservableCell, FileUploadButton, MispExportButton, ObservableIntelDrawer, RespondersButton, SightingsPopover, OBSERVABLE_TYPES, isPending } from '../lib/integrations';
import { FunctionActionsButton } from '../lib/functionActions';

const SEVERITY_OPTIONS = [{ value: 1, label: 'LOW' }, { value: 2, label: 'MEDIUM' }, { value: 3, label: 'HIGH' }, { value: 4, label: 'CRITICAL' }];
const TLP_OPTIONS = [{ value: 0, label: 'WHITE' }, { value: 1, label: 'GREEN' }, { value: 2, label: 'AMBER' }, { value: 3, label: 'RED' }];
const TASK_STATUS = ['Waiting', 'InProgress', 'Completed'];

export default function CaseDetailPage() {
  const { idOrNumber, tab } = useParams();
  const navigate = useNavigate();
  const qc = useQueryClient();
  const { can, user } = useAuth();
  const [taskModal, setTaskModal] = useState(false);
  const [obsModal, setObsModal] = useState(false);
  const [ttpModal, setTtpModal] = useState(false);
  const [ttpSearchInput, setTtpSearchInput] = useState('');
  const [ttpSearch, setTtpSearch] = useState('');
  const [ttpPattern, setTtpPattern] = useState<any>(null);
  const [ttpMatrix, setTtpMatrix] = useState(false);
  const [editModal, setEditModal] = useState(false);
  const [closeModal, setCloseModal] = useState(false);
  const [mergeModal, setMergeModal] = useState(false);
  const [shareModal, setShareModal] = useState(false);
  const [taskDrawer, setTaskDrawer] = useState<string | null>(null);
  const [editingTask, setEditingTask] = useState<any>(null);
  const [editingObs, setEditingObs] = useState<any>(null);
  const [intelObsId, setIntelObsId] = useState<string | null>(null);
  const [analyzeObs, setAnalyzeObs] = useState<any>(null);
  const [comment, setComment] = useState('');
  const reportRefs = useRef<Record<string, HTMLDivElement | null>>({});
  const [taskForm] = Form.useForm();
  const [obsForm] = Form.useForm();
  const [ttpForm] = Form.useForm();
  const [editForm] = Form.useForm();
  const [closeForm] = Form.useForm();
  const [mergeForm] = Form.useForm();
  const [shareForm] = Form.useForm();

  const caseQuery = useQuery({
    queryKey: ['case', idOrNumber],
    queryFn: async () => (await api.get(`/cases/${idOrNumber}`)).data,
    // Keep polling while Cortex analyses are running so taxonomies appear by themselves.
    refetchInterval: (q) => ((q.state.data as any)?.observables || []).some((o: any) => (o.reports || []).some((r: any) => isPending(r.status))) ? 4000 : false,
  });
  const c = caseQuery.data;
  const intelObs = (c?.observables || []).find((o: any) => o.id === intelObsId) || null;

  const patternsQuery = useQuery({
    queryKey: ['patterns', 'ttp', ttpSearch],
    queryFn: async () => (await api.get('/patterns', { params: { search: ttpSearch, limit: 50 } })).data,
    enabled: ttpModal,
  });
  const tacticsQuery = useQuery({ queryKey: ['tactics'], queryFn: async () => (await api.get('/tactics')).data });
  const matrixPatternsQuery = useQuery({
    queryKey: ['patterns', 'matrix'],
    queryFn: async () => (await api.get('/patterns', { params: { limit: 2000, includeRevoked: true } })).data,
    enabled: ttpMatrix,
  });
  useEffect(() => {
    const timer = setTimeout(() => setTtpSearch(ttpSearchInput), 300);
    return () => clearTimeout(timer);
  }, [ttpSearchInput]);
  const attachmentsQuery = useQuery({
    queryKey: ['attachments', c?.id],
    queryFn: async () => (await api.get('/attachments', { params: { objectType: 'case', objectId: c.id } })).data,
    enabled: !!c,
  });
  const reportsQuery = useQuery({
    queryKey: ['reports', c?.id],
    queryFn: async () => (await api.get(`/cases/${c.id}/reports`)).data,
    enabled: !!c,
  });
  const sharesQuery = useQuery({
    queryKey: ['shares', c?.id],
    queryFn: async () => (await api.get(`/cases/${c.id}/shares`)).data,
    enabled: !!c,
  });
  const orgsQuery = useQuery({ queryKey: ['organisations'], queryFn: async () => (await api.get('/organisations')).data });
  const profilesQuery = useQuery({ queryKey: ['profiles'], queryFn: async () => (await api.get('/profiles')).data });
  const casesQuery = useQuery({ queryKey: ['cases', 'merge-options'], queryFn: async () => (await api.get('/cases', { params: { pageSize: 100 } })).data });
  const relatedQuery = useQuery({
    queryKey: ['case', c?.id, 'related'],
    queryFn: async () => (await api.get(`/cases/${c.id}/related`)).data,
    enabled: !!c,
  });
  const timelineQuery = useQuery({
    queryKey: ['case', idOrNumber, 'timeline'],
    queryFn: async () => (await api.get(`/cases/${idOrNumber}/timeline`)).data,
    enabled: !!c && (tab || 'general') === 'timeline',
  });

  const ttpCounts = useMemo(() => {
    const counts = new Map<string, number>();
    for (const procedure of c?.procedures || []) counts.set(procedure.patternId, (counts.get(procedure.patternId) || 0) + 1);
    return counts;
  }, [c?.procedures]);

  const matrixColumns = useMemo(() => {
    if (!ttpMatrix) return [] as any[];
    const items: any[] = matrixPatternsQuery.data?.items || [];
    const byId = new Map<string, any>(items.map((item: any) => [item.patternId, item]));
    const needed = new Set<string>();
    for (const patternId of ttpCounts.keys()) {
      needed.add(patternId);
      const pattern = byId.get(patternId);
      if (pattern?.parentPatternId) needed.add(pattern.parentPatternId);
    }
    const patterns = items.filter((item: any) => needed.has(item.patternId));
    return (tacticsQuery.data || []).map((tactic: any) => ({
      ...tactic,
      techniques: patterns
        .filter((item: any) => (item.tactics || []).some((value: string) => value === tactic.name || value === tactic.shortName))
        .sort((a: any, b: any) => String(a.patternId).localeCompare(String(b.patternId))),
    }));
  }, [ttpMatrix, matrixPatternsQuery.data, tacticsQuery.data, ttpCounts]);

  const invalidate = () => {
    qc.invalidateQueries({ queryKey: ['case', idOrNumber] });
    qc.invalidateQueries({ queryKey: ['case', c?.id, 'related'] });
    qc.invalidateQueries({ queryKey: ['cases'] });
    qc.invalidateQueries({ queryKey: ['stats'] });
    qc.invalidateQueries({ queryKey: ['tasks'] });
  };

  const patchCase = useMutation({
    mutationFn: async (data: any) => (await api.patch(`/cases/${c.id}`, data)).data,
    onSuccess: () => { message.success('Caso actualizado'); invalidate(); },
    onError: (e) => message.error(errorMessage(e)),
  });
  const createTask = useMutation({
    mutationFn: async (data: any) => (await api.post(`/cases/${c.id}/tasks`, data)).data,
    onSuccess: () => { message.success('Tarea creada'); setTaskModal(false); taskForm.resetFields(); invalidate(); },
    onError: (e) => message.error(errorMessage(e)),
  });
  const updateTask = useMutation({
    mutationFn: async ({ id, data }: any) => (await api.patch(`/tasks/${id}`, data)).data,
    onSuccess: () => { message.success('Tarea actualizada'); invalidate(); qc.invalidateQueries({ queryKey: ['task', taskDrawer] }); },
    onError: (e) => message.error(errorMessage(e)),
  });
  const deleteTask = useMutation({
    mutationFn: async (id: string) => (await api.delete(`/tasks/${id}`)).data,
    onSuccess: () => { message.success('Tarea cancelada'); invalidate(); },
    onError: (e) => message.error(errorMessage(e)),
  });
  const createObservables = useMutation({
    mutationFn: async (values: any) => {
      const lines = String(values.data || '').split('\n').map((l) => l.trim()).filter(Boolean);
      for (const line of lines) {
        await api.post(`/cases/${c.id}/observables`, {
          dataType: values.dataType,
          data: line,
          message: values.message,
          tlp: values.tlp,
          pap: values.pap,
          ioc: values.ioc,
          sighted: values.sighted,
          tags: values.tags || [],
        });
      }
      return lines.length;
    },
    onSuccess: (count) => { message.success(`${count} observable(s) añadido(s)`); setObsModal(false); obsForm.resetFields(); invalidate(); },
    onError: (e) => message.error(errorMessage(e)),
  });
  const updateObservable = useMutation({
    mutationFn: async ({ id, data }: any) => (await api.patch(`/observables/${id}`, data)).data,
    onSuccess: () => { message.success('Observable actualizado'); setEditingObs(null); invalidate(); },
    onError: (e) => message.error(errorMessage(e)),
  });
  const deleteObservable = useMutation({
    mutationFn: async (id: string) => (await api.delete(`/observables/${id}`)).data,
    onSuccess: () => { message.success('Observable eliminado'); invalidate(); },
    onError: (e) => message.error(errorMessage(e)),
  });
  const createTtp = useMutation({
    mutationFn: async (values: any) => (await api.post(`/cases/${c.id}/procedures`, {
      ...values,
      occurDate: values.occurDate ? values.occurDate.toISOString() : new Date().toISOString(),
    })).data,
    onSuccess: () => { message.success('TTP añadido'); setTtpModal(false); ttpForm.resetFields(); setTtpPattern(null); setTtpSearchInput(''); setTtpSearch(''); invalidate(); },
    onError: (e) => message.error(errorMessage(e)),
  });
  const deleteTtp = useMutation({
    mutationFn: async (id: string) => (await api.delete(`/procedures/${id}`)).data,
    onSuccess: () => { message.success('TTP eliminado'); invalidate(); },
    onError: (e) => message.error(errorMessage(e)),
  });
  const addComment = useMutation({
    mutationFn: async (text: string) => (await api.post(`/cases/${c.id}/comments`, { message: text })).data,
    onSuccess: () => { setComment(''); invalidate(); },
    onError: (e) => message.error(errorMessage(e)),
  });
  const closeCase = useMutation({
    mutationFn: async (values: any) => (await api.post(`/cases/${c.id}/close`, values)).data,
    onSuccess: () => { message.success('Caso cerrado'); setCloseModal(false); closeForm.resetFields(); invalidate(); },
    onError: (e) => message.error(errorMessage(e)),
  });
  const reopenCase = useMutation({
    mutationFn: async () => (await api.post(`/cases/${c.id}/reopen`)).data,
    onSuccess: () => { message.success('Caso reabierto'); invalidate(); },
    onError: (e) => message.error(errorMessage(e)),
  });
  const deleteCase = useMutation({
    mutationFn: async () => (await api.delete(`/cases/${c.id}`, { params: { force: true } })).data,
    onSuccess: () => { message.success('Caso eliminado'); navigate('/cases'); },
    onError: (e) => message.error(errorMessage(e)),
  });
  const mergeCase = useMutation({
    mutationFn: async (ids: string[]) => (await api.post(`/cases/${c.id}/merge`, { ids })).data,
    onSuccess: (merged) => { message.success('Casos fusionados'); setMergeModal(false); navigate(`/cases/${merged.id}`); },
    onError: (e) => message.error(errorMessage(e)),
  });

  const addShare = useMutation({
    mutationFn: async (values: any) => (await api.post(`/cases/${c.id}/shares`, values)).data,
    onSuccess: () => { message.success('Caso compartido'); setShareModal(false); shareForm.resetFields(); qc.invalidateQueries({ queryKey: ['shares', c.id] }); },
    onError: (e) => message.error(errorMessage(e)),
  });
  const removeShare = useMutation({
    mutationFn: async (shareId: string) => (await api.delete(`/cases/${c.id}/shares/${shareId}`)).data,
    onSuccess: () => { message.success('Share eliminado'); qc.invalidateQueries({ queryKey: ['shares', c.id] }); },
    onError: (e) => message.error(errorMessage(e)),
  });

  const generateReport = useMutation({
    mutationFn: async () => (await api.post(`/cases/${c.id}/report`)).data,
    onSuccess: () => { message.success('Reporte generado'); qc.invalidateQueries({ queryKey: ['reports', c.id] }); },
    onError: (e) => message.error(errorMessage(e)),
  });

  const downloadReport = (report: any) => {
    const blob = new Blob([report.content || ''], { type: 'text/markdown;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement('a');
    anchor.href = url;
    anchor.download = `case-${c.number}-report-${String(report.createdAt).slice(0, 10)}.md`;
    document.body.appendChild(anchor);
    anchor.click();
    anchor.remove();
    URL.revokeObjectURL(url);
  };

  const printReport = (report: any) => {
    const node = reportRefs.current[report.id];
    const win = window.open('', '_blank');
    if (!win) {
      message.warning('El navegador ha bloqueado la ventana de impresión');
      return;
    }
    win.document.write(`<!doctype html><html><head><meta charset="utf-8"><title>Caso #${c.number} · Reporte</title>
      <style>
        body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Arial, sans-serif; margin: 32px; color: #222; line-height: 1.5; }
        h1 { border-bottom: 2px solid #54c1c2; padding-bottom: 6px; }
        h2 { margin-top: 24px; border-bottom: 1px solid #ddd; padding-bottom: 4px; }
        table { border-collapse: collapse; width: 100%; margin: 12px 0; }
        th, td { border: 1px solid #ddd; padding: 6px 8px; text-align: left; vertical-align: top; }
        code, pre { background: #f5f5f5; padding: 2px 4px; border-radius: 4px; }
        pre { padding: 10px; overflow: auto; }
        blockquote { border-left: 3px solid #54c1c2; margin: 8px 0; padding-left: 12px; color: #555; }
      </style></head><body>${node?.innerHTML || ''}</body></html>`);
    win.document.close();
    win.focus();
    setTimeout(() => win.print(), 150);
  };

  useEffect(() => {
    if (c) {
      editForm.setFieldsValue({
        title: c.title, description: c.description, summary: c.summary,
        severity: c.severity, tlp: c.tlp, pap: c.pap, tags: c.tags,
        assignee: c.assignee?.login,
      });
    }
  }, [c, editForm]);

  if (caseQuery.isLoading) return <Spin size="large" style={{ display: 'block', margin: '80px auto' }} />;
  if (!c) return <Alert type="error" message="Caso no encontrado" showIcon />;

  const activeTab = tab || 'general';
  const closed = c.stage === 'Closed';
  const customFields = c.customFields && typeof c.customFields === 'object' ? Object.entries(c.customFields) : [];

  const taskColumns = [
    { title: 'Estado', dataIndex: 'status', width: 120, render: (v: string) => <StatusBadge value={v} stage={v === 'Completed' ? 'Closed' : 'InProgress'} /> },
    { title: 'Grupo', dataIndex: 'group', width: 160, render: (v: string) => v || <span style={{ color: '#aaa' }}>—</span> },
    {
      title: 'Tarea', dataIndex: 'title',
      render: (v: string, row: any) => <a onClick={() => setTaskDrawer(row.id)} style={{ fontWeight: 600 }}>{v}</a>,
    },
    { title: 'Cesionario', dataIndex: ['assignee', 'name'], width: 150, render: (v: string) => v || '—' },
    { title: 'Due date', dataIndex: 'dueDate', width: 140, render: (v: string) => v ? date(v) : '—' },
    { title: 'Logs', width: 80, render: (_: any, row: any) => <span>{row._count?.logs ?? 0}</span> },
    {
      title: '', width: 170, align: 'right' as const,
      render: (_: any, row: any) => (
        <Space>
          {row.status === 'Waiting' && <Button size="small" onClick={() => updateTask.mutate({ id: row.id, data: { status: 'InProgress', startDate: new Date().toISOString() } })}>Iniciar</Button>}
          {row.status !== 'Completed' && <Button size="small" type="primary" ghost onClick={() => updateTask.mutate({ id: row.id, data: { status: 'Completed', endDate: new Date().toISOString() } })}>Cerrar</Button>}
          <Popconfirm title="¿Cancelar tarea?" onConfirm={() => deleteTask.mutate(row.id)}>
            <Button size="small" danger type="text" icon={<DeleteOutlined />} />
          </Popconfirm>
        </Space>
      ),
    },
  ];

  const obsColumns = [
    { title: 'Tipo', dataIndex: 'dataType', width: 100, render: (v: string) => <Tag color="blue">{v}</Tag> },
    {
      title: 'Valor', dataIndex: 'data', width: 320,
      render: (v: string, row: any) => (
        row.dataType === 'file'
          ? <FileObservableCell observable={row} onOpen={() => setIntelObsId(row.id)} />
          : (
            <Typography.Text copyable={{ text: v }} style={{ fontFamily: 'monospace', wordBreak: 'break-all' }}>
              <a onClick={() => setIntelObsId(row.id)} title="Ver análisis e inteligencia">{v}</a>
            </Typography.Text>
          )
      ),
    },
    { title: 'Mensaje', dataIndex: 'message', width: 220, render: (v: string) => v || '—' },
    { title: 'Análisis (Cortex)', width: 240, render: (_: any, row: any) => <AnalysisSummary reports={row.reports} /> },
    { title: 'Flags', width: 150, render: (_: any, row: any) => (
      <Space size={4} wrap>
        {row.ioc && <Tag color="red">IOC</Tag>}
        {row.sighted && <Tag color="green">Sighted</Tag>}
        <TlpTag value={row.tlp} prefix="TLP" />
      </Space>
    ) },
    { title: 'Tags', dataIndex: 'tags', width: 140, render: (tags: string[]) => (tags || []).map((t) => <Tag key={t}>{t}</Tag>) },
    { title: 'Fecha', dataIndex: 'createdAt', width: 140, render: (v: string) => date(v) },
    {
      title: 'Visto en', width: 80, align: 'center' as const,
      render: (_: any, row: any) => <SightingsPopover observable={row} compact />,
    },
    {
      title: '', width: 130, align: 'right' as const, fixed: 'right' as const,
      render: (_: any, row: any) => (
        <Space>
          {can('manageAnalyse') && (
            <Tooltip title="Analizar con Cortex"><Button size="small" type="text" icon={<ExperimentOutlined />} onClick={() => setAnalyzeObs(row)} /></Tooltip>
          )}
          <Button size="small" type="text" icon={<EditOutlined />} onClick={() => setEditingObs(row)} />
          <Popconfirm title="¿Eliminar observable?" onConfirm={() => deleteObservable.mutate(row.id)}>
            <Button size="small" danger type="text" icon={<DeleteOutlined />} />
          </Popconfirm>
        </Space>
      ),
    },
  ];

  const comments = c.comments || [];

  const generalTab = (
    <div className="case-detail-body">
      <div className="case-detail-main">
        <Descriptions column={1} size="small" bordered style={{ marginBottom: 18 }}>
          <Descriptions.Item label="Título"><b>{c.title}</b></Descriptions.Item>
          <Descriptions.Item label="Tags">{(c.tags || []).map((t: string) => <Tag key={t} color="cyan">{t}</Tag>)}</Descriptions.Item>
          <Descriptions.Item label="Descripción"><Markdown>{c.description}</Markdown></Descriptions.Item>
          {c.summary && <Descriptions.Item label="Summary"><Markdown>{c.summary}</Markdown></Descriptions.Item>}
          {customFields.length > 0 && (
            <Descriptions.Item label="Custom fields">
              {customFields.map(([k, v]) => <div key={k}><b>{k}</b>: {String(v)}</div>)}
            </Descriptions.Item>
          )}
        </Descriptions>
        <Typography.Title level={5}>Casos relacionados</Typography.Title>
        {relatedQuery.isLoading ? <Spin size="small" /> : !(relatedQuery.data || []).length ? (
          <Typography.Text type="secondary">No hay otros casos con observables en común.</Typography.Text>
        ) : (
          <List
            size="small"
            dataSource={relatedQuery.data}
            renderItem={(item: any) => {
              const total = item.ratio > 0 ? Math.round(item.sharedCount / item.ratio) : item.sharedCount;
              return (
                <List.Item style={{ display: 'block' }}>
                  <Space wrap size={6}>
                    <a onClick={() => navigate(`/cases/${item.case.id}`)} style={{ fontWeight: 600 }}>
                      #{item.case.number} {item.case.title}
                    </a>
                    <StatusBadge value={item.case.status} stage={item.case.stage} />
                    {item.case.closed && <Tag color="default">Cerrado</Tag>}
                    <Tag color="cyan">{item.sharedCount}/{total} observables · {Math.round(item.ratio * 100)}%</Tag>
                  </Space>
                  <div style={{ marginTop: 4 }}>
                    {(item.sharedObservables || []).map((observable: any) => (
                      <Tag key={`${observable.dataType}:${observable.data}`} color={observable.ioc ? 'red' : undefined}>
                        {observable.dataType}: {observable.data}
                      </Tag>
                    ))}
                  </div>
                </List.Item>
              );
            }}
          />
        )}
        <Typography.Title level={5} style={{ marginTop: 18 }}>Alertas vinculadas</Typography.Title>
        <Space wrap>
          {(c.alerts || []).map((a: any) => (
            <Tag key={a.id} color="orange">Alerta: {a.title}</Tag>
          ))}
          {(c.alerts || []).length === 0 && <Typography.Text type="secondary">No hay alertas vinculadas.</Typography.Text>}
        </Space>
      </div>
      <div className="case-comments">
        <Typography.Title level={5} style={{ marginTop: 0 }}>Comentarios</Typography.Title>
        <List
          dataSource={comments}
          locale={{ emptyText: 'Sin comentarios' }}
          renderItem={(item: any) => (
            <List.Item style={{ display: 'block' }}>
              <div style={{ fontSize: 12, color: '#8c8c9a' }}><b>{item.createdBy?.name}</b> · {fromNow(item.createdAt)}</div>
              <Markdown>{item.message}</Markdown>
            </List.Item>
          )}
        />
        <Input.TextArea rows={3} value={comment} onChange={(e) => setComment(e.target.value)} placeholder="Escribe un comentario…" />
        <Button type="primary" icon={<SendOutlined />} style={{ marginTop: 8 }} block disabled={!comment.trim()} loading={addComment.isPending} onClick={() => addComment.mutate(comment)}>
          Enviar
        </Button>
      </div>
    </div>
  );

  return (
    <div>
      <Card size="small" style={{ marginBottom: 12 }}>
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12, flexWrap: 'wrap' }}>
          <Space align="center">
            <Tag color="#faad14" style={{ fontSize: 14, padding: '2px 10px' }}>#{c.number}</Tag>
            <Typography.Title level={4} style={{ margin: 0 }}>{c.title}</Typography.Title>
            {c.flag && <Tag color="red">FLAGGED</Tag>}
            <SlaCell sla={c.sla} />
          </Space>
          <Space wrap>
            {can('manageCase/update') && <Button icon={<EditOutlined />} onClick={() => setEditModal(true)}>Editar</Button>}
            {can('manageCase/update') && (closed
              ? <Button icon={<CheckCircleOutlined />} onClick={() => reopenCase.mutate()}>Reabrir</Button>
              : <Button icon={<CloseCircleOutlined />} danger onClick={() => setCloseModal(true)}>Cerrar</Button>)}
            {can('manageShare') && <Button icon={<ShareAltOutlined />} onClick={() => setShareModal(true)}>Compartir</Button>}
            {can('manageShare') && <MispExportButton caseData={c} onDone={invalidate} />}
            <RespondersButton target="case" objectId={c.id} />
            <FunctionActionsButton target="case" objectId={c.id} onDone={invalidate} />
            {can('manageCase/merge') && <Button icon={<MergeCellsOutlined />} onClick={() => setMergeModal(true)}>Merge</Button>}
            <Button icon={<FlagOutlined />} onClick={() => patchCase.mutate({ flag: !c.flag })}>{c.flag ? 'Unflag' : 'Flag'}</Button>
            <Button icon={<ReloadOutlined />} onClick={() => caseQuery.refetch()} />
            {can('manageCase/delete') && (
              <Popconfirm title="¿Eliminar este caso?" onConfirm={() => deleteCase.mutate()}>
                <Button danger icon={<DeleteOutlined />} />
              </Popconfirm>
            )}
          </Space>
        </div>
      </Card>

      <div style={{ display: 'flex', gap: 12, alignItems: 'flex-start' }}>
        <Card size="small" className="case-summary" styles={{ body: { padding: 12 } }}>
          <Descriptions column={1} size="small">
            <Descriptions.Item label="ID">{c.id}</Descriptions.Item>
            <Descriptions.Item label="Creado por">{c.createdBy?.name || '—'}</Descriptions.Item>
            <Descriptions.Item label="Creado">{date(c.createdAt)}</Descriptions.Item>
            <Descriptions.Item label="Actualizado">{date(c.updatedAt)}</Descriptions.Item>
            <Descriptions.Item label="Severidad"><SeverityTag value={c.severity} /></Descriptions.Item>
            <Descriptions.Item label="TLP / PAP"><Space><TlpTag value={c.tlp} prefix="TLP" /><TlpTag value={c.pap} prefix="PAP" /></Space></Descriptions.Item>
            <Descriptions.Item label="Cesionario">{c.assignee?.name || 'Ninguno'}</Descriptions.Item>
            <Descriptions.Item label="Estado"><StatusBadge value={c.status?.value || c.stage} stage={c.stage} colour={c.status?.colour} /></Descriptions.Item>
            <Descriptions.Item label="Inicio">{date(c.startDate)}</Descriptions.Item>
            <Descriptions.Item label="Duración">{humanDuration(c.startDate, c.endDate)}</Descriptions.Item>
            <Descriptions.Item label="Tareas">{(c.tasks || []).length} · {c.tasks?.filter((t: any) => t.status === 'Completed').length || 0} completadas</Descriptions.Item>
            <Descriptions.Item label="Observables">{(c.observables || []).length}</Descriptions.Item>
            <Descriptions.Item label="TTPs">{(c.procedures || []).length}</Descriptions.Item>
          </Descriptions>
        </Card>

        <Card size="small" style={{ flex: 1, minWidth: 0 }} styles={{ body: { padding: 0 } }}>
          <Tabs
            activeKey={activeTab}
            onChange={(key) => navigate(`/cases/${idOrNumber}${key === 'general' ? '' : `/${key}`}`)}
            items={[
              { key: 'general', label: 'General', children: generalTab },
              {
                key: 'tasks', label: `Tareas (${(c.tasks || []).length})`,
                children: (
                  <div style={{ padding: 12 }}>
                    <Space style={{ marginBottom: 10 }}>
                      {can('manageTask') && <Button type="primary" size="small" icon={<PlusOutlined />} onClick={() => setTaskModal(true)}>Añadir tarea</Button>}
                    </Space>
                    <Table rowKey="id" size="small" dataSource={c.tasks || []} columns={taskColumns as any} pagination={false} />
                  </div>
                ),
              },
              {
                key: 'observables', label: `Observables (${(c.observables || []).length})`,
                children: (
                  <div style={{ padding: 12 }}>
                    <Space style={{ marginBottom: 10 }}>
                      {can('manageObservable') && <Button type="primary" size="small" icon={<PlusOutlined />} onClick={() => setObsModal(true)}>Añadir observable</Button>}
                      {can('manageObservable') && <FileUploadButton endpoint={`/cases/${c.id}/observables/file`} onDone={invalidate} />}
                      {can('manageObservable') && (
                        <Button size="small" onClick={async () => {
                          try {
                            const r = (await api.post(`/cases/${c.id}/observables/_merge`)).data;
                            message.success(`${r.removed} duplicado(s) fusionado(s)`);
                            invalidate();
                          } catch (e) { message.error(errorMessage(e)); }
                        }}>Fusionar duplicados</Button>
                      )}
                    </Space>
                    <Table
                      rowKey="id" size="small" dataSource={c.observables || []} columns={obsColumns as any}
                      pagination={{ pageSize: 20 }} scroll={{ x: 1520 }}
                    />
                  </div>
                ),
              },
              {
                key: 'procedures', label: `TTPs (${(c.procedures || []).length})`,
                children: (
                  <div style={{ padding: 12 }}>
                    <Space style={{ marginBottom: 10 }} wrap>
                      {can('manageProcedure') && <Button type="primary" size="small" icon={<PlusOutlined />} onClick={() => setTtpModal(true)}>Añadir TTP</Button>}
                      <Button size="small" type={ttpMatrix ? 'primary' : 'default'} onClick={() => setTtpMatrix((value) => !value)}>
                        Matriz
                      </Button>
                    </Space>
                    {ttpMatrix && (
                      <div style={{ display: 'flex', gap: 8, overflowX: 'auto', paddingBottom: 12 }}>
                        {matrixColumns.length === 0 && <Typography.Text type="secondary">Sin tácticas en el catálogo. Importa el catálogo MITRE ATT&CK en Administración.</Typography.Text>}
                        {matrixColumns.map((column: any) => (
                          <div key={column.id} style={{ flex: '0 0 180px', minWidth: 180, background: '#fafafa', borderRadius: 6, padding: 8 }}>
                            <Typography.Text strong style={{ fontSize: 12 }}>{column.name}</Typography.Text>
                            <div style={{ marginTop: 6 }}>
                              {(column.techniques || []).map((pattern: any) => {
                                const count = ttpCounts.get(pattern.patternId) || 0;
                                return (
                                  <div
                                    key={pattern.patternId}
                                    style={{
                                      marginLeft: pattern.isSubtechnique ? 10 : 0,
                                      marginBottom: 6,
                                      padding: 4,
                                      borderRadius: 4,
                                      background: count ? '#fff1f0' : 'transparent',
                                      border: count ? '1px solid #ffa39e' : '1px solid transparent',
                                    }}
                                  >
                                    <a href={pattern.url || `https://attack.mitre.org/techniques/${String(pattern.patternId).replace(/\./g, '/')}/`} target="_blank" rel="noreferrer" style={{ fontSize: 12 }}>
                                      {pattern.patternId}
                                    </a>
                                    {count > 0 && <Tag color="red" style={{ marginLeft: 4 }}>{count}</Tag>}
                                    <div style={{ fontSize: 11, color: '#8c8c9a' }}>{pattern.name}</div>
                                  </div>
                                );
                              })}
                            </div>
                          </div>
                        ))}
                      </div>
                    )}
                    <Table
                      rowKey="id" size="small" dataSource={c.procedures || []} pagination={false}
                      columns={[
                        {
                          title: 'Táctica', dataIndex: 'tactic', width: 180,
                          render: (v: string) => v ? <Tag>{v}</Tag> : '—',
                        },
                        {
                          title: 'Técnica',
                          render: (_: any, r: any) => (
                            <span>
                              <a href={`https://attack.mitre.org/techniques/${String(r.patternId).replace(/\./g, '/')}/`} target="_blank" rel="noreferrer"><b>{r.patternId}</b></a>
                              {' · '}{r.patternName}
                            </span>
                          ),
                        },
                        { title: 'Fecha', dataIndex: 'occurDate', width: 150, render: (v: string) => date(v) },
                        { title: 'Descripción', dataIndex: 'description', render: (v: string) => v || '—' },
                        {
                          title: '', width: 60,
                          render: (_: any, r: any) => can('manageProcedure') ? (
                            <Popconfirm title="¿Eliminar TTP?" onConfirm={() => deleteTtp.mutate(r.id)}>
                              <Button size="small" danger type="text" icon={<DeleteOutlined />} />
                            </Popconfirm>
                          ) : null,
                        },
                      ]}
                    />
                  </div>
                ),
              },
              {
                key: 'linked-alerts', label: `Alertas (${(c.alerts || []).length})`,
                children: (
                  <div style={{ padding: 12 }}>
                    <Table
                      rowKey="id" size="small" dataSource={c.alerts || []} pagination={false}
                      columns={[
                        { title: 'Título', dataIndex: 'title' },
                        { title: 'Tipo', dataIndex: 'type', width: 120 },
                        { title: 'Fuente', dataIndex: 'source', width: 160 },
                        { title: 'Severidad', dataIndex: 'severity', width: 110, render: (v: number) => <SeverityTag value={v} /> },
                        { title: 'Fecha', dataIndex: 'date', width: 150, render: (v: string) => date(v) },
                      ]}
                    />
                  </div>
                ),
              },
              {
                key: 'attachments', label: `Adjuntos (${(attachmentsQuery.data || []).length})`,
                children: (
                  <div style={{ padding: 12 }}>
                    <Upload
                      customRequest={async ({ file, onSuccess, onError }: any) => {
                        const formData = new FormData();
                        formData.append('file', file);
                        formData.append('objectType', 'case');
                        formData.append('objectId', c.id);
                        try {
                          await api.post('/attachments', formData, { headers: { 'Content-Type': 'multipart/form-data' } });
                          onSuccess?.({});
                          qc.invalidateQueries({ queryKey: ['attachments', c.id] });
                          message.success('Adjunto subido');
                        } catch (e) { onError?.(e); message.error(errorMessage(e)); }
                      }}
                      showUploadList={false}
                    >
                      <Button type="primary" size="small" icon={<UploadOutlined />}>Subir adjunto</Button>
                    </Upload>
                    <Table
                      style={{ marginTop: 12 }} rowKey="id" size="small" pagination={false} dataSource={attachmentsQuery.data || []}
                      columns={[
                        { title: 'Nombre', dataIndex: 'filename' },
                        { title: 'Tipo', dataIndex: 'contentType', width: 180 },
                        { title: 'Tamaño', dataIndex: 'size', width: 100, render: (v: number) => `${Math.round(v / 1024)} KB` },
                        { title: 'Subido por', render: (_: any, r: any) => r.createdBy?.name || '—', width: 180 },
                        { title: 'Fecha', dataIndex: 'createdAt', width: 160, render: (v: string) => date(v) },
                        {
                          title: '', width: 110,
                          render: (_: any, r: any) => (
                            <Button size="small" type="link" onClick={async () => {
                              const res = await api.get(`/attachments/${r.id}/download`, { responseType: 'blob' });
                              const url = URL.createObjectURL(res.data);
                              const a = document.createElement('a');
                              a.href = url; a.download = r.filename; a.click(); URL.revokeObjectURL(url);
                            }}>Descargar</Button>
                          ),
                        },
                      ]}
                    />
                  </div>
                ),
              },
              {
                key: 'report', label: 'Report',
                children: (
                  <div style={{ padding: 12 }}>
                    <Button type="primary" icon={<FileTextOutlined />} loading={generateReport.isPending} onClick={() => generateReport.mutate()} style={{ marginBottom: 12 }}>
                      Generar reporte
                    </Button>
                    {(reportsQuery.data || []).map((r: any) => (
                      <Card
                        key={r.id}
                        size="small"
                        title={`Reporte · ${date(r.createdAt)}`}
                        style={{ marginBottom: 12 }}
                        extra={(
                          <Space>
                            <Button size="small" icon={<DownloadOutlined />} onClick={() => downloadReport(r)}>Descargar .md</Button>
                            <Button size="small" icon={<PrinterOutlined />} onClick={() => printReport(r)}>Imprimir</Button>
                          </Space>
                        )}
                      >
                        <div ref={(element) => { reportRefs.current[r.id] = element; }}>
                          <Markdown>{r.content}</Markdown>
                        </div>
                      </Card>
                    ))}
                    {(reportsQuery.data || []).length === 0 && <Typography.Text type="secondary">Sin reportes generados.</Typography.Text>}
                  </div>
                ),
              },
              {
                key: 'shares', label: `Shares (${(sharesQuery.data || []).length})`,
                children: (
                  <div style={{ padding: 12 }}>
                    <Button type="primary" size="small" icon={<ShareAltOutlined />} style={{ marginBottom: 12 }} onClick={() => setShareModal(true)}>Compartir con organización</Button>
                    <Table
                      rowKey="id" size="small" pagination={false} dataSource={sharesQuery.data || []}
                      columns={[
                        { title: 'Organización', render: (_: any, r: any) => r.targetOrg?.name },
                        { title: 'Perfil', render: (_: any, r: any) => r.profile?.name },
                        { title: 'Compartido por', render: (_: any, r: any) => r.createdBy?.name || '—' },
                        { title: 'Fecha', dataIndex: 'createdAt', render: (v: string) => date(v) },
                        {
                          title: '', width: 100,
                          render: (_: any, r: any) => <Popconfirm title="¿Quitar share?" onConfirm={() => removeShare.mutate(r.id)}><Button size="small" danger type="text" icon={<DeleteOutlined />} /></Popconfirm>,
                        },
                      ]}
                    />
                  </div>
                ),
              },
              {
                key: 'timeline', label: 'Timeline',
                children: (
                  <div style={{ padding: 16 }}>
                    <Timeline
                      items={(timelineQuery.data || []).map((e: any) => ({
                        color: e.type === 'comment' ? 'blue' : e.type === 'ttp' ? 'red' : 'green',
                        children: (
                          <div className="timeline-item">
                            <div className="when">{date(e.date)}</div>
                            <div className="what">{e.title}</div>
                            {e.task && <div style={{ fontSize: 12, color: '#8c8c9a' }}>Tarea: {e.task}</div>}
                          </div>
                        ),
                      }))}
                    />
                  </div>
                ),
              },
            ]}
          />
        </Card>
      </div>

      {/* Task creation */}
      <Modal title="Añadir tarea" open={taskModal} onCancel={() => setTaskModal(false)} onOk={() => taskForm.submit()} confirmLoading={createTask.isPending}>
        <Form form={taskForm} layout="vertical" initialValues={{ status: 'Waiting' }} onFinish={(values) => createTask.mutate({ ...values, dueDate: values.dueDate?.toISOString() })}>
          <Form.Item name="title" label="Título" rules={[{ required: true }]}><Input /></Form.Item>
          <Row gutter={12}>
            <Col span={12}><Form.Item name="group" label="Grupo"><Input placeholder="Email analysis" /></Form.Item></Col>
            <Col span={12}><Form.Item name="status" label="Estado"><Select options={TASK_STATUS.map((s) => ({ value: s, label: s }))} /></Form.Item></Col>
          </Row>
          <Form.Item name="description" label="Descripción"><Input.TextArea rows={3} /></Form.Item>
          <Row gutter={12}>
            <Col span={12}><Form.Item name="assignee" label="Cesionario"><Input placeholder="login@myhive.local" /></Form.Item></Col>
            <Col span={12}><Form.Item name="dueDate" label="Due date"><DatePicker showTime style={{ width: '100%' }} /></Form.Item></Col>
          </Row>
        </Form>
      </Modal>

      {/* Observable creation */}
      <Modal title="Añadir observables" open={obsModal} onCancel={() => setObsModal(false)} onOk={() => obsForm.submit()} confirmLoading={createObservables.isPending} width={640}>
        <Form form={obsForm} layout="vertical" initialValues={{ dataType: 'ip', tlp: 2, pap: 2, ioc: true }} onFinish={(values) => createObservables.mutate(values)}>
          <Row gutter={12}>
            <Col span={8}><Form.Item name="dataType" label="Tipo"><Select options={OBSERVABLE_TYPES.map((v) => ({ value: v, label: v }))} /></Form.Item></Col>
            <Col span={8}><Form.Item name="tlp" label="TLP"><Select options={TLP_OPTIONS} /></Form.Item></Col>
            <Col span={8}><Form.Item name="pap" label="PAP"><Select options={TLP_OPTIONS} /></Form.Item></Col>
          </Row>
          <Form.Item name="data" label="Valor(es)" rules={[{ required: true }]} extra="Un observable por línea">
            <Input.TextArea rows={5} placeholder="185.199.108.153&#10;evil.example" />
          </Form.Item>
          <Form.Item name="message" label="Mensaje"><Input placeholder="Contexto del observable" /></Form.Item>
          <Space>
            <Form.Item name="ioc" label="IOC" valuePropName="checked"><input type="checkbox" /></Form.Item>
            <Form.Item name="sighted" label="Sighted" valuePropName="checked"><input type="checkbox" /></Form.Item>
          </Space>
          <Form.Item name="tags" label="Tags"><Select mode="tags" /></Form.Item>
        </Form>
      </Modal>

      {/* Edit observable */}
      <Modal
        title="Editar observable" open={!!editingObs} onCancel={() => setEditingObs(null)}
        onOk={() => updateObservable.mutate({ id: editingObs.id, data: { message: editingObs.message, ioc: editingObs.ioc, sighted: editingObs.sighted, tags: editingObs.tags } })}
      >
        {editingObs && (
          <div>
            <Typography.Text strong>{editingObs.dataType}: {editingObs.data}</Typography.Text>
            <Input.TextArea style={{ marginTop: 12 }} rows={3} value={editingObs.message || ''} onChange={(e) => setEditingObs({ ...editingObs, message: e.target.value })} />
            <Space style={{ marginTop: 12 }}>
              <label><input type="checkbox" checked={!!editingObs.ioc} onChange={(e) => setEditingObs({ ...editingObs, ioc: e.target.checked })} /> IOC</label>
              <label><input type="checkbox" checked={!!editingObs.sighted} onChange={(e) => setEditingObs({ ...editingObs, sighted: e.target.checked })} /> Sighted</label>
            </Space>
            <Select mode="tags" style={{ width: '100%', marginTop: 12 }} placeholder="Tags" value={editingObs.tags || []} onChange={(tags) => setEditingObs({ ...editingObs, tags })} />
          </div>
        )}
      </Modal>

      {/* TTP creation */}
      <Modal
        title="Añadir TTP"
        open={ttpModal}
        onCancel={() => { setTtpModal(false); setTtpPattern(null); ttpForm.resetFields(); }}
        onOk={() => ttpForm.submit()}
        confirmLoading={createTtp.isPending}
      >
        <Form form={ttpForm} layout="vertical" onFinish={(values) => createTtp.mutate(values)}>
          <Form.Item name="patternId" label="Técnica" rules={[{ required: true }]}>
            <Select
              showSearch
              filterOption={false}
              loading={patternsQuery.isFetching}
              onSearch={setTtpSearchInput}
              placeholder="T1059.001 · PowerShell"
              onChange={(value, option: any) => {
                const selected = Array.isArray(option) ? option[0] : option;
                setTtpPattern(selected);
                const tactics = selected?.tactics || [];
                ttpForm.setFieldsValue({ tactic: tactics.length === 1 ? tactics[0] : undefined });
              }}
              options={(patternsQuery.data?.items || []).map((pattern: any) => ({
                value: pattern.patternId,
                label: `${pattern.patternId} · ${pattern.name}`,
                tactics: pattern.tactics || [],
              }))}
            />
          </Form.Item>
          <Row gutter={12}>
            <Col span={12}>
              <Form.Item name="tactic" label="Táctica">
                <Select
                  allowClear
                  placeholder={ttpPattern ? 'Selecciona una táctica' : 'Selecciona primero una técnica'}
                  disabled={!ttpPattern}
                  options={(ttpPattern?.tactics || []).map((value: string) => ({ value, label: value }))}
                />
              </Form.Item>
            </Col>
            <Col span={12}><Form.Item name="occurDate" label="Fecha"><DatePicker showTime style={{ width: '100%' }} /></Form.Item></Col>
          </Row>
          <Form.Item name="description" label="Procedimiento"><Input.TextArea rows={3} /></Form.Item>
        </Form>
      </Modal>

      {/* Edit case */}
      <Modal title="Editar caso" open={editModal} onCancel={() => setEditModal(false)} onOk={() => editForm.submit()} confirmLoading={patchCase.isPending} width={700}>
        <Form form={editForm} layout="vertical" onFinish={(values) => { patchCase.mutate(values); setEditModal(false); }}>
          <Form.Item name="title" label="Título" rules={[{ required: true }]}><Input /></Form.Item>
          <Form.Item name="description" label="Descripción"><Input.TextArea rows={5} /></Form.Item>
          <Form.Item name="summary" label="Summary"><Input.TextArea rows={2} /></Form.Item>
          <Row gutter={12}>
            <Col span={8}><Form.Item name="severity" label="Severidad"><Select options={SEVERITY_OPTIONS} /></Form.Item></Col>
            <Col span={8}><Form.Item name="tlp" label="TLP"><Select options={TLP_OPTIONS} /></Form.Item></Col>
            <Col span={8}><Form.Item name="pap" label="PAP"><Select options={TLP_OPTIONS} /></Form.Item></Col>
          </Row>
          <Form.Item name="tags" label="Tags"><Select mode="tags" /></Form.Item>
          <Form.Item name="assignee" label="Cesionario"><Input placeholder="login@myhive.local" /></Form.Item>
        </Form>
      </Modal>

      {/* Close case */}
      <Modal title="Cerrar caso" open={closeModal} onCancel={() => setCloseModal(false)} onOk={() => closeForm.submit()} confirmLoading={closeCase.isPending}>
        <Form form={closeForm} layout="vertical" initialValues={{ status: 'TruePositive' }} onFinish={(values) => closeCase.mutate(values)}>
          <Form.Item name="status" label="Resolución" rules={[{ required: true }]}>
            <Select options={['TruePositive', 'FalsePositive', 'Indeterminate', 'Duplicated', 'Other'].map((v) => ({ value: v, label: v }))} />
          </Form.Item>
          <Form.Item name="summary" label="Summary"><Input.TextArea rows={4} /></Form.Item>
        </Form>
      </Modal>

      {/* Merge */}
      <Modal title="Fusionar casos" open={mergeModal} onCancel={() => setMergeModal(false)} onOk={() => mergeCase.mutate(mergeForm.getFieldValue('ids') || [])} confirmLoading={mergeCase.isPending}>
        <Typography.Paragraph type="secondary">Se creará un caso nuevo y se moverán tareas, observables, TTPs y alertas.</Typography.Paragraph>
        <Form form={mergeForm} layout="vertical">
          <Form.Item name="ids" label="Casos a fusionar">
            <Select
              mode="multiple"
              options={(casesQuery.data?.items || []).filter((x: any) => x.id !== c.id).map((x: any) => ({ value: x.id, label: `#${x.number} · ${x.title}` }))}
            />
          </Form.Item>
        </Form>
      </Modal>

      <Modal title="Compartir caso" open={shareModal} onCancel={() => setShareModal(false)} onOk={() => shareForm.submit()} confirmLoading={addShare.isPending}>
        <Form form={shareForm} layout="vertical" initialValues={{ profile: 'read-only' }} onFinish={(values) => addShare.mutate(values)}>
          <Form.Item name="organisation" label="Organización" rules={[{ required: true }]}>
            <Select options={(orgsQuery.data || []).filter((o: any) => o.name !== user?.activeOrganisation).map((o: any) => ({ value: o.name, label: o.name }))} />
          </Form.Item>
          <Form.Item name="profile" label="Perfil">
            <Select options={(profilesQuery.data || []).filter((p: any) => p.type !== 'admin').map((p: any) => ({ value: p.name, label: p.name }))} />
          </Form.Item>
        </Form>
      </Modal>

      <TaskDrawer id={taskDrawer} onClose={() => setTaskDrawer(null)} canManage={can('manageTask')} />
      <ObservableIntelDrawer observable={intelObs} onClose={() => setIntelObsId(null)} onChanged={invalidate} />
      <AnalyzeModal observable={analyzeObs} open={!!analyzeObs} onClose={() => setAnalyzeObs(null)} onDone={invalidate} />
    </div>
  );
}


function TaskDrawer({ id, onClose, canManage }: { id: string | null; onClose: () => void; canManage: boolean }) {
  const qc = useQueryClient();
  const [log, setLog] = useState('');
  const taskQuery = useQuery({
    queryKey: ['task', id],
    queryFn: async () => (await api.get(`/tasks/${id}`)).data,
    enabled: !!id,
  });
  const addLog = useMutation({
    mutationFn: async () => (await api.post(`/tasks/${id}/logs`, { message: log })).data,
    onSuccess: () => { setLog(''); qc.invalidateQueries({ queryKey: ['task', id] }); qc.invalidateQueries({ queryKey: ['case'] }); message.success('Log añadido'); },
    onError: (e) => message.error(errorMessage(e)),
  });
  const patch = useMutation({
    mutationFn: async (data: any) => (await api.patch(`/tasks/${id}`, data)).data,
    onSuccess: () => { qc.invalidateQueries({ queryKey: ['task', id] }); qc.invalidateQueries({ queryKey: ['case'] }); },
    onError: (e) => message.error(errorMessage(e)),
  });
  const t = taskQuery.data;
  return (
    <Drawer title={t?.title || 'Tarea'} open={!!id} onClose={onClose} width={640} destroyOnClose>
      {taskQuery.isLoading ? <Spin /> : t && (
        <div>
          <Descriptions column={2} size="small" bordered style={{ marginBottom: 16 }}>
            <Descriptions.Item label="Estado"><StatusBadge value={t.status} /></Descriptions.Item>
            <Descriptions.Item label="Grupo">{t.group || '—'}</Descriptions.Item>
            <Descriptions.Item label="Cesionario">{t.assignee?.name || '—'}</Descriptions.Item>
            <Descriptions.Item label="Due date">{t.dueDate ? date(t.dueDate) : '—'}</Descriptions.Item>
            <Descriptions.Item label="Inicio">{t.startDate ? date(t.startDate) : '—'}</Descriptions.Item>
            <Descriptions.Item label="Fin">{t.endDate ? date(t.endDate) : '—'}</Descriptions.Item>
          </Descriptions>
          <Markdown>{t.description}</Markdown>
          {canManage && (
            <Space style={{ margin: '12px 0' }}>
              {t.status === 'Waiting' && <Button onClick={() => patch.mutate({ status: 'InProgress', startDate: new Date().toISOString() })}>Iniciar</Button>}
              {t.status !== 'Completed' && <Button type="primary" onClick={() => patch.mutate({ status: 'Completed', endDate: new Date().toISOString() })}>Completar</Button>}
              {t.status === 'Completed' && <Button onClick={() => patch.mutate({ status: 'InProgress', endDate: null })}>Reabrir</Button>}
              <RespondersButton target="task" objectId={t.id} />
            </Space>
          )}
          <Typography.Title level={5}>Logs</Typography.Title>
          <List
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
