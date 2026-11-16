import { expect, test } from "bun:test";
import { MAX_FINISHED_TODOS, prunedFinishedTodoIds, TodoService } from "../src/services/todo-service";
import { dbIt } from "./harness";

type Status = "pending" | "in_progress" | "completed" | "cancelled";
const seed = async (h: Parameters<Parameters<typeof dbIt>[1]>[0], todos: Array<{ id: string; content: string; status: Status }>) => {
  const bot = await h.bot("Todos", {}, { dm: false });
  if (todos.length) await h.db.todoItem.createMany({ data: todos.map((todo, position) => ({ botId: bot.id, position, ...todo })) });
  const rows = async () => (await h.db.todoItem.findMany({ where: { botId: bot.id }, orderBy: { position: "asc" } })).map(({ id, content, status, position }) => ({ id, content, status, position }));
  return { botId: bot.id, rows, service: new TodoService(h.db) };
};

dbIt("partial merges preserve unchanged fields and reject incomplete new tasks before mutation", async h => {
  const f = await seed(h, [{ id: "a", content: "Original", status: "pending" }, { id: "b", content: "Neighbor", status: "pending" }]);
  expect((await f.service.write(f.botId, "partial", { merge: true, todos: [{ id: "a", status: "completed" }] })).todos[0]).toEqual({ id: "a", content: "Original", status: "completed" });
  expect((await f.service.write(f.botId, "rename", { merge: true, todos: [{ id: "a", content: "Renamed" }] })).todos[0]).toEqual({ id: "a", content: "Renamed", status: "completed" });
  const before = await f.rows();
  await expect(f.service.write(f.botId, "invalid", { merge: true, todos: [{ id: "a", status: "pending" }, { id: "new", status: "pending" }] })).rejects.toThrow("requires content and status");
  expect(await f.rows()).toEqual(before);
});

dbIt("merge preserves positions, ignores duplicate ids and reports what changed", async h => {
  const f = await seed(h, [{ id: "keep", content: "Keep", status: "pending" }, { id: "update", content: "Old", status: "pending" }]);
  const result = await f.service.write(f.botId, "call-1", { merge: true, todos: [
    { id: "update", content: "New", status: "completed" }, { id: "new", content: "Appended", status: "in_progress" }, { id: "update", content: "Ignored duplicate", status: "cancelled" },
  ] });
  expect(result.todos).toEqual([{ id: "keep", content: "Keep", status: "pending" }, { id: "update", content: "New", status: "completed" }, { id: "new", content: "Appended", status: "in_progress" }]);
  expect((await f.rows()).map(({ id, position }) => ({ id, position }))).toEqual([{ id: "keep", position: 0 }, { id: "update", position: 1 }, { id: "new", position: 2 }]);
  const event = await h.db.event.findFirstOrThrow({ where: { topic: "todo.updated", entityId: f.botId } });
  expect(event.payload).toMatchObject({ updatedIds: ["update", "new"] });
});

test("only the 50 most recently finished todos are kept; open ones always stay", () => {
  expect(MAX_FINISHED_TODOS).toBe(50);
  const at = (minute: number) => new Date(Date.UTC(2026, 9, 20, 0, minute));
  const finished = Array.from({ length: 52 }, (_, position) => ({ id: `done-${position}`, status: position % 2 ? "completed" : "cancelled", position, updatedAt: at(position) }));
  const open = { id: "open", status: "pending", position: 99, updatedAt: at(0) };
  expect(prunedFinishedTodoIds([...finished, open])).toEqual(["done-1", "done-0"]);
  // A todo updated later counts as newer, whatever its position; equal times prefer the later position.
  expect(prunedFinishedTodoIds([...finished.slice(1), { ...finished[0]!, updatedAt: at(90) }])).toEqual(["done-2", "done-1"]);
  expect(prunedFinishedTodoIds(finished.map(todo => ({ ...todo, updatedAt: at(0) })))).toEqual(["done-1", "done-0"]);
});

dbIt("a write past the cap prunes the oldest finished todos", async h => {
  const f = await seed(h, Array.from({ length: 51 }, (_, position) => ({ id: `done-${position}`, content: `done-${position}`, status: "completed" as const })));
  const result = await f.service.write(f.botId, "finish", { merge: true, todos: [{ id: "new", content: "New", status: "completed" }] });
  expect(result.todos).toHaveLength(50);
  expect(result.todos.map(todo => todo.id)).not.toContain("done-0");
  expect(result.todos.map(todo => todo.id)).not.toContain("done-1");
  expect(await f.rows()).toHaveLength(50);
});
