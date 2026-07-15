import { createServer } from "node:http";
import { readFile, stat } from "node:fs/promises";
import { existsSync, readFileSync } from "node:fs";
import { extname, join, normalize, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { randomInt } from "node:crypto";

const __dirname = fileURLToPath(new URL(".", import.meta.url));
const publicDir = resolve(__dirname, "public");

loadDotEnv(join(__dirname, ".env"));

const PORT = Number(process.env.PORT || 3000);
const TELEGRAM_BOT_TOKEN = String(process.env.TELEGRAM_BOT_TOKEN || "").trim();
const TELEGRAM_CHAT_ID = String(process.env.TELEGRAM_CHAT_ID || "-1004299599812").trim();

const products = JSON.parse(
  await readFile(join(publicDir, "data", "products.json"), "utf8"),
);
const productById = new Map(products.map((product) => [product.id, product]));
const rateLimits = new Map();

const MIME_TYPES = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".webp": "image/webp",
  ".png": "image/png",
  ".svg": "image/svg+xml",
  ".ico": "image/x-icon",
  ".txt": "text/plain; charset=utf-8",
};

const server = createServer(async (req, res) => {
  try {
    const url = new URL(req.url || "/", `http://${req.headers.host || "localhost"}`);

    if (url.pathname === "/api/health") {
      return sendJson(res, 200, {
        ok: true,
        telegramConfigured: Boolean(TELEGRAM_BOT_TOKEN && TELEGRAM_CHAT_ID),
        productCount: products.length,
      });
    }

    if (url.pathname === "/api/order") {
      if (req.method !== "POST") {
        res.setHeader("Allow", "POST");
        return sendJson(res, 405, { ok: false, error: "Метод не підтримується" });
      }
      return handleOrder(req, res);
    }

    if (req.method !== "GET" && req.method !== "HEAD") {
      return sendText(res, 405, "Method Not Allowed");
    }

    return serveStatic(url.pathname, req, res);
  } catch (error) {
    console.error("Unhandled request error:", error);
    return sendJson(res, 500, { ok: false, error: "Внутрішня помилка сервера" });
  }
});

server.listen(PORT, "0.0.0.0", () => {
  console.log(`Berta HoReCa: http://localhost:${PORT}`);
  console.log(`Товарів у каталозі: ${products.length}`);
  console.log(`Telegram: ${TELEGRAM_BOT_TOKEN ? "налаштовано" : "токен не задано"}`);
});

async function handleOrder(req, res) {
  const ip = getClientIp(req);
  if (!consumeRateLimit(ip)) {
    return sendJson(res, 429, {
      ok: false,
      error: "Забагато спроб. Повторіть відправлення трохи пізніше.",
    });
  }

  if (!TELEGRAM_BOT_TOKEN || !TELEGRAM_CHAT_ID) {
    console.error("TELEGRAM_BOT_TOKEN або TELEGRAM_CHAT_ID не налаштовано");
    return sendJson(res, 503, {
      ok: false,
      error: "Сервіс замовлень тимчасово не налаштований.",
    });
  }

  let payload;
  try {
    payload = await readJsonBody(req, 700_000);
  } catch (error) {
    return sendJson(res, error.statusCode || 400, {
      ok: false,
      error: error.message || "Некоректний запит",
    });
  }

  // Невидиме поле-пастка для простих спам-ботів.
  if (String(payload.website || "").trim()) {
    return sendJson(res, 200, { ok: true });
  }

  const validation = validateOrder(payload);
  if (!validation.ok) {
    return sendJson(res, 400, { ok: false, error: validation.error });
  }

  const { customer, items } = validation.value;
  const orderId = createOrderId();
  const now = new Date();
  const orderTime = new Intl.DateTimeFormat("uk-UA", {
    timeZone: "Europe/Kyiv",
    dateStyle: "medium",
    timeStyle: "short",
  }).format(now);

  const calculatedItems = items.map(({ id, quantity }) => {
    const product = productById.get(id);
    const packSize = getPackSize(product);
    const packages = quantity / packSize;
    const lineTotal = roundMoney(
      packSize > 1 && product.priceBasis === "pack"
        ? product.price * packages
        : product.price * quantity,
    );
    return { ...product, quantity, packSize, packages, lineTotal };
  });
  const total = roundMoney(calculatedItems.reduce((sum, item) => sum + item.lineTotal, 0));

  const messages = buildTelegramMessages({
    orderId,
    orderTime,
    customer,
    items: calculatedItems,
    total,
  });

  try {
    for (const message of messages) {
      await sendTelegramMessage(message);
    }
  } catch (error) {
    console.error("Telegram send failed:", error);
    return sendJson(res, 502, {
      ok: false,
      error: "Не вдалося відправити замовлення. Перевірте зв’язок і спробуйте ще раз.",
    });
  }

  // Відповідь успішна лише після підтвердження Telegram для кожної частини замовлення.
  return sendJson(res, 200, { ok: true });
}

