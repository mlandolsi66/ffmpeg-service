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
      return res.status(400).json({ error: "missing inputs" });
    }

    const dir = `/tmp/${videoId}`;
    fs.mkdirSync(dir, { recursive: true });

    // Download images
    for (let i = 0; i < images.length; i++) {
      const r = await fetch(images[i]);
      if (!r.ok) return res.status(400).json({ error: `image download failed ${i}` });
      fs.writeFileSync(`${dir}/img${i}.jpg`, Buffer.from(await r.arrayBuffer()));
    }

    // Download narration
    const ar = await fetch(audioUrl);
    if (!ar.ok) return res.status(400).json({ error: "audio download failed" });
    fs.writeFileSync(`${dir}/voice.wav`, Buffer.from(await ar.arrayBuffer()));

    // Target size (NOTE: FFmpeg filters use ":" not "x")
    const W = format === "9:16" ? 1080 : 1920;
    const H = format === "9:16" ? 1920 : 1080;

    // Concat list
    const sceneSeconds = 6;
    let concatTxt = "";
    for (let i = 0; i < images.length; i++) {
      concatTxt += `file '${dir}/img${i}.jpg'\n`;
      concatTxt += `duration ${sceneSeconds}\n`;
    }
    // repeat last file (concat demuxer requirement)
    concatTxt += `file '${dir}/img${images.length - 1}.jpg'\n`;
    fs.writeFileSync(`${dir}/list.txt`, concatTxt);

    const out = `${dir}/out.mp4`;

    // FFmpeg (simple, fast, deterministic)
    const cmd =
      `ffmpeg -y -hide_banner -loglevel error ` +
      `-f concat -safe 0 -i ${dir}/list.txt ` +
      `-i ${dir}/voice.wav ` +
      `-vf "scale=${W}:${H}:force_original_aspect_ratio=increase,crop=${W}:${H}" ` +
      `-r 30 -shortest -pix_fmt yuv420p ` +
      `"${out}"`;

    exec(cmd, { maxBuffer: 1024 * 1024 * 30 }, (err, stdout, stderr) => {
      if (err) {
        return res.status(500).json({
          error: "FFmpeg failed",
          stderr: (stderr || err.message || "").slice(-8000)
        });
      }

      const buf = fs.readFileSync(out);
      res.setHeader("Content-Type", "video/mp4");
      res.send(buf);
    });

  } catch (e) {
    res.status(500).json({ error: "server crash", details: String(e?.message || e) });
  }
});

app.listen(8080, "0.0.0.0", () => {
  console.log("🎬 FFmpeg service running on 8080");
});
