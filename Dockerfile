FROM node:18-bullseye

WORKDIR /app

COPY package*.json ./

RUN npm install --unsafe-perm

COPY . .

EXPOSE 3000

CMD ["npm", "start"]
