import React, { useState, useEffect, useRef } from 'react';
import appJson from '../../app.json';
const APP_VERSION = appJson?.expo?.version || '1.0.86';
import {
  View, Text, TextInput, TouchableOpacity,
  Alert, ActivityIndicator, ScrollView, Switch, Modal, Platform
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { Ionicons } from '@expo/vector-icons';
import {
  testConnection, syncStampDictionariesFromSupabase,
  syncCloudPalletsOffline, getLastOfflineSyncInfo,
  syncWarehouseMapOffline, getLastWarehouseMapOfflineSyncInfo,
  DEFAULT_SUPABASE_URL, DEFAULT_ANON_KEY
} from '../services/supabase';
import { getStampDictionariesCount } from '../services/database';
import { useAuth } from '../contexts/AuthContext';
import { useTheme, THEME_TAB_META } from '../contexts/ThemeContext';
import { isAutoSyncEnabled, setAutoSyncEnabled, syncAllWarehouseDataMaster } from '../services/autoSync';
import {
  syncOfflineAdjustmentProposals,
  getSubmittedAdjustmentProposals,
} from '../services/warehouseAdjustmentService';
import { DriveImageSettingsModal } from '../components/operations/DriveImageSettingsModal';
import { ModalNavBarSpacer } from '../components/common/ModalNavBarSpacer';
import {
  getDefaultTargetBoxQty,
  setDefaultTargetBoxQty,
  getAutoCompletePalletOnFull,
  setAutoCompletePalletOnFull,
  getAutoTranscribeVoiceOnStop,
  setAutoTranscribeVoiceOnStop,
} from '../services/appSettings';

export default function SettingsScreen({ onBack }: { onBack: () => void }) {
  const insets = useSafeAreaInsets();
  const bottomSafePad = Math.max(insets.bottom, Platform.OS === 'android' ? 32 : 16) + 24;
  const { user, logout } = useAuth();
  const { colors, isDark, tabThemes, setTabTheme, setAllTabsTheme } = useTheme();
  const [isThemeModalOpen, setIsThemeModalOpen] = useState(false);
  const [url, setUrl] = useState(DEFAULT_SUPABASE_URL);
  const [anonKey, setAnonKey] = useState(DEFAULT_ANON_KEY);
  const [systemCode, setSystemCode] = useState('KHO_DONG_LANH');
  const [testing, setTesting] = useState(false);
  const [testResult, setTestResult] = useState<string | null>(null);

  // Default target boxes per pallet setting
  const [defaultTargetQty, setDefaultTargetQtyState] = useState<string>('30');
  const [savingTargetQty, setSavingTargetQty] = useState(false);
  const [autoCompleteOnFull, setAutoCompleteOnFullState] = useState(true);
  const [autoTranscribeVoice, setAutoTranscribeVoiceState] = useState(false);

  // Master All-in-One Sync
  const [syncingAllMaster, setSyncingAllMaster] = useState(false);

  // Stamp Rules Sync
  const [stampRulesCount, setStampRulesCount] = useState(0);
  const [lastStampSync, setLastStampSync] = useState<string | null>(null);
  const [syncingStamp, setSyncingStamp] = useState(false);

  // Offline LOT Data Sync
  const [offlinePalletsCount, setOfflinePalletsCount] = useState(0);
  const [lastOfflineSync, setLastOfflineSync] = useState<string | null>(null);
  const [syncingOfflinePallets, setSyncingOfflinePallets] = useState(false);
  const [autoSyncEnabled, setAutoSyncEnabledState] = useState(false);

  // Offline Warehouse Map Sync
  const [warehouseMapCount, setWarehouseMapCount] = useState(0);
  const [warehouseMapWarehouses, setWarehouseMapWarehouses] = useState(0);
  const [lastWarehouseMapSync, setLastWarehouseMapSync] = useState<string | null>(null);
  const [syncingWarehouseMap, setSyncingWarehouseMap] = useState(false);

  // Advanced Technician Server Config
  const [showAdvancedConfig, setShowAdvancedConfig] = useState(false);
  const [showKeyPlain, setShowKeyPlain] = useState(false);
  const [isDriveModalVisible, setIsDriveModalVisible] = useState(false);
  const versionTapCountRef = useRef(0);
  const lastTapTimeRef = useRef(0);

  const handleVersionTap = () => {
    const now = Date.now();
    if (now - lastTapTimeRef.current < 600) {
      versionTapCountRef.current += 1;
    } else {
      versionTapCountRef.current = 1;
    }
    lastTapTimeRef.current = now;

    if (versionTapCountRef.current >= 5) {
      versionTapCountRef.current = 0;
      const next = !showAdvancedConfig;
      setShowAdvancedConfig(next);
      Alert.alert(
        next ? '🔓 Chế độ Kỹ thuật viên' : '🔒 Đã khóa',
        next
          ? 'Đã mở khóa Cấu hình máy chủ nâng cao. Vui lòng cẩn thận khi chỉnh sửa các thông số kỹ thuật này!'
          : 'Đã ẩn và khóa cấu hình máy chủ an toàn.'
      );
    }
  };

  async function loadSettings() {
    const savedUrl = await AsyncStorage.getItem('config_supabase_url');
    const savedKey = await AsyncStorage.getItem('config_supabase_key');
    const savedSys = await AsyncStorage.getItem('config_system_code');
    if (savedUrl) setUrl(savedUrl);
    if (savedKey) setAnonKey(savedKey);
    if (savedSys) setSystemCode(savedSys);

    try {
      const savedTargetQty = await getDefaultTargetBoxQty();
      setDefaultTargetQtyState(String(savedTargetQty));
      const autoChot = await getAutoCompletePalletOnFull();
      setAutoCompleteOnFullState(autoChot);
      const autoVoice = await getAutoTranscribeVoiceOnStop();
      setAutoTranscribeVoiceState(autoVoice);

      const count = await getStampDictionariesCount();
      setStampRulesCount(count);
      const lastSync = await AsyncStorage.getItem('last_stamp_sync_time');
      if (lastSync) setLastStampSync(lastSync);

      const offlineInfo = await getLastOfflineSyncInfo();
      setOfflinePalletsCount(offlineInfo.count);
      if (offlineInfo.lastSyncedAt) setLastOfflineSync(offlineInfo.lastSyncedAt);

      const whMapInfo = await getLastWarehouseMapOfflineSyncInfo();
      setWarehouseMapCount(whMapInfo.count);
      setWarehouseMapWarehouses(whMapInfo.warehousesCount);
      if (whMapInfo.lastSyncedAt) setLastWarehouseMapSync(whMapInfo.lastSyncedAt);

      const autoSync = await isAutoSyncEnabled();
      setAutoSyncEnabledState(autoSync);
    } catch {}
  }

  useEffect(() => {
    const timer = setTimeout(() => {
      void loadSettings();
    }, 0);
    return () => clearTimeout(timer);
  }, []);

  async function handleSaveTargetBoxQty(customVal?: number) {
    const qtyToSave = customVal !== undefined ? customVal : (parseInt(defaultTargetQty, 10) || 30);
    if (qtyToSave <= 0) {
      Alert.alert('Không hợp lệ', 'Mục tiêu số thùng phải lớn hơn 0');
      return;
    }
    setSavingTargetQty(true);
    try {
      const saved = await setDefaultTargetBoxQty(qtyToSave);
      setDefaultTargetQtyState(String(saved));
      Alert.alert('Thành công', `Đã lưu mục tiêu số thùng mặc định là ${saved} thùng / Pallet.`);
    } catch (err: any) {
      Alert.alert('Lỗi', err.message || 'Không thể lưu cài đặt.');
    } finally {
      setSavingTargetQty(false);
    }
  }

  async function handleToggleAutoComplete(val: boolean) {
    setAutoCompleteOnFullState(val);
    await setAutoCompletePalletOnFull(val);
  }

  async function handleToggleAutoTranscribeVoice(val: boolean) {
    setAutoTranscribeVoiceState(val);
    await setAutoTranscribeVoiceOnStop(val);
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
        const exactCount = await getStampDictionariesCount();
        setStampRulesCount(exactCount);
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

  async function handleSyncAllMaster() {
    setSyncingAllMaster(true);
    try {
      const res = await syncAllWarehouseDataMaster();
      if (res.success) {
        setWarehouseMapCount(res.totalPositions);
        setWarehouseMapWarehouses(res.totalWarehouses);
        setOfflinePalletsCount(res.totalLots);
        const now = new Date().toISOString();
        setLastWarehouseMapSync(now);
        setLastOfflineSync(now);
        Alert.alert('Đồng Bộ Hoàn Tất', res.message);
      } else {
        Alert.alert('Không thể tải toàn bộ', res.message);
      }
    } catch (err: any) {
      Alert.alert('Lỗi', err.message);
    } finally {
      setSyncingAllMaster(false);
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

  async function handleSyncWarehouseMap() {
    setSyncingWarehouseMap(true);
    try {
      const res = await syncWarehouseMapOffline();
      if (res.success) {
        let submittedCount = 0;
        try {
          await syncOfflineAdjustmentProposals();
          const submitted = await getSubmittedAdjustmentProposals('KHO_DONG_LANH');
          submittedCount = submitted.length;
        } catch {
          // ignore
        }
        setWarehouseMapCount(res.totalPositions);
        setWarehouseMapWarehouses(res.totalWarehouses);
        if (res.lastSyncedAt) setLastWarehouseMapSync(res.lastSyncedAt);
        Alert.alert(
          'Thành công',
          `${res.message}\nĐã đồng bộ kèm ${submittedCount} phiếu nháp đã gửi để xem ngoại tuyến.`
        );
      } else {
        Alert.alert('Không thể tải', res.message);
      }
    } catch (err: any) {
      Alert.alert('Lỗi', err.message);
    } finally {
      setSyncingWarehouseMap(false);
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

  const formatShortSync = (iso: string | null) => {
    if (!iso) return 'Chưa tải';
    try {
      const d = new Date(iso);
      return `${d.toLocaleTimeString('vi-VN', { hour: '2-digit', minute: '2-digit' })} ${d.toLocaleDateString('vi-VN', { day: '2-digit', month: '2-digit' })}`;
    } catch {
      return 'Chưa tải';
    }
  };

  const lightCount = THEME_TAB_META.filter(t => tabThemes[t.key] === 'light').length;
  const darkCount = THEME_TAB_META.filter(t => tabThemes[t.key] === 'dark').length;

  return (
    <View style={{ flex: 1, backgroundColor: colors.bg }}>
      {/* ── HEADER GỌN SẠCH ── */}
      <View
        style={{
          flexDirection: 'row',
          alignItems: 'center',
          justifyContent: 'space-between',
          paddingHorizontal: 14,
          paddingVertical: 12,
          backgroundColor: colors.surface,
          borderBottomWidth: 1,
          borderBottomColor: colors.border,
        }}
      >
        <TouchableOpacity
          onPress={onBack}
          style={{ flexDirection: 'row', alignItems: 'center', gap: 6, paddingVertical: 2 }}
          activeOpacity={0.7}
        >
          <Ionicons name="arrow-back" size={20} color={colors.text} />
          <Text style={{ color: colors.text, fontSize: 14, fontWeight: '700' }}>Quay lại</Text>
        </TouchableOpacity>
        <Text style={{ color: colors.text, fontSize: 15, fontWeight: '900', letterSpacing: 0.3 }}>
          Cài đặt
        </Text>
        <View style={{ width: 70 }} />
      </View>

      <ScrollView
        style={{ flex: 1 }}
        contentContainerStyle={{ padding: 14, paddingBottom: 36, gap: 16 }}
        showsVerticalScrollIndicator={false}
      >
        {/* ── 1. THẺ TÀI KHOẢN GỌN ── */}
        {user && (
          <View
            style={{
              backgroundColor: colors.surface,
              borderRadius: 16,
              padding: 14,
              borderWidth: 1,
              borderColor: colors.border,
            }}
          >
            <View style={{ flexDirection: 'row', alignItems: 'center', gap: 12 }}>
              <View
                style={{
                  width: 44,
                  height: 44,
                  borderRadius: 22,
                  backgroundColor: colors.primarySoftBg,
                  borderWidth: 1,
                  borderColor: colors.primarySoftBorder,
                  alignItems: 'center',
                  justifyContent: 'center',
                }}
              >
                <Ionicons name="person" size={22} color={colors.primary} />
              </View>
              <View style={{ flex: 1, minWidth: 0 }}>
                <Text style={{ color: colors.text, fontSize: 15, fontWeight: '800' }} numberOfLines={1}>
                  {user.full_name}
                </Text>
                <Text style={{ color: colors.textMuted, fontSize: 12, marginTop: 1 }} numberOfLines={1}>
                  {user.email || user.username}
                </Text>
              </View>
              <TouchableOpacity
                onPress={handleLogoutConfirm}
                activeOpacity={0.75}
                style={{
                  flexDirection: 'row',
                  alignItems: 'center',
                  gap: 4,
                  paddingHorizontal: 10,
                  paddingVertical: 7,
                  borderRadius: 10,
                  backgroundColor: isDark ? 'rgba(239, 68, 68, 0.16)' : '#fef2f2',
                  borderWidth: 1,
                  borderColor: isDark ? 'rgba(239, 68, 68, 0.35)' : '#fecaca',
                }}
              >
                <Ionicons name="log-out-outline" size={15} color={isDark ? '#f87171' : '#dc2626'} />
                <Text style={{ color: isDark ? '#f87171' : '#dc2626', fontSize: 12, fontWeight: '700' }}>
                  Đăng xuất
                </Text>
              </TouchableOpacity>
            </View>

            <View
              style={{
                flexDirection: 'row',
                alignItems: 'center',
                gap: 8,
                marginTop: 12,
                paddingTop: 10,
                borderTopWidth: 1,
                borderTopColor: colors.border,
              }}
            >
              <Ionicons name="business-outline" size={15} color="#059669" />
              <Text style={{ flex: 1, color: isDark ? '#34d399' : '#047857', fontSize: 12, fontWeight: '700' }} numberOfLines={2}>
                {user.company?.name || 'Công Ty Cổ Phần Tập Đoàn XNK Trái Cây Chánh Thu'}
                {user.company?.code ? ` (${user.company.code})` : ''}
              </Text>
            </View>

            {(user.employee_code || user.department) && (
              <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 12, marginTop: 6 }}>
                {user.employee_code && (
                  <Text style={{ color: colors.textMuted, fontSize: 11 }}>
                    Mã NV: <Text style={{ color: colors.text, fontWeight: '700' }}>{user.employee_code}</Text>
                  </Text>
                )}
                {user.department && (
                  <Text style={{ color: colors.textMuted, fontSize: 11 }}>
                    Phòng ban: <Text style={{ color: colors.text, fontWeight: '700' }}>{user.department}</Text>
                  </Text>
                )}
              </View>
            )}
          </View>
        )}

        {/* ── 2. NHÓM GIAO DIỆN & HÌNH ẢNH ── */}
        <View>
          <Text
            style={{
              color: colors.textMuted,
              fontSize: 11,
              fontWeight: '800',
              letterSpacing: 0.6,
              marginBottom: 6,
              marginLeft: 4,
            }}
          >
            GIAO DIỆN & HÌNH ẢNH
          </Text>
          <View
            style={{
              backgroundColor: colors.surface,
              borderRadius: 16,
              borderWidth: 1,
              borderColor: colors.border,
              overflow: 'hidden',
            }}
          >
            {/* Dòng 1: Theme từng menu */}
            <TouchableOpacity
              onPress={() => setIsThemeModalOpen(true)}
              activeOpacity={0.7}
              style={{
                flexDirection: 'row',
                alignItems: 'center',
                paddingHorizontal: 14,
                paddingVertical: 13,
                gap: 12,
              }}
            >
              <View
                style={{
                  width: 36,
                  height: 36,
                  borderRadius: 10,
                  backgroundColor: colors.primarySoftBg,
                  alignItems: 'center',
                  justifyContent: 'center',
                }}
              >
                <Ionicons name="color-palette" size={19} color={colors.primary} />
              </View>
              <View style={{ flex: 1 }}>
                <Text style={{ color: colors.text, fontSize: 13.5, fontWeight: '700' }}>
                  Giao diện Sáng / Tối từng Menu
                </Text>
                <Text style={{ color: colors.textMuted, fontSize: 11.5, marginTop: 1 }}>
                  {lightCount} Sáng · {darkCount} Tối
                </Text>
              </View>
              <Ionicons name="chevron-forward" size={18} color={colors.textMuted} />
            </TouchableOpacity>

            <View style={{ height: 1, backgroundColor: colors.border, marginLeft: 62 }} />

            {/* Dòng 2: Hình ảnh & Google Drive */}
            <TouchableOpacity
              onPress={() => setIsDriveModalVisible(true)}
              activeOpacity={0.7}
              style={{
                flexDirection: 'row',
                alignItems: 'center',
                paddingHorizontal: 14,
                paddingVertical: 13,
                gap: 12,
              }}
            >
              <View
                style={{
                  width: 36,
                  height: 36,
                  borderRadius: 10,
                  backgroundColor: isDark ? 'rgba(16, 185, 129, 0.18)' : '#ecfdf5',
                  alignItems: 'center',
                  justifyContent: 'center',
                }}
              >
                <Ionicons name="images-outline" size={19} color="#059669" />
              </View>
              <View style={{ flex: 1 }}>
                <Text style={{ color: colors.text, fontSize: 13.5, fontWeight: '700' }}>
                  Hình ảnh & Google Drive
                </Text>
                <Text style={{ color: colors.textMuted, fontSize: 11.5, marginTop: 1 }}>
                  Webhook Drive, Timemark & tự xóa ảnh gốc
                </Text>
              </View>
              <Ionicons name="chevron-forward" size={18} color={colors.textMuted} />
            </TouchableOpacity>
          </View>
        </View>

        {/* ── 3. NHÓM QUÉT PALLET & THÙNG ── */}
        <View>
          <Text
            style={{
              color: colors.textMuted,
              fontSize: 11,
              fontWeight: '800',
              letterSpacing: 0.6,
              marginBottom: 6,
              marginLeft: 4,
            }}
          >
            QUÉT PALLET & THÙNG
          </Text>
          <View
            style={{
              backgroundColor: colors.surface,
              borderRadius: 16,
              borderWidth: 1,
              borderColor: colors.border,
              padding: 14,
            }}
          >
            <View style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: 10 }}>
              <View style={{ flex: 1 }}>
                <Text style={{ color: colors.text, fontSize: 13.5, fontWeight: '700' }}>
                  Số thùng mặc định / Pallet
                </Text>
                <Text style={{ color: colors.textMuted, fontSize: 11.5, marginTop: 1 }}>
                  Dùng cho Quét Đóng Dấu & Quét Tem
                </Text>
              </View>
              <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6 }}>
                <TextInput
                  style={{
                    width: 64,
                    height: 38,
                    borderRadius: 10,
                    backgroundColor: colors.surfaceAlt,
                    borderWidth: 1,
                    borderColor: colors.border,
                    color: colors.text,
                    fontSize: 16,
                    fontWeight: '800',
                    textAlign: 'center',
                  }}
                  value={defaultTargetQty}
                  onChangeText={setDefaultTargetQtyState}
                  keyboardType="number-pad"
                  placeholder="30"
                  placeholderTextColor={colors.textMuted}
                />
                <TouchableOpacity
                  onPress={() => handleSaveTargetBoxQty()}
                  disabled={savingTargetQty}
                  activeOpacity={0.8}
                  style={{
                    height: 38,
                    paddingHorizontal: 12,
                    borderRadius: 10,
                    backgroundColor: colors.primary,
                    alignItems: 'center',
                    justifyContent: 'center',
                  }}
                >
                  {savingTargetQty ? (
                    <ActivityIndicator color="#fff" size="small" />
                  ) : (
                    <Text style={{ color: '#fff', fontSize: 12, fontWeight: '800' }}>Lưu</Text>
                  )}
                </TouchableOpacity>
              </View>
            </View>

            {/* Chọn nhanh */}
            <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 6, marginTop: 10 }}>
              {[20, 24, 30, 36, 40, 50].map((num) => {
                const isSelected = defaultTargetQty === String(num);
                return (
                  <TouchableOpacity
                    key={num}
                    activeOpacity={0.75}
                    onPress={() => {
                      setDefaultTargetQtyState(String(num));
                      handleSaveTargetBoxQty(num);
                    }}
                    style={{
                      paddingHorizontal: 10,
                      paddingVertical: 6,
                      borderRadius: 8,
                      backgroundColor: isSelected ? colors.primarySoftBg : colors.surfaceAlt,
                      borderWidth: 1,
                      borderColor: isSelected ? colors.primary : colors.border,
                    }}
                  >
                    <Text
                      style={{
                        color: isSelected ? colors.primary : colors.textMuted,
                        fontSize: 12,
                        fontWeight: isSelected ? '800' : '600',
                      }}
                    >
                      {num}
                    </Text>
                  </TouchableOpacity>
                );
              })}
            </View>

            <View style={{ height: 1, backgroundColor: colors.border, marginVertical: 12 }} />

            {/* Tự động chốt khi đủ thùng */}
            <View style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: 10 }}>
              <View style={{ flex: 1 }}>
                <Text style={{ color: colors.text, fontSize: 13.5, fontWeight: '700' }}>
                  Tự động chốt khi đủ {defaultTargetQty || 30} thùng
                </Text>
                <Text style={{ color: colors.textMuted, fontSize: 11.5, marginTop: 1 }}>
                  Tự hoàn thành Pallet ngay khi quét đủ chỉ tiêu
                </Text>
              </View>
              <Switch
                value={autoCompleteOnFull}
                onValueChange={handleToggleAutoComplete}
                trackColor={{ false: isDark ? '#334155' : '#cbd5e1', true: '#10b981' }}
                thumbColor="#ffffff"
              />
            </View>

            <View style={{ height: 1, backgroundColor: colors.border, marginVertical: 12 }} />

            {/* Tự động gửi AI dịch ngay khi ghi âm xong */}
            <View style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: 10 }}>
              <View style={{ flex: 1 }}>
                <Text style={{ color: colors.text, fontSize: 13.5, fontWeight: '700' }}>
                  Tự động gửi AI dịch khi ghi âm xong
                </Text>
                <Text style={{ color: colors.textMuted, fontSize: 11.5, marginTop: 1 }}>
                  Mặc định tắt: lưu máy nghe lại trước, bấm &quot;Dịch&quot; hoặc Đồng bộ sau
                </Text>
              </View>
              <Switch
                value={autoTranscribeVoice}
                onValueChange={handleToggleAutoTranscribeVoice}
                trackColor={{ false: isDark ? '#334155' : '#cbd5e1', true: '#8b5cf6' }}
                thumbColor="#ffffff"
              />
            </View>
          </View>
        </View>

        {/* ── 4. NHÓM DỮ LIỆU NGOẠI TUYẾN (GOM 1 KHỐI GỌN) ── */}
        <View>
          <Text
            style={{
              color: colors.textMuted,
              fontSize: 11,
              fontWeight: '800',
              letterSpacing: 0.6,
              marginBottom: 6,
              marginLeft: 4,
            }}
          >
            DỮ LIỆU NGOẠI TUYẾN (KHO LẠNH)
          </Text>
          <View
            style={{
              backgroundColor: colors.surface,
              borderRadius: 16,
              borderWidth: 1,
              borderColor: colors.border,
              overflow: 'hidden',
            }}
          >
            {/* Nút tải tất cả */}
            <View style={{ padding: 14, borderBottomWidth: 1, borderBottomColor: colors.border }}>
              <TouchableOpacity
                onPress={handleSyncAllMaster}
                disabled={syncingAllMaster}
                activeOpacity={0.85}
                style={{
                  backgroundColor: colors.primary,
                  flexDirection: 'row',
                  alignItems: 'center',
                  justifyContent: 'center',
                  gap: 8,
                  paddingVertical: 12,
                  borderRadius: 12,
                }}
              >
                {syncingAllMaster ? (
                  <ActivityIndicator color="#fff" size="small" />
                ) : (
                  <Ionicons name="cloud-download-outline" size={18} color="#fff" />
                )}
                <Text style={{ color: '#fff', fontSize: 13.5, fontWeight: '800' }}>
                  {syncingAllMaster ? 'Đang tải toàn bộ dữ liệu...' : 'Tải toàn bộ dữ liệu làm việc'}
                </Text>
              </TouchableOpacity>
            </View>

            {/* Dòng: Sơ đồ kho */}
            <View
              style={{
                flexDirection: 'row',
                alignItems: 'center',
                paddingHorizontal: 14,
                paddingVertical: 11,
                gap: 10,
              }}
            >
              <Ionicons name="map-outline" size={18} color="#059669" />
              <View style={{ flex: 1 }}>
                <Text style={{ color: colors.text, fontSize: 13, fontWeight: '700' }}>
                  Sơ đồ kho · {warehouseMapCount.toLocaleString('vi-VN')} vị trí
                  {warehouseMapWarehouses > 0 ? ` (${warehouseMapWarehouses} kho)` : ''}
                </Text>
                <Text style={{ color: colors.textMuted, fontSize: 11, marginTop: 1 }}>
                  Cập nhật: {formatShortSync(lastWarehouseMapSync)}
                </Text>
              </View>
              <TouchableOpacity
                onPress={handleSyncWarehouseMap}
                disabled={syncingWarehouseMap}
                style={{
                  width: 34,
                  height: 34,
                  borderRadius: 10,
                  backgroundColor: colors.surfaceAlt,
                  borderWidth: 1,
                  borderColor: colors.border,
                  alignItems: 'center',
                  justifyContent: 'center',
                }}
              >
                {syncingWarehouseMap ? (
                  <ActivityIndicator size="small" color="#059669" />
                ) : (
                  <Ionicons name="refresh" size={16} color={colors.text} />
                )}
              </TouchableOpacity>
            </View>

            <View style={{ height: 1, backgroundColor: colors.border, marginLeft: 42 }} />

            {/* Dòng: Danh sách LOT */}
            <View
              style={{
                flexDirection: 'row',
                alignItems: 'center',
                paddingHorizontal: 14,
                paddingVertical: 11,
                gap: 10,
              }}
            >
              <Ionicons name="layers-outline" size={18} color="#0284c7" />
              <View style={{ flex: 1 }}>
                <Text style={{ color: colors.text, fontSize: 13, fontWeight: '700' }}>
                  Danh sách LOT · {offlinePalletsCount.toLocaleString('vi-VN')} LOT
                </Text>
                <Text style={{ color: colors.textMuted, fontSize: 11, marginTop: 1 }}>
                  Cập nhật: {formatShortSync(lastOfflineSync)}
                </Text>
              </View>
              <TouchableOpacity
                onPress={handleSyncOfflinePallets}
                disabled={syncingOfflinePallets}
                style={{
                  width: 34,
                  height: 34,
                  borderRadius: 10,
                  backgroundColor: colors.surfaceAlt,
                  borderWidth: 1,
                  borderColor: colors.border,
                  alignItems: 'center',
                  justifyContent: 'center',
                }}
              >
                {syncingOfflinePallets ? (
                  <ActivityIndicator size="small" color="#0284c7" />
                ) : (
                  <Ionicons name="refresh" size={16} color={colors.text} />
                )}
              </TouchableOpacity>
            </View>

            <View style={{ height: 1, backgroundColor: colors.border, marginLeft: 42 }} />

            {/* Dòng: Quy tắc dấu đóng */}
            <View
              style={{
                flexDirection: 'row',
                alignItems: 'center',
                paddingHorizontal: 14,
                paddingVertical: 11,
                gap: 10,
              }}
            >
              <Ionicons name="barcode-outline" size={18} color="#7c3aed" />
              <View style={{ flex: 1 }}>
                <Text style={{ color: colors.text, fontSize: 13, fontWeight: '700' }}>
                  Quy tắc dấu đóng · {stampRulesCount} quy tắc
                </Text>
                <Text style={{ color: colors.textMuted, fontSize: 11, marginTop: 1 }}>
                  Cập nhật: {formatShortSync(lastStampSync)}
                </Text>
              </View>
              <TouchableOpacity
                onPress={handleSyncStampRules}
                disabled={syncingStamp}
                style={{
                  width: 34,
                  height: 34,
                  borderRadius: 10,
                  backgroundColor: colors.surfaceAlt,
                  borderWidth: 1,
                  borderColor: colors.border,
                  alignItems: 'center',
                  justifyContent: 'center',
                }}
              >
                {syncingStamp ? (
                  <ActivityIndicator size="small" color="#7c3aed" />
                ) : (
                  <Ionicons name="refresh" size={16} color={colors.text} />
                )}
              </TouchableOpacity>
            </View>

            <View style={{ height: 1, backgroundColor: colors.border }} />

            {/* Switch tự động tải ngầm */}
            <View
              style={{
                flexDirection: 'row',
                alignItems: 'center',
                justifyContent: 'space-between',
                paddingHorizontal: 14,
                paddingVertical: 11,
                gap: 10,
              }}
            >
              <View style={{ flex: 1 }}>
                <Text style={{ color: colors.text, fontSize: 13, fontWeight: '700' }}>
                  Tự động tải ngầm khi có Wi-Fi
                </Text>
                <Text style={{ color: colors.textMuted, fontSize: 11, marginTop: 1 }}>
                  Cập nhật LOT & Quy tắc dấu khi có mạng
                </Text>
              </View>
              <Switch
                value={autoSyncEnabled}
                onValueChange={async (val) => {
                  setAutoSyncEnabledState(val);
                  await setAutoSyncEnabled(val);
                }}
                trackColor={{ false: isDark ? '#334155' : '#cbd5e1', true: colors.primary }}
                thumbColor="#ffffff"
              />
            </View>
          </View>
        </View>

        {/* ── 5. CẤU HÌNH MÁY CHỦ (KỸ THUẬT VIÊN - ẨN MẶC ĐỊNH) ── */}
        {showAdvancedConfig && (
          <View
            style={{
              backgroundColor: colors.surface,
              borderRadius: 16,
              padding: 14,
              borderWidth: 1,
              borderColor: '#f59e0b',
              gap: 10,
            }}
          >
            <View style={{ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' }}>
              <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6 }}>
                <Ionicons name="construct-outline" size={16} color="#d97706" />
                <Text style={{ color: '#d97706', fontSize: 12, fontWeight: '800' }}>
                  CẤU HÌNH MÁY CHỦ (KỸ THUẬT)
                </Text>
              </View>
              <TouchableOpacity onPress={() => setShowAdvancedConfig(false)}>
                <Text style={{ color: colors.textMuted, fontSize: 12, fontWeight: '700' }}>Ẩn</Text>
              </TouchableOpacity>
            </View>

            <View>
              <Text style={{ color: colors.textMuted, fontSize: 11.5, fontWeight: '700', marginBottom: 4 }}>
                Supabase URL
              </Text>
              <TextInput
                style={{
                  backgroundColor: colors.surfaceAlt,
                  color: colors.text,
                  borderRadius: 10,
                  paddingHorizontal: 12,
                  paddingVertical: 9,
                  borderWidth: 1,
                  borderColor: colors.border,
                  fontSize: 12.5,
                }}
                value={url}
                onChangeText={setUrl}
                placeholder="https://api.chanhthu.click"
                placeholderTextColor={colors.textMuted}
                autoCapitalize="none"
              />
            </View>

            <View>
              <Text style={{ color: colors.textMuted, fontSize: 11.5, fontWeight: '700', marginBottom: 4 }}>
                Mã phân hệ kho (system_code)
              </Text>
              <TextInput
                style={{
                  backgroundColor: colors.surfaceAlt,
                  color: colors.text,
                  borderRadius: 10,
                  paddingHorizontal: 12,
                  paddingVertical: 9,
                  borderWidth: 1,
                  borderColor: colors.border,
                  fontSize: 12.5,
                }}
                value={systemCode}
                onChangeText={setSystemCode}
                placeholder="KHO_DONG_LANH"
                placeholderTextColor={colors.textMuted}
              />
            </View>

            <View>
              <View style={{ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', marginBottom: 4 }}>
                <Text style={{ color: colors.textMuted, fontSize: 11.5, fontWeight: '700' }}>Anon Key</Text>
                <TouchableOpacity onPress={() => setShowKeyPlain(s => !s)}>
                  <Text style={{ color: colors.primary, fontSize: 11.5, fontWeight: '700' }}>
                    {showKeyPlain ? 'Ẩn mã' : 'Xem mã'}
                  </Text>
                </TouchableOpacity>
              </View>
              <TextInput
                style={{
                  backgroundColor: colors.surfaceAlt,
                  color: colors.text,
                  borderRadius: 10,
                  paddingHorizontal: 12,
                  paddingVertical: 9,
                  borderWidth: 1,
                  borderColor: colors.border,
                  fontSize: 11.5,
                  height: showKeyPlain ? 70 : 40,
                }}
                value={anonKey}
                onChangeText={setAnonKey}
                secureTextEntry={!showKeyPlain}
                multiline={showKeyPlain}
                placeholder="eyJhbGciOi..."
                placeholderTextColor={colors.textMuted}
              />
            </View>

            <View style={{ flexDirection: 'row', gap: 8, marginTop: 4 }}>
              <TouchableOpacity
                onPress={handleTest}
                disabled={testing}
                style={{
                  flex: 1,
                  flexDirection: 'row',
                  alignItems: 'center',
                  justifyContent: 'center',
                  gap: 6,
                  paddingVertical: 10,
                  borderRadius: 10,
                  backgroundColor: colors.surfaceAlt,
                  borderWidth: 1,
                  borderColor: colors.border,
                }}
              >
                {testing ? (
                  <ActivityIndicator color={colors.primary} size="small" />
                ) : (
                  <>
                    <Ionicons name="pulse-outline" size={16} color={colors.primary} />
                    <Text style={{ color: colors.primary, fontSize: 12.5, fontWeight: '700' }}>Kiểm tra</Text>
                  </>
                )}
              </TouchableOpacity>
              <TouchableOpacity
                onPress={handleSave}
                style={{
                  flex: 1,
                  flexDirection: 'row',
                  alignItems: 'center',
                  justifyContent: 'center',
                  gap: 6,
                  paddingVertical: 10,
                  borderRadius: 10,
                  backgroundColor: '#059669',
                }}
              >
                <Ionicons name="save-outline" size={16} color="#fff" />
                <Text style={{ color: '#fff', fontSize: 12.5, fontWeight: '800' }}>Lưu cấu hình</Text>
              </TouchableOpacity>
            </View>

            {testResult && (
              <View
                style={{
                  backgroundColor: colors.surfaceAlt,
                  padding: 10,
                  borderRadius: 10,
                  borderWidth: 1,
                  borderColor: colors.border,
                }}
              >
                <Text style={{ color: colors.text, fontSize: 12 }}>{testResult}</Text>
              </View>
            )}
          </View>
        )}

        {/* ── 6. PHIÊN BẢN ── */}
        <TouchableOpacity
          onPress={handleVersionTap}
          activeOpacity={0.7}
          style={{ alignItems: 'center', paddingVertical: 8 }}
        >
          <Text style={{ color: colors.textMuted, fontSize: 12, fontWeight: '600' }}>
            Phiên bản v{APP_VERSION} · Chánh Thu WMS
          </Text>
          {showAdvancedConfig && (
            <Text style={{ color: '#d97706', fontSize: 11, fontWeight: '700', marginTop: 2 }}>
              Chế độ kỹ thuật viên đang mở (Chạm 5 lần để ẩn)
            </Text>
          )}
        </TouchableOpacity>
      </ScrollView>

      {/* Modal Tùy Chỉnh Theme Sáng / Tối Cho Từng Menu */}
      <Modal
        visible={isThemeModalOpen}
        transparent
        statusBarTranslucent
        animationType="slide"
        onRequestClose={() => setIsThemeModalOpen(false)}
      >
        <View style={{ flex: 1, backgroundColor: 'rgba(0,0,0,0.55)', justifyContent: 'flex-end' }}>
          <View
            style={{
              backgroundColor: colors.surface,
              borderTopLeftRadius: 24,
              borderTopRightRadius: 24,
              maxHeight: '86%',
              paddingHorizontal: 16,
              paddingTop: 14,
              paddingBottom: 16,
              borderTopWidth: 1,
              borderTopColor: colors.border,
            }}
          >
            <View
              style={{
                flexDirection: 'row',
                alignItems: 'center',
                justifyContent: 'space-between',
                paddingBottom: 12,
                borderBottomWidth: 1,
                borderBottomColor: colors.border,
              }}
            >
              <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
                <Ionicons name="color-palette" size={20} color={colors.primary} />
                <Text style={{ fontSize: 15, fontWeight: '800', color: colors.text }}>
                  Giao diện Sáng / Tối từng Menu
                </Text>
              </View>
              <TouchableOpacity onPress={() => setIsThemeModalOpen(false)} style={{ padding: 4 }}>
                <Ionicons name="close" size={22} color={colors.textMuted} />
              </TouchableOpacity>
            </View>

            <View style={{ flexDirection: 'row', gap: 8, marginTop: 12, marginBottom: 10 }}>
              <TouchableOpacity
                onPress={() => setAllTabsTheme('light')}
                style={{
                  flex: 1,
                  flexDirection: 'row',
                  alignItems: 'center',
                  justifyContent: 'center',
                  gap: 6,
                  paddingVertical: 9,
                  borderRadius: 10,
                  backgroundColor: colors.amberSoftBg,
                  borderWidth: 1,
                  borderColor: colors.amberSoftBorder,
                }}
              >
                <Ionicons name="sunny" size={15} color="#d97706" />
                <Text style={{ fontSize: 11, fontWeight: '800', color: colors.amberSoftText }}>
                  Đặt tất cả Sáng
                </Text>
              </TouchableOpacity>
              <TouchableOpacity
                onPress={() => setAllTabsTheme('dark')}
                style={{
                  flex: 1,
                  flexDirection: 'row',
                  alignItems: 'center',
                  justifyContent: 'center',
                  gap: 6,
                  paddingVertical: 9,
                  borderRadius: 10,
                  backgroundColor: colors.primarySoftBg,
                  borderWidth: 1,
                  borderColor: colors.primarySoftBorder,
                }}
              >
                <Ionicons name="moon" size={15} color={colors.primary} />
                <Text style={{ fontSize: 11, fontWeight: '800', color: colors.primarySoftText }}>
                  Đặt tất cả Tối
                </Text>
              </TouchableOpacity>
            </View>

            <ScrollView showsVerticalScrollIndicator={false} contentContainerStyle={{ gap: 8, paddingVertical: 4 }}>
              {THEME_TAB_META.map(item => {
                const curMode = tabThemes[item.key] || 'light';
                const itemIsDark = curMode === 'dark';
                return (
                  <View
                    key={item.key}
                    style={{
                      flexDirection: 'row',
                      alignItems: 'center',
                      justifyContent: 'space-between',
                      padding: 11,
                      borderRadius: 14,
                      backgroundColor: colors.surfaceAlt,
                      borderWidth: 1,
                      borderColor: colors.border,
                      gap: 10,
                    }}
                  >
                    <View style={{ flexDirection: 'row', alignItems: 'center', gap: 10, flex: 1 }}>
                      <View
                        style={{
                          width: 34,
                          height: 34,
                          borderRadius: 10,
                          backgroundColor: `${item.color}20`,
                          alignItems: 'center',
                          justifyContent: 'center',
                        }}
                      >
                        <Ionicons name={item.icon as any} size={18} color={item.color} />
                      </View>
                      <View style={{ flex: 1 }}>
                        <Text style={{ fontSize: 13, fontWeight: '800', color: colors.text }}>
                          {item.label}
                        </Text>
                        <Text style={{ fontSize: 10, color: colors.textMuted }} numberOfLines={1}>
                          {item.desc}
                        </Text>
                      </View>
                    </View>

                    <View
                      style={{
                        flexDirection: 'row',
                        backgroundColor: colors.surface,
                        borderRadius: 10,
                        borderWidth: 1,
                        borderColor: colors.border,
                        padding: 3,
                        gap: 3,
                      }}
                    >
                      <TouchableOpacity
                        onPress={() => setTabTheme(item.key, 'light')}
                        style={{
                          flexDirection: 'row',
                          alignItems: 'center',
                          gap: 4,
                          paddingHorizontal: 9,
                          paddingVertical: 6,
                          borderRadius: 7,
                          backgroundColor: !itemIsDark ? '#f59e0b' : 'transparent',
                        }}
                      >
                        <Ionicons name="sunny" size={13} color={!itemIsDark ? '#fff' : colors.textMuted} />
                        <Text style={{ fontSize: 11, fontWeight: '800', color: !itemIsDark ? '#fff' : colors.textMuted }}>
                          Sáng
                        </Text>
                      </TouchableOpacity>
                      <TouchableOpacity
                        onPress={() => setTabTheme(item.key, 'dark')}
                        style={{
                          flexDirection: 'row',
                          alignItems: 'center',
                          gap: 4,
                          paddingHorizontal: 9,
                          paddingVertical: 6,
                          borderRadius: 7,
                          backgroundColor: itemIsDark ? '#312e81' : 'transparent',
                        }}
                      >
                        <Ionicons name="moon" size={13} color={itemIsDark ? '#fff' : colors.textMuted} />
                        <Text style={{ fontSize: 11, fontWeight: '800', color: itemIsDark ? '#fff' : colors.textMuted }}>
                          Tối
                        </Text>
                      </TouchableOpacity>
                    </View>
                  </View>
                );
              })}
            </ScrollView>
          </View>
          <ModalNavBarSpacer />
        </View>
      </Modal>

      {/* Modal Cài Đặt Hình Ảnh & Google Drive */}
      <DriveImageSettingsModal
        visible={isDriveModalVisible}
        onClose={() => setIsDriveModalVisible(false)}
        systemCode={systemCode}
      />
    </View>
  );
}