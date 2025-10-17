// 




process.env.NODE_TLS_REJECT_UNAUTHORIZED = "0"; // ⚠️ local/dev only

const fs = require("fs");
require("dotenv").config();

const FIGMA_TOKEN = process.env.FIGMA_TOKEN;
const FILE_KEY = process.env.FIGMA_FILE_KEY;
const OUTPUT_DIR = "./out";

// ---- TUNABLES ----
const TARGET_FRAME_WIDTH = 1200;
const PAGE_MARGIN = 32;
const MAX_DEPTH = 50;

// Helpers
const clamp = (n, lo, hi) => Math.max(lo, Math.min(hi, n));
const rgbFromFigmaColor = (c, opacity = 1) => {
  const a = (c?.a ?? 1) * opacity;
  return a < 1
    ? `rgba(${Math.round((c?.r ?? 0) * 255)}, ${Math.round((c?.g ?? 0) * 255)}, ${Math.round((c?.b ?? 0) * 255)}, ${a.toFixed(3)})`
    : `rgb(${Math.round((c?.r ?? 0) * 255)}, ${Math.round((c?.g ?? 0) * 255)}, ${Math.round((c?.b ?? 0) * 255)})`;
};

// --- Fetch JSON from Figma ---
async function fetchJson(url) {
  const fetch = (await import("node-fetch")).default;
  const res = await fetch(url, { headers: { "X-Figma-Token": FIGMA_TOKEN } });
  if (!res.ok) throw new Error(`Figma API error ${res.status}: ${await res.text()}`);
  return res.json();
}

async function fetchFigmaFile() {
  console.log("Fetching Figma file JSON…");
  return fetchJson(`https://api.figma.com/v1/files/${FILE_KEY}`);
}

// Batch fetch images
const imageCache = new Map();
async function fetchImages(nodeIds) {
  if (nodeIds.length === 0) return;
  
  const uncached = nodeIds.filter(id => !imageCache.has(id));
  if (uncached.length === 0) return;
  
  console.log(`Fetching ${uncached.length} images...`);
  const ids = uncached.join(",");
  try {
    const data = await fetchJson(
      `https://api.figma.com/v1/images/${FILE_KEY}?ids=${encodeURIComponent(ids)}&scale=2&format=png`
    );
    for (const [id, url] of Object.entries(data.images || {})) {
      if (url) imageCache.set(id, url);
    }
  } catch (err) {
    console.warn("Image fetch failed:", err.message);
  }
}

// Collect all fonts used in document
function collectFonts(node, fontsSet) {
  if (node.type === "TEXT" && node.style?.fontFamily) {
    fontsSet.add(node.style.fontFamily);
  }
  if (node.children) {
    for (const child of node.children) {
      collectFonts(child, fontsSet);
    }
  }
}

// Collect all nodes that need images
function collectImageNodes(node, result = []) {
  if (node.fills?.some(f => f.type === "IMAGE" && f.visible !== false)) {
    result.push(node.id);
  }
  if (node.children) {
    for (const child of node.children) {
      collectImageNodes(child, result);
    }
  }
  return result;
}

