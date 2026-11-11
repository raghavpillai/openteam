/** Frames the RFB 3.8/VNC-auth client stream, independently of WebSocket boundaries.
 * The computer's x11vnc endpoint uses this protocol. Unknown extensions fail closed.
 */
export class RfbClientMessages {
  private bytes = Buffer.alloc(0);
  private phase: "version" | "security" | "auth" | "init" | "messages" = "version";
  push(chunk: Uint8Array): Array<{ data: Uint8Array; input: boolean }> {
    this.bytes = Buffer.concat([this.bytes, chunk]);
    if (this.bytes.length > 1_048_576) throw new Error("Computer input is too large");
    const result: Array<{ data: Uint8Array; input: boolean }> = [];
    while (this.bytes.length) {
      let size: number;
      let input = false;
      if (this.phase === "version") {
        size = 12;
        if (this.bytes.length < size) break;
        if (this.bytes.subarray(0, 12).toString() !== "RFB 003.008\n")
          throw new Error("Unsupported RFB protocol");
        this.phase = "security";
      } else if (this.phase === "security") {
        size = 1;
        if (this.bytes[0] !== 1 && this.bytes[0] !== 2)
          throw new Error("Unsupported RFB authentication");
        this.phase = this.bytes[0] === 2 ? "auth" : "init";
      } else if (this.phase === "auth") {
        size = 16;
        if (this.bytes.length < size) break;
        this.phase = "init";
      } else if (this.phase === "init") {
        size = 1;
        this.phase = "messages";
      } else {
        const type = this.bytes[0];
        const header = (
          {
            0: 20,
            2: 4,
            3: 10,
            4: 8,
            5: 6,
            6: 8,
            150: 10,
            248: 9,
            250: 4,
            251: 8,
            255: 12,
          } as Record<number, number>
        )[type!];
        if (!header) throw new Error("Unsupported RFB client message");
        if (this.bytes.length < header) break;
        size =
          type === 2
            ? 4 + 4 * this.bytes.readUInt16BE(2)
            : type === 6
              ? 8 + Math.abs(this.bytes.readInt32BE(4))
              : type === 248
                ? 9 + this.bytes[8]!
                : type === 251
                  ? 8 + 16 * this.bytes[6]!
                  : type === 5 && this.bytes[1]! & 0x80
                    ? 7
                    : header;
        if (size > 1_048_576) throw new Error("Computer input is too large");
        if (this.bytes.length < size) break;
        input = [4, 5, 6, 250, 251, 255].includes(type!);
      }
      result.push({ data: this.bytes.subarray(0, size), input });
      this.bytes = this.bytes.subarray(size);
    }
    return result;
  }
}
