export const fileDragContainsFiles = (dataTransfer: Pick<DataTransfer, "types"> | null) =>
  Array.from(dataTransfer?.types ?? []).includes("Files");
