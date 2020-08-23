FROM node:14.8.0-alpine

WORKDIR /usr/src/app

ENV NODE_ENV production

COPY ["package.json", "./"]

RUN yarn global add @nestjs/cli @types/node

RUN yarn

COPY . . 

RUN yarn build

EXPOSE 3000

CMD ["node", "dist/main"]