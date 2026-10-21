import { type TodoWriteInput } from "@openteam/contracts";
import type { PrismaClient } from "@openteam/db";
import { appendEvent } from "./service-utils";

/** Finished todos kept per bot, newest first, as in the reference. */
export const MAX_FINISHED_TODOS = 50;

/** The finished todos beyond the newest MAX_FINISHED_TODOS; ties go to the later position. */
export const prunedFinishedTodoIds = (
  todos: ReadonlyArray<{ id: string; status: string; position: number; updatedAt?: Date }>
): string[] =>
  todos
    .filter((todo) => todo.status === "completed" || todo.status === "cancelled")
    .sort((left, right) =>
      (right.updatedAt?.getTime() ?? 0) - (left.updatedAt?.getTime() ?? 0) || right.position - left.position)
    .slice(MAX_FINISHED_TODOS)
    .map((todo) => todo.id);

export const uniqueTodoInputs = (todos: TodoWriteInput["todos"]) => {
  const seen = new Set<string>();
  return todos.filter((todo) => {
    if (seen.has(todo.id)) return false;
    seen.add(todo.id);
    return true;
  });
};

export class TodoService {
  constructor(private readonly prisma: PrismaClient) {}

  async write(botId: string, callId: string, input: TodoWriteInput) {
    const todos = await this.prisma.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`todos:${botId}`}))`;
      const incoming = uniqueTodoInputs(input.todos);
      const incomingIds = incoming.map((todo) => todo.id);
      if (!input.merge) {
        const complete = incoming.map(todo => {
          if (todo.content === undefined || todo.status === undefined)
            throw new Error("Replacement tasks require content and status");
          return { id: todo.id, content: todo.content, status: todo.status };
        });
        await tx.todoItem.deleteMany({ where: { botId } });
        await tx.todoItem.createMany({
          data: complete.map((todo, position) => ({ botId, position, ...todo })),
        });
      } else {
        const [matching, last] = await Promise.all([
          tx.todoItem.findMany({
            where: { botId, id: { in: incomingIds } },
            select: { id: true, position: true, content: true, status: true },
          }),
          tx.todoItem.findFirst({
            where: { botId },
            orderBy: { position: "desc" },
            select: { position: true },
          }),
        ]);
        const existing = new Map(matching.map((todo) => [todo.id, todo]));
        let nextPosition = (last?.position ?? -1) + 1;
        const merged = incoming.map((todo) => {
          const previous = existing.get(todo.id);
          const content = todo.content ?? previous?.content;
          const status = todo.status ?? previous?.status;
          if (content === undefined || status === undefined)
            throw new Error(`New task ${todo.id} requires content and status`);
          return { botId, id: todo.id, content, status, position: previous?.position ?? nextPosition++ };
        });
        await tx.todoItem.deleteMany({ where: { botId, id: { in: incomingIds } } });
        await tx.todoItem.createMany({ data: merged });
      }
      await appendEvent(tx, "todo.updated", botId, {
        botId,
        callId,
        merge: input.merge,
        updatedIds: incomingIds,
      });
      const current = await tx.todoItem.findMany({
        where: { botId },
        orderBy: { position: "asc" },
      });
      const pruned = prunedFinishedTodoIds(current);
      if (pruned.length === 0) return current;
      await tx.todoItem.deleteMany({ where: { botId, id: { in: pruned } } });
      return current.filter((todo) => !pruned.includes(todo.id));
    });
    return {
      todos: todos.map(({ id, content, status }) => ({ id, content, status })),
      merge: input.merge,
    };
  }
}
