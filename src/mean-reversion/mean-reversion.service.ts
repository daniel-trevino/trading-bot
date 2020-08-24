import { Injectable, Logger } from '@nestjs/common'
import { AlpacaService } from 'src/alpaca/alpaca.service'

@Injectable()
export class MeanReversionService {
  alpaca: AlpacaService
  runningAverage: number
  lastOrder: any
  timeToClose: number
  // Stock that the algo will trade.
  stock: string
  private readonly logger = new Logger(MeanReversionService.name)

  constructor({ keyId, secretKey, paper = true }) {
    this.alpaca = new AlpacaService({
      keyId: keyId,
      secretKey: secretKey,
      paper: paper,
    })

    this.timeToClose = null

    this.runningAverage = 0
    this.lastOrder = null
    // Stock that the algo will trade.
    this.stock = 'AAPL'
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