function validateOrder(payload) {
  const customerInput = payload?.customer || {};
  const required = {
    company: "Вкажіть назву ФОП або компанії",
    contact: "Вкажіть контактну особу",
    phone: "Вкажіть номер телефону",
    city: "Вкажіть місто або населений пункт",
    street: "Вкажіть вулицю",
    house: "Вкажіть номер будинку",
  };

  const customer = {};
  for (const [field, error] of Object.entries(required)) {
    const value = cleanInput(customerInput[field], 160);
    if (!value) return { ok: false, error };
    customer[field] = value;
  }

  const phoneDigits = customer.phone.replace(/\D/g, "");
  if (phoneDigits.length < 9 || phoneDigits.length > 15) {
    return { ok: false, error: "Перевірте правильність номера телефону" };
  }

  customer.location = cleanInput(customerInput.location, 120);
  customer.deliveryDate = cleanInput(customerInput.deliveryDate, 30);
  customer.comment = cleanInput(customerInput.comment, 800);

  if (!Array.isArray(payload.items) || payload.items.length === 0) {
    return { ok: false, error: "Кошик порожній" };
  }
  if (payload.items.length > 200) {
    return { ok: false, error: "У замовленні забагато різних позицій" };
  }

  const merged = new Map();
  for (const item of payload.items) {
    const id = cleanInput(item?.id, 40);
    const quantity = Number(item?.quantity);
    const product = productById.get(id);
    if (!product) {
      return { ok: false, error: "Один із товарів не знайдено в актуальному каталозі" };
    }
    const packSize = getPackSize(product);
    const maxQuantity = Math.min(999999, packSize * 999);
    if (
      !Number.isInteger(quantity) ||
      quantity < packSize ||
      quantity > maxQuantity ||
      quantity % packSize !== 0
    ) {
      return {
        ok: false,
        error: packSize > 1
          ? `Кількість товару «${product.name}» має бути кратною упаковці ${packSize} шт`
          : "Некоректна кількість товару",
      };
    }
    const mergedQuantity = (merged.get(id) || 0) + quantity;
    if (mergedQuantity > maxQuantity) {
      return { ok: false, error: `Завелика кількість товару «${product.name}»` };
    }
    merged.set(id, mergedQuantity);
  }

  return {
    ok: true,
    value: {
      customer,
      items: [...merged.entries()].map(([id, quantity]) => ({ id, quantity })),
    },
  };
}

function getPackSize(product) {
  const packSize = Math.round(Number(product?.packSize) || 1);
  return Math.max(1, packSize);
}

