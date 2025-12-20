import express from "express";
import fetch from "node-fetch";
import { exec, execSync } from "child_process";
import fs from "fs";

const app = express();
app.use(express.json({ limit: "50mb" }));

/* ------------------ THEME → AMBIENCE (LOCAL) ------------------ */

function pickAmbiencePath(themeRaw) {
  const theme = String(themeRaw || "").toLowerCase();
  let file = null;

  if (theme.includes("ocean")) file = "waves.wav";
  else if (theme.includes("space")) file = "whitenoise-space.wav";
  else if (theme.includes("dino")) file = "music-box-34179.wav";
  else if (theme.includes("forest")) file = "forest.wav";
  else if (theme.includes("fairy")) file = "fairy.wav";
  else if (theme.includes("adventure")) file = "adventure.wav";
  else if (theme.includes("lullaby")) file = "lullaby.wav";

  if (!file) return null;

  const p = `ambience/${file}`;
  return fs.existsSync(p) ? p : null;
}

/* ------------------ OVERLAY PICKER (LOCAL) ------------------ */

function pickOverlayPath(format) {
  const base = format === "9:16" ? "overlays/9x16" : "overlays/16x9";
  if (!fs.existsSync(base)) return null;

  const files = fs.readdirSync(base).filter(f => f.endsWith(".mp4"));
  if (!files.length) return null;

  return `${base}/${files[Math.floor(Math.random() * files.length)]}`;
}

/* ------------------ HELPERS ------------------ */

function ffprobeDuration(file) {
  try {
    return parseFloat(
      execSync(
        `ffprobe -v error -show_entries format=duration -of csv=p=0 "${file}"`
      ).toString()
    );
  } catch {
    return NaN;
  }
}

async function download(url, dest) {
  const r = await fetch(url);
  if (!r.ok) throw new Error("download failed");
  fs.writeFileSync(dest, Buffer.from(await r.arrayBuffer()));
}

function run(cmd) {
  return new Promise((resolve, reject) => {
    exec(cmd, { maxBuffer: 1024 * 1024 * 100 }, (err, _, stderr) => {
      if (err) return reject(stderr);
      resolve();
    });
  });
}

/* ------------------ RENDER ------------------ */

app.post("/render", async (req, res) => {
  try {
    const { videoId, images, audioUrl, format, theme } = req.body;
    if (!videoId || !images?.length || !audioUrl)
      return res.status(400).json({ error: "missing inputs" });

    const dir = `/tmp/${videoId}`;
    fs.mkdirSync(dir, { recursive: true });

    /* ---------- images ---------- */
    for (let i = 0; i < images.length; i++) {
      await download(images[i], `${dir}/img${i}.jpg`);
    }

    /* ---------- narration ---------- */
    await download(audioUrl, `${dir}/audio.wav`);
    const narrationDur = ffprobeDuration(`${dir}/audio.wav`);
    if (!narrationDur) throw "bad narration";

    const perImage = narrationDur / images.length;
    const [W, H] = format === "9:16" ? ["1080", "1920"] : ["1920", "1080"];

    /* ---------- ambience ---------- */
    const ambiencePath = pickAmbiencePath(theme);
    const useAmbience = Boolean(ambiencePath);

    /* ---------- overlay ---------- */
    const overlayPath = pickOverlayPath(format);
    const useOverlay = Boolean(overlayPath);

    /* ---------- inputs ---------- */
    const imageInputs = images
      .map((_, i) => `-loop 1 -t ${perImage} -i "${dir}/img${i}.jpg"`)
      .join(" ");

    let inputs = `${imageInputs} -i "${dir}/audio.wav"`;
    if (useAmbience) inputs += ` -i "${ambiencePath}"`;
    if (useOverlay) inputs += ` -i "${overlayPath}"`;

    /* ---------- filter ---------- */
    const filters = images.map(
      (_, i) =>
        `[${i}:v]scale=${W}:${H}:force_original_aspect_ratio=increase,crop=${W}:${H},setpts=PTS-STARTPTS[v${i}]`
    );

    const concat = images.map((_, i) => `[v${i}]`).join("");

    let filter =
      `${filters.join(";")};` +
      `${concat}concat=n=${images.length}:v=1:a=0[vbase]`;

    let videoLabel = "[vbase]";
    let audioLabel = `[${images.length}:a]`;

    if (useOverlay) {
      const ovIndex = images.length + 1 + (useAmbience ? 1 : 0);
      filter +=
        `;[vbase]format=rgba[base]` +
        `;[${ovIndex}:v]scale=${W}:${H},format=rgba,colorchannelmixer=aa=0.15[fx]` +
        `;[base][fx]overlay=shortest=1[v]`;
      videoLabel = "[v]";
    }

    if (useAmbience) {
      const ambIndex = images.length + 1;
      filter +=
        `;[${ambIndex}:a]volume=0.2[amb]` +
        `;${audioLabel}[amb]amix=inputs=2:duration=first[a]`;
      audioLabel = "[a]";
    }

    filter += `;${videoLabel}format=yuv420p[vout]`;

    /* ---------- run ---------- */
    const out = `${dir}/out.mp4`;
    const cmd =
      `ffmpeg -y ${inputs} -filter_complex "${filter}" ` +
      `-map "[vout]" -map "${audioLabel}" -shortest -r 30 ` +
      `-c:v libx264 -preset veryfast -crf 28 -pix_fmt yuv420p ` +
      `-movflags +faststart -c:a aac -b:a 128k "${out}"`;

    console.log("🎬 FFmpeg:", cmd);
    await run(cmd);

    res.setHeader("Content-Type", "video/mp4");
    res.send(fs.readFileSync(out));
  } catch (e) {
    console.error("🔥 render failed:", e);
    res.status(500).json({ error: "render failed", details: String(e) });
  }
});

app.listen(8080, "0.0.0.0");
