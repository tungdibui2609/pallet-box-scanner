import React, { useState, useEffect, useRef } from 'react';
import {
  View, Text, StyleSheet, TouchableOpacity, ScrollView,
  Alert, Modal, TextInput, ActivityIndicator, Vibration, Animated, Platform, AppState, NativeModules
} from 'react-native';
import { CameraView, useCameraPermissions } from 'expo-camera';
import TextRecognition from '@react-native-ml-kit/text-recognition';
import * as Haptics from 'expo-haptics';
import { Ionicons } from '@expo/vector-icons';

let VolumeManager: any = null;
if (NativeModules && NativeModules.VolumeManager) {
  try {
    VolumeManager = require('react-native-volume-manager').VolumeManager;
  } catch (err) {
    console.warn('VolumeManager not linked:', err);
  }
}
import { Pallet, BoxLabel, ParsedStampData, StampFormat } from '../types';
import {
  getActivePallet, createNewPallet, completePallet,
  getBoxesByPallet, addStampBoxToPallet, deleteBox,
  getPalletByCode, activateExistingPallet, getStampDictionariesMap,
  getActiveStampFormat, cloneBoxToPallet, addStampBoxesBulkToPallet,
  updatePalletTag, updatePalletTagAndNotes, resetPalletBoxes
} from '../services/database';
import { parseStampText, isStampContent, decodeStamp } from '../services/stampParser';
import { syncStampDictionariesFromSupabase } from '../services/supabase';

