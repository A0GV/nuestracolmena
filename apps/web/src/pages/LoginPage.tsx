import { useState } from 'react';
import { Navigate, useNavigate } from 'react-router-dom';
import { Alert, Button, Card, Form, Input, Typography, message } from 'antd';
import { LockOutlined, UserOutlined } from '@ant-design/icons';
import { useAuth } from '../lib/auth';
import { errorMessage } from '../lib/api';

// Muestra y precarga las cuentas demo del seed solo si se compila con VITE_DEMO_LOGIN=true.
const DEMO_LOGIN = import.meta.env.VITE_DEMO_LOGIN === 'true';

export default function LoginPage() {
  const { login, user } = useAuth();
  const navigate = useNavigate();
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  if (user) return <Navigate to="/cases" replace />;

  const onFinish = async (values: { login: string; password: string }) => {
    setLoading(true);
    setError(null);
    try {
      await login(values.login, values.password);
      message.success('Bienvenido a Nuestracolmena');
      navigate('/cases', { replace: true });
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="login-wrapper">
      <Card className="login-card" bordered={false}>
        <div style={{ textAlign: 'center', marginBottom: 20 }}>
          <div style={{ fontSize: 30, fontWeight: 800, color: '#1b1b34' }}>
            Nuestra<span style={{ color: '#54c1c2' }}>colmena</span>
          </div>
          <Typography.Text type="secondary">Security Incident Response Platform</Typography.Text>
        </div>
        {error && <Alert type="error" message={error} style={{ marginBottom: 16 }} showIcon />}
        <Form layout="vertical" onFinish={onFinish} initialValues={DEMO_LOGIN ? { login: 'admin@myhive.local', password: 'admin123' } : undefined}>
          <Form.Item name="login" label="Acceso" rules={[{ required: true }]}>
            <Input prefix={<UserOutlined />} placeholder="admin@myhive.local" autoComplete="username" />
          </Form.Item>
          <Form.Item name="password" label="Contraseña" rules={[{ required: true }]}>
            <Input.Password prefix={<LockOutlined />} placeholder="••••••••" autoComplete="current-password" />
          </Form.Item>
          <Button type="primary" htmlType="submit" block loading={loading} size="large">
            Entrar
          </Button>
        </Form>
        {DEMO_LOGIN && (
          <div style={{ marginTop: 18, fontSize: 12, color: '#8c8c9a', lineHeight: 1.7 }}>
            Demo: <b>admin@myhive.local / admin123</b><br />
            Analista: <b>analyst@myhive.local / analyst123</b><br />
            Solo lectura: <b>readonly@myhive.local / readonly123</b>
          </div>
        )}
      </Card>
    </div>
  );
}
