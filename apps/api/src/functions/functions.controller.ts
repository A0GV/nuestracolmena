import {
  BadRequestException,
  Body,
  ConflictException,
  Controller,
  Delete,
  ForbiddenException,
  GatewayTimeoutException,
  Get,
  Param,
  Patch,
  Post,
  Query,
} from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { AuthUser, CurrentUser, RequirePermissions } from '../common/decorators/auth.decorators';
import { FunctionsService } from './functions.service';

function assertCanInvoke(user: AuthUser) {
  if (!user.permissions?.includes('manageFunction/invoke') && !user.permissions?.includes('manageConfig')) {
    throw new ForbiddenException('Missing permission: manageFunction/invoke');
  }
}

export function invokeResponse(result: any) {
  if (result.timedOut) throw new GatewayTimeoutException({ error: result.error, logs: result.logs });
  if (result.error) throw new BadRequestException({ error: result.error, logs: result.logs });
  return result.output ?? null;
}

@ApiTags('Functions')
@ApiBearerAuth()
@Controller('functions')
export class FunctionsController {
  constructor(private readonly functions: FunctionsService) {}

  @RequirePermissions('manageConfig')
  @Get()
  list(@CurrentUser() user: AuthUser) {
    return this.functions.list(user);
  }

  @Get('actions')
  actions(@CurrentUser() user: AuthUser, @Query('target') target?: string) {
    assertCanInvoke(user);
    if (target !== 'case' && target !== 'alert') throw new BadRequestException('target must be case or alert');
    return this.functions.actions(user, target);
  }

  @RequirePermissions('manageConfig')
  @Post()
  create(@CurrentUser() user: AuthUser, @Body() body: any) {
    return this.functions.create(user, body || {});
  }

  @RequirePermissions('manageConfig')
  @Get(':id')
  get(@CurrentUser() user: AuthUser, @Param('id') id: string) {
    return this.functions.get(user, id);
  }

  @RequirePermissions('manageConfig')
  @Patch(':id')
  update(@CurrentUser() user: AuthUser, @Param('id') id: string, @Body() body: any) {
    return this.functions.update(user, id, body || {});
  }

  @RequirePermissions('manageConfig')
  @Delete(':id')
  remove(@CurrentUser() user: AuthUser, @Param('id') id: string) {
    return this.functions.remove(user, id);
  }

  @RequirePermissions('manageConfig')
  @Post(':id/test')
  async test(@CurrentUser() user: AuthUser, @Param('id') id: string, @Body() body: any) {
    const fn = await this.functions.get(user, id);
    const result = await this.functions.run(fn, body?.input ?? {}, { user, dryRun: body?.dryRun !== false });
    return {
      output: result.output,
      logs: result.logs,
      calls: result.calls,
      durationMs: result.durationMs,
      ...(result.error ? { error: result.error } : {}),
      dryRun: result.dryRun,
      timedOut: result.timedOut,
    };
  }

  @RequirePermissions('manageConfig')
  @Get(':id/runs')
  runs(@CurrentUser() user: AuthUser, @Param('id') id: string, @Query('limit') limit?: string) {
    return this.functions.runs(user, id, Number(limit || 50));
  }

  @Post(':id/invoke')
  async invoke(@CurrentUser() user: AuthUser, @Param('id') id: string, @Body() body: any, @Query('dryRun') dryRun?: string) {
    assertCanInvoke(user);
    const fn = await this.functions.get(user, id);
    if (fn.mode === 'Disabled') throw new ConflictException({ error: 'Function is disabled' });
    const result = await this.functions.run(fn, body ?? {}, { user, dryRun: dryRun === 'true' });
    return {
      output: result.output,
      logs: result.logs,
      calls: result.calls,
      durationMs: result.durationMs,
      ...(result.error ? { error: result.error } : {}),
      timedOut: result.timedOut,
    };
  }
}

@ApiTags('Functions')
@ApiBearerAuth()
@Controller()
export class FunctionInvokeController {
  constructor(private readonly functions: FunctionsService) {}

  @Post('function/:name')
  async invokeByName(
    @CurrentUser() user: AuthUser,
    @Param('name') name: string,
    @Body() body: any,
    @Query('dryRun') dryRun?: string,
  ) {
    assertCanInvoke(user);
    const fn = await this.functions.findByName(user, name);
    if (fn.mode === 'Disabled') throw new ConflictException({ error: 'Function is disabled' });
    const result = await this.functions.run(fn, body ?? {}, { user, dryRun: dryRun === 'true' });
    return invokeResponse(result);
  }

  @Post('cases/:id/functions/:functionId')
  async runCaseAction(
    @CurrentUser() user: AuthUser,
    @Param('id') id: string,
    @Param('functionId') functionId: string,
  ) {
    assertCanInvoke(user);
    const result = await this.functions.runAction(user, 'case', id, functionId);
    if (result.timedOut) throw new GatewayTimeoutException({ error: result.error, logs: result.logs });
    if (result.error) throw new BadRequestException({ error: result.error, logs: result.logs });
    return { output: result.output, logs: result.logs, calls: result.calls, durationMs: result.durationMs };
  }

  @Post('alerts/:id/functions/:functionId')
  async runAlertAction(
    @CurrentUser() user: AuthUser,
    @Param('id') id: string,
    @Param('functionId') functionId: string,
  ) {
    assertCanInvoke(user);
    const result = await this.functions.runAction(user, 'alert', id, functionId);
    if (result.timedOut) throw new GatewayTimeoutException({ error: result.error, logs: result.logs });
    if (result.error) throw new BadRequestException({ error: result.error, logs: result.logs });
    return { output: result.output, logs: result.logs, calls: result.calls, durationMs: result.durationMs };
  }
}
