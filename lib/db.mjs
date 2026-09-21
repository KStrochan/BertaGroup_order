// Сховище клієнтів і замовлень.
//
// Два взаємозамінні варіанти з однаковим API:
//   - Upstash Redis — для продакшену (вмикається, коли задано
//     UPSTASH_REDIS_REST_URL і UPSTASH_REDIS_REST_TOKEN);
//   - локальні JSON-файли в ./data — для розробки на комп'ютері.
//
// Як дані лежать у Redis. Кожен запис — окремий ключ, тому два одночасні
// запити (дві реєстрації, два замовлення) не можуть затерти один одного, а
// кожен запит читає лише те, що йому потрібно, а не весь список:
//
//   berta:user:<userId>          JSON клієнта
//   berta:userphone:<phone>      userId; створюється через SET NX, тому телефон унікальний
//   berta:users:all              sorted set: усі userId, оцінка = час створення
//   berta:order:<orderId>        JSON замовлення
//   berta:orders:all             sorted set: усі orderId, оцінка = час створення
//   berta:orders:user:<userId>   sorted set: orderId замовлень одного клієнта
//   berta:schema                 "2" після переносу даних зі старого формату
//
// Старий формат (v1) — два ключі berta_users і berta_orders, у кожному один
// великий JSON-масив. При першому запуску вони переносяться у нову схему і
// залишаються недоторканими як резервна копія.
//
// Redis-клієнт має бути створений з automaticDeserialization: false — усі
// значення тут зберігаються як звичайні рядки, JSON розбираємо самі.
import { join } from "node:path";
import { createJsonCollection } from "./store.mjs";

export const ORDER_HISTORY_LIMIT = 500;

export class DuplicatePhoneError extends Error {
  constructor() {
    super("Phone number is already registered");
    this.name = "DuplicatePhoneError";
  }
}

const SCHEMA_KEY = "berta:schema";
const SCHEMA_VERSION = "2";
const LEGACY_USERS_KEY = "berta_users";
const LEGACY_ORDERS_KEY = "berta_orders";
const MIGRATION_BATCH_SIZE = 20;

const USERS_ALL = "berta:users:all";
const ORDERS_ALL = "berta:orders:all";
const userKey = (id) => `berta:user:${id}`;
const phoneKey = (phone) => `berta:userphone:${phone}`;
const orderKey = (id) => `berta:order:${id}`;
const userOrdersKey = (userId) => `berta:orders:user:${userId}`;

function toScore(isoDate) {
  const ms = Date.parse(isoDate);
  return Number.isFinite(ms) ? ms : 0;
}

// null, якщо запису немає або він пошкоджений (краще пропустити один
// запис, ніж повалити запит).
function decodeRecord(raw) {
  if (raw === null || raw === undefined) return null;
  if (typeof raw !== "string") return raw;
  try {
    return JSON.parse(raw);
  } catch (error) {
    console.error("Не вдалося розібрати запис із Redis:", error);
    return null;
  }
}

export function createStorage({ redis, dataDir }) {
  return redis ? createRedisStorage(redis) : createLocalStorage(dataDir);
}

// ---------------------------------------------------------------- Redis ----

function createRedisStorage(redis) {
  async function findUserById(id) {
    if (!id) return null;
    return decodeRecord(await redis.get(userKey(id)));
  }

  async function findUserByPhone(phone) {
    if (!phone) return null;
    const id = await redis.get(phoneKey(phone));
    return id ? findUserById(String(id)) : null;
  }

  async function createUser(user) {
    // Спершу пишемо сам запис, потім "займаємо" телефон. SET NX атомарний:
    // якщо двоє реєструються з одним номером одночасно, другий отримає відмову.
    await redis.set(userKey(user.id), JSON.stringify(user));
    const claimed = await redis.set(phoneKey(user.phone), user.id, { nx: true });
    if (claimed !== "OK") {
      await redis.del(userKey(user.id));
      throw new DuplicatePhoneError();
    }
    await redis.zadd(USERS_ALL, { score: toScore(user.createdAt), member: user.id });
    return user;
  }

  async function addOrder(order) {
    const score = toScore(order.createdAt);
    const tx = redis.multi();
    tx.set(orderKey(order.id), JSON.stringify(order));
    tx.zadd(ORDERS_ALL, { score, member: order.id });
    if (order.userId) tx.zadd(userOrdersKey(order.userId), { score, member: order.id });
    await tx.exec();
    return order;
  }

  async function listOrdersByUser(userId, limit = ORDER_HISTORY_LIMIT) {
    if (!userId) return [];
    const ids = await redis.zrange(userOrdersKey(userId), 0, limit - 1, { rev: true });
    if (!ids || ids.length === 0) return [];
    const rows = await redis.mget(...ids.map((id) => orderKey(id)));
    return rows.map(decodeRecord).filter(Boolean);
  }

  async function init() {
    await redis.ping();
    return migrateLegacyBlobs(redis);
  }

  return { kind: "upstash-redis", init, findUserById, findUserByPhone, createUser, addOrder, listOrdersByUser };
}

