require("dotenv").config();

const crypto = require("crypto");
const express = require("express");
const cors = require("cors");
const multer = require("multer");
const { Pool } = require("pg");
const cloudinary = require("cloudinary").v2;
const cron = require("node-cron");
const { Resend } = require("resend");

const app = express();
const PORT = process.env.PORT || 5000;
const ADMIN_TOKEN_LIFETIME_SECONDS = 8 * 60 * 60;

// -----------------------------------------------------------------------------
// Configuration
// -----------------------------------------------------------------------------
app.use(
  cors({
    origin: "*",
    methods: ["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"],
    allowedHeaders: ["Content-Type", "Authorization"],
  }),
);
app.use(express.json({ limit: "1mb" }));
app.use(express.urlencoded({ extended: true, limit: "1mb" }));

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.DATABASE_URL
    ? { rejectUnauthorized: false }
    : undefined,
});

pool.on("error", (err) => {
  console.error("Unexpected PostgreSQL pool error:", err);
});

cloudinary.config({
  cloud_name: process.env.CLOUDINARY_CLOUD_NAME || process.env.CLOUD_NAME,
  api_key: process.env.CLOUDINARY_API_KEY || process.env.API_KEY,
  api_secret: process.env.CLOUDINARY_API_SECRET || process.env.API_SECRET,
  secure: true,
});

// Email reminders are optional; the server still starts if Resend is not set.
const resend = process.env.RESEND_API_KEY
  ? new Resend(process.env.RESEND_API_KEY)
  : null;

// Use memory storage, then send the file directly to Cloudinary. This avoids
// relying on a local uploads/ directory or Render's temporary filesystem.
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 15 * 1024 * 1024 }, // 15 MB
  fileFilter: (_req, file, callback) => {
    if (!file.mimetype || !file.mimetype.startsWith("image/")) {
      return callback(new Error("Only image files are allowed."));
    }
    callback(null, true);
  },
});

// -----------------------------------------------------------------------------
// Helpers and admin authentication
// -----------------------------------------------------------------------------
function sendError(res, status, message, extra = {}) {
  return res.status(status).json({ success: false, message, ...extra });
}

function getTokenSecret() {
  // Keep this secret only in the backend environment. Never put it in frontend code.
  return process.env.ADMIN_TOKEN_SECRET || "";
}

function createAdminToken(username) {
  const secret = getTokenSecret();
  if (!secret) throw new Error("ADMIN_TOKEN_SECRET is not configured.");

  const payload = Buffer.from(
    JSON.stringify({
      sub: username,
      exp: Math.floor(Date.now() / 1000) + ADMIN_TOKEN_LIFETIME_SECONDS,
    }),
  ).toString("base64url");

  const signature = crypto
    .createHmac("sha256", secret)
    .update(payload)
    .digest("base64url");

  return `${payload}.${signature}`;
}

function isValidAdminToken(token) {
  const secret = getTokenSecret();
  if (!secret || !token) return false;

  const parts = token.split(".");
  if (parts.length !== 2) return false;

  const [payload, suppliedSignature] = parts;
  const expectedSignature = crypto
    .createHmac("sha256", secret)
    .update(payload)
    .digest("base64url");

  const supplied = Buffer.from(suppliedSignature);
  const expected = Buffer.from(expectedSignature);
  if (supplied.length !== expected.length) return false;
  if (!crypto.timingSafeEqual(supplied, expected)) return false;

  try {
    const decoded = JSON.parse(Buffer.from(payload, "base64url").toString("utf8"));
    return Boolean(decoded.sub) && Number(decoded.exp) > Math.floor(Date.now() / 1000);
  } catch {
    return false;
  }
}

function requireAdmin(req, res, next) {
  const authorization = req.get("authorization") || "";
  const match = authorization.match(/^Bearer\s+(.+)$/i);

  if (!match || !isValidAdminToken(match[1])) {
    return sendError(res, 401, "Authentication required. Please log in again.");
  }

  next();
}

function parsePositiveId(value) {
  const id = Number.parseInt(value, 10);
  return Number.isInteger(id) && id > 0 ? id : null;
}

function isHttpUrl(value) {
  try {
    const url = new URL(String(value || "").trim());
    return (url.protocol === "https:" || url.protocol === "http:") &&
      Boolean(url.hostname) && !url.username && !url.password;
  } catch {
    return false;
  }
}

