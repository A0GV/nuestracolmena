import { Controller, Get } from '@nestjs/common';
import { Public } from './common/decorators/auth.decorators';
import { PrismaService } from './prisma/prisma.service';

@Controller()
export class HealthController {
  constructor(private readonly prisma: PrismaService) {}

  @Public()
  @Get('health')
  async health() {
    try {
      await this.prisma.$queryRaw`SELECT 1`;
      return { status: 'ok', database: 'up', timestamp: new Date().toISOString() };
    } catch {
      return { status: 'degraded', database: 'down', timestamp: new Date().toISOString() };
    }
  }
}