// Переносить дані зі старого формату (два великі JSON-масиви) у нову схему.
// Безпечно запускати повторно: записи просто перезаписуються, а зайняті
// телефони (SET NX) пропускаються. Щоб перенести ще раз, видаліть ключ
// berta:schema і перезапустіть сервер.
async function migrateLegacyBlobs(redis) {
  if ((await redis.get(SCHEMA_KEY)) === SCHEMA_VERSION) return { migrated: false, users: 0, orders: 0 };

  const legacyUsers = readLegacyList(LEGACY_USERS_KEY, await redis.get(LEGACY_USERS_KEY));
  const legacyOrders = readLegacyList(LEGACY_ORDERS_KEY, await redis.get(LEGACY_ORDERS_KEY));

  let users = 0;
  for (const batch of chunk(legacyUsers, MIGRATION_BATCH_SIZE)) {
    const pipe = redis.pipeline();
    let queued = 0;
    for (const user of batch) {
      if (!user?.id || !user?.phone) continue;
      pipe.set(userKey(user.id), JSON.stringify(user));
      pipe.set(phoneKey(user.phone), user.id, { nx: true });
      pipe.zadd(USERS_ALL, { score: toScore(user.createdAt), member: user.id });
      queued += 1;
    }
    if (queued > 0) await pipe.exec();
    users += queued;
  }

  let orders = 0;
  for (const batch of chunk(legacyOrders, MIGRATION_BATCH_SIZE)) {
    const pipe = redis.pipeline();
    let queued = 0;
    for (const order of batch) {
      if (!order?.id) continue;
      const score = toScore(order.createdAt);
      pipe.set(orderKey(order.id), JSON.stringify(order));
      pipe.zadd(ORDERS_ALL, { score, member: order.id });
      if (order.userId) pipe.zadd(userOrdersKey(order.userId), { score, member: order.id });
      queued += 1;
    }
    if (queued > 0) await pipe.exec();
    orders += queued;
  }

  await redis.set(SCHEMA_KEY, SCHEMA_VERSION);
  return { migrated: true, users, orders };
}

function readLegacyList(key, raw) {
  if (!raw) return [];
  try {
    const parsed = typeof raw === "string" ? JSON.parse(raw) : raw;
    if (Array.isArray(parsed)) return parsed;
    console.error(`Redis key "${key}" не є масивом, ігноруємо.`);
  } catch (error) {
    console.error(`Не вдалося розібрати дані Redis для ключа "${key}":`, error);
  }
  return [];
}

function chunk(list, size) {
  const chunks = [];
  for (let i = 0; i < list.length; i += size) chunks.push(list.slice(i, i + size));
  return chunks;
}

// ----------------------------------------------------------- JSON-файли ----

function createLocalStorage(dataDir) {
  const users = createJsonCollection(join(dataDir, "users.json"), { defaultValue: [] });
  const orders = createJsonCollection(join(dataDir, "orders.json"), { defaultValue: [] });

  return {
    kind: "local-json",
    async init() {
      return { migrated: false, users: 0, orders: 0 };
    },
    async findUserById(id) {
      return (await users.all()).find((user) => user.id === id) || null;
    },
    async findUserByPhone(phone) {
      return (await users.all()).find((user) => user.phone === phone) || null;
    },
    async createUser(user) {
      await users.mutate((list) => {
        if (list.some((existing) => existing.phone === user.phone)) throw new DuplicatePhoneError();
        list.push(user);
        return list;
      });
      return user;
    },
    async addOrder(order) {
      await orders.mutate((list) => {
        list.push(order);
        return list;
      });
      return order;
    },
    async listOrdersByUser(userId, limit = ORDER_HISTORY_LIMIT) {
      if (!userId) return [];
      return (await orders.all())
        .filter((order) => order.userId === userId)
        .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
        .slice(0, limit);
    },
  };
}