function isYoutubeUrl(value) {
  try {
    const url = new URL(String(value || "").trim());
    const host = url.hostname.toLowerCase().replace(/^www\./, "");
    const allowedHosts = new Set([
      "youtube.com",
      "m.youtube.com",
      "youtu.be",
      "youtube-nocookie.com",
    ]);
    if (!allowedHosts.has(host)) return false;
    return host === "youtu.be"
      ? url.pathname.split("/").filter(Boolean).length > 0
      : Boolean(
          url.searchParams.get("v") ||
          /^\/(embed|shorts|live)\/[^/]+/.test(url.pathname),
        );
  } catch {
    return false;
  }
}

function cloudinaryConfigured() {
  return Boolean(
    (process.env.CLOUDINARY_CLOUD_NAME || process.env.CLOUD_NAME) &&
      (process.env.CLOUDINARY_API_KEY || process.env.API_KEY) &&
      (process.env.CLOUDINARY_API_SECRET || process.env.API_SECRET),
  );
}

async function uploadImageToCloudinary(file, folder) {
  if (!file || !file.buffer) {
    const err = new Error("Please select an image file.");
    err.status = 400;
    throw err;
  }
  if (!cloudinaryConfigured()) {
    const err = new Error("Cloudinary environment variables are not configured.");
    err.status = 500;
    throw err;
  }

  const dataUri = `data:${file.mimetype};base64,${file.buffer.toString("base64")}`;
  return cloudinary.uploader.upload(dataUri, {
    folder,
    resource_type: "image",
  });
}

function getCloudinaryPublicId(imageUrl) {
  if (!imageUrl || !imageUrl.includes("res.cloudinary.com/")) return null;

  try {
    const parsed = new URL(imageUrl);
    const marker = "/upload/";
    const index = parsed.pathname.indexOf(marker);
    if (index < 0) return null;

    const segments = parsed.pathname
      .slice(index + marker.length)
      .split("/")
      .filter(Boolean);

    // Remove Cloudinary's version prefix (for example v1234567890).
    if (segments.length && /^v\d+$/.test(segments[0])) segments.shift();
    if (!segments.length) return null;

    // Our uploads do not request URL transformations, so the path after the
    // version is the public ID plus the filename extension.
    const last = segments.length - 1;
    segments[last] = segments[last].replace(/\.[^.]+$/, "");
    return segments.join("/") || null;
  } catch {
    return null;
  }
}

async function deleteCloudinaryImage(imageUrl) {
  const publicId = getCloudinaryPublicId(imageUrl);
  if (!publicId || !cloudinaryConfigured()) return;

  try {
    const result = await cloudinary.uploader.destroy(publicId, {
      resource_type: "image",
      invalidate: true,
    });
    if (result.result !== "ok" && result.result !== "not found") {
      console.warn("Cloudinary image cleanup result:", result.result);
    }
  } catch (err) {
    // A Cloudinary cleanup issue should not leave the database record behind.
    console.error("Cloudinary image cleanup failed:", err.message);
  }
}

function handleAsyncRoute(handler) {
  return (req, res, next) => Promise.resolve(handler(req, res, next)).catch(next);
}

// -----------------------------------------------------------------------------
// Health checks and login
// -----------------------------------------------------------------------------
app.get("/", (_req, res) => {
  res.status(200).send("Backend is running ✅");
});

app.get("/ping", (_req, res) => {
  res.status(200).send("OK");
});

app.post("/login", (req, res) => {
  const { username, password } = req.body || {};

  if (!process.env.ADMIN_USERNAME || !process.env.ADMIN_PASSWORD) {
    return sendError(res, 500, "Admin login is not configured on the server.");
  }
  if (username !== process.env.ADMIN_USERNAME || password !== process.env.ADMIN_PASSWORD) {
    return sendError(res, 401, "Invalid username or password.");
  }

  try {
    const token = createAdminToken(username);
    return res.json({
      success: true,
      token,
      tokenType: "Bearer",
      expiresIn: ADMIN_TOKEN_LIFETIME_SECONDS,
    });
  } catch (err) {
    console.error("Login token creation failed:", err.message);
    return sendError(res, 500, "Admin token authentication is not configured.");
  }
});

