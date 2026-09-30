import { type TodoWriteInput } from "@openteam/contracts";
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
      return tx.todoItem.findMany({
        where: { botId },
        orderBy: { position: "asc" },
      });
    });
    return {
      todos: todos.map(({ id, content, status }) => ({ id, content, status })),
      merge: input.merge,
    };
  }
}
