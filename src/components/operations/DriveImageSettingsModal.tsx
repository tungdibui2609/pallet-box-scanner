import React, { useState, useEffect } from 'react';
import {
  Modal,
  View,
  Text,
  TextInput,
  TouchableOpacity,
  StyleSheet,
  ActivityIndicator,
  Alert,
  ScrollView,
} from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import AsyncStorage from '@react-native-async-storage/async-storage';
import {
  getDriveSettings,
  saveDriveSettings,
  OperationDriveSettings,
} from '../../services/operationDriveService';
import {
  getLocalAutoDeleteDays,
  setLocalAutoDeleteDays,
} from '../../services/operationImagesService';
import {
  getWatermarkEnabled,
  setWatermarkEnabled,
} from '../../services/watermarkService';

interface DriveImageSettingsModalProps {
  visible: boolean;
  onClose: () => void;
  systemCode?: string;
}

export const DriveImageSettingsModal: React.FC<DriveImageSettingsModalProps> = ({
  visible,
  onClose,
  systemCode: propSystemCode,
}) => {
  const [resolvedSystemCode, setResolvedSystemCode] = useState(
    propSystemCode || 'KHO_DONG_LANH'
  );
  const [driveSettings, setDriveSettings] = useState<OperationDriveSettings>({
    system_code: propSystemCode || 'KHO_DONG_LANH',
    webhook_url: '',
    root_folder_name: 'WMS_HinhAnh_Kho',
    auto_sync_enabled: true,
  });
  const [localAutoDeleteDays, setLocalAutoDeleteDaysState] = useState<number | null>(null);
  const [watermarkEnabled, setWatermarkEnabledState] = useState(true);
  const [savingDrive, setSavingDrive] = useState(false);
  const [testingDrive, setTestingDrive] = useState(false);

  useEffect(() => {
    if (!visible) return;

    let isMounted = true;
    (async () => {
      let sys = propSystemCode;
      if (!sys) {
        const stored = await AsyncStorage.getItem('config_system_code');
        sys = stored || 'KHO_DONG_LANH';
      }
      if (!isMounted) return;
      setResolvedSystemCode(sys);

      try {
        const cfg = await getDriveSettings(sys);
        if (isMounted) {
          setDriveSettings(cfg);
        }
      } catch (err) {
        console.warn('Lỗi đọc drive settings:', err);
      }

      try {
        const [days, wm] = await Promise.all([
          getLocalAutoDeleteDays(),
          getWatermarkEnabled(),
        ]);
        if (isMounted) {
          setLocalAutoDeleteDaysState(days);
          setWatermarkEnabledState(wm);
        }
      } catch (err) {
        console.warn('Lỗi đọc local days/watermark:', err);
      }
    })();

    return () => {
      isMounted = false;
    };
  }, [visible, propSystemCode]);

  const handleTestDrive = async () => {
    if (!driveSettings.webhook_url.trim()) {
      Alert.alert('Chưa nhập URL', 'Vui lòng dán Webhook URL trước khi kiểm tra');
      return;
    }
    setTestingDrive(true);
    try {
      const res = await fetch(driveSettings.webhook_url.trim(), {
        method: 'POST',
        headers: { 'Content-Type': 'text/plain;charset=utf-8' },
        body: JSON.stringify({
          action: 'ping',
          rootFolder: driveSettings.root_folder_name.trim() || 'WMS_HinhAnh_Kho',
        }),
      });
      const data = await res.json();
      if (data?.success) {
        Alert.alert('Thành công', data?.message || 'Kết nối Google Apps Script Webhook hoạt động tốt!');
      } else {
        Alert.alert('Thất bại', data?.error || 'Không kết nối được tới Webhook. Vui lòng kiểm tra lại URL.');
      }
    } catch (e: any) {
      Alert.alert('Lỗi kiểm tra', e?.message || 'Có lỗi xảy ra khi kết nối tới Webhook');
    } finally {
      setTestingDrive(false);
    }
  };

  const handleSaveDrive = async () => {
    setSavingDrive(true);
    try {
      await saveDriveSettings({
        ...driveSettings,
        system_code: resolvedSystemCode,
      });
      await setLocalAutoDeleteDays(localAutoDeleteDays);
      await setWatermarkEnabled(watermarkEnabled);

      Alert.alert('Thành công', 'Đã lưu cấu hình Google Drive & Hình ảnh!');
      onClose();
    } catch (err: any) {
      Alert.alert('Lỗi lưu cấu hình', err?.message || 'Không thể lưu cài đặt');
    } finally {
      setSavingDrive(false);
    }
  };

  return (
    <Modal
      visible={visible}
      transparent
      animationType="slide"
      onRequestClose={onClose}
    >
      <View style={styles.settingsOverlay}>
        <View style={styles.settingsSheet}>
          <ScrollView showsVerticalScrollIndicator={false}>
            {/* Header */}
            <View style={styles.headerRow}>
              <View style={{ flex: 1 }}>
                <Text style={styles.settingsTitle}>Cài Đặt Hình Ảnh & Drive</Text>
                <Text style={styles.settingsSubtitle}>Phân hệ: {resolvedSystemCode}</Text>
              </View>
              <TouchableOpacity onPress={onClose} style={styles.headerCloseBtn}>
                <Ionicons name="close" size={20} color="#94a3b8" />
              </TouchableOpacity>
            </View>

            {/* Webhook URL */}
            <Text style={styles.settingsLabel}>Google Apps Script Webhook URL</Text>
            <TextInput
              style={styles.settingsInput}
              placeholder="https://script.google.com/macros/s/.../exec"
              placeholderTextColor="#64748b"
              value={driveSettings.webhook_url}
              onChangeText={(t) => setDriveSettings((prev) => ({ ...prev, webhook_url: t }))}
              autoCapitalize="none"
              autoCorrect={false}
            />

            {/* Thư mục gốc */}
            <Text style={styles.settingsLabel}>Tên thư mục gốc trên Drive</Text>
            <TextInput
              style={styles.settingsInput}
              placeholder="WMS_HinhAnh_Kho"
              placeholderTextColor="#64748b"
              value={driveSettings.root_folder_name}
              onChangeText={(t) => setDriveSettings((prev) => ({ ...prev, root_folder_name: t }))}
            />

            {/* Tự động xóa ảnh gốc */}
            <Text style={styles.settingsLabel}>
              Tự động xóa ảnh gốc trên máy này (khi đã đồng bộ Drive)
            </Text>
            <View style={styles.daysRow}>
              {[
                { label: 'Không xóa', value: null },
                { label: '1 ngày', value: 1 },
                { label: '3 ngày', value: 3 },
                { label: '7 ngày', value: 7 },
                { label: '14 ngày', value: 14 },
                { label: '30 ngày', value: 30 },
              ].map((opt) => {
                const active = (localAutoDeleteDays ?? null) === opt.value;
                return (
                  <TouchableOpacity
                    key={String(opt.value)}
                    onPress={() => setLocalAutoDeleteDaysState(opt.value)}
                    style={[
                      styles.dayBtn,
                      active && styles.dayBtnActive,
                    ]}
                  >
                    <Text
                      style={[
                        styles.dayBtnText,
                        active && styles.dayBtnTextActive,
                      ]}
                    >
                      {opt.label}
                    </Text>
                  </TouchableOpacity>
                );
              })}
            </View>
            <Text style={styles.noteText}>
              * Chỉ áp dụng cho điện thoại này. File nén tạm luôn tự xóa ngay sau khi đẩy lên Drive thành công.
            </Text>

            {/* Đóng dấu Timemark */}
            <TouchableOpacity
              onPress={() => setWatermarkEnabledState((v) => !v)}
              style={[
                styles.timemarkBox,
                watermarkEnabled && styles.timemarkBoxActive,
              ]}
            >
              <View style={{ flex: 1, paddingRight: 8 }}>
                <Text style={styles.timemarkTitle}>
                  Đóng dấu thông tin lên ảnh (Timemark)
                </Text>
                <Text style={styles.timemarkDesc}>
                  Tự ghi ngày giờ, kho, tên hàng, số lượng & người chụp vào ảnh
                </Text>
              </View>
              <Ionicons
                name={watermarkEnabled ? 'checkmark-circle' : 'ellipse-outline'}
                size={22}
                color={watermarkEnabled ? '#fbbf24' : '#64748b'}
              />
            </TouchableOpacity>

            {/* Mẹo */}
            <View style={styles.tipBox}>
              <Text style={styles.tipText}>
                💡 Chỉ cần cài đặt 1 lần trên Web (mục Số Liệu → Album Hình Ảnh → Cài đặt Google Drive) hoặc dán URL vào đây, toàn bộ thiết bị trong kho sẽ tự động dùng chung. Ảnh giữ trên máy khi mất mạng và tự đẩy lên Google Drive khi có mạng.
              </Text>
            </View>

            {/* Các nút bấm */}
            <View style={styles.btnRow}>
              <TouchableOpacity
                onPress={handleTestDrive}
                disabled={testingDrive}
                style={styles.testBtn}
              >
                {testingDrive ? (
                  <ActivityIndicator size="small" color="#38bdf8" />
                ) : (
                  <>
                    <Ionicons name="flash-outline" size={14} color="#38bdf8" />
                    <Text style={styles.testBtnText}>Kiểm tra</Text>
                  </>
                )}
              </TouchableOpacity>

              <TouchableOpacity onPress={onClose} style={styles.cancelBtn}>
                <Text style={styles.cancelBtnText}>Đóng</Text>
              </TouchableOpacity>

              <TouchableOpacity
                onPress={handleSaveDrive}
                disabled={savingDrive}
                style={styles.saveBtn}
              >
                {savingDrive ? (
                  <ActivityIndicator size="small" color="#fff" />
                ) : (
                  <Text style={styles.saveBtnText}>Lưu</Text>
                )}
              </TouchableOpacity>
            </View>
          </ScrollView>
        </View>
      </View>
    </Modal>
  );
};

