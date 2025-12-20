import express from "express";
import fetch from "node-fetch";
import { exec, execSync } from "child_process";
import fs from "fs";

const app = express();
app.use(express.json({ limit: "50mb" }));

/* ------------------ AMBIENCE ------------------ */
function pickAmbience(theme = "") {
  const t = theme.toLowerCase();
  if (t.includes("ocean")) return "waves.wav";
  if (t.includes("space")) return "whitenoise-space.wav";
  if (t.includes("forest")) return "forest.wav";
  return "lullaby.wav";
}

/* ------------------ OVERLAY ------------------ */
function pickOverlay(format) {
  const dir = format === "9:16" ? "overlays/9x16" : "overlays/16x9";
  const files = fs.existsSync(dir)
    ? fs.readdirSync(dir).filter(f => f.endsWith(".mp4"))
    : [];
  return files.length ? `${dir}/${files[0]}` : null;
}

/* ------------------ HELPERS ------------------ */
function ffprobeDuration(file) {
  return parseFloat(
    execSync(`ffprobe -v error -show_entries format=duration -of csv=p=0 "${file}"`)
      .toString()
      .trim()
  );
}

async function download(url, dest) {
  const r = await fetch(url);
  if (!r.ok) throw new Error(`Download failed ${url}`);
  fs.writeFileSync(dest, Buffer.from(await r.arrayBuffer()));
}

function run(cmd) {
  return new Promise((res, rej) =>
    exec(cmd, { maxBuffer: 1024 * 1024 * 80 }, (e, _, err) =>
      e ? rej(err) : res()
    )
  );
}

/* ------------------ RENDER ------------------ */
app.post("/render", async (req, res) => {
  try {
    const { videoId, images, audioUrl, format, theme } = req.body;
    if (!images?.length || !audioUrl)
      return res.status(400).json({ error: "Missing inputs" });

    const dir = `/tmp/${videoId}`;
    fs.mkdirSync(dir, { recursive: true });

    /* ---------- DOWNLOAD ---------- */
    for (let i = 0; i < images.length; i++) {
      await download(images[i], `${dir}/img${i}.jpg`);
    }

    await download(audioUrl, `${dir}/voice.wav`);

    const ambFile = pickAmbience(theme);
    const ambPath = `ambience/${ambFile}`;
    const hasAmbience = fs.existsSync(ambPath);

    const overlayPath = pickOverlay(format);

    const audioDur = ffprobeDuration(`${dir}/voice.wav`);
    const perImage = Math.max(audioDur / images.length, 3);

    const [W, H] = format === "9:16"
      ? ["1080", "1920"]
      : ["1920", "1080"];

    /* ---------- INPUTS ---------- */
    let cmdInputs = images
      .map((_, i) => `-loop 1 -t ${perImage} -i "${dir}/img${i}.jpg"`)
      .join(" ");

    cmdInputs += ` -i "${dir}/voice.wav"`;

    if (hasAmbience) cmdInputs += ` -stream_loop -1 -i "${ambPath}"`;
    if (overlayPath) cmdInputs += ` -stream_loop -1 -i "${overlayPath}"`;

    const voiceIdx = images.length;
    const ambIdx = voiceIdx + 1;
    const overlayIdx = hasAmbience ? ambIdx + 1 : ambIdx;

    /* ---------- FILTER ---------- */
    let filter = images.map(
      (_, i) =>
        `[${i}:v]scale=${W}:${H}:force_original_aspect_ratio=increase,crop=${W}:${H},setpts=PTS-STARTPTS[v${i}]`
    ).join(";");

    filter += ";" + images.map((_, i) => `[v${i}]`).join("") +
      `concat=n=${images.length}:v=1:a=0[base]`;

    if (overlayPath) {
      filter += `;[base][${overlayIdx}:v]overlay=shortest=1,format=yuv420p[v]`;
    } else {
      filter += `;[base]format=yuv420p[v]`;
    }

    if (hasAmbience) {
      filter += `;[${ambIdx}:a]volume=0.25[amb]`;
      filter += `;[${voiceIdx}:a][amb]amix=inputs=2:duration=first[a]`;
    } else {
      filter += `;[${voiceIdx}:a]anull[a]`;
    }

    /* ---------- EXEC ---------- */
    const out = `${dir}/out.mp4`;

    const ffmpeg =
      `ffmpeg -y ${cmdInputs} ` +
      `-filter_complex "${filter}" ` +
      `-map "[v]" -map "[a]" -shortest ` +
      `-c:v libx264 -preset veryfast -crf 28 ` +
      `-pix_fmt yuv420p -movflags +faststart ` +
      `-c:a aac -b:a 128k "${out}"`;

    console.log("🎬 ffmpeg:", ffmpeg);
    await run(ffmpeg);

    res.setHeader("Content-Type", "video/mp4");
    res.send(fs.readFileSync(out));

  } catch (e) {
    console.error("🔥 render failed:", e);
    res.status(500).json({ error: "render failed", details: String(e) });
  }
});

app.listen(8080, "0.0.0.0");
