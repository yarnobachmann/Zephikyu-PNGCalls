FROM node:22-alpine
WORKDIR /app
COPY --chown=node:node package*.json ./
RUN npm ci
COPY --chown=node:node . .
RUN npx prisma generate && npm run build:activity && npm prune --omit=dev && mkdir -p /app/data /app/uploads && chown -R node:node /app/data /app/uploads
ENV NODE_ENV=production PORT=4173 DATA_DIR=/app/data UPLOAD_DIR=/app/uploads DATABASE_URL=file:../data/zephikyu.db
VOLUME ["/app/data", "/app/uploads"]
EXPOSE 4173
USER node
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 CMD ["node", "-e", "fetch('http://127.0.0.1:4173/api/health').then(r=>{if(!r.ok)process.exit(1)}).catch(()=>process.exit(1))"]
CMD ["npm", "start"]
