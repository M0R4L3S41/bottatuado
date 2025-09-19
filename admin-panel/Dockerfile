# Guardar como: admin-panel/Dockerfile

FROM node:18-slim

WORKDIR /app

# Copiar package.json e instalar dependencias
COPY package*.json ./
RUN npm ci --only=production && npm cache clean --force

# Copiar archivos del panel admin
COPY . ./

# Crear usuario no-root
RUN groupadd -r admin && useradd -r -g admin admin && \
    chown -R admin:admin /app

USER admin

# Exponer puerto
EXPOSE 3001

# Comando de inicio
CMD ["node", "web-admin-server.js"
