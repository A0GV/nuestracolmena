import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { AuthUser } from '../common/decorators/auth.decorators';
import { httpJson, joinUrl } from './http-client';

export type ConnectorType = 'cortex' | 'misp';
export const CONNECTOR_TYPES: ConnectorType[] = ['cortex', 'misp'];

export interface ConnectorConfig {
  url: string;
  apiKey: string;
  verifyTls?: boolean;
  /** MISP only: default distribution for exported events (0 = your org only). */
  distribution?: number;
}

export interface Connector {
  id: string;
  name: string;
  type: ConnectorType;
  organisationId: string | null;
  config: ConnectorConfig;
}

@Injectable()
export class ConnectorsService {
  constructor(private readonly prisma: PrismaService) {}

  /** Connectors visible for the user's organisation (own + global). */
  async list(user: AuthUser, type?: ConnectorType) {
    const rows = await this.prisma.endpoint.findMany({
      where: {
        type: type ? type : { in: CONNECTOR_TYPES },
        OR: [{ organisationId: user.organisationId }, { organisationId: null }],
      },
      orderBy: { createdAt: 'asc' },
    });
    return rows.map((r) => this.toConnector(r));
  }

  async get(user: AuthUser, id: string, type?: ConnectorType): Promise<Connector> {
    const row = await this.prisma.endpoint.findFirst({
      where: { id, type: type ? type : { in: CONNECTOR_TYPES }, OR: [{ organisationId: user.organisationId }, { organisationId: null }] },
    });
    if (!row) throw new NotFoundException(`${type || 'Connector'} not found`);
    return this.toConnector(row);
  }

  /** Same as get() but without user scoping, for background workers. */
  async getById(id: string): Promise<Connector | null> {
    const row = await this.prisma.endpoint.findUnique({ where: { id } });
    return row && CONNECTOR_TYPES.includes(row.type as ConnectorType) ? this.toConnector(row) : null;
  }

  async first(user: AuthUser, type: ConnectorType, id?: string): Promise<Connector> {
    if (id) return this.get(user, id, type);
    const all = await this.list(user, type);
    if (!all.length) throw new BadRequestException(`No ${type.toUpperCase()} server configured. Add one in Administración → Cortex & MISP.`);
    return all[0];
  }

  async create(user: AuthUser, data: any) {
    const type = this.validateType(data.type);
    const config = this.validateConfig(data, true);
    const row = await this.prisma.endpoint.create({
      data: {
        organisationId: data.global ? null : user.organisationId,
        name: String(data.name || `${type.toUpperCase()} server`),
        type,
        config: config as any,
        createdById: user.id,
      },
    });
    return this.publicView(this.toConnector(row));
  }

  async update(user: AuthUser, id: string, data: any) {
    const current = await this.get(user, id);
    const merged = { ...current.config, ...this.validateConfig({ ...current.config, ...data, apiKey: data.apiKey || current.config.apiKey }, false) };
    const row = await this.prisma.endpoint.update({
      where: { id },
      data: { name: data.name ?? undefined, config: merged as any },
    });
    return this.publicView(this.toConnector(row));
  }

  async remove(user: AuthUser, id: string) {
    await this.get(user, id);
    await this.prisma.endpoint.delete({ where: { id } });
    return { ok: true };
  }

  /** Checks reachability + credentials. Never throws: returns a status object. */
  async test(connector: Connector) {
    const started = Date.now();
    try {
      if (connector.type === 'cortex') {
        const status = await httpJson(joinUrl(connector.config.url, '/api/status'), { insecure: connector.config.verifyTls === false, timeoutMs: 8000 });
        if (!status.ok) return { ok: false, error: `HTTP ${status.status} on /api/status`, latencyMs: Date.now() - started };
        const me = await httpJson(joinUrl(connector.config.url, '/api/user/current'), {
          headers: this.authHeaders(connector),
          insecure: connector.config.verifyTls === false,
          timeoutMs: 8000,
        });
        if (!me.ok) return { ok: false, error: `Authentication failed (HTTP ${me.status})`, version: status.data?.versions?.Cortex, latencyMs: Date.now() - started };
        const analyzers = await httpJson(joinUrl(connector.config.url, '/api/analyzer?range=all'), {
          headers: this.authHeaders(connector),
          insecure: connector.config.verifyTls === false,
          timeoutMs: 8000,
        });
        return {
          ok: true,
          version: status.data?.versions?.Cortex,
          user: me.data?.id || me.data?.login,
          organisation: me.data?.organization,
          analyzers: Array.isArray(analyzers.data) ? analyzers.data.length : 0,
          latencyMs: Date.now() - started,
        };
      }
      const res = await httpJson(joinUrl(connector.config.url, '/servers/getVersion'), {
        headers: this.authHeaders(connector),
        insecure: connector.config.verifyTls === false,
        timeoutMs: 8000,
      });
      if (!res.ok) return { ok: false, error: `HTTP ${res.status}: ${res.data?.message || res.data?.name || 'MISP error'}`, latencyMs: Date.now() - started };
      return { ok: true, version: res.data?.version, latencyMs: Date.now() - started };
    } catch (e: any) {
      return { ok: false, error: e.message, latencyMs: Date.now() - started };
    }
  }

  authHeaders(connector: Connector): Record<string, string> {
    return connector.type === 'cortex'
      ? { Authorization: `Bearer ${connector.config.apiKey}` }
      : { Authorization: connector.config.apiKey };
  }

  publicView(c: Connector) {
    const key = c.config.apiKey || '';
    return {
      id: c.id,
      name: c.name,
      type: c.type,
      global: c.organisationId === null,
      url: c.config.url,
      verifyTls: c.config.verifyTls !== false,
      distribution: c.config.distribution,
      apiKeyPreview: key ? `${key.slice(0, 4)}…${key.slice(-4)}` : null,
    };
  }

  private toConnector(row: any): Connector {
    return { id: row.id, name: row.name, type: row.type, organisationId: row.organisationId, config: (row.config || {}) as ConnectorConfig };
  }

  private validateType(type: any): ConnectorType {
    if (!CONNECTOR_TYPES.includes(type)) throw new BadRequestException(`type must be one of: ${CONNECTOR_TYPES.join(', ')}`);
    return type;
  }

  private validateConfig(data: any, requireKey: boolean): ConnectorConfig {
    const url = String(data.url || '').trim();
    if (!/^https?:\/\/[^\s]+$/i.test(url)) throw new BadRequestException('url must be an http(s) URL');
    const apiKey = String(data.apiKey || '').trim();
    if (requireKey && !apiKey) throw new BadRequestException('apiKey is required');
    const config: ConnectorConfig = { url: url.replace(/\/+$/, ''), apiKey, verifyTls: data.verifyTls !== false };
    if (data.distribution !== undefined && data.distribution !== null && data.distribution !== '') config.distribution = Number(data.distribution);
    return config;
  }
}
