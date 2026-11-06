FROM node:20-alpine

RUN apk add --no-cache curl
WORKDIR /app
COPY package.json ./
COPY src ./src
COPY test ./test
COPY README.md ./.env.example ./

ENV NODE_ENV=production
EXPOSE 7000
CMD ["node", "src/server.js"]
