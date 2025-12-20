FROM node:18-slim

# ---------- system deps ----------
RUN apt-get update && apt-get install -y ffmpeg && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# ---------- install deps ----------
COPY package.json ./
RUN npm install

# ---------- copy app ----------
COPY server.js ./
COPY overlays ./overlays

# ---------- normalize overlays (BUILD TIME) ----------
RUN mkdir -p overlays/9x16 overlays/16x9 && \
  for f in overlays/raw/9x16/*.mp4; do \
    echo "Normalizing 9x16 overlay: $f"; \
    ffmpeg -y -i "$f" \
      -vf "scale=1080:1920:force_original_aspect_ratio=increase,crop=1080:1920,fps=30" \
      -pix_fmt yuv420p \
      -movflags +faststart \
      -c:v libx264 -profile:v baseline -level 3.0 -preset veryfast -crf 23 \
      "overlays/9x16/$(basename "$f")"; \
  done && \
  for f in overlays/raw/16x9/*.mp4; do \
    echo "Normalizing 16x9 overlay: $f"; \
    ffmpeg -y -i "$f" \
      -vf "scale=1920:1080:force_original_aspect_ratio=increase,crop=1920:1080,fps=30" \
      -pix_fmt yuv420p \
      -movflags +faststart \
      -c:v libx264 -profile:v baseline -level 3.0 -preset veryfast -crf 23 \
      "overlays/16x9/$(basename "$f")"; \
  done

# ---------- sanity check (FAIL BUILD if bad) ----------
RUN ffprobe -v error overlays/9x16/*.mp4 && \
    ffprobe -v error overlays/16x9/*.mp4

EXPOSE 3000
CMD ["node", "server.js"]

