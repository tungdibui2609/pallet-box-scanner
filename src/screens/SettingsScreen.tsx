import React, { useState, useEffect } from 'react';
import {
  View, Text, StyleSheet, TextInput, TouchableOpacity,
  Alert, ActivityIndicator, ScrollView, Switch
} from 'react-native';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { Ionicons } from '@expo/vector-icons';
import {
  testConnection, syncStampDictionariesFromSupabase,
  syncCloudPalletsOffline, getLastOfflineSyncInfo,
  DEFAULT_SUPABASE_URL, DEFAULT_ANON_KEY
} from '../services/supabase';
import { getStampDictionariesCount } from '../services/database';
import { useAuth } from '../contexts/AuthContext';
import { isAutoSyncEnabled, setAutoSyncEnabled } from '../services/autoSync';

export default function SettingsScreen({ onBack }: { onBack: () => void }) {
  const { user, logout } = useAuth();
  const [url, setUrl] = useState(DEFAULT_SUPABASE_URL);
  const [anonKey, setAnonKey] = useState(DEFAULT_ANON_KEY);
  const [systemCode, setSystemCode] = useState('KHO_DONG_LANH');
  const [testing, setTesting] = useState(false);
  const [testResult, setTestResult] = useState<string | null>(null);

  // Stamp Rules Sync
  const [stampRulesCount, setStampRulesCount] = useState(0);
  const [lastStampSync, setLastStampSync] = useState<string | null>(null);
  const [syncingStamp, setSyncingStamp] = useState(false);

  // Offline LOT Data Sync
  const [offlinePalletsCount, setOfflinePalletsCount] = useState(0);
  const [lastOfflineSync, setLastOfflineSync] = useState<string | null>(null);
  const [syncingOfflinePallets, setSyncingOfflinePallets] = useState(false);
  const [autoSyncEnabled, setAutoSyncEnabledState] = useState(true);

  useEffect(() => {
    loadSettings();
  }, []);

  async function loadSettings() {
    const savedUrl = await AsyncStorage.getItem('config_supabase_url');
    const savedKey = await AsyncStorage.getItem('config_supabase_key');
    const savedSys = await AsyncStorage.getItem('config_system_code');
    if (savedUrl) setUrl(savedUrl);
    if (savedKey) setAnonKey(savedKey);
    if (savedSys) setSystemCode(savedSys);

    try {
      const count = await getStampDictionariesCount();
      setStampRulesCount(count);
      const lastSync = await AsyncStorage.getItem('last_stamp_sync_time');
      if (lastSync) setLastStampSync(lastSync);

      const offlineInfo = await getLastOfflineSyncInfo();
      setOfflinePalletsCount(offlineInfo.count);
      if (offlineInfo.lastSyncedAt) setLastOfflineSync(offlineInfo.lastSyncedAt);

      const autoSync = await isAutoSyncEnabled();
      setAutoSyncEnabledState(autoSync);
    } catch {}
  }

  async function handleSave() {
    await AsyncStorage.setItem('config_supabase_url', url.trim());
    await AsyncStorage.setItem('config_supabase_key', anonKey.trim());
    await AsyncStorage.setItem('config_system_code', systemCode.trim());
    Alert.alert('Thành công', 'Đã lưu cấu hình máy chủ!');
  }

  async function handleTest() {
    setTesting(true);
    setTestResult(null);
    try {
      const res = await testConnection();
      setTestResult(res.message);
    } catch (e: any) {
      setTestResult('Lỗi: ' + e.message);
    } finally {
      setTesting(false);
    }
  }

  async function handleSyncStampRules() {
    setSyncingStamp(true);
    try {
      const res = await syncStampDictionariesFromSupabase();
      if (res.success) {
        setStampRulesCount(res.count);
        setLastStampSync(new Date().toISOString());
        Alert.alert('Thành công', res.message);
      } else {
        Alert.alert('Không thể tải', res.message);
      }
    } catch (err: any) {
      Alert.alert('Lỗi', err.message);
    } finally {
      setSyncingStamp(false);
    }
  }

  async function handleSyncOfflinePallets() {
    setSyncingOfflinePallets(true);
    try {
      const res = await syncCloudPalletsOffline();
      if (res.success) {
        setOfflinePalletsCount(res.count);
        if (res.lastSyncedAt) setLastOfflineSync(res.lastSyncedAt);
        Alert.alert('Thành công', res.message);
      } else {
        Alert.alert('Không thể tải', res.message);
      }
    } catch (err: any) {
      Alert.alert('Lỗi', err.message);
    } finally {
      setSyncingOfflinePallets(false);
    }
  }

  function handleLogoutConfirm() {
    Alert.alert(
      'Xác nhận đăng xuất',
      `Bạn có chắc chắn muốn đăng xuất tài khoản ${user?.full_name || user?.email} không?`,
      [
        { text: 'Hủy', style: 'cancel' },
        {
          text: 'Đăng xuất',
          style: 'destructive',
          onPress: async () => {
            await logout();
          },
        },
      ]
    );
  }

  return (
    <ScrollView style={styles.container}>
      <View style={styles.header}>
        <TouchableOpacity onPress={onBack} style={{ flexDirection: 'row', alignItems: 'center', gap: 6 }}>
          <Ionicons name="arrow-back" size={22} color="#fff" />
          <Text style={{ color: '#fff', fontWeight: '700' }}>Quay lại</Text>
        </TouchableOpacity>
        <Text style={styles.title}>CÀI ĐẶT HỆ THỐNG</Text>
      </View>

      {/* ── THÔNG TIN TÀI KHOẢN ĐĂNG NHẬP ────── */}
      {user && (
        <View style={styles.userCard}>
          <View style={styles.userHeader}>
            <View style={styles.userAvatar}>
              <Ionicons name="person" size={24} color="#38bdf8" />
            </View>
            <View style={{ flex: 1 }}>
              <Text style={styles.userName}>{user.full_name}</Text>
              <Text style={styles.userEmail}>{user.email || user.username}</Text>
            </View>
          </View>

          {/* Company Badge */}
          <View style={styles.companyBox}>
            <Ionicons name="business-outline" size={18} color="#10b981" />
            <View style={{ flex: 1 }}>
              <Text style={styles.companyLabel}>Công ty trực thuộc:</Text>
              <Text style={styles.companyName}>
                {user.company?.name || 'Công Ty Cổ Phần Tập Đoàn XNK Trái Cây Chánh Thu'}
                {user.company?.code ? ` (${user.company.code})` : ''}
              </Text>
            </View>
          </View>

          {/* Department / Employee code if available */}
          {(user.employee_code || user.department) && (
            <View style={styles.userMetaRow}>
              {user.employee_code && (
                <Text style={styles.userMetaText}>Mã NV: <Text style={styles.userMetaBold}>{user.employee_code}</Text></Text>
              )}
              {user.department && (
                <Text style={styles.userMetaText}>Phòng ban: <Text style={styles.userMetaBold}>{user.department}</Text></Text>
              )}
            </View>
          )}

          <TouchableOpacity style={styles.logoutBtn} onPress={handleLogoutConfirm}>
            <Ionicons name="log-out-outline" size={18} color="#ef4444" />
            <Text style={styles.logoutBtnText}>Đăng xuất tài khoản</Text>
          </TouchableOpacity>
        </View>
      )}

      {/* ── CẬP NHẬT QUY TẮC DẤU ĐÓNG TỪ WEB ─────── */}
      <View style={styles.card}>
        <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8, marginBottom: 6 }}>
          <Ionicons name="barcode-outline" size={20} color="#a855f7" />
          <Text style={[styles.sectionTitle, { color: '#a855f7', marginBottom: 0 }]}>
            QUY TẮC GIẢI MÃ DẤU ĐÓNG (OFFLINE)
          </Text>
        </View>

        <Text style={{ color: '#94a3b8', fontSize: 12, lineHeight: 18, marginBottom: 12 }}>
          Dữ liệu này được lưu trong bộ nhớ máy để tự động giải mã 2 dòng dấu đóng ngay cả khi không có mạng wifi trong kho lạnh.
        </Text>

        <View style={{ backgroundColor: '#0f172a', padding: 12, borderRadius: 12, marginBottom: 14, borderWidth: 1, borderColor: '#334155' }}>
          <View style={{ flexDirection: 'row', justifyContent: 'space-between', marginBottom: 6 }}>
            <Text style={{ color: '#94a3b8', fontSize: 12 }}>Số quy tắc trong máy:</Text>
            <Text style={{ color: '#38bdf8', fontSize: 13, fontWeight: '700' }}>{stampRulesCount} quy tắc</Text>
          </View>
          <View style={{ flexDirection: 'row', justifyContent: 'space-between' }}>
            <Text style={{ color: '#94a3b8', fontSize: 12 }}>Cập nhật lần cuối:</Text>
            <Text style={{ color: '#cbd5e1', fontSize: 11, fontStyle: 'italic' }}>
              {lastStampSync ? new Date(lastStampSync).toLocaleString('vi-VN') : 'Dữ liệu mặc định'}
            </Text>
          </View>
        </View>

        <TouchableOpacity 
          style={{ backgroundColor: '#7c3aed', flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 8, paddingVertical: 12, borderRadius: 12 }}
          onPress={handleSyncStampRules}
          disabled={syncingStamp}
        >
          {syncingStamp ? (
            <ActivityIndicator color="#fff" size="small" />
          ) : (
            <Ionicons name="cloud-download-outline" size={18} color="#fff" />
          )}
          <Text style={{ color: '#fff', fontWeight: '700', fontSize: 13 }}>
            {syncingStamp ? 'Đang tải từ máy chủ web...' : 'Tải / Cập nhật quy tắc từ Web mẹ'}
          </Text>
        </TouchableOpacity>
      </View>

      {/* ── TẢI DANH SÁCH LOT XEM NGOẠI TUYẾN ─────── */}
      <View style={styles.card}>
        <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8, marginBottom: 6 }}>
          <Ionicons name="cloud-offline-outline" size={20} color="#0ea5e9" />
          <Text style={[styles.sectionTitle, { color: '#0ea5e9', marginBottom: 0 }]}>
            DỮ LIỆU LOT XEM NGOẠI TUYẾN (OFFLINE)
          </Text>
        </View>

        <Text style={{ color: '#94a3b8', fontSize: 12, lineHeight: 18, marginBottom: 12 }}>
          Lưu trữ toàn bộ danh sách LOT và danh mục sản phẩm vào bộ nhớ máy để tra cứu, tìm kiếm và lọc khi mất sóng hoặc ở sâu trong kho lạnh.
        </Text>

        <View style={{ backgroundColor: '#0f172a', padding: 12, borderRadius: 12, marginBottom: 14, borderWidth: 1, borderColor: '#334155' }}>
          <View style={{ flexDirection: 'row', justifyContent: 'space-between', marginBottom: 6 }}>
            <Text style={{ color: '#94a3b8', fontSize: 12 }}>Số LOT lưu trong máy:</Text>
            <Text style={{ color: '#10b981', fontSize: 13, fontWeight: '700' }}>{offlinePalletsCount} LOT</Text>
          </View>
          <View style={{ flexDirection: 'row', justifyContent: 'space-between' }}>
            <Text style={{ color: '#94a3b8', fontSize: 12 }}>Đồng bộ lần cuối:</Text>
            <Text style={{ color: '#cbd5e1', fontSize: 11, fontStyle: 'italic' }}>
              {lastOfflineSync ? new Date(lastOfflineSync).toLocaleString('vi-VN') : 'Chưa tải về'}
            </Text>
          </View>
        </View>

        {/* Nút gạt bật/tắt tự động tải ngầm */}
        <View style={styles.autoSyncRow}>
          <View style={{ flex: 1, paddingRight: 10 }}>
            <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6 }}>
              <Ionicons name="sync-circle" size={17} color="#38bdf8" />
              <Text style={styles.autoSyncLabel}>Tự động tải ngầm khi có mạng</Text>
            </View>
            <Text style={styles.autoSyncSub}>
              Tự động cập nhật dữ liệu LOT & Quy tắc khi mở app hoặc khi vừa có Wi-Fi trở lại
            </Text>
          </View>
          <Switch
            value={autoSyncEnabled}
            onValueChange={async (val) => {
              setAutoSyncEnabledState(val);
              await setAutoSyncEnabled(val);
            }}
            trackColor={{ false: '#334155', true: '#0284c7' }}
            thumbColor={autoSyncEnabled ? '#38bdf8' : '#94a3b8'}
          />
        </View>

        <TouchableOpacity 
          style={{ backgroundColor: '#0284c7', flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 8, paddingVertical: 12, borderRadius: 12 }}
          onPress={handleSyncOfflinePallets}
          disabled={syncingOfflinePallets}
        >
          {syncingOfflinePallets ? (
            <ActivityIndicator color="#fff" size="small" />
          ) : (
            <Ionicons name="download-outline" size={18} color="#fff" />
          )}
          <Text style={{ color: '#fff', fontWeight: '700', fontSize: 13 }}>
            {syncingOfflinePallets ? 'Đang tải dữ liệu LOT...' : 'Tải / Cập nhật dữ liệu LOT về máy'}
          </Text>
        </TouchableOpacity>
      </View>

      {/* ── CẤU HÌNH MÁY CHỦ ─────────────────── */}
      <View style={styles.card}>
        <Text style={styles.sectionTitle}>CẤU HÌNH KẾT NỐI MÁY CHỦ</Text>

        <Text style={styles.label}>Tên miền máy chủ Supabase:</Text>
        <TextInput
          style={styles.input}
          value={url}
          onChangeText={setUrl}
          placeholder="https://api.chanhthu.click"
          placeholderTextColor="#64748b"
          autoCapitalize="none"
        />

        <Text style={styles.label}>Mã hệ thống kho (system_code):</Text>
        <TextInput
          style={styles.input}
          value={systemCode}
          onChangeText={setSystemCode}
          placeholder="KHO_DONG_LANH"
          placeholderTextColor="#64748b"
        />

        <Text style={styles.label}>Anon Key:</Text>
        <TextInput
          style={[styles.input, { height: 70, fontSize: 11 }]}
          value={anonKey}
          onChangeText={setAnonKey}
          multiline
          placeholder="eyJhbGciOi..."
          placeholderTextColor="#64748b"
        />

        <View style={styles.btnRow}>
          <TouchableOpacity style={styles.testBtn} onPress={handleTest} disabled={testing}>
            {testing ? (
              <ActivityIndicator color="#38bdf8" />
            ) : (
              <>
                <Ionicons name="pulse-outline" size={18} color="#38bdf8" />
                <Text style={styles.testBtnText}>Kiểm tra kết nối</Text>
              </>
            )}
          </TouchableOpacity>

          <TouchableOpacity style={styles.saveBtn} onPress={handleSave}>
            <Ionicons name="save-outline" size={18} color="#fff" />
            <Text style={styles.saveBtnText}>Lưu Cài Đặt</Text>
          </TouchableOpacity>
        </View>

        {testResult && (
          <View style={styles.resultBox}>
            <Text style={styles.resultText}>{testResult}</Text>
          </View>
        )}

        <View style={styles.versionContainer}>
          <Text style={styles.versionText}>Phiên bản v1.0.24 (Build 25)</Text>
          <Text style={styles.versionSubText}>Hệ thống Quản lý Tem & Pallet • Chánh Thu</Text>
        </View>
      </View>
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: '#0f172a' },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    padding: 16,
    borderBottomWidth: 1,
    borderBottomColor: '#1e293b'
  },
  title: { color: '#fff', fontSize: 16, fontWeight: '900' },
  userCard: {
    margin: 16,
    marginBottom: 0,
    backgroundColor: '#1e293b',
    borderRadius: 16,
    padding: 16,
    borderWidth: 1,
    borderColor: '#334155',
  },
  userHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
  },
  userAvatar: {
    width: 46,
    height: 46,
    borderRadius: 23,
    backgroundColor: '#0f172a',
    borderWidth: 1.5,
    borderColor: '#38bdf8',
    alignItems: 'center',
    justifyContent: 'center',
  },
  userName: {
    color: '#ffffff',
    fontSize: 16,
    fontWeight: '800',
  },
  userEmail: {
    color: '#94a3b8',
    fontSize: 12,
    marginTop: 2,
  },
  companyBox: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    gap: 10,
    backgroundColor: '#0f172a',
    borderRadius: 12,
    padding: 12,
    marginTop: 14,
    borderWidth: 1,
    borderColor: 'rgba(16, 185, 129, 0.3)',
  },
  companyLabel: {
    color: '#64748b',
    fontSize: 10,
    fontWeight: '700',
    textTransform: 'uppercase',
  },
  companyName: {
    color: '#10b981',
    fontSize: 13,
    fontWeight: '800',
    marginTop: 2,
  },
  userMetaRow: {
    flexDirection: 'row',
    gap: 16,
    marginTop: 10,
    paddingHorizontal: 4,
  },
  userMetaText: {
    color: '#64748b',
    fontSize: 11,
  },
  userMetaBold: {
    color: '#cbd5e1',
    fontWeight: '700',
  },
  logoutBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 8,
    marginTop: 14,
    paddingVertical: 10,
    borderRadius: 10,
    backgroundColor: 'rgba(239, 68, 68, 0.12)',
    borderWidth: 1,
    borderColor: 'rgba(239, 68, 68, 0.3)',
  },
  logoutBtnText: {
    color: '#ef4444',
    fontSize: 13,
    fontWeight: '800',
  },
  card: { padding: 16 },
  sectionTitle: {
    color: '#94a3b8',
    fontSize: 11,
    fontWeight: '800',
    letterSpacing: 1,
    marginBottom: 8,
  },
  label: { color: '#cbd5e1', fontSize: 12, fontWeight: '700', marginTop: 12, marginBottom: 4 },
  input: {
    backgroundColor: '#1e293b',
    color: '#fff',
    borderRadius: 8,
    padding: 12,
    borderWidth: 1,
    borderColor: '#334155',
    fontSize: 13
  },
  autoSyncRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    backgroundColor: '#0f172a',
    padding: 12,
    borderRadius: 12,
    marginBottom: 14,
    borderWidth: 1,
    borderColor: '#334155',
  },
  autoSyncLabel: {
    color: '#f8fafc',
    fontSize: 13,
    fontWeight: '700',
  },
  autoSyncSub: {
    color: '#94a3b8',
    fontSize: 11,
    marginTop: 2,
    lineHeight: 15,
  },
  btnRow: { flexDirection: 'row', gap: 10, marginTop: 20 },
  testBtn: {
    flex: 1,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: '#1e293b',
    borderColor: '#38bdf8',
    borderWidth: 1,
    paddingVertical: 12,
    borderRadius: 8,
    gap: 6
  },
  testBtnText: { color: '#38bdf8', fontWeight: '800' },
  saveBtn: {
    flex: 1,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: '#059669',
    paddingVertical: 12,
    borderRadius: 8,
    gap: 6
  },
  saveBtnText: { color: '#fff', fontWeight: '900' },
  resultBox: {
    backgroundColor: '#020617',
    padding: 12,
    borderRadius: 8,
    marginTop: 14,
    borderWidth: 1,
    borderColor: '#334155'
  },
  resultText: { color: '#38bdf8', fontSize: 12, fontWeight: '600' },
  versionContainer: {
    alignItems: 'center',
    justifyContent: 'center',
    marginTop: 28,
    marginBottom: 16,
    paddingVertical: 12,
  },
  versionText: {
    color: '#94a3b8',
    fontSize: 12,
    fontWeight: '700',
    letterSpacing: 0.5,
  },
  versionSubText: {
    color: '#475569',
    fontSize: 10,
    marginTop: 4,
    fontWeight: '500',
  }
});