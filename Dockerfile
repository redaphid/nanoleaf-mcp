FROM node:25-alpine

WORKDIR /app

COPY package*.json ./
RUN npm ci --omit=dev

COPY src ./src
COPY tsconfig.json ./

ENV PORT=3101
EXPOSE 3101

CMD ["node", "src/index.ts"]
