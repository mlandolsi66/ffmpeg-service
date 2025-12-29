/* ------------------ AMBIENCE (THEME-BASED WITH RANDOM SELECTION) ------------------ */
function pickAmbience(theme = "") {
  const ambienceDir = path.join(__dirname, "ambience");
  
  if (!fs.existsSync(ambienceDir)) {
    console.warn("⚠️ Ambience directory not found");
    return null;
  }

  const t = String(theme).toLowerCase();
  let ambiencePrefixes = []; // Array of possible prefixes

  // Map theme to ambience prefixes (with fallbacks)
  if (t.includes("ocean") || t.includes("water") || t.includes("sea")) {
    ambiencePrefixes = ["waves", "underwater", "ocean"];
  } else if (t.includes("space") || t.includes("bedtime journey")) {
    ambiencePrefixes = ["space-ambience", "whitenoise-space", "space"];
  } else if (t.includes("forest") || t.includes("magic forest")) {
    ambiencePrefixes = ["forest-ambience", "forest"];
  } else if (t.includes("dino") || t.includes("explorer")) {
    ambiencePrefixes = ["dino", "adventure"];
  } else if (t.includes("fairy") || t.includes("garden")) {
    ambiencePrefixes = ["fairy", "garden"];
  } else if (t.includes("princess") || t.includes("star dreams")) {
    ambiencePrefixes = ["princess-ambience", "music-box", "princess"];
  } else if (t.includes("birthday") || t.includes("celebration")) {
    ambiencePrefixes = ["birthday-ambience", "birthday", "celebration"];
  } else {
    ambiencePrefixes = ["lullaby"]; // Default
  }

  // Get all audio files matching ANY of the prefixes
  const matchingAudio = fs.readdirSync(ambienceDir)
    .filter(f => {
      if (!f.endsWith(".wav") && !f.endsWith(".mp3")) return false;
      const lowerName = f.toLowerCase();
      return ambiencePrefixes.some(prefix => lowerName.startsWith(prefix));
    });

  if (matchingAudio.length === 0) {
    console.log(`⚠️ No ambience found for "${ambiencePrefixes.join('/')}", using fallback`);
    
    // Fallback to lullaby.wav or any available audio
    if (fs.existsSync(path.join(ambienceDir, "lullaby.wav"))) {
      console.log(`🎧 Using fallback: lullaby.wav`);
      return path.join(ambienceDir, "lullaby.wav");
    }
    
    const allAudio = fs.readdirSync(ambienceDir).filter(f => f.endsWith(".wav") || f.endsWith(".mp3"));
    if (allAudio.length === 0) return null;
    
    const fallback = allAudio[0];
    console.log(`🎧 Using fallback: ${fallback}`);
    return path.join(ambienceDir, fallback);
  }

  // RANDOM SELECTION: Pick one of the matching audio files
  const selectedAudio = matchingAudio[Math.floor(Math.random() * matchingAudio.length)];
  const audioPath = path.join(ambienceDir, selectedAudio);

  console.log(`🎧 Using ambience: ${selectedAudio} for theme: "${theme}" (${matchingAudio.length} variant${matchingAudio.length > 1 ? 's' : ''} available)`);
  
  return audioPath;
}

/* ------------------ OVERLAY (THEME-BASED WITH RANDOM SELECTION) ------------------ */
function pickOverlay(format, theme = "") {
  const base = path.join(__dirname, "overlays");
  const dir = format === "9:16" ? path.join(base, "9x16") : path.join(base, "16x9");

  if (!fs.existsSync(dir)) {
    console.log("⚠️ Overlay dir missing:", dir);
    return null;
  }

  const t = String(theme).toLowerCase();
  let overlayPrefixes = []; // Array of possible prefixes

  // Map theme to overlay prefixes (with fallbacks)
  if (t.includes("ocean") || t.includes("water") || t.includes("sea")) {
    overlayPrefixes = ["ocean", "blue-pink", "sparkles"];
  } else if (t.includes("space") || t.includes("bedtime journey")) {
    overlayPrefixes = ["space_stars", "space", "lights"];
  } else if (t.includes("forest") || t.includes("magic forest")) {
    overlayPrefixes = ["forest"];
  } else if (t.includes("dino") || t.includes("explorer")) {
    overlayPrefixes = ["dino_leaves", "dino"];
  } else if (t.includes("fairy") || t.includes("garden")) {
    overlayPrefixes = ["fairy"];
  } else if (t.includes("princess") || t.includes("star dreams")) {
    overlayPrefixes = ["princess"];
  } else if (t.includes("birthday") || t.includes("celebration")) {
    overlayPrefixes = ["birthday"];
  } else {
    overlayPrefixes = ["bokeh", "dust"]; // Default fallback
  }

  // Get all overlays matching ANY of the prefixes
  const matchingOverlays = fs.readdirSync(dir)
    .filter(f => {
      if (!f.endsWith(".mp4")) return false;
      const lowerName = f.toLowerCase();
      return overlayPrefixes.some(prefix => lowerName.startsWith(prefix));
    });

  if (matchingOverlays.length === 0) {
    console.log(`⚠️ No overlays found for "${overlayPrefixes.join('/')}", using fallback`);
    
    // Fallback to any available overlay
    const allOverlays = fs.readdirSync(dir).filter(f => f.endsWith(".mp4"));
    if (allOverlays.length === 0) return null;
    
    const fallback = allOverlays[Math.floor(Math.random() * allOverlays.length)];
    console.log(`🎞 Using fallback overlay: ${fallback}`);
    return path.join(dir, fallback);
  }

  // RANDOM SELECTION: Pick one of the matching overlays
  const selectedOverlay = matchingOverlays[Math.floor(Math.random() * matchingOverlays.length)];
  const overlayPath = path.join(dir, selectedOverlay);

  console.log(`🎞 Using ${format} overlay: ${selectedOverlay} for theme: "${theme}" (${matchingOverlays.length} variant${matchingOverlays.length > 1 ? 's' : ''} available)`);
  
  return overlayPath;
}
