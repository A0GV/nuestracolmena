import { useMemo, useState } from 'react';
import { useSearchParams, useNavigate } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  Alert, Button, Card, Col, Descriptions, Form, Input, List, Modal, Popconfirm, Row, Select, Space, Statistic,
  Table, Tabs, Tag, Tooltip, Typography, message,
} from 'antd';
import {
  DeleteOutlined, KeyOutlined, LockOutlined, PlusOutlined, ReloadOutlined, SettingOutlined,
  TeamOutlined, UnlockOutlined, UserOutlined,
} from '@ant-design/icons';
import { api, errorMessage } from '../lib/api';
import { useAuth } from '../lib/auth';
import { date } from '../lib/format';
import IntegrationsPanel from './IntegrationsPanel';
import AutomationPanel from './AutomationPanel';
import MitrePanel from './MitrePanel';
import EmailFeedersPanel from './EmailFeedersPanel';

export default function AdminPage() {
  const [params, setParams] = useSearchParams();
  const navigate = useNavigate();
  const qc = useQueryClient();
  const { can, user } = useAuth();
  const requestedTab = params.get('tab');
  const [modal, setModal] = useState<string | null>(null);
  const [resetFor, setResetFor] = useState<any>(null);
  const [keysFor, setKeysFor] = useState<any>(null);
  const [keyName, setKeyName] = useState('');
  const [newKey, setNewKey] = useState<string | null>(null);
  const [form] = Form.useForm();
  const [resetForm] = Form.useForm();

  const canManagePlatformUsers = can('manageUser');
  const canManageOrgUsers = can('manageUser') || can('manageUser/org');

  const orgs = useQuery({ queryKey: ['organisations'], queryFn: async () => (await api.get('/organisations')).data });
  const users = useQuery({ queryKey: ['users'], queryFn: async () => (await api.get('/users')).data, enabled: canManagePlatformUsers });
  const activeOrg = (orgs.data || []).find((o: any) => o.name === user?.activeOrganisation);
  const activeOrgId = activeOrg?.id;
  const orgUsers = useQuery({
    queryKey: ['org-users', activeOrgId],
    queryFn: async () => (await api.get(`/organisations/${activeOrgId}/users`)).data,
    enabled: canManageOrgUsers && !!activeOrgId,
  });
  const profiles = useQuery({ queryKey: ['profiles'], queryFn: async () => (await api.get('/profiles')).data });
  const caseStatuses = useQuery({ queryKey: ['case-statuses'], queryFn: async () => (await api.get('/case-statuses')).data });
  const alertStatuses = useQuery({ queryKey: ['alert-statuses'], queryFn: async () => (await api.get('/alert-statuses')).data });
  const customFields = useQuery({ queryKey: ['custom-fields'], queryFn: async () => (await api.get('/custom-fields')).data });
  const tags = useQuery({ queryKey: ['tags'], queryFn: async () => (await api.get('/tags')).data });
  const templates = useQuery({ queryKey: ['templates'], queryFn: async () => (await api.get('/templates')).data });
  const audit = useQuery({ queryKey: ['audit'], queryFn: async () => (await api.get('/audit')).data, enabled: can('manageConfig') });
  const license = useQuery({ queryKey: ['license'], queryFn: async () => (await api.get('/license')).data });
  const platform = useQuery({ queryKey: ['platform'], queryFn: async () => (await api.get('/platform/status')).data });
  const userKeys = useQuery({
    queryKey: ['org-user-api-keys', activeOrgId, keysFor?.userId],
    queryFn: async () => (await api.get(`/organisations/${activeOrgId}/users/${keysFor.userId}/api-keys`)).data,
    enabled: !!activeOrgId && !!keysFor?.userId,
  });

  const userRows = useMemo(() => {
    if (canManagePlatformUsers) {
      return (users.data || []).map((row: any) => {
        const membership = (row.memberships || []).find((m: any) => m.organisationId === activeOrgId)
          || (row.memberships || []).find((m: any) => m.organisation?.name === user?.activeOrganisation);
        return {
          ...row,
          _userId: row.id,
          _rowKey: row.id,
          _profile: membership?.profile?.name,
          _memberships: row.memberships || [],
          _inActiveOrg: !!membership,
          _platformAdmin: (row.memberships || []).some((m: any) => m.profile?.type === 'admin'),
        };
      });
    }
    return (orgUsers.data || []).map((membership: any) => ({
      ...membership.user,
      _userId: membership.userId,
      _rowKey: membership.id,
      _profile: membership.profile?.name,
      _memberships: [membership],
      _inActiveOrg: true,
      _platformAdmin: !!membership.platformAdmin,
    }));
  }, [canManagePlatformUsers, users.data, orgUsers.data, activeOrgId, user?.activeOrganisation]);

  const refreshUsers = () => {
    qc.invalidateQueries({ queryKey: ['users'] });
    qc.invalidateQueries({ queryKey: ['org-users'] });
  };

  const create = useMutation({
    mutationFn: async ({ kind, values }: any) => {
      if (kind === 'org') return (await api.post('/organisations', values)).data;
      if (kind === 'user') {
        const organisationId = values.organisationId || activeOrgId;
        return (await api.post(`/organisations/${organisationId}/users`, { ...values, organisationId })).data;
      }
      if (kind === 'custom-field') return (await api.post('/custom-fields', values)).data;
      if (kind === 'tag') return (await api.post('/tags', values)).data;
      if (kind === 'template') return (await api.post('/templates', values)).data;
      if (kind === 'case-status') return (await api.post('/case-statuses', values)).data;
      if (kind === 'alert-status') return (await api.post('/alert-statuses', values)).data;
    },
    onSuccess: () => {
      message.success('Creado');
      setModal(null);
      form.resetFields();
      qc.invalidateQueries();
    },
    onError: (e) => message.error(errorMessage(e)),
  });

  const updateOrgUser = useMutation({
    mutationFn: async ({ userId, data }: any) => (await api.patch(`/organisations/${activeOrgId}/users/${userId}`, data)).data,
    onSuccess: () => { message.success('Usuario actualizado'); refreshUsers(); },
    onError: (e) => message.error(errorMessage(e)),
  });
  const resetPassword = useMutation({
    mutationFn: async ({ userId, password }: any) => (await api.post(`/organisations/${activeOrgId}/users/${userId}/password`, { password })).data,
    onSuccess: () => { message.success('Contraseña restablecida'); setResetFor(null); resetForm.resetFields(); },
    onError: (e) => message.error(errorMessage(e)),
  });
  const removeOrgUser = useMutation({
    mutationFn: async (userId: string) => (await api.delete(`/organisations/${activeOrgId}/users/${userId}`)).data,
    onSuccess: () => { message.success('Usuario eliminado de la organización'); refreshUsers(); },
    onError: (e) => message.error(errorMessage(e)),
  });
  const createUserKey = useMutation({
    mutationFn: async ({ userId, name }: any) => (await api.post(`/organisations/${activeOrgId}/users/${userId}/api-keys`, { name })).data,
    onSuccess: (data) => {
      setNewKey(data.key);
      setKeyName('');
      qc.invalidateQueries({ queryKey: ['org-user-api-keys', activeOrgId, keysFor?.userId] });
    },
    onError: (e) => message.error(errorMessage(e)),
  });
  const revokeUserKey = useMutation({
    mutationFn: async ({ userId, keyId }: any) => (await api.delete(`/organisations/${activeOrgId}/users/${userId}/api-keys/${keyId}`)).data,
    onSuccess: () => { message.success('API key revocada'); qc.invalidateQueries({ queryKey: ['org-user-api-keys', activeOrgId, keysFor?.userId] }); },
    onError: (e) => message.error(errorMessage(e)),
  });

  const openCreate = (kind: string) => {
    setModal(kind);
    form.resetFields();
    if (kind === 'case-status') form.setFieldsValue({ stage: 'New', order: 0, colour: '#4a90e2' });
    if (kind === 'alert-status') form.setFieldsValue({ stage: 'New', order: 0, colour: '#4a90e2' });
    if (kind === 'custom-field') form.setFieldsValue({ type: 'string', order: 0 });
    if (kind === 'template') form.setFieldsValue({ severity: 2, tlp: 2, pap: 2 });
    if (kind === 'user') form.setFieldsValue({ profile: 'analyst', organisationId: activeOrgId });
  };

  const items = useMemo(() => {
    const list: any[] = [];
    if (can('manageOrganisation')) list.push({
      key: 'organisations', label: <span><TeamOutlined /> Organizaciones</span>,
      children: (
        <Card size="small" extra={<Button type="primary" size="small" icon={<PlusOutlined />} onClick={() => openCreate('org')}>Nueva organización</Button>}>
          <Table rowKey="id" size="small" dataSource={orgs.data || []} pagination={false}
            columns={[
              { title: 'Nombre', dataIndex: 'name', render: (v: string, r: any) => <Space><a onClick={() => navigate(`/admin?tab=users&org=${r.id}`)}>{v}</a>{r.locked && <Tag>locked</Tag>}</Space> },
              { title: 'Descripción', dataIndex: 'description' },
              { title: 'Usuarios', render: (_: any, r: any) => r._count?.users ?? 0, width: 100 },
              { title: 'Casos', render: (_: any, r: any) => r._count?.cases ?? 0, width: 90 },
              { title: 'Creada', dataIndex: 'createdAt', width: 170, render: (v: string) => date(v) },
            ]} />
        </Card>
      ),
    });
    if (canManageOrgUsers) list.push({
      key: 'users', label: <span><UserOutlined /> Usuarios</span>,
      children: (
        <Card
          size="small"
          title={activeOrg ? `Usuarios de ${activeOrg.name}` : undefined}
          extra={<Button type="primary" size="small" icon={<PlusOutlined />} onClick={() => openCreate('user')}>Nuevo usuario</Button>}
        >
          <Table
            rowKey="_rowKey" size="small" dataSource={userRows} pagination={{ pageSize: 20 }}
            loading={canManagePlatformUsers ? users.isLoading : orgUsers.isLoading}
            columns={[
              { title: 'Nombre', dataIndex: 'name' },
              { title: 'Login', dataIndex: 'login' },
              { title: 'Tipo', dataIndex: 'type', width: 100 },
              {
                title: 'Organizaciones',
                render: (_: any, r: any) => (r._memberships || []).map((m: any) => (
                  <Tag key={m.id}>{m.organisation?.name || activeOrg?.name}/{m.profile?.name || r._profile}</Tag>
                )),
              },
              { title: 'Estado', dataIndex: 'locked', width: 100, render: (v: boolean) => v ? <Tag color="red">Locked</Tag> : <Tag color="green">Activo</Tag> },
              { title: 'Creado', dataIndex: 'createdAt', width: 170, render: (v: string) => date(v) },
              canManageOrgUsers && activeOrgId ? {
                title: '', width: 190, align: 'right' as const,
                render: (_: any, r: any) => r._inActiveOrg && !r._platformAdmin ? (
                  <Space size={0}>
                    <Tooltip title={r.locked ? 'Desbloquear' : 'Bloquear'}>
                      <Button
                        size="small" type="text" icon={r.locked ? <UnlockOutlined /> : <LockOutlined />}
                        onClick={() => updateOrgUser.mutate({ userId: r._userId, data: { locked: !r.locked } })}
                      />
                    </Tooltip>
                    <Tooltip title="Restablecer contraseña">
                      <Button size="small" type="text" icon={<KeyOutlined />} onClick={() => { setResetFor(r); resetForm.resetFields(); }} />
                    </Tooltip>
                    <Tooltip title="API keys">
                      <Button size="small" type="text" icon={<KeyOutlined rotate={45} />} onClick={() => { setKeysFor(r); setNewKey(null); setKeyName(''); }} />
                    </Tooltip>
                    <Popconfirm title="¿Quitar el usuario de esta organización?" onConfirm={() => removeOrgUser.mutate(r._userId)}>
                      <Button size="small" danger type="text" icon={<DeleteOutlined />} />
                    </Popconfirm>
                  </Space>
                ) : null,
              } : null,
            ].filter(Boolean) as any}
          />
        </Card>
      ),
    });
    if (can('manageProfile')) list.push({
      key: 'profiles', label: 'Perfiles',
      children: (
        <Card size="small">
          <Table rowKey="id" size="small" dataSource={profiles.data || []} pagination={false}
            columns={[
              { title: 'Nombre', dataIndex: 'name', width: 140 },
              { title: 'Tipo', dataIndex: 'type', width: 130 },
              { title: 'Permisos', dataIndex: 'permissions', render: (perms: string[]) => <Space wrap>{(perms || []).map((p) => <Tag key={p}>{p}</Tag>)}</Space> },
            ]} />
        </Card>
      ),
    });
    if (can('manageConfig')) list.push({
      key: 'statuses', label: 'Estados',
      children: (
        <Row gutter={12}>
          <Col span={12}>
            <Card size="small" title="Estados de caso" extra={<Button size="small" onClick={() => openCreate('case-status')} icon={<PlusOutlined />} />}>
              <Table rowKey="id" size="small" dataSource={caseStatuses.data || []} pagination={false}
                columns={[
                  { title: 'Valor', dataIndex: 'value' },
                  { title: 'Stage', dataIndex: 'stage' },
                  { title: 'Color', dataIndex: 'colour', render: (v: string) => <Tag color={v}>{v}</Tag> },
                ]} />
            </Card>
          </Col>
          <Col span={12}>
            <Card size="small" title="Estados de alerta" extra={<Button size="small" onClick={() => openCreate('alert-status')} icon={<PlusOutlined />} />}>
              <Table rowKey="id" size="small" dataSource={alertStatuses.data || []} pagination={false}
                columns={[
                  { title: 'Valor', dataIndex: 'value' },
                  { title: 'Stage', dataIndex: 'stage' },
                  { title: 'Color', dataIndex: 'colour', render: (v: string) => <Tag color={v}>{v}</Tag> },
                ]} />
            </Card>
          </Col>
        </Row>
      ),
    });
    list.push({
      key: 'custom-fields', label: 'Custom fields',
      children: (
        <Card size="small" extra={can('manageCustomField') && <Button size="small" type="primary" icon={<PlusOutlined />} onClick={() => openCreate('custom-field')}>Nuevo campo</Button>}>
          <Table rowKey="id" size="small" dataSource={customFields.data || []} pagination={false}
            columns={[
              { title: 'Nombre', dataIndex: 'name' },
              { title: 'Referencia', dataIndex: 'reference' },
              { title: 'Tipo', dataIndex: 'type', width: 120 },
              { title: 'Obligatorio', dataIndex: 'mandatory', width: 110, render: (v: boolean) => v ? 'Sí' : 'No' },
            ]} />
        </Card>
      ),
    });
    list.push({
      key: 'tags', label: 'Tags',
      children: (
        <Card size="small" extra={can('manageTag') && <Button size="small" type="primary" icon={<PlusOutlined />} onClick={() => openCreate('tag')}>Nuevo tag</Button>}>
          <Space wrap>{(tags.data || []).map((t: any) => <Tag key={t.id} color={t.colour}>{t.name}</Tag>)}</Space>
        </Card>
      ),
    });
    list.push({
      key: 'templates', label: 'Plantillas',
      children: (
        <Card size="small" extra={can('manageCaseTemplate') && <Button size="small" type="primary" icon={<PlusOutlined />} onClick={() => openCreate('template')}>Nueva plantilla</Button>}>
          <Table rowKey="id" size="small" dataSource={templates.data || []} pagination={false}
            columns={[
              { title: 'Nombre', dataIndex: 'displayName', render: (v: string, r: any) => v || r.name },
              { title: 'Título', dataIndex: 'titlePrefix' },
              { title: 'Tareas', render: (_: any, r: any) => r.tasks?.length ?? 0, width: 90 },
              { title: 'Severidad', dataIndex: 'severity', width: 100 },
              { title: 'Tags', dataIndex: 'tags', render: (v: string[]) => (v || []).map((t) => <Tag key={t}>{t}</Tag>) },
            ]} />
        </Card>
      ),
    });
    list.push({
      key: 'patterns', label: 'ATT&CK',
      children: <MitrePanel />,
    });
    if (can('managePlatform') || can('manageConfig')) list.push({
      key: 'platform', label: 'Plataforma',
      children: (
        <Row gutter={12}>
          <Col span={12}>
            <Card size="small" title="Licencia">
              <Descriptions column={1} size="small">
                <Descriptions.Item label="Edición">{license.data?.edition}</Descriptions.Item>
                <Descriptions.Item label="Estado">{license.data?.status}</Descriptions.Item>
                <Descriptions.Item label="Usuarios">{license.data?.usage?.users}</Descriptions.Item>
                <Descriptions.Item label="Organizaciones">{license.data?.usage?.organisations}</Descriptions.Item>
                <Descriptions.Item label="Casos">{license.data?.usage?.cases}</Descriptions.Item>
              </Descriptions>
            </Card>
          </Col>
          <Col span={12}>
            <Card size="small" title="Estado">
              <Row gutter={12}>
                <Col span={12}><Statistic title="Usuarios" value={platform.data?.counts?.users || 0} /></Col>
                <Col span={12}><Statistic title="Casos" value={platform.data?.counts?.cases || 0} /></Col>
                <Col span={12}><Statistic title="Alertas" value={platform.data?.counts?.alerts || 0} /></Col>
                <Col span={12}><Statistic title="Observables" value={platform.data?.counts?.observables || 0} /></Col>
              </Row>
              <Typography.Paragraph style={{ marginTop: 12 }} type="secondary">Uptime: {platform.data?.uptimeSeconds}s · DB: {platform.data?.database}</Typography.Paragraph>
            </Card>
          </Col>
        </Row>
      ),
    });
    if (can('manageConfig')) list.push({
      key: 'audit', label: 'Auditoría',
      children: (
        <Card size="small">
          <Table rowKey="id" size="small" dataSource={audit.data || []} pagination={{ pageSize: 20 }}
            columns={[
              { title: 'Fecha', dataIndex: 'createdAt', width: 170, render: (v: string) => date(v) },
              { title: 'Actor', render: (_: any, r: any) => r.actor?.name || '—', width: 180 },
              { title: 'Acción', dataIndex: 'action', width: 120 },
              { title: 'Objeto', render: (_: any, r: any) => `${r.objectType} ${r.objectId || ''}` },
            ]} />
        </Card>
      ),
    });
    if (can('manageConfig')) {
      list.push({
        key: 'cortex-misp', label: 'Cortex & MISP',
        children: <IntegrationsPanel />,
      });
      list.push({
        key: 'integrations', label: 'Automatización',
        children: (
          <>
          <AutomationPanel />
          <EmailFeedersPanel />
          </>
        ),
      });
    }
    return list;
  }, [orgs.data, users.data, orgUsers.data, userRows, profiles.data, caseStatuses.data, alertStatuses.data, customFields.data, tags.data, templates.data, audit.data, license.data, platform.data, can, canManageOrgUsers, canManagePlatformUsers, activeOrgId, activeOrg]);

  const tab = items.some((i) => i.key === requestedTab) ? (requestedTab as string) : items[0]?.key;

  return (
    <div>
      <div className="page-header">
        <div>
          <h1 className="page-title"><SettingOutlined /> Administración</h1>
          <span style={{ color: '#8c8c9a' }}>Gestión de la plataforma y de la organización</span>
        </div>
        <Button icon={<ReloadOutlined />} onClick={() => qc.invalidateQueries()}>Actualizar</Button>
      </div>
      <Card size="small"><Tabs activeKey={tab} onChange={(key) => setParams({ tab: key })} items={items} destroyInactiveTabPane /></Card>

      <Modal
        title={
          modal === 'org' ? 'Nueva organización' : modal === 'user' ? 'Nuevo usuario' :
          modal === 'custom-field' ? 'Nuevo custom field' : modal === 'tag' ? 'Nuevo tag' :
          modal === 'template' ? 'Nueva plantilla' : modal === 'case-status' ? 'Nuevo estado de caso' :
          modal === 'alert-status' ? 'Nuevo estado de alerta' : 'Crear'
        }
        open={!!modal} onCancel={() => setModal(null)} onOk={() => form.submit()} confirmLoading={create.isPending}
      >
        <Form form={form} layout="vertical" onFinish={(values) => create.mutate({ kind: modal, values })}>
          {modal === 'org' && <>
            <Form.Item name="name" label="Nombre" rules={[{ required: true }]}><Input /></Form.Item>
            <Form.Item name="description" label="Descripción"><Input.TextArea rows={2} /></Form.Item>
          </>}
          {modal === 'user' && <>
            {canManagePlatformUsers && (
              <Form.Item name="organisationId" label="Organización" rules={[{ required: true }]}>
                <Select options={(orgs.data || []).map((o: any) => ({ value: o.id, label: o.name }))} />
              </Form.Item>
            )}
            <Form.Item name="login" label="Login (email)" rules={[{ required: true }]}><Input /></Form.Item>
            <Form.Item name="name" label="Nombre" rules={[{ required: true }]}><Input /></Form.Item>
            <Form.Item name="email" label="Email"><Input /></Form.Item>
            <Form.Item name="password" label="Contraseña inicial"><Input.Password /></Form.Item>
            <Form.Item name="profile" label="Perfil" rules={[{ required: true }]}>
              <Select
                options={(profiles.data || [])
                  .filter((p: any) => canManagePlatformUsers || p.type === 'organisation')
                  .map((p: any) => ({ value: p.name, label: `${p.name} (${p.type})` }))}
              />
            </Form.Item>
          </>}
          {modal === 'custom-field' && <>
            <Form.Item name="name" label="Nombre" rules={[{ required: true }]}><Input /></Form.Item>
            <Form.Item name="reference" label="Referencia" rules={[{ required: true }]}><Input placeholder="business-impact" /></Form.Item>
            <Form.Item name="type" label="Tipo"><Select options={['string', 'text', 'number', 'date', 'boolean', 'select'].map((v) => ({ value: v, label: v }))} /></Form.Item>
            <Form.Item name="mandatory" label="Obligatorio" valuePropName="checked"><input type="checkbox" /></Form.Item>
          </>}
          {modal === 'tag' && <>
            <Form.Item name="name" label="Nombre" rules={[{ required: true }]}><Input /></Form.Item>
            <Form.Item name="colour" label="Color" initialValue="#54c1c2"><Input type="color" /></Form.Item>
          </>}
          {modal === 'template' && <>
            <Form.Item name="name" label="Nombre" rules={[{ required: true }]}><Input placeholder="phishing-investigation" /></Form.Item>
            <Form.Item name="displayName" label="Nombre visible"><Input /></Form.Item>
            <Form.Item name="titlePrefix" label="Prefijo de título"><Input /></Form.Item>
            <Form.Item name="description" label="Descripción"><Input.TextArea rows={2} /></Form.Item>
            <Row gutter={12}>
              <Col span={8}><Form.Item name="severity" label="Severidad"><Select options={[1, 2, 3, 4].map((v) => ({ value: v, label: v }))} /></Form.Item></Col>
              <Col span={8}><Form.Item name="tlp" label="TLP"><Select options={[0, 1, 2, 3].map((v) => ({ value: v, label: v }))} /></Form.Item></Col>
              <Col span={8}><Form.Item name="pap" label="PAP"><Select options={[0, 1, 2, 3].map((v) => ({ value: v, label: v }))} /></Form.Item></Col>
            </Row>
            <Form.Item name="tags" label="Tags"><Select mode="tags" /></Form.Item>
          </>}
          {(modal === 'case-status' || modal === 'alert-status') && <>
            <Form.Item name="value" label="Valor" rules={[{ required: true }]}><Input /></Form.Item>
            <Form.Item name="stage" label="Stage"><Select options={['New', 'InProgress', 'Imported', 'Closed'].map((v) => ({ value: v, label: v }))} /></Form.Item>
            <Form.Item name="order" label="Orden"><Input type="number" /></Form.Item>
            <Form.Item name="colour" label="Color"><Input type="color" /></Form.Item>
          </>}
        </Form>
      </Modal>

      <Modal
        title={`Restablecer contraseña · ${resetFor?.name || ''}`}
        open={!!resetFor}
        onCancel={() => setResetFor(null)}
        onOk={() => resetForm.submit()}
        confirmLoading={resetPassword.isPending}
      >
        <Form form={resetForm} layout="vertical" onFinish={(values) => resetPassword.mutate({ userId: resetFor?._userId, password: values.password })}>
          <Form.Item name="password" label="Nueva contraseña" rules={[{ required: true, min: 8 }]}>
            <Input.Password />
          </Form.Item>
        </Form>
      </Modal>

      <Modal
        title={`API keys · ${keysFor?.name || ''}`}
        open={!!keysFor}
        onCancel={() => { setKeysFor(null); setNewKey(null); }}
        footer={null}
      >
        <Space.Compact style={{ width: '100%', marginBottom: 12 }}>
          <Input value={keyName} onChange={(e) => setKeyName(e.target.value)} placeholder="Nombre de la key" />
          <Button type="primary" loading={createUserKey.isPending} onClick={() => createUserKey.mutate({ userId: keysFor?._userId, name: keyName })}>Crear</Button>
        </Space.Compact>
        {newKey && (
          <Alert
            type="success" showIcon style={{ marginBottom: 12 }}
            message="Copia esta API key ahora; no se volverá a mostrar"
            description={<Input readOnly value={newKey} style={{ fontFamily: 'monospace' }} />}
          />
        )}
        <List
          dataSource={userKeys.data || []}
          loading={userKeys.isLoading}
          locale={{ emptyText: 'Sin API keys' }}
          renderItem={(key: any) => (
            <List.Item actions={[
              <Button key="revoke" danger size="small" loading={revokeUserKey.isPending} onClick={() => revokeUserKey.mutate({ userId: keysFor?._userId, keyId: key.id })}>Revocar</Button>,
            ]}>
              <List.Item.Meta title={key.name} description={`${key.prefix}… · creada ${date(key.createdAt)}`} />
            </List.Item>
          )}
        />
      </Modal>
    </div>
  );
}
