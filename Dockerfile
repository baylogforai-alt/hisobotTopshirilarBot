FROM node:22-bookworm-slim

ENV NODE_ENV=production
WORKDIR /app

COPY package*.json ./
RUN npm ci --omit=dev

COPY src ./src
COPY scripts ./scripts

# Telegram bilan long polling ishlatiladi — kiruvchi trafik shart emas.
# Port faqat platforma (Koyeb va h.k.) health-check qilishi uchun ochiladi.
EXPOSE 8000
ENV PORT=8000

CMD ["node", "src/index.js"]
