import React, { useState, useEffect, useRef } from 'react';
import {
  View, Text, StyleSheet, TouchableOpacity, ScrollView,
  Alert, Modal, TextInput, ActivityIndicator, Vibration, Animated, Platform
} from 'react-native';
import { CameraView, useCameraPermissions } from 'expo-camera';
import TextRecognition from '@react-native-ml-kit/text-recognition';
import * as Haptics from 'expo-haptics';
import { Ionicons } from '@expo/vector-icons';
import { Pallet, BoxLabel, ParsedStampData, StampFormat } from '../types';
import {
  getActivePallet, createNewPallet, completePallet,
  getBoxesByPallet, addStampBoxToPallet, deleteBox,
  getPalletByCode, activateExistingPallet, getStampDictionariesMap,
  getActiveStampFormat
} from '../services/database';
import { parseStampText, isStampContent, decodeStamp } from '../services/stampParser';

export default function StampScannerScreen({ onNavigateToPallets }: { onNavigateToPallets: () => void }) {
  const [permission, requestPermission] = useCameraPermissions();
  const cameraRef = useRef<any>(null);

  const [activePallet, setActivePallet] = useState<Pallet | null>(null);
  const [boxes, setBoxes] = useState<BoxLabel[]>([]);
  const [isScanning, setIsScanning] = useState(false);
  const [torch, setTorch] = useState(false);

  // Pallet Modal
  const [isNewPalletModal, setIsNewPalletModal] = useState(false);
  const [newPalletCode, setNewPalletCode] = useState('');
  const [newTargetQty, setNewTargetQty] = useState('30');

  // Stamp Scanned Confirmation Modal
  const [pendingStamp, setPendingStamp] = useState<ParsedStampData | null>(null);
  const [pendingWeight, setPendingWeight] = useState('20');
  const [isSaving, setIsSaving] = useState(false);

  // Manual Input Modal
  const [isManualModal, setIsManualModal] = useState(false);
  const [manualLine1, setManualLine1] = useState('10102010204001');
  const [manualLine2, setManualLine2] = useState('1110926001471609');
  const [manualWeight, setManualWeight] = useState('20');

  // Success Feedback Banner
  const [successBanner, setSuccessBanner] = useState<string | null>(null);
  const bannerAnim = useRef(new Animated.Value(0)).current;

  // Offline Stamp Dictionary Map & Active Template
  const [dictMap, setDictMap] = useState<Record<string, Record<string, string>>>({});
  const [activeFormat, setActiveFormat] = useState<StampFormat | null>(null);

  useEffect(() => {
    loadActivePallet();
    getStampDictionariesMap().then(map => setDictMap(map)).catch(() => {});
    getActiveStampFormat().then(fmt => setActiveFormat(fmt)).catch(() => {});
  }, []);

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
    if (!cameraRef.current || isScanning) return;

    if (!activePallet) {
      Alert.alert(
        'Chưa có Pallet',
        'Vui lòng nhập Số Thứ Tự (STT) Pallet trước khi quét dấu thùng!',
        [
          { text: 'Nhập STT Pallet', onPress: () => setIsNewPalletModal(true) }
        ]
      );
      return;
    }

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

        const parsed = parseStampText(raw, dictMap, activeFormat);
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
      const res = await addStampBoxToPallet(activePallet.id, pendingStamp, w);
      
      Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
      triggerSuccessBanner(`✅ Đã lưu thùng #${res.box.box_index} (Dòng 1: ${pendingStamp.stamp_line1})`);
      
      setPendingStamp(null);
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
      const stampData: ParsedStampData = {
        stamp_line1: manualLine1.trim(),
        stamp_line2: manualLine2.trim(),
        raw_text: `${manualLine1.trim()}\n${manualLine2.trim()}`,
        detected_lines: [manualLine1.trim(), manualLine2.trim()].filter(Boolean),
        decoded: decodeStamp(manualLine1.trim(), manualLine2.trim(), dictMap, activeFormat)
      };

      const w = parseFloat(manualWeight) || 20;
      const res = await addStampBoxToPallet(activePallet.id, stampData, w);

      setIsManualModal(false);
      Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
      triggerSuccessBanner(`✅ Đã lưu thùng #${res.box.box_index} (${stampData.stamp_line1})`);
      await loadActivePallet();
    } catch (err: any) {
      Alert.alert('Lỗi', err.message);
    }
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
      let targetPallet: Pallet;

      if (existing) {
        targetPallet = (await activateExistingPallet(existing.id)) || existing;
      } else {
        const qty = parseInt(newTargetQty, 10) || 30;
        targetPallet = await createNewPallet(cleanCode, qty);
      }

      setActivePallet(targetPallet);
      const boxList = await getBoxesByPallet(targetPallet.id);
      setBoxes(boxList);
      setIsNewPalletModal(false);
      setNewPalletCode('');
      Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
    } catch (e: any) {
      Alert.alert('Lỗi', e.message);
    }
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
            onPress={() => setIsNewPalletModal(true)}
            activeOpacity={0.8}
          >
            <Ionicons name="finger-print" size={16} color="#fbbf24" />
            <Text style={styles.palletBadgeLabel}>DẤU MỰC</Text>
            <Text style={styles.palletCodeText}>
              {activePallet ? `STT: ${activePallet.code}` : 'Chưa chọn Pallet'}
            </Text>
            <Ionicons name="chevron-down" size={14} color="#94a3b8" style={{ marginLeft: 2 }} />
          </TouchableOpacity>

          <View style={styles.topActionBtns}>
            <TouchableOpacity
              style={[styles.iconButton, torch && styles.iconButtonActive]}
              onPress={() => setTorch(!torch)}
            >
              <Ionicons name={torch ? 'flash' : 'flash-off'} size={18} color={torch ? '#fbbf24' : '#fff'} />
            </TouchableOpacity>

            <TouchableOpacity
              style={styles.iconButton}
              onPress={() => setIsManualModal(true)}
            >
              <Ionicons name="create-outline" size={18} color="#fff" />
            </TouchableOpacity>

            <TouchableOpacity
              style={styles.iconButton}
              onPress={onNavigateToPallets}
            >
              <Ionicons name="list" size={18} color="#fff" />
            </TouchableOpacity>
          </View>
        </View>

        {activePallet && (
          <View style={styles.progressContainer}>
            <View style={styles.progressHeader}>
              <Text style={styles.progressText}>
                Tiến độ: <Text style={styles.progressHighlight}>{boxes.length}</Text> / {activePallet.target_qty} thùng
              </Text>
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
        )}
      </View>

      {/* ── CAMERA VIEW & STAMP TARGET RETICLE ─────────────── */}
      <View style={styles.cameraWrapper}>
        <CameraView
          ref={cameraRef}
          style={StyleSheet.absoluteFill}
          facing="back"
          enableTorch={torch}
        />

        {/* Viewfinder Overlay chuyên dụng cho 2 dòng số con dấu */}
        <View style={styles.reticleContainer}>
          <View style={styles.reticleHeaderBox}>
            <Ionicons name="scan-outline" size={18} color="#fbbf24" />
            <Text style={styles.reticleGuideText}>Đặt 2 dòng dấu mực vào khung dưới</Text>
          </View>

          {/* Khung chữ nhật ngang theo tỉ lệ con dấu mực đóng */}
          <View style={[styles.stampTargetFrame, isScanning && styles.stampTargetFrameScanning]}>
            <View style={[styles.corner, styles.tl]} />
            <View style={[styles.corner, styles.tr]} />
            <View style={[styles.corner, styles.bl]} />
            <View style={[styles.corner, styles.br]} />

            {/* Đường chỉ dẫn 2 dòng số */}
            <View style={styles.lineGuideRow}>
              <Text style={styles.lineGuideTag}>Dòng 1</Text>
              <View style={styles.lineGuideDash} />
              <Text style={styles.lineGuideExample}>10102010204001 (14 số)</Text>
            </View>

            <View style={[styles.lineGuideRow, { marginTop: 16 }]}>
              <Text style={styles.lineGuideTag}>Dòng 2</Text>
              <View style={styles.lineGuideDash} />
              <Text style={styles.lineGuideExample}>1110926001471609 (16 số)</Text>
            </View>
          </View>

          <Text style={styles.reticleHintSub}>
            Chụp rõ nét · Giữ thẳng góc và đủ ánh sáng
          </Text>
        </View>

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

      {/* ── BOTTOM TRIGGER CONTROLS ───────────────────────── */}
      <View style={styles.bottomControls}>
        <View style={styles.triggerRow}>
          <TouchableOpacity
            style={styles.btnManualInput}
            onPress={() => setIsManualModal(true)}
          >
            <Ionicons name="keypad-outline" size={20} color="#94a3b8" />
            <Text style={styles.btnManualText}>Nhập Số</Text>
          </TouchableOpacity>

          <TouchableOpacity
            style={[styles.shutterBtn, isScanning && styles.shutterBtnDisabled]}
            onPress={handleCaptureAndRecognize}
            disabled={isScanning}
            activeOpacity={0.8}
          >
            <View style={styles.shutterInner}>
              <Ionicons name="camera" size={32} color="#0f172a" />
            </View>
          </TouchableOpacity>

          <TouchableOpacity
            style={styles.btnHistory}
            onPress={onNavigateToPallets}
          >
            <Ionicons name="file-tray-full-outline" size={20} color="#94a3b8" />
            <Text style={styles.btnManualText}>Pallet ({boxes.length})</Text>
          </TouchableOpacity>
        </View>
      </View>

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
                const dec = decodeStamp(pendingStamp.stamp_line1, pendingStamp.stamp_line2, dictMap);
                return (
                  <View style={{ backgroundColor: '#1e1b4b', padding: 12, borderRadius: 14, borderWidth: 1, borderColor: '#4338ca', marginBottom: 12 }}>
                    <Text style={{ color: '#a5b4fc', fontSize: 10, fontWeight: '800', letterSpacing: 0.5, marginBottom: 4 }}>
                      🔍 GIẢI MÃ TỨC THÌ (OFFLINE):
                    </Text>
                    {dec.product_name_full ? (
                      <Text style={{ color: '#f8fafc', fontSize: 13, fontWeight: '700', marginBottom: 3 }}>
                        {dec.product_name_full} {dec.package_spec_name ? `• ${dec.package_spec_name}` : ''}
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
                      <Ionicons name="save" size={16} color="#fff" />
                      <Text style={styles.btnConfirmSaveText}>Lưu Vào Pallet</Text>
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

            <Text style={styles.inputLabel}>Khối lượng (Kg):</Text>
            <TextInput
              style={styles.textInput}
              value={manualWeight}
              onChangeText={setManualWeight}
              placeholder="20"
              placeholderTextColor="#64748b"
              keyboardType="decimal-pad"
            />

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
    marginBottom: 4,
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
});
