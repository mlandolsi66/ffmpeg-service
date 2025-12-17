import express from "express";
import fetch from "node-fetch";
import { exec, execSync } from "child_process";
import fs from "fs";

const app = express();
app.use(express.json({ limit: "50mb" }));

/**
 * Put your assets in Supabase Storage bucket "videos":
 *  - videos/ambience/*.wav
 *  - videos/overlays/*.mp4
 *
 * Set this env var in Railway:
 * ASSET_BASE_URL = https://<PROJECT>.supabase.co/storage/v1/object/public/videos
 */
const ASSET_BASE_URL = process.env.ASSET_BASE_URL; // REQUIRED

// Your 8 ambience files (as you listed)
const AMBIENCE_FILES = [
  "adventure.wav",
  "fairy.wav",
  "forest.wav",
  "lullaby.wav",
  "music-box-34179.wav",
  "underwater.wav",
  "waves.wav",
  "whitenoise-space.wav"
];

// Your overlay videos (as you listed)
const OVERLAY_FILES = [
  "dust_bokeh.mp4",
  "light.mp4",
  "magic.mp4",
  "sparkles.mp4"
];

// --- deterministic hash (stable across runs) ---
function hashStringToInt(str) {
  let h = 2166136261; // FNV-1a base
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return Math.abs(h >>> 0);
}

function pickOverlay(videoId) {
  const idx = hashStringToInt(videoId + "|overlay") % OVERLAY_FILES.length;
  return OVERLAY_FILES[idx];
}

/**
 * Pick ambience based on (optional) theme, with deterministic variation.
 * - If theme contains "ocean/sea/underwater": choose between underwater.wav and waves.wav deterministically
 * - If theme contains "forest": forest.wav
 * - If theme contains "space": whitenoise-space.wav
 * - If theme contains "adventure": adventure.wav
 * - If theme contains "fairy/magic": fairy.wav OR music-box deterministic
 * - Else: lullaby.wav
 */
function pickAmbience(videoId, themeMaybe) {
  const theme = (themeMaybe || "").toLowerCase();
  const r = hashStringToInt(videoId + "|amb");

  const choose = (a, b) => (r % 2 === 0 ? a : b);

  if (theme.includes("ocean") || theme.includes("sea") || theme.includes("underwater")) {
    return choose("underwater.wav", "waves.wav"); // ✅ your request: sometimes waves for ocean
  }
  if (theme.includes("forest") || theme.includes("woods")) return "forest.wav";
  if (theme.includes("space") || theme.includes("galaxy")) return "whitenoise-space.wav";
  if (theme.includes("adventure")) return "adventure.wav";
  if (theme.includes("fairy") || theme.includes("magic")) {
    return choose("fairy.wav", "music-box-34179.wav");
  }
  return "lullaby.wav";
}

async function downloadTo(url, path) {
  const r = await fetch(url);
  if (!r.ok) throw new Error(`Download failed: ${url} (${r.status})`);
  const buf = Buffer.from(await r.arrayBuffer());
  fs.writeFileSync(path, buf);
}

