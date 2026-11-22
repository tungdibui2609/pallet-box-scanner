import React, { useState, useEffect } from 'react';
import { View, StyleSheet, StatusBar, TouchableOpacity, Text, Platform, ActivityIndicator, AppState, AppStateStatus } from 'react-native';
import { SafeAreaProvider, useSafeAreaInsets } from 'react-native-safe-area-context';
import { Ionicons } from '@expo/vector-icons';
import ScannerScreen from './src/screens/ScannerScreen';
import StampScannerScreen from './src/screens/StampScannerScreen';
import PalletListScreen from './src/screens/PalletListScreen';
import WarehouseMapScreen from './src/screens/WarehouseMapScreen';
import InventoryScreen from './src/screens/InventoryScreen';
import OperationsDataScreen from './src/screens/OperationsDataScreen';
import SettingsScreen from './src/screens/SettingsScreen';
import LoginScreen from './src/screens/LoginScreen';
import { AuthProvider, useAuth } from './src/contexts/AuthContext';
import { ThemeProvider, useTheme, TabThemeScope } from './src/contexts/ThemeContext';
import { triggerBackgroundAutoSync } from './src/services/autoSync';
import { FullMenuModal } from './src/components/navigation/FullMenuModal';
import OperationWatermarkOverlay from './src/components/operations/OperationWatermarkOverlay';

type AppTab = 'scanner' | 'stamp_scanner' | 'operations' | 'inventory' | 'warehouse_map' | 'pallets' | 'settings';

// Màu nhấn của từng tab trên thanh Menu thương hiệu (nền indigo đậm ở cả 2 theme)
const NAV_ACTIVE = {
  menu: '#7dd3fc',
  stamp: '#fcd34d',
  ops: '#c4b5fd',
  pallets: '#7dd3fc',
  map: '#67e8f9',
};

