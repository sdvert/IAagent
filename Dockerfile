FROM node:20-alpine

# Dependências nativas para better-sqlite3
RUN apk add --no-cache python3 make g++ sqlite git

WORKDIR /app

# Copia manifests e instala dependências
COPY package*.json ./
RUN npm install --omit=dev

# Copia código fonte
COPY src/ ./src/

# Cria pastas para volumes persistentes:
#   /app/auth_info → credenciais da sessão WhatsApp (DEVE ser volume)
#   /app/data      → banco SQLite com histórico de conversas (DEVE ser volume)
RUN mkdir -p /app/auth_info /app/data

# Declara os volumes — o EasyPanel/Docker vai montar aqui
VOLUME ["/app/auth_info", "/app/data"]

# Expõe porta caso queira adicionar uma API HTTP futuramente
EXPOSE 3000

# Health check: verifica se o processo Node está rodando
HEALTHCHECK --interval=30s --timeout=10s --start-period=90s \
  CMD node -e "process.exit(0)"

CMD ["node", "src/index.js"]
