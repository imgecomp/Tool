import express from "express";
import cors from "cors";
import fileUpload from "express-fileupload";
import multer from "multer";
import fs from "fs/promises";
import fsSync from "fs";
import path from "path";
import os from "os";
import { v4 as uuidv4 } from "uuid";
import { createCanvas, loadImage } from "canvas";
import sharp from "sharp";
import { PDFDocument, StandardFonts, rgb } from "pdf-lib";
import JSZip from "jszip";
import { exec } from "child_process";
import ffmpeg from "fluent-ffmpeg";
import ffmpegPath from "ffmpeg-static";

import dotenv from "dotenv";
dotenv.config();

const app = express();
const PORT = process.env.PORT || 3000;
const MAX_FILE_SIZE = parseInt(process.env.MAX_FILE_SIZE_BYTES || "52428800", 10);

ffmpeg.setFfmpegPath(ffmpegPath);

// Middleware
app.use(cors({ origin: "*" }));
app.use(express.json({ limit: "100mb" }));
app.use(express.urlencoded({ extended: true, limit: "100mb" }));
app.use(fileUpload({ createParentPath: true }));

// Ensure directories exist
["uploads", "outputs", "temp"].forEach((dir) => {
  if (!fsSync.existsSync(dir)) fsSync.mkdirSync(dir);
});

// Multer for audio uploads
const audioUpload = multer({ storage: multer.memoryStorage(), limits: { fileSize: MAX_FILE_SIZE } });

// -------------------- Helpers --------------------
async function makeTempDir() {
  const dir = path.join(os.tmpdir(), `tools-${Date.now()}-${uuidv4()}`);
  await fs.mkdir(dir, { recursive: true });
  return dir;
}

async function safeRm(fileOrDir) {
  try {
    await fs.rm(fileOrDir, { force: true, recursive: true });
  } catch {}
}

function hexToRgb(hex) {
  const shorthandRegex = /^#?([a-f\d])([a-f\d])([a-f\d])$/i;
  hex = hex.replace(shorthandRegex, (m, r, g, b) => r + r + g + g + b + b);
  const result = /^#?([a-f\d]{2})([a-f\d]{2})([a-f\d]{2})$/i.exec(hex);
  return result
    ? { r: parseInt(result[1], 16), g: parseInt(result[2], 16), b: parseInt(result[3], 16) }
    : { r: 0, g: 0, b: 0 };
}

async function saveTempFile(file) {
  const tempDir = "./temp";
  await fs.mkdir(tempDir, { recursive: true });
  const fileName = `${uuidv4()}${path.extname(file.name)}`;
  const filePath = path.join(tempDir, fileName);
  await file.mv(filePath);
  return filePath;
}

// -------------------- AUDIO ROUTES --------------------

// Compress audio
app.post("/audio/compress", audioUpload.single("audio"), async (req, res) => {
  if (!req.file) return res.status(400).send("No audio uploaded");

  const quality = Math.max(10, Math.min(100, parseInt(req.body.quality) || 50));
  const tempDir = await makeTempDir();
  const inputPath = path.join(tempDir, `input${path.extname(req.file.originalname)}`);
  const outputPath = path.join(tempDir, `compressed.mp3`);
  await fs.writeFile(inputPath, req.file.buffer);

  const bitrate = Math.round(32 + ((quality / 100) * (320 - 32)));

  ffmpeg(inputPath)
    .audioCodec("libmp3lame")
    .audioBitrate(`${bitrate}k`)
    .on("end", async () => {
      res.download(outputPath, `compressed-${req.file.originalname}.mp3`, async () => await safeRm(tempDir));
    })
    .on("error", async (err) => {
      await safeRm(tempDir);
      res.status(500).send("Audio compression failed: " + err.message);
    })
    .save(outputPath);
});

// Merge audios
app.post("/audio/merge", audioUpload.array("audios", 20), async (req, res) => {
  if (!req.files || req.files.length < 2) return res.status(400).send("Upload at least 2 audio files");

  const tempDir = await makeTempDir();
  const fileNames = [];

  for (let i = 0; i < req.files.length; i++) {
    const f = req.files[i];
    const filePath = path.join(tempDir, `file${i}${path.extname(f.originalname)}`);
    await fs.writeFile(filePath, f.buffer);
    fileNames.push(filePath);
  }

  const concatFile = path.join(tempDir, "concat.txt");
  await fs.writeFile(concatFile, fileNames.map(f => `file '${f.replace(/'/g, "'\\''")}'`).join("\n"));

  const outputPath = path.join(tempDir, `merged.mp3`);
  ffmpeg()
    .input(concatFile)
    .inputOptions(["-f", "concat", "-safe", "0"])
    .audioCodec("libmp3lame")
    .outputOptions(["-q:a", "2"])
    .on("end", async () => res.download(outputPath, "merged-audio.mp3", async () => await safeRm(tempDir)))
    .on("error", async (err) => {
      await safeRm(tempDir);
      res.status(500).send("Audio merge failed: " + err.message);
    })
    .save(outputPath);
});

// -------------------- IMAGE ROUTES --------------------

