const express = require("express");
const cors = require("cors");
const multer = require("multer");
const path = require("path");
const fs = require("fs");
const { Pool } = require("pg");

const app = express();

app.use(cors({
  origin: "*"
}));

app.use(express.json());

// ✅ ROOT TEST
app.get("/", (req, res) => {
  res.send("Backend is running ✅");
});

app.get("/ping", async (req, res) => {
  try {
    await pool.query("SELECT NOW()");

    res.status(200).json({
      status: "awake",
      time: new Date()
    });
  } catch (err) {
    res.status(500).json({
      error: err.message
    });
  }
});

// ✅ DATABASE
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: {
    rejectUnauthorized: false
  }
});

// ✅ STORAGE
const storage = multer.diskStorage({
  destination: "uploads/",
  filename: (req, file, cb) => {
    cb(null, Date.now() + path.extname(file.originalname));
  }
});

const upload = multer({ storage });

// ✅ SERVE FILES
app.use("/uploads", express.static("uploads"));

app.post("/upload", upload.single("image"), async (req, res) => {
  const { key, category } = req.body;

  if (key !== process.env.ADMIN_KEY) {
    return res.status(403).send("Unauthorized");
  }

  try {
    const result = await cloudinary.uploader.upload(req.file.path);

    const imageUrl = result.secure_url;

    await pool.query(
      "INSERT INTO images (url, category) VALUES ($1, $2)",
      [imageUrl, category]
    );

    res.json({ imageUrl });

  } catch (err) {
    console.error(err);
    res.status(500).send("Upload error");
  }
});

// ✅ GET IMAGES
app.get("/images/:category", async (req, res) => {
  const { category } = req.params;

  try {
    const result = await pool.query(
      "SELECT * FROM images WHERE category = $1 ORDER BY created_at DESC",
      [category]
    );

    res.json(result.rows);
  } catch (err) {
    console.error(err);
    res.status(500).send("Error fetching images");
  }
});

// ✅ DELETE
app.delete("/delete/:id", async (req, res) => {
  const { id } = req.params;

  try {
    const result = await pool.query("SELECT * FROM images WHERE id = $1", [id]);
    const image = result.rows[0];

    if (!image) return res.status(404).send("Not found");

    const filePath = image.url.split("/uploads/")[1];

    if (filePath && fs.existsSync(`uploads/${filePath}`)) {
      fs.unlinkSync(`uploads/${filePath}`);
    }

    await pool.query("DELETE FROM images WHERE id = $1", [id]);

    res.send("Deleted");
  } catch (err) {
    console.error(err);
    res.status(500).send("Delete error");
  }
});

// ✅ GET VIDEOS FOR IMAGE
app.get("/image-video/:imageId", async (req, res) => {
  const { imageId } = req.params;

  try {
    const result = await pool.query(
      "SELECT * FROM image_videos WHERE image_id = $1",
      [imageId]
    );

    res.json(result.rows);

  } catch (err) {
    console.error(err);
    res.status(500).send("Error fetching video");
  }
});

// ✅ ADD VIDEO URL
app.post("/add-video", async (req, res) => {

  const {
    key,
    image_id,
    youtube_url
  } = req.body;

  if (key !== process.env.ADMIN_KEY) {
    return res.status(403).send("Unauthorized");
  }

  try {

    await pool.query(
      `
      INSERT INTO image_videos
      (image_id, youtube_url)
      VALUES ($1, $2)
      `,
      [image_id, youtube_url]
    );

    res.send("Video Added");

  } catch (err) {
    console.error(err);
    res.status(500).send("Error adding video");
  }

});

// ✅ DELETE VIDEO
app.delete("/delete-video/:id", async (req, res) => {

  const { id } = req.params;

  try {

    await pool.query(
      "DELETE FROM image_videos WHERE id = $1",
      [id]
    );

    res.send("Video deleted");

  } catch (err) {
    console.error(err);
    res.status(500).send("Delete video error");
  }

});
const cloudinary = require("cloudinary").v2;

cloudinary.config({
  cloud_name: process.env.CLOUD_NAME,
  api_key: process.env.API_KEY,
  api_secret: process.env.API_SECRET
});

// ✅ START SERVER
const PORT = process.env.PORT || 5000;

process.on("unhandledRejection", (err) => {
  console.error("Unhandled Rejection:", err);
});

process.on("uncaughtException", (err) => {
  console.error("Uncaught Exception:", err);
});

app.listen(PORT, "0.0.0.0", () => {
  console.log(`Server running on port ${PORT}`);
});