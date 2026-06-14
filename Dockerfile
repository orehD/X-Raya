FROM node:20-alpine
WORKDIR /app
COPY package.json ./
COPY server.js index.html ./
COPY fonts ./fonts
ENV PORT=3000
EXPOSE 3000
CMD ["node", "server.js"]
