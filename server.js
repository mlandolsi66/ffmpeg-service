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

const OVERLAY_FILES = [
  "sparkles.mp4",
  "magic.mp4",
  "dust_bokeh.mp4",
  "light.mp4",
];

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
    return (
      header.toString("ascii", 0, 4) === "RIFF" &&
      header.toString("ascii", 8, 12) === "WAVE"
    );
  } catch {
    return false;
  }
}

function ffprobeOk(filepath) {
  try {
    execSync(`ffprobe -v error "${filepath}"`);
    return true;
  } catch {
    return false;
  }
}

function ffprobeDuration(filepath) {
  return parseFloat(
    execSync(
      `ffprobe -v error -show_entries format=duration -of csv=p=0 "${filepath}"`
    ).toString().trim()
  );
}

/* ------------------ RENDER ------------------ */

app.post("/render", async (req, res) => {
  try {
    const { videoId, images, audioUrl, format, theme } = req.body;
    if (!videoId || !images?.length || !audioUrl) {
      return res.status(400).json({ error: "Missing inputs" });
    }

    const dir = `/tmp/${videoId}`;
    fs.mkdirSync(dir, { recursive: true });

    /* ---------- IMAGES ---------- */
    for (let i = 0; i < images.length; i++) {
      const r = await fetch(images[i]);
      if (!r.ok) return res.status(400).json({ error: "Image download failed" });
      fs.writeFileSync(`${dir}/img${i}.jpg`, Buffer.from(await r.arrayBuffer()));
    }

    /* ---------- NARRATION ---------- */
    const ar = await fetch(audioUrl);
    if (!ar.ok) return res.status(400).json({ error: "Audio download failed" });
    fs.writeFileSync(`${dir}/audio.wav`, Buffer.from(await ar.arrayBuffer()));

    const audioDuration = ffprobeDuration(`${dir}/audio.wav`);
    const perImageDuration = audioDuration / images.length;
    const size = format === "9:16" ? "1080:1920" : "1920:1080";
    const out = `${dir}/out.mp4`;

    /* ---------- AMBIENCE ---------- */
    const ASSET_BASE_URL = process.env.ASSET_BASE_URL;
    let useAmbience = false;
    let ambiencePath = `${dir}/ambience.wav`;

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

    const inputs =
      imageInputs +
      ` -i "${dir}/audio.wav"` +
      (useAmbience ? ` -stream_loop -1 -i "${ambiencePath}"` : "") +
      (useOverlay ? ` -stream_loop -1 -i "${overlayPath}"` : "");

    /* ---------- FILTER GRAPH ---------- */
    const vFilters = images
      .map(
        (_, i) =>
          `[${i}:v]scale=${size}:force_original_aspect_ratio=increase,crop=${size},setpts=PTS-STARTPTS[v${i}]`
      )
      .join(";");

    const concatInputs = images.map((_, i) => `[v${i}]`).join("");
    const narrationIndex = images.length;
    const ambienceIndex = images.length + 1;
    const overlayIndex = images.length + (useAmbience ? 2 : 1);

    let filter = `${vFilters};${concatInputs}concat=n=${images.length}:v=1:a=0[vbase];`;

    if (useOverlay) {
      filter +=
        `[${overlayIndex}:v]scale=${size}:force_original_aspect_ratio=increase,crop=${size},format=rgba,colorchannelmixer=aa=0.20[fx];` +
        `[vbase][fx]overlay=shortest=1[v];`;
    } else {
      filter += `[vbase]copy[v];`;
    }

    if (useAmbience) {
      filter +=
        `[${ambienceIndex}:a]volume=0.18[amb];` +
        `[${narrationIndex}:a][amb]amix=inputs=2:duration=first[a]`;
    } else {
      filter += `[${narrationIndex}:a]acopy[a]`;
    }

    /* ---------- EXEC ---------- */
    const cmd =
      `ffmpeg -y ${inputs} ` +
      `-filter_complex "${filter}" ` +
      `-map "[v]" -map "[a]" ` +
      `-shortest -r 30 ` +
      `-c:v libx264 -crf 28 -preset veryfast -pix_fmt yuv420p -movflags +faststart ` +
      `-c:a aac -b:a 128k "${out}"`;

    exec(cmd, { maxBuffer: 1024 * 1024 * 20 }, (err, _, stderr) => {
      if (err) {
        console.error(stderr);
        return res.status(500).json({ error: "FFmpeg failed" });
      }
      res.setHeader("Content-Type", "video/mp4");
      res.send(fs.readFileSync(out));
    });

  } catch (e) {
    console.error(e);
    res.status(500).json({ error: "Server crash" });
  }
});

app.listen(8080, "0.0.0.0");
