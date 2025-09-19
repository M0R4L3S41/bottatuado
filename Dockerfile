# Crear este archivo como: Dockerfile (en la RAÍZ del proyecto)

FROM node:18-alpine

# Instalar dependencias del sistema para Puppeteer
RUN apk add --no-cache \
    chromium \
    nss \
    freetype \
    freetype-dev \
    harfbuzz \
    ca-certificates \
    ttf-freefont

# Crear directorio de trabajo
WORKDIR /app

# Copiar package.json del bot
COPY whatsapp-bot/package*.json ./

# Instalar dependencias
RUN npm install --production

# Copiar el código del bot
COPY whatsapp-bot/ ./

# Crear carpetas necesarias
RUN mkdir -p downloads processed curpParaEnviar db_pdf .wwebjs_auth

# Configurar Puppeteer para Alpine
ENV PUPPETEER_SKIP_CHROMIUM_DOWNLOAD=true
ENV PUPPETEER_EXECUTABLE_PATH=/usr/bin/chromium-browser

# Exponer puerto
EXPOSE 8080

# Crear usuario no-root
RUN addgroup -g 1001 -S whatsapp && \
    adduser -S whatsapp -u 1001 -G whatsapp && \
    chown -R whatsapp:whatsapp /app

USER whatsapp

# Comando de inicio
CMD ["node", "whatsapp-bot.js"]
