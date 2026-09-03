export const COMPUTER_HANDOFF_OPEN_EVENT = "openbot:computer-handoff-open";

export interface ComputerHandoffOpenDetail {
  botId: string;
  messageId: string;
}

export const openComputerHandoff = (detail: ComputerHandoffOpenDetail): void => {
  window.dispatchEvent(
    new CustomEvent<ComputerHandoffOpenDetail>(COMPUTER_HANDOFF_OPEN_EVENT, { detail })
  );
};
