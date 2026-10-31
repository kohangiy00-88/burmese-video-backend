FROM node:20-bookworm-slim

RUN apt-get update && apt-get install -y \
    ffmpeg \
    fontconfig \
    fonts-noto-core \
    fonts-noto-extra \
    fonts-myanmar \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY package.json ./
RUN npm install --omit=dev

COPY . .

RUN mkdir -p /var/data/uploads /var/data/outputs /var/data/jobs
RUN fc-cache -f

ENV PORT=10000
ENV DATA_DIR=/var/data

EXPOSE 10000

CMD ["npm", "start"]