// -----------------------------------------------------------------------------
// Portfolio images: images table
// Categories used by the frontend include digital, video, motion, and
// billboard-portfolio. Any non-empty category can be used without a schema change.
// -----------------------------------------------------------------------------
app.get("/images/:category", handleAsyncRoute(async (req, res) => {
  const category = String(req.params.category || "").trim();
  if (!category) return sendError(res, 400, "Image category is required.");

  const result = await pool.query(
    `SELECT id, url, category, created_at
     FROM images
     WHERE category = $1
     ORDER BY created_at DESC, id DESC`,
    [category],
  );
  return res.json(result.rows);
}));

app.post(
  "/upload",
  requireAdmin,
  upload.single("image"),
  handleAsyncRoute(async (req, res) => {
    const category = String(req.body?.category || "").trim();
    if (!category) return sendError(res, 400, "Image category is required.");
    if (category.length > 100) return sendError(res, 400, "Image category is too long.");
    if (!req.file) return sendError(res, 400, "Please choose an image to upload.");

    let uploaded;
    try {
      uploaded = await uploadImageToCloudinary(req.file, "ebdaa-media/portfolio");
      const result = await pool.query(
        `INSERT INTO images (url, category)
         VALUES ($1, $2)
         RETURNING id, url, category, created_at`,
        [uploaded.secure_url, category],
      );
      return res.status(201).json({
        success: true,
        message: "Image uploaded and saved successfully.",
        image: result.rows[0],
        imageUrl: result.rows[0].url, // kept for compatibility with older frontend code
      });
    } catch (err) {
      if (uploaded?.public_id) {
        try {
          await cloudinary.uploader.destroy(uploaded.public_id, { resource_type: "image" });
        } catch (cleanupError) {
          console.error("Cloudinary rollback failed:", cleanupError.message);
        }
      }
      console.error("Image upload/database insert failed:", err);
      return sendError(res, err.status || 500, err.status ? err.message : "Image upload failed; it was not saved to the database.");
    }
  }),
);

app.delete("/delete/:id", requireAdmin, handleAsyncRoute(async (req, res) => {
  const id = parsePositiveId(req.params.id);
  if (!id) return sendError(res, 400, "Invalid image ID.");

  const result = await pool.query(
    "DELETE FROM images WHERE id = $1 RETURNING id, url, category",
    [id],
  );
  if (!result.rowCount) return sendError(res, 404, "Image not found.");

  // The schema's ON DELETE CASCADE removes associated image_videos automatically.
  await deleteCloudinaryImage(result.rows[0].url);
  return res.json({ success: true, message: "Image and linked video records deleted.", image: result.rows[0] });
}));

// -----------------------------------------------------------------------------
// Videos attached to portfolio images: image_videos table
// -----------------------------------------------------------------------------
app.get("/image-video/:imageId", handleAsyncRoute(async (req, res) => {
  const imageId = parsePositiveId(req.params.imageId);
  if (!imageId) return sendError(res, 400, "Invalid image ID.");

  const result = await pool.query(
    `SELECT id, image_id, youtube_url
     FROM image_videos
     WHERE image_id = $1
     ORDER BY id ASC`,
    [imageId],
  );
  return res.json(result.rows);
}));

app.post("/add-video", requireAdmin, handleAsyncRoute(async (req, res) => {
  const imageId = parsePositiveId(req.body?.image_id);
  const youtubeUrl = String(req.body?.youtube_url || "").trim();
  if (!imageId) return sendError(res, 400, "Choose a valid portfolio image first.");
  if (!youtubeUrl || !isYoutubeUrl(youtubeUrl)) {
    return sendError(res, 400, "Enter a valid YouTube video URL.");
  }

  const imageCheck = await pool.query("SELECT id FROM images WHERE id = $1", [imageId]);
  if (!imageCheck.rowCount) return sendError(res, 404, "The selected image does not exist.");

  const result = await pool.query(
    `INSERT INTO image_videos (image_id, youtube_url)
     VALUES ($1, $2)
     RETURNING id, image_id, youtube_url`,
    [imageId, youtubeUrl],
  );
  return res.status(201).json({
    success: true,
    message: "Video saved successfully.",
    video: result.rows[0],
  });
}));

