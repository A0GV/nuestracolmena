import { useParams, useNavigate } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { Button, Card, Col, Empty, Row, Spin, Statistic, Tag, Typography } from 'antd';
import { ArrowLeftOutlined } from '@ant-design/icons';
import { Bar, BarChart, CartesianGrid, Cell, Legend, Pie, PieChart, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts';
import { api } from '../lib/api';

const COLORS = ['#54c1c2', '#faad14', '#d0021b', '#4a90e2', '#52c41a', '#a7a7b6', '#722ed1', '#eb7033'];

export default function DashboardViewPage() {
  const { id } = useParams();
  const navigate = useNavigate();
  const dashboards = useQuery({ queryKey: ['dashboards'], queryFn: async () => (await api.get('/dashboards')).data });
  const stats = useQuery({ queryKey: ['stats'], queryFn: async () => (await api.get('/stats')).data });
  const dashboard = (dashboards.data || []).find((d: any) => d.id === id);

  if (dashboards.isLoading || stats.isLoading) return <Spin size="large" style={{ display: 'block', margin: '80px auto' }} />;
  if (!dashboard) return <Empty description="Dashboard no encontrado" />;

  const s = stats.data || {};
  const renderWidget = (widget: any) => {
    if (widget.type === 'cases-by-status') {
      const data = Object.entries(s.cases?.byStatus || {}).map(([name, value]) => ({ name, value }));
      return <PieWidget title={widget.title} data={data} />;
    }
    if (widget.type === 'cases-by-severity') {
      const data = Object.entries(s.cases?.bySeverity || {}).map(([name, value]) => ({ name: `Sev ${name}`, value }));
      return <PieWidget title={widget.title} data={data} />;
    }
    if (widget.type === 'alerts-by-stage') {
      const data = (s.alerts || []).map((a: any) => ({ name: a.stage, value: a.count }));
      return <BarWidget title={widget.title} data={data} />;
    }
    if (widget.type === 'observables-by-type') {
      const data = (s.observables || []).map((o: any) => ({ name: o.type, value: o.count }));
      return <BarWidget title={widget.title} data={data} />;
    }
    if (widget.type === 'tasks-by-status') {
      const data = (s.tasks || []).map((t: any) => ({ name: t.status, value: t.count }));
      return <BarWidget title={widget.title} data={data} />;
    }
    return <Card key={widget.id} title={widget.title}>Widget no soportado: {widget.type}</Card>;
  };

  return (
    <div>
      <div className="page-header">
        <div>
          <Button icon={<ArrowLeftOutlined />} onClick={() => navigate('/dashboards')} style={{ marginBottom: 8 }}>Dashboards</Button>
          <h1 className="page-title">{dashboard.name}</h1>
          <span style={{ color: '#8c8c9a' }}>{dashboard.description}</span>
        </div>
        <Tag color="cyan">{dashboard.visibility}</Tag>
      </div>
      <Row gutter={12} style={{ marginBottom: 12 }}>
        <Col xs={12} md={6}><Card size="small"><Statistic title="Casos" value={s.cases?.total || 0} /></Card></Col>
        <Col xs={12} md={6}><Card size="small"><Statistic title="Tareas" value={(s.tasks || []).reduce((a: number, x: any) => a + x.count, 0)} /></Card></Col>
        <Col xs={12} md={6}><Card size="small"><Statistic title="Observables" value={(s.observables || []).reduce((a: number, x: any) => a + x.count, 0)} /></Card></Col>
        <Col xs={12} md={6}><Card size="small"><Statistic title="Alertas" value={(s.alerts || []).reduce((a: number, x: any) => a + x.count, 0)} /></Card></Col>
      </Row>
      <Row gutter={[12, 12]}>
        {(dashboard.widgets || []).map((w: any) => (
          <Col xs={24} md={12} key={w.id}>{renderWidget(w)}</Col>
        ))}
      </Row>
      {(dashboard.widgets || []).length === 0 && <Empty description="Sin widgets" />}
    </div>
  );
}

function PieWidget({ title, data }: { title: string; data: any[] }) {
  return (
    <Card size="small" title={title}>
      {data.length === 0 ? <Empty description="Sin datos" /> : (
        <ResponsiveContainer width="100%" height={260}>
          <PieChart>
            <Pie data={data} dataKey="value" nameKey="name" outerRadius={90} label>
              {data.map((_, i) => <Cell key={i} fill={COLORS[i % COLORS.length]} />)}
            </Pie>
            <Tooltip />
            <Legend />
          </PieChart>
        </ResponsiveContainer>
      )}
    </Card>
  );
}

function BarWidget({ title, data }: { title: string; data: any[] }) {
  return (
    <Card size="small" title={title}>
      {data.length === 0 ? <Empty description="Sin datos" /> : (
        <ResponsiveContainer width="100%" height={260}>
          <BarChart data={data}>
            <CartesianGrid strokeDasharray="3 3" />
            <XAxis dataKey="name" />
            <YAxis allowDecimals={false} />
            <Tooltip />
            <Bar dataKey="value" fill="#54c1c2" radius={[4, 4, 0, 0]} />
          </BarChart>
        </ResponsiveContainer>
      )}
    </Card>
  );
}
