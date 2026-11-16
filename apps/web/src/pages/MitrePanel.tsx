import { useEffect, useMemo, useRef, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  Alert, Button, Card, Form, Input, Modal, Progress, Select, Space, Switch, Table, Tag, Typography, Upload, message,
} from 'antd';
import { CloudDownloadOutlined, UploadOutlined } from '@ant-design/icons';
import { api, errorMessage } from '../lib/api';
import { useAuth } from '../lib/auth';
import { date } from '../lib/format';

const DEFAULT_URL = 'https://raw.githubusercontent.com/mitre/cti/master/enterprise-attack/enterprise-attack.json';

function attackUrl(patternId: string) {
  return `https://attack.mitre.org/techniques/${String(patternId).replace(/\./g, '/')}/`;
}

export default function MitrePanel() {
  const qc = useQueryClient();
  const { can } = useAuth();
  const [searchInput, setSearchInput] = useState('');
  const [search, setSearch] = useState('');
  const [tactic, setTactic] = useState<string | undefined>();
  const [includeRevoked, setIncludeRevoked] = useState(false);
  const [importOpen, setImportOpen] = useState(false);
  const [importFile, setImportFile] = useState<any>(null);
  const [jobId, setJobId] = useState<string | null>(null);
  const handledJob = useRef<string | null>(null);
  const [form] = Form.useForm();

  const tactics = useQuery({ queryKey: ['tactics'], queryFn: async () => (await api.get('/tactics')).data });
  const patterns = useQuery({
    queryKey: ['patterns', 'admin', { search, tactic, includeRevoked }],
    queryFn: async () => (await api.get('/patterns', { params: { search, tactic, includeRevoked, limit: 2000, offset: 0 } })).data,
  });
  const jobs = useQuery({ queryKey: ['jobs'], queryFn: async () => (await api.get('/jobs')).data });
  const importJob = useQuery({
    queryKey: ['mitre-import-job', jobId],
    queryFn: async () => (await api.get(`/patterns/import/${jobId}`)).data,
    enabled: !!jobId,
    refetchInterval: (q) => {
      const status = (q.state.data as any)?.status;
      return status === 'pending' || status === 'running' ? 1500 : false;
    },
  });

  const startImport = useMutation({
    mutationFn: async () => {
      const values = await form.validateFields();
      if (importFile) {
        const body = new FormData();
        body.append('file', importFile);
        if (values.url) body.append('url', values.url);
        return (await api.post('/patterns/import', body)).data;
      }
      return (await api.post('/patterns/import', { url: values.url || DEFAULT_URL })).data;
    },
    onSuccess: (result) => {
      setImportFile(null);
      setJobId(result.jobId);
      message.success('Importación iniciada');
      qc.invalidateQueries({ queryKey: ['jobs'] });
    },
    onError: (e) => message.error(errorMessage(e)),
  });

  const jobStatus = importJob.data?.status;
  useEffect(() => {
    if (!jobId || handledJob.current === jobId) return;
    if (jobStatus === 'Success' || jobStatus === 'Failure') {
      handledJob.current = jobId;
      qc.invalidateQueries({ queryKey: ['patterns'] });
      qc.invalidateQueries({ queryKey: ['tactics'] });
      qc.invalidateQueries({ queryKey: ['jobs'] });
      if (jobStatus === 'Success') message.success('Catálogo MITRE ATT&CK importado');
      else message.error(importJob.data?.result?.error || 'La importación falló');
    }
  }, [jobId, jobStatus, importJob.data]);

  const rows = useMemo(() => {
    const items: any[] = patterns.data?.items || (Array.isArray(patterns.data) ? patterns.data : []);
    const byId = new Map<string, any>(items.map((item: any) => [item.patternId, { ...item, key: item.id, children: [] as any[] }]));
    const roots: any[] = [];
    for (const item of byId.values()) {
      if (item.isSubtechnique && item.parentPatternId && byId.has(item.parentPatternId)) {
        byId.get(item.parentPatternId).children.push(item);
      } else {
        roots.push(item);
      }
    }
    const sort = (list: any[]) => {
      list.sort((a, b) => String(a.patternId).localeCompare(String(b.patternId)));
      list.forEach((item) => item.children?.length ? sort(item.children) : undefined);
      return list;
    };
    return sort(roots);
  }, [patterns.data]);

  const lastImport = (jobs.data || []).find((job: any) => job.type === 'mitre-import');
  const job = importJob.data;
  const progress = job?.result?.progress;
  const percent = progress?.total ? Math.round((progress.processed / progress.total) * 100) : jobStatus === 'Success' ? 100 : 0;

  return (
    <Card
      size="small"
      title="Catálogo MITRE ATT&CK"
      extra={can('managePattern') && (
        <Button type="primary" size="small" icon={<CloudDownloadOutlined />} onClick={() => { form.setFieldsValue({ url: DEFAULT_URL }); setImportOpen(true); }}>
          Importar catálogo MITRE ATT&CK
        </Button>
      )}
    >
      <Space wrap style={{ marginBottom: 12 }}>
        <Input.Search placeholder="Buscar técnica o ID" allowClear value={searchInput} onChange={(e) => setSearchInput(e.target.value)} onSearch={(value) => setSearch(value)} style={{ width: 260 }} />
        <Select
          allowClear showSearch optionFilterProp="label" placeholder="Táctica" style={{ width: 220 }}
          value={tactic} onChange={setTactic}
          options={(tactics.data || []).map((item: any) => ({ value: item.name, label: `${item.name} (${item.shortName})` }))}
        />
        <Space size={6}>
          <Switch size="small" checked={includeRevoked} onChange={setIncludeRevoked} />
          <Typography.Text>Mostrar revocados</Typography.Text>
        </Space>
        <Typography.Text type="secondary">{patterns.data?.total ?? rows.length} técnicas</Typography.Text>
      </Space>
      <Table
        rowKey="id"
        size="small"
        loading={patterns.isLoading}
        dataSource={rows}
        pagination={{ pageSize: 20, showSizeChanger: false }}
        columns={[
          { title: 'Técnica', dataIndex: 'patternId', width: 130, render: (value: string) => <a href={attackUrl(value)} target="_blank" rel="noreferrer">{value}</a> },
          { title: 'Nombre', dataIndex: 'name' },
          { title: 'Tácticas', dataIndex: 'tactics', render: (value: string[]) => (value || []).map((item) => <Tag key={item}>{item}</Tag>) },
          { title: 'Plataformas', dataIndex: 'platforms', width: 180, render: (value: string[]) => (value || []).slice(0, 3).map((item) => <Tag key={item}>{item}</Tag>) },
          { title: 'Estado', dataIndex: 'revoked', width: 100, render: (value: boolean) => value ? <Tag color="red">Revocado</Tag> : <Tag color="green">Vigente</Tag> },
        ]}
      />
      {lastImport && (
        <Typography.Paragraph type="secondary" style={{ marginTop: 12, marginBottom: 0 }}>
          Última importación: {date(lastImport.finishedAt || lastImport.createdAt)} · {lastImport.status}
          {lastImport.result?.created !== undefined ? ` · ${lastImport.result.created} creadas, ${lastImport.result.updated} actualizadas` : ''}
        </Typography.Paragraph>
      )}

      <Modal
        title="Importar catálogo MITRE ATT&CK"
        open={importOpen}
        onCancel={() => setImportOpen(false)}
        onOk={() => startImport.mutate()}
        okText="Importar"
        confirmLoading={startImport.isPending}
      >
        <Form form={form} layout="vertical">
          <Form.Item name="url" label="URL del bundle STIX 2.x">
            <Input placeholder={DEFAULT_URL} />
          </Form.Item>
          <Form.Item label="… o sube un fichero JSON">
            <Upload
              accept=".json,application/json"
              maxCount={1}
              beforeUpload={(file) => { setImportFile(file); return false; }}
              onRemove={() => setImportFile(null)}
              fileList={importFile ? [importFile] : []}
            >
              <Button icon={<UploadOutlined />}>Seleccionar fichero</Button>
            </Upload>
          </Form.Item>
        </Form>
        {jobId && (
          <Alert
            type={jobStatus === 'Failure' ? 'error' : jobStatus === 'Success' ? 'success' : 'info'}
            showIcon
            message={jobStatus === 'Failure' ? 'Importación fallida' : jobStatus === 'Success' ? 'Importación completada' : 'Importando catálogo…'}
            description={(
              <div>
                <Progress percent={percent} status={jobStatus === 'Failure' ? 'exception' : jobStatus === 'Success' ? 'success' : 'active'} />
                {job?.result?.error && <Typography.Text type="danger">{job.result.error}</Typography.Text>}
                {jobStatus === 'Success' && (
                  <Typography.Text>
                    {job.result?.tactics} tácticas · {job.result?.techniques} técnicas · {job.result?.subtechniques} sub-técnicas · {job.result?.revoked} revocadas · {job.result?.created} creadas · {job.result?.updated} actualizadas
                  </Typography.Text>
                )}
              </div>
            )}
          />
        )}
      </Modal>
    </Card>
  );
}
