import React from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { Space, Tag, Tooltip, Typography } from 'antd';
import dayjs from 'dayjs';
import relativeTime from 'dayjs/plugin/relativeTime';
import 'dayjs/locale/es';

dayjs.extend(relativeTime);
dayjs.locale('es');

export const SEVERITY: Record<number, { label: string; colour: string }> = {
  1: { label: 'LOW', colour: '#52c41a' },
  2: { label: 'MEDIUM', colour: '#faad14' },
  3: { label: 'HIGH', colour: '#fa8c16' },
  4: { label: 'CRITICAL', colour: '#d0021b' },
};

export const TLP: Record<number, { label: string; colour: string }> = {
  0: { label: 'WHITE', colour: '#d9d9d9' },
  1: { label: 'GREEN', colour: '#52c41a' },
  2: { label: 'AMBER', colour: '#faad14' },
  3: { label: 'RED', colour: '#d0021b' },
};

export function SeverityTag({ value }: { value: number }) {
  const s = SEVERITY[value] || SEVERITY[2];
  return <Tag color={s.colour} style={{ fontWeight: 700, margin: 0 }}>{s.label}</Tag>;
}

export function TlpTag({ value, prefix }: { value: number; prefix: string }) {
  const s = TLP[value] || TLP[2];
  return <Tag color={s.colour} style={{ margin: 0 }}>{prefix}.{s.label}</Tag>;
}

export function StatusBadge({ value, stage, colour }: { value?: string; stage?: string; colour?: string }) {
  const color = colour || (stage === 'Closed' ? '#a7a7b6' : stage === 'InProgress' ? '#faad14' : '#4a90e2');
  return (
    <Tag style={{ borderColor: color, color, background: `${color}14`, fontWeight: 600, margin: 0 }}>
      {value || stage || 'Unknown'}
    </Tag>
  );
}

export function date(value?: string | Date | null) {
  return value ? dayjs(value).format('DD/MM/YYYY HH:mm') : '—';
}

export function fromNow(value?: string | Date | null) {
  return value ? dayjs(value).fromNow() : '—';
}

export function Markdown({ children }: { children?: string }) {
  if (!children) return <Typography.Text type="secondary">Sin contenido</Typography.Text>;
  return (
    <div className="markdown">
      <ReactMarkdown remarkPlugins={[remarkGfm]}>{children}</ReactMarkdown>
    </div>
  );
}

const SLA_STATE_COLOUR: Record<string, string> = {
  ok: 'green',
  warning: 'orange',
  breached: 'red',
  met: 'default',
  'met-late': 'default',
};

function shortDuration(ms: number) {
  const seconds = Math.max(0, Math.round(ms / 1000));
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  if (hours < 48) return `${hours}h ${minutes % 60}m`;
  return `${Math.floor(hours / 24)}d ${hours % 24}h`;
}

function slaText(prefix: string, value: any) {
  if (!value) return '';
  if (value.state === 'met') return `${prefix}: cumplido`;
  if (value.state === 'met-late') return `${prefix}: tarde`;
  const due = dayjs(value.dueAt);
  const diff = due.diff(dayjs(), 'millisecond');
  if (value.state === 'breached') return `${prefix}: Vencido hace ${shortDuration(-diff)}`;
  return `${prefix}: quedan ${shortDuration(diff)}`;
}

export function SlaBadge({ prefix, value }: { prefix: string; value: any }) {
  if (!value) return null;
  const tooltip = [
    `${prefix === 'Ack' ? 'Acuse' : 'Resolución'} · vence ${date(value.dueAt)}`,
    value.metAt ? `cumplido ${date(value.metAt)}` : `estado ${value.state}`,
  ].join(' · ');
  return (
    <Tooltip title={tooltip}>
      <Tag color={SLA_STATE_COLOUR[value.state] || 'default'} style={{ margin: 0 }}>{slaText(prefix, value)}</Tag>
    </Tooltip>
  );
}

export function SlaCell({ sla }: { sla: any }) {
  if (!sla) return <Typography.Text type="secondary">—</Typography.Text>;
  return (
    <Space size={4} wrap>
      <SlaBadge prefix="Ack" value={sla.acknowledge} />
      <SlaBadge prefix="Res" value={sla.resolve} />
    </Space>
  );
}

export function slaRank(sla: any) {
  const order: Record<string, number> = { breached: 4, warning: 3, ok: 2, 'met-late': 1, met: 0 };
  const values = [sla?.acknowledge?.state, sla?.resolve?.state].filter(Boolean) as string[];
  return values.length ? Math.max(...values.map((state) => order[state] ?? 0)) : -1;
}

export function humanDuration(start?: string | Date | null, end?: string | Date | null) {
  if (!start) return '—';
  const s = dayjs(start);
  const e = end ? dayjs(end) : dayjs();
  const diff = e.diff(s, 'second');
  if (diff < 60) return `${diff}s`;
  if (diff < 3600) return `${Math.floor(diff / 60)}m`;
  if (diff < 86400) return `${Math.floor(diff / 3600)}h ${Math.floor((diff % 3600) / 60)}m`;
  return `${Math.floor(diff / 86400)}d ${Math.floor((diff % 86400) / 3600)}h`;
}
