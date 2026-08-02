require("dotenv").config();
const { Resend } = require("resend");

const resend = new Resend(process.env.RESEND_API_KEY);
const cron = require("node-cron");
const express = require("express");
const cors = require("cors");
const multer = require("multer");
const path = require("path");
const fs = require("fs");
const { Pool } = require("pg");

const app = express();

app.use(
  cors({
    origin: "*",
  }),
);

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
      time: new Date(),
    });
  } catch (err) {
    res.status(500).json({
      error: err.message,
    });
  }
});

// ✅ DATABASE
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: {
    rejectUnauthorized: false,
  },
});

// ✅ STORAGE
const storage = multer.diskStorage({
  destination: "uploads/",
  filename: (req, file, cb) => {
    cb(null, Date.now() + path.extname(file.originalname));
  },
});

app.post("/login", (req, res) => {
  const { username, password } = req.body;

  if (
    username === process.env.ADMIN_USERNAME &&
    password === process.env.ADMIN_PASSWORD
  ) {
    return res.json({ success: true });
  }

  res.status(401).json({
    success: false,
    message: "Invalid credentials",
  });
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

    await pool.query("INSERT INTO images (url, category) VALUES ($1, $2)", [
      imageUrl,
      category,
    ]);

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
      [category],
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
      [imageId],
    );

    res.json(result.rows);
  } catch (err) {
    console.error(err);
    res.status(500).send("Error fetching video");
  }
});

// ✅ ADD VIDEO URL
app.post("/add-video", async (req, res) => {
  const { key, image_id, youtube_url } = req.body;

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
      [image_id, youtube_url],
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
    await pool.query("DELETE FROM image_videos WHERE id = $1", [id]);

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
  api_secret: process.env.API_SECRET,
});

// ===============================
// GET ALL BILLBOARDS
// ===============================
app.get("/billboards", async (req, res) => {
  try {
    const result = await pool.query(`
      SELECT *
      FROM billboards
      ORDER BY id ASC
    `);

    res.json(result.rows);
  } catch (err) {
    console.error(err);
    res.status(500).send("Error fetching billboards");
  }
});

// ===============================
// GET SINGLE BILLBOARD
// ===============================
app.get("/billboards/:id", async (req, res) => {
  const { id } = req.params;

  try {
    const result = await pool.query(
      `
      SELECT *
      FROM billboards
      WHERE id = $1
      `,
      [id],
    );

    if (result.rows.length === 0) {
      return res.status(404).send("Billboard not found");
    }

    res.json(result.rows[0]);
  } catch (err) {
    console.error(err);
    res.status(500).send("Error fetching billboard");
  }
});

// ===============================
// ADD BILLBOARD
// ===============================
app.post("/billboards", async (req, res) => {
  const {
    board_code,
    area,
    address,
    width,
    height,
    faces,
    total_area,
    status,
    notes,
  } = req.body;

  try {
    const result = await pool.query(
      `
      INSERT INTO billboards
      (
        board_code,
        area,
        address,
        width,
        height,
        faces,
        total_area,
        status,
        notes
      )

      VALUES
      (
        $1,$2,$3,$4,$5,$6,$7,$8,$9
      )

      RETURNING *
      `,
      [
        board_code,
        area,
        address,
        width,
        height,
        faces,
        total_area,
        status,
        notes,
      ],
    );

    res.json(result.rows[0]);
  } catch (err) {
    console.error(err);
    res.status(500).send("Error adding billboard");
  }
});

// ===============================
// UPDATE BILLBOARD
// ===============================
app.put("/billboards/:id", async (req, res) => {
  const { id } = req.params;

  const {
    board_code,
    area,
    address,
    width,
    height,
    faces,
    total_area,
    status,
    notes,
  } = req.body;

  try {
    const result = await pool.query(
      `
      UPDATE billboards

      SET

      board_code = $1,
      area = $2,
      address = $3,
      width = $4,
      height = $5,
      faces = $6,
      total_area = $7,
      status = $8,
      notes = $9

      WHERE id = $10

      RETURNING *
      `,
      [
        board_code,
        area,
        address,
        width,
        height,
        faces,
        total_area,
        status,
        notes,
        id,
      ],
    );

    res.json(result.rows[0]);
  } catch (err) {
    console.error(err);
    res.status(500).send("Error updating billboard");
  }
});

