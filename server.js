import express from "express";
import fetch from "node-fetch";
import { exec, execSync } from "child_process";
import fs from "fs";
import { createClient } from "@supabase/supabase-js";

const app = express();
app.use(express.json({ limit: "50mb" }));

/* ---------------- SUPABASE (STORAGE ONLY) ---------------- */

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);

/* ---------------- HELPERS ---------------- */

function ffprobeOk(path) {
  try {
    execSync(`ffprobe -v error "${path}"`, { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

function ffprobeDuration(path) {
  const d = execSync(
    `ffprobe -v error -show_entries format=duration -of csv=p=0 "${path}"`
  )
    .toString()
    .trim();
  return parseFloat(d) || 0;
}

/* ---------------- RENDER ---------------- */

app.post("/render", async (req, res) => {
  try {
    const { videoId, images, audioUrl, format } = req.body;
    if (!videoId || !images?.length || !audioUrl) {
      return res.status(400).json({ error: "missing inputs" });
    }

    const dir = `/tmp/${videoId}`;
    fs.mkdirSync(dir, { recursive: true });

    /* ---------- images ---------- */
    for (let i = 0; i < images.length; i++) {
      const r = await fetch(images[i]);
      fs.writeFileSync(`${dir}/img${i}.jpg`, Buffer.from(await r.arrayBuffer()));
      if (!ffprobeOk(`${dir}/img${i}.jpg`)) {
        return res.status(400).json({ error: "bad image" });
      }
    }

    /* ---------- audio ---------- */
    const ar = await fetch(audioUrl);
    fs.writeFileSync(`${dir}/audio.wav`, Buffer.from(await ar.arrayBuffer()));

    const audioDuration = ffprobeDuration(`${dir}/audio.wav`);
    if (audioDuration < 1) {
      return res.status(400).json({ error: "bad audio duration" });
    }

    const fps = 30;
    const perImage = Math.max(audioDuration / images.length, 0.8);
    const frames = Math.round(perImage * fps);

    const size = format === "9:16" ? "1080:1920" : "1920:1080";
    const [W, H] = size.split(":");

    /* ---------- inputs ---------- */
    const imageInputs = images
      .map((_, i) => `-loop 1 -i "${dir}/img${i}.jpg"`)
      .join(" ");

    const inputs = `${imageInputs} -i "${dir}/audio.wav"`;

    /* ---------- soft zoom (Ken Burns) ---------- */
    const zoomExpr = "min(zoom+0.0015,1.06)";

    const vFilters = images
      .map(
        (_, i) =>
          `[${i}:v]scale=${W}:${H}:force_original_aspect_ratio=increase,crop=${W}:${H},` +
          `zoompan=z='if(lte(on,1),1.0,${zoomExpr})':d=${frames}:s=${W}x${H}:fps=${fps},` +
          `format=yuv420p[v${i}]`
      )
      .join(";");

    const concat = images.map((_, i) => `[v${i}]`).join("");

    const filter =
      `${vFilters};` +
      `${concat}concat=n=${images.length}:v=1:a=0[v];`;

    const out = `${dir}/out.mp4`;

    const cmd =
      `ffmpeg -y ${inputs} ` +
      `-filter_complex "${filter}" ` +
      `-map "[v]" -map ${images.length}:a ` +
      `-shortest -r ${fps} ` +
      `-c:v libx264 -preset veryfast -crf 28 -pix_fmt yuv420p -movflags +faststart ` +
      `-c:a aac -b:a 128k "${out}"`;

    exec(cmd, async (err) => {
      if (err || !fs.existsSync(out)) {
        return res.status(500).json({ error: "ffmpeg failed" });
      }

      /* ---------- upload to storage ---------- */
      const buffer = fs.readFileSync(out);
      const path = `final/${videoId}.mp4`;

      const { error: uploadErr } = await supabase.storage
        .from("videos")
        .upload(path, buffer, { contentType: "video/mp4", upsert: true });

      if (uploadErr) {
        return res.status(500).json({ error: "upload failed" });
      }

      const { data } = supabase.storage.from("videos").getPublicUrl(path);

      /* ✅ RETURN URL ONLY */
      return res.json({ video_url: data.publicUrl });
    });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: "server crash" });
  }
});

app.listen(8080, "0.0.0.0");
