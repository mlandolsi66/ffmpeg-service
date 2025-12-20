import express from "express";
import fetch from "node-fetch";
import { exec, execSync } from "child_process";
import fs from "fs";
import path from "path";

const app = express();
app.use(express.json({ limit: "50mb" }));

/* ------------------ AMBIENCE ------------------ */
function pickAmbience(theme = "") {
  const t = String(theme).toLowerCase();
  if (t.includes("ocean")) return "waves.wav";
  if (t.includes("space")) return "whitenoise-space.wav";
  if (t.includes("forest")) return "forest.wav";
  return "lullaby.wav";
}

/* ------------------ OVERLAY ------------------ */
function pickOverlay(format) {
  const dir = format === "9:16" ? "overlays/9x16" : "overlays/16x9";
  if (!fs.existsSync(dir)) return null;
  const files = fs.readdirSync(dir).filter((f) => f.endsWith(".mp4"));
  return files.length ? path.join(dir, files[0]) : null;
}

/* ------------------ HELPERS ------------------ */
function ffprobeDuration(file) {
  const s = execSync(
    `ffprobe -v error -show_entries format=duration -of csv=p=0 "${file}"`
  )
    .toString()
    .trim();
  const d = parseFloat(s);
  if (!Number.isFinite(d) || d <= 0) throw new Error(`Bad duration for ${file}: ${s}`);
  return d;
}

async function download(url, dest) {
  const r = await fetch(url);
  if (!r.ok) throw new Error(`Download failed ${url} (${r.status})`);
  fs.writeFileSync(dest, Buffer.from(await r.arrayBuffer()));
}

function run(cmd) {
  return new Promise((res, rej) =>
    exec(cmd, { maxBuffer: 1024 * 1024 * 200 }, (e, stdout, stderr) =>
      e ? rej(new Error(stderr || stdout || String(e))) : res()
    )
  );
}

/* ------------------ RENDER ------------------ */
app.post("/render", async (req, res) => {
  try {
    const { videoId, images, audioUrl, format = "9:16", theme = "" } = req.body;
    if (!videoId || !images?.length || !audioUrl) {
      return res.status(400).json({ error: "Missing inputs" });
    }

    const dir = `/tmp/${videoId}`;
    fs.mkdirSync(dir, { recursive: true });

    // Download assets
    for (let i = 0; i < images.length; i++) {
      await download(images[i], `${dir}/img${i}.jpg`);
    }
    await download(audioUrl, `${dir}/voice.wav`);

    const ambPath = path.join("ambience", pickAmbience(theme));
    const hasAmbience = fs.existsSync(ambPath);

    const overlayPath = pickOverlay(format);
    const hasOverlay = !!overlayPath && fs.existsSync(overlayPath);

    const audioDur = ffprobeDuration(`${dir}/voice.wav`);

    const fps = 25;
    const perImage = Math.max(audioDur / images.length, 3);
    const [W, H] = format === "9:16" ? [1080, 1920] : [1920, 1080];

    // Inputs: images..., voice, ambience?, overlay?
    let cmdInputs = images
      .map((_, i) => `-loop 1 -framerate ${fps} -t ${perImage} -i "${dir}/img${i}.jpg"`)
      .join(" ");

    cmdInputs += ` -i "${dir}/voice.wav"`;
    if (hasAmbience) cmdInputs += ` -stream_loop -1 -i "${ambPath}"`;
    if (hasOverlay) cmdInputs += ` -stream_loop -1 -i "${overlayPath}"`;

    const voiceIdx = images.length;
    const ambIdx = voiceIdx + 1;
    const overlayIdx = hasAmbience ? ambIdx + 1 : ambIdx;

    // Filter graph
    let filter = images
      .map(
        (_, i) =>
          `[${i}:v]` +
          `scale=${W}:${H}:force_original_aspect_ratio=increase,` +
          `crop=${W}:${H},` +
          `fps=${fps},` +
          `format=yuv420p,` +
          `setpts=PTS-STARTPTS[v${i}]`
      )
      .join(";");

    filter +=
      ";" +
      images.map((_, i) => `[v${i}]`).join("") +
      `concat=n=${images.length}:v=1:a=0,trim=0:${audioDur},setpts=PTS-STARTPTS[base]`;

    if (hasOverlay) {
      // Make overlay NOT fully opaque (fix "only overlay visible")
      filter +=
        `;[${overlayIdx}:v]scale=${W}:${H},fps=${fps},format=rgba,setpts=PTS-STARTPTS,` +
        `colorchannelmixer=aa=0.25[ov]` +
        `;[base][ov]overlay=shortest=1:format=auto[v]`;
    } else {
      filter += `;[base]copy[v]`;
    }

    if (hasAmbience) {
      // Loop ambience and trim to narration length
      filter +=
        `;[${ambIdx}:a]` +
        `aformat=sample_fmts=fltp:sample_rates=48000:channel_layouts=stereo,` +
        `volume=0.18,atrim=0:${audioDur},asetpts=PTS-STARTPTS[amb]` +
        `;[${voiceIdx}:a]aformat=sample_fmts=fltp:sample_rates=48000:channel_layouts=stereo,asetpts=PTS-STARTPTS[vox]` +
        `;[vox][amb]amix=inputs=2:weights=1 1:duration=first:dropout_transition=0[a]`;
    } else {
      filter +=
        `;[${voiceIdx}:a]aformat=sample_fmts=fltp:sample_rates=48000:channel_layouts=stereo,asetpts=PTS-STARTPTS[a]`;
    }

    const out = `${dir}/out.mp4`;

    const ffmpeg =
      `ffmpeg -y ${cmdInputs} ` +
      `-filter_complex "${filter}" ` +
      `-map "[v]" -map "[a]" ` +
      `-t ${audioDur} ` +
      `-r ${fps} ` +
      `-c:v libx264 -preset veryfast -crf 23 -pix_fmt yuv420p -movflags +faststart ` +
      `-c:a aac -b:a 160k "${out}"`;

    console.log("🎬 ffmpeg:", ffmpeg);
    await run(ffmpeg);

    res.setHeader("Content-Type", "video/mp4");
    res.send(fs.readFileSync(out));
  } catch (e) {
    console.error("🔥 render failed:", e);
    res.status(500).json({ error: "render failed", details: String(e?.message || e) });
  }
});

app.listen(8080, "0.0.0.0");
