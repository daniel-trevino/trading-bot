import { Injectable, Logger } from '@nestjs/common'
// eslint-disable-next-line @typescript-eslint/no-var-requires
const Alpaca = require('@alpacahq/alpaca-trade-api')

const MINUTE = 60000
const USE_POLYGON = false

type Order = { id: number }

@Injectable()
export class LongShort {
  alpaca: typeof Alpaca
  timeToClose: number
  private readonly logger = new Logger(LongShort.name)

  constructor({ keyId, secretKey, paper = true, bucketPct = 0.25 }) {
    this.alpaca = new Alpaca({
      keyId: keyId,
      secretKey: secretKey,
      paper: paper,
      usePolygon: USE_POLYGON,
    })

    this.timeToClose = null
  }

  async awaitMarketOpen(): Promise<void> {
    return new Promise(resolve => {
      const check = async () => {
        try {
          const clock = await this.alpaca.getClock()
          if (clock.is_open) {
            resolve()
          } else {
            const openTime = this.getOpenTime(clock)
            const currTime = this.getCurrentTime(clock)
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

  getOpenTime(clock: { next_open: string; next_close: string }): number {
    return new Date(
      clock.next_open.substring(0, clock.next_close.length - 6),
    ).getTime()
  }

  getCurrentTime(clock: { timestamp: string }): number {
    return new Date(
      clock.timestamp.substring(0, clock.timestamp.length - 6),
    ).getTime()
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
      orders = await this.alpaca.getOrders({
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
            await this.alpaca.cancelOrder(order.id)
          } catch (err) {
            this.logger.error(err.error)
          }
          resolve()
        })
      }),
    )
  }
}
