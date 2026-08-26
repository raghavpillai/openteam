import type { TodoWriteInput } from "@openbot/contracts";
import type { PrismaClient } from "@openbot/db";
import { appendEvent } from "./service-utils";

export class TodoService {
  constructor(private readonly prisma: PrismaClient) {}

  async write(botId: string, callId: string, input: TodoWriteInput) {
    const todos = await this.prisma.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`todos:${botId}`}))`;
      const byId = new Map(input.todos.map((todo) => [todo.id, todo]));
      const incoming = input.todos.filter(
        (todo, index) => input.todos.findIndex((candidate) => candidate.id === todo.id) === index
      );
      if (!input.merge) {
        await tx.todoItem.deleteMany({ where: { botId } });
        await tx.todoItem.createMany({
          data: incoming.map((todo, position) => ({ botId, position, ...todo })),
        });
      } else {
        const existing = await tx.todoItem.findMany({
          where: { botId },
          orderBy: { position: "asc" },
        });
        let nextPosition = existing.reduce((max, todo) => Math.max(max, todo.position), -1) + 1;
        const positions = new Map(existing.map((todo) => [todo.id, todo.position]));
        for (const todo of incoming) {
          const position = positions.get(todo.id) ?? nextPosition++;
          await tx.todoItem.upsert({
            where: { botId_id: { botId, id: todo.id } },
            create: { botId, position, ...todo },
            update: { content: todo.content, status: todo.status },
          });
        }
      }
      await appendEvent(tx, "todo.updated", botId, {
        botId,
        callId,
        merge: input.merge,
        updatedIds: [...byId.keys()],
      });
      return tx.todoItem.findMany({ where: { botId }, orderBy: { position: "asc" } });
    });
    return {
      todos: todos.map(({ id, content, status }) => ({ id, content, status })),
      merge: input.merge,
    };
  }
}
