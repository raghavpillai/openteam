import { describe, expect, test } from "bun:test";
import { TodoService, uniqueTodoInputs } from "../src/services/todo-service";

type Row = {
  botId: string;
  id: string;
  content: string;
  status: "pending" | "in_progress" | "completed" | "cancelled";
  position: number;
};

const todoFixture = (initial: Row[]) => {
  let rows = initial.map((row) => ({ ...row }));
  const events: Array<Record<string, unknown>> = [];
  const operations = { deleteMany: 0, createMany: 0, upsert: 0 };
  const tx = {
    $executeRaw: async () => 1,
    todoItem: {
      findMany: async (args: {
        where: { botId: string; id?: { in: string[] } };
        select?: { id: true; position: true };
        take?: number;
      }) => {
        const selected = rows.filter(
          (row) =>
            row.botId === args.where.botId && (!args.where.id || args.where.id.in.includes(row.id))
        );
        if (args.select) {
          return selected.map(({ id, position }) => ({ id, position }));
        }
        return selected
          .sort((left, right) => left.position - right.position)
          .slice(0, args.take ?? selected.length);
      },
      findFirst: async (args: { where: { botId: string } }) =>
        rows
          .filter((row) => row.botId === args.where.botId)
          .sort((left, right) => right.position - left.position)[0] ?? null,
      count: async (args: { where: { botId: string } }) =>
        rows.filter((row) => row.botId === args.where.botId).length,
      deleteMany: async (args: { where: { botId: string; id?: { in: string[] } } }) => {
        operations.deleteMany += 1;
        rows = rows.filter(
          (row) =>
            row.botId !== args.where.botId ||
            (args.where.id !== undefined && !args.where.id.in.includes(row.id))
        );
      },
      createMany: async (args: { data: Row[] }) => {
        operations.createMany += 1;
        rows.push(...args.data.map((row) => ({ ...row })));
      },
      upsert: async () => {
        operations.upsert += 1;
        throw new Error("serial upsert should not be used");
      },
    },
    event: {
      create: async ({ data }: { data: Record<string, unknown> }) => {
        events.push(data);
        return data;
      },
    },
  };
  const prisma = { $transaction: async (run: (transaction: typeof tx) => unknown) => run(tx) };
  return {
    events,
    operations,
    rows: () => rows.sort((left, right) => left.position - right.position),
    service: new TodoService(prisma as never),
  };
};

describe("bounded set-based TodoWrite persistence", () => {
  test("deduplicates in linear first-write order", () => {
    expect(
      uniqueTodoInputs([
        { id: "a", content: "first", status: "pending" },
        { id: "b", content: "second", status: "in_progress" },
        { id: "a", content: "ignored", status: "completed" },
      ])
    ).toEqual([
      { id: "a", content: "first", status: "pending" },
      { id: "b", content: "second", status: "in_progress" },
    ]);
  });

  test("merge preserves positions and uses one bounded set replacement", async () => {
    const fixture = todoFixture([
      { botId: "bot-1", id: "keep", content: "Keep", status: "pending", position: 0 },
      { botId: "bot-1", id: "update", content: "Old", status: "pending", position: 1 },
    ]);

    const result = await fixture.service.write("bot-1", "call-1", {
      merge: true,
      todos: [
        { id: "update", content: "New", status: "completed" },
        { id: "new", content: "Appended", status: "in_progress" },
        { id: "update", content: "Ignored duplicate", status: "cancelled" },
      ],
    });

    expect(result.todos).toEqual([
      { id: "keep", content: "Keep", status: "pending" },
      { id: "update", content: "New", status: "completed" },
      { id: "new", content: "Appended", status: "in_progress" },
    ]);
    expect(fixture.rows().map(({ id, position }) => ({ id, position }))).toEqual([
      { id: "keep", position: 0 },
      { id: "update", position: 1 },
      { id: "new", position: 2 },
    ]);
    expect(fixture.operations).toEqual({ deleteMany: 1, createMany: 1, upsert: 0 });
    expect(fixture.events[0]).toMatchObject({
      topic: "todo.updated",
      payload: { updatedIds: ["update", "new"] },
    });
  });

  test("replace keeps first duplicate and incoming order", async () => {
    const fixture = todoFixture([
      { botId: "bot-1", id: "old", content: "Old", status: "pending", position: 0 },
    ]);
    const result = await fixture.service.write("bot-1", "call-2", {
      merge: false,
      todos: [
        { id: "b", content: "First B", status: "pending" },
        { id: "a", content: "A", status: "completed" },
        { id: "b", content: "Ignored B", status: "cancelled" },
      ],
    });

    expect(result.todos).toEqual([
      { id: "b", content: "First B", status: "pending" },
      { id: "a", content: "A", status: "completed" },
    ]);
    expect(fixture.operations).toEqual({ deleteMany: 1, createMany: 1, upsert: 0 });
  });

  test("rejects a merge that would grow the durable queue past its contract cap", async () => {
    const fixture = todoFixture(
      Array.from({ length: 64 }, (_, index) => ({
        botId: "bot-1",
        id: `existing-${index}`,
        content: "Existing",
        status: "pending" as const,
        position: index,
      }))
    );

    await expect(
      fixture.service.write("bot-1", "call-3", {
        merge: true,
        todos: [
          { id: "existing-0", content: "Updated", status: "completed" },
          { id: "overflow", content: "Too many", status: "pending" },
        ],
      })
    ).rejects.toThrow("at most 64 items");
    expect(fixture.operations).toEqual({ deleteMany: 0, createMany: 0, upsert: 0 });
  });
});
