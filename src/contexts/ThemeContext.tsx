import React, { createContext, useContext, useState, useEffect, useCallback, useMemo } from 'react';
import { StyleSheet } from 'react-native';
import AsyncStorage from '@react-native-async-storage/async-storage';

export type ThemeMode = 'light' | 'dark';

export type ThemeTabKey =
  | 'stamp_scanner'
  | 'operations'
  | 'pallets'
  | 'warehouse_map'
  | 'work'
  | 'scanner'
  | 'inventory'
  | 'settings';

export type TabThemesMap = Record<ThemeTabKey, ThemeMode>;

export const THEME_TAB_META: {
  key: ThemeTabKey;
  label: string;
  desc: string;
  icon: string;
  color: string;
}[] = [
  {
    key: 'stamp_scanner',
    label: 'Dấu Đóng Thùng',
    desc: 'Quét mã dấu đóng & liên kết tem',
    icon: 'finger-print',
    color: '#d97706',
  },
  {
    key: 'operations',
    label: 'Số Liệu & Ca Làm',
    desc: 'Nhập xuất số liệu, chốt ca tạm & báo cáo',
    icon: 'calculator',
    color: '#4f46e5',
  },
  {
    key: 'pallets',
    label: 'Pallet Kho',
    desc: 'Danh sách kiện/pallet và tình trạng lưu kho',
    icon: 'cube',
    color: '#0284c7',
  },
  {
    key: 'warehouse_map',
    label: 'Sơ Đồ Kho',
    desc: 'Vị trí sơ đồ kệ và các ô chứa pallet',
    icon: 'map',
    color: '#059669',
  },
  {
    key: 'work',
    label: 'Công Việc (Lệnh Xuất)',
    desc: 'Lệnh xuất kho, hạ sảnh & thống kê vị trí lấy hàng',
    icon: 'briefcase',
    color: '#2563eb',
  },
  {
    key: 'scanner',
    label: 'Quét Tem Thùng',
    desc: 'Quét barcode tem thùng và đóng pallet',
    icon: 'scan',
    color: '#16a34a',
  },
  {
    key: 'inventory',
    label: 'Kiểm Kê Kho',
    desc: 'Kiểm tra tồn thực tế và đối soát hàng tồn',
    icon: 'clipboard',
    color: '#059669',
  },
  {
    key: 'settings',
    label: 'Cài Đặt & Hệ Thống',
    desc: 'Cấu hình phân hệ kho, đồng bộ & tài khoản',
    icon: 'settings',
    color: '#7c3aed',
  },
];

export const DEFAULT_TAB_THEMES: TabThemesMap = {
  stamp_scanner: 'light',
  operations: 'light',
  pallets: 'light',
  warehouse_map: 'light',
  work: 'light',
  scanner: 'light',
  inventory: 'light',
  settings: 'light',
};

export interface AppThemeColors {
  mode: ThemeMode;
  isDark: boolean;
  // Nền
  bg: string;
  surface: string;
  surfaceAlt: string;
  surfaceElevated: string;
  headerBg: string;
  navBg: string;
  // Viền
  border: string;
  borderSubtle: string;
  // Chữ
  text: string;
  textSecondary: string;
  textMuted: string;
  // Màu nhấn
  primary: string;
  primarySoftBg: string;
  primarySoftBorder: string;
  primarySoftText: string;
  amber: string;
  amberSoftBg: string;
  amberSoftBorder: string;
  amberSoftText: string;
  success: string;
  successSoftBg: string;
  successSoftBorder: string;
  successSoftText: string;
  danger: string;
  dangerSoftBg: string;
  dangerSoftBorder: string;
  dangerSoftText: string;
  // Pill & Input
  pillBg: string;
  inputBg: string;
  inputPlaceholder: string;
  // Card xen kẽ
  cardAltBg: string;
  // Divider & Badge
  divider: string;
  iconMuted: string;
  navInactive: string;
  // Thanh thương hiệu (Header công ty + Bottom Menu)
  barBg: string;
  barBorder: string;
  barText: string;
  barMuted: string;
  barChipBg: string;
  barChipBorder: string;
}

