import { Module } from '@nestjs/common';
import { MitreController } from './mitre.controller';
import { MitreService } from './mitre.service';

@Module({
  controllers: [MitreController],
  providers: [MitreService],
  exports: [MitreService],
})
export class MitreModule {}