function buildTelegramMessages({ orderId, orderTime, customer, items, total }) {
  const address = [
    customer.city,
    `вул. ${customer.street}`,
    `буд. ${customer.house}`,
    customer.location,
  ].filter(Boolean).join(", ");

  const header = [
    "<b>🛒 Нове замовлення Berta HoReCa</b>",
    `<b>№:</b> ${escapeHtml(orderId)}`,
    `<b>Дата:</b> ${escapeHtml(orderTime)}`,
    "",
    `<b>ФОП / компанія:</b> ${escapeHtml(customer.company)}`,
    `<b>Контакт:</b> ${escapeHtml(customer.contact)}`,
    `<b>Телефон:</b> ${escapeHtml(customer.phone)}`,
    `<b>Адреса:</b> ${escapeHtml(address)}`,
    customer.deliveryDate
      ? `<b>Бажана дата доставки:</b> ${escapeHtml(formatDeliveryDate(customer.deliveryDate))}`
      : "",
    customer.comment ? `<b>Коментар:</b> ${escapeHtml(customer.comment)}` : "",
    "",
    "<b>Товари:</b>",
  ].filter((line) => line !== "").join("\n");

  const itemLines = items.map((item, index) => {
    let quantityLine;
    if (item.packSize > 1 && item.priceBasis === "pack") {
      quantityLine =
        `${item.packages} уп. × ${formatMoney(item.price)} ` +
        `(${item.quantity} шт) = <b>${formatMoney(item.lineTotal)}</b>`;
    } else if (item.packSize > 1) {
      quantityLine =
        `${item.quantity} шт × ${formatMoney(item.price)} ` +
        `(${item.packages} уп.) = <b>${formatMoney(item.lineTotal)}</b>`;
    } else {
      quantityLine =
        `${item.quantity} × ${formatMoney(item.price)} = <b>${formatMoney(item.lineTotal)}</b>`;
    }
    return [
      `${index + 1}. <b>${escapeHtml(item.name)}</b>`,
      `   ${quantityLine}`,
    ].join("\n");
  });

  const footer = `\n\n<b>Разом: ${formatMoney(total)}</b>\nПозицій: ${items.length}`;
  const maxLength = 3800;
  const messages = [];
  let current = header;

  for (const line of itemLines) {
    const candidate = `${current}\n${line}`;
    if (candidate.length > maxLength && current !== header) {
      messages.push(current);
      current = `<b>↪️ Продовження замовлення ${escapeHtml(orderId)}</b>\n${line}`;
    } else if (candidate.length > maxLength) {
      messages.push(header);
      current = `<b>↪️ Продовження замовлення ${escapeHtml(orderId)}</b>\n${line}`;
    } else {
      current = candidate;
    }
  }

  if (`${current}${footer}`.length <= 4090) {
    current += footer;
    messages.push(current);
  } else {
    messages.push(current);
    messages.push(`<b>Підсумок замовлення ${escapeHtml(orderId)}</b>${footer}`);
  }

  return messages;
}

async function sendTelegramMessage(text) {
  const endpoint = `https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage`;
  const response = await fetch(endpoint, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      chat_id: TELEGRAM_CHAT_ID,
      text,
      parse_mode: "HTML",
      disable_web_page_preview: true,
    }),
    signal: AbortSignal.timeout(15_000),
  });

  let result;
  try {
    result = await response.json();
  } catch {
    throw new Error(`Telegram повернув неочікувану відповідь (${response.status})`);
  }

  if (!response.ok || !result.ok) {
    throw new Error(result.description || `Telegram API error ${response.status}`);
  }
  return result;
}

async function serveStatic(pathname, req, res) {
  let requested = pathname === "/" ? "/index.html" : pathname;
  try {
    requested = decodeURIComponent(requested);
  } catch {
    return sendText(res, 400, "Bad Request");
  }

  const relative = normalize(requested).replace(/^([/\\])+/, "");
  const filePath = resolve(publicDir, relative);
  if (filePath !== publicDir && !filePath.startsWith(publicDir + sep)) {
    return sendText(res, 403, "Forbidden");
  }

  try {
    const info = await stat(filePath);
    if (!info.isFile()) return sendText(res, 404, "Not Found");
    const body = await readFile(filePath);
    const ext = extname(filePath).toLowerCase();
    res.statusCode = 200;
    res.setHeader("Content-Type", MIME_TYPES[ext] || "application/octet-stream");
    res.setHeader("X-Content-Type-Options", "nosniff");
    res.setHeader("Referrer-Policy", "strict-origin-when-cross-origin");
    res.setHeader("X-Frame-Options", "SAMEORIGIN");
    res.setHeader(
      "Cache-Control",
      ext === ".json" || ext === ".webp" || ext === ".png"
        ? "public, max-age=3600"
        : "no-cache",
    );
    if (req.method === "HEAD") return res.end();
    res.end(body);
  } catch {
    // SPA fallback for ordinary browser routes.
    if (!extname(relative)) {
      const body = await readFile(join(publicDir, "index.html"));
      res.statusCode = 200;
      res.setHeader("Content-Type", "text/html; charset=utf-8");
      return res.end(body);
    }
    return sendText(res, 404, "Not Found");
  }
}

