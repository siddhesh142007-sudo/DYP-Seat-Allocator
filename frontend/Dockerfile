FROM node:20-alpine
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY . .
EXPOSE 5173
# Vite dev server (HMR) with /api proxy to the backend container.
CMD ["npm", "run", "dev"]
