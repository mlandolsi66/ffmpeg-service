import express from "express";
import fetch from "node-fetch";
import { execSync } from "child_process";
import fs from "fs";
import path from "path";

const app = express();
app.use(express.json({ limit: "50mb" }));

/* ------------------ HELPERS ------------------ */

async function downloadWithRetry(url, dest, { tries = 3, minBytes = 10_000, expectType = "" } = {}) {
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
      await new Promise(r => setTimeout(r, 300 * i));
    }
  }
  throw lastErr;
}

function ffprobeDuration(file) {
  try {
    return parseFloat(
      execSync(
        `ffprobe -v error -show_entries format=duration -of csv=p=0 "${file}"`
      ).toString().trim()
    );
  } catch {
    return NaN;
  }
}

function ffprobeOk(file) {
  try {
    execSync(`ffprobe -v error "${file}"`);
    return true;
  } catch {
    return false;
  }
}

/* ------------------ ASSET PICKERS ------------------ */

function pickOverlayPath(format) {
  const base = format === "9:16" ? "overlays/9x16" : "overlays/16x9";
  if (!fs.existsSync(base)) return null;

  const files = fs.readdirSync(base).filter(f => f.endsWith(".mp4"));
  if (!files.length) return null;

  return path.join(base, files[Math.floor(Math.random() * files.length)]);
}

function pickAmbiencePath(theme) {
  theme = String(theme || "").toLowerCase();
  if (theme.includes("ocean")) return "ambience/waves.wav";
  if (theme.includes("space")) return "ambience/whitenoise-space.wav";
  return null;
}

/* ------------------ RENDER ------------------ */

app.post("/render", async (req, res) => {
  const { videoId, images, audioUrl, format, theme } = req.body;

  if (!videoId || !Array.isArray(images) || !images.length || !audioUrl) {
    return res.status(400).json({ error: "Missing inputs" });
  }

  const dir = `/tmp/${videoId}`;
  fs.mkdirSync(dir, { recursive: true });

  try {
    /* ---------- DOWNLOAD IMAGES ---------- */
    for (let i = 0; i < images.length; i++) {
      await downloadWithRetry(images[i], `${dir}/img${i}.jpg`, {
        expectType: "image",
        minBytes: 8000
      });
    }

    /* ---------- NARRATION ---------- */
    await downloadWithRetry(audioUrl, `${dir}/audio.wav`, {
      expectType: "audio",
      minBytes: 20_000
    });

    if (!ffprobeOk(`${dir}/audio.wav`)) {
      throw new Error("Narration audio invalid");
    }

    const audioDuration = ffprobeDuration(`${dir}/audio.wav`);
    if (!audioDuration || !isFinite(audioDuration)) {
      throw new Error("Invalid narration duration");
    }

    const size = format === "9:16" ? "1080:1920" : "1920:1080";
    const [W, H] = size.split(":");

    /* ---------- OPTIONAL AMBIENCE (LOCAL) ---------- */
    let ambienceInput = "";
    let useAmbience = false;

    const ambiencePath = pickAmbiencePath(theme);
    if (ambiencePath && fs.existsSync(ambiencePath) && ffprobeOk(ambiencePath)) {
      ambienceInput = ` -stream_loop -1 -i "${ambiencePath}"`;
      useAmbience = true;
    }

    /* ---------- OPTIONAL OVERLAY (LOCAL) ---------- */
    let overlayInput = "";
    let useOverlay = false;

    const overlayPath = pickOverlayPath(format);
    if (overlayPath && fs.existsSync(overlayPath) && ffprobeOk(overlayPath)) {
      overlayInput = ` -stream_loop -1 -i "${overlayPath}"`;
      useOverlay = true;
    }

    /* ---------- INPUTS ---------- */
    const imageInputs = images
      .map((_, i) => `-loop 1 -i "${dir}/img${i}.jpg"`)
      .join(" ");

    const inputs =
      imageInputs +
      ` -i "${dir}/audio.wav"` +
      ambienceInput +
      overlayInput;

    /* ---------- FILTER GRAPH (CORRECT & SAFE) ---------- */

    const imageFilters = images.map(
      (_, i) =>
        `[${i}:v]scale=${W}:${H}:force_original_aspect_ratio=increase,` +
        `crop=${W}:${H},fps=30,setpts=PTS-STARTPTS[v${i}]`
    );

    const concatInputs = images.map((_, i) => `[v${i}]`).join("");

    let filter =
      `${imageFilters.join(";")};` +
      `${concatInputs}concat=n=${images.length}:v=1:a=0,` +
      `setpts=PTS-STARTPTS,trim=duration=${audioDuration}[vbase]`;

    if (useOverlay) {
      const overlayIndex = images.length + 1 + (useAmbience ? 1 : 0);
      filter +=
        `;[${overlayIndex}:v]fps=30,setpts=PTS-STARTPTS[fx]` +
        `;[vbase][fx]overlay=shortest=1[v]`;
    } else {
      filter += `;[vbase]format=yuv420p[v]`;
    }

    if (useAmbience) {
      filter +=
        `;[${images.length}:a][${images.length + 1}:a]amix=inputs=2:duration=first[a]`;
    } else {
      filter += `;[${images.length}:a]anull[a]`;
    }

    /* ---------- EXEC ---------- */

    const cmd =
      `ffmpeg -y ${inputs} ` +
      `-filter_complex "${filter}" ` +
      `-map "[v]" -map "[a]" -shortest ` +
      `-c:v libx264 -preset veryfast -crf 28 -pix_fmt yuv420p ` +
      `-c:a aac -b:a 128k "${dir}/out.mp4"`;

    execSync(cmd, { stdio: "inherit" });

    res.setHeader("Content-Type", "video/mp4");
    res.send(fs.readFileSync(`${dir}/out.mp4`));

  } catch (e) {
    console.error("🔥 render failed:", e);
    res.status(500).json({ error: "Render failed", details: String(e.message || e) });
  }
});

app.listen(8080, "0.0.0.0");
