FROM node:20-alpine AS base

# Pnpm kurulumu
RUN corepack enable && corepack prepare pnpm@latest --activate
WORKDIR /app

# Paket tanımları ve Prisma şemasını kopyala
COPY package.json pnpm-lock.yaml* ./
COPY prisma ./prisma/

# Bağımlılıkları yükle
RUN pnpm install

# Kaynak kodları kopyala
COPY . .

# Prisma client üret ve NestJS build al
RUN pnpm prisma:generate
RUN pnpm build

# Production imajı
FROM node:20-alpine AS runner
WORKDIR /app
RUN corepack enable && corepack prepare pnpm@latest --activate

ENV NODE_ENV=production
ENV PORT=3001

COPY --from=base /app/node_modules ./node_modules
COPY --from=base /app/dist ./dist
COPY --from=base /app/prisma ./prisma
COPY --from=base /app/package.json ./package.json

EXPOSE 3001

CMD ["pnpm", "start:prod"]
