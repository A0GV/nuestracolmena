import { NestFactory } from '@nestjs/core';
import { RequestMethod, ValidationPipe } from '@nestjs/common';
import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger';
import cookieParser from 'cookie-parser';
import { AppModule } from './app.module';
import { AllExceptionsFilter } from './common/exceptions.filter';

async function bootstrap() {
  const app = await NestFactory.create(AppModule);
  app.use(cookieParser());
  app.enableCors({
    origin: (process.env.CORS_ORIGIN || 'http://localhost:5173').split(','),
    credentials: true,
  });
  app.useGlobalPipes(new ValidationPipe({ whitelist: false, transform: true }));
  app.useGlobalFilters(new AllExceptionsFilter());
  app.enableShutdownHooks();
  // TheHive 5 exposes these routes under /api (without /v1). Native MyHive routes keep /api/v1.
  app.setGlobalPrefix('api/v1', {
    exclude: [
      { path: 'api/customField', method: RequestMethod.GET },
      { path: 'api/connector/cortex/analyzer/type/:dataType', method: RequestMethod.GET },
      { path: 'api/connector/cortex/job', method: RequestMethod.POST },
      { path: 'api/connector/cortex/job/:id', method: RequestMethod.GET },
      { path: 'api/connector/cortex/responder/:type/:id', method: RequestMethod.GET },
      { path: 'api/connector/cortex/action', method: RequestMethod.POST },
      // The n8n TheHive 5 node's merge operation omits /v1.
      { path: 'api/alert/:id/merge/:caseId', method: RequestMethod.POST },
      // TheHive 4 (v0) compatibility routes.
      { path: 'api/status', method: RequestMethod.GET },
      { path: 'api/user/current', method: RequestMethod.GET },
      { path: 'api/alert(.*)', method: RequestMethod.ALL },
      { path: 'api/case(.*)', method: RequestMethod.ALL },
    ],
  });

  const config = new DocumentBuilder()
    .setTitle('Nuestracolmena API')
    .setDescription('SIRP clone API')
    .setVersion('0.1.0')
    .addBearerAuth()
    .build();
  const document = SwaggerModule.createDocument(app, config);
  SwaggerModule.setup('api/docs', app, document);

  const port = Number(process.env.PORT || 4100);
  await app.listen(port, '0.0.0.0');
  console.log(`Nuestracolmena API listening on http://localhost:${port}/api/v1`);
  console.log(`Swagger: http://localhost:${port}/api/docs`);
}

bootstrap();
