declare module "bplist-parser" {
  const parser: { parseBuffer(value: Buffer): unknown[] };
  export default parser;
}
