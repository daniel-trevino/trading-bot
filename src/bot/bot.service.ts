import { Injectable, OnModuleInit, Logger } from '@nestjs/common'
import { LongShort } from 'src/algorithms/longShort.service'
import { ConfigService } from '@nestjs/config'

@Injectable()
export class BotService implements OnModuleInit {
  private readonly logger = new Logger(BotService.name)
  private readonly alpaca = new LongShort({
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
    // First, cancel any existing orders so they don't impact our buying power.
    await this.alpaca.cancelExistingOrders()

    // Wait for market to open.
    this.logger.log('Waiting for market to open...')
    await this.alpaca.awaitMarketOpen()
    this.logger.log('Market opened.')
  }
}
