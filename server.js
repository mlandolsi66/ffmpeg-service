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

/* ------------------ END CARD ------------------ */
function getEndCard(format) {
  const endCardPath = path.join(
    __dirname,
    "endcards",
    format === "9:16" ? "endcard_9x16.jpg" : "endcard_16x9.jpg"
  );

  if (fs.existsSync(endCardPath)) {
    console.log("🎬 Using end card:", endCardPath);
    return endCardPath;
  }

  console.log("⚠️ End card not found, skipping");
  return null;
}

/* ------------------ OVERLAY (THEME-BASED) ------------------ */
function pickOverlay(format, theme = "") {
  const base = path.join(__dirname, "overlays");
  const dir = format === "9:16" ? path.join(base, "9x16") : path.join(base, "16x9");

  if (!fs.existsSync(dir)) {
    console.log("⚠️ Overlay dir missing:", dir);
    return null;
  }

  const t = String(theme).toLowerCase();
  let overlayName;

  if (format === "9:16") {
    if (t.includes("ocean") || t.includes("water") || t.includes("beach") || t.includes("sea")) {
      overlayName = "blue-pink-powder_ready.mp4";
    } else if (t.includes("space") || t.includes("stars") || t.includes("galaxy") || t.includes("cosmic")) {
      overlayName = "lights_ready.mp4";
    } else if (t.includes("magic") || t.includes("fairy") || t.includes("fantasy") || t.includes("wizard")) {
      overlayName = "dust.mp4";
    } else {
      overlayName = "bokeh_ready.mp4";
    }
  } else {
    if (t.includes("ocean") || t.includes("water") || t.includes("beach") || t.includes("sea")) {
      overlayName = "sparkles.mp4";
    } else if (t.includes("space") || t.includes("stars") || t.includes("galaxy") || t.includes("cosmic")) {
      overlayName = "light.mp4";
    } else if (t.includes("magic") || t.includes("fairy") || t.includes("fantasy") || t.includes("wizard")) {
      overlayName = "magic.mp4";
    } else {
      overlayName = "dust_bokeh.mp4";
    }
  }

  const overlayPath = path.join(dir, overlayName);
  if (fs.existsSync(overlayPath)) {
    console.log(`🎞 Using ${format} overlay:`, overlayName, "for theme:", theme || "default");
    return overlayPath;
  }

  console.log("⚠️ Requested overlay not found, using fallback");
  const files = fs.readdirSync(dir).filter((f) => f.endsWith(".mp4"));
  return files.length ? path.join(dir, files[0]) : null;
}

/* ------------------ HELPERS ------------------ */
function ffprobeDuration(file) {
  const d = parseFloat(
    execSync(`ffprobe -v error -show_entries format=duration -of csv=p=0 "${file}"`).toString().trim()
  );
  if (!Number.isFinite(d) || d <= 0) {
    throw new Error(`Invalid duration: ${file}`);
  }
  return d;
}

