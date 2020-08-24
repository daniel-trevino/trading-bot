# Trade bot

[![Conventional Commits](https://img.shields.io/badge/Conventional%20Commits-1.0.0-yellow.svg)](https://conventionalcommits.org)

![Node.js CI](https://github.com/danielivert/trading-bot/workflows/Node.js%20CI/badge.svg)

## Description

Trade bot using Alpaca as a bropker

## Installation

```bash
$ yarn
```

## Running the app

```bash
# development
$ yarn start

# watch mode
$ yarn start:dev

# production mode
$ yarn start:prod
```

## Test

```bash
# unit tests
$ yarn test

# e2e tests
$ yarn test:e2e

# test coverage
$ yarn test:cov
```

## Environmental variables

Please have a look at .env.sample to get started

## BOT_TYPE

There are two different types of algorithms

- `MEAN_REVERSION`
- `LONG_SHORT`
