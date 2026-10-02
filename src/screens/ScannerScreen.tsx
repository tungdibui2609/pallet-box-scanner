import React, { useState, useEffect, useRef } from 'react';
import {
  View, Text, StyleSheet, TouchableOpacity, ScrollView,
  Alert, Modal, TextInput, ActivityIndicator, Vibration, Animated
} from 'react-native';
import { CameraView, useCameraPermissions } from 'expo-camera';
import TextRecognition from '@react-native-ml-kit/text-recognition';
import AsyncStorage from '@react-native-async-storage/async-storage';
import * as Haptics from 'expo-haptics';
import { Ionicons } from '@expo/vector-icons';
import { Pallet, BoxLabel, ParsedLabelData } from '../types';
import {
  getActivePallet, createNewPallet, completePallet,
  getBoxesByPallet, addBoxToPallet, deleteBox,
  getPalletByCode, resetPalletBoxes, activateExistingPallet
} from '../services/database';
import { parseBoxLabelText, isBoxLabel } from '../services/labelParser';
import { DEFAULT_SUPABASE_URL } from '../services/supabase';

export default function ScannerScreen({ onNavigateToPallets }: { onNavigateToPallets: () => void }) {
  const [permission, requestPermission] = useCameraPermissions();
  const cameraRef = useRef<any>(null);

  const [activePallet, setActivePallet] = useState<Pallet | null>(null);
  const [boxes, setBoxes] = useState<BoxLabel[]>([]);
  const [isScanning, setIsScanning] = useState(false);
  const [torch, setTorch] = useState(false);

  // AUTO-SCAN STATE
  const [isAutoScan, setIsAutoScan] = useState(true);
  const isProcessingFrame = useRef(false);
  const lastScannedBoxRef = useRef<string | null>(null);
  const lastScannedTimeRef = useRef<number>(0);
  const pauseUntilRef = useRef<number>(0);

  // Success Feedback Banner
  const [successBanner, setSuccessBanner] = useState<string | null>(null);
  const bannerAnim = useRef(new Animated.Value(0)).current;

  // Pallet Creation Modal (NEVER forced automatically on app start)
  const [isNewPalletModal, setIsNewPalletModal] = useState(false);
  const [newPalletCode, setNewPalletCode] = useState('');
  const [newTargetQty, setNewTargetQty] = useState('30');

  // Manual Input Modal
  const [isManualModal, setIsManualModal] = useState(false);
  const [manualIndex, setManualIndex] = useState('');
  const [manualLot, setManualLot] = useState('D009TN08096');
  const [manualSku, setManualSku] = useState('TP101020104.002');
  const [manualWeight, setManualWeight] = useState('20');
  const [manualShift, setManualShift] = useState('Nguyên');
  const [manualDate, setManualDate] = useState('07/09/2026');

  // Duplicate Warning Alert
  const [duplicateWarning, setDuplicateWarning] = useState<string | null>(null);

  useEffect(() => {
    loadActivePallet();
  }, []);

  // AUTO SCAN INTERVAL LOOP - ONLY RUNS WHEN activePallet EXISTS!
  useEffect(() => {
    let scanTimer: any = null;

    if (isAutoScan && activePallet && permission?.granted) {
      scanTimer = setInterval(() => {
        runAutoScanCycle();
      }, 750);
    }

    return () => {
      if (scanTimer) clearInterval(scanTimer);
    };
  }, [isAutoScan, activePallet, permission?.granted]);

  async function loadActivePallet() {
    try {
      const pallet = await getActivePallet();
      if (pallet) {
        setActivePallet(pallet);
        const boxList = await getBoxesByPallet(pallet.id);
        setBoxes(boxList);
      } else {
        // DO NOT FORCE MODAL! Let user explore app or choose when to start
        setActivePallet(null);
        setBoxes([]);
      }
    } catch (e: any) {
      console.error('Error loading pallet:', e);
    }
  }

  function showSuccessFlash(msg: string) {
    setSuccessBanner(msg);
    Animated.sequence([
      Animated.timing(bannerAnim, { toValue: 1, duration: 200, useNativeDriver: true }),
      Animated.delay(1800),
      Animated.timing(bannerAnim, { toValue: 0, duration: 300, useNativeDriver: true })
    ]).start(() => setSuccessBanner(null));
  }

  async function processBoxData(parsedData: ParsedLabelData, isAuto = false) {
    if (!activePallet) {
      if (!isAuto) Alert.alert('Chưa có Pallet', 'Vui lòng chọn hoặc tạo Pallet trước khi quét');
      return;
    }

    try {
      setDuplicateWarning(null);
      const { box } = await addBoxToPallet(activePallet.id, parsedData);

      // Success Sound & Haptic
      Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
      Vibration.vibrate(100);

      lastScannedBoxRef.current = box.box_index;
      lastScannedTimeRef.current = Date.now();
      pauseUntilRef.current = Date.now() + 2000; // Pause auto-scan for 2.0s so worker comfortably moves to next box

      showSuccessFlash(`✅ ĐÃ QUÉT THÙNG #${box.box_index} (${box.weight}kg)`);

      // Refresh list
      const updatedBoxes = await getBoxesByPallet(activePallet.id);
      setBoxes(updatedBoxes);
      setActivePallet(prev => prev ? {
        ...prev,
        scanned_qty: updatedBoxes.length,
        total_weight: updatedBoxes.reduce((s, b) => s + b.weight, 0)
      } : null);

      // Check if target reached!
      if (updatedBoxes.length >= activePallet.target_qty) {
        Alert.alert(
          '🎉 ĐÃ ĐỦ PALLET!',
          `Pallet ${activePallet.code} đã đạt chỉ tiêu ${updatedBoxes.length}/${activePallet.target_qty} thùng.\nBạn có muốn chốt Pallet này không?`,
          [
            { text: 'Tiếp tục quét thêm', style: 'cancel' },
            { text: 'Chốt Pallet', onPress: handleCompletePallet }
          ]
        );
      }
    } catch (err: any) {
      if (!isAuto) {
        Haptics.notificationAsync(Haptics.NotificationFeedbackType.Error);
        Vibration.vibrate([0, 200, 100, 200]);
        setDuplicateWarning(err.message);
      }
    }
  }

  // 100% OFFLINE RECOGNITION CORE WITH STRICT LABEL VALIDATION
  async function recognizeImage(photo: any): Promise<ParsedLabelData | null> {
    // 1. Priority 1: Google ML Kit ON-DEVICE (100% Offline, ~80ms)
    try {
      if (TextRecognition && typeof TextRecognition.recognize === 'function') {
        const mlResult = await TextRecognition.recognize(photo.uri);
        if (mlResult?.text && mlResult.text.trim()) {
          // Strictly validate that this text is an actual carton box label
          if (isBoxLabel(mlResult.text)) {
            const parsed = parseBoxLabelText(mlResult.text);
            if (parsed && parsed.box_index) {
              return parsed;
            }
          }
        }
      }
    } catch (mlErr) {
      // Native ML Kit not available
    }

    // 2. Priority 2: Server Fallback via API (only when connected)
    if (photo.base64) {
      try {
        const storedUrl = await AsyncStorage.getItem('config_supabase_url');
        const baseApiUrl = storedUrl || DEFAULT_SUPABASE_URL;
        const ocrEndpoint = baseApiUrl.replace(/\/$/, '') + '/api/ocr';

        const response = await fetch(ocrEndpoint, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ image: photo.base64 })
        });
        const resJson = await response.json();
        if (resJson?.success && resJson?.data && resJson.data.box_index) {
          return resJson.data;
        }
      } catch (srvErr) {
        // Offline with no native ML Kit
      }
    }

    return null;
  }

  // AUTO SCAN CYCLE
  async function runAutoScanCycle() {
    // Strict Guard: ONLY scan if an active pallet is selected and not paused
    if (!cameraRef.current || !activePallet || isProcessingFrame.current || isScanning) return;
    if (Date.now() < pauseUntilRef.current) return;

    try {
      isProcessingFrame.current = true;
      const photo = await cameraRef.current.takePictureAsync({
        quality: 0.5,
        base64: true,
        skipProcessing: true
      });

      if (!photo?.uri) return;

      const parsed = await recognizeImage(photo);
      // Strictly require a valid box index extracted from a validated label
      if (parsed && parsed.box_index) {
        // Debounce: If same box index scanned within last 4 seconds, ignore
        if (parsed.box_index === lastScannedBoxRef.current && (Date.now() - lastScannedTimeRef.current < 4000)) {
          return;
        }
        await processBoxData(parsed, true);
      }
    } catch (err) {
      // Ignore background cycle hiccups
    } finally {
      isProcessingFrame.current = false;
    }
  }

  // MANUAL CAPTURE BUTTON
  async function handleManualCapture() {
    if (!cameraRef.current) return;
    if (!activePallet) {
      Alert.alert('Chưa có Pallet', 'Vui lòng bấm [+ Nhập STT Pallet] trước khi quét', [
        { text: 'Huỷ', style: 'cancel' },
        { text: 'Nhập STT Pallet', onPress: () => setIsNewPalletModal(true) }
      ]);
      return;
    }

    setIsScanning(true);
    setDuplicateWarning(null);
    try {
      const photo = await cameraRef.current.takePictureAsync({
        quality: 0.8,
        base64: true,
        skipProcessing: false
      });

      if (!photo?.uri) {
        throw new Error('Không thể chụp ảnh từ Camera');
      }

      const parsed = await recognizeImage(photo);
      if (!parsed || !parsed.box_index) {
        throw new Error('Không phát hiện con tem thùng hợp lệ trong khung hình');
      }

      await processBoxData(parsed, false);
    } catch (err: any) {
      Haptics.notificationAsync(Haptics.NotificationFeedbackType.Error);
      Alert.alert(
        'Không nhận diện được tem',
        err.message || 'Không tìm thấy số STT trên tem.\n\n👉 Bạn có thể bấm "Sửa / Nhập tay" để điền số thùng nhanh.',
        [
          { text: 'Đóng', style: 'cancel' },
          { text: 'Nhập tay ngay', onPress: () => setIsManualModal(true) }
        ]
      );
    } finally {
      setIsScanning(false);
    }
  }

  async function handleCreatePallet() {
    if (!newPalletCode.trim()) {
      Alert.alert('Lỗi', 'Vui lòng nhập số thực tế (STT) Pallet (Ví dụ: F3500 hoặc F5556)');
      return;
    }

    const cleanCode = newPalletCode.trim().toUpperCase();
    const existing = await getPalletByCode(cleanCode);

    if (existing) {
      Alert.alert(
        `⚠️ STT ${cleanCode} ĐÃ CÓ TRONG HỆ THỐNG!`,
        `STT ${cleanCode} hiện đang có ${existing.scanned_qty} thùng (${existing.total_weight} Kg).\n\nPallet này có bị xáo trộn hàng và bạn cần quét lại không?`,
        [
          {
            text: '🔄 Quét lại từ đầu (Xoá cũ)',
            style: 'destructive',
            onPress: async () => {
              await resetPalletBoxes(existing.id);
              const activated = await activateExistingPallet(existing.id);
              setActivePallet(activated);
              setBoxes([]);
              setIsNewPalletModal(false);
              Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
            }
          },
          {
            text: 'Tiếp tục quét thêm',
            onPress: async () => {
              const activated = await activateExistingPallet(existing.id);
              setActivePallet(activated);
              const existingBoxes = await getBoxesByPallet(existing.id);
              setBoxes(existingBoxes);
              setIsNewPalletModal(false);
            }
          },
          { text: 'Huỷ', style: 'cancel' }
        ]
      );
      return;
    }

    const target = parseInt(newTargetQty) || 30;
    const pallet = await createNewPallet(cleanCode, target);
    setActivePallet(pallet);
    setBoxes([]);
    setIsNewPalletModal(false);
    Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
  }

  async function handleCompletePallet() {
    if (!activePallet) return;
    await completePallet(activePallet.id);
    Alert.alert('Thành công', `Đã chốt Pallet ${activePallet.code} với ${boxes.length} thùng!\nDữ liệu đã lưu ngoại tuyến.`);
    setActivePallet(null);
    setBoxes([]);
  }

  async function handleDeleteBox(box: BoxLabel) {
    if (!activePallet) return;
    Alert.alert(
      'Xoá thùng',
      `Xoá thùng STT #${box.box_index} khỏi Pallet?`,
      [
        { text: 'Huỷ', style: 'cancel' },
        {
          text: 'Xoá',
          style: 'destructive',
          onPress: async () => {
            await deleteBox(box.id, activePallet.id);
            const updated = await getBoxesByPallet(activePallet.id);
            setBoxes(updated);
            setActivePallet(prev => prev ? {
              ...prev,
              scanned_qty: updated.length,
              total_weight: updated.reduce((s, b) => s + b.weight, 0)
            } : null);
          }
        }
      ]
    );
  }

  async function handleSaveManual() {
    if (!manualIndex.trim()) {
      Alert.alert('Thiếu thông tin', 'Vui lòng nhập số thứ tự thùng (INDEX)');
      return;
    }

    const parsed: ParsedLabelData = {
      sku: manualSku.trim(),
      lot_code: manualLot.trim().toUpperCase(),
      product_name: 'TP cấp đông sầu riêng múi monthong C - Hàng có hạt',
      box_index: manualIndex.trim(),
      weight: parseFloat(manualWeight) || 20,
      unit: 'Kg',
      shift_group: manualShift.trim(),
      region: 'Tây Nguyên',
      production_date: manualDate.trim(),
      packaging_date: manualDate.trim(),
      spec: 'Thùng/túi: 20kg',
      raw_text: 'Manual Input'
    };

    setIsManualModal(false);
    setManualIndex('');
    await processBoxData(parsed, false);
  }

  if (!permission) {
    return <View style={styles.center}><ActivityIndicator color="#10b981" size="large" /></View>;
  }

  if (!permission.granted) {
    return (
      <View style={styles.center}>
        <Ionicons name="camera-outline" size={64} color="#64748b" />
        <Text style={styles.permissionText}>Ứng dụng cần quyền Camera để quét tem thùng</Text>
        <TouchableOpacity style={styles.permissionBtn} onPress={requestPermission}>
          <Text style={styles.permissionBtnText}>Cấp quyền Camera</Text>
        </TouchableOpacity>
      </View>
    );
  }

  const scannedCount = boxes.length;
  const targetCount = activePallet?.target_qty || 30;
  const progressPercent = activePallet ? Math.min(100, Math.round((scannedCount / targetCount) * 100)) : 0;

  return (
    <View style={styles.container}>
      {/* 🔴 HEADER: PALLET STT & PROGRESS */}
      <View style={styles.topInfoBar}>
        <View style={styles.palletMetaCol}>
          <Text style={styles.palletLabel}>STT PALLET HIỆN TẠI</Text>
          <TouchableOpacity
            style={styles.palletCodeRow}
            onPress={() => {
              setNewPalletCode(activePallet?.code || '');
              setIsNewPalletModal(true);
            }}
          >
            {activePallet ? (
              <>
                <Text style={styles.palletCodeText}>{activePallet.code}</Text>
                <Ionicons name="create-outline" size={18} color="#f59e0b" style={{ marginLeft: 6 }} />
              </>
            ) : (
              <View style={styles.selectPalletPrompt}>
                <Ionicons name="add-circle" size={18} color="#10b981" />
                <Text style={styles.selectPalletPromptText}>Chọn / Nhập STT Pallet</Text>
              </View>
            )}
          </TouchableOpacity>
        </View>

        <View style={styles.weightBadge}>
          <Text style={styles.weightBadgeLabel}>TỔNG KG</Text>
          <Text style={styles.weightBadgeVal}>{activePallet ? activePallet.total_weight : 0} Kg</Text>
        </View>
      </View>

      {/* PROGRESS BAR (Only visible when activePallet exists) */}
      {activePallet ? (
        <View style={styles.progressContainer}>
          <View style={styles.progressRow}>
            <Text style={styles.progressLabel}>Tiến độ Pallet: <Text style={styles.progressBold}>{scannedCount} / {targetCount} thùng</Text></Text>
            <Text style={styles.progressPercent}>{progressPercent}%</Text>
          </View>
          <View style={styles.progressBarTrack}>
            <View style={[styles.progressBarFill, { width: `${progressPercent}%` }]} />
          </View>
        </View>
      ) : (
        <View style={styles.noPalletTipBar}>
          <Ionicons name="information-circle-outline" size={16} color="#38bdf8" />
          <Text style={styles.noPalletTipText}>Bạn chưa chọn Pallet. Hãy bấm chọn Pallet để kích hoạt quét.</Text>
        </View>
      )}

      {/* AUTO SCAN MODE TOGGLE BAR */}
      <View style={styles.autoScanBar}>
        <TouchableOpacity
          style={[styles.autoScanToggle, (isAutoScan && activePallet) ? styles.autoScanActive : styles.autoScanInactive]}
          onPress={() => {
            if (!activePallet) {
              setIsNewPalletModal(true);
              return;
            }
            setIsAutoScan(prev => !prev);
            Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
          }}
        >
          <Ionicons name={(isAutoScan && activePallet) ? "flash" : "flash-off"} size={16} color={(isAutoScan && activePallet) ? "#10b981" : "#94a3b8"} />
          <Text style={[styles.autoScanText, (isAutoScan && activePallet) && { color: '#10b981', fontWeight: '700' }]}>
            {activePallet ? (isAutoScan ? "Tự động quét: ĐANG BẬT" : "Tự động quét: ĐÃ TẮT") : "Tự động quét: CHỜ CHỌN PALLET"}
          </Text>
        </TouchableOpacity>

        <TouchableOpacity style={styles.torchBtn} onPress={() => setTorch(t => !t)}>
          <Ionicons name={torch ? "flash" : "flash-outline"} size={18} color={torch ? "#facc15" : "#94a3b8"} />
        </TouchableOpacity>
      </View>

      {/* 📷 CAMERA VIEWPORT */}
      <View style={styles.cameraBox}>
        <CameraView
          ref={cameraRef}
          style={StyleSheet.absoluteFill}
          facing="back"
          enableTorch={torch}
        />

        {/* Viewfinder Overlay Frame */}
        <View style={styles.viewfinderFrame}>
          <View style={[styles.cornerTL, (isAutoScan && activePallet) && styles.cornerActive]} />
          <View style={[styles.cornerTR, (isAutoScan && activePallet) && styles.cornerActive]} />
          <View style={[styles.cornerBL, (isAutoScan && activePallet) && styles.cornerActive]} />
          <View style={[styles.cornerBR, (isAutoScan && activePallet) && styles.cornerActive]} />

          <View style={styles.scanHintBox}>
            <Text style={styles.scanHintText}>
              {!activePallet
                ? "CHỌN PALLET ĐỂ BẮT ĐẦU"
                : (isAutoScan ? "⚡ ĐANG TỰ ĐỘNG QUÉT TEM..." : "CĂN KHUNG VÀO CON TEM THÙNG")}
            </Text>
          </View>
        </View>

        {/* Overlay when no active pallet */}
        {!activePallet && (
          <View style={styles.noPalletOverlay}>
            <Ionicons name="cube-outline" size={36} color="#38bdf8" />
            <Text style={styles.noPalletOverlayTitle}>Chưa chọn Pallet</Text>
            <Text style={styles.noPalletOverlaySub}>Để tránh quét nhầm hàng, vui lòng chọn hoặc nhập số Pallet trước.</Text>
            <TouchableOpacity style={styles.selectPalletOverlayBtn} onPress={() => setIsNewPalletModal(true)}>
              <Ionicons name="add-circle-outline" size={18} color="#fff" />
              <Text style={styles.selectPalletOverlayBtnText}>Chọn / Nhập Pallet Ngay</Text>
            </TouchableOpacity>
          </View>
        )}

        {/* SUCCESS POPUP BANNER */}
        {successBanner && (
          <Animated.View style={[styles.successBanner, { opacity: bannerAnim }]}>
            <Text style={styles.successBannerText}>{successBanner}</Text>
          </Animated.View>
        )}
      </View>

      {/* ⚠️ DUPLICATE ALERT WARNING */}
      {duplicateWarning && (
        <View style={styles.warningCard}>
          <Ionicons name="warning" size={20} color="#ef4444" />
          <Text style={styles.warningText}>{duplicateWarning}</Text>
        </View>
      )}

      {/* ACTION BUTTONS */}
      <View style={styles.actionRow}>
        <TouchableOpacity
          style={[styles.simulateScanBtn, (!activePallet || isScanning) && { opacity: 0.6 }]}
          disabled={isScanning}
          onPress={handleManualCapture}
        >
          {isScanning ? (
            <>
              <ActivityIndicator color="#ffffff" size="small" />
              <Text style={styles.simulateScanText}>Đang đọc tem...</Text>
            </>
          ) : (
            <>
              <Ionicons name="camera" size={20} color="#ffffff" />
              <Text style={styles.simulateScanText}>Chụp Quét Tem</Text>
            </>
          )}
        </TouchableOpacity>

        <TouchableOpacity
          style={[styles.manualBtn, !activePallet && { opacity: 0.6 }]}
          onPress={() => {
            if (!activePallet) {
              setIsNewPalletModal(true);
              return;
            }
            setIsManualModal(true);
          }}
        >
          <Ionicons name="keypad-outline" size={20} color="#38bdf8" />
          <Text style={styles.manualBtnText}>Sửa / Nhập tay</Text>
        </TouchableOpacity>

        {activePallet && scannedCount > 0 && (
          <TouchableOpacity
            style={styles.completeBtn}
            onPress={handleCompletePallet}
          >
            <Ionicons name="cube-outline" size={20} color="#ffffff" />
            <Text style={styles.completeBtnText}>Chốt Pallet</Text>
          </TouchableOpacity>
        )}
      </View>

      {/* 📦 RECENT SCANNED BOXES LIST */}
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
            <Ionicons name="barcode-outline" size={32} color="#64748b" />
            <Text style={styles.emptyText}>Chưa có thùng nào trong Pallet {activePallet.code}</Text>
            <Text style={styles.emptySubText}>
              {isAutoScan ? "Hướng camera vào tem thùng để tự động quét" : "Hướng camera vào tem rồi bấm [Chụp Quét Tem]"}
            </Text>
          </View>
        ) : (
          boxes.map((b, idx) => (
            <View key={b.id} style={styles.richBoxCard}>
              <View style={styles.richBoxHeader}>
                <View style={styles.richBoxIndexBadge}>
                  <Text style={styles.richBoxIndexText}>#{b.box_index}</Text>
                </View>
                <Text style={styles.richBoxSkuText}>SKU: {b.sku}</Text>
                <View style={styles.richBoxWeightBadge}>
                  <Text style={styles.richBoxWeightText}>{b.weight} {b.unit}</Text>
                </View>
                <TouchableOpacity onPress={() => handleDeleteBox(b)} style={styles.deleteBoxBtn}>
                  <Ionicons name="trash-outline" size={18} color="#ef4444" />
                </TouchableOpacity>
              </View>

              <Text style={styles.richBoxTitle}>{b.product_name}</Text>

              <View style={styles.richBoxMetaRow}>
                <Text style={styles.richMetaText}><Text style={styles.metaLabel}>Lot:</Text> {b.lot_code}</Text>
                <Text style={styles.richMetaText}><Text style={styles.metaLabel}>Quy cách:</Text> {b.spec || '20kg'}</Text>
                <Text style={styles.richMetaText}><Text style={styles.metaLabel}>Tổ:</Text> {b.shift_group || 'Nguyên'}</Text>
                <Text style={styles.richMetaText}><Text style={styles.metaLabel}>Vùng:</Text> {b.region || 'Tây Nguyên'}</Text>
                <Text style={styles.richMetaText}><Text style={styles.metaLabel}>NSX:</Text> {b.production_date}</Text>
                <Text style={styles.richMetaText}><Text style={styles.metaLabel}>NĐG:</Text> {b.packaging_date || b.production_date}</Text>
              </View>
            </View>
          ))
        )}
      </ScrollView>

      {/* 📝 MODAL: NEW / SELECT PALLET */}
      <Modal visible={isNewPalletModal} transparent animationType="slide">
        <View style={styles.modalBg}>
          <View style={styles.modalCard}>
            <Text style={styles.modalTitle}>📦 CHỌN / NHẬP STT PALLET</Text>
            <Text style={styles.modalSub}>Nhập số thực tế của Pallet đang xếp hàng (Ví dụ: F3500 hoặc F5556)</Text>

            <Text style={styles.inputLabel}>Số thực tế Pallet (STT):</Text>
            <TextInput
              style={styles.modalInput}
              value={newPalletCode}
              onChangeText={setNewPalletCode}
              placeholder="Ví dụ: F3500"
              placeholderTextColor="#64748b"
              autoCapitalize="characters"
              autoFocus
            />

            <Text style={styles.inputLabel}>Chỉ tiêu số thùng (Mặc định: 30):</Text>
            <TextInput
              style={styles.modalInput}
              value={newTargetQty}
              onChangeText={setNewTargetQty}
              keyboardType="number-pad"
              placeholder="30"
              placeholderTextColor="#64748b"
            />

            <View style={styles.modalBtnRow}>
              <TouchableOpacity
                style={styles.modalCancelBtn}
                onPress={() => setIsNewPalletModal(false)}
              >
                <Text style={styles.modalCancelText}>Đóng</Text>
              </TouchableOpacity>
              <TouchableOpacity
                style={styles.modalSaveBtn}
                onPress={handleCreatePallet}
              >
                <Text style={styles.modalSaveText}>Bắt Đầu Quét Pallet</Text>
              </TouchableOpacity>
            </View>
          </View>
        </View>
      </Modal>

      {/* ✏️ MODAL: MANUAL EDIT / INPUT */}
      <Modal visible={isManualModal} transparent animationType="slide">
        <View style={styles.modalBg}>
          <View style={styles.modalCard}>
            <Text style={styles.modalTitle}>✏️ NHẬP / SỬA THÙNG TAY</Text>
            <Text style={styles.modalSub}>Dành cho tem mờ hoặc điều chỉnh số thùng nhanh</Text>

            <Text style={styles.inputLabel}>Số thứ tự thùng (INDEX) *:</Text>
            <TextInput
              style={[styles.modalInput, { fontSize: 24, fontWeight: '700', color: '#10b981' }]}
              value={manualIndex}
              onChangeText={setManualIndex}
              placeholder="Ví dụ: 398"
              placeholderTextColor="#64748b"
              keyboardType="number-pad"
              autoFocus
            />

            <View style={{ flexDirection: 'row', gap: 10 }}>
              <View style={{ flex: 1 }}>
                <Text style={styles.inputLabel}>Mã Lot:</Text>
                <TextInput
                  style={styles.modalInput}
                  value={manualLot}
                  onChangeText={setManualLot}
                  autoCapitalize="characters"
                />
              </View>
              <View style={{ width: 90 }}>
                <Text style={styles.inputLabel}>Kg:</Text>
                <TextInput
                  style={styles.modalInput}
                  value={manualWeight}
                  onChangeText={setManualWeight}
                  keyboardType="numeric"
                />
              </View>
            </View>

            <View style={styles.modalBtnRow}>
              <TouchableOpacity
                style={styles.modalCancelBtn}
                onPress={() => setIsManualModal(false)}
              >
                <Text style={styles.modalCancelText}>Huỷ</Text>
              </TouchableOpacity>
              <TouchableOpacity
                style={styles.modalSaveBtn}
                onPress={handleSaveManual}
              >
                <Text style={styles.modalSaveText}>Thêm Vào Pallet</Text>
              </TouchableOpacity>
            </View>
          </View>
        </View>
      </Modal>
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: '#090d16' },
  center: { flex: 1, justifyContent: 'center', alignItems: 'center', backgroundColor: '#090d16', padding: 20 },
  permissionText: { color: '#94a3b8', fontSize: 16, textAlign: 'center', marginTop: 16, marginBottom: 20 },
  permissionBtn: { backgroundColor: '#10b981', paddingHorizontal: 24, paddingVertical: 12, borderRadius: 8 },
  permissionBtnText: { color: '#fff', fontWeight: '700' },

  topInfoBar: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    paddingHorizontal: 16,
    paddingTop: 8,
    paddingBottom: 6
  },
  palletMetaCol: { flex: 1 },
  palletLabel: { color: '#94a3b8', fontSize: 11, fontWeight: '700', letterSpacing: 0.5 },
  palletCodeRow: { flexDirection: 'row', alignItems: 'center', marginTop: 2 },
  palletCodeText: { color: '#ffffff', fontSize: 22, fontWeight: '800' },
  selectPalletPrompt: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    backgroundColor: '#064e3b',
    paddingHorizontal: 10,
    paddingVertical: 4,
    borderRadius: 6,
    marginTop: 2
  },
  selectPalletPromptText: { color: '#10b981', fontSize: 13, fontWeight: '700' },

  weightBadge: {
    backgroundColor: '#1e293b',
    paddingHorizontal: 14,
    paddingVertical: 6,
    borderRadius: 10,
    alignItems: 'flex-end',
    borderWidth: 1,
    borderColor: '#334155'
  },
  weightBadgeLabel: { color: '#94a3b8', fontSize: 10, fontWeight: '700' },
  weightBadgeVal: { color: '#38bdf8', fontSize: 16, fontWeight: '800' },

  progressContainer: { paddingHorizontal: 16, marginBottom: 8 },
  progressRow: { flexDirection: 'row', justifyContent: 'space-between', marginBottom: 4 },
  progressLabel: { color: '#e2e8f0', fontSize: 13 },
  progressBold: { color: '#ffffff', fontWeight: '700' },
  progressPercent: { color: '#10b981', fontWeight: '700', fontSize: 13 },
  progressBarTrack: { height: 6, backgroundColor: '#1e293b', borderRadius: 3, overflow: 'hidden' },
  progressBarFill: { height: '100%', backgroundColor: '#10b981' },

  noPalletTipBar: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    backgroundColor: 'rgba(56, 189, 248, 0.1)',
    marginHorizontal: 16,
    paddingHorizontal: 12,
    paddingVertical: 6,
    borderRadius: 8,
    borderWidth: 1,
    borderColor: 'rgba(56, 189, 248, 0.25)',
    marginBottom: 8
  },
  noPalletTipText: { color: '#38bdf8', fontSize: 12, flex: 1 },

  autoScanBar: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    paddingHorizontal: 16,
    marginBottom: 6
  },
  autoScanToggle: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 12,
    paddingVertical: 6,
    borderRadius: 20,
    backgroundColor: '#1e293b',
    gap: 6
  },
  autoScanActive: { backgroundColor: '#064e3b', borderWidth: 1, borderColor: '#10b981' },
  autoScanInactive: { backgroundColor: '#1e293b' },
  autoScanText: { color: '#94a3b8', fontSize: 12 },
  torchBtn: {
    padding: 6,
    borderRadius: 8,
    backgroundColor: '#1e293b',
    borderWidth: 1,
    borderColor: '#334155'
  },

  cameraBox: {
    height: 220,
    marginHorizontal: 16,
    borderRadius: 14,
    overflow: 'hidden',
    backgroundColor: '#000',
    position: 'relative',
    borderWidth: 1.5,
    borderColor: '#334155'
  },
  viewfinderFrame: {
    ...StyleSheet.absoluteFill,
    justifyContent: 'center',
    alignItems: 'center',
    padding: 16
  },
  cornerTL: { position: 'absolute', top: 12, left: 12, width: 28, height: 28, borderTopWidth: 3, borderLeftWidth: 3, borderColor: '#38bdf8' },
  cornerTR: { position: 'absolute', top: 12, right: 12, width: 28, height: 28, borderTopWidth: 3, borderRightWidth: 3, borderColor: '#38bdf8' },
  cornerBL: { position: 'absolute', bottom: 12, left: 12, width: 28, height: 28, borderBottomWidth: 3, borderLeftWidth: 3, borderColor: '#38bdf8' },
  cornerBR: { position: 'absolute', bottom: 12, right: 12, width: 28, height: 28, borderBottomWidth: 3, borderRightWidth: 3, borderColor: '#38bdf8' },
  cornerActive: { borderColor: '#10b981' },

  scanHintBox: {
    backgroundColor: 'rgba(0, 0, 0, 0.65)',
    paddingHorizontal: 12,
    paddingVertical: 5,
    borderRadius: 6
  },
  scanHintText: { color: '#ffffff', fontSize: 11, fontWeight: '700', letterSpacing: 0.5 },

  noPalletOverlay: {
    ...StyleSheet.absoluteFill,
    backgroundColor: 'rgba(9, 13, 22, 0.88)',
    justifyContent: 'center',
    alignItems: 'center',
    padding: 20
  },
  noPalletOverlayTitle: { color: '#ffffff', fontSize: 16, fontWeight: '800', marginTop: 8 },
  noPalletOverlaySub: { color: '#94a3b8', fontSize: 12, textAlign: 'center', marginTop: 4, marginBottom: 14, paddingHorizontal: 10 },
  selectPalletOverlayBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    backgroundColor: '#10b981',
    paddingHorizontal: 18,
    paddingVertical: 9,
    borderRadius: 8
  },
  selectPalletOverlayBtnText: { color: '#ffffff', fontWeight: '700', fontSize: 13 },

  successBanner: {
    position: 'absolute',
    bottom: 12,
    left: 12,
    right: 12,
    backgroundColor: '#10b981',
    paddingVertical: 10,
    borderRadius: 8,
    alignItems: 'center'
  },
  successBannerText: { color: '#ffffff', fontWeight: '800', fontSize: 14 },

  warningCard: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    backgroundColor: 'rgba(239, 68, 68, 0.15)',
    borderWidth: 1,
    borderColor: '#ef4444',
    marginHorizontal: 16,
    marginTop: 8,
    padding: 10,
    borderRadius: 8
  },
  warningText: { color: '#ef4444', fontSize: 12, flex: 1, fontWeight: '600' },

  actionRow: {
    flexDirection: 'row',
    gap: 8,
    paddingHorizontal: 16,
    marginTop: 10,
    marginBottom: 10
  },
  simulateScanBtn: {
    flex: 1.3,
    backgroundColor: '#059669',
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 6,
    paddingVertical: 11,
    borderRadius: 10
  },
  simulateScanText: { color: '#ffffff', fontWeight: '700', fontSize: 14 },
  manualBtn: {
    flex: 1,
    backgroundColor: '#0f2942',
    borderWidth: 1,
    borderColor: '#0284c7',
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 4,
    paddingVertical: 11,
    borderRadius: 10
  },
  manualBtnText: { color: '#38bdf8', fontWeight: '700', fontSize: 13 },
  completeBtn: {
    backgroundColor: '#7c3aed',
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
    paddingHorizontal: 14,
    borderRadius: 10
  },
  completeBtnText: { color: '#fff', fontWeight: '700', fontSize: 13 },

  listHeaderRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    paddingHorizontal: 16,
    marginBottom: 6
  },
  listHeaderTitle: { color: '#94a3b8', fontSize: 12, fontWeight: '700', textTransform: 'uppercase' },
  seeAllText: { color: '#38bdf8', fontSize: 12, fontWeight: '600' },

  boxList: { flex: 1, paddingHorizontal: 16 },
  emptyBox: { alignItems: 'center', paddingVertical: 24 },
  emptyText: { color: '#e2e8f0', fontSize: 14, fontWeight: '700', marginTop: 8 },
  emptySubText: { color: '#64748b', fontSize: 12, marginTop: 4, textAlign: 'center' },

  
  richBoxCard: {
    backgroundColor: '#131b2e',
    borderRadius: 10,
    padding: 12,
    marginBottom: 8,
    borderWidth: 1,
    borderColor: '#1e293b',
  },
  richBoxHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    marginBottom: 4,
  },
  richBoxIndexBadge: {
    backgroundColor: '#064e3b',
    paddingHorizontal: 8,
    paddingVertical: 2,
    borderRadius: 6,
    borderWidth: 1,
    borderColor: '#10b981',
    marginRight: 8,
  },
  richBoxIndexText: {
    color: '#34d399',
    fontSize: 13,
    fontWeight: '900',
  },
  richBoxSkuText: {
    color: '#94a3b8',
    fontSize: 12,
    fontWeight: '700',
    flex: 1,
  },
  richBoxWeightBadge: {
    backgroundColor: '#0c4a6e',
    paddingHorizontal: 7,
    paddingVertical: 2,
    borderRadius: 6,
    marginRight: 6,
  },
  richBoxWeightText: {
    color: '#38bdf8',
    fontSize: 12,
    fontWeight: '800',
  },
  richBoxTitle: {
    color: '#ffffff',
    fontSize: 13,
    fontWeight: '800',
    lineHeight: 18,
    marginBottom: 6,
  },
  richBoxMetaRow: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 4,
    paddingTop: 4,
    borderTopWidth: 1,
    borderTopColor: '#1e293b',
  },
  richMetaText: {
    width: '48%',
    color: '#cbd5e1',
    fontSize: 11,
    marginVertical: 1,
  },
  metaLabel: {
    color: '#64748b',
    fontWeight: '600',
  },
  deleteBoxBtn: { padding: 4 },

  modalBg: { flex: 1, backgroundColor: 'rgba(0,0,0,0.75)', justifyContent: 'center', padding: 20 },
  modalCard: { backgroundColor: '#131b2e', borderRadius: 16, padding: 20, borderWidth: 1, borderColor: '#334155' },
  modalTitle: { color: '#fff', fontSize: 17, fontWeight: '800', marginBottom: 4 },
  modalSub: { color: '#94a3b8', fontSize: 12, marginBottom: 16 },
  inputLabel: { color: '#cbd5e1', fontSize: 12, fontWeight: '600', marginBottom: 6 },
  modalInput: {
    backgroundColor: '#1e293b',
    color: '#fff',
    paddingHorizontal: 14,
    paddingVertical: 10,
    borderRadius: 8,
    fontSize: 15,
    marginBottom: 14,
    borderWidth: 1,
    borderColor: '#334155'
  },
  modalBtnRow: { flexDirection: 'row', justifyContent: 'flex-end', gap: 10, marginTop: 10 },
  modalCancelBtn: { paddingHorizontal: 16, paddingVertical: 10, borderRadius: 8, backgroundColor: '#334155' },
  modalCancelText: { color: '#fff', fontWeight: '600' },
  modalSaveBtn: { paddingHorizontal: 20, paddingVertical: 10, borderRadius: 8, backgroundColor: '#10b981' },
  modalSaveText: { color: '#fff', fontWeight: '700' }
});
