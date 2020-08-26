import { Injectable, Logger } from '@nestjs/common'
import { STOCKS } from './long-short.constants'
import { StockItem } from './long-short.types'
import { AlpacaService } from 'src/alpaca/alpaca.service'

const MINUTE = 60000
const THIRTY_SECONDS = 30

@Injectable()
export class LongShortService {
  alpaca: AlpacaService
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
  private readonly logger = new Logger(LongShortService.name)

  constructor({ keyId, secretKey, paper = true, bucketPct = 0.25 }) {
    this.alpaca = new AlpacaService({
      keyId: keyId,
      secretKey: secretKey,
      paper: paper,
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
    await this.alpaca.cancelExistingOrders()

    // Wait for market to open.
    this.logger.log('Waiting for market to open...')
    await this.alpaca.awaitMarketOpen()
    this.logger.log('Market opened.')

    await this.rebalancePorfolio(THIRTY_SECONDS)
  }

  async rebalancePorfolio(seconds: number): Promise<void> {
    // Rebalance the portfolio every minute, making necessary trades.
    const spin = setInterval(async () => {
      // Figure out when the market will close so we can prepare to sell beforehand.
      const INTERVAL = 15 // minutes
      this.timeToClose = await this.alpaca.getTimeToClose()

      if (this.timeToClose < MINUTE * INTERVAL) {
        // Close all positions when 15 minutes til market close.
        this.logger.log('Market closing soon. Closing positions.')

        try {
          const positions = await this.alpaca.instance.getPositions()

          await Promise.all(
            positions.map(position =>
              this.alpaca.submitOrder({
                quantity: Math.abs(position.qty),
                stock: position.symbol,
                side:
                  position.side === this.alpaca.positionType.LONG
                    ? this.alpaca.sideType.SELL
                    : this.alpaca.sideType.BUY,
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

  // Get percent changes of the stock prices over the past 10 minutes.
  getPercentChanges(limit = 10): Promise<unknown> {
    return Promise.all(
      this.stockList.map(stock => {
        return new Promise(async resolve => {
          try {
            const resp = await this.alpaca.instance.getBars(
              'minute',
              stock.name,
              {
                limit: limit,
              },
            )
            // polygon and alpaca have different responses to keep backwards
            // compatibility, so we handle it a bit differently
            if (this.alpaca.instance.configuration.usePolygon) {
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
      const result = await this.alpaca.instance.getAccount()
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
            const resp = await this.alpaca.instance.getBars('minute', stock, {
              limit: 1,
            })
            // polygon and alpaca have different responses to keep backwards
            // compatibility, so we handle it a bit differently
            if (this.alpaca.instance.configuration.usePolygon) {
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
    await this.alpaca.cancelExistingOrders()

    this.logger.log(`We are taking a long position in: ${this.long.toString()}`)
    this.logger.log(
      `We are taking a short position in: ${this.short.toString()}`,
    )

    // Remove positions that are no longer in the short or long list, and make a list of positions that do not need to change.
    // Adjust position quantities if needed.
    let positions
    try {
      positions = await this.alpaca.instance.getPositions()
      console.log(positions)
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
                await this.alpaca.submitOrder({
                  quantity,
                  stock: symbol,
                  side:
                    position.side === this.alpaca.positionType.LONG
                      ? this.alpaca.sideType.SELL
                      : this.alpaca.sideType.BUY,
                })
                resolve()
              } catch (err) {
                this.logger.error(err.error)
              }
            } else if (position.side === this.alpaca.positionType.LONG) {
              // Position in short list.
              try {
                // Position changed from long to short. Clear long position and short instead
                await this.alpaca.submitOrder({
                  quantity,
                  stock: symbol,
                  side: this.alpaca.sideType.SELL,
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
                  await this.alpaca.submitOrder({
                    quantity: Math.abs(diff),
                    stock: symbol,
                    // buy = Too many short positions. Buy some back to rebalance.
                    // sell = Too little short positions. Sell some more.
                    side:
                      diff > 0
                        ? this.alpaca.sideType.BUY
                        : this.alpaca.sideType.SELL,
                  })
                } catch (err) {
                  this.logger.error(err.error)
                }
              }
              executed.short.push(symbol)
              this.blacklist.add(symbol)
              resolve()
            }
          } else if (position.side === this.alpaca.positionType.SHORT) {
            // Position in long list.
            // Position changed from short to long. Clear short position and long instead.
            try {
              await this.alpaca.submitOrder({
                quantity,
                stock: symbol,
                side: this.alpaca.sideType.BUY,
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
              const side =
                diff > 0 ? this.alpaca.sideType.SELL : this.alpaca.sideType.BUY
              try {
                await this.alpaca.submitOrder({
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
          side: this.alpaca.sideType.BUY,
        }),
        this.sendBatchOrder({
          quantity: this.qShort,
          stocks: this.short,
          side: this.alpaca.sideType.SELL,
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
              this.alpaca.submitOrder({
                quantity: this.qLong,
                stock,
                side: this.alpaca.sideType.BUY,
              }),
            ),
          ]
        }

        if (this.adjustedQShort >= 0) {
          this.qShort = this.adjustedQShort - this.qShort
          allProms = [
            ...allProms,
            ...executed.short.map(stock =>
              this.alpaca.submitOrder({
                quantity: this.qShort,
                stock,
                side: this.alpaca.sideType.SELL,
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
      this.logger.error(err.error, 'Reorder stocks try, catch')
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
                const isSubmitted = await this.alpaca.submitOrder({
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
                this.logger.error(err.error, 'sendBatchOrder')
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
