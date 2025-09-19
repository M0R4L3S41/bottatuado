FROM node:18-alpine

# Instalar dependencias del sistema
RUN apk add --no-cache \
    chromium \
    nss \
    freetype \
    freetype-dev \
    harfbuzz \
    ca-certificates \
    ttf-freefont

WORKDIR /app

# IMPORTANTE: Copiar package.json DESDE whatsapp-bot/
COPY whatsapp-bot/package*.json ./

# Instalar dependencias
RUN npm install --production

# Copiar TODO el código del bot
COPY whatsapp-bot/ ./

# Crear carpetas necesarias
RUN mkdir -p downloads processed curpParaEnviar db_pdf .wwebjs_auth

# Configurar Puppeteer
ENV PUPPETEER_SKIP_CHROMIUM_DOWNLOAD=true
ENV PUPPETEER_EXECUTABLE_PATH=/usr/bin/chromium-browser

EXPOSE 8080

# Usuario no-root
RUN addgroup -g 1001 -S whatsapp && \
    adduser -S whatsapp -u 1001 -G whatsapp && \
    chown -R whatsapp:whatsapp /app

USER whatsapp

CMD ["node", "whatsapp-bot.js"]
