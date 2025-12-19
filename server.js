import express from "express";
import fetch from "node-fetch";
import { exec, execSync } from "child_process";
import fs from "fs";

const app = express();
app.use(express.json({ limit: "50mb" }));

/* ------------------ THEME → AMBIENCE ------------------ */

function pickAmbienceFilename(themeRaw) {
  const theme = String(themeRaw || "").trim().toLowerCase();

  const map = {
    "fairy garden adventure": "fairy-garden-adventure.wav",
    "princess star dreams": "fairy.wav",
    "magic forest friends": "magic-forest-friends.wav",
    "dino explorer": "music-box-34179.wav",
    "ocean wonders": "waves.wav",
    "space bedtime journey": "whitenoise-space.wav",
  };

  return map[theme] || null;
}

/* ------------------ OVERLAY POOL ------------------ */

const OVERLAY_FILES = ["sparkles.mp4", "magic.mp4", "dust_bokeh.mp4", "light.mp4"];
function pickRandomOverlay() {
  return OVERLAY_FILES[Math.floor(Math.random() * OVERLAY_FILES.length)];
}

/* ------------------ HELPERS ------------------ */

async function downloadToFile(url, filepath) {
  const r = await fetch(url);
  if (!r.ok) {
    return { ok: false, status: r.status, contentType: r.headers.get("content-type") };
  }
  const buf = Buffer.from(await r.arrayBuffer());
  fs.writeFileSync(filepath, buf);
  return { ok: true };
}

function looksLikeWav(filepath) {
  try {
    const fd = fs.openSync(filepath, "r");
    const header = Buffer.alloc(12);
    fs.readSync(fd, header, 0, 12, 0);
    fs.closeSync(fd);
    return header.toString("ascii", 0, 4) === "RIFF" && header.toString("ascii", 8, 12) === "WAVE";
  } catch {
    return false;
  }
}

