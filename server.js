import express from "express";
import fetch from "node-fetch";
import { exec, execSync } from "child_process";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

/* ------------------ ESM PATH FIX ------------------ */
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

/* ------------------ APP ------------------ */
const app = express();
app.use(express.json({ limit: "50mb" }));

console.log("🚀 Server starting");
console.log("📂 process.cwd() =", process.cwd());
console.log("📂 __dirname =", __dirname);

/* ------------------ AMBIENCE (ALWAYS) ------------------ */
function pickAmbience(theme = "") {
  const t = String(theme).toLowerCase();
  if (t.includes("ocean")) return "waves.wav";
  if (t.includes("space")) return "whitenoise-space.wav";
  if (t.includes("forest")) return "forest.wav";
  return "lullaby.wav";
}

/* ------------------ OVERLAY ------------------ */
function pickOverlay(format) {
  const base = path.join(__dirname, "overlays");
  const dir =
    format === "9:16"
      ? path.join(base, "9x16")
      : path.join(base, "16x9");

  if (!fs.existsSync(dir)) {
    console.log("⚠️ Overlay dir missing:", dir);
    return null;
  }

  const files = fs.readdirSync(dir).filter(f => f.endsWith(".mp4"));
  console.log("🎞 Overlay files:", files);

  return files.length ? path.join(dir, files[0]) : null;
}

/* ------------------ HELPERS ------------------ */
function ffprobeDuration(file) {
  const d = parseFloat(
    execSync(
      `ffprobe -v error -show_entries format=duration -of csv=p=0 "${file}"`
    )
      .toString()
      .trim()
  );
  if (!Number.isFinite(d) || d <= 0) {
    throw new Error(`Invalid duration: ${file}`);
  }
  return d;
}

async function download(url, dest) {
  console.log("⬇️ Downloading:", url);
  const r = await fetch(url);
  if (!r.ok) throw new Error(`Download failed: ${url}`);
  fs.writeFileSync(dest, Buffer.from(await r.arrayBuffer()));
}

function run(cmd) {
  return new Promise((res, rej) =>
    exec(cmd, { maxBuffer: 1024 * 1024 * 200 }, (e, o, err) =>
      e ? rej(new Error(err || o)) : res()
    )
  );
}

/* ------------------ RENDER ------------------ */
app.post("/render", async (req, res) => {
  try {
    const { videoId, images, audioUrl, format = "9:16", theme = "" } = req.body;

    console.log("🎬 Render request:", { videoId, format, theme });
    console.log("🖼 Images:", images?.length);

    if (!videoId || !images?.length || !audioUrl) {
      return res.status(400).json({ error: "Missing inputs" });
    }

    const dir = `/tmp/${videoId}`;
    fs.mkdirSync(dir, { recursive: true });

    /* ---------- DOWNLOAD ---------- */
    for (let i = 0; i < images.length; i++) {
      await download(images[i], `${dir}/img${i}.jpg`);
    }
    await download(audioUrl, `${dir}/voice.wav`);

    /* ---------- AMBIENCE ---------- */
    const ambFile = pickAmbience(theme);
    const ambPath = path.join(__dirname, "ambience", ambFile);

    console.log("🎧 Ambience file:", ambPath);

    if (!fs.existsSync(ambPath)) {
      console.log(
        "❌ Ambience dir contents:",
        fs.existsSync(path.join(__dirname, "ambience"))
          ? fs.readdirSync(path.join(__dirname, "ambience"))
          : "MISSING DIR"
      );
      throw new Error(`Ambience missing: ${ambPath}`);
    }

    /* ---------- OVERLAY ---------- */
    const overlayPath = pickOverlay(format);

    /* ---------- DURATIONS ---------- */
    const audioDur = ffprobeDuration(`${dir}/voice.wav`);
    console.log("⏱ Narration duration:", audioDur);

    const fps = 25;
    const perImage = Math.max(audioDur / images.length, 3);
    const [W, H] = format === "9:16" ? [1080, 1920] : [1920, 1080];

    /* ---------- INPUTS (LOCKED ORDER) ---------- */
    let cmdInputs = images
      .map(
        (_, i) =>
          `-loop 1 -framerate ${fps} -t ${perImage} -i "${dir}/img${i}.jpg"`
      )
      .join(" ");

    cmdInputs += ` -i "${dir}/voice.wav"`;
    cmdInputs += ` -i "${ambPath}"`;

    if (overlayPath) cmdInputs += ` -stream_loop -1 -i "${overlayPath}"`;

    const voiceIdx = images.length;
    const ambIdx = voiceIdx + 1;
    const overlayIdx = ambIdx + 1;

    /* ---------- FILTER GRAPH ---------- */
    let filter = images
      .map(
        (_, i) =>
          `[${i}:v]scale=${W}:${H}:force_original_aspect_ratio=increase,` +
          `crop=${W}:${H},fps=${fps},format=yuv420p,` +
          `setpts=PTS-STARTPTS[v${i}]`
      )
      .join(";");

    filter +=
      ";" +
      images.map((_, i) => `[v${i}]`).join("") +
      `concat=n=${images.length}:v=1:a=0,` +
      `trim=0:${audioDur},setpts=PTS-STARTPTS[base]`;

    if (overlayPath) {
      filter +=
        `;[${overlayIdx}:v]scale=${W}:${H},fps=${fps},format=rgba,` +
        `colorchannelmixer=aa=0.25,setpts=PTS-STARTPTS[ov]` +
        `;[base][ov]overlay=shortest=1:format=auto[v]`;
    } else {
      filter += `;[base]copy[v]`;
    }

    filter +=
      `;[${voiceIdx}:a]aformat=fltp:48000:stereo,asetpts=PTS-STARTPTS[vox]` +
      `;[${ambIdx}:a]aformat=fltp:48000:stereo,` +
      `aloop=loop=-1:size=2e+09,volume=0.18,apad,` +
      `atrim=0:${audioDur},asetpts=PTS-STARTPTS[amb]` +
      `;[vox][amb]amix=inputs=2:duration=first:dropout_transition=0[a]`;

    /* ---------- EXEC ---------- */
    const out = `${dir}/out.mp4`;

    const ffmpeg =
      `ffmpeg -y ${cmdInputs} ` +
      `-filter_complex "${filter}" ` +
      `-map "[v]" -map "[a]" ` +
      `-t ${audioDur} ` +
      `-c:v libx264 -preset veryfast -crf 23 -pix_fmt yuv420p -movflags +faststart ` +
      `-c:a aac -b:a 160k "${out}"`;

    console.log("🧠 FFmpeg command:\n", ffmpeg);

    await run(ffmpeg);

    res.setHeader("Content-Type", "video/mp4");
    res.send(fs.readFileSync(out));

  } catch (e) {
    console.error("🔥 render failed:", e);
    res.status(500).json({
      error: "render failed",
      details: String(e.message || e)
    });
  }
});

app.listen(8080, "0.0.0.0", () =>
  console.log("✅ Listening on 0.0.0.0:8080")
);