function AppContent() {
  const insets = useSafeAreaInsets();
  const { user, isLoading } = useAuth();
  const { colors, isDark, toggleTheme, setActiveThemeTab } = useTheme();
  const [currentTab, setCurrentTab] = useState<AppTab>('stamp_scanner');
  const [lastScannerTab, setLastScannerTab] = useState<'stamp_scanner' | 'scanner'>('stamp_scanner');
  const [isFullMenuOpen, setIsFullMenuOpen] = useState(false);
  const [visitedTabs, setVisitedTabs] = useState<Record<string, boolean>>({
    scanner: false,
    stamp_scanner: true,
    operations: false,
    warehouse_map: false,
    inventory: false,
    pallets: false,
  });

  useEffect(() => {
    setActiveThemeTab(currentTab);
    if (currentTab === 'scanner' || currentTab === 'stamp_scanner') {
      setLastScannerTab(currentTab);
    }
    if (!visitedTabs[currentTab]) {
      setVisitedTabs(prev => ({ ...prev, [currentTab]: true }));
    }
  }, [currentTab, setActiveThemeTab]);

  // Đã bỏ cơ chế tự động tải ngầm khi mở app / chuyển app để người dùng chủ động bấm tải trước mỗi ca làm việc (0ms lag)

  if (isLoading) {
    return (
      <View style={[styles.root, styles.loadingScreen]}>
        <StatusBar barStyle="light-content" />
        <View style={styles.loadingLogoCircle}>
          <Ionicons name="cube" size={50} color="#38bdf8" />
        </View>
        <Text style={styles.loadingTitle}>CHÁNH THU WAREHOUSE</Text>
        <Text style={styles.loadingSubtitle}>Hệ thống Quản lý Tem & Pallet Kho</Text>
        <ActivityIndicator size="large" color="#38bdf8" style={{ marginTop: 24 }} />
        <Text style={styles.loadingSub}>Đang kết nối phiên làm việc...</Text>
      </View>
    );
  }

  // Nếu chưa đăng nhập: Hiển thị màn hình Login
  if (!user) {
    return (
      <View style={[
        styles.root,
        {
          paddingTop: Math.max(insets.top, Platform.OS === 'android' ? (StatusBar.currentHeight || 28) : 20),
        }
      ]}>
        <StatusBar barStyle="light-content" />
        {currentTab === 'settings' ? (
          <SettingsScreen onBack={() => setCurrentTab('scanner')} />
        ) : (
          <LoginScreen onOpenSettings={() => setCurrentTab('settings')} />
        )}
      </View>
    );
  }

  // Đã đăng nhập: Hiển thị App chính
  return (
    <View style={[
      styles.root,
      {
        backgroundColor: colors.bg,
        paddingTop: Math.max(insets.top, Platform.OS === 'android' ? (StatusBar.currentHeight || 28) : 20),
      }
    ]}>
      <StatusBar barStyle={isDark ? 'light-content' : 'dark-content'} />

      {/* ── TOP USER & COMPANY HEADER (THANH THƯƠNG HIỆU INDIGO) ──────────────── */}
      <View
        style={[
          styles.topUserBar,
          {
            backgroundColor: colors.barBg,
            borderBottomColor: colors.barBorder,
          },
        ]}
      >
        <View
          style={[
            styles.topCompanyTag,
            {
              backgroundColor: 'rgba(16, 185, 129, 0.16)',
              borderWidth: 1,
              borderColor: 'rgba(110, 231, 183, 0.35)',
            },
          ]}
        >
          <Ionicons name="business" size={13} color="#6ee7b7" />
          <Text style={[styles.topCompanyText, { color: '#a7f3d0' }]} numberOfLines={1}>
            {user.company?.code || 'CTG'} · {user.company?.name || 'Chánh Thu'}
          </Text>
        </View>

        <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6 }}>
          <TouchableOpacity
            onPress={toggleTheme}
            activeOpacity={0.7}
            accessibilityLabel={isDark ? 'Chuyển sang giao diện sáng' : 'Chuyển sang giao diện tối'}
            style={{
              width: 28,
              height: 28,
              borderRadius: 8,
              backgroundColor: colors.barChipBg,
              borderWidth: 1,
              borderColor: colors.barChipBorder,
              alignItems: 'center',
              justifyContent: 'center',
            }}
          >
            <Ionicons
              name={isDark ? 'sunny' : 'moon'}
              size={14}
              color={isDark ? '#fcd34d' : '#e0e7ff'}
            />
          </TouchableOpacity>

          <TouchableOpacity
            style={[
              styles.topUserTag,
              {
                backgroundColor: colors.barChipBg,
                borderWidth: 1,
                borderColor: colors.barChipBorder,
              },
            ]}
            onPress={() => setCurrentTab('settings')}
            activeOpacity={0.7}
          >
            <Ionicons name="person-circle" size={15} color="#7dd3fc" />
            <Text style={[styles.topUserText, { color: colors.barText }]} numberOfLines={1}>
              {user.full_name}
            </Text>
          </TouchableOpacity>
        </View>
      </View>
      
      {/* ── TAB CONTENT (MỖI TAB CÓ THEME SÁNG/TỐI RIÊNG QUA TabThemeScope) ────── */}
      <View style={styles.body}>
        {currentTab === 'scanner' && (
          <TabThemeScope tab="scanner">
            <ScannerScreen
              onNavigateToPallets={() => {
                setLastScannerTab('scanner');
                setCurrentTab('pallets');
              }}
            />
          </TabThemeScope>
        )}
        {currentTab === 'stamp_scanner' && (
          <TabThemeScope tab="stamp_scanner">
            <StampScannerScreen
              onNavigateToPallets={() => {
                setLastScannerTab('stamp_scanner');
                setCurrentTab('pallets');
              }}
            />
          </TabThemeScope>
        )}
        {/* Keep-Alive cho Sơ Đồ Kho */}
        <View style={[styles.tabKeepAlive, currentTab !== 'warehouse_map' && styles.tabHidden]}>
          {visitedTabs.warehouse_map && (
            <TabThemeScope tab="warehouse_map">
              <WarehouseMapScreen
                onBackToScanner={() => setCurrentTab(lastScannerTab)}
                isActive={currentTab === 'warehouse_map'}
              />
            </TabThemeScope>
          )}
        </View>
        {/* Keep-Alive cho Số Liệu */}
        <View style={[styles.tabKeepAlive, currentTab !== 'operations' && styles.tabHidden]}>
          {visitedTabs.operations && (
            <TabThemeScope tab="operations">
              <OperationsDataScreen
                isActive={currentTab === 'operations'}
              />
            </TabThemeScope>
          )}
        </View>
        {/* Keep-Alive cho Kiểm Kê Kho */}
        <View style={[styles.tabKeepAlive, currentTab !== 'inventory' && styles.tabHidden]}>
          {visitedTabs.inventory && (
            <TabThemeScope tab="inventory">
              <InventoryScreen
                isActive={currentTab === 'inventory'}
              />
            </TabThemeScope>
          )}
        </View>
        {/* Keep-Alive cho Pallet Kho */}
        <View style={[styles.tabKeepAlive, currentTab !== 'pallets' && styles.tabHidden]}>
          {visitedTabs.pallets && (
            <TabThemeScope tab="pallets">
              <PalletListScreen
                onBackToScanner={() => setCurrentTab(lastScannerTab)}
                scannerMode={lastScannerTab}
                isActive={currentTab === 'pallets'}
              />
            </TabThemeScope>
          )}
        </View>
        {currentTab === 'settings' && (
          <TabThemeScope tab="settings">
            <SettingsScreen onBack={() => setCurrentTab(lastScannerTab)} />
          </TabThemeScope>
        )}
      </View>

      {/* ── BOTTOM NAVIGATION BAR (TINH GỌN 5 NÚT: MENU + 4 CHỨC NĂNG CHÍNH) ─────────────────── */}
      <View
        style={{
          backgroundColor: colors.bg,
          paddingBottom: insets.bottom,
        }}
      >
        <View
          style={[
            styles.bottomNav,
            {
              backgroundColor: colors.barBg,
              borderTopWidth: 1,
              borderTopColor: colors.barBorder,
              borderBottomWidth: insets.bottom > 0 ? 1 : 0,
              borderBottomColor: colors.barBorder,
              paddingBottom: 6,
              height: 58,
            },
          ]}
        >
        {/* Nút 1: Menu Hamburger (Mở toàn bộ danh mục chức năng) */}
        {(() => {
          const isDrawerActive = !['stamp_scanner', 'operations', 'pallets', 'warehouse_map'].includes(currentTab);
          return (
            <TouchableOpacity
              style={styles.navItem}
              onPress={() => setIsFullMenuOpen(true)}
              activeOpacity={0.7}
            >
              <View style={styles.menuIconWrapper}>
                <Ionicons
                  name="menu"
                  size={24}
                  color={isDrawerActive ? NAV_ACTIVE.menu : colors.barMuted}
                />
                {isDrawerActive && <View style={[styles.menuActiveDot, { borderColor: colors.barBg }]} />}
              </View>
              <Text style={[styles.navText, { color: isDrawerActive ? NAV_ACTIVE.menu : colors.barMuted, fontWeight: isDrawerActive ? '800' : '700' }]}>
                Menu
              </Text>
            </TouchableOpacity>
          );
        })()}

        {/* Nút 2: Dấu Đóng Thùng */}
        <TouchableOpacity
          style={styles.navItem}
          onPress={() => setCurrentTab('stamp_scanner')}
          activeOpacity={0.7}
        >
          <Ionicons
            name={currentTab === 'stamp_scanner' ? 'finger-print' : 'finger-print-outline'}
            size={22}
            color={currentTab === 'stamp_scanner' ? NAV_ACTIVE.stamp : colors.barMuted}
          />
          <Text style={[styles.navText, { color: currentTab === 'stamp_scanner' ? NAV_ACTIVE.stamp : colors.barMuted, fontWeight: currentTab === 'stamp_scanner' ? '800' : '700' }]}>
            Dấu Đóng
          </Text>
        </TouchableOpacity>

        {/* Nút 3: Số Liệu Báo Cáo & Ca Làm */}
        <TouchableOpacity
          style={styles.navItem}
          onPress={() => setCurrentTab('operations')}
          activeOpacity={0.7}
        >
          <Ionicons
            name={currentTab === 'operations' ? 'calculator' : 'calculator-outline'}
            size={22}
            color={currentTab === 'operations' ? NAV_ACTIVE.ops : colors.barMuted}
          />
          <Text style={[styles.navText, { color: currentTab === 'operations' ? NAV_ACTIVE.ops : colors.barMuted, fontWeight: currentTab === 'operations' ? '800' : '700' }]}>
            Số Liệu
          </Text>
        </TouchableOpacity>

        {/* Nút 4: Pallet Kho */}
        <TouchableOpacity
          style={styles.navItem}
          onPress={() => setCurrentTab('pallets')}
          activeOpacity={0.7}
        >
          <Ionicons
            name={currentTab === 'pallets' ? 'cube' : 'cube-outline'}
            size={22}
            color={currentTab === 'pallets' ? NAV_ACTIVE.pallets : colors.barMuted}
          />
          <Text style={[styles.navText, { color: currentTab === 'pallets' ? NAV_ACTIVE.pallets : colors.barMuted, fontWeight: currentTab === 'pallets' ? '800' : '700' }]}>
            Pallet Kho
          </Text>
        </TouchableOpacity>

        {/* Nút 5: Sơ Đồ Kho */}
        <TouchableOpacity
          style={styles.navItem}
          onPress={() => setCurrentTab('warehouse_map')}
          activeOpacity={0.7}
        >
          <Ionicons
            name={currentTab === 'warehouse_map' ? 'map' : 'map-outline'}
            size={22}
            color={currentTab === 'warehouse_map' ? NAV_ACTIVE.map : colors.barMuted}
          />
          <Text style={[styles.navText, { color: currentTab === 'warehouse_map' ? NAV_ACTIVE.map : colors.barMuted, fontWeight: currentTab === 'warehouse_map' ? '800' : '700' }]}>
            Sơ Đồ Kho
          </Text>
        </TouchableOpacity>
        </View>
      </View>

      {/* ── MODAL FULL MENU (HIỂN THỊ TOÀN BỘ TẤT CẢ CHỨC NĂNG) ─────────────────── */}
      <FullMenuModal
        visible={isFullMenuOpen}
        onClose={() => setIsFullMenuOpen(false)}
        currentTab={currentTab}
        onSelectTab={setCurrentTab}
      />
    </View>
  );
}

