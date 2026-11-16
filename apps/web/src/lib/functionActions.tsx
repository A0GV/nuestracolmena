import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Alert, Button, Dropdown, Modal, Space, Spin, Tag, Typography } from 'antd';
import { ThunderboltOutlined } from '@ant-design/icons';
import { api, errorMessage } from './api';

interface Props {
  target: 'case' | 'alert';
  objectId: string;
  onDone?: () => void;
}

export function FunctionActionsButton({ target, objectId, onDone }: Props) {
  const [open, setOpen] = useState(false);
  const [result, setResult] = useState<any>(null);
  const qc = useQueryClient();

  const actions = useQuery({
    queryKey: ['function-actions', target],
    queryFn: async () => (await api.get('/functions/actions', { params: { target } })).data,
    enabled: open,
  });

  const run = useMutation({
    mutationFn: async (fn: any) => {
      const base = target === 'case' ? 'cases' : 'alerts';
      return (await api.post(`/${base}/${objectId}/functions/${fn.id}`)).data;
    },
    onSuccess: (data) => {
      setResult(data);
      qc.invalidateQueries({ queryKey: [target === 'case' ? 'case' : 'alerts'] });
      onDone?.();
    },
    onError: (error: any) => {
      setResult({ error: errorMessage(error), logs: error?.response?.data?.logs });
    },
  });

  const list = Array.isArray(actions.data) ? actions.data : [];
  const items = actions.isLoading
    ? [{ key: 'loading', disabled: true, label: <Spin size="small" /> }]
    : list.length
      ? list.map((fn: any) => ({
          key: fn.id,
          label: <span><b>{fn.name}</b>{fn.description ? <span style={{ color: '#8c8c9a' }}> · {fn.description}</span> : null}</span>,
          onClick: () => run.mutate(fn),
        }))
      : [{ key: 'none', disabled: true, label: 'Ninguna función de acción habilitada' }];

  return (
    <>
      <Dropdown
        menu={{ items }}
        trigger={['click']}
        onOpenChange={(value) => setOpen(value)}
      >
        <Button icon={<ThunderboltOutlined />} loading={run.isPending}>Acciones</Button>
      </Dropdown>
      <Modal
        title="Resultado de la acción"
        open={!!result}
        onCancel={() => setResult(null)}
        footer={<Button onClick={() => setResult(null)}>Cerrar</Button>}
        width={760}
      >
        {result?.error ? <Alert type="error" showIcon message={result.error} style={{ marginBottom: 12 }} /> : null}
        {result && !result.error ? (
          <Space direction="vertical" style={{ width: '100%' }}>
            {result.durationMs !== undefined ? <Tag color="blue">{result.durationMs} ms</Tag> : null}
            <Typography.Text strong>Salida</Typography.Text>
            <pre style={{ fontSize: 12, maxHeight: 320, overflow: 'auto', background: '#f7f7f9', padding: 10, borderRadius: 6 }}>
              {JSON.stringify(result.output ?? result, null, 2)}
            </pre>
            {Array.isArray(result.logs) && result.logs.length > 0 ? (
              <>
                <Typography.Text strong>Logs</Typography.Text>
                <pre style={{ fontSize: 12, maxHeight: 200, overflow: 'auto', background: '#f7f7f9', padding: 10, borderRadius: 6 }}>
                  {result.logs.join('\n')}
                </pre>
              </>
            ) : null}
          </Space>
        ) : null}
      </Modal>
    </>
  );
}
