import { Injectable, Logger } from '@nestjs/common'
import { AlpacaService } from 'src/alpaca/alpaca.service'

const MINUTE = 60000
const TWENTY_MINUTES = 20

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

    await this.getAvgPricesOnLastXMinutes(TWENTY_MINUTES)
  }

  async getAvgPricesOnLastXMinutes(minutes: number): Promise<void> {
    // Get the running average of prices of the last 20 minutes, waiting until we have 20 bars from market open.
    const promBars = new Promise((resolve, reject) => {
      const barChecker = setInterval(async () => {
        await this.alpaca.instance.getCalendar(Date.now()).then(async resp => {
          const marketOpen = resp[0].open
          await this.alpaca.instance
            .getBars('minute', this.stock, { start: marketOpen })
            .then(resp => {
              const bars = resp[this.stock]
              if (bars.length >= minutes) {
                clearInterval(barChecker)
                resolve()
              }
            })
            .catch(err => {
              this.logger.error(err.error, 'promBars')
            })
        })
      }, MINUTE)
    })
    this.logger.log('Waiting for 20 bars...')
    await promBars
    this.logger.log('We have 20 bars.')

    // Rebalance our portfolio every minute based off running average data.
    const spin = setInterval(async () => {
      // Clear the last order so that we only have 1 hanging order.
      if (this.lastOrder != null)
        await this.alpaca.instance.cancelOrder(this.lastOrder.id).catch(err => {
          this.logger.error(err.error, 'CancelOrder')
        })

      // Figure out when the market will close so we can prepare to sell beforehand.
      const INTERVAL = 15 // minutes

      this.timeToClose = await this.alpaca.getTimeToClose()

      if (this.timeToClose < MINUTE * INTERVAL) {
        // Close all positions when 15 minutes til market close.
        this.logger.log('Market closing soon.  Closing positions.')
        try {
          await this.alpaca.instance
            .getPosition(this.stock)
            .then(async resp => {
              const positionQuantity = resp.qty
              await this.alpaca.submitOrder({
                quantity: positionQuantity,
                stock: this.stock,
                side: this.alpaca.sideType.SELL,
              })
            })
            .catch(err => {
              this.logger.error(err.error, 'Closing positions')
            })
        } catch (err) {
          /*console.log(err.error);*/
        }
        clearInterval(spin)
        this.logger.log('Sleeping until market close (15 minutes).')
        setTimeout(() => {
          // Run script again after market close for next trading day.
          this.run()
        }, 60000 * 15)
      } else {
        // Rebalance the portfolio.
        await this.rebalance()
      }
    }, 60000)
  }

  // Rebalance our position after an update.
  async rebalance(): Promise<void> {
    let positionQuantity = 0
    let positionValue = 0

    // Get our position, if any.
    try {
      await this.alpaca.instance.getPosition(this.stock).then(resp => {
        positionQuantity = resp.qty
        positionValue = resp.market_value
      })
    } catch (err) {
      /*console.log(err.error);*/
    }

    // Get the new updated price and running average.
    let bars
    await this.alpaca.instance
      .getBars('minute', this.stock, { limit: 20 })
      .then(resp => {
        bars = resp[this.stock]
      })
      .catch(err => {
        console.log(err.error)
      })
    const currPrice = bars[bars.length - 1].closePrice
    this.runningAverage = 0
    bars.forEach(bar => {
      this.runningAverage += bar.closePrice
    })
    this.runningAverage /= 20

    if (currPrice > this.runningAverage) {
      // Sell our position if the price is above the running average, if any.
      if (positionQuantity > 0) {
        console.log('Setting position to zero.')
        this.lastOrder = await this.alpaca.submitLimitOrder({
          quantity: positionQuantity,
          stock: this.stock,
          price: currPrice,
          side: this.alpaca.sideType.SELL,
        })
      } else console.log('No position in the stock.  No action required.')
    } else if (currPrice < this.runningAverage) {
      // Determine optimal amount of shares based on portfolio and market data.
      let portfolioValue
      let buyingPower
      await this.alpaca.instance
        .getAccount()
        .then(resp => {
          portfolioValue = resp.portfolio_value
          buyingPower = resp.buying_power
        })
        .catch(err => {
          console.log(err.error)
        })
      const portfolioShare =
        ((this.runningAverage - currPrice) / currPrice) * 200
      const targetPositionValue = portfolioValue * portfolioShare
      let amountToAdd = targetPositionValue - positionValue

      // Add to our position, constrained by our buying power; or, sell down to optimal amount of shares.
      if (amountToAdd > 0) {
        if (amountToAdd > buyingPower) amountToAdd = buyingPower
        const qtyToBuy = Math.floor(amountToAdd / currPrice)
        this.lastOrder = await this.alpaca.submitLimitOrder({
          quantity: qtyToBuy,
          stock: this.stock,
          price: currPrice,
          side: this.alpaca.sideType.BUY,
        })
      } else {
        amountToAdd *= -1
        let qtyToSell = Math.floor(amountToAdd / currPrice)
        if (qtyToSell > positionQuantity) qtyToSell = positionQuantity
        this.lastOrder = await this.alpaca.submitLimitOrder({
          quantity: qtyToSell,
          stock: this.stock,
          price: currPrice,
          side: this.alpaca.sideType.SELL,
        })
      }
    }
  }
}
