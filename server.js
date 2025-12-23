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

/* ------------------ SUPABASE CONFIG ------------------ */
const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

if (!SUPABASE_URL || !SUPABASE_SERVICE_KEY) {
  console.warn("⚠️ Supabase credentials missing - uploads will fail");
}

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
  const dir = format === "9:16" ? path.join(base, "9x16") : path.join(base, "16x9");

  if (!fs.existsSync(dir)) {
    console.log("⚠️ Overlay dir missing:", dir);
    return null;
  }

  const files = fs.readdirSync(dir).filter((f) => f.endsWith(".mp4"));
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

/* ------------------ SUPABASE UPLOAD ------------------ */
async function uploadToSupabase(videoId, buffer) {
  if (!SUPABASE_URL || !SUPABASE_SERVICE_KEY) {
    throw new Error("Supabase credentials not configured");
  }

  const path = `final/${videoId}.mp4`;
  const uploadUrl = `${SUPABASE_URL}/storage/v1/object/videos/${path}`;

  console.log("📤 Uploading to Supabase:", path);

  const uploadRes = await fetch(uploadUrl, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${SUPABASE_SERVICE_KEY}`,
      "Content-Type": "video/mp4",
      "x-upsert": "true",
    },
    body: buffer,
  });

  if (!uploadRes.ok) {
    const err = await uploadRes.text();
    throw new Error(`Supabase upload failed: ${err}`);
  }

  const publicUrl = `${SUPABASE_URL}/storage/v1/object/public/videos/${path}`;
  console.log("✅ Uploaded:", publicUrl);

  return publicUrl;
}

/* ------------------ UPDATE DB ------------------ */
async function updateVideoStatus(videoId, status, videoUrl = null) {
  if (!SUPABASE_URL || !SUPABASE_SERVICE_KEY) {
    console.warn("⚠️ Cannot update DB - no Supabase credentials");
    return;
  }

  const updateUrl = `${SUPABASE_URL}/rest/v1/videos?id=eq.${videoId}`;

  const payload = { status };
  if (videoUrl) {
    payload.video_url = videoUrl;
    payload.final = true;
  }

  console.log("📝 Updating DB:", payload);

  const res = await fetch(updateUrl, {
    method: "PATCH",
    headers: {
      Authorization: `Bearer ${SUPABASE_SERVICE_KEY}`,
      apikey: SUPABASE_SERVICE_KEY,
      "Content-Type": "application/json",
      Prefer: "return=minimal",
    },
    body: JSON.stringify(payload),
  });

  if (!res.ok) {
    const err = await res.text();
    console.error("❌ DB update failed:", err);
    throw new Error(`DB update failed: ${err}`);
  }

  console.log("✅ DB updated");
}

/* ------------------ RENDER (ASYNC) ------------------ */
async function renderVideo(videoId, images, audioUrl, format, theme) {
  const dir = `/tmp/${videoId}`;

  try {
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
      console.error(
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

    /* ---------- FILTER GRAPH (WITH KEN BURNS - FIXED) ---------- */
    const zoomFactor = 1.15; // 15% zoom (1.15), or 1.2 for more dramatic
    const totalFrames = Math.floor(perImage * fps); // Convert seconds to frames

    // Process each image with Ken Burns zoom
    let filter = images
      .map((_, i) => {
        // Alternate zoom direction for variety
        const zoomIn = i % 2 === 0;
        
        if (zoomIn) {
          // ZOOM IN: Start at 1.0, end at zoomFactor
          const zoomIncrement = (zoomFactor - 1.0) / totalFrames;
          return (
            `[${i}:v]scale=${W * 1.3}:${H * 1.3}:force_original_aspect_ratio=increase,` +
            `crop=${W * 1.3}:${H * 1.3},` +
            `zoompan=z='min(1.0+on*${zoomIncrement},${zoomFactor})':d=${totalFrames}:x='iw/2-(iw/zoom/2)':y='ih/2-(ih/zoom/2)':s=${W}x${H}:fps=${fps},` +
            `format=yuv420p,setpts=PTS-STARTPTS[v${i}]`
          );
        } else {
          // ZOOM OUT: Start at zoomFactor, end at 1.0
          const zoomDecrement = (zoomFactor - 1.0) / totalFrames;
          return (
            `[${i}:v]scale=${W * 1.3}:${H * 1.3}:force_original_aspect_ratio=increase,` +
            `crop=${W * 1.3}:${H * 1.3},` +
            `zoompan=z='max(${zoomFactor}-on*${zoomDecrement},1.0)':d=${totalFrames}:x='iw/2-(iw/zoom/2)':y='ih/2-(ih/zoom/2)':s=${W}x${H}:fps=${fps},` +
            `format=yuv420p,setpts=PTS-STARTPTS[v${i}]`
          );
        }
      })
      .join(";");

    // Concatenate all zoomed scenes
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

    /* ---------- UPLOAD TO SUPABASE ---------- */
    const buffer = fs.readFileSync(out);
    const publicUrl = await uploadToSupabase(videoId, buffer);

    /* ---------- UPDATE DB ---------- */
    await updateVideoStatus(videoId, "done", publicUrl);

    console.log("✅ Render complete:", publicUrl);

    /* ---------- CLEANUP ---------- */
    fs.rmSync(dir, { recursive: true, force: true });

    return publicUrl;
  } catch (e) {
    console.error("🔥 Render failed:", e);

    // Update DB to failed status
    try {
      await updateVideoStatus(videoId, "failed");
    } catch (dbErr) {
      console.error("❌ Could not update DB to failed:", dbErr);
    }

    // Cleanup on failure
    if (fs.existsSync(dir)) {
      fs.rmSync(dir, { recursive: true, force: true });
    }

    throw e;
  }
}

/* ------------------ ENDPOINT ------------------ */
app.post("/render", async (req, res) => {
  try {
    const { videoId, images, audioUrl, format = "9:16", theme = "" } = req.body;

    console.log("🎬 Render request:", { videoId, format, theme });
    console.log("🖼 Images:", images?.length);

    if (!videoId || !images?.length || !audioUrl) {
      return res.status(400).json({ error: "Missing inputs" });
    }

    // Update status to rendering
    await updateVideoStatus(videoId, "rendering");

    // Return immediately - render happens async
    res.status(202).json({
      success: true,
      message: "Rendering started",
      videoId,
    });

    // Start render in background
    renderVideo(videoId, images, audioUrl, format, theme).catch((e) => {
      console.error("🔥 Background render failed:", e);
    });
  } catch (e) {
    console.error("🔥 /render endpoint failed:", e);
    res.status(500).json({
      error: "render failed",
      details: String(e.message || e),
    });
  }
});

/* ------------------ HEALTH CHECK ------------------ */
app.get("/health", (req, res) => {
  res.json({ status: "ok", timestamp: new Date().toISOString() });
});

app.listen(8080, "0.0.0.0", () =>
  console.log("✅ Listening on 0.0.0.0:8080")
);
