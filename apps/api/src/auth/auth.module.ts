import { Module } from '@nestjs/common';
import { JwtModule } from '@nestjs/jwt';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { AuthController } from './auth.controller';
import { AuthService } from './auth.service';

// Sin JWT_SECRET la API no arranca: un secreto por defecto conocido permitiría falsificar tokens.
function requireJwtSecret(secret: string | undefined): string {
  if (!secret) throw new Error('JWT_SECRET no está definido; ponlo en apps/api/.env (ver .env.example).');
  return secret;
}

@Module({
  imports: [
    JwtModule.registerAsync({
      imports: [ConfigModule],
      inject: [ConfigService],
      useFactory: (config: ConfigService) => ({
        secret: requireJwtSecret(config.get<string>('JWT_SECRET')),
        signOptions: { expiresIn: config.get('JWT_EXPIRES_IN') || '12h' },
      }),
    }),
  ],
  controllers: [AuthController],
  providers: [AuthService],
  exports: [JwtModule, AuthService],
})
export class AuthModule {}
