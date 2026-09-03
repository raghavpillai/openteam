import { ApiError, TODO_MAX_ITEMS, type TodoWriteInput } from "@openteam/contracts";
import type { PrismaClient } from "@openteam/db";
import { appendEvent } from "./service-utils";

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
        await tx.todoItem.deleteMany({ where: { botId } });
        await tx.todoItem.createMany({
          data: incoming.map((todo, position) => ({ botId, position, ...todo })),
        });
      } else {
        const [matching, last, existingCount] = await Promise.all([
          tx.todoItem.findMany({
            where: { botId, id: { in: incomingIds } },
            select: { id: true, position: true },
          }),
          tx.todoItem.findFirst({
            where: { botId },
            orderBy: { position: "desc" },
            select: { position: true },
          }),
          tx.todoItem.count({ where: { botId } }),
        ]);
        const positions = new Map(matching.map((todo) => [todo.id, todo.position]));
        const newCount = incoming.length - positions.size;
        if (newCount > Math.max(0, TODO_MAX_ITEMS - existingCount)) {
          throw new ApiError(
            400,
            "todo_limit_exceeded",
            `A task queue can contain at most ${TODO_MAX_ITEMS} items`
          );
        }
        let nextPosition = (last?.position ?? -1) + 1;
        const merged = incoming.map((todo) => ({
          botId,
          position: positions.get(todo.id) ?? nextPosition++,
          ...todo,
        }));
        await tx.todoItem.deleteMany({ where: { botId, id: { in: incomingIds } } });
        await tx.todoItem.createMany({ data: merged });
      }
      await appendEvent(tx, "todo.updated", botId, {
        botId,
        callId,
        merge: input.merge,
        updatedIds: incomingIds,
      });
      return tx.todoItem.findMany({
        where: { botId },
        orderBy: { position: "asc" },
        take: TODO_MAX_ITEMS,
      });
    });
    return {
      todos: todos.map(({ id, content, status }) => ({ id, content, status })),
      merge: input.merge,
    };
  }
}