export const LIGHT_COLORS: AppThemeColors = {
  mode: 'light',
  isDark: false,
  bg: '#f1f5f9',
  surface: '#ffffff',
  surfaceAlt: '#f8fafc',
  surfaceElevated: '#ffffff',
  headerBg: '#312e81',
  navBg: '#312e81',
  border: '#e2e8f0',
  borderSubtle: '#f1f5f9',
  text: '#0f172a',
  textSecondary: '#334155',
  textMuted: '#64748b',
  primary: '#4f46e5',
  primarySoftBg: '#eef2ff',
  primarySoftBorder: '#a5b4fc',
  primarySoftText: '#4338ca',
  amber: '#d97706',
  amberSoftBg: '#fffbeb',
  amberSoftBorder: '#fcd34d',
  amberSoftText: '#b45309',
  success: '#059669',
  successSoftBg: '#dcfce7',
  successSoftBorder: '#86efac',
  successSoftText: '#047857',
  danger: '#e11d48',
  dangerSoftBg: '#ffe4e6',
  dangerSoftBorder: '#fda4af',
  dangerSoftText: '#be123c',
  pillBg: '#f1f5f9',
  inputBg: '#ffffff',
  inputPlaceholder: '#94a3b8',
  cardAltBg: '#fffdf7',
  divider: '#e2e8f0',
  iconMuted: '#64748b',
  navInactive: '#a5b4fc',
  barBg: '#312e81',
  barBorder: '#4338ca',
  barText: '#ffffff',
  barMuted: '#a5b4fc',
  barChipBg: 'rgba(255,255,255,0.10)',
  barChipBorder: 'rgba(255,255,255,0.22)',
};

export const DARK_COLORS: AppThemeColors = {
  mode: 'dark',
  isDark: true,
  bg: '#0b1120',
  surface: '#1e293b',
  surfaceAlt: '#0f172a',
  surfaceElevated: '#1e293b',
  headerBg: '#1e1b4b',
  navBg: '#1e1b4b',
  border: '#334155',
  borderSubtle: '#1e293b',
  text: '#f8fafc',
  textSecondary: '#cbd5e1',
  textMuted: '#94a3b8',
  primary: '#6366f1',
  primarySoftBg: 'rgba(99, 102, 241, 0.16)',
  primarySoftBorder: '#6366f1',
  primarySoftText: '#a5b4fc',
  amber: '#f59e0b',
  amberSoftBg: 'rgba(245, 158, 11, 0.15)',
  amberSoftBorder: '#78350f',
  amberSoftText: '#fcd34d',
  success: '#22c55e',
  successSoftBg: 'rgba(34, 197, 94, 0.16)',
  successSoftBorder: 'rgba(74, 222, 128, 0.35)',
  successSoftText: '#4ade80',
  danger: '#f43f5e',
  dangerSoftBg: 'rgba(244, 63, 94, 0.16)',
  dangerSoftBorder: 'rgba(248, 113, 113, 0.35)',
  dangerSoftText: '#fda4af',
  pillBg: '#0f172a',
  inputBg: '#0f172a',
  inputPlaceholder: '#64748b',
  cardAltBg: '#172033',
  divider: '#334155',
  iconMuted: '#94a3b8',
  navInactive: '#94a3b8',
  barBg: '#1e1b4b',
  barBorder: '#312e81',
  barText: '#f8fafc',
  barMuted: '#94a3b8',
  barChipBg: 'rgba(255,255,255,0.06)',
  barChipBorder: 'rgba(255,255,255,0.14)',
};

const TAB_THEMES_STORAGE_KEY = 'app_tab_themes_v1';

interface ThemeContextValue {
  mode: ThemeMode;
  isDark: boolean;
  colors: AppThemeColors;
  activeTab: ThemeTabKey;
  tabThemes: TabThemesMap;
  setActiveThemeTab: (tab: ThemeTabKey) => void;
  setTabTheme: (tab: ThemeTabKey, mode: ThemeMode) => void;
  toggleTabTheme: (tab?: ThemeTabKey) => void;
  setAllTabsTheme: (mode: ThemeMode) => void;
  setMode: (mode: ThemeMode) => void;
  toggleTheme: () => void;
}

