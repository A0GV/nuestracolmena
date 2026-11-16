import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Button, Card, Drawer, Empty, Form, Input, List, Popconfirm, Select, Space, Tag, Typography, message } from 'antd';
import { DeleteOutlined, EditOutlined, PlusOutlined } from '@ant-design/icons';
import { api, errorMessage } from '../lib/api';
import { useAuth } from '../lib/auth';
import { Markdown, date } from '../lib/format';

export default function KnowledgeBasePage() {
  const qc = useQueryClient();
  const { can } = useAuth();
  const [open, setOpen] = useState(false);
  const [editing, setEditing] = useState<any>(null);
  const [preview, setPreview] = useState<any>(null);
  const [form] = Form.useForm();
  const pages = useQuery({ queryKey: ['pages'], queryFn: async () => (await api.get('/pages')).data });

  const save = useMutation({
    mutationFn: async (values: any) => editing
      ? (await api.patch(`/pages/${editing.id}`, values)).data
      : (await api.post('/pages', values)).data,
    onSuccess: () => { message.success('Página guardada'); setOpen(false); setEditing(null); form.resetFields(); qc.invalidateQueries({ queryKey: ['pages'] }); },
    onError: (e) => message.error(errorMessage(e)),
  });
  const remove = useMutation({
    mutationFn: async (id: string) => (await api.delete(`/pages/${id}`)).data,
    onSuccess: () => { message.success('Página eliminada'); qc.invalidateQueries({ queryKey: ['pages'] }); },
    onError: (e) => message.error(errorMessage(e)),
  });

  const openEdit = (page?: any) => {
    setEditing(page || null);
    form.setFieldsValue(page ? { title: page.title, category: page.category, content: page.content } : { title: '', category: '', content: '' });
    setOpen(true);
  };

  return (
    <div>
      <div className="page-header">
        <div>
          <h1 className="page-title">Knowledge base</h1>
          <span style={{ color: '#8c8c9a' }}>{pages.data?.length ?? 0} páginas</span>
        </div>
        {can('manageKnowledgeBase') && <Button type="primary" icon={<PlusOutlined />} onClick={() => openEdit()}>Nueva página</Button>}
      </div>
      <Card size="small">
        <List
          dataSource={pages.data || []}
          locale={{ emptyText: <Empty description="Sin páginas" /> }}
          renderItem={(p: any) => (
            <List.Item
              actions={[
                <Button key="view" size="small" type="link" onClick={() => setPreview(p)}>Ver</Button>,
                can('manageKnowledgeBase') ? <Button key="edit" size="small" type="link" icon={<EditOutlined />} onClick={() => openEdit(p)} /> : null,
                can('manageKnowledgeBase') ? (
                  <Popconfirm key="del" title="¿Eliminar página?" onConfirm={() => remove.mutate(p.id)}>
                    <Button size="small" type="link" danger icon={<DeleteOutlined />} />
                  </Popconfirm>
                ) : null,
              ]}
            >
              <List.Item.Meta
                title={<a onClick={() => setPreview(p)}>{p.title}</a>}
                description={<Space><Tag>{p.category || 'General'}</Tag><span style={{ color: '#8c8c9a' }}>Actualizado {date(p.updatedAt)}</span></Space>}
              />
            </List.Item>
          )}
        />
      </Card>

      <Drawer title={editing ? 'Editar página' : 'Nueva página'} width={720} open={open} onClose={() => setOpen(false)}
        extra={<Button type="primary" loading={save.isPending} onClick={() => form.submit()}>Guardar</Button>}>
        <Form form={form} layout="vertical" onFinish={(v) => save.mutate(v)}>
          <Form.Item name="title" label="Título" rules={[{ required: true }]}><Input /></Form.Item>
          <Form.Item name="category" label="Categoría"><Input placeholder="Playbooks, Procedures, ..." /></Form.Item>
          <Form.Item name="content" label="Contenido (Markdown)"><Input.TextArea rows={18} /></Form.Item>
        </Form>
      </Drawer>

      <Drawer title={preview?.title} width={720} open={!!preview} onClose={() => setPreview(null)}>
        {preview && (
          <div>
            <Space style={{ marginBottom: 12 }}><Tag>{preview.category || 'General'}</Tag><Typography.Text type="secondary">{date(preview.updatedAt)}</Typography.Text></Space>
            <Markdown>{preview.content}</Markdown>
          </div>
        )}
      </Drawer>
    </div>
  );
}
