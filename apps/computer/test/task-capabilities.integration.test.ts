import { expect, test } from "bun:test";

// Run against a built computer image with scripts/test-computer-image.sh IMAGE.
// This exercises the packaged gateway and binaries, rather than a mocked capability.
const gateway = process.env.OPENTEAM_COMPUTER_TEST_URL;

test.skipIf(!gateway)(
  "the packaged computer advertises its desktop to Task workers",
  async () => {
    const deadline = Date.now() + 30_000;
    let response: Response | undefined;
    while (!response) {
      try {
        response = await fetch(new URL("/v1/task-capabilities", gateway), {
          headers: { authorization: `Bearer ${process.env.OPENTEAM_CONTROL_TOKEN}` },
          signal: AbortSignal.timeout(2_000),
        });
      } catch (error) {
        if (Date.now() >= deadline) throw error;
        await Bun.sleep(100);
      }
    }
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ boxAvailable: true, desktopAvailable: true });
  },
  35_000
);
