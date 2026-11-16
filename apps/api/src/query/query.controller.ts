import { Body, Controller, Get, Post } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { AuthUser, CurrentUser } from '../common/decorators/auth.decorators';
import { QueryService } from './query.service';

@ApiTags('Query and Export')
@ApiBearerAuth()
@Controller()
export class QueryController {
  constructor(private readonly query: QueryService) {}

  @Post('query')
  execute(@CurrentUser() user: AuthUser, @Body() body: any) {
    return this.query.execute(user, body);
  }

  @Get('describe/_all')
  describe() {
    return this.query.describe();
  }
}
