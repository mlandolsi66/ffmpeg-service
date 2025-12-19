import express from "express";
import fetch from "node-fetch";
import { exec, execSync } from "child_process";
import fs from "fs";

const app = express();
app.use(express.json({ limit: "50mb" }));

/* =====================================================
   THEME → AMBIENCE
===================================================== */

function pickAmbienceFilename(themeRaw) {
  const theme = String(themeRaw || "").toLowerCase();
  const map = {
    "fairy": "fairy-garden-adventure.wav",
    "princess": "fairy.wav",
    "forest": "magic-forest-friends.wav",
    "dino": "music-box-34179.wav",
    "ocean": "waves.wav",
    "space": "whitenoise-space.wav"
  };

  for (const key in map) {
    if (theme.includes(key)) return map[key];
  }
  return null;
}

/* =====================================================
   THEME → OVERLAY (SAFE MAPPING)
===================================================== */

function pickOverlay(themeRaw, format) {
  const theme = String(themeRaw || "").toLowerCase();

  const overlays9x16 = {
    ocean: "bokeh.mp4",
    space: "lights.mp4",
    fairy: "dust.mp4",
    princess: "blue-pink-powder.mp4",
    default: "bokeh.mp4"
  };

  const overlays16x9 = {
    ocean: "sparkles.mp4",
    space: "light.mp4",
    fairy: "magic.mp4",
    princess: "dust_bokeh.mp4",
    default: "sparkles.mp4"
  };

  const map = format === "9:16" ? overlays9x16 : overlays16x9;

  for (const key in map) {
    if (theme.includes(key)) return map[key];
  }

  return map.default;
}

/* =====================================================
   HELPERS
===================================================== */

async function downloadToFile(url, filepath) {
  const r = await fetch(url);
  if (!r.ok) return false;
  fs.writeFileSync(filepath, Buffer.from(await r.arrayBuffer()));
  return true;
}

function ffprobeDuration(file) {
  return parseFloat(
    execSync(
      `ffprobe -v error -show_entries format=duration -of csv=p=0 "${file}"`
    ).toString().trim()
  );
}

/* =====================================================
   RENDER ENDPOINT
===================================================== */

app.post("/render", async (req, res) => {
  try {
    const { videoId, images, audioUrl, format, theme } = req.body;
    if (!videoId || !images?.length || !audioUrl) {
      return res.status(400).json({ error: "Missing inputs" });
    }

    const dir = `/tmp/${videoId}`;
    fs.mkdirSync(dir, { recursive: true });

    /* ---------- DOWNLOAD IMAGES ---------- */
    for (let i = 0; i < images.length; i++) {
      const r = await fetch(images[i]);
      if (!r.ok) throw new Error("Image download failed");
      fs.writeFileSync(`${dir}/img${i}.jpg`, Buffer.from(await r.arrayBuffer()));
    }

    /* ---------- DOWNLOAD AUDIO ---------- */
    const ar = await fetch(audioUrl);
    if (!ar.ok) throw new Error("Audio download failed");
    fs.writeFileSync(`${dir}/audio.wav`, Buffer.from(await ar.arrayBuffer()));

    const audioDuration = ffprobeDuration(`${dir}/audio.wav`);
    const perImage = audioDuration / images.length;
    const fade = 1.0;

    const size = format === "9:16" ? "1080:1920" : "1920:1080";
    const [W, H] = size.split(":");
    const out = `${dir}/out.mp4`;

    /* ---------- AMBIENCE ---------- */
    let useAmbience = false;
    const ambiencePath = `${dir}/ambience.wav`;
    const ambFile = pickAmbienceFilename(theme);

    if (ambFile && process.env.ASSET_BASE_URL) {
      const ok = await downloadToFile(
        `${process.env.ASSET_BASE_URL}/ambience/${ambFile}`,
        ambiencePath
      );
      useAmbience = ok;
    }

    /* ---------- OVERLAY ---------- */
    let useOverlay = false;
    const overlayPath = `${dir}/overlay.mp4`;
    const overlayFile = pickOverlay(theme, format);

    if (overlayFile && process.env.ASSET_BASE_URL) {
      const ok = await downloadToFile(
        `${process.env.ASSET_BASE_URL}/overlays/${format}/${overlayFile}`,
        overlayPath
      );
      useOverlay = ok;
    }

    /* ---------- INPUTS ---------- */
    const imageInputs = images
      .map((_, i) => `-loop 1 -t ${perImage} -i "${dir}/img${i}.jpg"`)
      .join(" ");

    const inputs =
      imageInputs +
      ` -i "${dir}/audio.wav"` +
      (useAmbience ? ` -stream_loop -1 -i "${ambiencePath}"` : "") +
      (useOverlay ? ` -stream_loop -1 -i "${overlayPath}"` : "");

    /* ---------- FILTER GRAPH ---------- */
    const filters = [];

    images.forEach((_, i) => {
      filters.push(
        `[${i}:v]scale=${W}:${H}:force_original_aspect_ratio=increase,` +
        `crop=${W}:${H},setpts=PTS-STARTPTS[v${i}]`
      );
    });

    let last = "v0";
    let offset = perImage - fade;

    for (let i = 1; i < images.length; i++) {
      filters.push(
        `[${last}][v${i}]xfade=transition=fade:duration=${fade}:offset=${offset}[vx${i}]`
      );
      last = `vx${i}`;
      offset += perImage;
    }

    let filter = filters.join(";");

    if (useOverlay) {
      const overlayIndex = images.length + (useAmbience ? 2 : 1);
      filter +=
        `;[${last}]format=rgba[base]` +
        `;[${overlayIndex}:v]scale=${W}:${H},format=rgba,colorchannelmixer=aa=0.45[fx]` +
        `;[base][fx]overlay=shortest=1,format=yuv420p[v]`;
    } else {
      filter += `;[${last}]format=yuv420p[v]`;
    }

    if (useAmbience) {
      filter +=
        `;[${images.length + 1}:a]volume=0.2[amb]` +
        `;[${images.length}:a][amb]amix=inputs=2:duration=first[a]`;
    } else {
      filter += `;[${images.length}:a]anull[a]`;
    }

    /* ---------- EXEC ---------- */
    const cmd =
      `ffmpeg -y ${inputs} ` +
      `-filter_complex "${filter}" ` +
      `-map "[v]" -map "[a]" -shortest -r 30 ` +
      `-c:v libx264 -preset veryfast -crf 28 -pix_fmt yuv420p -movflags +faststart ` +
      `-c:a aac -b:a 128k "${out}"`;

    exec(cmd, { maxBuffer: 1024 * 1024 * 50 }, (err, _o, stderr) => {
      if (err) {
        console.error("❌ FFmpeg failed:", stderr);
        return res.status(500).json({ error: "FFmpeg failed" });
      }
      res.setHeader("Content-Type", "video/mp4");
      res.send(fs.readFileSync(out));
    });

  } catch (e) {
    console.error("🔥 Server crash:", e);
    res.status(500).json({ error: "Server crash" });
  }
});

app.listen(8080, "0.0.0.0");
