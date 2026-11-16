import { ArgumentsHost, Catch, ExceptionFilter, HttpException, HttpStatus, Logger } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { ExternalServiceError } from '../integrations/http-client';

/**
 * Turns Prisma / integration errors into meaningful HTTP responses instead of generic 500s.
 */
@Catch()
export class AllExceptionsFilter implements ExceptionFilter {
  private readonly logger = new Logger('Exceptions');

  catch(exception: unknown, host: ArgumentsHost) {
    const res = host.switchToHttp().getResponse();
    const req = host.switchToHttp().getRequest();

    if (exception instanceof HttpException) {
      const status = exception.getStatus();
      const body = exception.getResponse();
      return res.status(status).json(typeof body === 'string' ? { statusCode: status, message: body } : body);
    }

    let status = HttpStatus.INTERNAL_SERVER_ERROR;
    let message = 'Internal server error';

    if (exception instanceof Prisma.PrismaClientKnownRequestError) {
      switch (exception.code) {
        case 'P2002':
          status = HttpStatus.CONFLICT;
          message = `Already exists (unique: ${[].concat((exception.meta?.target as any) || []).join(', ') || 'constraint'})`;
          break;
        case 'P2025':
        case 'P2001':
          status = HttpStatus.NOT_FOUND;
          message = 'Not found';
          break;
        case 'P2003':
          status = HttpStatus.BAD_REQUEST;
          message = 'Invalid reference to a related object';
          break;
        default:
          status = HttpStatus.BAD_REQUEST;
          message = `Database error ${exception.code}`;
      }
    } else if (exception instanceof Prisma.PrismaClientValidationError) {
      status = HttpStatus.BAD_REQUEST;
      const lines = exception.message.split('\n').filter((l) => l.trim());
      message = `Invalid request: ${lines[lines.length - 1] || 'validation error'}`;
    } else if (exception instanceof ExternalServiceError) {
      status = HttpStatus.BAD_GATEWAY;
      message = exception.message;
    }

    if (status >= 500) this.logger.error(`${req.method} ${req.url}: ${(exception as any)?.stack || exception}`);
    return res.status(status).json({ statusCode: status, message });
  }
}
