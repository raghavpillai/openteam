import type { Prisma } from "@openteam/db";

/** Public transcript addresses are distinct from private database IDs. */
export async function nextMessageAddress(tx: Prisma.TransactionClient, channelId: string, sender: "user" | "agent") {
  await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`transcript-address:${channelId}`}))`;
  const users = await tx.channelMessage.count({where:{channelId,sender:"user"}});
  if (sender === "user") return `t${users}u`;
  const last = await tx.channelMessage.findFirst({where:{channelId,sender:"user"},orderBy:{sequence:"desc"},select:{sequence:true}});
  let index = await tx.channelMessage.count({where:{channelId,sender:"agent",...(last ? {sequence:{gt:last.sequence}} : {})}});
  const turn = users ? users - 1 : 0;
  while (await tx.channelMessage.findFirst({where:{channelId,metadata:{path:["address"],equals:`t${turn}s${index}`}},select:{id:true}})) index++;
  return `t${turn}s${index}`;
}

export async function resolveMessageAddress(tx: Prisma.TransactionClient, channelId: string, address: string) {
  const exact = await tx.channelMessage.findFirst({where:{channelId,metadata:{path:["address"],equals:address}}});
  if (exact) return exact;
  // Messages without a transcript address (system rows) are addressed by id.
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(address)) return null;
  return tx.channelMessage.findFirst({where:{channelId,id:address}});
}
