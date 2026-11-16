import { useEffect } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { notification } from 'antd';
import { API_URL, ORG_KEY, TOKEN_KEY } from './api';

interface LiveEvent {
  action: string;
  objectType: string;
  objectId: string | null;
  rootType: string | null;
  rootId: string | null;
  title: string | null;
  severity: number | null;
}

const SEVERITY = ['', 'LOW', 'MEDIUM', 'HIGH', 'CRITICAL'];

/**
 * Listens to /stream (Server-Sent Events) and refreshes the affected lists the
 * moment the API reports a change: no polling, no manual reload. fetch is used
 * instead of EventSource so the token goes in the Authorization header, not the URL.
 * `session` identifies the logged-in user + organisation; null disables it, a change reconnects.
 */
export function useLiveUpdates(session: string | null, onOpenAlert?: (id: string) => void) {
  const qc = useQueryClient();

  useEffect(() => {
    if (!session) return;
    let stopped = false;
    let controller: AbortController | null = null;
    let retry: ReturnType<typeof setTimeout> | undefined;

    const handle = (ev: LiveEvent) => {
      const alertId = ev.rootType === 'Alert' ? ev.rootId : ev.objectType === 'Alert' ? ev.objectId : null;
      const caseId = ev.rootType === 'Case' ? ev.rootId : ev.objectType === 'Case' ? ev.objectId : null;
      if (alertId || ev.objectType === 'Alert') {
        qc.invalidateQueries({ queryKey: ['alerts'] });
        if (alertId) qc.invalidateQueries({ queryKey: ['alert', alertId] });
      }
      if (caseId || ev.objectType === 'Case' || ev.action === 'import-to-case' || ev.action === 'merge-alert') {
        qc.invalidateQueries({ queryKey: ['cases'] });
        qc.invalidateQueries({ queryKey: ['stats'] });
        if (caseId) qc.invalidateQueries({ queryKey: ['case', caseId] });
      }
      if (ev.objectType === 'Alert' && ev.action === 'create' && ev.objectId) {
        const id = ev.objectId;
        notification.info({
          key: `alert-${id}`,
          message: `Nueva alerta${ev.severity ? ` · ${SEVERITY[ev.severity] || ev.severity}` : ''}`,
          description: ev.title || undefined,
          placement: 'bottomRight',
          duration: 6,
          onClick: onOpenAlert ? () => onOpenAlert(id) : undefined,
          style: onOpenAlert ? { cursor: 'pointer' } : undefined,
        });
      }
    };

    const connect = async () => {
      const token = localStorage.getItem(TOKEN_KEY);
      if (!token || stopped) return;
      controller = new AbortController();
      const headers: Record<string, string> = { Authorization: `Bearer ${token}`, Accept: 'text/event-stream' };
      const org = localStorage.getItem(ORG_KEY);
      if (org) headers['X-Organisation'] = org;
      try {
        const res = await fetch(`${API_URL}/stream`, { headers, signal: controller.signal, cache: 'no-store' });
        if (!res.ok || !res.body) throw new Error(`stream ${res.status}`);
        // Something may have arrived while disconnected.
        qc.invalidateQueries({ queryKey: ['alerts'] });
        const reader = res.body.pipeThrough(new TextDecoderStream()).getReader();
        let buffer = '';
        for (;;) {
          const { value, done } = await reader.read();
          if (done) break;
          buffer += value;
          let sep: number;
          while ((sep = buffer.indexOf('\n\n')) >= 0) {
            const chunk = buffer.slice(0, sep);
            buffer = buffer.slice(sep + 2);
            const data = chunk.split('\n').filter((l) => l.startsWith('data:')).map((l) => l.slice(5).trim()).join('');
            if (!data) continue;
            try { handle(JSON.parse(data)); } catch { /* ignore malformed event */ }
          }
        }
      } catch {
        // network error, server restart or abort: fall through to reconnect
      }
      if (!stopped) retry = setTimeout(connect, 3000);
    };

    connect();
    return () => {
      stopped = true;
      if (retry) clearTimeout(retry);
      controller?.abort();
    };
  }, [session, qc, onOpenAlert]);
}
