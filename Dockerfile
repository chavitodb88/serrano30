FROM node:18-alpine

# better-sqlite3 necesita build tools para compilar
RUN apk add --no-cache python3 make g++

WORKDIR /app

# Copiar dependencias primero (cache de Docker)
COPY package.json package-lock.json ./
RUN npm ci --omit=dev

# Copiar código fuente
COPY src/ ./src/

# Crear directorios de storage
RUN mkdir -p storage/uploads storage/processed storage/exports

# Usuario no-root por seguridad
RUN addgroup -S appgroup && adduser -S appuser -G appgroup
RUN chown -R appuser:appgroup /app/storage
USER appuser

EXPOSE 3000

ENV NODE_ENV=production

CMD ["node", "src/app.js"]