app.delete("/delete-video/:id", requireAdmin, handleAsyncRoute(async (req, res) => {
  const id = parsePositiveId(req.params.id);
  if (!id) return sendError(res, 400, "Invalid video ID.");

  const result = await pool.query(
    "DELETE FROM image_videos WHERE id = $1 RETURNING id, image_id, youtube_url",
    [id],
  );
  if (!result.rowCount) return sendError(res, 404, "Video not found.");
  return res.json({ success: true, message: "Video deleted successfully.", video: result.rows[0] });
}));

// -----------------------------------------------------------------------------
// Website clients: website_clients table
// Public GET, authenticated create/update/delete. For POST, send multipart form
// fields: name, website_url, optional sort_order, and logo (file). For PUT, the
// logo field is optional; omit it to retain the previous logo.
// -----------------------------------------------------------------------------
app.get("/website-clients", handleAsyncRoute(async (_req, res) => {
  const result = await pool.query(
    `SELECT id, name, logo_url, website_url, sort_order, created_at
     FROM website_clients
     ORDER BY sort_order ASC, id ASC`,
  );
  return res.json(result.rows);
}));

app.post(
  "/website-clients",
  requireAdmin,
  upload.single("logo"),
  handleAsyncRoute(async (req, res) => {
    const name = String(req.body?.name || "").trim();
    const websiteUrl = String(req.body?.website_url || "").trim();
    const sortOrderRaw = req.body?.sort_order;
    const sortOrder = sortOrderRaw === undefined || sortOrderRaw === ""
      ? 0
      : Number(sortOrderRaw);

    if (!name) return sendError(res, 400, "Client name is required.");
    if (name.length > 150) return sendError(res, 400, "Client name must be 150 characters or fewer.");
    if (!isHttpUrl(websiteUrl)) return sendError(res, 400, "Enter a valid http:// or https:// website URL.");
    if (!Number.isInteger(sortOrder) || sortOrder < 0) return sendError(res, 400, "Sort order must be a non-negative integer.");
    if (!req.file) return sendError(res, 400, "Please select a client logo.");

    let uploaded;
    try {
      uploaded = await uploadImageToCloudinary(req.file, "ebdaa-media/website-clients");
      const result = await pool.query(
        `INSERT INTO website_clients (name, logo_url, website_url, sort_order)
         VALUES ($1, $2, $3, $4)
         RETURNING id, name, logo_url, website_url, sort_order, created_at`,
        [name, uploaded.secure_url, websiteUrl, sortOrder],
      );
      return res.status(201).json({ success: true, message: "Website client created.", client: result.rows[0] });
    } catch (err) {
      if (uploaded?.public_id) {
        try {
          await cloudinary.uploader.destroy(uploaded.public_id, { resource_type: "image" });
        } catch (cleanupError) {
          console.error("Cloudinary rollback failed:", cleanupError.message);
        }
      }
      console.error("Website client create failed:", err);
      return sendError(res, err.status || 500, err.status ? err.message : "Website client could not be saved.");
    }
  }),
);

app.put(
  "/website-clients/:id",
  requireAdmin,
  upload.single("logo"),
  handleAsyncRoute(async (req, res) => {
    const id = parsePositiveId(req.params.id);
    if (!id) return sendError(res, 400, "Invalid website client ID.");

    const existingResult = await pool.query("SELECT * FROM website_clients WHERE id = $1", [id]);
    if (!existingResult.rowCount) return sendError(res, 404, "Website client not found.");

    const existing = existingResult.rows[0];
    const name = String(req.body?.name ?? existing.name).trim();
    const websiteUrl = String(req.body?.website_url ?? existing.website_url).trim();
    const sortOrderRaw = req.body?.sort_order;
    const sortOrder = sortOrderRaw === undefined || sortOrderRaw === ""
      ? existing.sort_order
      : Number(sortOrderRaw);

    if (!name) return sendError(res, 400, "Client name is required.");
    if (name.length > 150) return sendError(res, 400, "Client name must be 150 characters or fewer.");
    if (!isHttpUrl(websiteUrl)) return sendError(res, 400, "Enter a valid http:// or https:// website URL.");
    if (!Number.isInteger(sortOrder) || sortOrder < 0) return sendError(res, 400, "Sort order must be a non-negative integer.");

    let uploaded;
    try {
      if (req.file) {
        uploaded = await uploadImageToCloudinary(req.file, "ebdaa-media/website-clients");
      }
      const logoUrl = uploaded?.secure_url || existing.logo_url;
      const result = await pool.query(
        `UPDATE website_clients
         SET name = $1, logo_url = $2, website_url = $3, sort_order = $4
         WHERE id = $5
         RETURNING id, name, logo_url, website_url, sort_order, created_at`,
        [name, logoUrl, websiteUrl, sortOrder, id],
      );

      if (uploaded?.secure_url && existing.logo_url !== logoUrl) {
        await deleteCloudinaryImage(existing.logo_url);
      }
      return res.json({ success: true, message: "Website client updated.", client: result.rows[0] });
    } catch (err) {
      if (uploaded?.public_id) {
        try {
          await cloudinary.uploader.destroy(uploaded.public_id, { resource_type: "image" });
        } catch (cleanupError) {
          console.error("Cloudinary rollback failed:", cleanupError.message);
        }
      }
      console.error("Website client update failed:", err);
      return sendError(res, err.status || 500, err.status ? err.message : "Website client could not be updated.");
    }
  }),
);