// --- Core export ---
async function extractHtmlAndCss(figma) {
  const pages = figma.document?.children || [];
  
  // Collect all unique fonts used in the document
  const fontsUsed = new Set();
  collectFonts(figma.document, fontsUsed);
  
  // Generate Google Fonts link for all fonts
  const fontFamilies = Array.from(fontsUsed).map(f => {
    const family = f.split(':')[0];
    return `family=${encodeURIComponent(family)}:ital,wght@0,100;0,200;0,300;0,400;0,500;0,600;0,700;0,800;0,900;1,100;1,200;1,300;1,400;1,500;1,600;1,700;1,800;1,900`;
  }).join('&');
  
  const googleFontsUrl = fontsUsed.size > 0 
    ? `https://fonts.googleapis.com/css2?${fontFamilies}&display=swap`
    : 'https://fonts.googleapis.com/css2?family=Inter:wght@100;200;300;400;500;600;700;800;900&display=swap';

  let html = `<!doctype html>
<html>
<head>
  <meta charset="utf-8"/>
  <meta name="viewport" content="width=device-width, initial-scale=1"/>
  <title>Figma Export</title>
  <link href="${googleFontsUrl}" rel="stylesheet">
  <link rel="stylesheet" href="styles.css"/>
</head>
<body>
<div class="page">
`;

  let css = `
:root { --page-gap: ${PAGE_MARGIN}px; }
* { box-sizing: border-box; }
html, body { margin: 0; padding: 0; }
body { font-family: Inter, Arial, sans-serif; background: #fafafa; color: #111; }
.page { display: flex; flex-direction: column; gap: var(--page-gap); padding: var(--page-gap); }
.frame-container {
  margin: 0 auto;
}
.frame {
  position: relative;
  overflow: hidden;
  border: 1px solid #e6e6e6;
  border-radius: 12px;
  background: #fff;
  box-shadow: 0 1px 2px rgba(0,0,0,0.04);
}
.frame-title { 
  font: 600 14px/1 Inter, system-ui, sans-serif; 
  color: #666; 
  padding: 10px 12px; 
  background: #f9f9f9;
  border-bottom: 1px solid #e6e6e6;
}
.frame-inner { position: relative; }
.text { white-space: pre-wrap; word-wrap: break-word; }
.node { position: absolute; }
`;

  for (const page of pages) {
    const frames = (page.children || []).filter(
      n => n.type === "FRAME" || n.type === "COMPONENT" || n.type === "COMPONENT_SET"
    );
    if (!frames.length) continue;

    html += `<h2 class="page-title" style="font:600 18px/1.2 Inter,system-ui,sans-serif;margin:24px 0 16px 0;color:#333;">${escapeHtml(page.name)}</h2>\n`;

    // Pre-fetch all images for this page
    const imageNodeIds = frames.flatMap(frame => collectImageNodes(frame));
    if (imageNodeIds.length > 0) {
      await fetchImages(imageNodeIds);
    }

    for (const frame of frames) {
      const fbb = frame.absoluteBoundingBox || {};
      const frameW = fbb.width || 1200;
      const frameH = fbb.height || 800;

      const scale = frameW ? TARGET_FRAME_WIDTH / frameW : 1;
      const outW = Math.round(frameW * scale);
      const outH = Math.round(frameH * scale);

      // Frame background
      let frameBg = getBackground(frame, scale);

      const frameClass = `frame-${sanitize(frame.id)}`;
      css += `.${frameClass} { width:${outW}px; height:${outH}px; ${frameBg} }\n`;

      html += `<div class="frame-container">
  <div class="frame-title">${escapeHtml(frame.name)} — ${outW}×${outH}px (${Number((scale * 100).toFixed(1))}%)</div>
  <section class="frame ${frameClass}">
    <div class="frame-inner">
`;

      // Process all children recursively
      const result = await processChildren(frame, frame, scale, 0);
      html += result.html;
      css += result.css;

      html += `    </div>
  </section>
</div>\n`;
    }
  }

  html += `</div>\n</body>\n</html>`;
  return { html, css };
}

// Recursive processor - processes children of a node
async function processChildren(node, rootFrame, scale, depth) {
  if (depth > MAX_DEPTH || !node.children) {
    return { html: "", css: "" };
  }

  let html = "";
  let css = "";

  for (const child of node.children) {
    // Skip invisible nodes
    if (child.visible === false) continue;

    // Render this child
    const result = await renderNode(child, rootFrame, scale);
    html += result.html;
    css += result.css;

    // Recursively process this child's children
    if (child.children && child.children.length > 0) {
      const childResult = await processChildren(child, rootFrame, scale, depth + 1);
      html += childResult.html;
      css += childResult.css;
    }
  }

  return { html, css };
}

