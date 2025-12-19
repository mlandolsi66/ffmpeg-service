import express from "express";
import fetch from "node-fetch";
import { exec } from "child_process";
import fs from "fs";

const app = express();
app.use(express.json({ limit: "50mb" }));

/* ------------------ THEME → AMBIENCE ------------------ */

function pickAmbienceFilename(themeRaw) {
  const theme = String(themeRaw || "").toLowerCase();
  if (theme.includes("ocean")) return "waves.wav";
  if (theme.includes("space")) return "whitenoise-space.wav";
  if (theme.includes("dino")) return "music-box-34179.wav";
  return null;
}

/* ------------------ OVERLAY PICKER ------------------ */

function pickOverlay(format) {
  // folders:
  // /overlays/16x9/*
  // /overlays/9x16/*
  const base = process.env.ASSET_BASE_URL;
  if (!base) return null;

  const folder = format === "9:16" ? "9x16" : "16x9";
  const files =
    format === "9:16"
      ? ["dust.mp4", "bokeh.mp4", "lights.mp4", "blue-pink-powder.mp4"]
      : ["sparkles.mp4", "magic.mp4", "dust_bokeh.mp4", "light.mp4"];

  const file = files[Math.floor(Math.random() * files.length)];
  return `${base}/overlays/${folder}/${file}`;
}

/* ------------------ HELPERS ------------------ */

async function download(url, path) {
  const r = await fetch(url);
  if (!r.ok) throw new Error("Download failed");
  fs.writeFileSync(path, Buffer.from(await r.arrayBuffer()));
}

function duration(file) {
  return parseFloat(
    exec(`ffprobe -v error -show_entries format=duration -of csv=p=0 "${file}"`)
      .toString()
      .trim()
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

    /* -------- DOWNLOAD IMAGES -------- */
    for (let i = 0; i < images.length; i++) {
      await download(images[i], `${dir}/img${i}.jpg`);
    }

    /* -------- DOWNLOAD AUDIO -------- */
    await download(audioUrl, `${dir}/voice.wav`);
    const voiceDuration = duration(`${dir}/voice.wav`);
    const perImage = voiceDuration / images.length;
    const fade = 1;

    const size = format === "9:16" ? "1080:1920" : "1920:1080";
    const [W, H] = size.split(":");

    /* -------- AMBIENCE -------- */
    let ambienceInput = "";
    let ambienceFilter = "";
    const ambFile = pickAmbienceFilename(theme);

    if (ambFile) {
      const ambPath = `${dir}/amb.wav`;
      await download(`${process.env.ASSET_BASE_URL}/ambience/${ambFile}`, ambPath);
      ambienceInput = ` -stream_loop -1 -i "${ambPath}"`;
      ambienceFilter = `;[a0][a1]amix=inputs=2:duration=first[a]`;
    }

    /* -------- OVERLAY -------- */
    let overlayInput = "";
    let overlayFilter = "";
    const overlayUrl = pickOverlay(format);

    if (overlayUrl) {
      const overlayRaw = `${dir}/overlay_raw.mp4`;
      const overlayClean = `${dir}/overlay.mp4`;

      await download(overlayUrl, overlayRaw);

      // normalize overlay
      exec(`
        ffmpeg -y -i "${overlayRaw}" \
        -vf "scale=${W}:${H},format=rgba" \
        -pix_fmt yuva420p \
        "${overlayClean}"
      `);

      overlayInput = ` -stream_loop -1 -i "${overlayClean}"`;
      overlayFilter =
        `;[vbase][vover]overlay=eof_action=repeat:format=auto,format=yuv420p[v]`;
    }

    /* -------- INPUTS -------- */
    const imageInputs = images
      .map((_, i) => `-loop 1 -t ${perImage} -i "${dir}/img${i}.jpg"`)
      .join(" ");

    const inputs =
      imageInputs +
      ` -i "${dir}/voice.wav"` +
      ambienceInput +
      overlayInput;

    /* -------- FILTER GRAPH -------- */
    let filters = [];

    images.forEach((_, i) => {
      filters.push(
        `[${i}:v]scale=${W}:${H}:force_original_aspect_ratio=increase,crop=${W}:${H},setpts=PTS-STARTPTS[v${i}]`
      );
    });

    let last = "v0";
    let offset = perImage - fade;

    for (let i = 1; i < images.length; i++) {
      filters.push(
        `[${last}][v${i}]xfade=transition=fade:duration=${fade}:offset=${offset}[vxf${i}]`
      );
      last = `vxf${i}`;
      offset += perImage;
    }

    filters.push(`[${last}]format=rgba[vbase]`);

    const audioBase = images.length;
    const audioAmb = images.length + 1;
    const overlayIndex = images.length + (ambienceInput ? 2 : 1);

    let audioFilter = `[${audioBase}:a]anull[a0]`;
    if (ambienceInput) {
      audioFilter =
        `[${audioBase}:a][${audioAmb}:a]amix=inputs=2:weights=1 0.2[a]`;
    } else {
      audioFilter = `[${audioBase}:a]anull[a]`;
    }

    const filterComplex =
      filters.join(";") +
      overlayFilter +
      ";" +
      audioFilter;

    const out = `${dir}/out.mp4`;

    const cmd = `
      ffmpeg -y ${inputs}
      -filter_complex "${filterComplex}"
      -map "[v]" -map "[a]"
      -r 30 -shortest
      -c:v libx264 -preset veryfast -crf 26
      -pix_fmt yuv420p
      -c:a aac -b:a 128k
      -movflags +faststart
      "${out}"
    `;

    exec(cmd, (err, _stdout, stderr) => {
      if (err) {
        console.error("❌ FFmpeg STDERR:", stderr);
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