app.delete("/website-clients/:id", requireAdmin, handleAsyncRoute(async (req, res) => {
  const id = parsePositiveId(req.params.id);
  if (!id) return sendError(res, 400, "Invalid website client ID.");

  const result = await pool.query(
    `DELETE FROM website_clients
     WHERE id = $1
     RETURNING id, name, logo_url, website_url, sort_order`,
    [id],
  );
  if (!result.rowCount) return sendError(res, 404, "Website client not found.");

  await deleteCloudinaryImage(result.rows[0].logo_url);
  return res.json({ success: true, message: "Website client deleted.", client: result.rows[0] });
}));

// -----------------------------------------------------------------------------
// Physical billboard inventory: billboards table
// These routes are for the admin inventory, not the website's image gallery.
// -----------------------------------------------------------------------------
app.get("/billboards", requireAdmin, handleAsyncRoute(async (_req, res) => {
  const result = await pool.query("SELECT * FROM billboards ORDER BY id ASC");
  return res.json(result.rows);
}));

app.get("/billboards/:id", requireAdmin, handleAsyncRoute(async (req, res) => {
  const id = parsePositiveId(req.params.id);
  if (!id) return sendError(res, 400, "Invalid billboard ID.");

  const result = await pool.query("SELECT * FROM billboards WHERE id = $1", [id]);
  if (!result.rowCount) return sendError(res, 404, "Billboard not found.");
  return res.json(result.rows[0]);
}));

app.post("/billboards", requireAdmin, handleAsyncRoute(async (req, res) => {
  const body = req.body || {};
  const boardCode = String(body.board_code || "").trim();
  const area = String(body.area || "").trim();
  const address = String(body.address || "").trim();
  const width = Number(body.width);
  const height = Number(body.height);
  const faces = body.faces === undefined || body.faces === "" ? 1 : Number(body.faces);
  const totalArea = body.total_area === undefined || body.total_area === ""
    ? width * height
    : Number(body.total_area);
  const status = String(body.status || "متاحة").trim();
  const notes = body.notes == null ? null : String(body.notes);

  if (!boardCode || !area || !address) return sendError(res, 400, "Board code, area, and address are required.");
  if (![width, height, faces, totalArea].every(Number.isFinite) || width <= 0 || height <= 0 || faces < 1 || !Number.isInteger(faces) || totalArea < 0) {
    return sendError(res, 400, "Check the billboard dimensions, faces, and total area.");
  }

  try {
    const result = await pool.query(
      `INSERT INTO billboards
       (board_code, area, address, width, height, faces, total_area, status, notes)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
       RETURNING *`,
      [boardCode, area, address, width, height, faces, totalArea, status, notes],
    );
    return res.status(201).json({ success: true, billboard: result.rows[0] });
  } catch (err) {
    if (err.code === "23505") return sendError(res, 409, "That billboard code already exists.");
    console.error("Add billboard failed:", err);
    return sendError(res, 500, "Could not add billboard.");
  }
}));