async function renderNode(node, rootFrame, scale) {
  const rfbb = rootFrame.absoluteBoundingBox || {};
  const nbb = node.absoluteBoundingBox || {};
  
  const nx = (nbb.x ?? 0) - (rfbb.x ?? 0);
  const ny = (nbb.y ?? 0) - (rfbb.y ?? 0);
  const nw = nbb.width ?? 0;
  const nh = nbb.height ?? 0;

  const left = Math.round(nx * scale);
  const top = Math.round(ny * scale);
  const width = Math.max(0, Math.round(nw * scale));
  const height = Math.max(0, Math.round(nh * scale));
  const opacity = clamp(node.opacity ?? 1, 0, 1);

  let html = "";
  let css = "";
  const cls = `n-${sanitize(node.id)}`;

  // TEXT nodes
  if (node.type === "TEXT") {
    const content = node.characters || "";
    
    // Debug logging
    console.log(`Text node: "${content.substring(0, 30)}..."`);
    console.log(`  Font: ${node.style?.fontFamily}, Weight: ${node.style?.fontWeight}`);
    console.log(`  PostScript: ${node.style?.fontPostScriptName}`);
    console.log(`  Effects:`, node.effects);
    console.log(`  Transform:`, node.relativeTransform);
    
    const textStyles = getTextStyles(node, rootFrame, scale, opacity);
    
    // Check if text has hyperlink
    const linkUrl = node.hyperlink?.url || "";
    
    css += `.${cls} {
  position: absolute;
  left: ${left}px;
  top: ${top}px;
  width: ${width}px;
  min-height: ${height}px;
  ${textStyles}
}\n`;
    
    if (linkUrl) {
      html += `<a href="${escapeHtml(linkUrl)}" class="text node ${cls}" style="text-decoration: underline; cursor: pointer;">${escapeHtml(content)}</a>\n`;
    } else {
      html += `<div class="text node ${cls}">${escapeHtml(content)}</div>\n`;
    }
    return { html, css };
  }

  // Visual nodes (rectangles, ellipses, vectors, etc.)
  const visualTypes = ["RECTANGLE", "ELLIPSE", "POLYGON", "VECTOR", "STAR", "LINE", "BOOLEAN_OPERATION"];
  if (visualTypes.includes(node.type)) {
    const visualStyles = getVisualStyles(node, rootFrame, scale, opacity);
    
    css += `.${cls} {
  position: absolute;
  left: ${left}px;
  top: ${top}px;
  width: ${width}px;
  height: ${height}px;
  ${visualStyles}
}\n`;
    
    html += `<div class="node ${cls}"></div>\n`;
    return { html, css };
  }

  // Container nodes (FRAME, GROUP, COMPONENT, INSTANCE)
  const containerTypes = ["FRAME", "GROUP", "COMPONENT", "INSTANCE", "COMPONENT_SET", "SECTION"];
  if (containerTypes.includes(node.type)) {
    // Only render container div if it has visual properties
    const hasVisuals = (node.fills?.length > 0 && node.fills.some(f => f.visible !== false)) ||
                       (node.effects?.length > 0 && node.effects.some(e => e.visible !== false)) ||
                       (node.strokes?.length > 0 && node.strokes.some(s => s.visible !== false));
    
    if (hasVisuals) {
      const containerStyles = getVisualStyles(node, rootFrame, scale, opacity);
      
      css += `.${cls} {
  position: absolute;
  left: ${left}px;
  top: ${top}px;
  width: ${width}px;
  height: ${height}px;
  ${containerStyles}
}\n`;
      
      html += `<div class="node ${cls}"></div>\n`;
    }
  }

  return { html, css };
}

// Get background styles (fills)
function getBackground(node, scale) {
  const fills = (node.fills || []).filter(f => f.visible !== false);
  if (fills.length === 0) return "background: transparent;";

  const backgrounds = [];
  
  for (const fill of fills) {
    if (fill.type === "SOLID") {
      const color = rgbFromFigmaColor(fill.color, fill.opacity ?? 1);
      return `background: ${color};`;
    } else if (fill.type === "IMAGE") {
      const url = imageCache.get(node.id);
      if (url) {
        return `background: url('${url}'); background-size: cover; background-position: center;`;
      }
    } else if (fill.type === "GRADIENT_LINEAR") {
      const gradient = getLinearGradient(fill);
      return `background: ${gradient};`;
    }
  }

  return "background: transparent;";
}

function getLinearGradient(fill) {
  const stops = (fill.gradientStops || [])
    .map(s => `${rgbFromFigmaColor(s.color)} ${(s.position * 100).toFixed(1)}%`)
    .join(", ");
  
  // Calculate angle from gradient handles
  const h = fill.gradientHandlePositions || [];
  let angle = 90;
  if (h.length >= 2) {
    const dx = h[1].x - h[0].x;
    const dy = h[1].y - h[0].y;
    angle = Math.round((Math.atan2(dy, dx) * 180) / Math.PI + 90);
  }
  
  return `linear-gradient(${angle}deg, ${stops})`;
}