function ffprobeOk(filepath) {
  try {
    execSync(`ffprobe -v error "${filepath}"`, { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

function ffprobeDuration(filepath) {
  const s = execSync(
    `ffprobe -v error -show_entries format=duration -of csv=p=0 "${filepath}"`
  )
    .toString()
    .trim();
  const v = parseFloat(s);
  return Number.isFinite(v) ? v : 0;
}

/* ------------------ RENDER ------------------ */

app.post("/render", async (req, res) => {
  try {
    const { videoId, images, audioUrl, format, theme } = req.body;
    if (!videoId || !Array.isArray(images) || images.length === 0 || !audioUrl) {
      return res.status(400).json({ error: "Missing inputs" });
    }

    const dir = `/tmp/${videoId}`;
    fs.mkdirSync(dir, { recursive: true });

    /* ---------- IMAGES ---------- */
    for (let i = 0; i < images.length; i++) {
      const r = await fetch(images[i]);
      if (!r.ok) return res.status(400).json({ error: `Image download failed: ${i}` });
      fs.writeFileSync(`${dir}/img${i}.jpg`, Buffer.from(await r.arrayBuffer()));
      if (!ffprobeOk(`${dir}/img${i}.jpg`)) {
        return res.status(400).json({ error: `Image not decodable by FFmpeg: ${i}` });
      }
    }

    /* ---------- NARRATION ---------- */
    const ar = await fetch(audioUrl);
    if (!ar.ok) return res.status(400).json({ error: "Audio download failed" });
    fs.writeFileSync(`${dir}/audio.wav`, Buffer.from(await ar.arrayBuffer()));

    if (!looksLikeWav(`${dir}/audio.wav`) || !ffprobeOk(`${dir}/audio.wav`)) {
      return res.status(400).json({ error: "Narration WAV invalid / not decodable" });
    }

    const audioDuration = ffprobeDuration(`${dir}/audio.wav`);
    if (audioDuration < 1) {
      return res.status(400).json({ error: "Narration duration too short / probe failed" });
    }

    // Clamp per-image duration to avoid 0 or tiny values that can cause black output
    let perImageDuration = audioDuration / images.length;
    if (!Number.isFinite(perImageDuration) || perImageDuration < 0.7) perImageDuration = 0.7;

    const size = format === "9:16" ? "1080:1920" : "1920:1080";
    const out = `${dir}/out.mp4`;

    console.log("🎬 render", {
      videoId,
      images: images.length,
      audioDuration,
      perImageDuration,
      size,
      theme
    });

    /* ---------- AMBIENCE ---------- */
    const ASSET_BASE_URL = process.env.ASSET_BASE_URL;
    let useAmbience = false;
    const ambiencePath = `${dir}/ambience.wav`;

    if (ASSET_BASE_URL) {
      const ambFile = pickAmbienceFilename(theme);
      if (ambFile) {
        const ambUrl = `${ASSET_BASE_URL}/ambience/${ambFile}`;
        const dl = await downloadToFile(ambUrl, ambiencePath);
        if (dl.ok && looksLikeWav(ambiencePath) && ffprobeOk(ambiencePath)) {
          useAmbience = true;
        }
      }
    }

    /* ---------- RANDOM OVERLAY ---------- */
    let useOverlay = false;
    const overlayPath = `${dir}/overlay.mp4`;

    if (ASSET_BASE_URL) {
      const overlayFile = pickRandomOverlay();
      const overlayUrl = `${ASSET_BASE_URL}/overlays/${overlayFile}`;
      const dl = await downloadToFile(overlayUrl, overlayPath);

      if (dl.ok && ffprobeOk(overlayPath)) {
        useOverlay = true;
        console.log("✨ Overlay selected:", overlayFile);
      } else {
        console.warn("⚠️ Overlay failed, skipping:", overlayFile);
      }
    }

    /* ---------- INPUTS ---------- */
    const imageInputs = images
      .map((_, i) => `-loop 1 -t ${perImageDuration} -i "${dir}/img${i}.jpg"`)
      .join(" ");

    const narrationIndex = images.length;
    const ambienceIndex = images.length + 1;
    const overlayIndex = images.length + (useAmbience ? 2 : 1);

    const inputs =
      imageInputs +
      ` -i "${dir}/audio.wav"` +
      (useAmbience ? ` -stream_loop -1 -i "${ambiencePath}"` : "") +
      (useOverlay ? ` -stream_loop -1 -i "${overlayPath}"` : "");

    /* ---------- FILTER GRAPH ---------- */
    const vFilters = images
      .map(
        (_, i) =>
          `[${i}:v]scale=${size}:force_original_aspect_ratio=increase,crop=${size},setsar=1,setpts=PTS-STARTPTS[v${i}]`
      )
      .join(";");

    const concatInputs = images.map((_, i) => `[v${i}]`).join("");

    let filter = `${vFilters};${concatInputs}concat=n=${images.length}:v=1:a=0[vbase];`;

    // SAFE overlay compositing (always format-align + scale)
    if (useOverlay) {
      filter +=
        `[vbase]format=rgba[base_rgba];` +
        `[${overlayIndex}:v]scale=${size}:force_original_aspect_ratio=increase,crop=${size},format=rgba,colorchannelmixer=aa=0.18[fx];` +
        `[base_rgba][fx]overlay=shortest=1:format=auto,format=yuv420p[v];`;
    } else {
      filter += `[vbase]format=yuv420p[v];`;
    }

    // Audio mix
    if (useAmbience) {
      filter +=
        `[${ambienceIndex}:a]volume=0.20[amb];` +
        `[${narrationIndex}:a][amb]amix=inputs=2:duration=first:dropout_transition=2[a]`;
    } else {
      filter += `[${narrationIndex}:a]acopy[a]`;
    }

    /* ---------- EXEC ---------- */
    // IMPORTANT: cap threads to reduce memory spikes
    const cmd =
      `ffmpeg -y -hide_banner -loglevel error ${inputs} ` +
      `-filter_complex "${filter}" ` +
      `-map "[v]" -map "[a]" ` +
      `-shortest -r 30 -threads 1 ` +
      `-c:v libx264 -crf 28 -preset veryfast -pix_fmt yuv420p -movflags +faststart ` +
      `-c:a aac -b:a 128k "${out}"`;

    exec(cmd, { maxBuffer: 1024 * 1024 * 10 }, (err, _stdout, stderr) => {
      if (err) {
        console.error("❌ FFmpeg failed:", stderr);
        return res.status(500).json({ error: "FFmpeg failed", details: stderr?.slice(0, 1500) });
      }

      if (!fs.existsSync(out) || fs.statSync(out).size < 1024) {
        return res.status(500).json({ error: "Output MP4 missing or empty" });
      }

      // ✅ STREAM the file (no fs.readFileSync RAM bomb)
      res.setHeader("Content-Type", "video/mp4");
      res.setHeader("Content-Length", String(fs.statSync(out).size));

      const stream = fs.createReadStream(out);
      stream.on("error", (e) => {
        console.error("❌ stream error:", e);
        res.destroy(e);
      });
      stream.pipe(res);
    });
  } catch (e) {
    console.error("🔥 Server crash:", e);
    res.status(500).json({ error: "Server crash" });
  }
});

app.listen(8080, "0.0.0.0");
