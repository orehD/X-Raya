FROM node:20-alpine
WORKDIR /app
COPY server.js package.json og.png fonts.css ./
COPY index.html cabinet.html help.html privacy.html terms.html cookies.html stats.html ./
COPY fonts ./fonts
ENV PORT=3000
EXPOSE 3000
CMD ["node", "server.js"]