app.put("/billboards/:id", requireAdmin, handleAsyncRoute(async (req, res) => {
  const id = parsePositiveId(req.params.id);
  if (!id) return sendError(res, 400, "Invalid billboard ID.");

  const body = req.body || {};
  const boardCode = String(body.board_code || "").trim();
  const area = String(body.area || "").trim();
  const address = String(body.address || "").trim();
  const width = Number(body.width);
  const height = Number(body.height);
  const faces = body.faces === undefined || body.faces === "" ? 1 : Number(body.faces);
  const totalArea = body.total_area === undefined || body.total_area === ""
    ? width * height
    : Number(body.total_area);
  const status = String(body.status || "متاحة").trim();
  const notes = body.notes == null ? null : String(body.notes);

  if (!boardCode || !area || !address) return sendError(res, 400, "Board code, area, and address are required.");
  if (![width, height, faces, totalArea].every(Number.isFinite) || width <= 0 || height <= 0 || faces < 1 || !Number.isInteger(faces) || totalArea < 0) {
    return sendError(res, 400, "Check the billboard dimensions, faces, and total area.");
  }

  try {
    const result = await pool.query(
      `UPDATE billboards
       SET board_code=$1, area=$2, address=$3, width=$4, height=$5,
           faces=$6, total_area=$7, status=$8, notes=$9
       WHERE id=$10
       RETURNING *`,
      [boardCode, area, address, width, height, faces, totalArea, status, notes, id],
    );
    if (!result.rowCount) return sendError(res, 404, "Billboard not found.");
    return res.json({ success: true, billboard: result.rows[0] });
  } catch (err) {
    if (err.code === "23505") return sendError(res, 409, "That billboard code already exists.");
    console.error("Update billboard failed:", err);
    return sendError(res, 500, "Could not update billboard.");
  }
}));

app.delete("/billboards/:id", requireAdmin, handleAsyncRoute(async (req, res) => {
  const id = parsePositiveId(req.params.id);
  if (!id) return sendError(res, 400, "Invalid billboard ID.");

  const result = await pool.query("DELETE FROM billboards WHERE id = $1 RETURNING id", [id]);
  if (!result.rowCount) return sendError(res, 404, "Billboard not found.");
  return res.json({ success: true, message: "Billboard deleted." });
}));

// -----------------------------------------------------------------------------
// Rentals: billboard_rentals table
// -----------------------------------------------------------------------------
app.get("/rentals", requireAdmin, handleAsyncRoute(async (_req, res) => {
  const result = await pool.query(
    `SELECT r.*, b.board_code, b.area, b.address
     FROM billboard_rentals r
     JOIN billboards b ON b.id = r.billboard_id
     ORDER BY r.id ASC`,
  );
  return res.json(result.rows);
}));

app.post("/rentals", requireAdmin, handleAsyncRoute(async (req, res) => {
  const body = req.body || {};
  const billboardId = parsePositiveId(body.billboard_id);
  const customerName = String(body.customer_name || "").trim();
  const rentStart = body.rent_start;
  const rentEnd = body.rent_end;

  if (!billboardId || !customerName || !rentStart || !rentEnd) {
    return sendError(res, 400, "Billboard, customer name, start date, and end date are required.");
  }
  if (new Date(rentEnd) < new Date(rentStart)) return sendError(res, 400, "The rental end date cannot be before the start date.");

  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const boardCheck = await client.query("SELECT id FROM billboards WHERE id = $1 FOR UPDATE", [billboardId]);
    if (!boardCheck.rowCount) {
      await client.query("ROLLBACK");
      return sendError(res, 404, "Selected billboard not found.");
    }

    const result = await client.query(
      `INSERT INTO billboard_rentals
       (billboard_id, customer_name, customer_phone, company_name, rent_start, rent_end, contract_price, notes)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
       RETURNING *`,
      [
        billboardId,
        customerName,
        body.customer_phone || null,
        body.company_name || null,
        rentStart,
        rentEnd,
        body.contract_price === "" || body.contract_price == null ? null : Number(body.contract_price),
        body.notes || null,
      ],
    );

    await client.query("UPDATE billboards SET status = $1 WHERE id = $2", ["مؤجرة", billboardId]);
    await client.query("COMMIT");
    return res.status(201).json({ success: true, rental: result.rows[0] });
  } catch (err) {
    await client.query("ROLLBACK");
    console.error("Add rental failed:", err);
    return sendError(res, 500, "Could not add rental.");
  } finally {
    client.release();
  }
}));

