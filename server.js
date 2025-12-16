import express from "express";
import fetch from "node-fetch";
import { exec } from "child_process";
import fs from "fs";

const app = express();
app.use(express.json({ limit: "50mb" }));

app.post("/render", async (req, res) => {
  try {
    const { videoId, images, audioUrl, format } = req.body;

    if (!videoId || !images?.length || !audioUrl) {
      return res.status(400).json({ error: "Missing videoId, images or audio" });
    }

    const dir = `/tmp/${videoId}`;
    fs.mkdirSync(dir, { recursive: true });

    // 1) Download images
    for (let i = 0; i < images.length; i++) {
      const r = await fetch(images[i]);
      if (!r.ok) return res.status(400).json({ error: `Failed to download image ${i}` });
      const b = await r.arrayBuffer();
      fs.writeFileSync(`${dir}/img${i}.jpg`, Buffer.from(b));
    }

    // 2) Download audio (WAV)
    const ar = await fetch(audioUrl);
    if (!ar.ok) return res.status(400).json({ error: "Failed to download audio" });
    const ab = await ar.arrayBuffer();
    fs.writeFileSync(`${dir}/audio.wav`, Buffer.from(ab));

    // 3) Video settings
    const scaleSize = format === "9:16" ? "1080:1920" : "1920:1080";
    const zoomSize = format === "9:16" ? "1080x1920" : "1920x1080";
    const out = `${dir}/out.mp4`;

    // 4) Inputs (each image 6s)
    // NOTE: keep your behavior the same (6s per image)
    const inputs = images
      .map((_, i) => `-loop 1 -t 6 -i ${dir}/img${i}.jpg`)
      .join(" ");

    // 5) Filter graph — SAFE Ken Burns (pan + zoom) with PTS reset per segment
    // d=180 at 30fps => 6 seconds
    // Progress p goes 0..1 deterministically: on/(d-1)
    const d = 180;
    const p = `(on/${d - 1})`;

    const motions = [
      // Pan L -> R (centered vertically)
      `zoompan=z='min(zoom+0.00045,1.08)':x='(iw-iw/zoom)*${p}':y='(ih-ih/zoom)*0.50'`,

      // Pan R -> L
      `zoompan=z='min(zoom+0.00045,1.08)':x='(iw-iw/zoom)*(1-${p})':y='(ih-ih/zoom)*0.50'`,

      // Pan T -> B (centered horizontally)
      `zoompan=z='min(zoom+0.00045,1.08)':x='(iw-iw/zoom)*0.50':y='(ih-ih/zoom)*${p}'`,

      // Pan B -> T
      `zoompan=z='min(zoom+0.00045,1.08)':x='(iw-iw/zoom)*0.50':y='(ih-ih/zoom)*(1-${p})'`,

      // Gentle diagonal ↘
      `zoompan=z='min(zoom+0.00040,1.075)':x='(iw-iw/zoom)*${p}':y='(ih-ih/zoom)*${p}'`,

      // Gentle diagonal ↖
      `zoompan=z='min(zoom+0.00040,1.075)':x='(iw-iw/zoom)*(1-${p})':y='(ih-ih/zoom)*(1-${p})'`
    ];

    const filters = images
      .map((_, i) => {
        const motion = motions[i % motions.length];

        return (
          `[${i}:v]` +
          // Ensure we have enough “canvas” for zoom without pixel blowup,
          // then crop to target aspect.
          `scale=${scaleSize}:force_original_aspect_ratio=increase,` +
          `crop=${scaleSize},` +
          // Apply motion, lock duration + fps inside zoompan
          `${motion}:d=${d}:fps=30:s=${zoomSize},` +
          // THIS IS THE CRITICAL PART: reset timestamps so concat works reliably
          `setpts=PTS-STARTPTS` +
          `[v${i}]`
        );
      })
      .join(";");

    const concatInputs = images.map((_, i) => `[v${i}]`).join("");
    const filterComplex =
      `${filters};${concatInputs}concat=n=${images.length}:v=1:a=0[v]`;

    // 6) FFmpeg command (single line)
    const cmd =
      `ffmpeg -y -r 30 ${inputs} ` +
      `-i ${dir}/audio.wav ` +
      `-filter_complex "${filterComplex}" ` +
      `-map "[v]" -map ${images.length}:a ` +
      `-shortest -pix_fmt yuv420p "${out}"`;

    console.log("🎬 Running FFmpeg:", cmd);

    exec(cmd, { maxBuffer: 1024 * 1024 * 20 }, (err, stdout, stderr) => {
      if (stdout) console.log("FFmpeg STDOUT:", stdout);
      if (stderr) console.log("FFmpeg STDERR:", stderr);

      if (err) {
        return res.status(500).json({
          error: "FFmpeg failed",
          details: stderr || err.message
        });
      }

      const videoBuffer = fs.readFileSync(out);
      res.setHeader("Content-Type", "video/mp4");
      res.send(videoBuffer);
    });
  } catch (e) {
    console.error("🔥 Server crash:", e);
    res.status(500).json({ error: "Server crash" });
  }
});

const PORT = process.env.PORT || 8080;
app.listen(PORT, "0.0.0.0", () => {
  console.log(`🎬 FFmpeg service running on 0.0.0.0:${PORT}`);
});
