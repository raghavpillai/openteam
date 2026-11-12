import { join, resolve } from "node:path";
import { mkdir } from "node:fs/promises";
import QRCode from "qrcode";
import { configuredService } from "../service";

// Operator-run live tests use a dedicated account ID and persistent directory.
const service = configuredService();
const mode = process.argv[2] ?? "status";
try {
  if (mode === "link") {
    const status = await service.status();
    if (status.linked) throw new Error("This test account is already linked. Run verify next.");
    const session = await service.startLink();
    const directory = resolve("output/signal-validation/private");
    await mkdir(directory, { recursive: true, mode: 0o700 });
    const qrPath = join(directory, `link-${session.sessionId}.png`);
    const png = await QRCode.toDataURL(session.deviceLinkUri, { width: 320, margin: 4 });
    await Bun.write(qrPath, Buffer.from(png.split(",")[1]!, "base64"));
    console.log(JSON.stringify({ stage: "scan-qr", qrPath, expiresAt: session.expiresAt }));
    await service.finishLink(session.sessionId);
    console.log(JSON.stringify({ stage: "linked" }));
  } else if (mode === "verify") {
    if (!(await service.status()).linked)
      throw new Error("Run link and approve the QR code first.");
    const requestId = `signal-validation-${Date.now()}`;
    const message = `OpenTeam Signal validation ${requestId} 🐈`;
    const first = await service.send(requestId, { noteToSelf: true }, message);
    const repeated = await service.send(requestId, { noteToSelf: true }, message);
    if (first.state !== "sent" || !repeated.existing)
      throw new Error("Self-send or duplicate protection failed.");
    console.log(JSON.stringify({ stage: "self-send-check", requestId, sent: true,
      duplicateSuppressed: true, indexed: !!service.store.list({ query: message }).messages.length,
      next: "Send a labeled Note to Self message from the phone to test received synchronization separately." }));
  } else if (mode === "status") {
    const status = await service.status();
    console.log(
      JSON.stringify({
        connected: status.connected,
        linked: status.linked,
        runtimeVersion: status.runtimeVersion,
      })
    );
  } else throw new Error("Choose status, link, or verify.");
} finally {
  await service.close();
}