// Convert image
app.post("/image/convert", async (req, res) => {
  try {
    if (!req.files?.image) return res.status(400).send("No image uploaded");
    const { format } = req.body;
    const img = await loadImage(req.files.image.data);
    const canvas = createCanvas(img.width, img.height);
    canvas.getContext("2d").drawImage(img, 0, 0);

    let mimeType = "image/png";
    if (format === "jpeg") mimeType = "image/jpeg";
    else if (format === "webp") mimeType = "image/webp";
    else if (format === "bmp") mimeType = "image/bmp";

    const buffer = canvas.toBuffer(mimeType);
    res.setHeader("Content-Disposition", `attachment; filename=converted.${format}`);
    res.type(mimeType).send(buffer);
  } catch (err) {
    res.status(500).send("Image conversion failed: " + err.message);
  }
});

// Watermark image
app.post("/image/watermark", async (req, res) => {
  try {
    if (!req.files?.image) return res.status(400).send("No image uploaded");
    const { text, fontSize = 18, color = "#ff0000", opacity = 1, position = "center" } = req.body;
    const img = await loadImage(req.files.image.data);
    const canvas = createCanvas(img.width, img.height);
    const ctx = canvas.getContext("2d");
    ctx.drawImage(img, 0, 0);

    ctx.globalAlpha = parseFloat(opacity);
    ctx.fillStyle = color;
    ctx.font = `${parseInt(fontSize)}px Poppins`;

    const textWidth = ctx.measureText(text).width;
    const textHeight = parseInt(fontSize);
    const margin = 20;

    let x = 0, y = 0;
    switch (position) {
      case "top-left": x = margin; y = margin + textHeight; break;
      case "top-right": x = img.width - textWidth - margin; y = margin + textHeight; break;
      case "bottom-left": x = margin; y = img.height - margin; break;
      case "bottom-right": x = img.width - textWidth - margin; y = img.height - margin; break;
      case "center": x = (img.width - textWidth) / 2; y = (img.height + textHeight) / 2; break;
    }

    ctx.fillText(text, x, y);
    ctx.globalAlpha = 1;

    const buffer = canvas.toBuffer("image/png");
    res.setHeader("Content-Disposition", `attachment; filename=watermarked.png`);
    res.type("image/png").send(buffer);
  } catch (err) {
    res.status(500).send("Watermark failed: " + err.message);
  }
});

// Resize image
app.post("/image/resize", async (req, res) => {
  try {
    if (!req.files?.image) return res.status(400).send("No image uploaded");
    const { width, height, format = "png" } = req.body;

    const buffer = await sharp(req.files.image.data)
      .resize(parseInt(width), parseInt(height))
      .toFormat(format)
      .toBuffer();

    res.setHeader("Content-Disposition", `attachment; filename=resized.${format}`);
    res.type(`image/${format}`).send(buffer);
  } catch (err) {
    res.status(500).send("Resize failed: " + err.message);
  }
});

// -------------------- PDF ROUTES --------------------

// Merge PDFs
app.post("/pdf/merge", async (req, res) => {
  try {
    if (!req.files?.pdfs) return res.status(400).send("No PDFs uploaded");
    const files = Array.isArray(req.files.pdfs) ? req.files.pdfs : [req.files.pdfs];
    const mergedPdf = await PDFDocument.create();

    for (const file of files) {
      const pdf = await PDFDocument.load(file.data);
      const pages = await mergedPdf.copyPages(pdf, pdf.getPageIndices());
      pages.forEach((p) => mergedPdf.addPage(p));
    }

    const mergedBytes = await mergedPdf.save();
    res.setHeader("Content-Disposition", `attachment; filename=merged.pdf`);
    res.type("application/pdf").send(Buffer.from(mergedBytes));
  } catch (err) {
    res.status(500).send("PDF merge failed: " + err.message);
  }
});

// -------------------- VIDEO ROUTES --------------------

app.post("/video", async (req, res) => {
  if (!req.files?.video) return res.status(400).send("No video uploaded");
  const file = req.files.video;
  const format = req.body.format || "mp4";
  const resolution = req.body.resolution || "original";

  const outputFile = path.join("outputs", `${uuidv4()}.${format}`);
  const scaleCmd = resolution !== "original" ? `-vf scale=${resolution}` : "";
  const codecCmd =
    format === "mp4" ? "-c:v libx264 -preset fast -crf 28" : format === "webm" ? "-c:v libvpx -b:v 1M" : "-c:v mjpeg";

  exec(`ffmpeg -i "${file.tempFilePath}" ${scaleCmd} ${codecCmd} "${outputFile}"`, (err) => {
    if (err) return res.status(500).send("Video processing failed: " + err.message);
    res.download(outputFile, () => {
      fsSync.unlinkSync(file.tempFilePath);
      fsSync.unlinkSync(outputFile);
    });
  });
});

// -------------------- HEALTH CHECK --------------------
app.get("/", (req, res) => res.send("Unified Audio, Image, PDF & Video Tools Backend is running"));

// -------------------- START SERVER --------------------
app.listen(PORT, () => console.log(`Server running at http://localhost:${PORT}`));
