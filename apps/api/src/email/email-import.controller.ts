import { Body, Controller, Post, UploadedFiles, UseInterceptors } from '@nestjs/common';
import { ApiBearerAuth, ApiConsumes, ApiTags } from '@nestjs/swagger';
import { FilesInterceptor } from '@nestjs/platform-express';
import { AuthUser, CurrentUser, RequirePermissions } from '../common/decorators/auth.decorators';
import { EmailIntakeService } from './email-intake.service';

@ApiTags('Alerts')
@ApiBearerAuth()
@Controller('alerts')
export class EmailImportController {
  constructor(private readonly intake: EmailIntakeService) {}

  @ApiConsumes('multipart/form-data')
  @RequirePermissions('manageAlert/create')
  @Post('import-eml')
  @UseInterceptors(FilesInterceptor('file', 100))
  import(@CurrentUser() user: AuthUser, @UploadedFiles() files: any[], @Body() body: any) {
    return this.intake.importFiles(user, files, {
      source: 'manual-eml',
      tlp: Number(body?.tlp ?? 2),
      severity: Number(body?.severity ?? 2),
      tags: Array.isArray(body?.tags) ? body.tags : undefined,
    });
  }
}