function readJsonBody(req, maxBytes) {
  return new Promise((resolveBody, rejectBody) => {
    const chunks = [];
    let size = 0;
    req.on("data", (chunk) => {
      size += chunk.length;
      if (size > maxBytes) {
        const error = new Error("Запит завеликий");
        error.statusCode = 413;
        rejectBody(error);
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => {
      try {
        const text = Buffer.concat(chunks).toString("utf8");
        resolveBody(JSON.parse(text || "{}"));
      } catch {
        const error = new Error("Некоректний формат даних");
        error.statusCode = 400;
        rejectBody(error);
      }
    });
    req.on("error", rejectBody);
  });
}

function consumeRateLimit(ip) {
  const now = Date.now();
  const windowMs = 10 * 60 * 1000;
  const maxRequests = 8;
  const previous = rateLimits.get(ip) || [];
  const recent = previous.filter((timestamp) => now - timestamp < windowMs);
  if (recent.length >= maxRequests) return false;
  recent.push(now);
  rateLimits.set(ip, recent);

  if (rateLimits.size > 5000) {
    for (const [key, timestamps] of rateLimits) {
      if (!timestamps.some((timestamp) => now - timestamp < windowMs)) rateLimits.delete(key);
    }
  }
  return true;
}

function getClientIp(req) {
  const forwarded = String(req.headers["x-forwarded-for"] || "").split(",")[0].trim();
  return forwarded || req.socket.remoteAddress || "unknown";
}

function cleanInput(value, maxLength) {
  return String(value ?? "").replace(/[\u0000-\u001F\u007F]/g, " ").replace(/\s+/g, " ").trim().slice(0, maxLength);
}

function escapeHtml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

function formatMoney(value) {
  return `${Number(value).toLocaleString("uk-UA", {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  })} грн`;
}

function roundMoney(value) {
  return Math.round((Number(value) + Number.EPSILON) * 100) / 100;
}

function formatDeliveryDate(value) {
  const date = new Date(`${value}T12:00:00`);
  return Number.isNaN(date.getTime())
    ? value
    : new Intl.DateTimeFormat("uk-UA", { dateStyle: "long" }).format(date);
}

function createOrderId() {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Europe/Kyiv",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
  }).formatToParts(new Date());
  const values = Object.fromEntries(parts.map(({ type, value }) => [type, value]));
  return `BH-${values.year}${values.month}${values.day}-${values.hour}${values.minute}${values.second}-${randomInt(100, 1000)}`;
}

function sendJson(res, statusCode, payload) {
  const body = JSON.stringify(payload);
  res.statusCode = statusCode;
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  res.setHeader("Cache-Control", "no-store");
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.end(body);
}

function sendText(res, statusCode, text) {
  res.statusCode = statusCode;
  res.setHeader("Content-Type", "text/plain; charset=utf-8");
  res.end(text);
}

function loadDotEnv(filePath) {
  if (!existsSync(filePath)) return;
  const content = readFileSync(filePath, "utf8");
  for (const rawLine of content.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;
    const equals = line.indexOf("=");
    if (equals < 1) continue;
    const key = line.slice(0, equals).trim();
    let value = line.slice(equals + 1).trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    if (!(key in process.env)) process.env[key] = value;
  }
}