export default function App() {
  return (
    <SafeAreaProvider>
      <ThemeProvider>
        <AuthProvider>
          <AppContent />
          <OperationWatermarkOverlay />
        </AuthProvider>
      </ThemeProvider>
    </SafeAreaProvider>
  );
}

const styles = StyleSheet.create({
  root: {
    flex: 1,
    backgroundColor: '#0f172a',
  },
  body: {
    flex: 1,
  },
  tabKeepAlive: {
    flex: 1,
  },
  tabHidden: {
    display: 'none',
  },
  loadingScreen: {
    alignItems: 'center',
    justifyContent: 'center',
    padding: 24,
  },
  loadingLogoCircle: {
    width: 90,
    height: 90,
    borderRadius: 45,
    backgroundColor: '#1e293b',
    borderWidth: 2,
    borderColor: '#38bdf8',
    alignItems: 'center',
    justifyContent: 'center',
    marginBottom: 16,
  },
  loadingTitle: {
    color: '#ffffff',
    fontSize: 20,
    fontWeight: '900',
    letterSpacing: 1,
  },
  loadingSubtitle: {
    color: '#94a3b8',
    fontSize: 13,
    marginTop: 4,
  },
  loadingSub: {
    color: '#64748b',
    fontSize: 12,
    marginTop: 14,
  },
  topUserBar: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    backgroundColor: '#0c1322',
    paddingHorizontal: 12,
    paddingVertical: 6,
    borderBottomWidth: 1,
    borderBottomColor: '#1e293b',
    gap: 8,
  },
  topCompanyTag: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 5,
    backgroundColor: 'rgba(16, 185, 129, 0.12)',
    paddingVertical: 3,
    paddingHorizontal: 8,
    borderRadius: 6,
    flexShrink: 1,
  },
  topCompanyText: {
    color: '#10b981',
    fontSize: 11,
    fontWeight: '800',
  },
  topUserTag: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
    backgroundColor: '#1e293b',
    paddingVertical: 3,
    paddingHorizontal: 8,
    borderRadius: 6,
    maxWidth: 160,
  },
  topUserText: {
    color: '#e2e8f0',
    fontSize: 11,
    fontWeight: '700',
  },
  bottomNav: {
    flexDirection: 'row',
    backgroundColor: '#1e293b',
    borderTopWidth: 1,
    borderTopColor: '#334155',
    paddingTop: 8,
    elevation: 8,
  },
  navItem: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    gap: 3,
  },
  navText: {
    color: '#94a3b8',
    fontSize: 10,
    fontWeight: '700',
  },
  navTextActive: {
    color: '#22c55e',
  },
  menuIconWrapper: {
    position: 'relative',
    alignItems: 'center',
    justifyContent: 'center',
  },
  menuActiveDot: {
    position: 'absolute',
    top: -2,
    right: -4,
    width: 7,
    height: 7,
    borderRadius: 4,
    backgroundColor: '#38bdf8',
    borderWidth: 1.5,
    borderColor: '#1e293b',
  },
});