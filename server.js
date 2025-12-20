import express from "express";
import fetch from "node-fetch";
import { exec, execSync } from "child_process";
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

/* ------------------ OVERLAY PICKER (LOCAL FILES) ------------------ */

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
    const out = execSync(
      `ffprobe -v error -show_entries format=duration -of csv=p=0 "${file}"`
    ).toString().trim();
    return parseFloat(out);
  } catch {
    return NaN;
  }
}

async function downloadWithRetry(
  url,
  dest,
  { tries = 3, minBytes = 10_000, expectType = "" } = {}
) {
  let lastErr;

  for (let i = 1; i <= tries; i++) {
    try {
      const r = await fetch(url, { redirect: "follow" });
      if (!r.ok) throw new Error(`HTTP ${r.status}`);

      const ct = (r.headers.get("content-type") || "").toLowerCase();
      const buf = Buffer.from(await r.arrayBuffer());

      if (buf.length < minBytes) throw new Error(`Too small (${buf.length})`);
      if (ct.includes("text/html") || ct.includes("application/json"))
        throw new Error(`Bad content-type: ${ct}`);
      if (expectType && !ct.includes(expectType))
        throw new Error(`Unexpected content-type: ${ct}`);

      fs.writeFileSync(dest, buf);
      return;
    } catch (e) {
      lastErr = e;
      await new Promise(r => setTimeout(r, 250 * i));
    }
  }

  throw lastErr;
}

function runFfmpeg(cmd) {
  return new Promise((resolve, reject) => {
    exec(cmd, { maxBuffer: 1024 * 1024 * 80 }, (err, stdout, stderr) => {
      if (err) return reject({ err, stderr });
      resolve();
    });
  });
}

/* ------------------ RENDER ------------------ */

app.post("/render", async (req, res) => {
  try {
    const { videoId, images, audioUrl, format, theme } = req.body;

    if (!videoId || !Array.isArray(images) || !images.length || !audioUrl) {
      return res.status(400).json({ error: "Missing inputs" });
    }

    const dir = `/tmp/${videoId}`;
    fs.mkdirSync(dir, { recursive: true });

    /* ---------- IMAGES ---------- */
    for (let i = 0; i < images.length; i++) {
      await downloadWithRetry(images[i], `${dir}/img${i}.jpg`, {
        expectType: "image",
        minBytes: 8000
      });
    }

    /* ---------- AUDIO ---------- */
    await downloadWithRetry(audioUrl, `${dir}/audio.wav`, {
      expectType: "audio",
      minBytes: 20_000
    });

    const audioDuration = ffprobeDuration(`${dir}/audio.wav`);
    if (!isFinite(audioDuration)) {
      return res.status(400).json({ error: "Invalid narration audio" });
    }

    const perImage = Math.max(audioDuration / images.length, 3);
    const size = format === "9:16" ? "1080:1920" : "1920:1080";
    const [W, H] = size.split(":");

    /* ---------- AMBIENCE (REMOTE) ---------- */
    let ambienceInput = "";
    let useAmbience = false;

    const ambienceFile = pickAmbienceFilename(theme);
    if (ambienceFile && process.env.ASSET_BASE_URL) {
      try {
        const ambPath = `${dir}/amb.wav`;
        await downloadWithRetry(
          `${process.env.ASSET_BASE_URL}/ambience/${ambienceFile}`,
          ambPath,
          { expectType: "audio", minBytes: 20_000 }
        );
        ambienceInput = ` -stream_loop -1 -i "${ambPath}"`;
        useAmbience = true;
      } catch {
        useAmbience = false;
      }
    }

    /* ---------- OVERLAY (LOCAL, FIXED) ---------- */
    let overlayInput = "";
    let useOverlay = false;
    let ovPath = null;

    const overlayPath = pickOverlayPath(format);
    if (overlayPath) {
      ovPath = overlayPath;
      overlayInput = ` -i "${ovPath}"`;
      useOverlay = true;
    }

    /* ---------- INPUTS ---------- */
    const imageInputs = images
      .map((_, i) => `-loop 1 -t ${perImage} -i "${dir}/img${i}.jpg"`)
      .join(" ");

    const inputs =
      imageInputs +
      ` -i "${dir}/audio.wav"` +
      ambienceInput +
      overlayInput;

    /* ---------- FILTER GRAPH ---------- */
    const filters = images.map(
      (_, i) =>
        `[${i}:v]scale=${W}:${H}:force_original_aspect_ratio=increase,crop=${W}:${H},setpts=PTS-STARTPTS[v${i}]`
    );

    const concat = images.map((_, i) => `[v${i}]`).join("");

    let filter =
      `${filters.join(";")};` +
      `${concat}concat=n=${images.length}:v=1:a=0[vbase]`;

    if (useOverlay) {
      const overlayIndex = images.length + 1 + (useAmbience ? 1 : 0);

      filter +=
        `;[vbase]format=rgba[base]` +
        `;[${overlayIndex}:v]scale=${W}:${H},format=rgba,colorchannelmixer=aa=0.15[fx]` +
        `;[base][fx]overlay=shortest=1,format=yuv420p[v]`;
    } else {
      filter += `;[vbase]format=yuv420p[v]`;
    }

    if (useAmbience) {
      filter +=
        `;[${images.length + 1}:a]volume=0.2[amb]` +
        `;[${images.length}:a][amb]amix=inputs=2:duration=first[a]`;
    } else {
      filter += `;[${images.length}:a]anull[a]`;
    }

    /* ---------- EXEC ---------- */
    const out = `${dir}/out.mp4`;

    const cmd =
      `ffmpeg -y ${inputs} ` +
      `-filter_complex "${filter}" ` +
      `-map "[v]" -map "[a]" -shortest -r 30 ` +
      `-c:v libx264 -preset veryfast -crf 28 -pix_fmt yuv420p ` +
      `-movflags +faststart -c:a aac -b:a 128k "${out}"`;

    console.log("🎬 ffmpeg:", cmd);
    await runFfmpeg(cmd);

    res.setHeader("Content-Type", "video/mp4");
    res.send(fs.readFileSync(out));

  } catch (e) {
    console.error("🔥 Server crash:", e);
    res.status(500).json({ error: "Server crash", details: String(e) });
  }
});

app.listen(8080, "0.0.0.0");