// ===============================
// DELETE BILLBOARD
// ===============================
app.delete("/billboards/:id", async (req, res) => {
  const { id } = req.params;

  try {
    await pool.query(
      `
      DELETE
      FROM billboards
      WHERE id = $1
      `,
      [id],
    );

    res.send("Billboard deleted");
  } catch (err) {
    console.error(err);
    res.status(500).send("Error deleting billboard");
  }
});

// ===============================
// GET ALL RENTALS
// ===============================
app.get("/rentals", async (req, res) => {
  try {
    const result = await pool.query(`
      SELECT
        r.*,
        b.board_code,
        b.area,
        b.address
      FROM billboard_rentals r
      JOIN billboards b
      ON r.billboard_id = b.id
      ORDER BY r.id ASC
    `);

    res.json(result.rows);
  } catch (err) {
    console.error(err);
    res.status(500).send("Error fetching rentals");
  }
});

// ===============================
// ADD RENTAL
// ===============================
app.post("/rentals", async (req, res) => {
  const {
    billboard_id,
    customer_name,
    customer_phone,
    company_name,
    rent_start,
    rent_end,
    contract_price,
    notes,
  } = req.body;

  try {
    const result = await pool.query(
      `
      INSERT INTO billboard_rentals
      (
        billboard_id,
        customer_name,
        customer_phone,
        company_name,
        rent_start,
        rent_end,
        contract_price,
        notes
      )

      VALUES
      (
        $1,$2,$3,$4,$5,$6,$7,$8
      )

      RETURNING *
      `,
      [
        billboard_id,
        customer_name,
        customer_phone,
        company_name,
        rent_start,
        rent_end,
        contract_price,
        notes,
      ],
    );

    await pool.query(
      `
      UPDATE billboards
      SET status='مؤجرة'
      WHERE id=$1
      `,
      [billboard_id],
    );

    res.json(result.rows[0]);
  } catch (err) {
    console.error("ADD RENTAL ERROR:", err);

    res.status(500).json({
      error: err.message,
    });
  }
});

// ===============================
// UPDATE RENTAL
// ===============================
app.put("/rentals/:id", async (req, res) => {
  const { id } = req.params;

  const {
    billboard_id,
    customer_name,
    customer_phone,
    company_name,
    rent_start,
    rent_end,
    contract_price,
    notes,
  } = req.body;

  try {
    const result = await pool.query(
      `
      UPDATE billboard_rentals

      SET
          billboard_id = $1,
          customer_name = $2,
          customer_phone = $3,
          company_name = $4,
          rent_start = $5,
          rent_end = $6,
          contract_price = $7,
          notes = $8,

          reminder_6_month = false,
          reminder_3_month = false,
          reminder_1_month = false

      WHERE id = $9

      RETURNING *;
      `,
      [
        billboard_id,
        customer_name,
        customer_phone,
        company_name,
        rent_start,
        rent_end,
        contract_price,
        notes,
        id,
      ],
    );

    res.json(result.rows[0]);
  } catch (err) {
    console.error(err);
    res.status(500).send("Error updating rental");
  }
});

// ===============================
// DELETE RENTAL
// ===============================
app.delete("/rentals/:id", async (req, res) => {
  const { id } = req.params;

  try {
    // Get the billboard ID before deleting the rental
    const rentalResult = await pool.query(
      `
      SELECT billboard_id
      FROM billboard_rentals
      WHERE id = $1
      `,
      [id],
    );

    if (rentalResult.rows.length === 0) {
      return res.status(404).send("Rental not found");
    }

    const billboardId = rentalResult.rows[0].billboard_id;

    // Delete the rental
    await pool.query(
      `
      DELETE FROM billboard_rentals
      WHERE id = $1
      `,
      [id],
    );

    // Make the billboard available again
    await pool.query(
      `
      UPDATE billboards
      SET status = 'متاحة'
      WHERE id = $1
      `,
      [billboardId],
    );

    res.send("Rental deleted");
  } catch (err) {
    console.error(err);
    res.status(500).send("Error deleting rental");
  }
});

