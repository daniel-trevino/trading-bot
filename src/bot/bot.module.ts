import { Module } from '@nestjs/common'
import { BotService } from './bot.service'
import { ConfigModule } from '@nestjs/config'

@Module({
  imports: [ConfigModule],
  controllers: [],
  providers: [BotService],
})
export class BotModule {}
