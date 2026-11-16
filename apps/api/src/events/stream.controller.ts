import { Controller, Get, Req, Res } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import type { Request, Response } from 'express';
import { AuthUser, CurrentUser } from '../common/decorators/auth.decorators';
import { EventsService } from './events.module';

/** Object types the web refreshes live. */
const LIVE_TYPES = new Set(['Alert', 'Case', 'Task', 'Observable']);

/**
 * Server-Sent Events: pushes a small notice to the browser whenever an alert or
 * case of the user's organisation changes, so lists update the moment it happens.
 * Only ids and the action travel here; the web refetches through the normal API.
 */
@ApiTags('Events')
@ApiBearerAuth()
@Controller('stream')
export class StreamController {
  constructor(private readonly events: EventsService) {}

  @Get()
  stream(@CurrentUser() user: AuthUser, @Req() req: Request, @Res() res: Response) {
    res.status(200);
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache, no-transform');
    res.setHeader('Connection', 'keep-alive');
    // nginx: deliver each event immediately instead of buffering the response.
    res.setHeader('X-Accel-Buffering', 'no');
    res.flushHeaders();
    res.write(': conectado\n\n');

    const off = this.events.on((event) => {
      if (event.organisationId !== user.organisationId) return;
      if (!LIVE_TYPES.has(String(event.objectType))) return;
      const payload = {
        action: event.action,
        objectType: event.objectType,
        objectId: event.objectId,
        rootType: event.rootType ?? null,
        rootId: event.rootId,
        title: event.action === 'create' && event.objectType === 'Alert' ? event.details?.title ?? null : null,
        severity: event.action === 'create' && event.objectType === 'Alert' ? event.details?.severity ?? null : null,
      };
      res.write(`data: ${JSON.stringify(payload)}\n\n`);
    });
    // Comment line every 25 s keeps proxies (nginx default 60 s) from closing it.
    const ping = setInterval(() => res.write(': ping\n\n'), 25000);

    req.on('close', () => {
      clearInterval(ping);
      off();
    });
  }
}