async function download(url, dest, retries = 3) {
  for (let attempt = 1; attempt <= retries; attempt++) {
    try {
      console.log(`⬇️ Downloading (attempt ${attempt}/${retries}):`, url);
      
      const r = await fetch(url, {
        timeout: 30000, // 30 second timeout
        headers: {
          'User-Agent': 'Mozilla/5.0'
        }
      });
      
      if (!r.ok) {
        throw new Error(`HTTP ${r.status}: ${r.statusText}`);
      }
      
      const arrayBuffer = await r.arrayBuffer();
      const buffer = Buffer.from(arrayBuffer);
      
      console.log(`✅ Downloaded ${buffer.length} bytes`);
      
      fs.writeFileSync(dest, buffer);
      
      // Verify file was written
      if (!fs.existsSync(dest)) {
        throw new Error(`File not written to ${dest}`);
      }
      
      const stats = fs.statSync(dest);
      console.log(`✅ Saved to ${dest} (${stats.size} bytes)`);
      
      return; // Success!
      
    } catch (error) {
      console.error(`❌ Download attempt ${attempt} failed:`, error.message);
      
      if (attempt === retries) {
        throw new Error(`Download failed after ${retries} attempts: ${error.message}`);
      }
      
      // Wait before retry (exponential backoff)
      const waitTime = attempt * 2000;
      console.log(`⏳ Waiting ${waitTime}ms before retry...`);
      await new Promise(resolve => setTimeout(resolve, waitTime));
    }
  }
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

    // ✅ VALIDATE: Check all image URLs first
    console.log("🔍 Validating image URLs...");
    for (let i = 0; i < images.length; i++) {
      if (!images[i] || typeof images[i] !== 'string') {
        throw new Error(`Image ${i} is invalid: ${images[i]}`);
      }
      
      if (!images[i].startsWith('http')) {
        throw new Error(`Image ${i} is not a URL: ${images[i]}`);
      }
      
      console.log(`✅ Image ${i} URL valid:`, images[i].substring(0, 60) + '...');
    }

    // Download all images
    for (let i = 0; i < images.length; i++) {
      await download(images[i], `${dir}/img${i}.jpg`);
      
      // ✅ VALIDATE: Check downloaded file
      const imgPath = `${dir}/img${i}.jpg`;
      if (!fs.existsSync(imgPath)) {
        throw new Error(`Image ${i} failed to download: ${images[i]}`);
      }
      
      const imgStats = fs.statSync(imgPath);
      console.log(`✅ img${i}.jpg saved: ${imgStats.size} bytes`);
      
      // ✅ VALIDATE: Check image dimensions with ffprobe
      try {
        const probe = execSync(`ffprobe -v error -select_streams v:0 -show_entries stream=width,height -of csv=p=0 "${imgPath}"`).toString().trim();
        console.log(`📐 img${i}.jpg dimensions: ${probe}`);
      } catch (probeError) {
        console.error(`⚠️ Could not probe img${i}.jpg:`, probeError.message);
      }
    }
    await download(audioUrl, `${dir}/voice.wav`);

    const ambFile = pickAmbience(theme);
    const ambPath = path.join(__dirname, "ambience", ambFile);

    console.log("🎧 Ambience file:", ambPath);

    if (!fs.existsSync(ambPath)) {
      console.error("❌ Ambience missing:", ambPath);
      throw new Error(`Ambience missing: ${ambPath}`);
    }

    const overlayPath = pickOverlay(format, theme);
    const endCardPath = getEndCard(format);
    const endCardDuration = 2.5;

    const audioDur = ffprobeDuration(`${dir}/voice.wav`);
    console.log("⏱ Narration duration:", audioDur);

    const storyDuration = endCardPath ? audioDur - endCardDuration : audioDur;
    const perImage = Math.max(storyDuration / images.length, 3);
    
    const fps = 25;
    const [W, H] = format === "9:16" ? [1080, 1920] : [1920, 1080];

    let cmdInputs = images.map((_, i) => `-loop 1 -framerate ${fps} -t ${perImage} -i "${dir}/img${i}.jpg"`).join(" ");

    if (endCardPath) {
      cmdInputs += ` -loop 1 -framerate ${fps} -t ${endCardDuration} -i "${endCardPath}"`;
    }

    cmdInputs += ` -i "${dir}/voice.wav"`;
    cmdInputs += ` -i "${ambPath}"`;
    if (overlayPath) cmdInputs += ` -stream_loop -1 -i "${overlayPath}"`;

    const voiceIdx = images.length + (endCardPath ? 1 : 0);
    const ambIdx = voiceIdx + 1;
    const overlayIdx = ambIdx + 1;

    const zoomFactor = 1.2;
    const totalFrames = Math.floor(perImage * fps);
    const fadeDuration = 0.5;

    // LIGHTWEIGHT ZOOM: Simpler calculation, less memory
    let filter = images.map((_, i) => {
      const zoomIn = i % 2 === 0;
      
      // Simpler zoom without complex pan calculations
      const zoomFilter = zoomIn 
        ? `zoompan=z='1+0.2*on/${totalFrames}':d=${totalFrames}:s=${W}x${H}:fps=${fps}`
        : `zoompan=z='1.2-0.2*on/${totalFrames}':d=${totalFrames}:s=${W}x${H}:fps=${fps}`;
      
      return (
        `[${i}:v]scale=${W * 1.2}:${H * 1.2}:force_original_aspect_ratio=increase,` +
        `crop=${W * 1.2}:${H * 1.2},` +
        `${zoomFilter},` +
        `format=yuv420p,setpts=PTS-STARTPTS` +
        (i === 0 ? `,fade=t=in:st=0:d=${fadeDuration}[v${i}]` :
         i === images.length - 1 ? `,fade=t=out:st=${perImage - fadeDuration}:d=${fadeDuration}[v${i}]` :
         `,fade=t=in:st=0:d=${fadeDuration},fade=t=out:st=${perImage - fadeDuration}:d=${fadeDuration}[v${i}]`)
      );
    }).join(";");

    const endCardIdx = images.length;

    if (endCardPath) {
      filter += `;[${endCardIdx}:v]scale=${W}:${H}:force_original_aspect_ratio=increase,crop=${W}:${H},fps=${fps},format=yuv420p,setpts=PTS-STARTPTS,fade=t=in:st=0:d=${fadeDuration}[vendcard]`;
      filter += ";" + images.map((_, i) => `[v${i}]`).join("") + `[vendcard]concat=n=${images.length + 1}:v=1:a=0[vconcat];[vconcat]trim=0:${audioDur},setpts=PTS-STARTPTS[base]`;
    } else {
      filter += ";" + images.map((_, i) => `[v${i}]`).join("") + `concat=n=${images.length}:v=1:a=0[vconcat];[vconcat]trim=0:${audioDur},setpts=PTS-STARTPTS[base]`;
    }

    if (overlayPath) {
      filter += `;[${overlayIdx}:v]scale=${W}:${H},fps=${fps},format=rgba,colorchannelmixer=aa=0.25,setpts=PTS-STARTPTS[ov];[base][ov]overlay=shortest=1:format=auto[v]`;
    } else {
      filter += `;[base]copy[v]`;
    }

    filter += `;[${voiceIdx}:a]aformat=fltp:48000:stereo,asetpts=PTS-STARTPTS[vox];[${ambIdx}:a]aformat=fltp:48000:stereo,aloop=loop=-1:size=2e+09,volume=0.18,apad,atrim=0:${audioDur},asetpts=PTS-STARTPTS[amb];[vox][amb]amix=inputs=2:duration=first:dropout_transition=0[a]`;

    const out = `${dir}/out.mp4`;

    const ffmpeg = `ffmpeg -y -loglevel error ${cmdInputs} -filter_complex "${filter}" -map "[v]" -map "[a]" -t ${audioDur} -c:v libx264 -preset veryfast -crf 23 -pix_fmt yuv420p -movflags +faststart -c:a aac -b:a 160k "${out}"`;

    console.log("🧠 FFmpeg command:\n", ffmpeg.substring(0, 500), "...");

    console.log("🧠 Running FFmpeg...");
    console.log("📊 Command length:", ffmpeg.length, "chars");

    try {
      await run(ffmpeg);
      console.log("✅ FFmpeg completed successfully");
    } catch (ffmpegError) {
      console.error("🔥 FFmpeg execution failed!");
      console.error("❌ Error message:", ffmpegError.message);
      console.error("❌ Error details:", String(ffmpegError).substring(0, 1000));
      throw ffmpegError;
    }

    console.log("📂 Checking if out.mp4 exists...");
    if (!fs.existsSync(out)) {
      throw new Error(`FFmpeg completed but ${out} was not created!`);
    }

    const stats = fs.statSync(out);
    console.log(`✅ Video file created: ${stats.size} bytes`);

    const buffer = fs.readFileSync(out);
    const publicUrl = await uploadToSupabase(videoId, buffer);

    await updateVideoStatus(videoId, "done", publicUrl);

    console.log("✅ Render complete:", publicUrl);

    fs.rmSync(dir, { recursive: true, force: true });

    return publicUrl;
  } catch (e) {
    console.error("🔥 Render failed:", e);

    try {
      await updateVideoStatus(videoId, "failed");
    } catch (dbErr) {
      console.error("❌ Could not update DB to failed:", dbErr);
    }

    if (fs.existsSync(dir)) {
      fs.rmSync(dir, { recursive: true, force: true });
    }

    throw e;
  }
}

