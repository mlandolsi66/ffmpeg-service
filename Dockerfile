# ============================================
# DOCKERFILE - Build-time normalization
# ============================================
# ✅ Normalizes overlays during build (10s videos = fast)
# ✅ Verifies all assets exist
# ✅ Fails build if assets missing
# ============================================

FROM node:18-slim

# ---------- Install FFmpeg ----------
RUN apt-get update && \
    apt-get install -y ffmpeg && \
    rm -rf /var/lib/apt/lists/*

WORKDIR /app

# ---------- Install Node dependencies ----------
COPY package*.json ./
RUN npm install --production

# ---------- Copy application code ----------
COPY server.js ./

# ---------- Copy RAW assets ----------
COPY overlays ./overlays
COPY ambience ./ambience
COPY endcards ./endcards   
# ---------- Normalize overlays at BUILD TIME ----------
RUN mkdir -p overlays/9x16 overlays/16x9 && \
    echo "🔧 Normalizing 9:16 overlays..." && \
    if ls overlays/raw/9x16/*.mp4 1> /dev/null 2>&1; then \
      for f in overlays/raw/9x16/*.mp4; do \
        echo "  → $(basename "$f")"; \
        ffmpeg -y -i "$f" \
          -vf "scale=1080:1920:force_original_aspect_ratio=increase,crop=1080:1920,fps=30" \
          -an -pix_fmt yuv420p \
          -c:v libx264 -preset veryfast -crf 23 \
          -movflags +faststart \
          "overlays/9x16/$(basename "$f")"; \
      done; \
    else \
      echo "⚠️  No raw 9:16 overlays found"; \
    fi && \
    echo "🔧 Normalizing 16:9 overlays..." && \
    if ls overlays/raw/16x9/*.mp4 1> /dev/null 2>&1; then \
      for f in overlays/raw/16x9/*.mp4; do \
        echo "  → $(basename "$f")"; \
        ffmpeg -y -i "$f" \
          -vf "scale=1920:1080:force_original_aspect_ratio=increase,crop=1920:1080,fps=30" \
          -an -pix_fmt yuv420p \
          -c:v libx264 -preset veryfast -crf 23 \
          -movflags +faststart \
          "overlays/16x9/$(basename "$f")"; \
      done; \
    else \
      echo "⚠️  No raw 16:9 overlays found"; \
    fi

# ---------- Verify CRITICAL assets exist ----------
# This FAILS the build if assets are missing
RUN echo "🔍 Verifying assets..." && \
    test -d overlays/9x16 || (echo "❌ overlays/9x16 missing" && exit 1) && \
    test -d overlays/16x9 || (echo "❌ overlays/16x9 missing" && exit 1) && \
    test -d ambience || (echo "❌ ambience directory missing" && exit 1) && \
    test -d endcards || (echo "❌ endcards directory missing" && exit 1) && \
    ls endcards/*.jpg || echo "⚠️  No endcard files found (optional)"
    ls overlays/9x16/*.mp4 || (echo "❌ No 9:16 overlays found" && exit 1) && \
    ls overlays/16x9/*.mp4 || (echo "❌ No 16:9 overlays found" && exit 1) && \
    ls ambience/*.wav || (echo "❌ No ambience files found" && exit 1) && \
    echo "✅ All assets verified" && \
    echo "📂 9:16 overlays:" && ls -lh overlays/9x16/ && \
    echo "📂 16:9 overlays:" && ls -lh overlays/16x9/ && \
    echo "📂 Ambience:" && ls -lh ambience/

# ---------- Health check ----------
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD node -e "require('http').get('http://localhost:8080/health', (r) => { process.exit(r.statusCode === 200 ? 0 : 1); });"

EXPOSE 8080

CMD ["node", "server.js"]
