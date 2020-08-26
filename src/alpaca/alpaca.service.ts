import { Injectable, Logger } from '@nestjs/common'
import { Order, Clock } from './alpaca.types'
// eslint-disable-next-line @typescript-eslint/no-var-requires
const Alpaca = require('@alpacahq/alpaca-trade-api')

const MINUTE = 60000

@Injectable()
export class AlpacaService {
  instance: typeof Alpaca
  timeToClose: number
  sideType = { BUY: 'buy', SELL: 'sell' }
  positionType = { LONG: 'long', SHORT: 'short' }
  private readonly logger = new Logger(AlpacaService.name)

  constructor({ keyId, secretKey, paper = true }) {
    this.instance = new Alpaca({
      keyId: keyId,
      secretKey: secretKey,
      paper: paper,
    })

    this.timeToClose = null
  }

  async awaitMarketOpen(): Promise<void> {
    return new Promise(resolve => {
      const check = async () => {
        try {
          const clock = await this.instance.getClock()
          if (clock.is_open) {
            resolve()
          } else {
            const openTime = await this.getOpenTime()
            const currTime = await this.getCurrentTime()
            this.timeToClose = Math.floor((openTime - currTime) / 1000 / 60)
            this.logger.log(
              `${this.numberToHourMinutes(
                this.timeToClose,
              )} til next market open.`,
            )
            setTimeout(check, MINUTE)
          }
        } catch (err) {
          this.logger.error(err.error)
        }
      }
      check()
    })
  }

  async getOpenTime(): Promise<number> {
    const clock: Clock = await this.instance.getClock()
    return new Date(
      clock.next_open.substring(0, clock.next_close.length - 6),
    ).getTime()
  }

  async getClosingTime(): Promise<number> {
    const clock: Clock = await this.instance.getClock()
    return new Date(
      clock.next_close.substring(0, clock.next_close.length - 6),
    ).getTime()
  }

  async getCurrentTime(): Promise<number> {
    const clock: Clock = await this.instance.getClock()
    return new Date(
      clock.timestamp.substring(0, clock.timestamp.length - 6),
    ).getTime()
  }

  async getTimeToClose(): Promise<number> {
    const closingTime = await this.getClosingTime()
    const currentTime = await this.getCurrentTime()
    return Math.abs(closingTime - currentTime)
  }

  numberToHourMinutes(number: number): string {
    const hours = number / 60
    const realHours = Math.floor(hours)
    const minutes = (hours - realHours) * 60
    const realMinutes = Math.round(minutes)
    return realHours + ' hour(s) and ' + realMinutes + ' minute(s)'
  }

  async cancelExistingOrders(): Promise<Order[]> {
    let orders: Order[]
    try {
      orders = await this.instance.getOrders({
        status: 'open',
        direction: 'desc',
      })
    } catch (err) {
      this.logger.error(err.error)
    }

    this.logger.log('Canceling existing orders...')
    return Promise.all<Order>(
      orders.map(order => {
        return new Promise(async resolve => {
          try {
            await this.instance.cancelOrder(order.id)
          } catch (err) {
            this.logger.error(err.error)
          }
          resolve()
        })
      }),
    )
  }

  // Submit an order if quantity is above 0.
  async submitOrder({ quantity, stock, side }): Promise<boolean> {
    return new Promise(async resolve => {
      if (quantity <= 0) {
        this.logger.log(
          `Quantity is <=0, order of | ${quantity} ${stock} ${side} | not sent.`,
        )
        resolve(true)
        return
      }

      try {
        await this.instance.createOrder({
          symbol: stock,
          qty: quantity,
          side,
          type: 'market',
          time_in_force: 'day',
        })
        this.logger.log(
          `Market order of | ${quantity} ${stock} ${side} | completed.`,
        )
        resolve(true)
      } catch (err) {
        this.logger.log(
          `Order of | ${quantity} ${stock} ${side} | did not go through.`,
        )
        resolve(false)
      }
    })
  }

  // Submit a limit order if quantity is above 0.
  async submitLimitOrder({
    quantity,
    stock,
    price,
    side,
  }): Promise<any | undefined> {
    return new Promise(async resolve => {
      if (quantity <= 0) {
        this.logger.log(
          `Quantity is <=0, order of | ${quantity} ${stock} ${side} | not sent.`,
        )
        resolve(true)
        return
      }

      try {
        const lastOrder = await this.instance.createOrder({
          symbol: stock,
          qty: quantity,
          side: side,
          type: 'limit',
          time_in_force: 'day',
          limit_price: price,
        })
        this.logger.log(
          'Limit order of |' + quantity + ' ' + stock + ' ' + side + '| sent.',
        )

        resolve(lastOrder)
      } catch (err) {
        this.logger.error(
          'Order of |' +
            quantity +
            ' ' +
            stock +
            ' ' +
            side +
            '| did not go through.',
        )
        resolve(undefined)
      }
    })
  }
}
