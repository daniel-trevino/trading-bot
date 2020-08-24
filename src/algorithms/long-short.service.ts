import { Injectable, Logger } from '@nestjs/common'
import { STOCKS } from './long-short.constants'
import { StockItem, Order, Clock } from './long-short.types'
// eslint-disable-next-line @typescript-eslint/no-var-requires
const Alpaca = require('@alpacahq/alpaca-trade-api')

const MINUTE = 60000
const THIRTY_SECONDS = 30
const USE_POLYGON = false
const SideType = { BUY: 'buy', SELL: 'sell' }
const PositionType = { LONG: 'long', SHORT: 'short' }

@Injectable()
export class LongShort {
  alpaca: typeof Alpaca
  timeToClose: number
  stockList: StockItem[]
  long: string[]
  short: string[]
  qShort: number
  qLong: number
  adjustedQLong: number
  adjustedQShort: number
  blacklist: Set<string>
  longAmount: number
  shortAmount: number
  bucketPct: number
  private readonly logger = new Logger(LongShort.name)

  constructor({ keyId, secretKey, paper = true, bucketPct = 0.25 }) {
    this.alpaca = new Alpaca({
      keyId: keyId,
      secretKey: secretKey,
      paper: paper,
      usePolygon: USE_POLYGON,
    })

    this.timeToClose = null

    this.stockList = STOCKS.map(item => ({ name: item, pc: 0 }))

    this.long = []
    this.short = []
    this.qShort = null
    this.qLong = null
    this.adjustedQLong = null
    this.adjustedQShort = null
    this.blacklist = new Set()
    this.longAmount = 0
    this.shortAmount = 0
    this.timeToClose = null
    this.bucketPct = bucketPct
  }

  async run(): Promise<void> {
    // First, cancel any existing orders so they don't impact our buying power.
    await this.cancelExistingOrders()

    // Wait for market to open.
    this.logger.log('Waiting for market to open...')
    await this.awaitMarketOpen()
    this.logger.log('Market opened.')

    await this.rebalancePorfolio(THIRTY_SECONDS)
  }

