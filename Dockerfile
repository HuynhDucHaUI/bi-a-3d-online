FROM node:22-alpine AS build
WORKDIR /app
COPY package*.json ./
RUN npm ci
COPY . .
RUN npm run build

FROM node:22-alpine
WORKDIR /app
ENV NODE_ENV=production
COPY package*.json ./
RUN npm ci --omit=dev && npm i --no-save tsx
COPY shared ./shared
COPY server ./server
COPY --from=build /app/client/dist ./client/dist
EXPOSE 3000
CMD ["npx", "tsx", "server/src/index.ts"]