const ThemeContext = createContext<ThemeContextValue>({
  mode: 'light',
  isDark: false,
  colors: LIGHT_COLORS,
  activeTab: 'stamp_scanner',
  tabThemes: DEFAULT_TAB_THEMES,
  setActiveThemeTab: () => {},
  setTabTheme: () => {},
  toggleTabTheme: () => {},
  setAllTabsTheme: () => {},
  setMode: () => {},
  toggleTheme: () => {},
});

export const ThemeProvider: React.FC<{ children: React.ReactNode }> = ({ children }) => {
  const [activeTab, setActiveTabState] = useState<ThemeTabKey>('stamp_scanner');
  const [tabThemes, setTabThemes] = useState<TabThemesMap>(DEFAULT_TAB_THEMES);

  useEffect(() => {
    AsyncStorage.getItem(TAB_THEMES_STORAGE_KEY)
      .then(raw => {
        if (!raw) return;
        const parsed = JSON.parse(raw);
        if (parsed && typeof parsed === 'object') {
          setTabThemes(prev => ({ ...prev, ...parsed }));
        }
      })
      .catch(() => {});
  }, []);

  const persistMap = useCallback((nextMap: TabThemesMap) => {
    AsyncStorage.setItem(TAB_THEMES_STORAGE_KEY, JSON.stringify(nextMap)).catch(() => {});
  }, []);

  const setActiveThemeTab = useCallback((tab: ThemeTabKey) => {
    setActiveTabState(tab);
  }, []);

  const setTabTheme = useCallback(
    (tab: ThemeTabKey, nextMode: ThemeMode) => {
      setTabThemes(prev => {
        const next = { ...prev, [tab]: nextMode };
        persistMap(next);
        return next;
      });
    },
    [persistMap]
  );

  const toggleTabTheme = useCallback(
    (tab?: ThemeTabKey) => {
      const target = tab || activeTab;
      setTabThemes(prev => {
        const cur = prev[target] || 'light';
        const nextMode: ThemeMode = cur === 'light' ? 'dark' : 'light';
        const next = { ...prev, [target]: nextMode };
        persistMap(next);
        return next;
      });
    },
    [activeTab, persistMap]
  );

  const setAllTabsTheme = useCallback(
    (nextMode: ThemeMode) => {
      const next: TabThemesMap = {
        stamp_scanner: nextMode,
        operations: nextMode,
        pallets: nextMode,
        warehouse_map: nextMode,
        work: nextMode,
        scanner: nextMode,
        inventory: nextMode,
        settings: nextMode,
      };
      setTabThemes(next);
      persistMap(next);
    },
    [persistMap]
  );

  const setMode = useCallback(
    (nextMode: ThemeMode) => {
      setTabTheme(activeTab, nextMode);
    },
    [activeTab, setTabTheme]
  );

  const toggleTheme = useCallback(() => {
    toggleTabTheme(activeTab);
  }, [activeTab, toggleTabTheme]);

  const currentMode: ThemeMode = tabThemes[activeTab] || 'light';

  const value = useMemo<ThemeContextValue>(
    () => ({
      mode: currentMode,
      isDark: currentMode === 'dark',
      colors: currentMode === 'dark' ? DARK_COLORS : LIGHT_COLORS,
      activeTab,
      tabThemes,
      setActiveThemeTab,
      setTabTheme,
      toggleTabTheme,
      setAllTabsTheme,
      setMode,
      toggleTheme,
    }),
    [
      currentMode,
      activeTab,
      tabThemes,
      setActiveThemeTab,
      setTabTheme,
      toggleTabTheme,
      setAllTabsTheme,
      setMode,
      toggleTheme,
    ]
  );

  return <ThemeContext.Provider value={value}>{children}</ThemeContext.Provider>;
};

