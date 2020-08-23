import { Injectable, OnModuleInit, Logger } from '@nestjs/common'
import { LongShort } from 'src/algorithms/long-short.service'
import { ConfigService } from '@nestjs/config'

@Injectable()
export class BotService implements OnModuleInit {
  private readonly logger = new Logger(BotService.name)
  private readonly alpacaLongShort = new LongShort({
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
    await this.alpacaLongShort.run()
  }
}
