FROM node:20-alpine
WORKDIR /app
COPY package*.json ./
RUN npm ci --only=production
COPY server.js ./
COPY public/ ./public/
EXPOSE 3000
ENV NODE_ENV=production
CMD ["node", "server.js"]
