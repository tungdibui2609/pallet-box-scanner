import React, { useState } from 'react';
import { View, StyleSheet, StatusBar, TouchableOpacity, Text, Platform } from 'react-native';
import { SafeAreaProvider, useSafeAreaInsets } from 'react-native-safe-area-context';
import { Ionicons } from '@expo/vector-icons';
import ScannerScreen from './src/screens/ScannerScreen';
import PalletListScreen from './src/screens/PalletListScreen';
import SettingsScreen from './src/screens/SettingsScreen';

function AppContent() {
  const insets = useSafeAreaInsets();
  const [currentTab, setCurrentTab] = useState<'scanner' | 'pallets' | 'settings'>('scanner');

  return (
    <View style={[
      styles.root,
      {
        paddingTop: Math.max(insets.top, Platform.OS === 'android' ? (StatusBar.currentHeight || 28) : 20),
      }
    ]}>
      <StatusBar barStyle="light-content" backgroundColor="#0f172a" translucent />
      
      <View style={styles.body}>
        {currentTab === 'scanner' && (
          <ScannerScreen onNavigateToPallets={() => setCurrentTab('pallets')} />
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
          <Text style={[styles.navText, currentTab === 'scanner' && styles.navTextActive]}>
            Quét Thùng
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
            color={currentTab === 'settings' ? '#fbbf24' : '#94a3b8'}
          />
          <Text style={[styles.navText, currentTab === 'settings' && { color: '#fbbf24' }]}>
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
      <AppContent />
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