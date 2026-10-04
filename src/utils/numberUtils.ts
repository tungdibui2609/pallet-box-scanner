/**
 * Utility functions for STT (Số Thứ Tự Pallet/Lô) encoding/decoding
 * Matches exactly with web Anywarehouse algorithm
 */

export function encodeSTT(sttStr: string | number | null | undefined): number | null {
  if (sttStr === null || sttStr === undefined || sttStr === '') return null;
  const s = String(sttStr).trim().toUpperCase();
  if (!s) return null;

  // Định dạng: 1 chữ cái in hoa + số thứ tự, ví dụ: A100, B5, C544, F3219
  const match = s.match(/^([A-Z])(\d+)$/);
  if (match) {
    const char = match[1];
    const num = parseInt(match[2], 10);
    const charCode = char.charCodeAt(0) - 64; // A = 1, B = 2, ..., Z = 26
    return charCode * 100000 + num;
  }

  // Nếu chỉ là số bình thường
  const num = parseInt(s, 10);
  if (!isNaN(num)) return num;
  return null;
}

export function decodeSTT(val: number | string | null | undefined): string {
  if (val === null || val === undefined || val === '') return '';
  const num = Number(val);
  if (isNaN(num)) return String(val);

  if (num >= 100000) {
    const prefixIndex = Math.floor(num / 100000);
    const seq = num % 100000;
    if (prefixIndex >= 1 && prefixIndex <= 26) {
      const char = String.fromCharCode(64 + prefixIndex);
      return `${char}${seq}`;
    }
  }
  return String(num);
}
