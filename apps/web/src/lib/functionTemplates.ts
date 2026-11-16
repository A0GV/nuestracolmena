export interface FunctionTemplate {
  key: string;
  label: string;
  kind: 'api' | 'action:case' | 'action:alert' | 'notification';
  code: string;
}

export const FUNCTION_TEMPLATES: FunctionTemplate[] = [
  {
    key: 'wazuh-alert',
    label: 'Wazuh → alerta',
    kind: 'api',
    code: `// Convierte uno o varios avisos de Wazuh en alertas de Nuestracolmena.
async function handle(input, context) {
  // Un aviso de Wazuh se reconoce por tener un bloque "rule" en la raíz.
  const isWazuh = (value) => value && typeof value === 'object' && !Array.isArray(value) && value.rule && typeof value.rule === 'object';

  // Acepta el aviso directo, { alert }, { body } (salida de n8n) y arrays.
  const collect = (value) => {
    if (Array.isArray(value)) {
      const out = [];
      for (const item of value) out.push.apply(out, collect(item));
      return out;
    }
    if (isWazuh(value)) return [value];
    if (value && typeof value === 'object') {
      if (isWazuh(value.alert)) return [value.alert];
      if (isWazuh(value.body)) return [value.body];
      if (Array.isArray(value.body)) return collect(value.body);
      if (typeof value.body === 'string') {
        try { return collect(JSON.parse(value.body)); } catch (e) {}
      }
    }
    return [value || {}];
  };

  const createOne = async (alert) => {
    const rule = alert.rule || {};
    const agent = alert.agent || {};
    const data = alert.data || {};
    const suricata = data.alert || {};
    const http = data.http || {};
    const dns = data.dns || {};
    const tls = data.tls || {};
    const win = data.win || {};
    const winEvent = win.eventdata || {};
    const winSystem = win.system || {};
    const syscheck = alert.syscheck || {};

    const sourceRef = String(alert.id || (rule.id + '-' + (alert.timestamp || Date.now())));

    // Idempotencia: si ya existe una alerta con el mismo sourceRef, devolverla.
    try {
      const existing = await context.alert.find({ _eq: { _field: 'sourceRef', _value: sourceRef } });
      if (existing && existing.length) return { _id: existing[0]._id, created: false, sourceRef: sourceRef };
    } catch (e) {
      // Si la búsqueda falla seguimos con la creación.
    }

    // Nivel de Wazuh (0-15) traducido a severidad de Nuestracolmena (1-4).
    const level = Number(rule.level || 0);
    const severity = level <= 5 ? 1 : level <= 9 ? 2 : level <= 12 ? 3 : 4;

    const srcIp = data.src_ip || data.srcip || alert.src_ip || alert.srcip;
    const destIp = data.dest_ip || data.dstip || data.dst_ip || alert.dest_ip || alert.dstip;
    const srcPort = data.src_port || data.srcport;
    const destPort = data.dest_port || data.destport;
    const proto = data.proto || data.protocol;
    const signature = suricata.signature;
    const signatureId = suricata.signature_id;
    const category = suricata.category;

    const groups = Array.isArray(rule.groups) ? rule.groups : [];
    const mitre = rule.mitre || {};
    const mitreIds = Array.isArray(mitre.id) ? mitre.id : mitre.id ? [mitre.id] : [];
    const mitreTactics = Array.isArray(mitre.tactic) ? mitre.tactic : mitre.tactic ? [mitre.tactic] : [];

    const tags = ['wazuh'];
    if (rule.id !== undefined) tags.push('rule:' + rule.id);
    for (const group of groups) tags.push(String(group));
    for (const id of mitreIds) tags.push(String(id));
    if (signatureId !== undefined && signatureId !== '') tags.push('sid:' + signatureId);
    if (category) tags.push(String(category));

    const observables = [];
    const addObservable = (dataType, value, message) => {
      if (!value) return;
      const text = String(value).trim();
      if (!text) return;
      if (observables.some((o) => o.dataType === dataType && o.data === text)) return;
      observables.push({ dataType: dataType, data: text, message: message || '', tags: ['wazuh'], tlp: 2, ioc: true });
    };
    addObservable('ip', srcIp, 'IP origen');
    addObservable('ip', destIp, 'IP destino');
    addObservable('hostname', data.hostname || agent.name, 'Host');
    addObservable('ip', agent.ip, 'Agente');
    addObservable('url', http.url, 'URL HTTP');
    addObservable('fqdn', http.hostname, 'Host HTTP');
    addObservable('domain', dns.rrname, 'Dominio DNS');
    addObservable('domain', tls.sni, 'SNI TLS');
    addObservable('hash', syscheck.sha256_after, 'Hash SHA-256');
    addObservable('filename', winEvent.image, 'Imagen Sysmon');
    addObservable('filename', winEvent.targetFilename, 'Fichero Sysmon');
    addObservable('hostname', winSystem.computer, 'Equipo Windows');

    const hashes = winEvent.hashes;
    if (hashes) {
      let sha256 = '';
      if (typeof hashes === 'string') {
        const match = hashes.match(/SHA256=([A-Fa-f0-9]{64})/);
        sha256 = match ? match[1] : '';
      } else if (typeof hashes === 'object') {
        sha256 = hashes.SHA256 || hashes.sha256 || '';
      }
      addObservable('hash', sha256, 'Hash SHA-256 (Sysmon)');
    }

    // La descripción usa Markdown e incluye puertos, protocolo, firma y log completo.
    const lines = [];
    lines.push('## ' + (rule.description || 'Alerta de Wazuh'));
    lines.push('');
    lines.push('- **Agente:** ' + (agent.name || 'desconocido') + (agent.ip ? ' (' + agent.ip + ')' : ''));
    lines.push('- **Regla:** ' + (rule.id || '?') + ' · nivel ' + level);
    if (groups.length) lines.push('- **Grupos:** ' + groups.join(', '));
    if (mitreIds.length) lines.push('- **MITRE ATT&CK:** ' + mitreIds.join(', '));
    if (signature || signatureId) {
      lines.push('- **Suricata:** ' + (signature || 'sin firma') + (signatureId ? ' (SID ' + signatureId + ')' : '') + (category ? ' · ' + category : ''));
    }
    const origin = (srcIp || '-') + (srcPort ? ':' + srcPort : '');
    const target = (destIp || '-') + (destPort ? ':' + destPort : '');
    if (srcIp || destIp || srcPort || destPort) lines.push('- **Origen/destino:** ' + origin + ' → ' + target + (proto ? ' (' + proto + ')' : ''));
    else if (proto) lines.push('- **Protocolo:** ' + proto);
    if (http.hostname || http.url) lines.push('- **HTTP:** ' + [http.hostname, http.url].filter(Boolean).join(' '));
    if (dns.rrname) lines.push('- **DNS:** ' + dns.rrname);
    if (tls.sni) lines.push('- **TLS SNI:** ' + tls.sni);
    if (winEvent.image) lines.push('- **Proceso:** ' + winEvent.image);
    if (winEvent.targetFilename) lines.push('- **Fichero:** ' + winEvent.targetFilename);
    if (winSystem.computer) lines.push('- **Equipo:** ' + winSystem.computer);
    lines.push('');
    lines.push('~~~');
    lines.push(String(alert.full_log || alert.timestamp || '').slice(0, 4000));
    lines.push('~~~');

    const procedures = mitreIds.map((id, i) => ({
      patternId: String(id),
      patternName: String(id),
      tactic: mitreTactics[i] || mitreTactics[0] || undefined,
      description: rule.description || '',
    }));

    const parsed = typeof alert.timestamp === 'number' ? alert.timestamp : Date.parse(String(alert.timestamp || ''));
    const created = await context.alert.create({
      title: rule.description || ('Wazuh rule ' + (rule.id || 'unknown')),
      description: lines.join('\\n'),
      type: 'wazuh',
      source: 'Wazuh',
      sourceRef: sourceRef,
      severity: severity,
      tlp: 2,
      pap: 2,
      tags: tags,
      date: Number.isFinite(parsed) ? parsed : Date.now(),
      observables: observables,
      procedures: procedures,
      customFields: { 'detection-source': 'SIEM' },
    });
    return { _id: created._id, created: true, sourceRef: sourceRef };
  };

  const alerts = collect(input);
  const results = [];
  for (const alert of alerts) results.push(await createOne(alert));
  return Array.isArray(input) || results.length > 1 ? results : results[0];
}`,
  },
  {
    key: 'suricata-eve',
    label: 'Suricata EVE → alerta',
    kind: 'api',
    code: `// Convierte uno o varios eventos "alert" de Suricata EVE en alertas de Nuestracolmena.
async function handle(input, context) {
  const isEve = (value) => value && typeof value === 'object' && !Array.isArray(value) && (value.event_type === 'alert' || (value.alert && (value.alert.signature_id !== undefined || value.alert.signature !== undefined)));

  // Acepta el evento directo, { body } (salida de n8n), { event } y arrays.
  const collect = (value) => {
    if (Array.isArray(value)) {
      const out = [];
      for (const item of value) out.push.apply(out, collect(item));
      return out;
    }
    if (isEve(value)) return [value];
    if (value && typeof value === 'object') {
      if (isEve(value.body)) return [value.body];
      if (Array.isArray(value.body)) return collect(value.body);
      if (typeof value.body === 'string') {
        try { return collect(JSON.parse(value.body)); } catch (e) {}
      }
      if (isEve(value.event)) return [value.event];
    }
    return [value || {}];
  };

  const createOne = async (event) => {
    const sig = event.alert || {};
    const sourceRef = String(event.flow_id || event.timestamp || Date.now()) + ':' + String(sig.signature_id || sig.signature || 'unknown');

    try {
      const existing = await context.alert.find({ _eq: { _field: 'sourceRef', _value: sourceRef } });
      if (existing && existing.length) return { _id: existing[0]._id, created: false, sourceRef: sourceRef };
    } catch (e) {
      // Si la búsqueda falla seguimos con la creación.
    }

    // Severidad Suricata: 1 alta, 2 media, 3 baja → Nuestracolmena 3, 2, 1.
    const level = Number(sig.severity || 3);
    const severity = level <= 1 ? 3 : level === 2 ? 2 : 1;

    const observables = [];
    const add = (dataType, value, message) => {
      if (!value) return;
      const text = String(value);
      if (observables.some((o) => o.dataType === dataType && o.data === text)) return;
      observables.push({ dataType: dataType, data: text, message: message, tags: ['suricata'], ioc: true });
    };
    add('ip', event.src_ip, 'IP origen');
    add('ip', event.dest_ip, 'IP destino');
    add('hostname', event.http && event.http.hostname, 'Host HTTP');
    add('url', event.http && event.http.url, 'URL HTTP');
    add('domain', event.dns && event.dns.rrname, 'Dominio DNS');
    add('domain', event.tls && event.tls.sni, 'SNI TLS');

    const tags = ['suricata', 'signature:' + (sig.signature_id || 'unknown')];
    if (sig.signature_id !== undefined && sig.signature_id !== '') tags.push('sid:' + sig.signature_id);
    if (sig.category) tags.push(String(sig.category));

    const lines = [
      '## ' + (sig.signature || 'Alerta de Suricata'),
      '',
      '- **Categoría:** ' + (sig.category || '—'),
      '- **Origen/destino:** ' + (event.src_ip || '?') + ':' + (event.src_port || '?') + ' → ' + (event.dest_ip || '?') + ':' + (event.dest_port || '?'),
      '- **Protocolo:** ' + (event.proto || '—'),
      '- **Signature ID:** ' + (sig.signature_id || '—'),
    ];
    if (event.http && (event.http.hostname || event.http.url)) lines.push('- **HTTP:** ' + [event.http.hostname, event.http.url].filter(Boolean).join(' '));
    if (event.dns && event.dns.rrname) lines.push('- **DNS:** ' + event.dns.rrname);
    if (event.tls && event.tls.sni) lines.push('- **TLS SNI:** ' + event.tls.sni);

    const parsed = typeof event.timestamp === 'number' ? event.timestamp : Date.parse(String(event.timestamp || ''));
    const created = await context.alert.create({
      title: sig.signature || 'Suricata alert',
      description: lines.join('\\n'),
      type: 'suricata',
      source: 'Suricata',
      sourceRef: sourceRef,
      severity: severity,
      tlp: 2,
      pap: 2,
      tags: tags,
      date: Number.isFinite(parsed) ? parsed : Date.now(),
      observables: observables,
    });
    return { _id: created._id, created: true, sourceRef: sourceRef };
  };

  const events = collect(input);
  const results = [];
  for (const event of events) results.push(await createOne(event));
  return Array.isArray(input) || results.length > 1 ? results : results[0];
}`,
  },
  {
    key: 'generic-webhook',
    label: 'Webhook genérico → alerta',
    kind: 'api',
    code: `// Crea una alerta a partir de un JSON con { title, description, severity, observables }.
async function handle(input, context) {
  const body = input || {};
  const created = await context.alert.create({
    title: body.title || body.name || 'Evento recibido por webhook',
    description: body.description || '',
    type: body.type || 'external',
    source: body.source || 'Webhook',
    sourceRef: body.sourceRef || body.id || ('webhook-' + Date.now()),
    severity: Number(body.severity || 2),
    tlp: Number(body.tlp !== undefined ? body.tlp : 2),
    pap: Number(body.pap !== undefined ? body.pap : 2),
    tags: Array.isArray(body.tags) ? body.tags : ['webhook'],
    observables: Array.isArray(body.observables) ? body.observables : [],
    customFields: body.customFields || {},
  });
  return { _id: created._id, created: true };
}`,
  },
  {
    key: 'case-action-close-duplicates',
    label: 'Acción: casos duplicados',
    kind: 'action:case',
    code: `// Acción manual: añade un comentario con otros casos abiertos que comparten observables.
async function handle(input, context) {
  const current = input.case || {};
  const observables = Array.isArray(current.observables) ? current.observables : [];
  if (!observables.length) {
    await context.case.addComment(current._id, '### Posibles duplicados\\n\\nEl caso no tiene observables.');
    return { duplicates: [], comment: 'El caso no tiene observables' };
  }

  const counts = {};
  for (const observable of observables) {
    const found = await context.observable.find({ _eq: { _field: 'data', _value: observable.data } });
    for (const item of found) {
      if (!item.caseId || item.caseId === current._id) continue;
      counts[item.caseId] = (counts[item.caseId] || 0) + 1;
    }
  }

  const duplicates = [];
  for (const caseId of Object.keys(counts)) {
    const item = await context.case.get(caseId);
    if (item && item.stage !== 'Closed') {
      duplicates.push({ _id: item._id, number: item.number, title: item.title, shared: counts[caseId] });
    }
  }

  const lines = ['### Posibles duplicados', '', 'Casos abiertos que comparten observables:'];
  if (duplicates.length) {
    for (const item of duplicates) {
      lines.push('- #' + item.number + ' ' + item.title + ' (' + item.shared + ' observable(s) en común)');
    }
  } else {
    lines.push('- Ninguno');
  }

  const comment = lines.join('\\n');
  await context.case.addComment(current._id, comment);
  return { comment: comment, duplicates: duplicates };
}`,
  },
];

export const DEFAULT_FUNCTION_TEMPLATE = FUNCTION_TEMPLATES[0];