// Bọc từng tab Keep-Alive để mỗi tab luôn đọc đúng theme riêng của tab đó mà không cần re-render khi đổi qua tab khác
export const TabThemeScope: React.FC<{ tab: ThemeTabKey; children: React.ReactNode }> = ({
  tab,
  children,
}) => {
  const parent = useContext(ThemeContext);
  const tabMode: ThemeMode = parent.tabThemes[tab] || 'light';

  const scopedValue = useMemo<ThemeContextValue>(
    () => ({
      ...parent,
      mode: tabMode,
      isDark: tabMode === 'dark',
      colors: tabMode === 'dark' ? DARK_COLORS : LIGHT_COLORS,
      setMode: (m: ThemeMode) => parent.setTabTheme(tab, m),
      toggleTheme: () => parent.toggleTabTheme(tab),
    }),
    [parent, tab, tabMode]
  );

  return <ThemeContext.Provider value={scopedValue}>{children}</ThemeContext.Provider>;
};

export function useTheme(): ThemeContextValue {
  return useContext(ThemeContext);
}

// ── AUTO-MAPPER LIGHT THEME CHO CÁC MÀN HÌNH ──
const SOLID_ACCENT_BG = new Set([
  '#4f46e5', '#6366f1', '#4338ca', '#3730a3',
  '#059669', '#10b981', '#16a34a', '#15803d', '#22c55e',
  '#e11d48', '#dc2626', '#ef4444', '#be123c',
  '#d97706', '#f59e0b', '#b45309', '#ea580c',
  '#0284c7', '#0369a1', '#2563eb', '#1d4ed8', '#0891b2', '#06b6d4', '#7c3aed', '#9333ea',
]);

const LIGHT_BG_MAP: Record<string, string> = {
  '#020617': '#f1f5f9',
  '#02061733': '#f8fafc',
  '#02061766': '#f1f5f9',
  '#060b16': '#f1f5f9',
  '#070c17': '#f1f5f9',
  '#080e1a': '#f1f5f9',
  '#0a0f1d': '#f1f5f9',
  '#0a101f': '#f8fafc',
  '#0b1120': '#f1f5f9',
  '#0b1324': '#ffffff',
  '#0c1322': '#ffffff',
  '#0c1424': '#ffffff',
  '#0c1629': '#ffffff',
  '#0c2338': '#f0f9ff',
  '#0d1729': '#ffffff',
  '#0e1626': '#ffffff',
  '#0e182b': '#ffffff',
  '#0f172a': '#f1f5f9',
  '#0f172a88': '#f8fafc',
  '#0f172a99': '#f8fafc',
  '#0f172acc': '#ffffff',
  '#0f172ae6': '#ffffff',
  '#111827': '#f1f5f9',
  '#111b2e': '#ffffff',
  '#131d2e': '#ffffff',
  '#131d33': '#ffffff',
  '#172033': '#f8fafc',
  '#1e2433': '#ffffff',
  '#1e293b': '#ffffff',
  '#1e3a5f': '#e0f2fe',
  '#2e2013': '#fffbeb',
  '#082f49': '#e0f2fe',
  '#083344': '#ecfeff',
  '#0833444d': '#ecfeff',
  '#083344cc': '#cffafe',
  '#3b0764': '#f3e8ff',
  '#1e1b4b': '#eef2ff',
  '#312e81': '#eef2ff',
  '#334155': '#f1f5f9',
  '#475569': '#e2e8f0',
  '#14532d': '#dcfce7',
  '#064e3b': '#d1fae5',
  '#064e3b4d': '#d1fae5',
  '#064e3b66': '#dcfce7',
  '#065f4633': '#dcfce7',
  '#451a03': '#fffbeb',
  '#451a0344': '#fffbeb',
  '#451a034d': '#fef3c7',
  '#451a0366': '#fef3c7',
  '#78350f': '#fef3c7',
  '#78350f33': '#fef3c7',
  '#78350f44': '#fde68a',
  '#4c0519': '#ffe4e6',
  '#4c051966': '#ffe4e6',
  '#7f1d1d': '#fee2e2',
};

const LIGHT_BORDER_MAP: Record<string, string> = {
  '#0a0f1d': '#e2e8f0',
  '#0b1324': '#e2e8f0',
  '#0e1626': '#e2e8f0',
  '#0f172a': '#e2e8f0',
  '#131d33': '#e2e8f0',
  '#1e293b': '#e2e8f0',
  '#334155': '#cbd5e1',
  '#475569': '#cbd5e1',
  '#312e81': '#c7d2fe',
  '#78350f': '#fcd34d',
  '#083344': '#a5f3fc',
  '#064e3b': '#86efac',
};