const styles = StyleSheet.create({
  settingsOverlay: {
    flex: 1,
    backgroundColor: 'rgba(0,0,0,0.7)',
    justifyContent: 'flex-end',
  },
  settingsSheet: {
    backgroundColor: '#1e293b',
    borderTopLeftRadius: 20,
    borderTopRightRadius: 20,
    padding: 18,
    maxHeight: '90%',
  },
  headerRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    marginBottom: 12,
  },
  settingsTitle: {
    color: '#fff',
    fontSize: 16,
    fontWeight: '800',
  },
  settingsSubtitle: {
    color: '#94a3b8',
    fontSize: 11,
    marginTop: 2,
  },
  headerCloseBtn: {
    padding: 6,
    borderRadius: 8,
    backgroundColor: '#0f172a',
  },
  settingsLabel: {
    color: '#cbd5e1',
    fontSize: 12,
    fontWeight: '700',
    marginTop: 10,
    marginBottom: 4,
  },
  settingsInput: {
    backgroundColor: '#0f172a',
    borderRadius: 10,
    borderWidth: 1,
    borderColor: '#334155',
    color: '#fff',
    paddingHorizontal: 12,
    paddingVertical: 8,
    fontSize: 12,
  },
  daysRow: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 6,
    marginBottom: 6,
  },
  dayBtn: {
    paddingHorizontal: 10,
    paddingVertical: 6,
    borderRadius: 8,
    borderWidth: 1,
    borderColor: '#334155',
    backgroundColor: '#0f172a',
  },
  dayBtnActive: {
    borderColor: '#10b981',
    backgroundColor: 'rgba(16,185,129,0.18)',
  },
  dayBtnText: {
    color: '#cbd5e1',
    fontSize: 12,
    fontWeight: '700',
  },
  dayBtnTextActive: {
    color: '#34d399',
  },
  noteText: {
    color: '#94a3b8',
    fontSize: 11,
    marginBottom: 4,
  },
  timemarkBox: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    backgroundColor: '#0f172a',
    borderWidth: 1,
    borderColor: '#334155',
    borderRadius: 10,
    paddingHorizontal: 12,
    paddingVertical: 10,
    marginTop: 6,
  },
  timemarkBoxActive: {
    backgroundColor: 'rgba(245,158,11,0.12)',
    borderColor: '#f59e0b',
  },
  timemarkTitle: {
    color: '#f8fafc',
    fontSize: 12,
    fontWeight: '700',
  },
  timemarkDesc: {
    color: '#94a3b8',
    fontSize: 11,
    marginTop: 2,
  },
  tipBox: {
    backgroundColor: 'rgba(99,102,241,0.12)',
    borderColor: 'rgba(99,102,241,0.35)',
    borderWidth: 1,
    borderRadius: 10,
    padding: 10,
    marginTop: 10,
  },
  tipText: {
    color: '#c7d2fe',
    fontSize: 11,
    lineHeight: 16,
  },
  btnRow: {
    flexDirection: 'row',
    gap: 10,
    marginTop: 14,
    marginBottom: 10,
  },
  testBtn: {
    paddingHorizontal: 12,
    paddingVertical: 10,
    borderRadius: 10,
    backgroundColor: '#0f172a',
    borderWidth: 1,
    borderColor: '#38bdf8',
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
  },
  testBtnText: {
    color: '#38bdf8',
    fontWeight: '700',
    fontSize: 12,
  },
  cancelBtn: {
    flex: 1,
    backgroundColor: '#334155',
    borderRadius: 10,
    paddingVertical: 10,
    alignItems: 'center',
  },
  cancelBtnText: {
    color: '#cbd5e1',
    fontWeight: '700',
    fontSize: 13,
  },
  saveBtn: {
    flex: 1.2,
    backgroundColor: '#10b981',
    borderRadius: 10,
    paddingVertical: 10,
    alignItems: 'center',
  },
  saveBtnText: {
    color: '#fff',
    fontWeight: '700',
    fontSize: 13,
  },
});
