import { Injectable } from '@nestjs/common';
import { createHash } from 'node:crypto';
import { isIP } from 'node:net';
import { AddressObject, ParsedMail, simpleParser } from 'mailparser';

export interface EmailObservable {
  dataType: string;
  data: string;
  message?: string;
  tags?: string[];
  ioc?: boolean;
}

export interface EmailAttachment {
  filename: string;
  contentType: string;
  content: Buffer;
}

export interface ParsedEmail {
  sourceRef: string;
  title: string;
  date: Date;
  description: string;
  observables: EmailObservable[];
  attachments: EmailAttachment[];
  /** Raw message as received (outer envelope when it is a reported-phishing forward). */
  raw: Buffer;
  /** True when the alert comes from a message/rfc822 attachment inside the received mail. */
  reported: boolean;
  reporter?: string;
}

const MAX_BODY = 20 * 1024;
const URL_RE = /\bhttps?:\/\/[^\s<>"'`]+/gi;
const ANCHOR_RE = /<a\b[^>]*href\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))[^>]*>([\s\S]*?)<\/a>/gi;

const sha256 = (value: Buffer | string) => createHash('sha256').update(value).digest('hex');

function headerValues(parsed: ParsedMail, name: string): string[] {
  const value = parsed.headers.get(name);
  if (value === undefined || value === null) return [];
  const list = Array.isArray(value) ? value : [value];
  return list.map((entry) => {
    if (entry && typeof entry === 'object' && 'text' in entry) return String((entry as any).text || '');
    return String(entry);
  }).filter(Boolean);
}

function addresses(value?: AddressObject | AddressObject[]): string[] {
  if (!value) return [];
  const list = Array.isArray(value) ? value : [value];
  return list.flatMap((entry) => (entry.value || []).map((address) => String(address.address || '').trim()).filter(Boolean));
}

function emailDomain(address: string): string | undefined {
  const at = address.lastIndexOf('@');
  if (at < 0) return undefined;
  const domain = address.slice(at + 1).toLowerCase().replace(/[>.]+$/, '').trim();
  return domain || undefined;
}

function cleanEmail(value: string): string {
  return String(value || '').replace(/^<|>$/g, '').trim();
}

function decodeEntities(value: string): string {
  return value
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;|&apos;/gi, "'")
    .replace(/&nbsp;/gi, ' ')
    .replace(/&#x([0-9a-f]+);/gi, (_m, hex) => {
      try { return String.fromCodePoint(parseInt(hex, 16)); } catch { return _m; }
    })
    .replace(/&#(\d+);/g, (_m, dec) => {
      try { return String.fromCodePoint(Number(dec)); } catch { return _m; }
    });
}

function stripTags(value: string): string {
  return decodeEntities(String(value || '').replace(/<[^>]*>/g, ' ')).replace(/\s+/g, ' ').trim();
}

function cleanUrl(value: string): string | undefined {
  const url = decodeEntities(String(value || '').trim()).replace(/[),.;!?]+$/, '');
  if (!/^https?:\/\//i.test(url)) return undefined;
  try {
    const parsed = new URL(url);
    if (!parsed.hostname) return undefined;
    return parsed.toString();
  } catch {
    return undefined;
  }
}

function urlDomain(value: string): string | undefined {
  try {
    return new URL(value).hostname.toLowerCase().replace(/^\[|\]$/g, '') || undefined;
  } catch {
    return undefined;
  }
}

function isPublicIp(value: string): boolean {
  const version = isIP(value);
  if (version === 4) {
    const octets = value.split('.').map(Number);
    if (octets.some((n) => Number.isNaN(n) || n < 0 || n > 255)) return false;
    if (octets[0] === 0 || octets[0] === 10 || octets[0] === 127) return false;
    if (octets[0] === 172 && octets[1] >= 16 && octets[1] <= 31) return false;
    if (octets[0] === 192 && octets[1] === 168) return false;
    if (octets[0] === 169 && octets[1] === 254) return false;
    if (octets[0] === 100 && octets[1] >= 64 && octets[1] <= 127) return false;
    return true;
  }
  if (version === 6) {
    const lower = value.toLowerCase();
    if (lower === '::1' || lower === '::') return false;
    if (/^f[cd]/.test(lower)) return false;
    if (/^fe[89ab]/.test(lower)) return false;
    return true;
  }
  return false;
}

function ipsIn(value: string): string[] {
  const found = new Set<string>();
  for (const match of value.matchAll(/(?<![\d.])(\d{1,3}(?:\.\d{1,3}){3})(?![\d.])/g)) found.add(match[1]);
  for (const match of value.matchAll(/\[IPv6:([0-9a-f:]+)\]/gi)) found.add(match[1].toLowerCase());
  return [...found];
}

