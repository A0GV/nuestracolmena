import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Button, Card, Col, Empty, Form, Input, Modal, Row, Space, Statistic, Tag, Typography, message } from 'antd';
import { DashboardOutlined, PlusOutlined } from '@ant-design/icons';
import { api, errorMessage } from '../lib/api';
import { useAuth } from '../lib/auth';
import { date } from '../lib/format';

export default function DashboardsPage() {
  const navigate = useNavigate();
  const qc = useQueryClient();
  const { can } = useAuth();
  const [open, setOpen] = useState(false);
  const [form] = Form.useForm();
  const dashboards = useQuery({ queryKey: ['dashboards'], queryFn: async () => (await api.get('/dashboards')).data });
  const slaSummary = useQuery({ queryKey: ['sla-summary-dashboard'], queryFn: async () => (await api.get('/sla/summary')).data });
  const attackStats = useQuery({ queryKey: ['procedures-stats', 90], queryFn: async () => (await api.get('/procedures/stats', { params: { days: 90 } })).data });
  const create = useMutation({
    mutationFn: async (values: any) => (await api.post('/dashboards', values)).data,
    onSuccess: (d) => { message.success('Dashboard creado'); setOpen(false); form.resetFields(); qc.invalidateQueries({ queryKey: ['dashboards'] }); navigate(`/dashboards/${d.id}`); },
    onError: (e) => message.error(errorMessage(e)),
  });

  return (
    <div>
      <div className="page-header">
        <div>
          <h1 className="page-title">Dashboards</h1>
          <span style={{ color: '#8c8c9a' }}>{dashboards.data?.length ?? 0} cuadros de mando</span>
        </div>
        {can('manageDashboard') && <Button type="primary" icon={<PlusOutlined />} onClick={() => setOpen(true)}>Crear dashboard</Button>}
      </div>
      <Card size="small" title="Cumplimiento SLA (últimos 30 días)" style={{ marginBottom: 12 }} loading={slaSummary.isLoading}>
        <Row gutter={12}>
          <Col xs={12} md={6}>
            <Statistic title="Acuse" value={slaSummary.data?.overall?.acknowledge?.total ? slaSummary.data.overall.acknowledge.compliance : '—'} suffix={slaSummary.data?.overall?.acknowledge?.total ? '%' : ''} />
            <Typography.Text type="secondary">{(slaSummary.data?.overall?.acknowledge?.metOnTime || 0)} a tiempo · {(slaSummary.data?.overall?.acknowledge?.metLate || 0)} tarde</Typography.Text>
          </Col>
          <Col xs={12} md={6}>
            <Statistic title="Resolución" value={slaSummary.data?.overall?.resolve?.total ? slaSummary.data.overall.resolve.compliance : '—'} suffix={slaSummary.data?.overall?.resolve?.total ? '%' : ''} />
            <Typography.Text type="secondary">{(slaSummary.data?.overall?.resolve?.metOnTime || 0)} a tiempo · {(slaSummary.data?.overall?.resolve?.metLate || 0)} tarde</Typography.Text>
          </Col>
          <Col xs={12} md={6}>
            <Statistic title="Vencidos abiertos" value={(slaSummary.data?.overall?.acknowledge?.breachedOpen || 0) + (slaSummary.data?.overall?.resolve?.breachedOpen || 0)} valueStyle={{ color: '#d0021b' }} />
          </Col>
          <Col xs={12} md={6}>
            <Statistic title="Objetos medidos" value={slaSummary.data?.overall?.resolve?.total || slaSummary.data?.overall?.acknowledge?.total || 0} />
            <Typography.Text type="secondary">Reglas configuradas</Typography.Text>
          </Col>
        </Row>
      </Card>
      <Card size="small" title="ATT&CK (últimos 90 días)" style={{ marginBottom: 12 }} loading={attackStats.isLoading}>
        {(attackStats.data?.items || []).length === 0 ? (
          <Typography.Text type="secondary">Sin técnicas registradas en los últimos 90 días.</Typography.Text>
        ) : (
          <Space direction="vertical" style={{ width: '100%' }} size={4}>
            {(attackStats.data?.items || []).map((item: any, index: number) => (
              <div key={item.patternId} style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12 }}>
                <span>
                  <Typography.Text type="secondary" style={{ marginRight: 8 }}>{index + 1}.</Typography.Text>
                  <a href={`https://attack.mitre.org/techniques/${String(item.patternId).replace(/\./g, '/')}/`} target="_blank" rel="noreferrer"><b>{item.patternId}</b></a>
                  {' · '}{item.patternName || '—'}
                  {item.tactic && <Tag style={{ marginLeft: 8 }}>{item.tactic}</Tag>}
                </span>
                <Tag color="red">{item.caseCount} caso(s)</Tag>
              </div>
            ))}
          </Space>
        )}
      </Card>
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(300px, 1fr))', gap: 12 }}>
        {(dashboards.data || []).map((d: any) => (
          <Card key={d.id} hoverable onClick={() => navigate(`/dashboards/${d.id}`)} title={<Space><DashboardOutlined />{d.name}</Space>}
            extra={<Tag color="cyan">{d.widgets?.length || 0} widgets</Tag>}>
            <Typography.Paragraph type="secondary" ellipsis={{ rows: 2 }}>{d.description || 'Sin descripción'}</Typography.Paragraph>
            <div style={{ fontSize: 12, color: '#8c8c9a' }}>Creado {date(d.createdAt)}</div>
          </Card>
        ))}
        {!dashboards.isLoading && (dashboards.data || []).length === 0 && <Empty description="No hay dashboards" />}
      </div>
      <Modal title="Crear dashboard" open={open} onCancel={() => setOpen(false)} onOk={() => form.submit()} confirmLoading={create.isPending}>
        <Form form={form} layout="vertical" onFinish={(v) => create.mutate({
          ...v,
          widgets: [
            { type: 'cases-by-status', title: 'Cases by status' },
            { type: 'cases-by-severity', title: 'Cases by severity' },
            { type: 'alerts-by-stage', title: 'Alerts by stage' },
            { type: 'observables-by-type', title: 'Observables by type' },
          ],
        })}>
          <Form.Item name="name" label="Nombre" rules={[{ required: true }]}><Input /></Form.Item>
          <Form.Item name="description" label="Descripción"><Input.TextArea rows={2} /></Form.Item>
        </Form>
      </Modal>
    </div>
  );
}