/* ------------------ RENDER QUEUE ------------------ */
let renderQueue = [];
let isRendering = false;

async function processQueue() {
  if (isRendering || renderQueue.length === 0) return;
  
  isRendering = true;
  const { videoId, images, audioUrl, format, theme, res } = renderQueue.shift();
  
  console.log(`🎬 Processing video ${videoId} (${renderQueue.length} in queue)`);
  
  try {
    const publicUrl = await renderVideo(videoId, images, audioUrl, format, theme);
    
    if (res && !res.headersSent) {
      res.status(200).json({
        success: true,
        message: "render complete",
        videoId,
        url: publicUrl
      });
    }
  } catch (error) {
    console.error("🔥 Queue processing failed:", error);
    
    if (res && !res.headersSent) {
      res.status(500).json({
        error: "render failed",
        details: String(error.message || error)
      });
    }
  } finally {
    isRendering = false;
    
    // Process next item
    if (renderQueue.length > 0) {
      console.log(`📋 ${renderQueue.length} videos remaining in queue`);
      setTimeout(processQueue, 1000); // Small delay between videos
    }
  }
}

/* ------------------ ENDPOINT (UPDATED) ------------------ */
app.post("/render", async (req, res) => {
  try {
    const { videoId, images, audioUrl, format = "9:16", theme = "" } = req.body;

    console.log("🎬 Render request:", { videoId, format, theme });
    console.log("🖼 Images:", images?.length);

    if (!videoId || !images?.length || !audioUrl) {
      return res.status(400).json({ error: "Missing inputs" });
    }

    await updateVideoStatus(videoId, "rendering");

    // ✅ ADD TO QUEUE instead of immediate processing
    renderQueue.push({ videoId, images, audioUrl, format, theme, res: null });
    
    const queuePosition = renderQueue.length;
    console.log(`📋 Added to queue at position ${queuePosition}`);

    // Return 202 immediately
    res.status(202).json({
      success: true,
      message: queuePosition === 1 ? "render starting" : `queued at position ${queuePosition}`,
      videoId,
      queuePosition
    });

    // Start processing queue
    processQueue();

  } catch (e) {
    console.error("🔥 /render endpoint failed:", e);
    res.status(500).json({
      error: "render failed",
      details: String(e.message || e)
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
