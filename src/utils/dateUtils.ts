/**
 * Các hàm tiện ích chuẩn hóa ngày/giờ dùng chung cho toàn dự án.
 */

export function formatDateVN(d?: string | null): string {
  if (!d) return '--/--/----';
  const clean = String(d).split('T')[0];
  const parts = clean.split('-');
  if (parts.length === 3) {
    const [y, m, day] = parts;
    if (y.length === 4) {
      return `${day.padStart(2, '0')}/${m.padStart(2, '0')}/${y}`;
    }
  }
  return d;
}

export function formatDateShortVN(d?: string | null): string {
  if (!d) return '';
  const clean = String(d).split('T')[0];
  const parts = clean.split('-');
  if (parts.length === 3) {
    const [y, m, day] = parts;
    const shortYear = y.length === 4 ? y.slice(2) : y;
    return `${day.padStart(2, '0')}/${m.padStart(2, '0')}/${shortYear}`;
  }
  return d;
}

/** Định dạng dateKey (YYYY-MM-DD) sang DD/MM/YYYY */
export function formatDateDisplay(dateKey: string): string {
  if (!dateKey) return '';
  const parts = dateKey.split('-');
  if (parts.length === 3) {
    return `${parts[2]}/${parts[1]}/${parts[0]}`;
  }
  return dateKey;
}

/** Chuyển chuỗi thời gian thành timestamp mili-giây an toàn */
export function toTimestamp(dateStr?: string | null): number {
  if (!dateStr) return 0;
  let s = String(dateStr).trim();
  if (s.includes(' ')) s = s.replace(' ', 'T');
  if (/[+-]\d{2}$/.test(s)) {
    s = `${s}:00`;
  }
  const t = new Date(s).getTime();
  if (!isNaN(t)) return t;
  const fallback = new Date(dateStr).getTime();
  return isNaN(fallback) ? 0 : fallback;
}

/** Định dạng ngày giờ chuẩn Việt Nam (HH:mm:ss DD/MM/YYYY) */
export function formatDateTime(isoString?: string | null): string {
  if (!isoString) return '-';
  try {
    const ts = toTimestamp(isoString);
    if (!ts) return isoString;
    const d = new Date(ts);
    const time = d.toLocaleTimeString('vi-VN', {
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
      hour12: false,
    });
    const date = d.toLocaleDateString('vi-VN', {
      day: '2-digit',
      month: '2-digit',
      year: 'numeric',
    });
    return `${time} ${date}`;
  } catch {
    return isoString;
  }
}