app.post("/render", async (req, res) => {
  try {
    const { videoId, images, audioUrl, format, theme } = req.body;

    if (!ASSET_BASE_URL) {
      return res.status(500).json({ error: "Missing ASSET_BASE_URL env var" });
    }

    if (!videoId || !images?.length || !audioUrl) {
      return res.status(400).json({ error: "Missing videoId, images or audioUrl" });
    }

    const dir = `/tmp/${videoId}`;
    fs.mkdirSync(dir, { recursive: true });

    // 1) Download images
    for (let i = 0; i < images.length; i++) {
      await downloadTo(images[i], `${dir}/img${i}.jpg`);
    }

    // 2) Download narration audio (WAV)
    await downloadTo(audioUrl, `${dir}/voice.wav`);

    // 3) Pick + download ambience + overlay from Supabase
    const ambienceFile = pickAmbience(videoId, theme);
    const overlayFile = pickOverlay(videoId);

    const ambienceUrl = `${ASSET_BASE_URL}/ambience/${ambienceFile}`;
    const overlayUrl = `${ASSET_BASE_URL}/overlays/${overlayFile}`;

    await downloadTo(ambienceUrl, `${dir}/ambience.wav`);
    await downloadTo(overlayUrl, `${dir}/overlay.mp4`);

    // 4) Video settings
    const fps = 30;
    const target = format === "9:16" ? "1080:1920" : "1920:1080";
    const zoomSize = format === "9:16" ? "1080x1920" : "1920x1080";
    const out = `${dir}/out.mp4`;

    // 5) Get narration duration
    let voiceDuration = 0;
    try {
      voiceDuration = parseFloat(
        execSync(
          `ffprobe -v error -show_entries format=duration -of csv=p=0 ${dir}/voice.wav`
        )
          .toString()
          .trim()
      );
    } catch {
      return res.status(400).json({ error: "Invalid narration WAV" });
    }

    const perScene = Math.max(1, voiceDuration / images.length);
    const framesPerScene = Math.max(1, Math.round(perScene * fps));

    // 6) Inputs
    // Images: perScene seconds each (deterministic, covers whole narration)
    const imageInputs = images
      .map((_, i) => `-loop 1 -t ${perScene.toFixed(3)} -i ${dir}/img${i}.jpg`)
      .join(" ");

    // overlay loop + ambience loop
    const inputs =
      `${imageInputs} ` +
      `-stream_loop -1 -i ${dir}/overlay.mp4 ` +
      `-stream_loop -1 -i ${dir}/ambience.wav ` +
      `-i ${dir}/voice.wav`;

    // Input indices:
    // 0..N-1 = images
    // N = overlay video
    // N+1 = ambience wav
    // N+2 = voice wav
    const overlayIndex = images.length;
    const ambienceIndex = images.length + 1;
    const voiceIndex = images.length + 2;

    // 7) Motion patterns (gentle pan + zoom, alternating direction)
    // Keep it “cozy”: small zoom, slow pan, no vibration.
    const motions = [
      // left -> right
      `x='(iw-ow)*(t/${perScene.toFixed(3)})':y='(ih-oh)*0.50'`,
      // right -> left
      `x='(iw-ow)*(1-t/${perScene.toFixed(3)})':y='(ih-oh)*0.50'`,
      // top -> bottom
      `x='(iw-ow)*0.50':y='(ih-oh)*(t/${perScene.toFixed(3)})'`,
      // bottom -> top
      `x='(iw-ow)*0.50':y='(ih-oh)*(1-t/${perScene.toFixed(3)})'`
    ];

    // per-scene overlay opacity (subtle)
    const opacities = [0.10, 0.14, 0.12, 0.16, 0.11, 0.15];

    // 8) Filter graph
    const vFilters = images
      .map((_, i) => {
        const motion = motions[i % motions.length];
        const alpha = opacities[i % opacities.length];

        return (
          // base scene
          `[${i}:v]` +
          `scale=${target}:force_original_aspect_ratio=increase,` +
          `crop=${target}:${motion},` +
          // gentle zoom (max ~1.07)
          `zoompan=z='min(zoom+0.0009,1.07)':d=${framesPerScene}:s=${zoomSize}:fps=${fps},` +
          `format=yuv420p,` +
          `setpts=PTS-STARTPTS` +
          `[base${i}];` +
          // overlay slice for this scene
          `[${overlayIndex}:v]` +
          `scale=${target},` +
          `format=rgba,` +
          `trim=duration=${perScene.toFixed(3)},setpts=PTS-STARTPTS,` +
          `colorchannelmixer=aa=${alpha}` +
          `[ov${i}];` +
          // composite
          `[base${i}][ov${i}]overlay=0:0[v${i}]`
        );
      })
      .join(";");

    const concatInputs = images.map((_, i) => `[v${i}]`).join("");
    const vConcat = `${concatInputs}concat=n=${images.length}:v=1:a=0[vraw]`;

    // fade out video at end (cozy)
    const vFadeDur = 1.5;
    const vFadeStart = Math.max(0, voiceDuration - vFadeDur).toFixed(3);
    const vOut = `[vraw]fade=t=out:st=${vFadeStart}:d=${vFadeDur}[v]`;

    // audio: ambience under voice, loop ambience, trim to voice length, fade out
    const aFadeDur = 2.0;
    const aFadeStart = Math.max(0, voiceDuration - aFadeDur).toFixed(3);

    const aMix =
      `[${ambienceIndex}:a]atrim=0:${voiceDuration.toFixed(3)},asetpts=PTS-STARTPTS,volume=0.18[amb];` +
      `[${voiceIndex}:a]asetpts=PTS-STARTPTS,volume=1.0[voice];` +
      `[voice][amb]amix=inputs=2:duration=first[a0];` +
      `[a0]afade=t=out:st=${aFadeStart}:d=${aFadeDur}[a]`;

    const filterComplex = `${vFilters};${vConcat};${vOut};${aMix}`;

    // 9) FFmpeg command
    const cmd =
      `ffmpeg -y -r ${fps} ${inputs} ` +
      `-filter_complex "${filterComplex}" ` +
      `-map "[v]" -map "[a]" ` +
      `-shortest -pix_fmt yuv420p "${out}"`;

    console.log("🎬 FFmpeg:", cmd);

    exec(cmd, { maxBuffer: 1024 * 1024 * 30 }, (err, stdout, stderr) => {
      if (stdout) console.log(stdout);
      if (stderr) console.log(stderr);

      if (err) {
        return res.status(500).json({ error: "FFmpeg failed", stderr: stderr?.slice(-4000) });
      }

      const buf = fs.readFileSync(out);
      res.setHeader("Content-Type", "video/mp4");
      res.send(buf);
    });
  } catch (e) {
    console.error("🔥 Server crash:", e);
    res.status(500).json({ error: "Server crash", details: String(e?.message || e) });
  }
});

const PORT = process.env.PORT || 8080;
app.listen(PORT, "0.0.0.0", () => console.log(`🎬 FFmpeg service on :${PORT}`));