function receivedHops(values: string[]): Array<{ label: string; ips: string[] }> {
  return values.map((value) => {
    const flat = value.replace(/\s+/g, ' ').trim();
    const from = flat.match(/\bfrom\s+([^\s;()]+)/i)?.[1];
    const by = flat.match(/\bby\s+([^\s;()]+)/i)?.[1];
    const ips = ipsIn(flat);
    const parts = [from ? `from ${from}` : '', ips.length ? `(${ips.join(', ')})` : '', by ? `by ${by}` : ''].filter(Boolean);
    return { label: parts.join(' ') || flat.slice(0, 200), ips };
  });
}

function authenticationSummary(values: string[]): string {
  if (!values.length) return 'sin cabecera Authentication-Results';
  const seen = new Map<string, string>();
  for (const value of values) {
    for (const match of value.matchAll(/\b(spf|dkim|dmarc)\s*=\s*([a-z]+)/gi)) {
      const key = match[1].toLowerCase();
      if (!seen.has(key)) seen.set(key, match[2].toLowerCase());
    }
  }
  if (!seen.size) return values.join(' ');
  return ['spf', 'dkim', 'dmarc'].filter((key) => seen.has(key)).map((key) => `${key.toUpperCase()}=${seen.get(key)}`).join(' · ');
}

function textFromHtml(html: string): string {
  return stripTags(
    String(html || '')
      .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, ' ')
      .replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, ' '),
  );
}

interface LinkHit {
  url: string;
  tags: string[];
  message?: string;
}