const LIGHT_TEXT_MAP: Record<string, string> = {
  '#f8fafc': '#0f172a',
  '#f1f5f9': '#0f172a',
  '#e2e8f0': '#1e293b',
  '#cbd5e1': '#334155',
  '#94a3b8': '#475569',
  '#64748b': '#64748b',
  '#38bdf8': '#0284c7',
  '#7dd3fc': '#0369a1',
  '#22d3ee': '#059669',
  '#06b6d4': '#059669',
  '#818cf8': '#4f46e5',
  '#a5b4fc': '#4338ca',
  '#4ade80': '#059669',
  '#34d399': '#059669',
  '#fbbf24': '#b45309',
  '#fcd34d': '#b45309',
  '#fde68a': '#92400e',
  '#f87171': '#e11d48',
  '#fda4af': '#be123c',
  '#a78bfa': '#7c3aed',
};

function mapStyleForLight(style: Record<string, any>): Record<string, any> {
  if (!style || typeof style !== 'object') return style;
  const out: Record<string, any> = { ...style };
  const rawBg = typeof out.backgroundColor === 'string' ? out.backgroundColor.trim().toLowerCase() : '';
  const hasSolidAccentBg = SOLID_ACCENT_BG.has(rawBg);

  if (rawBg && LIGHT_BG_MAP[rawBg]) {
    out.backgroundColor = LIGHT_BG_MAP[rawBg];
  } else if (rawBg.startsWith('rgba(15, 23, 42') || rawBg.startsWith('rgba(15,23,42')) {
    out.backgroundColor = '#f1f5f9';
  } else if (rawBg.startsWith('rgba(30, 41, 59') || rawBg.startsWith('rgba(30,41,59')) {
    out.backgroundColor = '#ffffff';
  }

  for (const key of ['borderColor', 'borderTopColor', 'borderBottomColor', 'borderLeftColor', 'borderRightColor']) {
    if (typeof out[key] === 'string') {
      const kLow = out[key].trim().toLowerCase();
      if (LIGHT_BORDER_MAP[kLow]) out[key] = LIGHT_BORDER_MAP[kLow];
    }
  }

  if (typeof out.color === 'string') {
    const cLow = out.color.trim().toLowerCase();
    if (LIGHT_TEXT_MAP[cLow]) {
      out.color = LIGHT_TEXT_MAP[cLow];
    } else if ((cLow === '#fff' || cLow === '#ffffff') && !hasSolidAccentBg && !rawBg) {
      // Xử lý ở bước tiếp theo dựa trên tên style
    }
  }

  return out;
}

export function useThemedStyles<T extends Record<string, any>>(baseStyles: T): { [K in keyof T]: any } {
  const { isDark } = useTheme();
  return useMemo(() => {
    if (isDark) return StyleSheet.create(baseStyles as any) as { [K in keyof T]: any };
    const mapped: Record<string, any> = {};
    for (const [key, val] of Object.entries(baseStyles)) {
      const next = mapStyleForLight(val as Record<string, any>);
      if (
        next &&
        typeof next.color === 'string' &&
        (next.color.toLowerCase() === '#fff' || next.color.toLowerCase() === '#ffffff')
      ) {
        const lowerKey = key.toLowerCase();
        const isOnSolidButton =
          lowerKey.includes('btn') ||
          lowerKey.includes('button') ||
          lowerKey.includes('badge') ||
          lowerKey.includes('active') ||
          lowerKey.includes('pill') ||
          lowerKey.includes('fab') ||
          lowerKey.includes('submit') ||
          lowerKey.includes('overlay') ||
          lowerKey.includes('camera') ||
          lowerKey.includes('toast');
        if (!isOnSolidButton) {
          next.color = '#0f172a';
        }
      }
      mapped[key] = next;
    }
    return StyleSheet.create(mapped as any) as { [K in keyof T]: any };
  }, [baseStyles, isDark]);
}