app.put("/rentals/:id", requireAdmin, handleAsyncRoute(async (req, res) => {
  const id = parsePositiveId(req.params.id);
  const body = req.body || {};
  const billboardId = parsePositiveId(body.billboard_id);
  const customerName = String(body.customer_name || "").trim();
  const rentStart = body.rent_start;
  const rentEnd = body.rent_end;

  if (!id) return sendError(res, 400, "Invalid rental ID.");
  if (!billboardId || !customerName || !rentStart || !rentEnd) {
    return sendError(res, 400, "Billboard, customer name, start date, and end date are required.");
  }
  if (new Date(rentEnd) < new Date(rentStart)) return sendError(res, 400, "The rental end date cannot be before the start date.");

  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const oldRentalResult = await client.query(
      "SELECT billboard_id FROM billboard_rentals WHERE id = $1 FOR UPDATE",
      [id],
    );
    if (!oldRentalResult.rowCount) {
      await client.query("ROLLBACK");
      return sendError(res, 404, "Rental not found.");
    }
    const oldBillboardId = oldRentalResult.rows[0].billboard_id;

    const boardCheck = await client.query("SELECT id FROM billboards WHERE id = $1", [billboardId]);
    if (!boardCheck.rowCount) {
      await client.query("ROLLBACK");
      return sendError(res, 404, "Selected billboard not found.");
    }

    const result = await client.query(
      `UPDATE billboard_rentals
       SET billboard_id=$1, customer_name=$2, customer_phone=$3, company_name=$4,
           rent_start=$5, rent_end=$6, contract_price=$7, notes=$8,
           reminder_6_month=false, reminder_3_month=false, reminder_1_month=false
       WHERE id=$9
       RETURNING *`,
      [
        billboardId,
        customerName,
        body.customer_phone || null,
        body.company_name || null,
        rentStart,
        rentEnd,
        body.contract_price === "" || body.contract_price == null ? null : Number(body.contract_price),
        body.notes || null,
        id,
      ],
    );

    if (oldBillboardId !== billboardId) {
      await client.query("UPDATE billboards SET status=$1 WHERE id=$2", ["متاحة", oldBillboardId]);
    }
    await client.query("UPDATE billboards SET status=$1 WHERE id=$2", ["مؤجرة", billboardId]);
    await client.query("COMMIT");
    return res.json({ success: true, rental: result.rows[0] });
  } catch (err) {
    await client.query("ROLLBACK");
    console.error("Update rental failed:", err);
    return sendError(res, 500, "Could not update rental.");
  } finally {
    client.release();
  }
}));

app.delete("/rentals/:id", requireAdmin, handleAsyncRoute(async (req, res) => {
  const id = parsePositiveId(req.params.id);
  if (!id) return sendError(res, 400, "Invalid rental ID.");

  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const rentalResult = await client.query(
      "DELETE FROM billboard_rentals WHERE id = $1 RETURNING id, billboard_id",
      [id],
    );
    if (!rentalResult.rowCount) {
      await client.query("ROLLBACK");
      return sendError(res, 404, "Rental not found.");
    }

    await client.query(
      "UPDATE billboards SET status=$1 WHERE id=$2",
      ["متاحة", rentalResult.rows[0].billboard_id],
    );
    await client.query("COMMIT");
    return res.json({ success: true, message: "Rental deleted." });
  } catch (err) {
    await client.query("ROLLBACK");
    console.error("Delete rental failed:", err);
    return sendError(res, 500, "Could not delete rental.");
  } finally {
    client.release();
  }
}));

// -----------------------------------------------------------------------------
// Rental reminder emails
// -----------------------------------------------------------------------------
function escapeHtml(value) {
  return String(value ?? "").replace(/[&<>"']/g, (character) => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    '"': "&quot;",
    "'": "&#39;",
  })[character]);
}

