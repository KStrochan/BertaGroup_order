// Minimal JSON-file "database". No external dependencies, matches the rest
// of this project's style. Good enough for a small B2B client list; if you
// ever outgrow it, the read/write API here is small enough to swap for a
// real database without touching server.mjs.
import { mkdir, readFile, writeFile, rename } from "node:fs/promises";
import { dirname } from "node:path";

const writeQueues = new Map();

async function ensureDir(filePath) {
  await mkdir(dirname(filePath), { recursive: true });
}

async function readJsonFile(filePath, fallback) {
  try {
    const text = await readFile(filePath, "utf8");
    return JSON.parse(text);
  } catch (error) {
    if (error.code === "ENOENT") return fallback;
    throw error;
  }
}

async function writeJsonFile(filePath, data) {
  await ensureDir(filePath);
  const tmpPath = `${filePath}.tmp`;
  await writeFile(tmpPath, JSON.stringify(data, null, 2), "utf8");
  await rename(tmpPath, filePath); // atomic on the same filesystem
}

// Queues writes per-file so two concurrent requests can't interleave and
// corrupt the file (the http server here handles requests concurrently).
function withWriteLock(filePath, task) {
  const previous = writeQueues.get(filePath) || Promise.resolve();
  const next = previous.then(task, task);
  writeQueues.set(filePath, next.catch(() => {}));
  return next;
}

export function createJsonCollection(filePath, { defaultValue = [] } = {}) {
  let cache = null;

  async function load() {
    if (cache === null) cache = await readJsonFile(filePath, defaultValue);
    return cache;
  }

  async function save(nextValue) {
    cache = nextValue;
    return withWriteLock(filePath, () => writeJsonFile(filePath, nextValue));
  }

  return {
    async all() {
      const value = await load();
      return Array.isArray(value) ? [...value] : value;
    },
    async mutate(mutator) {
      const value = await load();
      const next = await mutator(value);
      await save(next ?? value);
      return next ?? value;
    },
  };
}
