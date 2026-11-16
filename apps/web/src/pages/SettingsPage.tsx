import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Button, Card, Descriptions, Form, Input, List, Space, Tag, Typography, message } from 'antd';
import { KeyOutlined, LockOutlined, UserOutlined } from '@ant-design/icons';
import { api, errorMessage } from '../lib/api';
import { useAuth } from '../lib/auth';

export default function SettingsPage() {
  const { user, refresh } = useAuth();
  const qc = useQueryClient();
  const [passwordForm] = Form.useForm();
  const [keyForm] = Form.useForm();
  const [newKey, setNewKey] = useState<string | null>(null);

  const keys = useQuery({ queryKey: ['api-keys'], queryFn: async () => (await api.get('/auth/api-keys')).data });

  const changePassword = useMutation({
    mutationFn: async (values: any) => (await api.post('/auth/password', values)).data,
    onSuccess: () => { message.success('Contraseña actualizada'); passwordForm.resetFields(); },
    onError: (e) => message.error(errorMessage(e)),
  });
  const createKey = useMutation({
    mutationFn: async (values: any) => (await api.post('/auth/api-keys', values)).data,
    onSuccess: (data) => { setNewKey(data.key); keyForm.resetFields(); qc.invalidateQueries({ queryKey: ['api-keys'] }); },
    onError: (e) => message.error(errorMessage(e)),
  });
  const revokeKey = useMutation({
    mutationFn: async (id: string) => (await api.delete(`/auth/api-keys/${id}`)).data,
    onSuccess: () => { message.success('API key revocada'); qc.invalidateQueries({ queryKey: ['api-keys'] }); },
    onError: (e) => message.error(errorMessage(e)),
  });

  return (
    <div>
      <div className="page-header"><h1 className="page-title">Ajustes de cuenta</h1></div>
      <div style={{ display: 'grid', gridTemplateColumns: 'minmax(0, 1fr) minmax(0, 1fr)', gap: 12 }}>
        <Card size="small" title={<span><UserOutlined /> Perfil</span>}>
          <Descriptions column={1} size="small">
            <Descriptions.Item label="Nombre">{user?.name}</Descriptions.Item>
            <Descriptions.Item label="Login">{user?.login}</Descriptions.Item>
            <Descriptions.Item label="Email">{user?.email || '—'}</Descriptions.Item>
            <Descriptions.Item label="Tipo">{user?.type || 'normal'}</Descriptions.Item>
            <Descriptions.Item label="Organización activa">{user?.activeOrganisation}</Descriptions.Item>
            <Descriptions.Item label="Perfil">{user?.profile}</Descriptions.Item>
            <Descriptions.Item label="Organizaciones">
              {(user?.organisations || []).map((o) => <Tag key={o.id}>{o.name} / {o.profile}</Tag>)}
            </Descriptions.Item>
          </Descriptions>
          <Typography.Title level={5}>Permisos</Typography.Title>
          <Space wrap>{(user?.permissions || []).map((p) => <Tag key={p}>{p}</Tag>)}</Space>
        </Card>

        <Card size="small" title={<span><LockOutlined /> Cambiar contraseña</span>}>
          <Form form={passwordForm} layout="vertical" onFinish={(v) => changePassword.mutate(v)}>
            <Form.Item name="currentPassword" label="Contraseña actual" rules={[{ required: true }]}><Input.Password /></Form.Item>
            <Form.Item name="newPassword" label="Nueva contraseña" rules={[{ required: true, min: 8 }]}><Input.Password /></Form.Item>
            <Button type="primary" htmlType="submit" loading={changePassword.isPending}>Actualizar contraseña</Button>
          </Form>
        </Card>

        <Card size="small" title={<span><KeyOutlined /> API keys</span>} style={{ gridColumn: '1 / -1' }}>
          <Form form={keyForm} layout="inline" onFinish={(v) => createKey.mutate(v)} style={{ marginBottom: 16 }}>
            <Form.Item name="name" rules={[{ required: true }]}><Input placeholder="Nombre de la key" /></Form.Item>
            <Button type="primary" htmlType="submit" loading={createKey.isPending}>Crear key</Button>
          </Form>
          {newKey && (
            <Card size="small" style={{ marginBottom: 12, background: '#f6ffed' }}>
              <Typography.Text strong>Copia esta API key ahora; no se volverá a mostrar:</Typography.Text>
              <Input value={newKey} readOnly style={{ marginTop: 8, fontFamily: 'monospace' }} />
            </Card>
          )}
          <List
            dataSource={keys.data || []}
            locale={{ emptyText: 'Sin API keys' }}
            renderItem={(k: any) => (
              <List.Item actions={[<Button key="revoke" danger size="small" onClick={() => revokeKey.mutate(k.id)}>Revocar</Button>]}>
                <List.Item.Meta title={k.name} description={`${k.prefix}… · creada ${new Date(k.createdAt).toLocaleString()}`} />
              </List.Item>
            )}
          />
        </Card>
      </div>
    </div>
  );
}
