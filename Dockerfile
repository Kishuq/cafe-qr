FROM node:20-alpine
WORKDIR /app
COPY package*.json ./
RUN npm ci --omit=dev
COPY . .
ENV NODE_ENV=production PORT=3000
EXPOSE 3000
# Persist orders/menu across restarts: mount a volume at /app/data
VOLUME ["/app/data"]
CMD ["node", "server.js"]
