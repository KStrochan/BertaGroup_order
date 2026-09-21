// Запуск: npm test (Node 20+, без додаткових залежностей).
// Redis тут підмінений простою копією в пам'яті, тож справжня база не потрібна
// і нічого не витрачається з ліміту Upstash.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createStorage, DuplicatePhoneError } from "../lib/db.mjs";

// Мінімальна імітація клієнта @upstash/redis: лише те, чим користується lib/db.mjs.
function createFakeRedis() {
  const strings = new Map();
  const zsets = new Map();

  const commands = {
    async ping() {
      return "PONG";
    },
    async get(key) {
      await Promise.resolve();
      return strings.has(key) ? strings.get(key) : null;
    },
    async set(key, value, opts = {}) {
      await Promise.resolve();
      if (opts.nx && strings.has(key)) return null;
      strings.set(key, typeof value === "string" ? value : JSON.stringify(value));
      return "OK";
    },
    async del(...keys) {
      await Promise.resolve();
      return keys.filter((key) => strings.delete(key)).length;
    },
    async mget(...keys) {
      await Promise.resolve();
      return keys.map((key) => (strings.has(key) ? strings.get(key) : null));
    },
    async zadd(key, { score, member }) {
      await Promise.resolve();
      const zset = zsets.get(key) ?? new Map();
      zsets.set(key, zset);
      const isNew = !zset.has(member);
      zset.set(member, score);
      return isNew ? 1 : 0;
    },
    async zrange(key, start, stop, { rev = false } = {}) {
      await Promise.resolve();
      const zset = zsets.get(key);
      if (!zset) return [];
      const sorted = [...zset.entries()].sort((a, b) => a[1] - b[1] || a[0].localeCompare(b[0]));
      if (rev) sorted.reverse();
      return sorted.slice(start, stop === -1 ? undefined : stop + 1).map(([member]) => member);
    },
  };

  function batch() {
    const queue = [];
    const builder = {
      set: (...args) => (queue.push(["set", args]), builder),
      zadd: (...args) => (queue.push(["zadd", args]), builder),
      async exec() {
        const results = [];
        for (const [name, args] of queue) results.push(await commands[name](...args));
        return results;
      },
    };
    return builder;
  }

  return { ...commands, pipeline: batch, multi: batch, strings };
}

const makeUser = (n, overrides = {}) => ({
  id: `user-${n}`,
  phone: `38067000000${n}`,
  company: `Company ${n}`,
  contact: "Contact",
  passwordHash: "salt:hash",
  createdAt: new Date(Date.UTC(2026, 0, 1, 0, 0, n)).toISOString(),
  ...overrides,
});

const makeOrder = (id, userId, second) => ({
  id,
  userId,
  createdAt: new Date(Date.UTC(2026, 0, 1, 0, 0, second)).toISOString(),
  total: 100,
  items: [],
});

// Обидва варіанти сховища мають поводитися однаково.
const backends = {
  "upstash-redis": async () => ({
    storage: createStorage({ redis: createFakeRedis(), dataDir: "" }),
    cleanup: async () => {},
  }),
  "local-json": async () => {
    const dir = await mkdtemp(join(tmpdir(), "berta-test-"));
    return {
      storage: createStorage({ redis: null, dataDir: dir }),
      cleanup: () => rm(dir, { recursive: true, force: true }),
    };
  },
};

for (const [name, open] of Object.entries(backends)) {
  test(`${name}: клієнта можна знайти за id і за телефоном`, async () => {
    const { storage, cleanup } = await open();
    try {
      await storage.init();
      const user = makeUser(1);
      await storage.createUser(user);
      assert.deepEqual(await storage.findUserById(user.id), user);
      assert.deepEqual(await storage.findUserByPhone(user.phone), user);
      assert.equal(await storage.findUserById("nope"), null);
      assert.equal(await storage.findUserByPhone("000000000"), null);
    } finally {
      await cleanup();
    }
  });

  test(`${name}: два одночасні запити з одним телефоном — зареєструється лише один`, async () => {
    const { storage, cleanup } = await open();
    try {
      await storage.init();
      const results = await Promise.allSettled([
        storage.createUser(makeUser(1, { id: "first" })),
        storage.createUser(makeUser(1, { id: "second" })),
      ]);
      const fulfilled = results.filter((r) => r.status === "fulfilled");
      const rejected = results.filter((r) => r.status === "rejected");
      assert.equal(fulfilled.length, 1);
      assert.equal(rejected.length, 1);
      assert.ok(rejected[0].reason instanceof DuplicatePhoneError);

      const winner = await storage.findUserByPhone(makeUser(1).phone);
      assert.equal(winner.id, fulfilled[0].value.id);
      const loserId = winner.id === "first" ? "second" : "first";
      assert.equal(await storage.findUserById(loserId), null);
    } finally {
      await cleanup();
    }
  });

  test(`${name}: історія замовлень — лише свої, від нових до старих`, async () => {
    const { storage, cleanup } = await open();
    try {
      await storage.init();
      await storage.addOrder(makeOrder("BH-1", "user-1", 10));
      await storage.addOrder(makeOrder("BH-3", "user-1", 30));
      await storage.addOrder(makeOrder("BH-2", "user-1", 20));
      await storage.addOrder(makeOrder("BH-other", "user-2", 40));
      await storage.addOrder(makeOrder("BH-guest", null, 50));

      const mine = await storage.listOrdersByUser("user-1");
      assert.deepEqual(mine.map((order) => order.id), ["BH-3", "BH-2", "BH-1"]);
      assert.equal((await storage.listOrdersByUser("user-1", 2)).length, 2);
      assert.deepEqual(await storage.listOrdersByUser("user-without-orders"), []);
      assert.deepEqual(await storage.listOrdersByUser(null), []);
    } finally {
      await cleanup();
    }
  });
}

test("upstash-redis: дані зі старого формату переносяться один раз і залишаються як резерв", async () => {
  const redis = createFakeRedis();
  const users = [makeUser(1), makeUser(2)];
  const orders = [makeOrder("BH-1", "user-1", 10), makeOrder("BH-2", "user-1", 20), makeOrder("BH-guest", null, 30)];
  await redis.set("berta_users", JSON.stringify(users));
  await redis.set("berta_orders", JSON.stringify(orders));

  const storage = createStorage({ redis, dataDir: "" });
  assert.deepEqual(await storage.init(), { migrated: true, users: 2, orders: 3 });

  assert.deepEqual(await storage.findUserByPhone(users[1].phone), users[1]);
  const history = await storage.listOrdersByUser("user-1");
  assert.deepEqual(history.map((order) => order.id), ["BH-2", "BH-1"]);
  assert.equal(await redis.get("berta:schema"), "2");
  assert.ok(await redis.get("berta_users"), "старий ключ не видаляється");
  assert.ok(await redis.get("berta_orders"), "старий ключ не видаляється");

  // Другий запуск нічого не переносить.
  assert.equal((await storage.init()).migrated, false);
});

test("upstash-redis: порожня база і пошкоджені старі дані не валять запуск", async () => {
  const empty = createStorage({ redis: createFakeRedis(), dataDir: "" });
  assert.deepEqual(await empty.init(), { migrated: true, users: 0, orders: 0 });

  const redis = createFakeRedis();
  await redis.set("berta_users", "це не JSON");
  await redis.set("berta_orders", JSON.stringify({ не: "масив" }));
  const broken = createStorage({ redis, dataDir: "" });
  const originalError = console.error;
  console.error = () => {};
  try {
    assert.deepEqual(await broken.init(), { migrated: true, users: 0, orders: 0 });
  } finally {
    console.error = originalError;
  }
});
