import { BadRequestException, ConflictException, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { join } from 'node:path';
import { Worker } from 'node:worker_threads';
import * as vm from 'node:vm';
import { PrismaService } from '../prisma/prisma.service';
import { AlertsService } from '../alerts/alerts.service';
import { CasesService } from '../cases/cases.service';
import { QueryService } from '../query/query.service';
import { AuthUser } from '../common/decorators/auth.decorators';
import {
  mapAlert,
  mapCase,
  mapComment,
  mapObservable,
  mapTask,
  normaliseAlertInput,
  normaliseCaseInput,
  normaliseObservableInput,
  normaliseTaskInput,
} from '../compat/thehive-mapper';

const NAME_PATTERN = /^[a-zA-Z0-9_-]{1,64}$/;
export const FUNCTION_KINDS = ['api', 'action:case', 'action:alert', 'notification'];
export const FUNCTION_MODES = ['Enabled', 'Disabled', 'DryRun'];
const MUTATING_CALLS = new Set([
  'alert.create',
  'alert.update',
  'alert.createCase',
  'alert.merge',
  'case.create',
  'case.update',
  'case.addObservable',
  'case.addTask',
  'case.addComment',
]);
const EXECUTION_TIMEOUT_MS = 30000;
const MAX_INPUT_BYTES = 20000;
const MAX_LOGS = 1000;
const MAX_RUNS_PER_FUNCTION = 200;

export interface FunctionRunResult {
  output: any;
  logs: string[];
  calls: { call: string; args: any[] }[];
  durationMs: number;
  error: string | null;
  timedOut: boolean;
  dryRun: boolean;
}

@Injectable()
export class FunctionsService {
  private readonly logger = new Logger('Functions');
  private readonly workerPath = join(__dirname, 'function-worker.js');

  constructor(
    private readonly prisma: PrismaService,
    private readonly alerts: AlertsService,
    private readonly cases: CasesService,
    private readonly query: QueryService,
  ) {}

  // ---------------------------------------------------------------- management

  async list(user: AuthUser) {
    const functions = await this.prisma.function.findMany({
      where: { organisationId: user.organisationId },
      orderBy: [{ updatedAt: 'desc' }, { createdAt: 'desc' }],
    });
    const runs = await this.prisma.job.findMany({
      where: { organisationId: user.organisationId, type: 'function' },
      orderBy: { createdAt: 'desc' },
      take: 1000,
    });
    const lastRuns = new Map<string, any>();
    for (const job of runs) {
      const payload: any = job.payload || {};
      if (payload.functionId && !lastRuns.has(payload.functionId)) {
        const result: any = job.result || {};
        lastRuns.set(payload.functionId, {
          id: job.id,
          status: job.status,
          createdAt: job.createdAt,
          durationMs: result.durationMs,
          dryRun: !!payload.dryRun,
          error: result.error || null,
        });
      }
    }
    return functions.map((fn) => ({ ...fn, lastRun: lastRuns.get(fn.id) || null }));
  }

  async get(user: AuthUser, id: string) {
    const fn = await this.prisma.function.findFirst({ where: { id, organisationId: user.organisationId } });
    if (!fn) throw new NotFoundException('Function not found');
    return fn;
  }

  async findByName(user: AuthUser, name: string) {
    const fn = await this.prisma.function.findFirst({ where: { name, organisationId: user.organisationId } });
    if (!fn) throw new NotFoundException('Function not found');
    return fn;
  }

  async create(user: AuthUser, data: any) {
    this.validateFields(data, false);
    const mode = data.mode || (data.enabled === false ? 'Disabled' : 'Enabled');
    try {
      return await this.prisma.function.create({
        data: {
          organisationId: user.organisationId,
          name: String(data.name),
          description: data.description || '',
          code: String(data.code ?? ''),
          kind: data.kind || 'api',
          mode,
          enabled: mode !== 'Disabled',
          createdById: user.id,
        },
      });
    } catch (error: any) {
      if (error?.code === 'P2002') throw new ConflictException(`A function named "${data.name}" already exists`);
      throw error;
    }
  }

  async update(user: AuthUser, id: string, data: any) {
    const existing = await this.get(user, id);
    this.validateFields(data, true);
    let mode = data.mode;
    if (!mode && data.enabled !== undefined) mode = data.enabled ? 'Enabled' : 'Disabled';
    try {
      return await this.prisma.function.update({
        where: { id },
        data: {
          name: data.name !== undefined ? String(data.name) : undefined,
          description: data.description !== undefined ? data.description : undefined,
          code: data.code !== undefined ? String(data.code) : undefined,
          kind: data.kind !== undefined ? data.kind : undefined,
          mode: mode !== undefined ? mode : undefined,
          enabled: mode !== undefined ? mode !== 'Disabled' : data.enabled,
        },
      });
    } catch (error: any) {
      if (error?.code === 'P2002') throw new ConflictException(`A function named "${data.name}" already exists`);
      throw error;
    }
  }

  async remove(user: AuthUser, id: string) {
    await this.get(user, id);
    await this.prisma.function.delete({ where: { id } });
    await this.purgeRuns(id, user.organisationId).catch(() => undefined);
    return { ok: true };
  }

  async runs(user: AuthUser, id: string, limit = 50) {
    const fn = await this.get(user, id);
    const take = Math.min(MAX_RUNS_PER_FUNCTION, Math.max(1, Number(limit) || 50));
    return this.prisma.job.findMany({
      where: {
        organisationId: user.organisationId,
        type: 'function',
        payload: { path: ['functionId'], equals: fn.id },
      },
      orderBy: { createdAt: 'desc' },
      take,
    });
  }

  async actions(user: AuthUser, target: string) {
    const kind = target === 'alert' ? 'action:alert' : 'action:case';
    return this.prisma.function.findMany({
      where: { organisationId: user.organisationId, kind, mode: 'Enabled' },
      orderBy: { name: 'asc' },
    });
  }

  async runAction(user: AuthUser, target: 'case' | 'alert', objectId: string, functionId: string) {
    const fn = await this.get(user, functionId);
    const expected = target === 'case' ? 'action:case' : 'action:alert';
    if (fn.kind !== expected) throw new BadRequestException(`This function is not a ${expected} action`);
    if (fn.mode === 'Disabled') throw new ConflictException('Function is disabled');
    const object = target === 'case' ? mapCase(await this.cases.getCase(user, objectId)) : mapAlert(await this.alerts.get(user, objectId));
    return this.run(fn, target === 'case' ? { case: object } : { alert: object }, { user, dryRun: fn.mode === 'DryRun' });
  }

  // ---------------------------------------------------------------- validation

  validateFields(data: any, partial: boolean) {
    if (!partial || data.name !== undefined) {
      const name = String(data?.name ?? '');
      if (!NAME_PATTERN.test(name)) {
        throw new BadRequestException('name must match ^[a-zA-Z0-9_-]{1,64}$');
      }
    }
    if (data.kind !== undefined && !FUNCTION_KINDS.includes(data.kind)) {
      throw new BadRequestException(`kind must be one of ${FUNCTION_KINDS.join(', ')}`);
    }
    if (data.mode !== undefined && !FUNCTION_MODES.includes(data.mode)) {
      throw new BadRequestException(`mode must be one of ${FUNCTION_MODES.join(', ')}`);
    }
    if (!partial || data.code !== undefined) {
      const error = this.validateCode(String(data?.code ?? ''));
      if (error) throw new BadRequestException(`Invalid function code: ${error}`);
    }
  }

  validateCode(code: string): string | null {
    const context = vm.createContext(
      { console: { log() {}, info() {}, warn() {}, error() {}, debug() {} } },
      { name: 'myhive-function-validation' },
    );
    try {
      new vm.Script(code, { filename: 'function.js' }).runInContext(context, { timeout: 1000 });
    } catch (error: any) {
      return error?.message || String(error);
    }
    try {
      const exists = new vm.Script("typeof handle === 'function'").runInContext(context, { timeout: 1000 });
      return exists ? null : 'The code must define function handle(input, context)';
    } catch (error: any) {
      return error?.message || String(error);
    }
  }

  // ---------------------------------------------------------------- execution

  async run(fn: any, input: any, options: { user: AuthUser; dryRun?: boolean }): Promise<FunctionRunResult> {
    const started = Date.now();
    const logs: string[] = [];
    const calls: { call: string; args: any[] }[] = [];
    const dryRun = !!options.dryRun || fn.mode === 'DryRun';
    let output: any = null;
    let error: string | null = null;
    let timedOut = false;

    try {
      const organisationName = await this.organisationName(options.user.organisationId);
      const outcome = await this.spawnWorker(fn, input, {
        user: options.user,
        organisation: { id: options.user.organisationId, name: organisationName },
        dryRun,
        logs,
        calls,
      });
      output = outcome.output;
      error = outcome.error;
      timedOut = outcome.timedOut;
    } catch (e: any) {
      error = this.errorText(e);
    }

    const durationMs = Date.now() - started;
    const result: FunctionRunResult = { output, logs, calls, durationMs, error, timedOut, dryRun };
    await this.recordJob(fn, input, result, options.user).catch((e) =>
      this.logger.warn(`Could not record function run: ${e?.message || e}`),
    );
    return result;
  }

  private spawnWorker(
    fn: any,
    input: any,
    context: { user: AuthUser; organisation: any; dryRun: boolean; logs: string[]; calls: any[] },
  ): Promise<{ output: any; error: string | null; timedOut: boolean }> {
    return new Promise((resolve) => {
      let worker: Worker;
      try {
        worker = new Worker(this.workerPath, {
          workerData: {
            code: fn.code,
            input: this.jsonSafe(input),
            user: { login: context.user.login, name: context.user.name },
            organisation: context.organisation,
          },
          resourceLimits: { maxOldGenerationSizeMb: 256 },
        });
      } catch (e: any) {
        resolve({ output: null, error: this.errorText(e), timedOut: false });
        return;
      }

      let settled = false;
      let output: any = null;
      let error: string | null = null;
      let timedOut = false;

      const finish = () => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        worker.terminate().catch(() => undefined);
        resolve({ output, error, timedOut });
      };

      const timer = setTimeout(() => {
        timedOut = true;
        error = `Function execution timed out after ${EXECUTION_TIMEOUT_MS}ms`;
        finish();
      }, EXECUTION_TIMEOUT_MS);

      const reply = (message: any) => {
        try {
          worker.postMessage(message);
        } catch {
          // Worker already gone (timeout or result).
        }
      };

      worker.on('message', (message: any) => {
        if (message?.type === 'log') {
          if (context.logs.length < MAX_LOGS) context.logs.push(String(message.line));
          return;
        }
        if (message?.type === 'call') {
          this.handleCall(message.call, message.args, context).then(
            (value) => reply({ type: 'response', id: message.id, value: this.jsonSafe(value) }),
            (e) => reply({ type: 'response', id: message.id, error: this.errorText(e) }),
          );
          return;
        }
        if (message?.type === 'result') {
          output = message.output;
          finish();
          return;
        }
        if (message?.type === 'error') {
          error = message.error;
          timedOut = !!message.timedOut;
          finish();
        }
      });
      worker.on('error', (e: any) => {
        error = this.errorText(e);
        finish();
      });
      worker.on('exit', (code: number) => {
        if (!settled) {
          if (!error && code !== 0) error = `Function worker exited with code ${code}`;
          finish();
        }
      });
    });
  }

  private async handleCall(
    call: string,
    rawArgs: any,
    context: { user: AuthUser; dryRun: boolean; calls: any[] },
  ): Promise<any> {
    const args = Array.isArray(rawArgs) ? rawArgs : [];
    if (context.dryRun && MUTATING_CALLS.has(call)) {
      context.calls.push({ call, args: this.jsonSafe(args) });
      return this.dryRunResult(call, args);
    }
    const user = context.user;
    switch (call) {
      case 'alert.create':
        return mapAlert(await this.alerts.create(user, normaliseAlertInput(args[0] || {})));
      case 'alert.get':
        return mapAlert(await this.alerts.get(user, String(args[0])));
      case 'alert.update':
        return mapAlert(await this.alerts.update(user, String(args[0]), normaliseAlertInput(args[1] || {})));
      case 'alert.find':
        return this.findWith('listAlert', args[0], user);
      case 'alert.createCase':
        return mapCase(await this.alerts.importToCase(user, String(args[0]), normaliseCaseInput(args[1] || {})));
      case 'alert.merge':
        return mapCase(await this.alerts.mergeIntoCase(user, String(args[0]), String(args[1])));

      case 'case.create':
        return mapCase(await this.cases.createCase(user, normaliseCaseInput(args[0] || {})));
      case 'case.get':
        return mapCase(await this.cases.getCase(user, String(args[0])));
      case 'case.update':
        await this.cases.updateCase(user, String(args[0]), normaliseCaseInput(args[1] || {}));
        return mapCase(await this.cases.getCase(user, String(args[0])));
      case 'case.find':
        return this.findWith('listCase', args[0], user);
      case 'case.addObservable':
        return mapObservable(
          await this.cases.createObservable(user, { ...normaliseObservableInput(args[1] || {}), caseId: String(args[0]) }),
        );
      case 'case.addTask':
        return mapTask(await this.cases.createTask(user, String(args[0]), normaliseTaskInput(args[1] || {})));
      case 'case.addComment':
        return mapComment(
          await this.cases.createComment(user, { message: String(args[1] || ''), objectType: 'case', objectId: String(args[0]) }),
        );

      case 'observable.find':
        return this.findWith('listObservable', args[0], user);

      case 'query': {
        if (!Array.isArray(args[0]) || args[0].length === 0) throw new BadRequestException('query array is required');
        return this.query.execute(user, { query: args[0] });
      }
      default:
        throw new Error(`Unknown context call: ${call}`);
    }
  }

  private async findWith(starter: string, filter: any, user: AuthUser) {
    const query: any[] = [{ _name: starter }];
    if (filter && typeof filter === 'object' && Object.keys(filter).length) query.push({ _name: 'filter', ...filter });
    return this.query.execute(user, { query });
  }

  private dryRunResult(call: string, args: any[]) {
    const type = call.startsWith('alert') ? 'Alert' : call.startsWith('case') ? 'Case' : call.startsWith('observable') ? 'Observable' : undefined;
    const first = args[0];
    const body = first && typeof first === 'object' && !Array.isArray(first) ? first : {};
    return { _id: 'dry-run', ...(type ? { _type: type } : {}), ...body };
  }

  // ---------------------------------------------------------------- jobs

  private async recordJob(fn: any, input: any, result: FunctionRunResult, user: AuthUser) {
    const status = result.error || result.timedOut ? 'Failure' : 'Success';
    const now = Date.now();
    const job = await this.prisma.job.create({
      data: {
        organisationId: user.organisationId,
        type: 'function',
        status,
        payload: {
          functionId: fn.id,
          functionName: fn.name,
          dryRun: result.dryRun,
          input: this.truncate(input),
        },
        result: {
          durationMs: result.durationMs,
          logs: result.logs,
          output: this.jsonSafe(result.output),
          calls: result.calls,
          error: result.error,
          timedOut: result.timedOut,
        },
        createdById: user.id,
        startedAt: new Date(now - result.durationMs),
        finishedAt: new Date(now),
      },
    });
    await this.purgeRuns(fn.id, user.organisationId).catch((e) =>
      this.logger.warn(`Could not trim function runs: ${e?.message || e}`),
    );
    return job;
  }

  private async purgeRuns(functionId: string, organisationId: string) {
    const old = await this.prisma.job.findMany({
      where: {
        organisationId,
        type: 'function',
        payload: { path: ['functionId'], equals: functionId },
      },
      orderBy: { createdAt: 'desc' },
      skip: MAX_RUNS_PER_FUNCTION,
      select: { id: true },
    });
    if (old.length) await this.prisma.job.deleteMany({ where: { id: { in: old.map((job) => job.id) } } });
  }

  // ---------------------------------------------------------------- helpers

  private async organisationName(organisationId: string) {
    const organisation = await this.prisma.organisation.findUnique({ where: { id: organisationId }, select: { name: true } });
    return organisation?.name || organisationId;
  }

  private jsonSafe(value: any) {
    try {
      const serialised = JSON.stringify(value);
      return serialised === undefined ? null : JSON.parse(serialised);
    } catch {
      return String(value);
    }
  }

  private truncate(value: any) {
    const safe = this.jsonSafe(value);
    let text = '';
    try {
      text = JSON.stringify(safe) ?? '';
    } catch {
      text = String(safe);
    }
    if (text.length > MAX_INPUT_BYTES) return { _truncated: true, preview: text.slice(0, MAX_INPUT_BYTES) };
    return safe;
  }

  private errorText(error: any) {
    const message = error?.message || String(error);
    const stack = String(error?.stack || '')
      .split('\n')
      .slice(0, 3)
      .join('\n');
    return stack ? `${message}\n${stack}` : message;
  }
}
