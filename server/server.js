// server.js
import express from "express";
import { google } from "googleapis";
import bodyParser from "body-parser";
import cors from "cors";
import dotenv from "dotenv";

dotenv.config();

const app = express();
app.use(cors());
app.use(bodyParser.json());

// تأكد من تهيئة المتغيرات البيئية:
// GOOGLE_SERVICE_ACCOUNT_EMAIL
// GOOGLE_PRIVATE_KEY   (مع \n ضمن القيمة)
// GOOGLE_SHEET_ID

const SERVICE_EMAIL = process.env.GOOGLE_SERVICE_ACCOUNT_EMAIL;
const PRIVATE_KEY = (process.env.GOOGLE_PRIVATE_KEY || "").replace(/\\n/g, "\n");
const SPREADSHEET_ID = process.env.GOOGLE_SHEET_ID;

if (!SERVICE_EMAIL || !PRIVATE_KEY || !SPREADSHEET_ID) {
  console.error("Missing one of required env vars: GOOGLE_SERVICE_ACCOUNT_EMAIL, GOOGLE_PRIVATE_KEY, GOOGLE_SHEET_ID");
  process.exit(1);
}

const auth = new google.auth.JWT(
  SERVICE_EMAIL,
  undefined,
  PRIVATE_KEY,
  ["https://www.googleapis.com/auth/spreadsheets"]
);

const sheets = google.sheets({ version: "v4", auth });

// مساعدة: تحويل تاريخ/وقت المحفوظ في الشيت إلى كائن Date
function parseSheetDateTime(dateStr, timeStr) {
  if (!dateStr) return null;
  // حاول البناء المباشر
  try {
    const direct = new Date(`${dateStr} ${timeStr || ""}`);
    if (!isNaN(direct)) return direct;
  } catch (e) {}
  // عادة التاريخ مخزن بصيغة dd/MM/yyyy أو dd-MM-yyyy
  const sep = dateStr.includes("/") ? "/" : dateStr.includes("-") ? "-" : null;
  if (sep) {
    const parts = dateStr.split(sep).map(s => s.trim());
    if (parts.length === 3) {
      const day = parseInt(parts[0], 10);
      const month = parseInt(parts[1], 10) - 1;
      const year = parseInt(parts[2], 10);
      let hh = 0, mm = 0, ss = 0;
      if (timeStr) {
        const t = timeStr.split(":").map(x => parseInt(x, 10) || 0);
        hh = t[0] || 0; mm = t[1] || 0; ss = t[2] || 0;
      }
      return new Date(year, month, day, hh, mm, ss);
    }
  }
  // فشل التحويل
  return null;
}

// قراءة كل الصفوف من الشيت (باستثناء العنوان)
async function readAllRows() {
  // نحصل على كل القيم
  const range = "Users!A:Z";
  const resp = await sheets.spreadsheets.values.get({
    spreadsheetId: SPREADSHEET_ID,
    range
  });
  const rows = resp.data.values || [];
  if (rows.length === 0) return { headers: [], data: [] };

  const headers = rows[0].map(h => (h || "").toString().trim());
  const dataRows = rows.slice(1);
  const mapped = dataRows.map(r => {
    // حدد قيم حسب الأعمدة المتوقعة — لكن نكوّن شيء عام
    const obj = {};
    headers.forEach((h, i) => {
      obj[h || `col${i}`] = r[i] !== undefined ? r[i] : "";
    });

    // نبحث عن حقل التاريخ والوقت وفق أسماء مألوفة
    const dateKeys = ["التاريخ", "Date", "date"];
    const timeKeys = ["الوقت", "Time", "time"];
    const dateKey = headers.find(h => dateKeys.includes(h)) || headers.find(h => /تاريخ/i.test(h)) || null;
    const timeKey = headers.find(h => timeKeys.includes(h)) || headers.find(h => /وقت/i.test(h)) || null;

    const dateStr = dateKey ? obj[dateKey] : "";
    const timeStr = timeKey ? obj[timeKey] : "";

    const ts = parseSheetDateTime(dateStr, timeStr);
    obj._timestamp = ts ? ts.toISOString() : null; // ISO string or null

    return obj;
  });

  return { headers, data: mapped };
}

// فلترة حسب فترة: period = 'today'|'7days'|'month'|'all'
function filterByPeriod(rows, period) {
  if (!period || period === "all") return rows;
  const now = new Date();
  let since;
  if (period === "today") {
    since = new Date(now.getFullYear(), now.getMonth(), now.getDate()); // بداية اليوم
  } else if (period === "7days") {
    since = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);
  } else if (period === "month") {
    // آخر 30 يوماً
    since = new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000);
  } else {
    since = null;
  }

  if (!since) return rows;

  return rows.filter(r => {
    if (!r._timestamp) return false;
    const d = new Date(r._timestamp);
    return d >= since;
  });
}

// endpoint: جلب السجلات مع فلترة
app.get("/entries", async (req, res) => {
  try {
    const period = req.query.period || "all"; // today, 7days, month, all
    const { headers, data } = await readAllRows();
    const filtered = filterByPeriod(data, period);

    // رتب حسب التاريخ تنازلياً إن أمكن
    filtered.sort((a, b) => {
      const da = a._timestamp ? new Date(a._timestamp) : new Date(0);
      const db = b._timestamp ? new Date(b._timestamp) : new Date(0);
      return db - da;
    });

    res.json({ success: true, headers, rows: filtered });
  } catch (err) {
    console.error("Error /entries:", err);
    res.status(500).json({ success: false, message: "خطأ في قراءة الشيت" });
  }
});

// (اختياري) endpoint لفحص الاتصال
app.get("/ping", (req, res) => res.json({ success: true, now: new Date().toISOString() }));

const PORT = process.env.PORT || 5000;
app.listen(PORT, () => console.log(`Server running on port ${PORT}`));
