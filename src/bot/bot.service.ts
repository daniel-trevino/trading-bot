import { Injectable, OnModuleInit, Logger } from '@nestjs/common'
import { MeanReversionService } from '../mean-reversion/mean-reversion.service'
import { LongShortService } from 'src/long-short/long-short.service'
import { ConfigService } from '@nestjs/config'
import { BotType } from './bot.types'

@Injectable()
export class BotService implements OnModuleInit {
  private readonly logger = new Logger(BotService.name)
  private readonly meanReversion = new MeanReversionService({
    keyId: this.configService.get<string>('ALPACA_API_KEY'),
    secretKey: this.configService.get<string>('ALPACA_SECRET_KEY'),
    paper: true,
  })

  private readonly longShort = new LongShortService({
    keyId: this.configService.get<string>('ALPACA_API_KEY'),
    secretKey: this.configService.get<string>('ALPACA_SECRET_KEY'),
    paper: true,
  })

  constructor(private configService: ConfigService) {}

  onModuleInit(): void {
    this.logger.log(`Initializing ${BotService.name}`)
    this.run()
  }

  async run(): Promise<void> {
    const botType: BotType = this.configService.get<BotType>('BOT_TYPE')

    if (botType === BotType.LONG_SHORT) {
      this.logger.log('Initializing Long Short algorithm')
      await this.longShort.run()
    } else if (botType === BotType.MEAN_REVERSION) {
      this.logger.log('Initializing Mean Reversion algorithm')
      await this.meanReversion.run()
    } else {
      this.logger.error('Please include a valid BOT_TYPE env variable')
    }
  }
}
