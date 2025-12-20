FROM node:18-slim

# ---------- system deps ----------
RUN apt-get update && apt-get install -y ffmpeg && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# ---------- install deps ----------
COPY package.json ./
RUN npm install

# ---------- copy app + overlays ----------
COPY server.js ./
COPY overlays ./overlays

# ---------- normalize overlays (BUILD TIME) ----------
RUN mkdir -p overlays/9x16 overlays/16x9 && \
  echo "🔧 Normalizing 9x16 overlays" && \
  for f in overlays/raw/9x16/*.mp4; do \
    echo " → $f"; \
    ffmpeg -y -i "$f" \
      -vf "scale=1080:1920:force_original_aspect_ratio=increase,crop=1080:1920,fps=30" \
      -an \
      -pix_fmt yuv420p \
      -c:v libx264 -preset veryfast -crf 23 \
      -movflags +faststart \
      "overlays/9x16/$(basename "$f")"; \
  done && \
  echo "🔧 Normalizing 16x9 overlays" && \
  for f in overlays/raw/16x9/*.mp4; do \
    echo " → $f"; \
    ffmpeg -y -i "$f" \
      -vf "scale=1920:1080:force_original_aspect_ratio=increase,crop=1920:1080,fps=30" \
      -an \
      -pix_fmt yuv420p \
      -c:v libx264 -preset veryfast -crf 23 \
      -movflags +faststart \
      "overlays/16x9/$(basename "$f")"; \
  done

# ---------- verify overlays (FAIL BUILD IF BAD) ----------
# ---------- verify overlays (FAIL BUILD IF BAD) ----------
RUN for f in overlays/9x16/*.mp4; do \
      echo "Verifying $f"; \
      ffprobe -v error "$f"; \
    done && \
    for f in overlays/16x9/*.mp4; do \
      echo "Verifying $f"; \
      ffprobe -v error "$f"; \
    done


EXPOSE 3000
CMD ["node", "server.js"]
