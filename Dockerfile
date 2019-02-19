#FROM node:11
FROM node:8
WORKDIR /app
COPY . /app
RUN rm -rf node_modules && npm install
EXPOSE 3000
#CMD ["node", "index.js"]
ENTRYPOINT ["/app/entrypoint.sh"]
