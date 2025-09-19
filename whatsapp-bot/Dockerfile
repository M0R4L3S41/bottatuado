
FROM node:18-slim

# Instalar dependencias del sistema necesarias para Puppeteer
RUN apt-get update && apt-get install -y \
    wget \
    gnupg \
    ca-certificates \
    procps \
    libxss1 \
    libgconf-2-4 \
    libxcomposite1 \
    libxdamage1 \
    libxrandr2 \
    libasound2 \
    libatk1.0-0 \
    libdrm-dev \
    libxcomposite-dev \
    libxdamage-dev \
    libxrandr2 \
    libgbm-dev \
    libxss-dev \
    libasound2-dev \
    && rm -rf /var/lib/apt/lists/*

# Crear directorio de trabajo
WORKDIR /app

# Copiar package.json e instalar dependencias
COPY package*.json ./
RUN npm ci --only=production && npm cache clean --force

# Copiar código fuente
COPY . ./

# Crear carpetas necesarias
RUN mkdir -p downloads processed curpParaEnviar db_pdf .wwebjs_auth && \
    chmod 755 downloads processed curpParaEnviar db_pdf .wwebjs_auth

# Crear usuario no-root para seguridad
RUN groupadd -r whatsapp && useradd -r -g whatsapp -G audio,video whatsapp && \
    chown -R whatsapp:whatsapp /app

USER whatsapp

# Exponer puerto para Railway
EXPOSE 8080

# Comando de inicio
CMD ["node", "--max-old-space-size=512", "whatsapp-bot.js"]
