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
      fs.writeFileSync(`${dir}/img${i}.jpg`, Buffer.from(await r.arrayBuffer()));
    }

    // Download narration
    const ar = await fetch(audioUrl);
    fs.writeFileSync(`${dir}/voice.wav`, Buffer.from(await ar.arrayBuffer()));

    const size = format === "9:16" ? "1080x1920" : "1920x1080";

    // Create concat file
    let concatTxt = "";
    for (let i = 0; i < images.length; i++) {
      concatTxt += `file '${dir}/img${i}.jpg'\n`;
      concatTxt += `duration 6\n`;
    }
    concatTxt += `file '${dir}/img${images.length - 1}.jpg'\n`;

    fs.writeFileSync(`${dir}/list.txt`, concatTxt);

    const out = `${dir}/out.mp4`;

    const cmd = `
ffmpeg -y
-f concat -safe 0 -i ${dir}/list.txt
-i ${dir}/voice.wav
-vf "scale=${size}:force_original_aspect_ratio=increase,crop=${size}"
-r 30
-shortest
-pix_fmt yuv420p
${out}
`.replace(/\n/g, " ");

    console.log("🎬 FFmpeg start");

    exec(cmd, { maxBuffer: 1024 * 1024 * 10 }, (err) => {
      if (err) {
        console.error("❌ FFmpeg failed", err);
        return res.status(500).json({ error: "FFmpeg failed" });
      }

      console.log("✅ FFmpeg done");

      res.setHeader("Content-Type", "video/mp4");
      res.send(fs.readFileSync(out));
    });

  } catch (e) {
    console.error("🔥 server crash", e);
    res.status(500).json({ error: "server crash" });
  }
});

app.listen(8080, "0.0.0.0", () => {
  console.log("🎬 FFmpeg service running");
});