export default function StampScannerScreen({ onNavigateToPallets }: { onNavigateToPallets: () => void }) {
  const [permission, requestPermission] = useCameraPermissions();
  const cameraRef = useRef<any>(null);

  const [activePallet, setActivePallet] = useState<Pallet | null>(null);
  const [boxes, setBoxes] = useState<BoxLabel[]>([]);
  const [isScanning, setIsScanning] = useState(false);
  const [torch, setTorch] = useState(false);
  const [cameraEnabled, setCameraEnabled] = useState(true);
  const [isAppActive, setIsAppActive] = useState(AppState.currentState === 'active');

  useEffect(() => {
    const sub = AppState.addEventListener('change', (nextState) => {
      const active = nextState === 'active';
      setIsAppActive(active);
      if (!active) {
        setTorch(false);
      }
    });
    return () => sub.remove();
  }, []);

  const isCameraRunning = cameraEnabled && isAppActive && !!activePallet;
  const lastVolumeRef = useRef<number>(0.5);
  const captureHandlerRef = useRef<() => void>(() => {});

  function toggleCamera() {
    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
    setCameraEnabled(prev => {
      if (prev) setTorch(false);
      return !prev;
    });
  }

  // Bấm nút Giảm âm lượng để chụp dấu mực
  useEffect(() => {
    if (!VolumeManager) return;
    let volumeListener: any = null;

    async function setupVolumeTrigger() {
      try {
        await VolumeManager.showNativeVolumeUI({ enabled: false });
        await VolumeManager.setVolume(0.5);
        lastVolumeRef.current = 0.5;

        volumeListener = VolumeManager.addVolumeListener(async (result: any) => {
          if (result.volume < lastVolumeRef.current) {
            captureHandlerRef.current?.();
          }
          lastVolumeRef.current = 0.5;
          await VolumeManager.setVolume(0.5, { showUI: false, playSound: false });
        });
      } catch (err) {
        console.warn('VolumeManager listener setup:', err);
      }
    }

    setupVolumeTrigger();

    return () => {
      if (volumeListener && typeof volumeListener.remove === 'function') {
        volumeListener.remove();
      }
      VolumeManager?.showNativeVolumeUI({ enabled: true })?.catch(() => {});
    };
  }, [activePallet]);

  // Pallet Modal
  const [isNewPalletModal, setIsNewPalletModal] = useState(false);
  const [newPalletCode, setNewPalletCode] = useState('');
  const [newPalletTag, setNewPalletTag] = useState('');
  const [newPalletNotes, setNewPalletNotes] = useState('');
  const [newTargetQty, setNewTargetQty] = useState('30');

  // Stamp Scanned Confirmation Modal
  const [pendingStamp, setPendingStamp] = useState<ParsedStampData | null>(null);
  const [pendingWeight, setPendingWeight] = useState('20');
  const [pendingCount, setPendingCount] = useState('1');
  const [isSaving, setIsSaving] = useState(false);

  // Manual Input Modal
  const [isManualModal, setIsManualModal] = useState(false);
  const [manualLine1, setManualLine1] = useState('10102010204001');
  const [manualLine2, setManualLine2] = useState('1110926001471609');
  const [manualWeight, setManualWeight] = useState('20');
  const [manualCount, setManualCount] = useState('1');

  // Clone Existing Box Modal
  const [cloneModalVisible, setCloneModalVisible] = useState(false);
  const [cloneSampleBox, setCloneSampleBox] = useState<BoxLabel | null>(null);
  const [cloneCount, setCloneCount] = useState('1');
  const [isCloning, setIsCloning] = useState(false);

  // Success Feedback Banner
  const [successBanner, setSuccessBanner] = useState<string | null>(null);
  const bannerAnim = useRef(new Animated.Value(0)).current;

  // Offline Stamp Dictionary Map & Active Template
  const [dictMap, setDictMap] = useState<Record<string, Record<string, string>>>({});
  const [activeFormat, setActiveFormat] = useState<StampFormat | null>(null);
  const [syncingRules, setSyncingRules] = useState(false);

  async function handleSyncStampRules() {
    if (syncingRules) return;
    setSyncingRules(true);
    try {
      Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium);
      const res = await syncStampDictionariesFromSupabase();
      if (res.success) {
        await refreshStampRules();
        Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
        Alert.alert('Thành công', res.message || `Đã tải ${res.count} quy tắc dấu đóng mới nhất về máy.`);
      } else {
        Alert.alert('Không thể tải', res.message || 'Vui lòng kiểm tra kết nối mạng.');
      }
    } catch (e: any) {
      Alert.alert('Lỗi', e?.message || 'Không thể tải quy tắc dấu đóng.');
    } finally {
      setSyncingRules(false);
    }
  }

  useEffect(() => {
    loadActivePallet();
    refreshStampRules();
  }, []);

  async function refreshStampRules() {
    try {
      const [map, fmt] = await Promise.all([
        getStampDictionariesMap(),
        getActiveStampFormat()
      ]);
      setDictMap(map);
      setActiveFormat(fmt);
    } catch (e) {
      console.warn('Lỗi nạp từ điển con dấu:', e);
    }
  }

  async function loadActivePallet() {
    try {
      const pallet = await getActivePallet();
      if (pallet) {
        const boxList = await getBoxesByPallet(pallet.id);
        setActivePallet(pallet);
        setBoxes(boxList);
      } else {
        setActivePallet(null);
        setBoxes([]);
      }
    } catch (e: any) {
      console.error('Error loading pallet:', e);
    }
  }

  function triggerSuccessBanner(text: string) {
    setSuccessBanner(text);
    Animated.sequence([
      Animated.timing(bannerAnim, { toValue: 1, duration: 250, useNativeDriver: true }),
      Animated.delay(2200),
      Animated.timing(bannerAnim, { toValue: 0, duration: 250, useNativeDriver: true })
    ]).start(() => setSuccessBanner(null));
  }

  // ── Chụp và nhận diện con dấu mực ──────────────────────────
  async function handleCaptureAndRecognize() {
    if (!activePallet) {
      Alert.alert(
        'Chưa có Pallet',
        'Vui lòng nhập Số Thứ Tự (STT) Pallet trước khi quét dấu thùng!',
        [
          { text: 'Huỷ', style: 'cancel' },
          { text: 'Nhập STT Pallet', onPress: () => setIsNewPalletModal(true) }
        ]
      );
      return;
    }
    if (!cameraEnabled) {
      Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
      setCameraEnabled(true);
      return;
    }
    if (!cameraRef.current || isScanning) return;

    try {
      setIsScanning(true);
      Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);

      const photo = await cameraRef.current.takePictureAsync({
        quality: 0.9,
        skipProcessing: false,
      });

      if (!photo?.uri) {
        throw new Error('Không chụp được ảnh từ camera');
      }

      // OCR qua Google ML Kit
      if (TextRecognition && typeof TextRecognition.recognize === 'function') {
        const mlResult = await TextRecognition.recognize(photo.uri);
        const raw = mlResult?.text || '';

        if (!raw.trim()) {
          Alert.alert('Không nhận diện được', 'Camera không thấy chữ số nào trong khung ngắm. Vui lòng căn chỉnh lại gần dấu mực hơn.');
          return;
        }

        let currentDict = dictMap;
        let currentFmt = activeFormat;
        try {
          const [m, f] = await Promise.all([getStampDictionariesMap(), getActiveStampFormat()]);
          currentDict = m;
          currentFmt = f;
          setDictMap(m);
          setActiveFormat(f);
        } catch {}

        const parsed = parseStampText(raw, currentDict, currentFmt);
        if (parsed && (parsed.stamp_line1 || parsed.stamp_line2)) {
          Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
          Vibration.vibrate(80);
          setPendingStamp(parsed);
          setPendingWeight('20');
        } else {
          Haptics.notificationAsync(Haptics.NotificationFeedbackType.Warning);
          Alert.alert(
            'Chưa nhận diện đủ dãy số',
            `Văn bản đọc được:\n"${raw.slice(0, 100)}"\n\nVui lòng giữ chắc tay và chụp vuông góc với 2 dòng số đóng dấu.`
          );
        }
      } else {
        Alert.alert('Thông báo', 'Bộ nhận diện ML Kit chưa sẵn sàng trên thiết bị này.');
      }
    } catch (err: any) {
      Alert.alert('Lỗi quét', err.message || 'Không thể chụp ảnh');
    } finally {
      setIsScanning(false);
    }
  }

  // ── Xác nhận lưu thùng vào Pallet ─────────────────────────
  async function handleConfirmSaveStampBox() {
    if (!pendingStamp || !activePallet) return;

    setIsSaving(true);
    try {
      const w = parseFloat(pendingWeight) || 20;
      const count = parseInt(pendingCount, 10) || 1;

      if (count > 1) {
        const res = await addStampBoxesBulkToPallet(activePallet.id, pendingStamp, w, count);
        Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
        triggerSuccessBanner(`✨ Đã nhân bản ${res.addedCount} thùng con dấu vào Pallet ${activePallet.code}!`);
      } else {
        const res = await addStampBoxToPallet(activePallet.id, pendingStamp, w);
        Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
        triggerSuccessBanner(`✅ Đã lưu thùng #${res.box.box_index} (Dòng 1: ${pendingStamp.stamp_line1})`);
      }
      
      setPendingStamp(null);
      setPendingCount('1');
      await loadActivePallet();
    } catch (err: any) {
      Haptics.notificationAsync(Haptics.NotificationFeedbackType.Error);
      Alert.alert('Lỗi lưu thùng', err.message);
    } finally {
      setIsSaving(false);
    }
  }

  // ── Lưu thùng nhập tay ────────────────────────────────────
  async function handleSaveManual() {
    if (!activePallet) return;
    if (!manualLine1.trim() && !manualLine2.trim()) {
      Alert.alert('Lỗi', 'Vui lòng nhập ít nhất 1 dòng số đóng dấu');
      return;
    }

    try {
      let currentDict = dictMap;
      let currentFmt = activeFormat;
      try {
        const [m, f] = await Promise.all([getStampDictionariesMap(), getActiveStampFormat()]);
        currentDict = m;
        currentFmt = f;
        setDictMap(m);
        setActiveFormat(f);
      } catch {}

      const stampData: ParsedStampData = {
        stamp_line1: manualLine1.trim(),
        stamp_line2: manualLine2.trim(),
        raw_text: `${manualLine1.trim()}\n${manualLine2.trim()}`,
        detected_lines: [manualLine1.trim(), manualLine2.trim()].filter(Boolean),
        decoded: decodeStamp(manualLine1.trim(), manualLine2.trim(), currentDict, currentFmt)
      };

      const w = parseFloat(manualWeight) || 20;
      const count = parseInt(manualCount, 10) || 1;

      if (count > 1) {
        const res = await addStampBoxesBulkToPallet(activePallet.id, stampData, w, count);
        setIsManualModal(false);
        setManualCount('1');
        Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
        triggerSuccessBanner(`✨ Đã tạo & nhân bản ${res.addedCount} thùng vào Pallet ${activePallet.code}!`);
      } else {
        const res = await addStampBoxToPallet(activePallet.id, stampData, w);
        setIsManualModal(false);
        setManualCount('1');
        Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
        triggerSuccessBanner(`✅ Đã lưu thùng #${res.box.box_index} (${stampData.stamp_line1})`);
      }
      await loadActivePallet();
    } catch (err: any) {
      Alert.alert('Lỗi', err.message);
    }
  }

  // ── Nhân bản từ thùng đã quét ────────────────────────────
  function handleOpenCloneModal(box: BoxLabel) {
    if (!activePallet) return;
    const remaining = Math.max(1, activePallet.target_qty - boxes.length);
    setCloneSampleBox(box);
    setCloneCount(String(remaining));
    setCloneModalVisible(true);
  }

  async function handleConfirmClone() {
    if (!activePallet || !cloneSampleBox) return;
    const qty = parseInt(cloneCount, 10);
    if (isNaN(qty) || qty <= 0) {
      Alert.alert('Số lượng không hợp lệ', 'Vui lòng nhập số lượng thùng cần nhân bản lớn hơn 0.');
      return;
    }
    try {
      setIsCloning(true);
      const res = await cloneBoxToPallet(activePallet.id, cloneSampleBox, qty);
      await loadActivePallet();
      setCloneModalVisible(false);
      Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
      triggerSuccessBanner(`✨ Đã nhân bản ${res.addedCount} thùng vào Pallet ${activePallet.code}!`);
    } catch (err: any) {
      Alert.alert('Lỗi nhân bản', err.message);
    } finally {
      setIsCloning(false);
    }
  }

  // ── Làm mới / Xoá toàn bộ thùng của Pallet đang chọn ─────
  function handleResetActivePallet() {
    if (!activePallet) return;
    Alert.alert(
      `Xoá thùng Pallet ${activePallet.code}?`,
      `Bạn có chắc chắn muốn xoá toàn bộ ${boxes.length} thùng (${activePallet.total_weight.toFixed(1)} Kg) của Pallet ${activePallet.code} để quét lại từ đầu không?`,
      [
        { text: 'Huỷ', style: 'cancel' },
        {
          text: '🔄 Xoá và Quét lại',
          style: 'destructive',
          onPress: async () => {
            try {
              await resetPalletBoxes(activePallet.id);
              await loadActivePallet();
              Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
              triggerSuccessBanner(`Đã làm mới Pallet ${activePallet.code} về 0 thùng!`);
            } catch (err: any) {
              Alert.alert('Lỗi', err.message);
            }
          }
        }
      ]
    );
  }

  // ── Tạo Pallet mới ───────────────────────────────────────
  async function handleCreateNewPallet() {
    if (!newPalletCode.trim()) {
      Alert.alert('Lỗi', 'Vui lòng nhập Số Thứ Tự (STT) Pallet (Ví dụ: C544, F3219, G588...)');
      return;
    }

    try {
      const cleanCode = newPalletCode.trim().toUpperCase();
      const existing = await getPalletByCode(cleanCode);

      if (existing) {
        if (existing.scanned_qty > 0) {
          Alert.alert(
            `⚠️ STT ${cleanCode} ĐÃ CÓ TRONG HỆ THỐNG!`,
            `STT ${cleanCode} hiện đang có ${existing.scanned_qty} thùng (${existing.total_weight.toFixed(1)} Kg).\n\nPallet này có bị xáo trộn hàng và bạn cần quét lại không?`,
            [
              {
                text: '🔄 Quét lại từ đầu (Xoá cũ)',
                style: 'destructive',
                onPress: async () => {
                  await updatePalletTagAndNotes(existing.id, newPalletTag.trim() || null, newPalletNotes.trim() || null);
                  await resetPalletBoxes(existing.id);
                  const activated = (await activateExistingPallet(existing.id)) || existing;
                  setActivePallet({
                    ...activated,
                    tag: newPalletTag.trim() || existing.tag,
                    notes: newPalletNotes.trim() || existing.notes,
                    scanned_qty: 0,
                    total_weight: 0
                  });
                  setBoxes([]);
                  setIsNewPalletModal(false);
                  setNewPalletCode('');
                  setNewPalletTag('');
                  setNewPalletNotes('');
                  Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
                  triggerSuccessBanner(`Đã đặt lại STT ${cleanCode} về 0 thùng để quét lại!`);
                }
              },
              {
                text: 'Tiếp tục quét thêm',
                onPress: async () => {
                  await updatePalletTagAndNotes(existing.id, newPalletTag.trim() || null, newPalletNotes.trim() || null);
                  const activated = (await activateExistingPallet(existing.id)) || existing;
                  setActivePallet({
                    ...activated,
                    tag: newPalletTag.trim() || existing.tag,
                    notes: newPalletNotes.trim() || existing.notes
                  });
                  const existingBoxes = await getBoxesByPallet(existing.id);
                  setBoxes(existingBoxes);
                  setIsNewPalletModal(false);
                  setNewPalletCode('');
                  setNewPalletTag('');
                  setNewPalletNotes('');
                  Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
                }
              },
              { text: 'Huỷ', style: 'cancel' }
            ]
          );
          return;
        } else {
          await updatePalletTagAndNotes(existing.id, newPalletTag.trim() || null, newPalletNotes.trim() || null);
          const activated = (await activateExistingPallet(existing.id)) || existing;
          setActivePallet({
            ...activated,
            tag: newPalletTag.trim() || existing.tag,
            notes: newPalletNotes.trim() || existing.notes
          });
          setBoxes([]);
          setIsNewPalletModal(false);
          setNewPalletCode('');
          setNewPalletTag('');
          setNewPalletNotes('');
          Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
          return;
        }
      }

      const qty = parseInt(newTargetQty, 10) || 30;
      const targetPallet = await createNewPallet(
        cleanCode,
        qty,
        'KHO_DONG_LANH',
        newPalletTag.trim() || null,
        newPalletNotes.trim() || null
      );
      setActivePallet(targetPallet);
      setBoxes([]);
      setIsNewPalletModal(false);
      setNewPalletCode('');
      setNewPalletTag('');
      setNewPalletNotes('');
      Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
    } catch (e: any) {
      Alert.alert('Lỗi', e.message);
    }
  }

  captureHandlerRef.current = handleCaptureAndRecognize;

  async function handleDeleteBox(box: BoxLabel) {
    Alert.alert(
      'Xóa thùng hàng',
      `Bạn muốn xóa thùng #${box.box_index} (${box.stamp_line1 || box.lot_code}) khỏi Pallet?`,
      [
        { text: 'Hủy', style: 'cancel' },
        {
          text: 'Xóa',
          style: 'destructive',
          onPress: async () => {
            if (!activePallet) return;
            await deleteBox(box.id, activePallet.id);
            await loadActivePallet();
          }
        }
      ]
    );
  }

  async function handleCompletePallet() {
    if (!activePallet) return;
    Alert.alert(
      'Hoàn thành & Chốt Pallet?',
      `Pallet ${activePallet.code} đã có ${boxes.length} thùng (${activePallet.total_weight.toFixed(1)} Kg).`,
      [
        { text: 'Chưa chốt', style: 'cancel' },
        {
          text: 'Chốt Pallet',
          onPress: async () => {
            await completePallet(activePallet.id);
            setActivePallet(null);
            setBoxes([]);
            Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
            Alert.alert('Đã chốt', `Pallet ${activePallet.code} đã hoàn thành!`);
          }
        }
      ]
    );
  }

  if (!permission) {
    return (
      <View style={styles.centerContainer}>
        <ActivityIndicator size="large" color="#38bdf8" />
        <Text style={styles.permissionText}>Đang yêu cầu quyền camera...</Text>
      </View>
    );
  }

  if (!permission.granted) {
    return (
      <View style={styles.centerContainer}>
        <Ionicons name="camera-outline" size={64} color="#94a3b8" />
        <Text style={styles.permissionTitle}>Cần quyền truy cập Camera</Text>
        <Text style={styles.permissionText}>App cần sử dụng máy ảnh để quét dãy số dấu mực trên thùng.</Text>
        <TouchableOpacity style={styles.primaryBtn} onPress={requestPermission}>
          <Text style={styles.primaryBtnText}>Cấp Quyền Camera</Text>
        </TouchableOpacity>
      </View>
    );
  }

  const isPalletFull = activePallet && boxes.length >= activePallet.target_qty;

  return (
    <View style={styles.container}>
      {/* ── TOP PALLET STATUS BAR ─────────────────────────── */}
      <View style={styles.topBar}>
        <View style={styles.palletInfoRow}>
          <TouchableOpacity
            style={styles.palletBadge}
            onPress={() => {
              setNewPalletCode(activePallet?.code || '');
              setNewPalletTag(activePallet?.tag || '');
              setNewPalletNotes(activePallet?.notes || '');
              setNewTargetQty(String(activePallet?.target_qty || 30));
              setIsNewPalletModal(true);
            }}
            activeOpacity={0.8}
          >
            <Ionicons name="finger-print" size={16} color="#fbbf24" />
            <Text style={styles.palletBadgeLabel}>DẤU MỰC</Text>
            <Text style={styles.palletCodeText}>
              {activePallet ? `STT: ${activePallet.code}` : 'Chưa chọn Pallet'}
            </Text>
            {activePallet?.tag ? (
              <View style={{ backgroundColor: '#ea580c', paddingHorizontal: 6, paddingVertical: 2, borderRadius: 6, marginLeft: 4 }}>
                <Text style={{ color: '#fff', fontSize: 10, fontWeight: '800' }}>🏷️ {activePallet.tag}</Text>
              </View>
            ) : null}
            {activePallet?.notes ? (
              <View style={{ backgroundColor: '#2563eb', paddingHorizontal: 6, paddingVertical: 2, borderRadius: 6, marginLeft: 4 }}>
                <Text style={{ color: '#fff', fontSize: 10, fontWeight: '800' }}>📝 Ghi chú</Text>
              </View>
            ) : null}
            <Ionicons name="chevron-down" size={14} color="#94a3b8" style={{ marginLeft: 2 }} />
          </TouchableOpacity>

          <View style={styles.topActionBtns}>
            <TouchableOpacity
              style={[styles.iconButton, { borderColor: '#10b98155', borderWidth: 1 }]}
              onPress={handleSyncStampRules}
              disabled={syncingRules}
            >
              {syncingRules ? (
                <ActivityIndicator size="small" color="#34d399" />
              ) : (
                <Ionicons name="cloud-download-outline" size={18} color="#34d399" />
              )}
            </TouchableOpacity>
          </View>
        </View>

        {activePallet ? (
          <View style={styles.progressContainer}>
            <View style={styles.progressHeader}>
              <View style={{ flexDirection: 'row', alignItems: 'center' }}>
                <Text style={styles.progressText}>
                  Tiến độ: <Text style={styles.progressHighlight}>{boxes.length}</Text> / {activePallet.target_qty} thùng
                </Text>
                {boxes.length > 0 && (
                  <TouchableOpacity
                    style={styles.resetButton}
                    onPress={handleResetActivePallet}
                  >
                    <Ionicons name="refresh-outline" size={12} color="#ef4444" />
                    <Text style={styles.resetButtonText}>Làm mới</Text>
                  </TouchableOpacity>
                )}
              </View>
              <Text style={styles.weightText}>
                Tổng: <Text style={styles.progressHighlight}>{activePallet.total_weight.toFixed(1)}</Text> Kg
              </Text>
            </View>
            <View style={styles.progressBarBg}>
              <View
                style={[
                  styles.progressBarFill,
                  { width: `${Math.min(100, (boxes.length / activePallet.target_qty) * 100)}%` },
                  isPalletFull && styles.progressBarFull
                ]}
              />
            </View>
          </View>
        ) : (
          <View style={styles.noPalletTipBar}>
            <Ionicons name="information-circle-outline" size={16} color="#38bdf8" />
            <Text style={styles.noPalletTipText}>Bạn chưa chọn Pallet. Hãy bấm chọn Pallet để bắt đầu.</Text>
          </View>
        )}
      </View>

      {/* ── HARDWARE VOLUME KEY HINT & TORCH ─────────────── */}
      <View style={styles.volumeBar}>
        <View style={styles.volumeKeyHintBadge}>
          <Ionicons name="volume-low" size={15} color="#38bdf8" />
          <Text style={styles.volumeKeyHintText}>Bấm [Giảm âm lượng] để chụp</Text>
        </View>

        <TouchableOpacity
          style={[styles.torchBtn, !isCameraRunning && { opacity: 0.45 }]}
          onPress={() => {
            if (!isCameraRunning) return;
            setTorch(t => !t);
          }}
          disabled={!isCameraRunning}
        >
          <Ionicons
            name={torch && isCameraRunning ? 'flash' : 'flash-outline'}
            size={18}
            color={torch && isCameraRunning ? '#facc15' : '#94a3b8'}
          />
        </TouchableOpacity>
      </View>

      {/* ── CAMERA BOX (GỌN GIỐNG QUÉT TEM) ──────────────── */}
      <View style={styles.compactCameraBox}>
        {!activePallet ? (
          <View style={styles.noPalletOverlay}>
            <Ionicons name="cube-outline" size={36} color="#38bdf8" />
            <Text style={styles.noPalletOverlayTitle}>Chưa chọn Pallet</Text>
            <Text style={styles.noPalletOverlaySub}>
              Để tránh quét nhầm hàng, vui lòng chọn hoặc nhập số Pallet trước.
            </Text>
            <TouchableOpacity
              style={styles.selectPalletOverlayBtn}
              onPress={() => setIsNewPalletModal(true)}
            >
              <Ionicons name="add-circle-outline" size={18} color="#fff" />
              <Text style={styles.selectPalletOverlayBtnText}>Chọn / Nhập Pallet Ngay</Text>
            </TouchableOpacity>
          </View>
        ) : isCameraRunning ? (
          <>
            <CameraView
              ref={cameraRef}
              style={StyleSheet.absoluteFill}
              facing="back"
              enableTorch={torch}
            />

            {/* Khung ngắm 2 dòng dấu mực gọn */}
            <View style={styles.compactReticleContainer}>
              <View style={[styles.compactStampFrame, isScanning && styles.stampTargetFrameScanning]}>
                <View style={[styles.corner, styles.tl]} />
                <View style={[styles.corner, styles.tr]} />
                <View style={[styles.corner, styles.bl]} />
                <View style={[styles.corner, styles.br]} />

                <View style={styles.lineGuideRow}>
                  <Text style={styles.lineGuideTag}>Dòng 1</Text>
                  <View style={styles.lineGuideDash} />
                  <Text style={styles.lineGuideExample}>10102010204001</Text>
                </View>

                <View style={[styles.lineGuideRow, { marginTop: 10 }]}>
                  <Text style={styles.lineGuideTag}>Dòng 2</Text>
                  <View style={styles.lineGuideDash} />
                  <Text style={styles.lineGuideExample}>1110926001471609</Text>
                </View>
              </View>

              <Text style={styles.compactHintText}>
                Đặt 2 dòng dấu mực vào khung · Bấm nút hoặc Giảm âm lượng
              </Text>
            </View>

            {/* Nút tắt camera nhanh để tiết kiệm pin */}
            <TouchableOpacity
              style={styles.cameraTogglePill}
              onPress={toggleCamera}
              activeOpacity={0.8}
            >
              <Ionicons name="videocam-off-outline" size={14} color="#fca5a5" />
              <Text style={styles.cameraTogglePillText}>Tắt Camera</Text>
            </TouchableOpacity>
          </>
        ) : (
          <View style={styles.cameraPausedContainer}>
            <Ionicons name="videocam-off-outline" size={34} color="#94a3b8" />
            <Text style={styles.cameraPausedTitle}>Camera đang tắt</Text>
            <Text style={styles.cameraPausedSub}>
              Tạm tắt để tiết kiệm pin. Bạn vẫn có thể Nhập Số bên dưới.
            </Text>
            <TouchableOpacity
              style={styles.cameraEnableBtn}
              onPress={toggleCamera}
              activeOpacity={0.85}
            >
              <Ionicons name="videocam" size={16} color="#0f172a" />
              <Text style={styles.cameraEnableBtnText}>Bật Camera</Text>
            </TouchableOpacity>
          </View>
        )}

        {/* Success Banner */}
        {successBanner && (
          <Animated.View style={[styles.bannerContainer, { opacity: bannerAnim }]}>
            <Text style={styles.bannerText}>{successBanner}</Text>
          </Animated.View>
        )}

        {/* Scanning Spinner */}
        {isScanning && (
          <View style={styles.scanningOverlay}>
            <ActivityIndicator size="large" color="#fbbf24" />
            <Text style={styles.scanningText}>Đang đọc dãy số con dấu...</Text>
          </View>
        )}
      </View>

      {/* ── ACTION BUTTONS ────────────────────────────────── */}
      <View style={styles.actionRow}>
        <TouchableOpacity
          style={[styles.captureActionBtn, (!activePallet || isScanning) && { opacity: 0.6 }]}
          disabled={isScanning}
          onPress={handleCaptureAndRecognize}
        >
          {isScanning ? (
            <>
              <ActivityIndicator color="#ffffff" size="small" />
              <Text style={styles.captureActionText}>Đang đọc dấu...</Text>
            </>
          ) : (
            <>
              <Ionicons name="camera" size={20} color="#ffffff" />
              <Text style={styles.captureActionText}>Chụp Dấu Mực</Text>
            </>
          )}
        </TouchableOpacity>

        <TouchableOpacity
          style={[styles.manualActionBtn, !activePallet && { opacity: 0.6 }]}
          onPress={() => {
            if (!activePallet) {
              setIsNewPalletModal(true);
              return;
            }
            setIsManualModal(true);
          }}
        >
          <Ionicons name="keypad-outline" size={20} color="#38bdf8" />
          <Text style={styles.manualActionText}>Nhập Số</Text>
        </TouchableOpacity>

        {activePallet && boxes.length > 0 && (
          <TouchableOpacity
            style={styles.completeActionBtn}
            onPress={handleCompletePallet}
          >
            <Ionicons name="cube-outline" size={20} color="#ffffff" />
            <Text style={styles.completeActionText}>Chốt Pallet</Text>
          </TouchableOpacity>
        )}
      </View>

      {/* ── DANH SÁCH THÙNG HÀNG ──────────────────────────── */}
      <View style={styles.listHeaderRow}>
        <Text style={styles.listHeaderTitle}>
          {activePallet ? `Danh sách thùng đã quét (${boxes.length})` : 'Thùng hàng'}
        </Text>
        <TouchableOpacity onPress={onNavigateToPallets}>
          <Text style={styles.seeAllText}>Xem tất cả Pallet →</Text>
        </TouchableOpacity>
      </View>

      <ScrollView style={styles.boxList}>
        {!activePallet ? (
          <View style={styles.emptyBox}>
            <Ionicons name="cube-outline" size={32} color="#64748b" />
            <Text style={styles.emptyText}>Chưa có Pallet nào đang chọn</Text>
            <TouchableOpacity onPress={() => setIsNewPalletModal(true)} style={{ marginTop: 8 }}>
              <Text style={{ color: '#10b981', fontWeight: '700' }}>+ Bấm để chọn hoặc nhập Pallet mới</Text>
            </TouchableOpacity>
          </View>
        ) : boxes.length === 0 ? (
          <View style={styles.emptyBox}>
            <Ionicons name="finger-print-outline" size={32} color="#64748b" />
            <Text style={styles.emptyText}>Chưa có thùng nào trong Pallet {activePallet.code}</Text>
            <Text style={styles.emptySubText}>
              Bấm nút [Chụp Dấu Mực] hoặc bấm phím [Giảm âm lượng] để quét
            </Text>
          </View>
        ) : (
          <>
            {boxes.length < activePallet.target_qty && (
              <TouchableOpacity
                style={[styles.quickStampCloneBanner, { marginHorizontal: 0, marginTop: 0, marginBottom: 8 }]}
                onPress={() => handleOpenCloneModal(boxes[boxes.length - 1])}
                activeOpacity={0.8}
              >
                <Ionicons name="copy" size={15} color="#fbbf24" />
                <Text style={styles.quickStampCloneText}>
                  ⚡ Nhân bản thùng #{boxes[boxes.length - 1].box_index} cho {activePallet.target_qty - boxes.length} thùng còn lại
                </Text>
                <Ionicons name="chevron-forward" size={15} color="#fbbf24" />
              </TouchableOpacity>
            )}
            {boxes.map((b) => (
              <View key={b.id} style={styles.stampBoxCard}>
                <View style={styles.stampBoxHeader}>
                  <View style={styles.stampBoxIndexBadge}>
                    <Text style={styles.stampBoxIndexText}>#{b.box_index}</Text>
                  </View>
                  <Text style={styles.stampBoxCodeText} numberOfLines={1}>
                    {b.stamp_line1 || b.lot_code || '---'}
                  </Text>
                  <View style={styles.stampBoxWeightBadge}>
                    <Text style={styles.stampBoxWeightText}>{b.weight} {b.unit || 'Kg'}</Text>
                  </View>
                  <TouchableOpacity
                    onPress={() => handleOpenCloneModal(b)}
                    style={{ padding: 4 }}
                  >
                    <Ionicons name="copy-outline" size={16} color="#38bdf8" />
                  </TouchableOpacity>
                  <TouchableOpacity
                    onPress={() => handleDeleteBox(b)}
                    style={{ padding: 4 }}
                  >
                    <Ionicons name="trash-outline" size={17} color="#ef4444" />
                  </TouchableOpacity>
                </View>
                {b.product_name ? (
                  <Text style={styles.stampBoxTitle} numberOfLines={1}>{b.product_name}</Text>
                ) : null}
                {b.stamp_line2 ? (
                  <Text style={styles.stampBoxSub} numberOfLines={1}>Dòng 2: {b.stamp_line2}</Text>
                ) : null}
              </View>
            ))}
          </>
        )}
      </ScrollView>

      {/* ── MODAL XÁC NHẬN KẾT QUẢ ĐỌC CON DẤU ────────────── */}
      {pendingStamp && (
        <Modal
          visible={true}
          transparent
          animationType="slide"
          onRequestClose={() => setPendingStamp(null)}
        >
          <View style={styles.modalBackdrop}>
            <View style={styles.confirmStampCard}>
              <View style={styles.confirmHeader}>
                <View style={styles.confirmTitleRow}>
                  <Ionicons name="checkmark-circle" size={22} color="#10b981" />
                  <Text style={styles.confirmTitle}>ĐÃ ĐỌC ĐƯỢC CON DẤU</Text>
                </View>
                <TouchableOpacity onPress={() => setPendingStamp(null)}>
                  <Ionicons name="close" size={22} color="#94a3b8" />
                </TouchableOpacity>
              </View>

              <View style={styles.stampResultBox}>
                <View style={styles.stampResultLine}>
                  <Text style={styles.stampLineLabel}>DÒNG 1 (MÃ SẢN PHẨM):</Text>
                  <TextInput
                    style={styles.stampLineInput}
                    value={pendingStamp.stamp_line1}
                    onChangeText={t => setPendingStamp({ ...pendingStamp, stamp_line1: t })}
                    placeholder="Chưa phát hiện dòng 1"
                    placeholderTextColor="#64748b"
                    keyboardType="number-pad"
                  />
                  <Text style={styles.stampCharCount}>{pendingStamp.stamp_line1.length} ký tự</Text>
                </View>

                <View style={[styles.stampResultLine, { marginTop: 12 }]}>
                  <Text style={styles.stampLineLabel}>DÒNG 2 (DÃY SỐ PHỤ):</Text>
                  <TextInput
                    style={styles.stampLineInput}
                    value={pendingStamp.stamp_line2}
                    onChangeText={t => setPendingStamp({ ...pendingStamp, stamp_line2: t })}
                    placeholder="Chưa phát hiện dòng 2"
                    placeholderTextColor="#64748b"
                    keyboardType="number-pad"
                  />
                  <Text style={styles.stampCharCount}>{pendingStamp.stamp_line2.length} ký tự</Text>
                </View>
              </View>

              {/* Giải mã tiếng Việt tức thì từ bộ từ điển offline */}
              {(() => {
                const dec = decodeStamp(pendingStamp.stamp_line1, pendingStamp.stamp_line2, dictMap, activeFormat);
                return (
                  <View style={{ backgroundColor: '#1e1b4b', padding: 12, borderRadius: 14, borderWidth: 1, borderColor: '#4338ca', marginBottom: 12 }}>
                    <View style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', marginBottom: 4 }}>
                      <Text style={{ color: '#a5b4fc', fontSize: 10, fontWeight: '800', letterSpacing: 0.5 }}>
                        🔍 GIẢI MÃ TỨC THÌ (OFFLINE):
                      </Text>
                      {dec.is_special_12 && (
                        <View style={{ backgroundColor: '#065f46', paddingHorizontal: 6, paddingVertical: 2, borderRadius: 6, borderWidth: 1, borderColor: '#34d399' }}>
                          <Text style={{ color: '#6ee7b7', fontSize: 9, fontWeight: '800' }}>⭐ NGOẠI LỆ 12 SỐ</Text>
                        </View>
                      )}
                    </View>
                    {dec.product_name_full ? (
                      <Text style={{ color: '#f8fafc', fontSize: 13, fontWeight: '700', marginBottom: 3 }}>
                        {dec.product_name_full} {dec.package_spec_name && !dec.is_special_12 ? `• ${dec.package_spec_name}` : ''}
                      </Text>
                    ) : (
                      <Text style={{ color: '#94a3b8', fontSize: 11, fontStyle: 'italic' }}>
                        Dòng 1 chưa đủ 12 ký tự để nhận diện sản phẩm
                      </Text>
                    )}
                    {dec.traceability_full && (
                      <Text style={{ color: '#cbd5e1', fontSize: 11, lineHeight: 16 }}>
                        {dec.traceability_full}
                      </Text>
                    )}
                  </View>
                );
              })()}

              {/* Khối lượng thùng */}
              <View style={styles.weightInputRow}>
                <Text style={styles.weightLabel}>Khối lượng thùng (Kg):</Text>
                <TextInput
                  style={styles.weightInput}
                  value={pendingWeight}
                  onChangeText={setPendingWeight}
                  keyboardType="decimal-pad"
                />
              </View>

              {/* Số lượng thùng (Nhân bản nhanh) */}
              <View style={styles.countInputRow}>
                <View style={{ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' }}>
                  <Text style={styles.weightLabel}>Số lượng thùng tạo:</Text>
                  {parseInt(pendingCount, 10) > 1 && (
                    <Text style={styles.bulkNoticeTag}>Nhân bản {pendingCount} thùng</Text>
                  )}
                </View>
                <TextInput
                  style={[styles.countInput, parseInt(pendingCount, 10) > 1 && styles.countInputBulk]}
                  value={pendingCount}
                  onChangeText={setPendingCount}
                  keyboardType="number-pad"
                  placeholder="1"
                  placeholderTextColor="#64748b"
                />
                {activePallet && (
                  <View style={styles.quickChipsRow}>
                    <TouchableOpacity
                      style={[styles.quickChip, pendingCount === '1' && styles.quickChipActive]}
                      onPress={() => setPendingCount('1')}
                    >
                      <Text style={[styles.quickChipText, pendingCount === '1' && styles.quickChipActiveText]}>1 thùng</Text>
                    </TouchableOpacity>
                    {activePallet.target_qty - boxes.length > 0 && (
                      <TouchableOpacity
                        style={[styles.quickChip, pendingCount === String(activePallet.target_qty - boxes.length) && styles.quickChipActive]}
                        onPress={() => setPendingCount(String(Math.max(1, activePallet.target_qty - boxes.length)))}
                      >
                        <Text style={[styles.quickChipText, pendingCount === String(activePallet.target_qty - boxes.length) && styles.quickChipActiveText]}>
                          Điền đủ ({activePallet.target_qty - boxes.length})
                        </Text>
                      </TouchableOpacity>
                    )}
                    <TouchableOpacity
                      style={[styles.quickChip, pendingCount === '5' && styles.quickChipActive]}
                      onPress={() => setPendingCount('5')}
                    >
                      <Text style={[styles.quickChipText, pendingCount === '5' && styles.quickChipActiveText]}>+5</Text>
                    </TouchableOpacity>
                    <TouchableOpacity
                      style={[styles.quickChip, pendingCount === '10' && styles.quickChipActive]}
                      onPress={() => setPendingCount('10')}
                    >
                      <Text style={[styles.quickChipText, pendingCount === '10' && styles.quickChipActiveText]}>+10</Text>
                    </TouchableOpacity>
                    <TouchableOpacity
                      style={[styles.quickChip, pendingCount === '20' && styles.quickChipActive]}
                      onPress={() => setPendingCount('20')}
                    >
                      <Text style={[styles.quickChipText, pendingCount === '20' && styles.quickChipActiveText]}>+20</Text>
                    </TouchableOpacity>
                  </View>
                )}
              </View>

              {/* Action Buttons */}
              <View style={styles.confirmActionRow}>
                <TouchableOpacity
                  style={styles.btnRescan}
                  onPress={() => setPendingStamp(null)}
                >
                  <Ionicons name="refresh" size={16} color="#94a3b8" />
                  <Text style={styles.btnRescanText}>Quét Lại</Text>
                </TouchableOpacity>

                <TouchableOpacity
                  style={[styles.btnConfirmSave, isSaving && { opacity: 0.6 }]}
                  onPress={handleConfirmSaveStampBox}
                  disabled={isSaving}
                >
                  {isSaving ? (
                    <ActivityIndicator size="small" color="#fff" />
                  ) : (
                    <>
                      <Ionicons name={parseInt(pendingCount, 10) > 1 ? "copy" : "save"} size={16} color="#fff" />
                      <Text style={styles.btnConfirmSaveText}>
                        {parseInt(pendingCount, 10) > 1 ? `Nhân Bản (${pendingCount} Thùng)` : 'Lưu Vào Pallet'}
                      </Text>
                    </>
                  )}
                </TouchableOpacity>
              </View>
            </View>
          </View>
        </Modal>
      )}

      {/* ── MODAL NHẬP THỦ CÔNG ───────────────────────────── */}
      <Modal
        visible={isManualModal}
        transparent
        animationType="fade"
        onRequestClose={() => setIsManualModal(false)}
      >
        <View style={styles.modalBackdrop}>
          <View style={styles.modalCard}>
            <View style={styles.modalHeader}>
              <Text style={styles.modalTitle}>Nhập Dãy Số Con Dấu Thủ Công</Text>
              <TouchableOpacity onPress={() => setIsManualModal(false)}>
                <Ionicons name="close" size={20} color="#94a3b8" />
              </TouchableOpacity>
            </View>

            <Text style={styles.inputLabel}>Dòng 1 (Ví dụ: 10102010204001):</Text>
            <TextInput
              style={styles.textInput}
              value={manualLine1}
              onChangeText={setManualLine1}
              placeholder="Nhập dòng 1"
              placeholderTextColor="#64748b"
              keyboardType="number-pad"
            />

            <Text style={styles.inputLabel}>Dòng 2 (Ví dụ: 1110926001471609):</Text>
            <TextInput
              style={styles.textInput}
              value={manualLine2}
              onChangeText={setManualLine2}
              placeholder="Nhập dòng 2"
              placeholderTextColor="#64748b"
              keyboardType="number-pad"
            />

            {/* Live preview giải mã trong modal thủ công */}
            {(() => {
              const dec = decodeStamp(manualLine1, manualLine2, dictMap, activeFormat);
              if (!dec.product_name_full && !dec.traceability_full) return null;
              return (
                <View style={{ backgroundColor: '#1e1b4b', padding: 10, borderRadius: 12, borderWidth: 1, borderColor: '#4338ca', marginVertical: 8 }}>
                  <View style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', marginBottom: 3 }}>
                    <Text style={{ color: '#a5b4fc', fontSize: 9, fontWeight: '800' }}>XEM TRƯỚC GIẢI MÃ:</Text>
                    {dec.is_special_12 && (
                      <View style={{ backgroundColor: '#065f46', paddingHorizontal: 5, paddingVertical: 1, borderRadius: 4, borderWidth: 1, borderColor: '#34d399' }}>
                        <Text style={{ color: '#6ee7b7', fontSize: 8, fontWeight: '800' }}>⭐ NGOẠI LỆ 12 SỐ</Text>
                      </View>
                    )}
                  </View>
                  {dec.product_name_full && (
                    <Text style={{ color: '#f8fafc', fontSize: 12, fontWeight: '700', marginBottom: 2 }}>
                      {dec.product_name_full}
                    </Text>
                  )}
                  {dec.traceability_full && (
                    <Text style={{ color: '#cbd5e1', fontSize: 10 }}>
                      {dec.traceability_full}
                    </Text>
                  )}
                </View>
              );
            })()}

            <Text style={styles.inputLabel}>Khối lượng (Kg):</Text>
            <TextInput
              style={styles.textInput}
              value={manualWeight}
              onChangeText={setManualWeight}
              placeholder="20"
              placeholderTextColor="#64748b"
              keyboardType="decimal-pad"
            />

            <Text style={styles.inputLabel}>Số lượng thùng tạo (Nhân bản):</Text>
            <TextInput
              style={[styles.textInput, parseInt(manualCount, 10) > 1 && { borderColor: '#fbbf24', color: '#fbbf24' }]}
              value={manualCount}
              onChangeText={setManualCount}
              placeholder="1"
              placeholderTextColor="#64748b"
              keyboardType="number-pad"
            />

            {activePallet && (
              <View style={[styles.quickChipsRow, { marginTop: 8 }]}>
                {activePallet.target_qty - boxes.length > 0 && (
                  <TouchableOpacity
                    style={[styles.quickChip, styles.quickChipActive]}
                    onPress={() => setManualCount(String(Math.max(1, activePallet.target_qty - boxes.length)))}
                  >
                    <Text style={styles.quickChipActiveText}>
                      Điền đủ ({activePallet.target_qty - boxes.length})
                    </Text>
                  </TouchableOpacity>
                )}
                <TouchableOpacity style={styles.quickChip} onPress={() => setManualCount('5')}>
                  <Text style={styles.quickChipText}>+5</Text>
                </TouchableOpacity>
                <TouchableOpacity style={styles.quickChip} onPress={() => setManualCount('10')}>
                  <Text style={styles.quickChipText}>+10</Text>
                </TouchableOpacity>
              </View>
            )}

            <View style={styles.modalActions}>
              <TouchableOpacity
                style={styles.modalCancelBtn}
                onPress={() => setIsManualModal(false)}
              >
                <Text style={styles.modalCancelText}>Hủy</Text>
              </TouchableOpacity>

              <TouchableOpacity
                style={styles.modalSaveBtn}
                onPress={handleSaveManual}
              >
                <Text style={styles.modalSaveText}>Lưu Thùng</Text>
              </TouchableOpacity>
            </View>
          </View>
        </View>
      </Modal>

      {/* ── MODAL CHỌN / ĐỔI PALLET ──────────────────────── */}
      <Modal
        visible={isNewPalletModal}
        transparent
        animationType="fade"
        onRequestClose={() => setIsNewPalletModal(false)}
      >
        <View style={styles.modalBackdrop}>
          <View style={styles.modalCard}>
            <View style={styles.modalHeader}>
              <Text style={styles.modalTitle}>Chọn / Tạo Pallet Quét Dấu</Text>
              <TouchableOpacity onPress={() => setIsNewPalletModal(false)}>
                <Ionicons name="close" size={20} color="#94a3b8" />
              </TouchableOpacity>
            </View>

            <Text style={styles.inputLabel}>Số Thứ Tự (STT) Pallet (Ví dụ: C544, F3219, G588...):</Text>
            <TextInput
              style={styles.textInput}
              value={newPalletCode}
              onChangeText={setNewPalletCode}
              placeholder="Nhập STT Pallet"
              placeholderTextColor="#64748b"
              autoCapitalize="characters"
            />

            <Text style={styles.inputLabel}>Mục tiêu số thùng (Mặc định: 30):</Text>
            <TextInput
              style={styles.textInput}
              value={newTargetQty}
              onChangeText={setNewTargetQty}
              placeholder="30"
              placeholderTextColor="#64748b"
              keyboardType="number-pad"
            />

            <Text style={styles.inputLabel}>Mã phụ (Tag):</Text>
            <TextInput
              style={styles.textInput}
              value={newPalletTag}
              onChangeText={setNewPalletTag}
              placeholder="Ví dụ: OEM-A, XK-HQ, HÀNG LOẠI 1..."
              placeholderTextColor="#64748b"
              autoCapitalize="characters"
            />

            <Text style={styles.inputLabel}>Ghi chú Pallet / LOT hàng:</Text>
            <TextInput
              style={[styles.textInput, { minHeight: 44 }]}
              value={newPalletNotes}
              onChangeText={setNewPalletNotes}
              placeholder="Nhập ghi chú cho LOT hàng (nếu có)..."
              placeholderTextColor="#64748b"
            />

            <View style={styles.modalActions}>
              <TouchableOpacity
                style={styles.modalCancelBtn}
                onPress={() => setIsNewPalletModal(false)}
              >
                <Text style={styles.modalCancelText}>Đóng</Text>
              </TouchableOpacity>

              <TouchableOpacity
                style={styles.modalSaveBtn}
                onPress={handleCreateNewPallet}
              >
                <Text style={styles.modalSaveText}>Xác Nhận Pallet</Text>
              </TouchableOpacity>
            </View>
          </View>
        </View>
      </Modal>
      {/* ── MODAL NHÂN BẢN THÙNG MẪU ────────────────────── */}
      <Modal
        visible={cloneModalVisible}
        transparent
        animationType="slide"
        onRequestClose={() => setCloneModalVisible(false)}
      >
        <View style={styles.modalBackdrop}>
          <View style={styles.modalCard}>
            <View style={styles.modalHeader}>
              <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6 }}>
                <Ionicons name="copy" size={20} color="#fbbf24" />
                <Text style={styles.modalTitle}>Nhân Bản Thùng Dấu Mực</Text>
              </View>
              <TouchableOpacity onPress={() => setCloneModalVisible(false)}>
                <Ionicons name="close" size={20} color="#94a3b8" />
              </TouchableOpacity>
            </View>

            {cloneSampleBox && (
              <View style={styles.sampleBoxCard}>
                <Text style={styles.sampleBoxTitle}>
                  Thùng mẫu: #{cloneSampleBox.box_index} · {cloneSampleBox.sku}
                </Text>
                <Text style={styles.sampleBoxSub}>
                  {cloneSampleBox.product_name}
                </Text>
                <Text style={styles.sampleBoxMeta}>
                  Dòng 1: {cloneSampleBox.stamp_line1 || 'N/A'} | Dòng 2: {cloneSampleBox.stamp_line2 || 'N/A'}
                </Text>
              </View>
            )}

            <Text style={styles.inputLabel}>Số lượng thùng cần nhân bản thêm:</Text>
            <TextInput
              style={[styles.textInput, { fontSize: 18, fontWeight: '700', color: '#fbbf24' }]}
              value={cloneCount}
              onChangeText={setCloneCount}
              keyboardType="number-pad"
              placeholder="1"
              placeholderTextColor="#64748b"
            />

            {activePallet && (
              <View style={[styles.quickChipsRow, { marginTop: 10 }]}>
                {activePallet.target_qty - boxes.length > 0 && (
                  <TouchableOpacity
                    style={[styles.quickChip, styles.quickChipActive]}
                    onPress={() => setCloneCount(String(Math.max(1, activePallet.target_qty - boxes.length)))}
                  >
                    <Text style={styles.quickChipActiveText}>
                      Điền đủ ({activePallet.target_qty - boxes.length} thùng)
                    </Text>
                  </TouchableOpacity>
                )}
                <TouchableOpacity style={styles.quickChip} onPress={() => setCloneCount('5')}>
                  <Text style={styles.quickChipText}>+5</Text>
                </TouchableOpacity>
                <TouchableOpacity style={styles.quickChip} onPress={() => setCloneCount('10')}>
                  <Text style={styles.quickChipText}>+10</Text>
                </TouchableOpacity>
                <TouchableOpacity style={styles.quickChip} onPress={() => setCloneCount('20')}>
                  <Text style={styles.quickChipText}>+20</Text>
                </TouchableOpacity>
              </View>
            )}

            <View style={styles.modalActions}>
              <TouchableOpacity
                style={styles.modalCancelBtn}
                onPress={() => setCloneModalVisible(false)}
                disabled={isCloning}
              >
                <Text style={styles.modalCancelText}>Hủy</Text>
              </TouchableOpacity>

              <TouchableOpacity
                style={[styles.modalSaveBtn, isCloning && { opacity: 0.6 }]}
                onPress={handleConfirmClone}
                disabled={isCloning}
              >
                {isCloning ? (
                  <ActivityIndicator size="small" color="#0f172a" />
                ) : (
                  <Text style={styles.modalSaveText}>Xác Nhận Nhân Bản</Text>
                )}
              </TouchableOpacity>
            </View>
          </View>
        </View>
      </Modal>
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: '#0f172a',
  },
  centerContainer: {
    flex: 1,
    backgroundColor: '#0f172a',
    justifyContent: 'center',
    alignItems: 'center',
    padding: 24,
  },
  permissionTitle: {
    fontSize: 18,
    fontWeight: '700',
    color: '#f8fafc',
    marginTop: 16,
    marginBottom: 8,
  },
  permissionText: {
    fontSize: 14,
    color: '#94a3b8',
    textAlign: 'center',
    marginBottom: 20,
  },
  primaryBtn: {
    backgroundColor: '#38bdf8',
    paddingHorizontal: 20,
    paddingVertical: 12,
    borderRadius: 12,
  },
  primaryBtnText: {
    color: '#0f172a',
    fontWeight: '700',
    fontSize: 14,
  },

  // Top Bar
  topBar: {
    backgroundColor: 'rgba(15, 23, 42, 0.95)',
    paddingHorizontal: 16,
    paddingVertical: 10,
    borderBottomWidth: 1,
    borderBottomColor: '#1e293b',
  },
  palletInfoRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
  },
  palletBadge: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: '#1e293b',
    paddingHorizontal: 12,
    paddingVertical: 6,
    borderRadius: 10,
    borderWidth: 1,
    borderColor: '#334155',
  },
  palletBadgeLabel: {
    fontSize: 10,
    fontWeight: '800',
    color: '#fbbf24',
    marginLeft: 4,
    marginRight: 6,
  },
  palletCodeText: {
    fontSize: 13,
    fontWeight: '700',
    color: '#f8fafc',
  },
  topActionBtns: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
  },
  iconButton: {
    width: 36,
    height: 36,
    borderRadius: 10,
    backgroundColor: '#1e293b',
    justifyContent: 'center',
    alignItems: 'center',
    borderWidth: 1,
    borderColor: '#334155',
  },
  iconButtonActive: {
    backgroundColor: '#854d0e',
    borderColor: '#fbbf24',
  },

  // Progress Bar
  progressContainer: {
    marginTop: 8,
  },
  progressHeader: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    marginBottom: 4,
  },
  resetButton: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: 'rgba(239, 68, 68, 0.15)',
    borderWidth: 1,
    borderColor: '#ef4444',
    paddingHorizontal: 6,
    paddingVertical: 1,
    borderRadius: 6,
    marginLeft: 8,
    gap: 3,
  },
  resetButtonText: {
    color: '#ef4444',
    fontSize: 11,
    fontWeight: '700',
  },
  progressText: {
    fontSize: 12,
    color: '#94a3b8',
  },
  progressHighlight: {
    color: '#fbbf24',
    fontWeight: '700',
  },
  weightText: {
    fontSize: 12,
    color: '#94a3b8',
  },
  progressBarBg: {
    height: 6,
    backgroundColor: '#1e293b',
    borderRadius: 3,
    overflow: 'hidden',
  },
  progressBarFill: {
    height: '100%',
    backgroundColor: '#fbbf24',
  },
  progressBarFull: {
    backgroundColor: '#10b981',
  },

  // Camera Wrapper & Reticle
  cameraWrapper: {
    flex: 1,
    position: 'relative',
    overflow: 'hidden',
  },
  reticleContainer: {
    position: 'absolute',
    top: 0,
    left: 0,
    right: 0,
    bottom: 0,
    justifyContent: 'center',
    alignItems: 'center',
  },
  reticleHeaderBox: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    backgroundColor: 'rgba(15, 23, 42, 0.85)',
    paddingHorizontal: 14,
    paddingVertical: 6,
    borderRadius: 20,
    marginBottom: 16,
    borderWidth: 1,
    borderColor: 'rgba(251, 191, 36, 0.4)',
  },
  reticleGuideText: {
    color: '#f8fafc',
    fontSize: 12,
    fontWeight: '700',
  },
  stampTargetFrame: {
    width: '90%',
    height: 140,
    borderRadius: 16,
    borderWidth: 1.5,
    borderColor: 'rgba(251, 191, 36, 0.6)',
    backgroundColor: 'rgba(251, 191, 36, 0.04)',
    justifyContent: 'center',
    paddingHorizontal: 16,
    position: 'relative',
  },
  stampTargetFrameScanning: {
    borderColor: '#10b981',
    backgroundColor: 'rgba(16, 185, 129, 0.1)',
  },
  corner: {
    position: 'absolute',
    width: 20,
    height: 20,
    borderColor: '#fbbf24',
  },
  tl: { top: -2, left: -2, borderTopWidth: 4, borderLeftWidth: 4, borderTopLeftRadius: 12 },
  tr: { top: -2, right: -2, borderTopWidth: 4, borderRightWidth: 4, borderTopRightRadius: 12 },
  bl: { bottom: -2, left: -2, borderBottomWidth: 4, borderLeftWidth: 4, borderBottomLeftRadius: 12 },
  br: { bottom: -2, right: -2, borderBottomWidth: 4, borderRightWidth: 4, borderBottomRightRadius: 12 },

  lineGuideRow: {
    flexDirection: 'row',
    alignItems: 'center',
  },
  lineGuideTag: {
    fontSize: 10,
    fontWeight: '800',
    color: '#fbbf24',
    backgroundColor: 'rgba(15, 23, 42, 0.8)',
    paddingHorizontal: 6,
    paddingVertical: 2,
    borderRadius: 4,
    marginRight: 8,
  },
  lineGuideDash: {
    flex: 1,
    height: 1,
    backgroundColor: 'rgba(251, 191, 36, 0.3)',
    marginRight: 8,
  },
  lineGuideExample: {
    fontSize: 11,
    fontFamily: Platform.OS === 'ios' ? 'Menlo' : 'monospace',
    color: '#e2e8f0',
    fontWeight: '600',
  },
  reticleHintSub: {
    color: '#cbd5e1',
    fontSize: 11,
    marginTop: 14,
    backgroundColor: 'rgba(15, 23, 42, 0.75)',
    paddingHorizontal: 12,
    paddingVertical: 4,
    borderRadius: 12,
  },

  // Banner
  bannerContainer: {
    position: 'absolute',
    top: 20,
    left: 20,
    right: 20,
    backgroundColor: '#059669',
    paddingVertical: 10,
    paddingHorizontal: 16,
    borderRadius: 12,
    alignItems: 'center',
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 4 },
    shadowOpacity: 0.3,
    shadowRadius: 6,
    elevation: 6,
  },
  bannerText: {
    color: '#fff',
    fontWeight: '700',
    fontSize: 13,
  },

  // Scanning Overlay
  scanningOverlay: {
    position: 'absolute',
    top: 0,
    left: 0,
    right: 0,
    bottom: 0,
    backgroundColor: 'rgba(15, 23, 42, 0.7)',
    justifyContent: 'center',
    alignItems: 'center',
  },
  scanningText: {
    color: '#fbbf24',
    fontSize: 14,
    fontWeight: '700',
    marginTop: 12,
  },

  // Bottom Controls
  bottomControls: {
    backgroundColor: 'rgba(15, 23, 42, 0.95)',
    paddingVertical: 16,
    paddingHorizontal: 24,
    borderTopWidth: 1,
    borderTopColor: '#1e293b',
  },
  triggerRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-around',
  },
  btnManualInput: {
    alignItems: 'center',
    justifyContent: 'center',
    width: 70,
  },
  btnHistory: {
    alignItems: 'center',
    justifyContent: 'center',
    width: 70,
  },
  btnManualText: {
    fontSize: 11,
    fontWeight: '600',
    color: '#94a3b8',
    marginTop: 4,
  },
  shutterBtn: {
    width: 72,
    height: 72,
    borderRadius: 36,
    backgroundColor: 'rgba(251, 191, 36, 0.3)',
    justifyContent: 'center',
    alignItems: 'center',
    borderWidth: 2,
    borderColor: '#fbbf24',
  },
  shutterBtnDisabled: {
    opacity: 0.5,
  },
  shutterInner: {
    width: 58,
    height: 58,
    borderRadius: 29,
    backgroundColor: '#fbbf24',
    justifyContent: 'center',
    alignItems: 'center',
  },

  // Modals
  modalBackdrop: {
    flex: 1,
    backgroundColor: 'rgba(0, 0, 0, 0.75)',
    justifyContent: 'center',
    alignItems: 'center',
    padding: 20,
  },
  confirmStampCard: {
    width: '100%',
    backgroundColor: '#1e293b',
    borderRadius: 20,
    padding: 20,
    borderWidth: 1,
    borderColor: '#334155',
  },
  confirmHeader: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    paddingBottom: 12,
    borderBottomWidth: 1,
    borderBottomColor: '#334155',
  },
  confirmTitleRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
  },
  confirmTitle: {
    color: '#10b981',
    fontWeight: '800',
    fontSize: 14,
    letterSpacing: 0.5,
  },
  stampResultBox: {
    marginVertical: 14,
    backgroundColor: '#0f172a',
    padding: 14,
    borderRadius: 14,
    borderWidth: 1,
    borderColor: '#334155',
  },
  stampResultLine: {},
  stampLineLabel: {
    color: '#94a3b8',
    fontSize: 10,
    fontWeight: '800',
    marginBottom: 4,
  },
  stampLineInput: {
    backgroundColor: '#1e293b',
    color: '#fbbf24',
    fontFamily: Platform.OS === 'ios' ? 'Menlo' : 'monospace',
    fontSize: 16,
    fontWeight: '800',
    paddingHorizontal: 12,
    paddingVertical: 8,
    borderRadius: 8,
    borderWidth: 1,
    borderColor: '#475569',
  },
  stampCharCount: {
    color: '#64748b',
    fontSize: 10,
    textAlign: 'right',
    marginTop: 2,
  },
  weightInputRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    marginBottom: 16,
    backgroundColor: '#0f172a',
    paddingHorizontal: 14,
    paddingVertical: 10,
    borderRadius: 12,
  },
  weightLabel: {
    color: '#e2e8f0',
    fontSize: 13,
    fontWeight: '600',
  },
  weightInput: {
    backgroundColor: '#1e293b',
    color: '#f8fafc',
    fontSize: 15,
    fontWeight: '700',
    paddingHorizontal: 14,
    paddingVertical: 6,
    borderRadius: 8,
    width: 80,
    textAlign: 'center',
    borderWidth: 1,
    borderColor: '#475569',
  },
  confirmActionRow: {
    flexDirection: 'row',
    gap: 12,
  },
  btnRescan: {
    flex: 1,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 6,
    paddingVertical: 12,
    borderRadius: 12,
    backgroundColor: '#334155',
  },
  btnRescanText: {
    color: '#e2e8f0',
    fontWeight: '700',
    fontSize: 13,
  },
  btnConfirmSave: {
    flex: 1.5,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 6,
    paddingVertical: 12,
    borderRadius: 12,
    backgroundColor: '#10b981',
  },
  btnConfirmSaveText: {
    color: '#fff',
    fontWeight: '800',
    fontSize: 13,
  },

  modalCard: {
    width: '100%',
    backgroundColor: '#1e293b',
    borderRadius: 20,
    padding: 20,
    borderWidth: 1,
    borderColor: '#334155',
  },
  modalHeader: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    marginBottom: 16,
  },
  modalTitle: {
    color: '#f8fafc',
    fontWeight: '800',
    fontSize: 16,
  },
  inputLabel: {
    color: '#94a3b8',
    fontSize: 11,
    fontWeight: '600',
    marginBottom: 4,
    marginTop: 8,
  },
  textInput: {
    backgroundColor: '#0f172a',
    color: '#f8fafc',
    fontSize: 14,
    fontWeight: '600',
    paddingHorizontal: 12,
    paddingVertical: 10,
    borderRadius: 10,
    borderWidth: 1,
    borderColor: '#334155',
  },
  modalActions: {
    flexDirection: 'row',
    justifyContent: 'flex-end',
    gap: 12,
    marginTop: 20,
  },
  modalCancelBtn: {
    paddingHorizontal: 16,
    paddingVertical: 10,
    borderRadius: 10,
    backgroundColor: '#334155',
  },
  modalCancelText: {
    color: '#94a3b8',
    fontWeight: '600',
    fontSize: 13,
  },
  modalSaveBtn: {
    paddingHorizontal: 20,
    paddingVertical: 10,
    borderRadius: 10,
    backgroundColor: '#fbbf24',
  },
  modalSaveText: {
    color: '#0f172a',
    fontWeight: '800',
    fontSize: 13,
  },

  // Clone & Bulk styles
  quickStampCloneBanner: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: 'rgba(251, 191, 36, 0.15)',
    borderWidth: 1,
    borderColor: 'rgba(251, 191, 36, 0.5)',
    borderRadius: 10,
    marginHorizontal: 16,
    marginBottom: 8,
    paddingHorizontal: 12,
    paddingVertical: 8,
    gap: 8,
  },
  quickStampCloneText: {
    flex: 1,
    color: '#fbbf24',
    fontSize: 12,
    fontWeight: '700',
  },
  countInputRow: {
    marginBottom: 14,
  },
  countInput: {
    backgroundColor: '#0f172a',
    color: '#f8fafc',
    fontSize: 16,
    fontWeight: '700',
    paddingHorizontal: 12,
    paddingVertical: 8,
    borderRadius: 10,
    borderWidth: 1,
    borderColor: '#334155',
  },
  countInputBulk: {
    borderColor: '#fbbf24',
    color: '#fbbf24',
  },
  bulkNoticeTag: {
    fontSize: 11,
    color: '#fbbf24',
    fontWeight: '700',
  },
  quickChipsRow: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 6,
    marginTop: 8,
  },
  quickChip: {
    backgroundColor: '#1e293b',
    borderWidth: 1,
    borderColor: '#334155',
    paddingHorizontal: 10,
    paddingVertical: 5,
    borderRadius: 8,
  },
  quickChipActive: {
    backgroundColor: '#854d0e',
    borderColor: '#fbbf24',
  },
  quickChipText: {
    color: '#94a3b8',
    fontSize: 11,
    fontWeight: '700',
  },
  quickChipActiveText: {
    color: '#fbbf24',
    fontWeight: '800',
  },
  sampleBoxCard: {
    backgroundColor: '#0f172a',
    borderRadius: 10,
    padding: 10,
    marginBottom: 12,
    borderLeftWidth: 3,
    borderLeftColor: '#fbbf24',
  },
  sampleBoxTitle: {
    color: '#f8fafc',
    fontSize: 13,
    fontWeight: '700',
  },
  sampleBoxSub: {
    color: '#94a3b8',
    fontSize: 11,
    marginTop: 2,
  },
  sampleBoxMeta: {
    color: '#cbd5e1',
    fontSize: 10,
    marginTop: 4,
  },
  cameraTogglePill: {
    position: 'absolute',
    top: 12,
    right: 12,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 5,
    backgroundColor: 'rgba(15, 23, 42, 0.85)',
    borderWidth: 1,
    borderColor: 'rgba(248, 113, 113, 0.45)',
    paddingHorizontal: 10,
    paddingVertical: 6,
    borderRadius: 999,
  },
  cameraTogglePillText: {
    color: '#fecaca',
    fontSize: 11,
    fontWeight: '700',
  },
  cameraPausedContainer: {
    flex: 1,
    backgroundColor: '#0b1220',
    justifyContent: 'center',
    alignItems: 'center',
    paddingHorizontal: 28,
  },
  cameraPausedIconCircle: {
    width: 72,
    height: 72,
    borderRadius: 36,
    backgroundColor: '#1e293b',
    borderWidth: 1,
    borderColor: '#334155',
    justifyContent: 'center',
    alignItems: 'center',
    marginBottom: 14,
  },
  cameraPausedTitle: {
    color: '#f8fafc',
    fontSize: 16,
    fontWeight: '800',
    marginBottom: 6,
  },
  cameraPausedSub: {
    color: '#94a3b8',
    fontSize: 12,
    textAlign: 'center',
    lineHeight: 18,
    marginBottom: 18,
  },
  cameraEnableBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    backgroundColor: '#fbbf24',
    paddingHorizontal: 20,
    paddingVertical: 11,
    borderRadius: 12,
  },
  cameraEnableBtnText: {
    color: '#0f172a',
    fontSize: 14,
    fontWeight: '800',
  },
  noPalletTipBar: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    backgroundColor: 'rgba(56, 189, 248, 0.1)',
    marginTop: 8,
    paddingHorizontal: 12,
    paddingVertical: 6,
    borderRadius: 8,
    borderWidth: 1,
    borderColor: 'rgba(56, 189, 248, 0.25)',
  },
  noPalletTipText: {
    color: '#38bdf8',
    fontSize: 12,
    flex: 1,
  },
  volumeBar: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    paddingHorizontal: 16,
    marginTop: 8,
    marginBottom: 6,
    gap: 8,
  },
  volumeKeyHintBadge: {
    flex: 1,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: 'rgba(56, 189, 248, 0.12)',
    paddingHorizontal: 10,
    paddingVertical: 6,
    borderRadius: 8,
    borderWidth: 1,
    borderColor: 'rgba(56, 189, 248, 0.3)',
    gap: 6,
  },
  volumeKeyHintText: {
    color: '#38bdf8',
    fontSize: 11,
    fontWeight: '700',
  },
  torchBtn: {
    padding: 7,
    borderRadius: 8,
    backgroundColor: '#1e293b',
    borderWidth: 1,
    borderColor: '#334155',
  },
  compactCameraBox: {
    height: 220,
    marginHorizontal: 16,
    borderRadius: 14,
    overflow: 'hidden',
    backgroundColor: '#000',
    position: 'relative',
    borderWidth: 1.5,
    borderColor: '#334155',
  },
  noPalletOverlay: {
    ...StyleSheet.absoluteFill,
    backgroundColor: 'rgba(9, 13, 22, 0.92)',
    justifyContent: 'center',
    alignItems: 'center',
    padding: 20,
  },
  noPalletOverlayTitle: {
    color: '#ffffff',
    fontSize: 16,
    fontWeight: '800',
    marginTop: 8,
  },
  noPalletOverlaySub: {
    color: '#94a3b8',
    fontSize: 12,
    textAlign: 'center',
    marginTop: 4,
    marginBottom: 14,
    paddingHorizontal: 10,
  },
  selectPalletOverlayBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    backgroundColor: '#10b981',
    paddingHorizontal: 18,
    paddingVertical: 9,
    borderRadius: 8,
  },
  selectPalletOverlayBtnText: {
    color: '#ffffff',
    fontWeight: '700',
    fontSize: 13,
  },
  compactReticleContainer: {
    ...StyleSheet.absoluteFill,
    justifyContent: 'center',
    alignItems: 'center',
    paddingHorizontal: 14,
  },
  compactStampFrame: {
    width: '92%',
    height: 110,
    backgroundColor: 'rgba(15, 23, 42, 0.35)',
    borderRadius: 10,
    justifyContent: 'center',
    paddingHorizontal: 14,
    position: 'relative',
  },
  compactHintText: {
    marginTop: 8,
    color: '#e2e8f0',
    fontSize: 11,
    fontWeight: '600',
    backgroundColor: 'rgba(15, 23, 42, 0.72)',
    paddingHorizontal: 10,
    paddingVertical: 4,
    borderRadius: 8,
  },
  actionRow: {
    flexDirection: 'row',
    gap: 8,
    paddingHorizontal: 16,
    marginTop: 10,
    marginBottom: 10,
  },
  captureActionBtn: {
    flex: 1.3,
    backgroundColor: '#059669',
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 6,
    paddingVertical: 11,
    borderRadius: 10,
  },
  captureActionText: {
    color: '#ffffff',
    fontWeight: '700',
    fontSize: 14,
  },
  manualActionBtn: {
    flex: 1,
    backgroundColor: '#0f2942',
    borderWidth: 1,
    borderColor: '#0284c7',
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 5,
    paddingVertical: 11,
    borderRadius: 10,
  },
  manualActionText: {
    color: '#38bdf8',
    fontWeight: '700',
    fontSize: 13,
  },
  completeActionBtn: {
    backgroundColor: '#7c3aed',
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
    paddingHorizontal: 14,
    borderRadius: 10,
  },
  completeActionText: {
    color: '#fff',
    fontWeight: '700',
    fontSize: 13,
  },
  listHeaderRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    paddingHorizontal: 16,
    marginBottom: 6,
  },
  listHeaderTitle: {
    color: '#94a3b8',
    fontSize: 12,
    fontWeight: '700',
    textTransform: 'uppercase',
  },
  seeAllText: {
    color: '#38bdf8',
    fontSize: 12,
    fontWeight: '600',
  },
  boxList: {
    flex: 1,
    paddingHorizontal: 16,
  },
  emptyBox: {
    alignItems: 'center',
    paddingVertical: 22,
  },
  emptyText: {
    color: '#e2e8f0',
    fontSize: 14,
    fontWeight: '700',
    marginTop: 8,
  },
  emptySubText: {
    color: '#64748b',
    fontSize: 12,
    marginTop: 4,
    textAlign: 'center',
  },
  stampBoxCard: {
    backgroundColor: '#131b2e',
    borderRadius: 10,
    padding: 10,
    marginBottom: 8,
    borderWidth: 1,
    borderColor: '#1e293b',
  },
  stampBoxHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
  },
  stampBoxIndexBadge: {
    backgroundColor: '#854d0e',
    paddingHorizontal: 7,
    paddingVertical: 2,
    borderRadius: 6,
  },
  stampBoxIndexText: {
    color: '#fbbf24',
    fontSize: 11,
    fontWeight: '800',
  },
  stampBoxCodeText: {
    flex: 1,
    color: '#e2e8f0',
    fontSize: 12,
    fontWeight: '700',
  },
  stampBoxWeightBadge: {
    backgroundColor: '#064e3b',
    paddingHorizontal: 7,
    paddingVertical: 2,
    borderRadius: 6,
  },
  stampBoxWeightText: {
    color: '#34d399',
    fontSize: 11,
    fontWeight: '700',
  },
  stampBoxTitle: {
    color: '#f8fafc',
    fontSize: 13,
    fontWeight: '600',
    marginTop: 5,
  },
  stampBoxSub: {
    color: '#94a3b8',
    fontSize: 11,
    marginTop: 2,
  },
});