// Get text styles
function getTextStyles(node, rootFrame, scale, opacity) {
  const style = node.style || {};
  const fills = (node.fills || []).filter(f => f.visible !== false);
  
  const fill = fills.find(f => f.type === "SOLID");
  const color = fill ? rgbFromFigmaColor(fill.color, (fill.opacity ?? 1) * opacity) : `rgba(0,0,0,${opacity})`;

  const fontFamily = style.fontFamily || "Inter";
  
  // Parse font weight - handle both numeric and text values
  let fontWeight = 400;
  if (typeof style.fontWeight === 'number') {
    fontWeight = style.fontWeight;
  } else if (typeof style.fontWeight === 'string') {
    const weightMap = {
      'Thin': 100, 'ExtraLight': 200, 'Light': 300, 'Regular': 400, 'Normal': 400,
      'Medium': 500, 'SemiBold': 600, 'Bold': 700, 'ExtraBold': 800, 'Black': 900
    };
    fontWeight = weightMap[style.fontWeight] || 400;
  }
  
  // Check fontPostScriptName for weight indicators
  const postscript = style.fontPostScriptName || '';
  if (postscript.includes('Bold') && fontWeight < 700) fontWeight = 700;
  if (postscript.includes('Black')) fontWeight = 900;
  if (postscript.includes('Heavy')) fontWeight = 900;
  if (postscript.includes('Semibold') || postscript.includes('SemiBold')) fontWeight = 600;
  if (postscript.includes('Medium')) fontWeight = 500;
  if (postscript.includes('Light')) fontWeight = 300;
  if (postscript.includes('Thin')) fontWeight = 100;
  
  const fontSize = Math.round((style.fontSize || 16) * scale);
  const lineHeight = style.lineHeightPx 
    ? `${Math.round(style.lineHeightPx * scale)}px`
    : style.lineHeightPercent 
    ? `${(style.lineHeightPercent / 100).toFixed(2)}`
    : "normal";
  
  const letterSpacing = style.letterSpacing 
    ? `${(style.letterSpacing * scale).toFixed(2)}px` 
    : "normal";
  
  const textAlign = (style.textAlignHorizontal || "LEFT").toLowerCase();
  const textDecoration = style.textDecoration === "UNDERLINE" ? "underline" : "none";
  const fontStyle = postscript.includes("Italic") ? "italic" : "normal";
  
  // Get rotation/transform
  const transform = getTransform(node, rootFrame, scale);
  
  // Get text effects (shadows, etc.)
  const effects = getEffects(node, scale, true); // true = for text

  return `
  color: ${color};
  font-family: '${fontFamily}', Inter, system-ui, sans-serif;
  font-weight: ${fontWeight};
  font-size: ${fontSize}px;
  font-style: ${fontStyle};
  line-height: ${lineHeight};
  letter-spacing: ${letterSpacing};
  text-align: ${textAlign};
  text-decoration: ${textDecoration};
  white-space: pre-wrap;
  word-wrap: break-word;
  ${transform}
  ${effects}
`.trim();
}

// Get visual styles for shapes
function getVisualStyles(node, rootFrame, scale, opacity) {
  const bg = getBackground(node, scale);
  const stroke = getStroke(node, scale, opacity);
  const borderRadius = getCornerRadius(node, scale);
  const effects = getEffects(node, scale, false); // false = not text
  const clipContent = node.clipsContent ? "overflow: hidden;" : "";
  const transform = getTransform(node, rootFrame, scale);

  // Special handling for ellipses
  const isEllipse = node.type === "ELLIPSE";
  const ellipseRadius = isEllipse ? "border-radius: 50%;" : "";

  return `
  ${bg}
  ${stroke}
  opacity: ${opacity};
  ${borderRadius && !isEllipse ? `border-radius: ${borderRadius};` : ""}
  ${ellipseRadius}
  ${transform}
  ${effects}
  ${clipContent}
`.trim();
}

