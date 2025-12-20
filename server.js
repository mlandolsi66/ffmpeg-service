import express from "express";
import fetch from "node-fetch";
import { exec } from "child_process";
import fs from "fs";

const app = express();
app.use(express.json({ limit: "50mb" }));

/* ------------------ HELPERS ------------------ */

function sleep(ms) {
  return new Promise(r => setTimeout(r, ms));
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
      await sleep(250 * i);
    }
  }
  throw lastErr;
}

function ffprobeDuration(file) {
  try {
    const { execSync } = await import("child_process");
    return parseFloat(
      execSync(
        `ffprobe -v error -show_entries format=duration -of csv=p=0 "${file}"`
      ).toString().trim()
    );
  } catch {
    return NaN;
  }
}

function run(cmd) {
  return new Promise((resolve, reject) => {
    exec(cmd, { maxBuffer: 1024 * 1024 * 80 }, (err, stdout, stderr) => {
      if (err) reject(stderr || err);
      else resolve();
    });
  });
}

/* ------------------ PICKERS ------------------ */

function pickAmbienceFilename(theme) {
  const t = String(theme || "").toLowerCase();
  if (t.includes("ocean")) return "waves.wav";
  if (t.includes("space")) return "whitenoise-space.wav";
  return null;
}

function pickOverlayFilename(format) {
  return format === "9:16" ? "bokeh_ready.mp4" : "magic.mp4";
}

/* ------------------ RENDER ------------------ */

app.post("/render", async (req, res) => {
  const { videoId, images, audioUrl, format, theme } = req.body;

  if (!videoId || !images?.length || !audioUrl) {
    return res.status(400).json({ error: "Missing inputs" });
  }

  const dir = `/tmp/${videoId}`;
  fs.mkdirSync(dir, { recursive: true });

  try {
    /* ---------- IMAGES ---------- */
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

    const audioDuration = ffprobeDuration(`${dir}/audio.wav`);
    if (!audioDuration || !isFinite(audioDuration)) {
      throw new Error("Invalid narration");
    }

    const perImage = Math.max(audioDuration / images.length, 3);
    const size = format === "9:16" ? "1080:1920" : "1920:1080";
    const [W, H] = size.split(":");

    /* ---------- AMBIENCE (REMOTE ONLY) ---------- */
    let ambienceInput = "";
    let useAmbience = false;

    const amb = pickAmbienceFilename(theme);
    if (amb && process.env.ASSET_BASE_URL) {
      try {
        await downloadWithRetry(
          `${process.env.ASSET_BASE_URL}/ambience/${amb}`,
          `${dir}/amb.wav`,
          { expectType: "audio", minBytes: 20_000 }
        );
        ambienceInput = ` -stream_loop -1 -i "${dir}/amb.wav"`;
        useAmbience = true;
      } catch {
        useAmbience = false;
      }
    }

    /* ---------- OVERLAY (LOCAL, PRE-NORMALIZED) ---------- */
    let overlayInput = "";
    let useOverlay = false;

    const overlayPath = `overlays/${format === "9:16" ? "9x16" : "16x9"}/${pickOverlayFilename(format)}`;
    if (fs.existsSync(overlayPath)) {
      overlayInput = ` -stream_loop -1 -i "${overlayPath}"`;
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

    /* ---------- FILTER GRAPH (SIMPLE + SAFE) ---------- */
    const imageFilters = images.map(
      (_, i) =>
        `[${i}:v]scale=${W}:${H}:force_original_aspect_ratio=increase,crop=${W}:${H},setpts=PTS-STARTPTS[v${i}]`
    );

    let filter =
      `${imageFilters.join(";")};` +
      `${images.map((_, i) => `[v${i}]`).join("")}concat=n=${images.length}:v=1:a=0,format=yuv420p[vbase]`;

    if (useOverlay) {
      const ovIdx = images.length + 1 + (useAmbience ? 1 : 0);
      filter +=
        `;[${ovIdx}:v]fps=30,format=rgba[fx]` +
        `;[vbase][fx]overlay=shortest=1[v]`;
    } else {
      filter += `;[vbase]copy[v]`;
    }

    if (useAmbience) {
      filter +=
        `;[${images.length}:a][${images.length + 1}:a]amix=inputs=2:duration=first[a]`;
    } else {
      filter += `;[${images.length}:a]anull[a]`;
    }

    /* ---------- EXEC ---------- */
    const out = `${dir}/out.mp4`;

    const cmd =
      `ffmpeg -y ${inputs} ` +
      `-filter_complex "${filter}" ` +
      `-map "[v]" -map "[a]" -shortest ` +
      `-c:v libx264 -preset veryfast -crf 28 -pix_fmt yuv420p ` +
      `-c:a aac -b:a 128k "${out}"`;

    console.log("🎬 ffmpeg:", cmd);
    await run(cmd);

    res.setHeader("Content-Type", "video/mp4");
    res.send(fs.readFileSync(out));

  } catch (e) {
    console.error("🔥 render failed:", e);
    res.status(500).json({ error: "Render failed", details: String(e) });
  }
});

app.listen(8080, "0.0.0.0");
