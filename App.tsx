import React, { useState, useEffect } from 'react';
import { View, StyleSheet, StatusBar, TouchableOpacity, Text, Platform, ActivityIndicator, AppState, AppStateStatus } from 'react-native';
import { SafeAreaProvider, useSafeAreaInsets } from 'react-native-safe-area-context';
import { Ionicons } from '@expo/vector-icons';
import ScannerScreen from './src/screens/ScannerScreen';
import StampScannerScreen from './src/screens/StampScannerScreen';
import PalletListScreen from './src/screens/PalletListScreen';
import WarehouseMapScreen from './src/screens/WarehouseMapScreen';
import SettingsScreen from './src/screens/SettingsScreen';
import LoginScreen from './src/screens/LoginScreen';
import { AuthProvider, useAuth } from './src/contexts/AuthContext';
import { triggerBackgroundAutoSync } from './src/services/autoSync';

type AppTab = 'scanner' | 'stamp_scanner' | 'warehouse_map' | 'pallets' | 'settings';

function AppContent() {
  const insets = useSafeAreaInsets();
  const { user, isLoading } = useAuth();
  const [currentTab, setCurrentTab] = useState<AppTab>('scanner');

  useEffect(() => {
    if (!user) return;

    // Tự động tải ngầm khi mở app
    triggerBackgroundAutoSync({ reason: 'Khởi động ứng dụng', minIntervalMinutes: 5 });

    // Lắng nghe khi ứng dụng từ trạng thái nền quay lại màn hình chính
    const subscription = AppState.addEventListener('change', (nextAppState: AppStateStatus) => {
      if (nextAppState === 'active') {
        triggerBackgroundAutoSync({ reason: 'Quay lại ứng dụng', minIntervalMinutes: 15 });
      }
    });

    return () => {
      subscription.remove();
    };
  }, [user]);

  if (isLoading) {
    return (
      <View style={[styles.root, styles.loadingScreen]}>
        <StatusBar barStyle="light-content" backgroundColor="#0f172a" translucent />
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
        <StatusBar barStyle="light-content" backgroundColor="#0f172a" translucent />
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
        paddingTop: Math.max(insets.top, Platform.OS === 'android' ? (StatusBar.currentHeight || 28) : 20),
      }
    ]}>
      <StatusBar barStyle="light-content" backgroundColor="#0f172a" translucent />

      {/* ── TOP USER & COMPANY HEADER ──────────────── */}
      <View style={styles.topUserBar}>
        <View style={styles.topCompanyTag}>
          <Ionicons name="business" size={13} color="#10b981" />
          <Text style={styles.topCompanyText} numberOfLines={1}>
            {user.company?.code || 'CTG'} · {user.company?.name || 'Chánh Thu'}
          </Text>
        </View>

        <TouchableOpacity
          style={styles.topUserTag}
          onPress={() => setCurrentTab('settings')}
          activeOpacity={0.7}
        >
          <Ionicons name="person-circle" size={15} color="#38bdf8" />
          <Text style={styles.topUserText} numberOfLines={1}>
            {user.full_name}
          </Text>
        </TouchableOpacity>
      </View>
      
      {/* ── TAB CONTENT ────────────────────────────── */}
      <View style={styles.body}>
        {currentTab === 'scanner' && (
          <ScannerScreen onNavigateToPallets={() => setCurrentTab('pallets')} />
        )}
        {currentTab === 'stamp_scanner' && (
          <StampScannerScreen onNavigateToPallets={() => setCurrentTab('pallets')} />
        )}
        {currentTab === 'warehouse_map' && (
          <WarehouseMapScreen onBackToScanner={() => setCurrentTab('scanner')} />
        )}
        {currentTab === 'pallets' && (
          <PalletListScreen onBackToScanner={() => setCurrentTab('scanner')} />
        )}
        {currentTab === 'settings' && (
          <SettingsScreen onBack={() => setCurrentTab('scanner')} />
        )}
      </View>

      {/* ── BOTTOM NAVIGATION BAR ─────────────────── */}
      <View style={[
        styles.bottomNav,
        {
          paddingBottom: Math.max(insets.bottom, 12),
          height: 60 + Math.max(insets.bottom, 12),
        }
      ]}>
        <TouchableOpacity
          style={styles.navItem}
          onPress={() => setCurrentTab('scanner')}
        >
          <Ionicons
            name={currentTab === 'scanner' ? 'scan' : 'scan-outline'}
            size={22}
            color={currentTab === 'scanner' ? '#22c55e' : '#94a3b8'}
          />
          <Text style={[styles.navText, currentTab === 'scanner' && { color: '#22c55e' }]}>
            Quét Tem
          </Text>
        </TouchableOpacity>

        <TouchableOpacity
          style={styles.navItem}
          onPress={() => setCurrentTab('stamp_scanner')}
        >
          <Ionicons
            name={currentTab === 'stamp_scanner' ? 'finger-print' : 'finger-print-outline'}
            size={22}
            color={currentTab === 'stamp_scanner' ? '#fbbf24' : '#94a3b8'}
          />
          <Text style={[styles.navText, currentTab === 'stamp_scanner' && { color: '#fbbf24' }]}>
            Dấu Đóng
          </Text>
        </TouchableOpacity>

        <TouchableOpacity
          style={styles.navItem}
          onPress={() => setCurrentTab('warehouse_map')}
        >
          <Ionicons
            name={currentTab === 'warehouse_map' ? 'map' : 'map-outline'}
            size={22}
            color={currentTab === 'warehouse_map' ? '#06b6d4' : '#94a3b8'}
          />
          <Text style={[styles.navText, currentTab === 'warehouse_map' && { color: '#06b6d4' }]}>
            Sơ Đồ Kho
          </Text>
        </TouchableOpacity>

        <TouchableOpacity
          style={styles.navItem}
          onPress={() => setCurrentTab('pallets')}
        >
          <Ionicons
            name={currentTab === 'pallets' ? 'cube' : 'cube-outline'}
            size={22}
            color={currentTab === 'pallets' ? '#38bdf8' : '#94a3b8'}
          />
          <Text style={[styles.navText, currentTab === 'pallets' && { color: '#38bdf8' }]}>
            Pallet Kho
          </Text>
        </TouchableOpacity>

        <TouchableOpacity
          style={styles.navItem}
          onPress={() => setCurrentTab('settings')}
        >
          <Ionicons
            name={currentTab === 'settings' ? 'settings' : 'settings-outline'}
            size={22}
            color={currentTab === 'settings' ? '#a78bfa' : '#94a3b8'}
          />
          <Text style={[styles.navText, currentTab === 'settings' && { color: '#a78bfa' }]}>
            Cài Đặt
          </Text>
        </TouchableOpacity>
      </View>
    </View>
  );
}

export default function App() {
  return (
    <SafeAreaProvider>
      <AuthProvider>
        <AppContent />
      </AuthProvider>
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
    fontSize: 11,
    fontWeight: '700',
  },
  navTextActive: {
    color: '#22c55e',
  },
});