function getStroke(node, scale, opacity) {
  const strokes = (node.strokes || []).filter(s => s.visible !== false);
  if (strokes.length === 0 || !node.strokeWeight) return "";

  const stroke = strokes[0];
  if (stroke.type === "SOLID") {
    const weight = Math.max(1, Math.round((node.strokeWeight || 1) * scale));
    const color = rgbFromFigmaColor(stroke.color, (stroke.opacity ?? 1) * opacity);
    return `border: ${weight}px solid ${color};`;
  }
  return "";
}

function getCornerRadius(node, scale) {
  if (typeof node.cornerRadius === "number" && node.cornerRadius > 0) {
    return `${Math.round(node.cornerRadius * scale)}px`;
  }
  if (Array.isArray(node.rectangleCornerRadii) && node.rectangleCornerRadii.length === 4) {
    const radii = node.rectangleCornerRadii.map(r => Math.round(r * scale));
    if (radii.every(r => r === radii[0])) {
      return `${radii[0]}px`;
    }
    return `${radii[0]}px ${radii[1]}px ${radii[2]}px ${radii[3]}px`;
  }
  return "";
}

function getEffects(node, scale, isText = false) {
  const effects = (node.effects || []).filter(e => e.visible !== false);
  if (effects.length === 0) return "";

  const boxShadows = [];
  const textShadows = [];
  let blur = "";

  for (const effect of effects) {
    if (effect.type === "DROP_SHADOW" || effect.type === "INNER_SHADOW") {
      const x = Math.round((effect.offset?.x || 0) * scale);
      const y = Math.round((effect.offset?.y || 0) * scale);
      const blurRadius = Math.round((effect.radius || 0) * scale);
      const spread = Math.round((effect.spread || 0) * scale);
      const color = rgbFromFigmaColor(effect.color, effect.color?.a ?? 1);
      
      if (isText) {
        // Text shadows don't support spread or inset
        textShadows.push(`${x}px ${y}px ${blurRadius}px ${color}`);
      } else {
        const inset = effect.type === "INNER_SHADOW" ? "inset " : "";
        boxShadows.push(`${inset}${x}px ${y}px ${blurRadius}px ${spread}px ${color}`);
      }
    } else if (effect.type === "LAYER_BLUR") {
      blur = `filter: blur(${Math.round((effect.radius || 0) * scale)}px);`;
    }
  }

  if (isText && textShadows.length > 0) {
    return `text-shadow: ${textShadows.join(", ")};`;
  }
  
  const boxShadow = boxShadows.length > 0 ? `box-shadow: ${boxShadows.join(", ")};` : "";
  return `${boxShadow} ${blur}`.trim();
}

// Get transform (rotation, etc.)
function getTransform(node, rootFrame, scale) {
  const transforms = [];
  
  // Handle rotation
  if (node.relativeTransform) {
    const matrix = node.relativeTransform;
    // Extract rotation angle from transform matrix
    // matrix is [[a, b, tx], [c, d, ty]]
    // rotation = atan2(b, a)
    const a = matrix[0][0];
    const b = matrix[0][1];
    const angle = Math.atan2(b, a) * (180 / Math.PI);
    
    if (Math.abs(angle) > 0.01) { // Only add if there's meaningful rotation
      transforms.push(`rotate(${angle.toFixed(2)}deg)`);
    }
  }
  
  return transforms.length > 0 ? `transform: ${transforms.join(' ')};` : '';
}

function sanitize(id) {
  return String(id).replace(/[^a-zA-Z0-9_-]/g, "-");
}

function escapeHtml(s) {
  return String(s)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

// --- Main ---
(async function main() {
  try {
    const data = await fetchFigmaFile();
    console.log("Building HTML/CSS…");

    const { html, css } = await extractHtmlAndCss(data);

    if (!fs.existsSync(OUTPUT_DIR)) fs.mkdirSync(OUTPUT_DIR, { recursive: true });
    fs.writeFileSync(`${OUTPUT_DIR}/index.html`, html);
    fs.writeFileSync(`${OUTPUT_DIR}/styles.css`, css);

    console.log("✅ Export complete!");
    console.log(`📂 ${OUTPUT_DIR}/index.html`);
    console.log(`📂 ${OUTPUT_DIR}/styles.css`);
    console.log(`📊 ${imageCache.size} images referenced`);
  } catch (err) {
    console.error("❌ Error:", err.message || err);
    console.error(err.stack);
  }
})();