function normaliseUrl(value: string) {
  return value.toLowerCase().replace(/^https?:\/\//, '').replace(/\/+$/, '');
}

function extractLinks(text: string, html: string): LinkHit[] {
  const links = new Map<string, { tags: Set<string>; message?: string }>();
  const realHrefs = new Set<string>();
  const displayedUrls = new Set<string>();
  const mismatches = new Map<string, string>();

  // An anchor whose visible text is a different URL is a classic phishing
  // trick. Keep only the real href (tagged link-mismatch) and never create
  // url/domain observables for the text shown to the victim.
  for (const match of String(html || '').matchAll(ANCHOR_RE)) {
    const href = cleanUrl(match[1] ?? match[2] ?? match[3] ?? '');
    if (!href) continue;
    const visible = stripTags(match[4] || '');
    const visibleUrl = cleanUrl(visible);
    const looksLikeLink = /^https?:\/\//i.test(visible) || /^[a-z0-9.-]+\.[a-z]{2,}(\/\S*)?$/i.test(visible);
    realHrefs.add(normaliseUrl(href));
    if (looksLikeLink && visibleUrl && normaliseUrl(visibleUrl) !== normaliseUrl(href)) {
      mismatches.set(href, visible);
      displayedUrls.add(normaliseUrl(visibleUrl));
    }
  }

  const add = (value: string, tags: string[] = [], message?: string) => {
    const url = cleanUrl(value);
    if (!url) return;
    const normal = normaliseUrl(url);
    if (displayedUrls.has(normal) && !realHrefs.has(normal)) return;
    if (!links.has(url)) links.set(url, { tags: new Set() });
    const hit = links.get(url)!;
    for (const tag of tags) hit.tags.add(tag);
    if (message && !hit.message) hit.message = message;
  };

  for (const match of String(text || '').matchAll(URL_RE)) add(match[0]);
  for (const match of String(html || '').matchAll(URL_RE)) add(match[0]);

  for (const [url, visible] of mismatches) {
    add(url, ['link-mismatch'], `Texto mostrado: ${visible}`);
  }

  return [...links.entries()].map(([url, hit]) => ({
    url,
    tags: [...hit.tags],
    message: hit.message,
  }));
}

function previewMessageId(parsed: ParsedMail, raw: Buffer): string {
  return parsed.messageId ? String(parsed.messageId) : sha256(raw);
}

function bodyOf(parsed: ParsedMail): string {
  const plain = parsed.text || '';
  const html = typeof parsed.html === 'string' ? parsed.html : '';
  if (plain.trim()) return plain.trim();
  return textFromHtml(html).trim();
}

function descriptionFor(target: ParsedMail, reporter?: string): string {
  const from = addresses(target.from).join(', ') || '—';
  const replyTo = addresses(target.replyTo).join(', ') || '—';
  const to = addresses(target.to).join(', ') || '—';
  const subject = target.subject || '(sin asunto)';
  const date = target.date ? target.date.toISOString() : '—';
  const returnPath = headerValues(target, 'return-path').map(cleanEmail).filter(Boolean).join(', ') || '—';
  const auth = authenticationSummary(headerValues(target, 'authentication-results'));
  const hops = receivedHops(headerValues(target, 'received'));
  const body = bodyOf(target).slice(0, MAX_BODY);

  const lines: string[] = [];
  if (reporter) lines.push(`> Correo reportado por **${reporter}** (reenviado como adjunto).`, '');
  lines.push('## Cabeceras');
  lines.push(`- **De:** ${from}`);
  lines.push(`- **Reply-To:** ${replyTo}`);
  lines.push(`- **Para:** ${to}`);
  lines.push(`- **Fecha:** ${date}`);
  lines.push(`- **Asunto:** ${subject}`);
  lines.push(`- **Return-Path:** ${returnPath}`);
  lines.push(`- **Autenticación:** ${auth}`);
  lines.push('', '## Cadena de recepción');
  if (hops.length) hops.forEach((hop) => lines.push(`- ${hop.label}`));
  else lines.push('- —');
  lines.push('', '## Cuerpo', '', body || '(sin cuerpo de texto)');
  return lines.join('\n');
}

@Injectable()
export class EmailParserService {
  async parse(raw: Buffer): Promise<ParsedEmail> {
    const outer = await simpleParser(raw);
    const forwarded = (outer.attachments || []).find((attachment) => {
      const type = String(attachment.contentType || '').toLowerCase();
      return type === 'message/rfc822' || type === 'message/rfc822;' || /\.eml$/i.test(attachment.filename || '');
    });

    const reported = !!forwarded?.content?.length;
    const targetRaw = reported ? forwarded!.content : raw;
    const target = reported ? await simpleParser(targetRaw) : outer;
    const reporter = reported ? addresses(outer.from)[0] : undefined;

    const subject = target.subject?.trim();
    const title = reported ? `Reportado: ${subject || '(sin asunto)'}` : (subject || '(sin asunto)');
    const date = target.date && !Number.isNaN(target.date.getTime()) ? target.date : new Date();

    const observables = new Map<string, EmailObservable>();
    const add = (dataType: string, data: string, message?: string, tags?: string[]) => {
      const value = String(data || '').trim();
      if (!value) return;
      const key = `${dataType}:${value.toLowerCase()}`;
      if (observables.has(key)) {
        if (tags?.length) observables.get(key)!.tags = [...new Set([...(observables.get(key)!.tags || []), ...tags])];
        return;
      }
      observables.set(key, { dataType, data: value, message, tags: tags?.length ? [...new Set(tags)] : undefined, ioc: false });
    };

    const senders = addresses(target.from);
    for (const sender of senders) {
      add('mail', sender, 'Remitente');
      const domain = emailDomain(sender);
      if (domain) add('domain', domain, 'Dominio del remitente');
    }
    for (const reply of addresses(target.replyTo)) {
      if (!senders.some((sender) => sender.toLowerCase() === reply.toLowerCase())) add('mail', reply, 'Reply-To');
    }
    for (const value of headerValues(target, 'return-path')) {
      const address = cleanEmail(value);
      if (address) add('mail', address, 'Return-Path');
    }
    if (subject) add('mail_subject', subject, 'Asunto');

    const received = headerValues(target, 'received');
    for (const hop of receivedHops(received)) {
      for (const ip of hop.ips) {
        if (isPublicIp(ip)) add('ip', ip, 'IP en cadena de recepción');
      }
    }

    const text = bodyOf(target);
    const html = typeof target.html === 'string' ? target.html : '';
    for (const link of extractLinks(text, html)) {
      add('url', link.url, link.message || 'Enlace en el cuerpo', link.tags);
      const domain = urlDomain(link.url);
      if (domain) add('domain', domain, link.message ? `Dominio del enlace (${link.message})` : 'Dominio de enlace');
    }

    if (reporter) add('mail', reporter, 'Reportado por');

    const attachments: EmailAttachment[] = [];
    for (const [index, attachment] of (target.attachments || []).entries()) {
      const type = String(attachment.contentType || '').toLowerCase();
      if (type.startsWith('message/rfc822')) continue;
      if (!attachment.content?.length) continue;
      const filename = String(attachment.filename || `adjunto-${index + 1}`).replace(/[\\/]/g, '_');
      attachments.push({
        filename,
        contentType: attachment.contentType || 'application/octet-stream',
        content: Buffer.from(attachment.content),
      });
    }

    return {
      sourceRef: previewMessageId(outer, raw),
      title: title.slice(0, 500),
      date,
      description: descriptionFor(target, reporter),
      observables: [...observables.values()],
      attachments,
      raw,
      reported,
      reporter,
    };
  }
}
