import {
  Body, Controller, Delete, Get, Param, Post, Query, Res, UploadedFile, UseInterceptors,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { ApiBearerAuth, ApiConsumes, ApiTags } from '@nestjs/swagger';
import type { Response } from 'express';
import { AuthUser, CurrentUser } from '../common/decorators/auth.decorators';
import { AttachmentsService } from './attachments.service';

@ApiTags('Attachments')
@ApiBearerAuth()
@Controller('attachments')
export class AttachmentsController {
  constructor(private readonly attachments: AttachmentsService) {}

  @Get()
  list(@CurrentUser() user: AuthUser, @Query('objectType') objectType?: string, @Query('objectId') objectId?: string) {
    return this.attachments.list(user.organisationId, objectType, objectId);
  }

  @ApiConsumes('multipart/form-data')
  @Post()
  @UseInterceptors(FileInterceptor('file'))
  upload(@CurrentUser() user: AuthUser, @UploadedFile() file: any, @Body() body: any) {
    return this.attachments.upload(user, file, body);
  }

  @Get(':id/download')
  async download(@Param('id') id: string, @Res() res: Response) {
    const { attachment, path } = await this.attachments.getForDownload(id);
    res.download(path, attachment.filename);
  }

  @Delete(':id')
  remove(@CurrentUser() user: AuthUser, @Param('id') id: string) {
    return this.attachments.remove(id, user.id);
  }
}
