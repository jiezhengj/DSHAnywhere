import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, stat, writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SCHEMA_VERSION, Store, emptyState } from "../../packages/plugin/src/store.ts";

async function tempDir(): Promise<string> {
  return await mkdtemp(join(tmpdir(), "dshanywhere-store-"));
}

test("首次加载返回空状态且不建文件", async () => {
  const dir = await tempDir();
  const store = new Store(dir);
  const state = await store.load();
  assert.deepEqual(state, emptyState());
  await assert.rejects(stat(store.file));
});

test("保存后可原样读回", async () => {
  const dir = await tempDir();
  const a = new Store(dir);
  await a.load();
  await a.update((s) => {
    s.installation = { installId: "inst-1" };
    s.stats.success = 3;
  });
  const b = new Store(dir);
  const loaded = await b.load();
  assert.equal(loaded.installation?.installId, "inst-1");
  assert.equal(loaded.stats.success, 3);
});

test("状态文件权限为 0600", async () => {
  const dir = await tempDir();
  const store = new Store(dir);
  await store.load();
  await store.save(emptyState());
  const info = await stat(store.file);
  assert.equal(info.mode & 0o777, 0o600);
});

test("损坏的 JSON 被改名保留并回退为空状态", async () => {
  const dir = await tempDir();
  await mkdir(dir, { recursive: true });
  const store = new Store(dir);
  await writeFile(store.file, "{ 这不是 JSON", "utf8");
  const state = await store.load();
  assert.deepEqual(state, emptyState());
  const entries = (await import("node:fs/promises")).readdir(dir);
  const names = await entries;
  assert.ok(names.some((n) => n.startsWith("state.corrupt-")));
});

test("schemaVersion 不匹配时回退为空状态", async () => {
  const dir = await tempDir();
  const store = new Store(dir);
  await mkdir(dir, { recursive: true });
  await writeFile(store.file, JSON.stringify({ schemaVersion: SCHEMA_VERSION + 1, devices: [] }), "utf8");
  const state = await store.load();
  assert.deepEqual(state, emptyState());
});

test("保存为原子替换：不留下临时文件", async () => {
  const dir = await tempDir();
  const store = new Store(dir);
  await store.load();
  await store.save(emptyState());
  await store.save(emptyState());
  const names = await (await import("node:fs/promises")).readdir(dir);
  assert.deepEqual(names.filter((n) => n.endsWith(".tmp")), []);
  const raw = await readFile(store.file, "utf8");
  assert.equal(JSON.parse(raw).schemaVersion, SCHEMA_VERSION);
});
