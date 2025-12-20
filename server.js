import express from "express";
import fetch from "node-fetch";
import { exec, execSync } from "child_process";
import fs from "fs";

const app = express();
app.use(express.json({ limit: "50mb" }));

/* ------------------ OVERLAY PICKER ------------------ */

function pickOverlayPath(format) {
  const base = format === "9:16" ? "overlays/9x16" : "overlays/16x9";
  if (!fs.existsSync(base)) return null;
  const files = fs.readdirSync(base).filter(f => f.endsWith(".mp4"));
  if (!files.length) return null;
  return `${base}/${files[Math.floor(Math.random() * files.length)]}`;
}

/* ------------------ HELPERS ------------------ */

function ffprobeDuration(file) {
  const out = execSync(
    `ffprobe -v error -show_entries format=duration -of csv=p=0 "${file}"`
  ).toString().trim();
  return parseFloat(out);
}

async function download(url, dest) {
  const r = await fetch(url);
  if (!r.ok) throw new Error(`Download failed ${url}`);
  fs.writeFileSync(dest, Buffer.from(await r.arrayBuffer()));
}

function run(cmd) {
  return new Promise((resolve, reject) => {
    exec(cmd, { maxBuffer: 1024 * 1024 * 80 }, (err, _, stderr) => {
      if (err) return reject(stderr);
      resolve();
    });
  });
}

/* ------------------ RENDER ------------------ */

app.post("/render", async (req, res) => {
  try {
    const { videoId, images, audioUrl, format } = req.body;
    if (!videoId || !images?.length || !audioUrl) {
      return res.status(400).json({ error: "Missing inputs" });
    }

    const dir = `/tmp/${videoId}`;
    fs.mkdirSync(dir, { recursive: true });

    /* ---------- DOWNLOAD INPUTS ---------- */
    for (let i = 0; i < images.length; i++) {
      await download(images[i], `${dir}/img${i}.jpg`);
    }

    await download(audioUrl, `${dir}/audio.wav`);

    const audioDuration = ffprobeDuration(`${dir}/audio.wav`);
    const perImage = Math.max(audioDuration / images.length, 3);

    const [W, H] = format === "9:16"
      ? ["1080", "1920"]
      : ["1920", "1080"];

    const overlayPath = pickOverlayPath(format);

    /* ---------- INPUTS ---------- */
    const imageInputs = images
      .map((_, i) => `-loop 1 -t ${perImage} -i "${dir}/img${i}.jpg"`)
      .join(" ");

    const inputs =
      imageInputs +
      ` -i "${dir}/audio.wav"` +
      (overlayPath ? ` -i "${overlayPath}"` : "");

    /* ---------- FILTER GRAPH ---------- */
    const filters = images.map(
      (_, i) =>
        `[${i}:v]scale=${W}:${H}:force_original_aspect_ratio=increase,crop=${W}:${H},setpts=PTS-STARTPTS[v${i}]`
    );

    let filter =
      `${filters.join(";")};` +
      `${images.map((_, i) => `[v${i}]`).join("")}` +
      `concat=n=${images.length}:v=1:a=0[base]`;

    if (overlayPath) {
      const overlayIndex = images.length + 1; // after audio
      filter +=
        `;[base][${overlayIndex}:v]overlay=shortest=1,format=yuv420p[v]`;
    } else {
      filter += `;[base]format=yuv420p[v]`;
    }

    filter += `;[${images.length}:a]anull[a]`;

    /* ---------- EXEC ---------- */
    const out = `${dir}/out.mp4`;

    const cmd =
      `ffmpeg -y ${inputs} ` +
      `-filter_complex "${filter}" ` +
      `-map "[v]" -map "[a]" -shortest ` +
      `-r 30 -c:v libx264 -preset veryfast -crf 28 ` +
      `-pix_fmt yuv420p -movflags +faststart ` +
      `-c:a aac -b:a 128k "${out}"`;

    console.log("🎬 ffmpeg:", cmd);
    await run(cmd);

    res.setHeader("Content-Type", "video/mp4");
    res.send(fs.readFileSync(out));

  } catch (e) {
    console.error("🔥 render failed:", e);
    res.status(500).json({ error: "render failed", details: String(e) });
  }
});

app.listen(8080, "0.0.0.0");
