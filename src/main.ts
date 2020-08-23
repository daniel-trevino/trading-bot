import { NestFactory } from '@nestjs/core'
import { AppModule } from './app.module'

async function bootstrap() {
  const app = await NestFactory.createApplicationContext(AppModule)

  // Starts the application with lifecycle events
  app.init()

  await app.close()
}
bootstrap()
