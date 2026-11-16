import { Body, Controller, Delete, Get, Param, Post, UploadedFile, UseInterceptors } from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { ApiBearerAuth, ApiConsumes, ApiTags } from '@nestjs/swagger';
import { AuthUser, CurrentUser, RequirePermissions } from '../common/decorators/auth.decorators';
import { MitreService } from './mitre.service';

@ApiTags('MITRE ATT&CK')
@ApiBearerAuth()
@Controller()
export class MitreController {
  constructor(private readonly mitre: MitreService) {}

  @RequirePermissions('managePattern')
  @ApiConsumes('multipart/form-data')
  @Post('patterns/import')
  @UseInterceptors(FileInterceptor('file'))
  importPatterns(
    @CurrentUser() user: AuthUser,
    @Body() body: any,
    @UploadedFile() file?: { buffer?: Buffer },
  ) {
    const url = body?.url ? String(body.url) : undefined;
    return this.mitre.startImport(user, { url, file: file?.buffer });
  }

  @RequirePermissions('managePattern')
  @Get('patterns/import/:jobId')
  importJob(@Param('jobId') jobId: string) {
    return this.mitre.getImportJob(jobId);
  }

  @Get('tactics')
  tactics() {
    return this.mitre.tactics();
  }

  @RequirePermissions('managePattern')
  @Delete('patterns/:patternId')
  deletePattern(@Param('patternId') patternId: string) {
    return this.mitre.deletePattern(patternId);
  }

  @RequirePermissions('managePattern')
  @Delete('tactics/:tacticId')
  deleteTactic(@Param('tacticId') tacticId: string) {
    return this.mitre.deleteTactic(tacticId);
  }
}
