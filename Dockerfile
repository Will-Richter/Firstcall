FROM node:22-slim
WORKDIR /app
COPY package.json ./
COPY *.js index.html gate.css manifest.webmanifest icon.svg *.png ./
RUN rm -f test.js && mkdir -p /data && chown node:node /data
ENV NODE_ENV=production DATA_DIR=/data PORT=8080
EXPOSE 8080
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||8080)+'/health').then(r=>process.exit(r.ok?0:1),()=>process.exit(1))"
# Hosts usually mount the data disk owned by root. Starting as root lets the app hand the disk to the unprivileged
# "node" user and then run as that user. If the host already starts the container unprivileged, it just runs.
COPY start.sh ./
CMD ["sh", "/app/start.sh"]
