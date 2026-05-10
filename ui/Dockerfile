# VITE_API_URL must be set at build time because Vite bakes it into the bundle.
# Default points to the manager port on the host (works when containers expose ports).
ARG VITE_API_URL=http://localhost:3002

FROM node:20-alpine AS builder
ARG VITE_API_URL
WORKDIR /app
COPY package*.json ./
RUN npm ci
COPY tsconfig.json tsconfig.node.json vite.config.ts ./
COPY tailwind.config.js postcss.config.js index.html ./
COPY src ./src
COPY public ./public
ENV VITE_API_URL=$VITE_API_URL
RUN npm run build

FROM nginx:alpine
COPY --from=builder /app/dist /usr/share/nginx/html
COPY nginx.conf /etc/nginx/conf.d/default.conf
EXPOSE 80
CMD ["nginx", "-g", "daemon off;"]