async function sendEmail(customerName, period, boardCode, endDate) {
  if (!resend || !process.env.EMAIL_TO) {
    console.warn("Reminder email skipped: RESEND_API_KEY or EMAIL_TO is not configured.");
    return false;
  }

  try {
    const formattedDate = new Date(endDate).toLocaleDateString("en-GB");
    const { data, error } = await resend.emails.send({
      from: "Ebdaa Billboard <info@ebdaa-media.com>",
      to: process.env.EMAIL_TO,
      subject: `تنبيه: سينتهي عقد اللوحة ${boardCode} خلال ${period}`,
      html: `
        <div dir="rtl" style="font-family:Arial,sans-serif">
          <h2>تنبيه تلقائي</h2>
          <p>يوجد عقد لوحة إعلانية يقترب من موعد انتهائه.</p>
          <table border="1" cellpadding="8" cellspacing="0" style="border-collapse:collapse">
            <tr><td><b>اسم العميل</b></td><td>${escapeHtml(customerName)}</td></tr>
            <tr><td><b>رقم اللوحة</b></td><td>${escapeHtml(boardCode)}</td></tr>
            <tr><td><b>المدة المتبقية</b></td><td>${escapeHtml(period)}</td></tr>
            <tr><td><b>تاريخ انتهاء العقد</b></td><td>${escapeHtml(formattedDate)}</td></tr>
          </table>
          <p style="margin-top:20px">يرجى التواصل مع العميل قبل انتهاء العقد.</p>
        </div>`,
    });

    if (error) {
      console.error("Resend error:", JSON.stringify(error, null, 2));
      return false;
    }
    console.log("Reminder email sent:", data?.id || "success");
    return true;
  } catch (err) {
    console.error("Reminder email exception:", err);
    return false;
  }
}

async function checkRentalReminders() {
  try {
    const result = await pool.query(
      `SELECT r.*, b.board_code
       FROM billboard_rentals r
       JOIN billboards b ON b.id = r.billboard_id`,
    );
    const today = new Date();

    for (const rental of result.rows) {
      const endDate = new Date(rental.rent_end);
      const diffDays = Math.ceil((endDate - today) / (1000 * 60 * 60 * 24));

      if (diffDays <= 180 && diffDays > 90 && !rental.reminder_6_month) {
        const sent = await sendEmail(rental.customer_name, "6 أشهر", rental.board_code, rental.rent_end);
        if (sent) {
          await pool.query("UPDATE billboard_rentals SET reminder_6_month=true WHERE id=$1", [rental.id]);
        }
      }

      if (diffDays <= 90 && diffDays > 30 && !rental.reminder_3_month) {
        const sent = await sendEmail(rental.customer_name, "3 أشهر", rental.board_code, rental.rent_end);
        if (sent) {
          await pool.query("UPDATE billboard_rentals SET reminder_3_month=true WHERE id=$1", [rental.id]);
        }
      }

      if (diffDays <= 30 && diffDays > 0 && !rental.reminder_1_month) {
        const sent = await sendEmail(rental.customer_name, "شهر واحد", rental.board_code, rental.rent_end);
        if (sent) {
          await pool.query("UPDATE billboard_rentals SET reminder_1_month=true WHERE id=$1", [rental.id]);
        }
      }

      if (diffDays < 0) {
        await pool.query(
          "UPDATE billboards SET status=$1 WHERE id=$2",
          ["متاحة", rental.billboard_id],
        );
      }
    }
  } catch (err) {
    console.error("Rental reminder check failed:", err);
  }
}

cron.schedule("0 9 * * *", checkRentalReminders, {
  timezone: "Europe/Istanbul",
});

// Run a check once at startup without blocking the server from accepting requests.
checkRentalReminders();

// -----------------------------------------------------------------------------
// Error handling
// -----------------------------------------------------------------------------
app.use((err, _req, res, _next) => {
  if (err instanceof multer.MulterError) {
    const message = err.code === "LIMIT_FILE_SIZE"
      ? "Image exceeds the 15 MB upload limit."
      : err.message;
    return sendError(res, 400, message);
  }
  if (err?.message === "Only image files are allowed.") {
    return sendError(res, 400, err.message);
  }
  console.error("Unhandled request error:", err);
  return sendError(res, 500, "Unexpected server error.");
});

app.listen(PORT, "0.0.0.0", () => {
  console.log(`Ebdaa backend listening on port ${PORT}`);
  if (!process.env.DATABASE_URL) console.warn("DATABASE_URL is not configured.");
  if (!getTokenSecret()) console.warn("ADMIN_TOKEN_SECRET is not configured.");
  if (!cloudinaryConfigured()) console.warn("Cloudinary environment variables are not configured.");
});