  async awaitMarketOpen(): Promise<void> {
    return new Promise(resolve => {
      const check = async () => {
        try {
          const clock = await this.alpaca.getClock()
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
    const clock: Clock = await this.alpaca.getClock()
    return new Date(
      clock.next_open.substring(0, clock.next_close.length - 6),
    ).getTime()
  }

  async getClosingTime(): Promise<number> {
    const clock: Clock = await this.alpaca.getClock()
    return new Date(
      clock.next_close.substring(0, clock.next_close.length - 6),
    ).getTime()
  }

  async getCurrentTime(): Promise<number> {
    const clock: Clock = await this.alpaca.getClock()
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

  async rebalancePorfolio(seconds: number): Promise<void> {
    // Rebalance the portfolio every minute, making necessary trades.
    const spin = setInterval(async () => {
      // Figure out when the market will close so we can prepare to sell beforehand.
      try {
        const closingTime = await this.getClosingTime()
        const currTime = await this.getCurrentTime()
        this.timeToClose = Math.abs(closingTime - currTime)
      } catch (err) {
        this.logger.error(err.error)
      }

      const INTERVAL = 15 // minutes

      if (this.timeToClose < MINUTE * INTERVAL) {
        // Close all positions when 15 minutes til market close.
        this.logger.log('Market closing soon. Closing positions.')

        try {
          const positions = await this.alpaca.getPositions()

          await Promise.all(
            positions.map(position =>
              this.submitOrder({
                quantity: Math.abs(position.qty),
                stock: position.symbol,
                side:
                  position.side === PositionType.LONG
                    ? SideType.SELL
                    : SideType.BUY,
              }),
            ),
          )
        } catch (err) {
          this.logger.error(err.error)
        }

        clearInterval(spin)
        this.logger.log(`Sleeping until market close (${INTERVAL} minutes).`)

        setTimeout(() => {
          // Run script again after market close for next trading day.
          this.run()
        }, MINUTE * INTERVAL)
      } else {
        // Rebalance the portfolio.
        await this.rebalance()
      }
    }, seconds * 1000)
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
        await this.alpaca.createOrder({
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

  // Get percent changes of the stock prices over the past 10 minutes.
  getPercentChanges(limit = 10): Promise<unknown> {
    return Promise.all(
      this.stockList.map(stock => {
        return new Promise(async resolve => {
          try {
            const resp = await this.alpaca.getBars('minute', stock.name, {
              limit: limit,
            })
            // polygon and alpaca have different responses to keep backwards
            // compatibility, so we handle it a bit differently
            if (this.alpaca.configuration.usePolygon) {
              const l = resp[stock.name].length
              const last_close = resp[stock.name][l - 1].c
              const first_open = resp[stock.name][0].o
              stock.pc = (last_close - first_open) / first_open
            } else {
              const l = resp[stock.name].length
              const last_close = resp[stock.name][l - 1].closePrice
              const first_open = resp[stock.name][0].openPrice
              stock.pc = (last_close - first_open) / first_open
            }
          } catch (err) {
            this.logger.error(err.message)
          }
          resolve()
        })
      }),
    )
  }

  // Mechanism used to rank the stocks, the basis of the Long-Short Equity Strategy.
  async rank(): Promise<void> {
    // Ranks all stocks by percent change over the past 10 minutes (higher is better).
    await this.getPercentChanges()

    // Sort the stocks in place by the percent change field (marked by pc).
    this.stockList.sort((a, b) => {
      return a.pc - b.pc
    })
  }

  // Re-rank all stocks to adjust longs and shorts.
  async rerank(): Promise<void> {
    await this.rank()
    // Grabs the top and bottom bucket (according to percentage) of the sorted stock list
    // to get the long and short lists.
    const bucketSize = Math.floor(this.stockList.length * this.bucketPct)

    this.short = this.stockList.slice(0, bucketSize).map(item => item.name)
    this.long = this.stockList
      .slice(this.stockList.length - bucketSize)
      .map(item => item.name)

    // Determine amount to long/short based on total stock price of each bucket.
    // Employs 130-30 Strategy
    try {
      const result = await this.alpaca.getAccount()
      const equity = result.equity
      this.shortAmount = 0.3 * equity
      this.longAmount = Number(this.shortAmount) + Number(equity)
    } catch (err) {
      this.logger.error(err.error)
    }

    try {
      const longPrices = await this.getTotalPrice(this.long)
      const longTotal = longPrices.reduce((a, b) => a + b, 0)
      this.qLong = Math.floor(this.longAmount / longTotal)
    } catch (err) {
      this.logger.error(err.error)
    }

    try {
      const shortPrices = await this.getTotalPrice(this.short)
      const shortTotal = shortPrices.reduce((a, b) => a + b, 0)
      this.qShort = Math.floor(this.shortAmount / shortTotal)
    } catch (err) {
      this.logger.error(err.error)
    }
  }

  // Get the total price of the array of input stocks.
  async getTotalPrice(stocks = []): Promise<number[]> {
    return Promise.all<number>(
      stocks.map(stock => {
        return new Promise(async resolve => {
          try {
            const resp = await this.alpaca.getBars('minute', stock, {
              limit: 1,
            })
            // polygon and alpaca have different responses to keep backwards
            // compatibility, so we handle it a bit differently
            if (this.alpaca.configuration.usePolygon) {
              resolve(resp[stock][0].c)
            } else {
              resolve(resp[stock][0].closePrice)
            }
          } catch (err) {
            this.logger.error(err.message)
          }
        })
      }),
    )
  }

  // Rebalance our position after an update.
  async rebalance(): Promise<void> {
    await this.rerank()

    // Clear existing orders again.
    await this.cancelExistingOrders()

    this.logger.log(`We are taking a long position in: ${this.long.toString()}`)
    this.logger.log(
      `We are taking a short position in: ${this.short.toString()}`,
    )

    // Remove positions that are no longer in the short or long list, and make a list of positions that do not need to change.
    // Adjust position quantities if needed.
    let positions
    try {
      positions = await this.alpaca.getPositions()
    } catch (err) {
      this.logger.error(err.error)
    }

    const executed = { long: [], short: [] }

    this.blacklist.clear()

    await Promise.all(
      positions.map(position => {
        return new Promise(async (resolve, reject) => {
          const quantity = Math.abs(position.qty)
          const symbol = position.symbol

          if (this.long.indexOf(symbol) < 0) {
            // Position is not in short list.
            if (this.short.indexOf(symbol) < 0) {
              // Clear position.
              try {
                await this.submitOrder({
                  quantity,
                  stock: symbol,
                  side:
                    position.side === PositionType.LONG
                      ? SideType.SELL
                      : SideType.BUY,
                })
                resolve()
              } catch (err) {
                this.logger.error(err.error)
              }
            } else if (position.side === PositionType.LONG) {
              // Position in short list.
              try {
                // Position changed from long to short. Clear long position and short instead
                await this.submitOrder({
                  quantity,
                  stock: symbol,
                  side: SideType.SELL,
                })
                resolve()
              } catch (err) {
                this.logger.error(err.error)
              }
            } else {
              // Position is not where we want it.
              if (quantity !== this.qShort) {
                // Need to adjust position amount
                const diff = Number(quantity) - Number(this.qShort)
                try {
                  await this.submitOrder({
                    quantity: Math.abs(diff),
                    stock: symbol,
                    // buy = Too many short positions. Buy some back to rebalance.
                    // sell = Too little short positions. Sell some more.
                    side: diff > 0 ? SideType.BUY : SideType.SELL,
                  })
                } catch (err) {
                  this.logger.error(err.error)
                }
              }
              executed.short.push(symbol)
              this.blacklist.add(symbol)
              resolve()
            }
          } else if (position.side === PositionType.SHORT) {
            // Position in long list.
            // Position changed from short to long. Clear short position and long instead.
            try {
              await this.submitOrder({
                quantity,
                stock: symbol,
                side: SideType.BUY,
              })
              resolve()
            } catch (err) {
              this.logger.error(err.error)
            }
          } else {
            // Position is not where we want it.
            if (quantity !== this.qLong) {
              // Need to adjust position amount.
              const diff = Number(quantity) - Number(this.qLong)
              // sell = Too many long positions. Sell some to rebalance.
              // buy = Too little long positions. Buy some more.
              const side = diff > 0 ? SideType.SELL : SideType.BUY
              try {
                await this.submitOrder({
                  quantity: Math.abs(diff),
                  stock: symbol,
                  side,
                })
              } catch (err) {
                this.logger.error(err.error)
              }
            }
            executed.long.push(symbol)
            this.blacklist.add(symbol)
            resolve()
          }
        })
      }),
    )

    this.adjustedQLong = -1
    this.adjustedQShort = -1

    try {
      // Send orders to all remaining stocks in the long and short list
      const [longOrders, shortOrders] = await Promise.all([
        this.sendBatchOrder({
          quantity: this.qLong,
          stocks: this.long,
          side: SideType.BUY,
        }),
        this.sendBatchOrder({
          quantity: this.qShort,
          stocks: this.short,
          side: SideType.SELL,
        }),
      ])

      executed.long = longOrders.executed.slice()
      executed.short = shortOrders.executed.slice()

      // Handle rejected/incomplete long orders
      if (longOrders.incomplete.length > 0 && longOrders.executed.length > 0) {
        const prices = await this.getTotalPrice(longOrders.executed)
        const completeTotal = prices.reduce((a, b) => a + b, 0)
        if (completeTotal !== 0) {
          this.adjustedQLong = Math.floor(this.longAmount / completeTotal)
        }
      }

      // Handle rejected/incomplete short orders
      if (
        shortOrders.incomplete.length > 0 &&
        shortOrders.executed.length > 0
      ) {
        const prices = await this.getTotalPrice(shortOrders.executed)
        const completeTotal = prices.reduce((a, b) => a + b, 0)
        if (completeTotal !== 0) {
          this.adjustedQShort = Math.floor(this.shortAmount / completeTotal)
        }
      }
    } catch (err) {
      this.logger.error(err.error)
    }

    try {
      // Reorder stocks that didn't throw an error so that the equity quota is reached.
      await new Promise(async resolve => {
        let allProms = []

        if (this.adjustedQLong >= 0) {
          this.qLong = this.adjustedQLong - this.qLong
          allProms = [
            ...allProms,
            ...executed.long.map(stock =>
              this.submitOrder({
                quantity: this.qLong,
                stock,
                side: SideType.BUY,
              }),
            ),
          ]
        }

        if (this.adjustedQShort >= 0) {
          this.qShort = this.adjustedQShort - this.qShort
          allProms = [
            ...allProms,
            ...executed.short.map(stock =>
              this.submitOrder({
                quantity: this.qShort,
                stock,
                side: SideType.SELL,
              }),
            ),
          ]
        }

        if (allProms.length > 0) {
          await Promise.all(allProms)
        }

        resolve()
      })
    } catch (err) {
      this.logger.error(err.error)
    }
  }

  // Submit a batch order that returns completed and uncompleted orders.
  async sendBatchOrder({
    quantity,
    stocks,
    side,
  }): Promise<{ incomplete: StockItem[]; executed: StockItem[] }> {
    return new Promise(async resolve => {
      const incomplete = []
      const executed = []
      await Promise.all<{ incomplete: StockItem[]; executed: StockItem[] }>(
        stocks.map(stock => {
          return new Promise(async resolve => {
            if (!this.blacklist.has(stock)) {
              try {
                const isSubmitted = await this.submitOrder({
                  quantity,
                  stock,
                  side,
                })
                if (isSubmitted) {
                  executed.push(stock)
                } else {
                  incomplete.push(stock)
                }
              } catch (err) {
                this.logger.error(err.error)
              }
            }
            resolve()
          })
        }),
      )
      resolve({ incomplete, executed })
    })
  }
}