async function sendEmail(customerName, period, boardCode, endDate) {
  try {
    const formattedDate = new Date(endDate).toLocaleDateString("en-GB");

    const { data, error } = await resend.emails.send({
      from: "Ebdaa Billboard <info@ebdaa-media.com>",
      to: process.env.EMAIL_TO,
      subject: `تنبيه: سينتهي عقد اللوحة ${boardCode} خلال ${period}`,
      html: `
<div dir="rtl" style="font-family: Arial, sans-serif">

<h2>تنبيه تلقائي</h2>

<p>يوجد عقد لوحة إعلانية يقترب من موعد انتهائه.</p>

<table border="1" cellpadding="8" cellspacing="0" style="border-collapse:collapse">
<tr>
<td><b>اسم العميل</b></td>
<td>${customerName}</td>
</tr>

<tr>
<td><b>رقم اللوحة</b></td>
<td>${boardCode}</td>
</tr>

<tr>
<td><b>المدة المتبقية</b></td>
<td>${period}</td>
</tr>

<tr>
<td><b>تاريخ انتهاء العقد</b></td>
<td>${formattedDate}</td>
</tr>
</table>

<p style="margin-top:20px">
يرجى التواصل مع العميل قبل انتهاء العقد.
</p>

</div>
`,
    });

    if (error) {
      console.error("❌ Resend Error:");
      console.error(JSON.stringify(error, null, 2));
      return false;
    }

    console.log("✅ Email sent successfully!");
    console.log(data);

    return true;
  } catch (err) {
    console.error("❌ Exception:");
    console.error(err);
    return false;
  }
}

// ===============================
// CHECK RENTAL REMINDERS
// ===============================
async function checkRentalReminders() {
  console.log("=== Reminder check started ===");

  try {
    const result = await pool.query(`
      SELECT
        r.*,
        b.board_code
      FROM billboard_rentals r
      JOIN billboards b
      ON r.billboard_id = b.id
    `);

    console.log("Rentals found:", result.rows.length);

    const today = new Date();
    console.log("Today:", today);

    for (const rental of result.rows) {
      const endDate = new Date(rental.rent_end);
      const diffDays = Math.ceil((endDate - today) / (1000 * 60 * 60 * 24));

      console.log(
        rental.board_code,
        rental.customer_name,
        "Days left:",
        diffDays
      );

      // ===============================
      // 6 MONTH REMINDER
      // ===============================
      if (diffDays <= 180 && diffDays > 90 && !rental.reminder_6_month) {
        await sendEmail(
          rental.customer_name,
          "6 أشهر",
          rental.board_code,
          rental.rent_end,
        );

        await pool.query(
          `
          UPDATE billboard_rentals
          SET reminder_6_month = true
          WHERE id = $1
          `,
          [rental.id],
        );
      }

      // ===============================
      // 3 MONTH REMINDER
      // ===============================
      if (diffDays <= 90 && diffDays > 30 && !rental.reminder_3_month) {
        await sendEmail(
          rental.customer_name,
          "3 أشهر",
          rental.board_code,
          rental.rent_end,
        );

        await pool.query(
          `
          UPDATE billboard_rentals
          SET reminder_3_month = true
          WHERE id = $1
          `,
          [rental.id],
        );
      }

      // ===============================
      // 1 MONTH REMINDER
      // ===============================
      if (diffDays <= 30 && diffDays > 0 && !rental.reminder_1_month) {
        await sendEmail(
          rental.customer_name,
          "شهر واحد",
          rental.board_code,
          rental.rent_end,
        );

        await pool.query(
          `
          UPDATE billboard_rentals
          SET reminder_1_month = true
          WHERE id = $1
          `,
          [rental.id],
        );
      }

      // ===============================
      // CONTRACT EXPIRED
      // ===============================
      if (diffDays < 0) {
        await pool.query(
          `
          UPDATE billboards
          SET status = 'متاحة'
          WHERE id = $1
          `,
          [rental.billboard_id],
        );
      }
    }
  } catch (err) {
    console.error(err);
    throw err;
  }
}
cron.schedule(
  "0 9 * * *",
  checkRentalReminders,
  {
    timezone: "Europe/Istanbul",
  }
);

checkRentalReminders();
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
