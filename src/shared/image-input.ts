export const IMAGE_INPUT_MIME = /^image\/(?:png|jpe?g|gif|webp|avif|bmp|x-ms-bmp|heic|heif)$/i;
export const IMAGE_INPUT_DATA_URL = /^data:image\/(?:png|jpe?g|gif|webp|avif|bmp|x-ms-bmp|heic|heif);base64,/i;

export type ImageInputFile = {
  id: string;
  name: string;
  type: string;
  size: number;
  dataUrl: string;
};

export function isImageInputFile(file: File): boolean {
  if (file.type) return IMAGE_INPUT_MIME.test(file.type);
  return /\.(?:avif|gif|jpe?g|png|webp|bmp|heic|heif)$/i.test(file.name);
}

export function inferImageInputMime(file: File): string {
  if (IMAGE_INPUT_MIME.test(file.type)) return file.type.toLowerCase();
  const extension = /\.([^.]+)$/.exec(file.name)?.[1]?.toLowerCase();
  if (extension === "jpg" || extension === "jpeg") return "image/jpeg";
  if (extension === "bmp") return "image/bmp";
  return extension ? `image/${extension}` : "";
}

export function readImageInputFile(file: File, id: string): Promise<ImageInputFile> {
  return new Promise((resolve, reject) => {
    const mime = inferImageInputMime(file);
    if (!IMAGE_INPUT_MIME.test(mime)) {
      reject(new Error(`「${file.name || "图片"}」不是支持的图片格式`));
      return;
    }

    const reader = new FileReader();
    reader.onerror = () => reject(new Error(`读取「${file.name || "图片"}」失败`));
    reader.onload = () => {
      const dataUrl = typeof reader.result === "string" ? reader.result : "";
      if (!IMAGE_INPUT_DATA_URL.test(dataUrl)) {
        reject(new Error(`「${file.name || "图片"}」不是可读取的图片`));
        return;
      }
      resolve({ id, name: file.name || "图片", type: mime, size: file.size, dataUrl });
    };

    // 少数浏览器不给 AVIF/HEIC 等扩展名补 MIME；给 Blob 切片补上，
    // 否则 FileReader 会产出 application/octet-stream，后续无法作为视觉输入。
    reader.readAsDataURL(file.type ? file : file.slice(0, file.size, mime));
  });
}
