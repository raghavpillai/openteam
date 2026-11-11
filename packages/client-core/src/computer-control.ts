import type { ComputerControlSession, ScreenStatusView } from "@openteam/contracts";

/** The transport may disappear for hours. Only an explicit release changes ownership. */
export const ownsComputerControl = (status: ScreenStatusView | null, id: string) =>
  status?.humanTakeover === true && !status.controlPending && status.controlSession?.id === id;

/** Handles closing during acquisition without depending on a later React render. */
export const createComputerControlController = (
  id: string,
  request: (
    active: boolean,
    input: { controlId: string; generation?: number; force?: boolean }
  ) => Promise<ScreenStatusView>
) => {
  let closed = false;
  let owned: ComputerControlSession | null = null;
  let pending: Promise<ScreenStatusView | null> | null = null;
  const release = async (control: ComputerControlSession) =>
    request(false, { controlId: id, generation: control.generation });
  return {
    observe(status: ScreenStatusView) {
      owned =
        !status.controlPending && status.controlSession?.id === id ? status.controlSession : null;
    },
    open() {
      closed = false;
    },
    async take(force = false) {
      if (pending) return pending;
      pending = (async () => {
        const status = await request(true, { controlId: id, force });
        if (status.controlSession?.id !== id)
          throw new Error("Update your OpenTeam server to use persistent computer control.");
        owned = status.controlSession;
        if (closed) {
          await release(owned);
          owned = null;
          return null;
        }
        return status;
      })();
      try {
        return await pending;
      } finally {
        pending = null;
      }
    },
    async giveBack() {
      if (pending) await pending;
      if (!owned) return null;
      const status = await release(owned);
      owned =
        !status.controlPending && status.controlSession?.id === id ? status.controlSession : null;
      return status;
    },
    async close() {
      closed = true;
      if (pending) {
        await pending;
        return;
      }
      if (owned) {
        const control = owned;
        owned = null;
        await release(control);
      }
    },
  };
};
