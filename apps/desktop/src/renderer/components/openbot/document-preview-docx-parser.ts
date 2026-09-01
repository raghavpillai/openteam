export const documentHtml = async (buffer: ArrayBuffer) => {
  const mammoth = await import("mammoth");
  const result = await mammoth.convertToHtml(
    { arrayBuffer: buffer },
    { convertImage: mammoth.images.dataUri }
  );
  return result.value;
};
