FROM node:24-bookworm-slim
WORKDIR /app
COPY package*.json ./
RUN npm ci --omit=dev
COPY server.js ./
COPY public/ ./public/
EXPOSE 3000
ENV NODE_ENV=production
CMD ["node", "server.js"]
