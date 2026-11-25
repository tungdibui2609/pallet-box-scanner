import React, { useState, useEffect, useRef, useMemo } from 'react';
import {
  View, Text, StyleSheet, TouchableOpacity, ScrollView,
  Alert, Modal, TextInput, ActivityIndicator, Vibration, Animated, Platform, AppState, NativeModules, Image,
  KeyboardAvoidingView, TouchableWithoutFeedback, Keyboard
} from 'react-native';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { CameraView, useCameraPermissions } from 'expo-camera';
import * as ImageManipulator from 'expo-image-manipulator';
import * as ImagePicker from 'expo-image-picker';
import TextRecognition from '@react-native-ml-kit/text-recognition';
import * as Haptics from 'expo-haptics';
import { Ionicons } from '@expo/vector-icons';
import { useTheme } from '../contexts/ThemeContext';

import { Pallet, BoxLabel, ParsedStampData, StampFormat } from '../types';
import {
  getActivePallet, createNewPallet, completePallet,
  getBoxesByPallet, addStampBoxToPallet, deleteBox,
  getPalletByCode, activateExistingPallet, getStampDictionariesMap,
  getActiveStampFormat, cloneBoxToPallet, addStampBoxesBulkToPallet,
  updatePalletTagAndNotes, resetPalletBoxes, getDb
} from '../services/database';
import { parseStampText, decodeStamp } from '../services/stampParser';
import { syncStampDictionariesFromSupabase, getSupabaseClient } from '../services/supabase';
import {
  submitStampPhotoToQueue,
  fetchRecentStampQueue,
  StampQueueItemMobile,
  uploadMobileStampImageToGoogleDrive,
  enqueueStampPhotoForBackgroundSync,
  processBackgroundStampQueue,
} from '../services/stampQueueService';
import {
  getDefaultTargetBoxQty,
  getAutoCompletePalletOnFull,
  setAutoCompletePalletOnFull,
} from '../services/appSettings';

let VolumeManager: any = null;
if (NativeModules && NativeModules.VolumeManager) {
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    VolumeManager = require('react-native-volume-manager').VolumeManager;
  } catch (err) {
    console.warn('VolumeManager not linked:', err);
  }
}

export default function StampScannerScreen({ onNavigateToPallets }: { onNavigateToPallets: () => void }) {
  const { isDark } = useTheme();
  const styles = useMemo(() => getStampStyles(isDark), [isDark]);
  const [permission, requestPermission] = useCameraPermissions();
  const cameraRef = useRef<any>(null);
  const cameraBoxSizeRef = useRef<{ width: number; height: number }>({ width: 340, height: 220 });

  const [activePallet, setActivePallet] = useState<Pallet | null>(null);
  const [boxes, setBoxes] = useState<BoxLabel[]>([]);
  const [isScanning, setIsScanning] = useState(false);
  const [torch, setTorch] = useState(false);
  const [cameraEnabled, setCameraEnabled] = useState(true);
  const [isAppActive, setIsAppActive] = useState(AppState.currentState === 'active');

  useEffect(() => {
    // Tự động kiểm tra và đẩy hàng đợi ảnh ngầm khi vào màn hình
    processBackgroundStampQueue().catch(() => {});

    const sub = AppState.addEventListener('change', (nextState) => {
      const active = nextState === 'active';
      setIsAppActive(active);
      if (active) {
        processBackgroundStampQueue().catch(() => {});
      } else {
        setTorch(false);
      }
    });
    return () => sub.remove();
  }, []);

  const [isKeyboardVisible, setKeyboardVisible] = useState(false);
  useEffect(() => {
    const showSub = Keyboard.addListener(
      Platform.OS === 'android' ? 'keyboardDidShow' : 'keyboardWillShow',
      () => setKeyboardVisible(true)
    );
    const hideSub = Keyboard.addListener(
      Platform.OS === 'android' ? 'keyboardDidHide' : 'keyboardWillHide',
      () => setKeyboardVisible(false)
    );
    return () => {
      showSub.remove();
      hideSub.remove();
    };
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
  const [defaultTargetQty, setDefaultTargetQty] = useState(30);
  const [newTargetQty, setNewTargetQty] = useState('30');
  const [autoCompleteOnFull, setAutoCompleteOnFull] = useState(true);

  useEffect(() => {
    void (async () => {
      const [def, autoChot] = await Promise.all([
        getDefaultTargetBoxQty(),
        getAutoCompletePalletOnFull()
      ]);
      setDefaultTargetQty(def);
      setNewTargetQty(String(def));
      setAutoCompleteOnFull(autoChot);
    })();
  }, []);

  const openNewPalletModal = async (palletToEdit?: Pallet | null) => {
    const targetPallet = palletToEdit !== undefined ? palletToEdit : activePallet;
    const [def, autoChot] = await Promise.all([
      getDefaultTargetBoxQty(),
      getAutoCompletePalletOnFull()
    ]);
    setDefaultTargetQty(def);
    setAutoCompleteOnFull(autoChot);
    setNewPalletCode(targetPallet?.code || '');
    setNewPalletTag(targetPallet?.tag || '');
    setNewPalletNotes(targetPallet?.notes || '');
    setNewTargetQty(String(targetPallet?.target_qty || def));
    setIsNewPalletModal(true);
  };

  const handleToggleAutoComplete = async () => {
    const next = !autoCompleteOnFull;
    setAutoCompleteOnFull(next);
    await setAutoCompletePalletOnFull(next);
  };

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

  // Gửi ảnh lên Web Mẹ (Google Drive + Gemini AI)
  const [isCapturingForWeb, setIsCapturingForWeb] = useState(false);
  const [isSendToWebModal, setIsSendToWebModal] = useState(false);
  const [sendPhotoUri, setSendPhotoUri] = useState<string | null>(null);
  const [sendPhotoCropUri, setSendPhotoCropUri] = useState<string | null>(null);
  const [sendBoxCount, setSendBoxCount] = useState('30');
  const [sendBoxWeight, setSendBoxWeight] = useState('20');
  const [isSendingToWeb, setIsSendingToWeb] = useState(false);

  // Lịch sử gửi dấu lên Web Mẹ
  const [isQueueHistoryModal, setIsQueueHistoryModal] = useState(false);
  const [queueHistory, setQueueHistory] = useState<StampQueueItemMobile[]>([]);
  const [isLoadingQueueHistory, setIsLoadingQueueHistory] = useState(false);

  // ── Lắng nghe Realtime Web Mẹ duyệt Pallet con dấu ───────────
  useEffect(() => {
    let channel: any = null;
    let isMounted = true;

    async function setupQueueRealtime() {
      try {
        const client = await getSupabaseClient();
        const storedSys = await AsyncStorage.getItem('config_system_code');
        const systemCode = storedSys || 'KHO_DONG_LANH';

        channel = client
          .channel('stamp_queue_mobile_realtime')
          .on(
            'postgres_changes',
            {
              event: 'UPDATE',
              schema: 'public',
              table: 'stamp_scan_queue',
              filter: `system_code=eq.${systemCode}`,
            },
            (payload: any) => {
              if (!isMounted) return;
              const updated = payload?.new;
              if (updated && updated.status === 'approved') {
                try {
                  Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
                  Vibration.vibrate([0, 200, 100, 200]);
                } catch {}
                triggerSuccessBanner(`🎉 Server đã duyệt Pallet STT ${updated.pallet_stt} (${updated.box_count} thùng)!`);
                Alert.alert(
                  '🎉 Server Đã Duyệt Pallet!',
                  `Pallet STT ${updated.pallet_stt} (${updated.box_count} thùng) đã được văn phòng duyệt tạo thành công và lưu ảnh trên Server!`,
                  [{ text: 'Đã hiểu', style: 'default' }]
                );
              }
            }
          )
          .subscribe();
      } catch (err) {
        console.warn('[RealtimeQueue] Lỗi đăng ký realtime:', err);
      }
    }

    setupQueueRealtime();
    return () => {
      isMounted = false;
      if (channel) {
        channel.unsubscribe();
      }
    };
  }, []);

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
          { text: 'Nhập STT Pallet', onPress: () => openNewPalletModal() }
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

      // Crop chính xác vùng khung ngắm hiển thị (loại bỏ chữ/số từ các thùng bên trên & dưới)
      let recognizeUri = photo.uri;
      try {
        const imgW = photo.width || 0;
        const imgH = photo.height || 0;
        const { width: boxW, height: boxH } = cameraBoxSizeRef.current;
        if (imgW > 100 && imgH > 100 && boxW > 0 && boxH > 0) {
          const scale = Math.max(boxW / imgW, boxH / imgH);
          const visW = boxW / scale;
          const visH = boxH / scale;
          const visX = Math.max(0, (imgW - visW) / 2);
          const visY = Math.max(0, (imgH - visH) / 2);

          // Khung ngắm chiếm ~92% ngang, 50% dọc của hộp camera -> lấy rộng an toàn 98% ngang, 74% dọc ở giữa
          const cropW = Math.min(imgW, Math.round(visW * 0.98));
          const cropH = Math.min(imgH, Math.round(visH * 0.74));
          const originX = Math.max(0, Math.min(imgW - cropW, Math.round(visX + (visW - cropW) / 2)));
          const originY = Math.max(0, Math.min(imgH - cropH, Math.round(visY + (visH - cropH) / 2)));

          if (cropW > 50 && cropH > 50) {
            const cropped = await ImageManipulator.manipulateAsync(
              photo.uri,
              [{ crop: { originX, originY, width: cropW, height: cropH } }],
              { compress: 0.92, format: ImageManipulator.SaveFormat.JPEG }
            );
            if (cropped?.uri) {
              recognizeUri = cropped.uri;
            }
          }
        }
      } catch (cropErr) {
        console.warn('Crop ảnh khung ngắm fallback về ảnh gốc:', cropErr);
      }

      // OCR qua Google ML Kit (Native) kèm fallback thông minh khi chạy trên Expo Go
      let raw = '';
      let isMlKitLinked = false;

      try {
        if (TextRecognition && typeof TextRecognition.recognize === 'function') {
          const mlResult = await TextRecognition.recognize(recognizeUri);
          raw = mlResult?.text || '';
          isMlKitLinked = true;
        }
      } catch (mlErr: any) {
        console.warn('[ML Kit] Module native chưa được link (đang chạy trong Expo Go):', mlErr?.message);
        isMlKitLinked = false;
      }

      // Nếu đang chạy trong Expo Go (ML Kit native bị chặn): Tự động fallback sang Server OCR hoặc gợi ý gửi Server
      if (!isMlKitLinked) {
        try {
          const base64Crop = await ImageManipulator.manipulateAsync(
            recognizeUri,
            [{ resize: { width: 1200 } }],
            { compress: 0.85, format: ImageManipulator.SaveFormat.JPEG, base64: true }
          );
          if (base64Crop.base64) {
            const serverUrl = 'https://api.chanhthu.click/api/ocr';
            const res = await fetch(serverUrl, {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ image: `data:image/jpeg;base64,${base64Crop.base64}`, mode: 'stamp' })
            });
            if (res.ok) {
              const resJson = await res.json();
              if (resJson?.rawText) {
                raw = resJson.rawText;
              } else if (resJson?.data?.stamp_line1 || resJson?.data?.stamp_line2) {
                Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
                Vibration.vibrate(80);
                setPendingStamp({
                  stamp_line1: resJson.data.stamp_line1 || '',
                  stamp_line2: resJson.data.stamp_line2 || '',
                  raw_text: resJson.rawText || '',
                  detected_lines: [],
                  decoded: resJson.data.decoded,
                  photoUri: recognizeUri || photo.uri,
                });
                setPendingWeight('20');
                const fillCount = activePallet
                  ? Math.max(1, activePallet.target_qty - boxes.length)
                  : 30;
                setPendingCount(String(fillCount));
                return;
              }
            }
          }
        } catch (serverOcrErr) {
          console.warn('[Server OCR Fallback] Lỗi gọi server OCR khi test Expo Go:', serverOcrErr);
        }

        if (!raw.trim()) {
          Alert.alert(
            'Lưu ý Expo Go',
            'Thư viện nhận diện ML Kit Native chỉ chạy trên ứng dụng cài từ file APK (không hỗ trợ Expo Go).\n\nBạn có muốn chuyển ảnh này sang mục "Gửi Server" để giải mã không?',
            [
              { text: 'Huỷ', style: 'cancel' },
              {
                text: 'Gửi Server giải mã',
                onPress: () => {
                  setSendPhotoUri(photo.uri);
                  setSendPhotoCropUri(recognizeUri);
                  setSendBoxCount('1');
                  setSendBoxWeight('20');
                  setIsSendToWebModal(true);
                }
              }
            ]
          );
          return;
        }
      }

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
          setPendingStamp({
            ...parsed,
            photoUri: recognizeUri || photo.uri,
          });
          setPendingWeight('20');
          const fillCount = activePallet
            ? Math.max(1, activePallet.target_qty - boxes.length)
            : 30;
          setPendingCount(String(fillCount));
        } else {
          Haptics.notificationAsync(Haptics.NotificationFeedbackType.Warning);
          Alert.alert(
            'Chưa nhận diện đủ dãy số',
            `Văn bản đọc được:\n"${raw.slice(0, 100)}"\n\nVui lòng giữ chắc tay và chụp vuông góc với 2 dòng số đóng dấu.`
          );
        }
    } catch (err: any) {
      Alert.alert('Lỗi quét', err.message || 'Không thể chụp ảnh');
    } finally {
      setIsScanning(false);
    }
  }

  // ── Tải ảnh con dấu từ thư viện & Căn chỉnh crop tâm ─────────────
  async function handlePickStampImage() {
    if (!activePallet) {
      Alert.alert(
        'Chưa có Pallet',
        'Vui lòng nhập Số Thứ Tự (STT) Pallet trước khi tải ảnh con dấu!',
        [
          { text: 'Huỷ', style: 'cancel' },
          { text: 'Nhập STT Pallet', onPress: () => openNewPalletModal() }
        ]
      );
      return;
    }

    try {
      const perm = await ImagePicker.requestMediaLibraryPermissionsAsync();
      if (!perm.granted) {
        Alert.alert('Cần quyền truy cập', 'Vui lòng cấp quyền truy cập thư viện ảnh để tải ảnh con dấu.');
        return;
      }

      // Mở trình chọn ảnh kèm crop native cho phép zoom và căn chỉnh tâm
      const result = await ImagePicker.launchImageLibraryAsync({
        mediaTypes: ['images'],
        allowsEditing: true, // Bật trình cắt crop của Android/iOS
        aspect: [16, 9], // Tỉ lệ tiêu chuẩn khung ngắm con dấu
        quality: 0.95,
      });

      if (result.canceled || !result.assets || result.assets.length === 0) {
        return;
      }

      const pickedPhoto = result.assets[0];
      if (!pickedPhoto.uri) return;

      setIsScanning(true);
      Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);

      let raw = '';
      let isMlKitLinked = false;

      try {
        if (TextRecognition && typeof TextRecognition.recognize === 'function') {
          const mlResult = await TextRecognition.recognize(pickedPhoto.uri);
          raw = mlResult?.text || '';
          isMlKitLinked = true;
        }
      } catch (mlErr: any) {
        console.warn('[ML Kit] Module native chưa link (Expo Go):', mlErr?.message);
        isMlKitLinked = false;
      }

      if (!isMlKitLinked) {
        try {
          const base64Crop = await ImageManipulator.manipulateAsync(
            pickedPhoto.uri,
            [{ resize: { width: 1200 } }],
            { compress: 0.85, format: ImageManipulator.SaveFormat.JPEG, base64: true }
          );
          if (base64Crop.base64) {
            const serverUrl = 'https://api.chanhthu.click/api/ocr';
            const res = await fetch(serverUrl, {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ image: `data:image/jpeg;base64,${base64Crop.base64}`, mode: 'stamp' })
            });
            if (res.ok) {
              const resJson = await res.json();
              if (resJson?.rawText) {
                raw = resJson.rawText;
              } else if (resJson?.data?.stamp_line1 || resJson?.data?.stamp_line2) {
                Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
                Vibration.vibrate(80);
                setPendingStamp({
                  stamp_line1: resJson.data.stamp_line1 || '',
                  stamp_line2: resJson.data.stamp_line2 || '',
                  raw_text: resJson.rawText || '',
                  detected_lines: [],
                  decoded: resJson.data.decoded,
                  photoUri: pickedPhoto.uri,
                });
                setPendingWeight('20');
                const fillCount = activePallet
                  ? Math.max(1, activePallet.target_qty - boxes.length)
                  : 30;
                setPendingCount(String(fillCount));
                return;
              }
            }
          }
        } catch (serverOcrErr) {
          console.warn('[Server OCR Fallback] Lỗi khi nhận diện ảnh upload:', serverOcrErr);
        }
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

      const parsed = raw.trim() ? parseStampText(raw, currentDict, currentFmt) : null;
      if (parsed && (parsed.stamp_line1 || parsed.stamp_line2)) {
        Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
        Vibration.vibrate(80);
        setPendingStamp({
          ...parsed,
          photoUri: pickedPhoto.uri,
        });
        setPendingWeight('20');
        const fillCount = activePallet
          ? Math.max(1, activePallet.target_qty - boxes.length)
          : 30;
        setPendingCount(String(fillCount));
      } else {
        Haptics.notificationAsync(Haptics.NotificationFeedbackType.Warning);
        Alert.alert(
          'Chưa nhận diện rõ dãy số con dấu',
          'Ảnh đã chọn và cắt nhưng phần chữ số bị mờ hoặc không đủ ký tự.\n\nBạn có muốn chuyển ảnh này sang mục "Gửi giải mã" để Server phân tích không?',
          [
            { text: 'Hủy', style: 'cancel' },
            {
              text: 'Gửi Giải Mã',
              onPress: () => {
                setSendPhotoUri(pickedPhoto.uri);
                setSendPhotoCropUri(pickedPhoto.uri);
                setSendBoxCount('1');
                setSendBoxWeight('20');
                setIsSendToWebModal(true);
              }
            }
          ]
        );
      }
    } catch (err: any) {
      Alert.alert('Lỗi tải ảnh', err.message || 'Không thể chọn ảnh từ thư viện');
    } finally {
      setIsScanning(false);
    }
  }

  // ── Xác nhận lưu thùng vào Pallet (Thao tác tức thời 0ms delay) ──
  async function handleConfirmSaveStampBox() {
    if (!pendingStamp || !activePallet) return;

    setIsSaving(true);
    try {
      const stampDataToSave: ParsedStampData = { ...pendingStamp };
      const w = parseFloat(pendingWeight) || 20;
      const count = parseInt(pendingCount, 10) || 1;

      let createdBoxIds: string[] = [];

      // 1. Lưu thùng vào CSDL nội bộ SQLite ngay tức thì (dưới 20ms)
      if (count > 1) {
        const res = await addStampBoxesBulkToPallet(activePallet.id, stampDataToSave, w, count);
        createdBoxIds = res.newBoxes.map(b => b.id);
        Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
        triggerSuccessBanner(`✅ Đã nhân bản ${res.addedCount} thùng con dấu vào Pallet ${activePallet.code}!`);
      } else {
        const res = await addStampBoxToPallet(activePallet.id, stampDataToSave, w);
        createdBoxIds = [res.box.id];
        Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
        triggerSuccessBanner(`✅ Đã lưu thùng #${res.box.box_index} (Dòng 1: ${stampDataToSave.stamp_line1})`);
      }

      // 2. Thu dọn form & reset trạng thái ngay lập tức để nhân viên tiếp tục quét thùng tiếp theo
      const capturedPhotoUri = pendingStamp.photoUri;
      const palletCode = activePallet.code;
      const palletId = activePallet.id;
      const targetQty = activePallet.target_qty;
      setPendingStamp(null);
      const remainingCount = activePallet
        ? Math.max(1, activePallet.target_qty - (boxes.length + count))
        : 30;
      setPendingCount(String(remainingCount));
      
      const newTotalBoxes = boxes.length + count;
      const isAutoClosed = await triggerAutoCompleteIfFull(palletId, palletCode, newTotalBoxes, targetQty);
      if (!isAutoClosed) {
        await loadActivePallet();
      }

      // 3. Tải ảnh lên Google Drive CON_DAU chạy HOÀN TOÀN TRONG NỀN (không chặn màn hình)
      if (capturedPhotoUri && createdBoxIds.length > 0) {
        uploadMobileStampImageToGoogleDrive(capturedPhotoUri, palletCode)
          .then(async upRes => {
            const remoteUrl = upRes.viewUrl || upRes.imageUrl || null;
            if (upRes.success && (upRes.fileId || remoteUrl)) {
              const db = await getDb();
              for (const bxId of createdBoxIds) {
                await db.runAsync(
                  `UPDATE boxes SET drive_file_id = ?, drive_view_url = ?, stamp_image_url = ? WHERE id = ?`,
                  [upRes.fileId || null, remoteUrl, remoteUrl, bxId]
                );
              }
              // Cập nhật cả các thùng vừa được nhân bản (clone) từ cùng tấm ảnh local này trên Pallet
              await db.runAsync(
                `UPDATE boxes SET drive_file_id = ?, drive_view_url = ?, stamp_image_url = ? WHERE pallet_id = ? AND stamp_image_url = ?`,
                [upRes.fileId || null, remoteUrl, remoteUrl, palletId, capturedPhotoUri]
              );
            }
          })
          .catch(e => console.warn('[StampScanner] Tải ảnh lên Google Drive ngầm:', e));
      }
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
        triggerSuccessBanner(`✅ Đã tạo & nhân bản ${res.addedCount} thùng vào Pallet ${activePallet.code}!`);
      } else {
        const res = await addStampBoxToPallet(activePallet.id, stampData, w);
        setIsManualModal(false);
        setManualCount('1');
        Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
        triggerSuccessBanner(`✅ Đã lưu thùng #${res.box.box_index} (${stampData.stamp_line1})`);
      }

      const palletCode = activePallet.code;
      const palletId = activePallet.id;
      const targetQty = activePallet.target_qty;
      const newTotalBoxes = boxes.length + count;
      const isAutoClosed = await triggerAutoCompleteIfFull(palletId, palletCode, newTotalBoxes, targetQty);
      if (!isAutoClosed) {
        await loadActivePallet();
      }
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
      setCloneModalVisible(false);
      Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
      triggerSuccessBanner(`✅ Đã nhân bản ${res.addedCount} thùng vào Pallet ${activePallet.code}!`);

      const palletCode = activePallet.code;
      const palletId = activePallet.id;
      const targetQty = activePallet.target_qty;
      const newTotalBoxes = boxes.length + qty;
      const isAutoClosed = await triggerAutoCompleteIfFull(palletId, palletCode, newTotalBoxes, targetQty);
      if (!isAutoClosed) {
        await loadActivePallet();
      }
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

  // ── Gửi ảnh con dấu lên Web Mẹ (Google Drive + Gemini AI) ─
  async function handleOpenSendToWeb() {
    if (!activePallet) {
      Alert.alert(
        'Chưa có Pallet',
        'Vui lòng chọn hoặc nhập Số Thứ Tự (STT) Pallet trước khi chụp gửi giải mã!',
        [
          { text: 'Huỷ', style: 'cancel' },
          { text: 'Nhập STT', onPress: () => openNewPalletModal() }
        ]
      );
      return;
    }

    if (!cameraEnabled) {
      setCameraEnabled(true);
    }

    if (!cameraRef.current) {
      Alert.alert('Camera chưa sẵn sàng', 'Vui lòng căn chỉnh lại camera trước khi gửi.');
      return;
    }

    try {
      setIsCapturingForWeb(true);
      Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);

      const photo = await cameraRef.current.takePictureAsync({
        quality: 0.9,
        skipProcessing: false,
      });

      if (!photo?.uri) {
        throw new Error('Không chụp được ảnh từ camera');
      }

      // Tự động tạo bản crop theo đúng khung ngắm để AI đọc siêu nhanh (~0.5s) và không dính watermark
      let cropUri: string | null = null;
      try {
        const imgW = photo.width || 0;
        const imgH = photo.height || 0;
        const { width: boxW, height: boxH } = cameraBoxSizeRef.current;
        if (imgW > 100 && imgH > 100 && boxW > 0 && boxH > 0) {
          const scale = Math.max(boxW / imgW, boxH / imgH);
          const visW = boxW / scale;
          const visH = boxH / scale;
          const visX = Math.max(0, (imgW - visW) / 2);
          const visY = Math.max(0, (imgH - visH) / 2);

          const cropW = Math.min(imgW, Math.round(visW * 0.98));
          const cropH = Math.min(imgH, Math.round(visH * 0.74));
          const originX = Math.max(0, Math.min(imgW - cropW, Math.round(visX + (visW - cropW) / 2)));
          const originY = Math.max(0, Math.min(imgH - cropH, Math.round(visY + (visH - cropH) / 2)));

          if (cropW > 50 && cropH > 50) {
            const cropped = await ImageManipulator.manipulateAsync(
              photo.uri,
              [{ crop: { originX, originY, width: cropW, height: cropH } }],
              { compress: 0.88, format: ImageManipulator.SaveFormat.JPEG }
            );
            if (cropped?.uri) {
              cropUri = cropped.uri;
            }
          }
        }
      } catch (cropErr) {
        console.warn('Lỗi tạo crop ảnh con dấu:', cropErr);
      }

      setSendPhotoUri(photo.uri);
      setSendPhotoCropUri(cropUri);
      setSendBoxCount('1');
      setSendBoxWeight('20');
      setIsSendToWebModal(true);
      Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
    } catch (err: any) {
      Alert.alert('Lỗi chụp ảnh', err?.message || 'Không thể chụp ảnh để gửi');
    } finally {
      setIsCapturingForWeb(false);
    }
  }

  async function flushPalletAiQueueBatches(
    palletId: string,
    palletCode: string,
    palletTag?: string | null,
    palletNotes?: string | null
  ): Promise<{ aiBoxCount: number; normalBoxCount: number }> {
    try {
      const db = await getDb();
      const allBoxes = await db.getAllAsync<BoxLabel>(
        `SELECT * FROM boxes WHERE pallet_id = ? ORDER BY CAST(box_index AS INTEGER) ASC`,
        [palletId]
      );
      const aiBoxes = allBoxes.filter(b => b.stamp_line1 === 'CHỜ GIẢI MÃ AI');
      const normalBoxes = allBoxes.filter(b => b.stamp_line1 !== 'CHỜ GIẢI MÃ AI');

      if (aiBoxes.length > 0) {
        const grouped = new Map<string, BoxLabel[]>();
        aiBoxes.forEach(b => {
          const bId = b.stamp_line2 || 'default';
          if (!grouped.has(bId)) grouped.set(bId, []);
          grouped.get(bId)!.push(b);
        });

        for (const [, batchList] of grouped.entries()) {
          let photoUri = batchList[0]?.stamp_image_url || '';
          let cropUri: string | null = null;
          try {
            if (batchList[0]?.raw_text) {
              const parsed = JSON.parse(batchList[0].raw_text);
              if (parsed.photo_uri) photoUri = parsed.photo_uri;
              if (parsed.crop_uri) cropUri = parsed.crop_uri;
            }
          } catch {}

          if (photoUri) {
            await enqueueStampPhotoForBackgroundSync({
              photoUri,
              cropPhotoUri: cropUri,
              palletStt: palletCode,
              palletTag: palletTag || null,
              palletNotes: palletNotes || null,
              boxCount: batchList.length,
              boxWeight: batchList[0]?.weight || 20,
            });
          }
        }

        // Xóa các thùng tạm AI khỏi SQLite sau khi đã chuyển sang hàng đợi giải mã AI
        await db.runAsync(
          `DELETE FROM boxes WHERE pallet_id = ? AND stamp_line1 = 'CHỜ GIẢI MÃ AI'`,
          [palletId]
        );

        if (normalBoxes.length === 0) {
          // Toàn bộ Pallet là ảnh chờ giải mã AI -> xóa bản ghi pallet tạm khỏi SQLite Chờ đẩy
          await db.runAsync(`DELETE FROM pallets WHERE id = ?`, [palletId]);
        } else {
          const now = new Date().toISOString();
          await db.runAsync(
            `UPDATE pallets SET 
               scanned_qty = (SELECT COUNT(*) FROM boxes WHERE pallet_id = ?),
               total_weight = (SELECT COALESCE(SUM(weight), 0) FROM boxes WHERE pallet_id = ?),
               updated_at = ?
             WHERE id = ?`,
            [palletId, palletId, now, palletId]
          );
        }
      }

      return { aiBoxCount: aiBoxes.length, normalBoxCount: normalBoxes.length };
    } catch (e) {
      console.warn('[StampScanner] Lỗi chuyển đợt ảnh AI sang hàng đợi:', e);
      return { aiBoxCount: 0, normalBoxCount: 1 };
    }
  }

  async function handleConfirmSendToWeb() {
    if (!sendPhotoUri || !activePallet) return;

    const count = parseInt(sendBoxCount, 10);
    if (!count || count <= 0) {
      Alert.alert('Lỗi', 'Số lượng thùng phải lớn hơn 0');
      return;
    }

    const weight = parseFloat(sendBoxWeight);
    if (isNaN(weight) || weight <= 0) {
      Alert.alert('Lỗi', 'Khối lượng thùng không hợp lệ');
      return;
    }

    const targetPallet = activePallet;
    const targetPalletCode = activePallet.code;
    const targetPhotoUri = sendPhotoUri;
    const targetCropUri = sendPhotoCropUri;

    setIsSendToWebModal(false);
    setSendPhotoUri(null);
    setSendPhotoCropUri(null);

    try {
      const batchId = 'aibatch_' + Date.now() + '_' + Math.random().toString(36).substring(2, 6);
      const batchMetaJson = JSON.stringify({
        is_ai_queue: true,
        batch_id: batchId,
        photo_uri: targetPhotoUri,
        crop_uri: targetCropUri,
      });

      const stampData: ParsedStampData = {
        stamp_line1: 'CHỜ GIẢI MÃ AI',
        stamp_line2: batchId,
        raw_text: batchMetaJson,
        detected_lines: [],
        drive_view_url: targetCropUri || targetPhotoUri,
      };

      const res = await addStampBoxesBulkToPallet(targetPallet.id, stampData, weight, count);
      Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
      Vibration.vibrate(70);

      const newTotalBoxes = boxes.length + res.addedCount;
      const targetQty = targetPallet.target_qty || defaultTargetQty || 30;

      if (newTotalBoxes < targetQty) {
        triggerSuccessBanner(
          `✅ Đã lưu ${res.addedCount} thùng vào Pallet ${targetPalletCode} (${newTotalBoxes}/${targetQty} thùng). Đủ ${targetQty} thùng sẽ gửi giải mã!`
        );
      }

      const isAutoClosed = await triggerAutoCompleteIfFull(
        targetPallet.id,
        targetPalletCode,
        newTotalBoxes,
        targetQty
      );
      if (!isAutoClosed) {
        await loadActivePallet();
      }
    } catch (err: any) {
      Alert.alert('Lỗi lưu thùng vào Pallet', err?.message || 'Không thể lưu thùng');
    }
  }

  async function handleOpenQueueHistory() {
    setIsQueueHistoryModal(true);
    setIsLoadingQueueHistory(true);
    try {
      const list = await fetchRecentStampQueue();
      setQueueHistory(list);
    } catch (err: any) {
      Alert.alert('Lỗi', 'Không thể tải lịch sử gửi: ' + err.message);
    } finally {
      setIsLoadingQueueHistory(false);
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

      const qty = parseInt(newTargetQty, 10) || defaultTargetQty;
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

  async function triggerAutoCompleteIfFull(palletId: string, palletCode: string, totalBoxesCount: number, targetQty: number) {
    if (autoCompleteOnFull && totalBoxesCount >= targetQty) {
      try {
        const palletTag = activePallet?.tag || null;
        const palletNotes = activePallet?.notes || null;
        const flushRes = await flushPalletAiQueueBatches(palletId, palletCode, palletTag, palletNotes);
        await completePallet(palletId);
        setActivePallet(null);
        setBoxes([]);
        Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
        triggerSuccessBanner(
          flushRes.aiBoxCount > 0
            ? `🎉 Pallet ${palletCode} đã đủ ${totalBoxesCount}/${targetQty} thùng! Đã tự động chốt & gửi lên Server giải mã!`
            : `🎉 Pallet ${palletCode} đã đủ ${totalBoxesCount}/${targetQty} thùng và được TỰ ĐỘNG CHỐT!`
        );
        Alert.alert(
          '🎉 TỰ ĐỘNG CHỐT PALLET THÀNH CÔNG',
          flushRes.aiBoxCount > 0
            ? `Pallet ${palletCode} đã đạt đủ chỉ tiêu ${totalBoxesCount}/${targetQty} thùng. Hệ thống đã TỰ ĐỘNG CHỐT và gửi các đợt ảnh con dấu lên Server giải mã!\n\nBạn có thể chọn hoặc nhập STT Pallet mới để tiếp tục.`
            : `Pallet ${palletCode} đã đạt đủ chỉ tiêu ${totalBoxesCount}/${targetQty} thùng và đã được hệ thống TỰ ĐỘNG CHỐT thành công!\n\nBạn có thể chọn hoặc nhập STT Pallet mới để tiếp tục.`,
          [
            { text: 'Nhập STT Pallet Mới', onPress: () => openNewPalletModal(null) },
            { text: 'Đóng', style: 'cancel' }
          ]
        );
        return true;
      } catch (err: any) {
        console.warn('Lỗi tự động chốt pallet:', err);
      }
    }
    return false;
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
            const palletId = activePallet.id;
            const palletCode = activePallet.code;
            const palletTag = activePallet.tag || null;
            const palletNotes = activePallet.notes || null;
            const flushRes = await flushPalletAiQueueBatches(palletId, palletCode, palletTag, palletNotes);
            await completePallet(palletId);
            setActivePallet(null);
            setBoxes([]);
            Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
            Alert.alert(
              'Đã chốt Pallet',
              flushRes.aiBoxCount > 0
                ? `Pallet ${palletCode} đã hoàn thành và gửi ${flushRes.aiBoxCount} thùng ảnh con dấu lên Server giải mã!`
                : `Pallet ${palletCode} đã hoàn thành!`
            );
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
            onPress={() => openNewPalletModal(activePallet)}
            activeOpacity={0.8}
          >
            <Ionicons name="finger-print" size={16} color={isDark ? "#fbbf24" : "#059669"} />
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
            <Ionicons name="chevron-down" size={14} color={isDark ? "#94a3b8" : "#059669"} style={{ marginLeft: 2 }} />
          </TouchableOpacity>

          <View style={styles.topActionBtns}>
            <TouchableOpacity
              style={[styles.iconButton, { borderColor: isDark ? '#818cf855' : '#bbf7d0', borderWidth: 1 }]}
              onPress={handleOpenQueueHistory}
            >
              <Ionicons name="time-outline" size={18} color={isDark ? "#a5b4fc" : "#059669"} />
            </TouchableOpacity>

            <TouchableOpacity
              style={[styles.iconButton, { borderColor: isDark ? '#10b98155' : '#86efac', borderWidth: 1 }]}
              onPress={handleSyncStampRules}
              disabled={syncingRules}
            >
              {syncingRules ? (
                <ActivityIndicator size="small" color={isDark ? "#34d399" : "#059669"} />
              ) : (
                <Ionicons name="cloud-download-outline" size={18} color={isDark ? "#34d399" : "#059669"} />
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
            <Ionicons name="information-circle-outline" size={16} color={isDark ? "#38bdf8" : "#059669"} />
            <Text style={styles.noPalletTipText}>Bạn chưa chọn Pallet. Hãy bấm chọn Pallet để bắt đầu.</Text>
          </View>
        )}
      </View>

      {/* ── HARDWARE VOLUME KEY HINT & TORCH ─────────────── */}
      <View style={styles.volumeBar}>
        <View style={styles.volumeKeyHintBadge}>
          <Ionicons name="volume-low" size={15} color={isDark ? "#38bdf8" : "#047857"} />
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
            color={torch && isCameraRunning ? '#facc15' : (isDark ? '#94a3b8' : '#059669')}
          />
        </TouchableOpacity>
      </View>

      {/* ── CAMERA BOX (GỌN GIỐNG QUÉT TEM) ──────────────── */}
      <View
        style={styles.compactCameraBox}
        onLayout={e => {
          const { width, height } = e.nativeEvent.layout;
          if (width > 0 && height > 0) {
            cameraBoxSizeRef.current = { width, height };
          }
        }}
      >
        {!activePallet ? (
          <View style={styles.noPalletOverlay}>
            <Ionicons name="cube-outline" size={36} color={isDark ? "#38bdf8" : "#059669"} />
            <Text style={styles.noPalletOverlayTitle}>Chưa chọn Pallet</Text>
            <Text style={styles.noPalletOverlaySub}>
              Để tránh quét nhầm hàng, vui lòng chọn hoặc nhập số Pallet trước.
            </Text>
            <TouchableOpacity
              style={styles.selectPalletOverlayBtn}
              onPress={() => openNewPalletModal()}
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
            <View style={styles.cameraPausedIconCircle}>
              <Ionicons name="videocam-off-outline" size={34} color={isDark ? "#94a3b8" : "#059669"} />
            </View>
            <Text style={styles.cameraPausedTitle}>Camera đang tắt</Text>
            <Text style={styles.cameraPausedSub}>
              Tạm tắt để tiết kiệm pin. Bạn vẫn có thể Nhập Số bên dưới.
            </Text>
            <TouchableOpacity
              style={styles.cameraEnableBtn}
              onPress={toggleCamera}
              activeOpacity={0.85}
            >
              <Ionicons name="videocam" size={16} color={isDark ? "#0f172a" : "#ffffff"} />
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
            <ActivityIndicator size="large" color={isDark ? "#fbbf24" : "#059669"} />
            <Text style={styles.scanningText}>Đang đọc dãy số con dấu...</Text>
          </View>
        )}
      </View>

      {/* ── ACTION BUTTONS ────────────────────────────────── */}
      <View style={styles.actionRow}>
        <TouchableOpacity
          style={[styles.captureActionBtn, (!activePallet || isScanning) && { opacity: 0.6 }]}
          disabled={isScanning || isCapturingForWeb}
          onPress={handleCaptureAndRecognize}
        >
          {isScanning ? (
            <>
              <ActivityIndicator color="#ffffff" size="small" />
              <Text numberOfLines={1} style={styles.captureActionText}>Đang đọc...</Text>
            </>
          ) : (
            <>
              <Ionicons name="camera" size={15} color="#ffffff" />
              <Text numberOfLines={1} style={styles.captureActionText}>Chụp</Text>
            </>
          )}
        </TouchableOpacity>

        <TouchableOpacity
          style={[styles.uploadActionBtn, (!activePallet || isScanning) && { opacity: 0.6 }]}
          disabled={isScanning || isCapturingForWeb}
          onPress={handlePickStampImage}
        >
          <Ionicons name="image-outline" size={14} color={isDark ? "#c084fc" : "#ffffff"} />
          <Text numberOfLines={1} style={styles.uploadActionText}>Tải ảnh</Text>
        </TouchableOpacity>

        <TouchableOpacity
          style={[styles.aiSendActionBtn, (!activePallet || isCapturingForWeb) && { opacity: 0.6 }]}
          disabled={isScanning || isCapturingForWeb}
          onPress={handleOpenSendToWeb}
        >
          {isCapturingForWeb ? (
            <ActivityIndicator color="#ffffff" size="small" />
          ) : (
            <>
              <Ionicons name="cloud-upload-outline" size={14} color={isDark ? "#fbbf24" : "#ffffff"} />
              <Text numberOfLines={1} style={styles.aiSendActionText}>Gửi AI</Text>
            </>
          )}
        </TouchableOpacity>

        <TouchableOpacity
          style={[styles.manualActionBtn, !activePallet && { opacity: 0.6 }]}
          onPress={() => {
            if (!activePallet) {
              openNewPalletModal();
              return;
            }
            const fillCount = activePallet
              ? Math.max(1, activePallet.target_qty - boxes.length)
              : defaultTargetQty;
            setManualCount(String(fillCount));
            setIsManualModal(true);
          }}
        >
          <Ionicons name="keypad-outline" size={14} color={isDark ? "#38bdf8" : "#ffffff"} />
          <Text numberOfLines={1} style={styles.manualActionText}>Nhập số</Text>
        </TouchableOpacity>

        {activePallet && boxes.length > 0 && (
          <TouchableOpacity
            style={styles.completeActionBtn}
            onPress={handleCompletePallet}
          >
            <Ionicons name="cube-outline" size={14} color="#ffffff" />
            <Text numberOfLines={1} style={styles.completeActionText}>Chốt</Text>
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
            <Ionicons name="cube-outline" size={32} color={isDark ? "#64748b" : "#059669"} />
            <Text style={styles.emptyText}>Chưa có Pallet nào đang chọn</Text>
            <TouchableOpacity onPress={() => openNewPalletModal()} style={{ marginTop: 8 }}>
              <Text style={{ color: isDark ? '#10b981' : '#059669', fontWeight: '800' }}>+ Bấm để chọn hoặc nhập Pallet mới</Text>
            </TouchableOpacity>
          </View>
        ) : boxes.length === 0 ? (
          <View style={styles.emptyBox}>
            <Ionicons name="finger-print-outline" size={32} color={isDark ? "#64748b" : "#059669"} />
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
                <Ionicons name="copy" size={15} color={isDark ? "#fbbf24" : "#047857"} />
                <Text style={styles.quickStampCloneText}>
                  ⚡ Nhân bản thùng #{boxes[boxes.length - 1].box_index} cho {activePallet.target_qty - boxes.length} thùng còn lại
                </Text>
                <Ionicons name="chevron-forward" size={15} color={isDark ? "#fbbf24" : "#047857"} />
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
                    <Ionicons name="copy-outline" size={16} color={isDark ? "#38bdf8" : "#059669"} />
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
                  <View style={{ backgroundColor: isDark ? '#1e1b4b' : '#f0fdf4', padding: 12, borderRadius: 14, borderWidth: 1, borderColor: isDark ? '#4338ca' : '#86efac', marginBottom: 12 }}>
                    <View style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', marginBottom: 4 }}>
                      <Text style={{ color: isDark ? '#a5b4fc' : '#15803d', fontSize: 10, fontWeight: '800', letterSpacing: 0.5 }}>
                        🔍 GIẢI MÃ TỨC THÌ (OFFLINE):
                      </Text>
                      {dec.is_special_12 && (
                        <View style={{ backgroundColor: '#065f46', paddingHorizontal: 6, paddingVertical: 2, borderRadius: 6, borderWidth: 1, borderColor: '#34d399' }}>
                          <Text style={{ color: '#6ee7b7', fontSize: 9, fontWeight: '800' }}>⭐ NGOẠI LỆ 12 SỐ</Text>
                        </View>
                      )}
                    </View>
                    {dec.product_name_full ? (
                      <Text style={{ color: isDark ? '#f8fafc' : '#0f172a', fontSize: 13, fontWeight: '700', marginBottom: 3 }}>
                        {dec.product_name_full} {dec.package_spec_name && !dec.is_special_12 ? `• ${dec.package_spec_name}` : ''}
                      </Text>
                    ) : (
                      <Text style={{ color: isDark ? '#94a3b8' : '#64748b', fontSize: 11, fontStyle: 'italic' }}>
                        Dòng 1 chưa đủ 12 ký tự để nhận diện sản phẩm
                      </Text>
                    )}
                    {dec.traceability_full && (
                      <Text style={{ color: isDark ? '#cbd5e1' : '#475569', fontSize: 11, lineHeight: 16 }}>
                        {dec.traceability_full}
                      </Text>
                    )}
                  </View>
                );
              })()}

              {/* Khối lượng thùng */}
              <View style={[styles.countInputRow, { marginBottom: 10 }]}>
                <View style={{ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' }}>
                  <Text style={styles.weightLabel}>Khối lượng thùng (Kg):</Text>
                  <TextInput
                    style={styles.weightInput}
                    value={pendingWeight}
                    onChangeText={setPendingWeight}
                    keyboardType="decimal-pad"
                  />
                </View>
                <View style={[styles.quickChipsRow, { marginTop: 8 }]}>
                  {['10', '15', '18', '20', '25'].map((w) => (
                    <TouchableOpacity
                      key={w}
                      style={[
                        styles.quickChip,
                        pendingWeight === w && { backgroundColor: 'rgba(14, 165, 233, 0.2)', borderColor: '#38bdf8' }
                      ]}
                      onPress={() => setPendingWeight(w)}
                    >
                      <Text
                        style={[
                          styles.quickChipText,
                          pendingWeight === w && { color: '#7dd3fc', fontWeight: '800' }
                        ]}
                      >
                        {w} Kg
                      </Text>
                    </TouchableOpacity>
                  ))}
                </View>
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
                      <Text style={styles.btnConfirmSaveText} numberOfLines={1} ellipsizeMode="tail">
                        {parseInt(pendingCount, 10) > 1
                          ? `Lưu (${pendingCount} Thùng) Vào ${activePallet?.code || ''}`
                          : `Lưu Vào Pallet ${activePallet?.code || ''}`}
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
        onRequestClose={() => {
          Keyboard.dismiss();
          setIsManualModal(false);
        }}
      >
        <KeyboardAvoidingView
          behavior={Platform.OS === 'ios' ? 'padding' : 'height'}
          style={[
            styles.modalBackdrop,
            isKeyboardVisible && {
              justifyContent: 'flex-start',
              paddingTop: Platform.OS === 'android' ? 24 : 44,
            },
          ]}
        >
          <View style={[styles.modalCard, { maxHeight: isKeyboardVisible ? '96%' : '88%', display: 'flex', flexDirection: 'column' }]}>
            <View style={styles.modalHeader}>
              <Text style={styles.modalTitle}>Nhập Dãy Số Con Dấu Thủ Công</Text>
              <TouchableOpacity onPress={() => {
                Keyboard.dismiss();
                setIsManualModal(false);
              }}>
                <Ionicons name="close" size={20} color="#94a3b8" />
              </TouchableOpacity>
            </View>

            <ScrollView
              showsVerticalScrollIndicator={false}
              keyboardShouldPersistTaps="handled"
              style={{ flexShrink: 1 }}
              contentContainerStyle={{ paddingBottom: 16 }}
            >
              <Text style={styles.inputLabel}>Dòng 1 (Ví dụ: 10102010204001):</Text>
              <TextInput
                style={styles.textInput}
                value={manualLine1}
                onChangeText={setManualLine1}
                placeholder="Nhập dòng 1"
                placeholderTextColor="#64748b"
                keyboardType="number-pad"
                returnKeyType="next"
              />

              <Text style={styles.inputLabel}>Dòng 2 (Ví dụ: 1110926001471609):</Text>
              <TextInput
                style={styles.textInput}
                value={manualLine2}
                onChangeText={setManualLine2}
                placeholder="Nhập dòng 2"
                placeholderTextColor="#64748b"
                keyboardType="number-pad"
                returnKeyType="next"
              />

              {/* Live preview giải mã trong modal thủ công */}
              {(() => {
                const dec = decodeStamp(manualLine1, manualLine2, dictMap, activeFormat);
                if (!dec.product_name_full && !dec.traceability_full) return null;
                return (
                  <View style={{ backgroundColor: isDark ? '#1e1b4b' : '#f0fdf4', padding: 10, borderRadius: 12, borderWidth: 1, borderColor: isDark ? '#4338ca' : '#86efac', marginVertical: 8 }}>
                    <View style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', marginBottom: 3 }}>
                      <Text style={{ color: isDark ? '#a5b4fc' : '#15803d', fontSize: 9, fontWeight: '800' }}>XEM TRƯỚC GIẢI MÃ:</Text>
                      {dec.is_special_12 && (
                        <View style={{ backgroundColor: '#065f46', paddingHorizontal: 5, paddingVertical: 1, borderRadius: 4, borderWidth: 1, borderColor: '#34d399' }}>
                          <Text style={{ color: '#6ee7b7', fontSize: 8, fontWeight: '800' }}>⭐ NGOẠI LỆ 12 SỐ</Text>
                        </View>
                      )}
                    </View>
                    {dec.product_name_full && (
                      <Text style={{ color: isDark ? '#f8fafc' : '#0f172a', fontSize: 12, fontWeight: '700', marginBottom: 2 }}>
                        {dec.product_name_full}
                      </Text>
                    )}
                    {dec.traceability_full && (
                      <Text style={{ color: isDark ? '#cbd5e1' : '#475569', fontSize: 10 }}>
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
                returnKeyType="next"
              />

              <Text style={styles.inputLabel}>Số lượng thùng tạo (Nhân bản):</Text>
              <TextInput
                style={[styles.textInput, parseInt(manualCount, 10) > 1 && { borderColor: '#fbbf24', color: '#fbbf24' }]}
                value={manualCount}
                onChangeText={setManualCount}
                placeholder="1"
                placeholderTextColor="#64748b"
                keyboardType="number-pad"
                returnKeyType="done"
                onSubmitEditing={() => Keyboard.dismiss()}
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

              <View style={[styles.modalActions, { marginTop: 14, borderTopWidth: 1, borderTopColor: '#334155', paddingTop: 12 }]}>
                <TouchableOpacity
                  style={styles.modalCancelBtn}
                  onPress={() => {
                    Keyboard.dismiss();
                    setIsManualModal(false);
                  }}
                >
                  <Text style={styles.modalCancelText}>Hủy</Text>
                </TouchableOpacity>

                <TouchableOpacity
                  style={styles.modalSaveBtn}
                  onPress={() => {
                    Keyboard.dismiss();
                    handleSaveManual();
                  }}
                >
                  <Text style={styles.modalSaveText}>Lưu Thùng</Text>
                </TouchableOpacity>
              </View>
            </ScrollView>
          </View>
        </KeyboardAvoidingView>
      </Modal>

      {/* ── MODAL CHỌN / ĐỔI PALLET ──────────────────────── */}
      <Modal
        visible={isNewPalletModal}
        transparent
        animationType="fade"
        onRequestClose={() => {
          Keyboard.dismiss();
          setIsNewPalletModal(false);
        }}
      >
        <KeyboardAvoidingView
          behavior={Platform.OS === 'ios' ? 'padding' : 'height'}
          style={[
            styles.modalBackdrop,
            isKeyboardVisible && {
              justifyContent: 'flex-start',
              paddingTop: Platform.OS === 'android' ? 24 : 44,
            },
          ]}
        >
          <View style={[styles.modalCard, { maxHeight: isKeyboardVisible ? '96%' : '88%', display: 'flex', flexDirection: 'column' }]}>
            <View style={styles.modalHeader}>
              <Text style={styles.modalTitle}>Chọn / Tạo Pallet Quét Dấu</Text>
              <TouchableOpacity onPress={() => {
                Keyboard.dismiss();
                setIsNewPalletModal(false);
              }}>
                <Ionicons name="close" size={20} color="#94a3b8" />
              </TouchableOpacity>
            </View>

            <ScrollView
              showsVerticalScrollIndicator={false}
              keyboardShouldPersistTaps="handled"
              style={{ flexShrink: 1 }}
              contentContainerStyle={{ paddingBottom: 16 }}
            >
              {/* HÀNG 1: STT PALLET & MỤC TIÊU SỐ THÙNG (SONG SONG) */}
              <View style={{ flexDirection: 'row', gap: 10 }}>
                <View style={{ flex: 1.25 }}>
                  <Text style={[styles.inputLabel, { marginTop: 0 }]}>Số STT Pallet *:</Text>
                  <TextInput
                    style={[styles.textInput, { paddingVertical: 8, fontSize: 15, fontWeight: '700' }]}
                    value={newPalletCode}
                    onChangeText={setNewPalletCode}
                    placeholder="VD: C544, G22..."
                    placeholderTextColor="#64748b"
                    autoCapitalize="characters"
                    returnKeyType="next"
                  />
                </View>

                <View style={{ flex: 1 }}>
                  <Text style={[styles.inputLabel, { marginTop: 0 }]}>Mục tiêu (Mặc định: {defaultTargetQty}):</Text>
                  <TextInput
                    style={[styles.textInput, { paddingVertical: 8, fontSize: 15, fontWeight: '700', textAlign: 'center' }]}
                    value={newTargetQty}
                    onChangeText={setNewTargetQty}
                    placeholder={String(defaultTargetQty)}
                    placeholderTextColor="#64748b"
                    keyboardType="number-pad"
                    returnKeyType="next"
                  />
                </View>
              </View>

              {/* HÀNG 2: DẤU TÍCH GHI NHỚ TỰ ĐỘNG CHỐT */}
              <TouchableOpacity
                style={{
                  flexDirection: 'row',
                  alignItems: 'center',
                  gap: 8,
                  marginTop: 8,
                  marginBottom: 6,
                  paddingVertical: 7,
                  paddingHorizontal: 10,
                  borderRadius: 8,
                  backgroundColor: autoCompleteOnFull
                    ? (isDark ? 'rgba(16, 185, 129, 0.14)' : '#ecfdf5')
                    : (isDark ? '#0f172a' : '#ffffff'),
                  borderWidth: 1,
                  borderColor: autoCompleteOnFull ? '#10b981' : (isDark ? '#334155' : '#cbd5e1'),
                }}
                onPress={handleToggleAutoComplete}
                activeOpacity={0.7}
              >
                <Ionicons
                  name={autoCompleteOnFull ? "checkbox" : "square-outline"}
                  size={20}
                  color={autoCompleteOnFull ? "#10b981" : (isDark ? "#94a3b8" : "#64748b")}
                />
                <View style={{ flex: 1 }}>
                  <Text style={{ color: autoCompleteOnFull ? (isDark ? '#34d399' : '#047857') : (isDark ? '#e2e8f0' : '#0f172a'), fontSize: 12, fontWeight: '700' }}>
                    Tự động chốt khi quét đủ {newTargetQty || defaultTargetQty} thùng
                  </Text>
                </View>
              </TouchableOpacity>

              {/* HÀNG 3: MÃ PHỤ (TAG) */}
              <Text style={[styles.inputLabel, { marginTop: 4 }]}>Mã phụ (Tag):</Text>
              <TextInput
                style={[styles.textInput, { paddingVertical: 8 }]}
                value={newPalletTag}
                onChangeText={setNewPalletTag}
                placeholder="Ví dụ: OEM-A, XK-HQ, HÀNG LOẠI 1..."
                placeholderTextColor="#64748b"
                autoCapitalize="characters"
                returnKeyType="next"
              />

              {/* HÀNG 4: GHI CHÚ PALLET / LOT HÀNG */}
              <Text style={[styles.inputLabel, { marginTop: 4 }]}>Ghi chú Pallet / LOT hàng:</Text>
              <TextInput
                style={[styles.textInput, { minHeight: 38, paddingVertical: 8 }]}
                value={newPalletNotes}
                onChangeText={setNewPalletNotes}
                placeholder="Nhập ghi chú cho LOT hàng (nếu có)..."
                placeholderTextColor="#64748b"
                returnKeyType="done"
                onSubmitEditing={() => Keyboard.dismiss()}
              />

              {/* HÀNG 5: CÁC NÚT HÀNH ĐỘNG NẰM TRONG SCROLLVIEW ĐẢM BẢO KHÔNG BỊ BÀN PHÍM CHE */}
              <View style={[styles.modalActions, { marginTop: 14, borderTopWidth: 1, borderTopColor: '#334155', paddingTop: 12 }]}>
                <TouchableOpacity
                  style={styles.modalCancelBtn}
                  onPress={() => {
                    Keyboard.dismiss();
                    setIsNewPalletModal(false);
                  }}
                >
                  <Text style={styles.modalCancelText}>Đóng</Text>
                </TouchableOpacity>

                <TouchableOpacity
                  style={styles.modalSaveBtn}
                  onPress={() => {
                    Keyboard.dismiss();
                    handleCreateNewPallet();
                  }}
                >
                  <Text style={styles.modalSaveText}>Xác Nhận Pallet</Text>
                </TouchableOpacity>
              </View>
            </ScrollView>
          </View>
        </KeyboardAvoidingView>
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
      {/* ── MODAL CHỤP CON DẤU LƯU VÀO PALLET & CHỜ GỬI GIẢI MÃ AI (GIỐNG QUÉT DẤU THƯỜNG) ──── */}
      <Modal
        visible={isSendToWebModal}
        transparent
        animationType="slide"
        onRequestClose={() => {
          if (!isSendingToWeb) setIsSendToWebModal(false);
        }}
      >
        <View style={styles.modalBackdrop}>
          <View style={[styles.confirmStampCard, { maxHeight: '90%' }]}>
            <View style={styles.confirmHeader}>
              <View style={styles.confirmTitleRow}>
                <Ionicons name="checkmark-circle" size={22} color="#10b981" />
                <Text style={styles.confirmTitle}>
                  ĐÃ CHỤP CON DẤU (STT: {activePallet?.code || ''})
                </Text>
              </View>
              <TouchableOpacity
                onPress={() => {
                  if (!isSendingToWeb) setIsSendToWebModal(false);
                }}
                disabled={isSendingToWeb}
              >
                <Ionicons name="close" size={22} color="#94a3b8" />
              </TouchableOpacity>
            </View>

            <ScrollView showsVerticalScrollIndicator={false} keyboardShouldPersistTaps="handled">
              {/* Khung ảnh con dấu vừa chụp (Thay thế phần giải mã offline) */}
              {sendPhotoUri && (
                <View style={{ backgroundColor: isDark ? '#0f172a' : '#f8fafc', padding: 10, borderRadius: 14, borderWidth: 1, borderColor: isDark ? '#334155' : '#e2e8f0', marginBottom: 10 }}>
                  <View style={[styles.sendPreviewContainer, { marginBottom: 8, height: 155 }]}>
                    <Image
                      source={{ uri: sendPhotoCropUri || sendPhotoUri }}
                      style={[styles.sendPreviewImage, { height: 155 }]}
                      resizeMode="contain"
                    />
                  </View>
                  <View style={{ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' }}>
                    <Text style={{ color: isDark ? '#a5b4fc' : '#059669', fontSize: 11, fontWeight: '700' }}>
                      📦 Lưu vào Pallet {activePallet?.code} ({boxes.length}/{activePallet?.target_qty || 30} thùng)
                    </Text>
                    <Text style={{ color: isDark ? '#94a3b8' : '#64748b', fontSize: 10 }}>
                      Đủ {activePallet?.target_qty || 30} thùng sẽ gửi giải mã
                    </Text>
                  </View>
                </View>
              )}

              {/* Khối lượng thùng (Kg) - Giống hệt Hình 2 */}
              <View style={[styles.countInputRow, { marginBottom: 10 }]}>
                <View style={{ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' }}>
                  <Text style={styles.weightLabel}>Khối lượng thùng (Kg):</Text>
                  <TextInput
                    style={styles.weightInput}
                    value={sendBoxWeight}
                    onChangeText={setSendBoxWeight}
                    keyboardType="decimal-pad"
                  />
                </View>
                <View style={[styles.quickChipsRow, { marginTop: 8 }]}>
                  {['10', '15', '18', '20', '25'].map((w) => (
                    <TouchableOpacity
                      key={w}
                      style={[
                        styles.quickChip,
                        sendBoxWeight === w && { backgroundColor: 'rgba(14, 165, 233, 0.2)', borderColor: '#38bdf8' }
                      ]}
                      onPress={() => setSendBoxWeight(w)}
                    >
                      <Text
                        style={[
                          styles.quickChipText,
                          sendBoxWeight === w && { color: '#7dd3fc', fontWeight: '800' }
                        ]}
                      >
                        {w} Kg
                      </Text>
                    </TouchableOpacity>
                  ))}
                </View>
              </View>

              {/* Số lượng thùng tạo (Nhân bản nhanh) - Giống hệt Hình 2 */}
              <View style={styles.countInputRow}>
                <View style={{ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' }}>
                  <Text style={styles.weightLabel}>Số lượng thùng tạo:</Text>
                  {parseInt(sendBoxCount, 10) > 1 && (
                    <Text style={styles.bulkNoticeTag}>Nhân bản {sendBoxCount} thùng</Text>
                  )}
                </View>
                <TextInput
                  style={[styles.countInput, parseInt(sendBoxCount, 10) > 1 && styles.countInputBulk]}
                  value={sendBoxCount}
                  onChangeText={setSendBoxCount}
                  keyboardType="number-pad"
                  placeholder="1"
                  placeholderTextColor="#64748b"
                />
                {activePallet && (
                  <View style={styles.quickChipsRow}>
                    <TouchableOpacity
                      style={[styles.quickChip, sendBoxCount === '1' && styles.quickChipActive]}
                      onPress={() => setSendBoxCount('1')}
                    >
                      <Text style={[styles.quickChipText, sendBoxCount === '1' && styles.quickChipActiveText]}>1 thùng</Text>
                    </TouchableOpacity>
                    {(activePallet.target_qty || 30) - boxes.length > 0 && (
                      <TouchableOpacity
                        style={[
                          styles.quickChip,
                          sendBoxCount === String(Math.max(1, (activePallet.target_qty || 30) - boxes.length)) && styles.quickChipActive
                        ]}
                        onPress={() => setSendBoxCount(String(Math.max(1, (activePallet.target_qty || 30) - boxes.length)))}
                      >
                        <Text
                          style={[
                            styles.quickChipText,
                            sendBoxCount === String(Math.max(1, (activePallet.target_qty || 30) - boxes.length)) && styles.quickChipActiveText
                          ]}
                        >
                          Điền đủ ({Math.max(1, (activePallet.target_qty || 30) - boxes.length)})
                        </Text>
                      </TouchableOpacity>
                    )}
                    {['5', '10', '20'].map((c) => (
                      <TouchableOpacity
                        key={c}
                        style={[styles.quickChip, sendBoxCount === c && styles.quickChipActive]}
                        onPress={() => setSendBoxCount(c)}
                      >
                        <Text style={[styles.quickChipText, sendBoxCount === c && styles.quickChipActiveText]}>+{c}</Text>
                      </TouchableOpacity>
                    ))}
                  </View>
                )}
              </View>
            </ScrollView>

            {/* Action Buttons - Giống hệt Hình 2 */}
            <View style={[styles.confirmActionRow, { marginTop: 12 }]}>
              <TouchableOpacity
                style={styles.btnRescan}
                onPress={() => setIsSendToWebModal(false)}
                disabled={isSendingToWeb}
              >
                <Ionicons name="refresh" size={16} color="#94a3b8" />
                <Text style={styles.btnRescanText}>Quét Lại</Text>
              </TouchableOpacity>

              <TouchableOpacity
                style={[styles.btnConfirmSave, isSendingToWeb && { opacity: 0.6 }]}
                onPress={handleConfirmSendToWeb}
                disabled={isSendingToWeb}
              >
                {isSendingToWeb ? (
                  <ActivityIndicator size="small" color="#fff" />
                ) : (
                  <>
                    <Ionicons name="save" size={16} color="#fff" />
                    <Text style={styles.btnConfirmSaveText} numberOfLines={1} ellipsizeMode="tail">
                      {parseInt(sendBoxCount, 10) > 1
                        ? `Lưu (${sendBoxCount} Thùng) Vào ${activePallet?.code || ''}`
                        : `Lưu Vào Pallet ${activePallet?.code || ''}`}
                    </Text>
                  </>
                )}
              </TouchableOpacity>
            </View>
          </View>
        </View>
      </Modal>

      {/* ── MODAL LỊCH SỬ GỬI DẤU LÊN WEB MẸ ──────────────────────── */}
      <Modal
        visible={isQueueHistoryModal}
        transparent
        animationType="slide"
        onRequestClose={() => setIsQueueHistoryModal(false)}
      >
        <View style={styles.modalBackdrop}>
          <View style={[styles.modalCard, { maxHeight: '85%' }]}>
            <View style={styles.modalHeader}>
              <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6 }}>
                <Ionicons name="time" size={20} color="#a5b4fc" />
                <Text style={styles.modalTitle}>Lịch Sử Gửi Giải Mã</Text>
              </View>
              <TouchableOpacity onPress={() => setIsQueueHistoryModal(false)}>
                <Ionicons name="close" size={20} color="#94a3b8" />
              </TouchableOpacity>
            </View>

            <View style={{ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', marginBottom: 10 }}>
              <Text style={{ color: '#94a3b8', fontSize: 12 }}>
                Các Pallet bạn đã chụp gửi lên hàng đợi ({queueHistory.length})
              </Text>
              <TouchableOpacity
                onPress={handleOpenQueueHistory}
                disabled={isLoadingQueueHistory}
                style={{ flexDirection: 'row', alignItems: 'center', gap: 4, paddingHorizontal: 8, paddingVertical: 4, backgroundColor: '#1e293b', borderRadius: 6 }}
              >
                <Ionicons name="refresh" size={13} color="#38bdf8" />
                <Text style={{ color: '#38bdf8', fontSize: 11, fontWeight: '700' }}>Làm mới</Text>
              </TouchableOpacity>
            </View>

            {isLoadingQueueHistory ? (
              <View style={{ padding: 30, alignItems: 'center' }}>
                <ActivityIndicator size="small" color="#38bdf8" />
                <Text style={{ color: '#94a3b8', fontSize: 12, marginTop: 8 }}>Đang tải hàng đợi...</Text>
              </View>
            ) : queueHistory.length === 0 ? (
              <View style={{ padding: 30, alignItems: 'center' }}>
                <Ionicons name="file-tray-outline" size={36} color="#64748b" />
                <Text style={{ color: '#94a3b8', fontSize: 13, marginTop: 8, textAlign: 'center' }}>
                  Chưa có Pallet nào được gửi giải mã.
                </Text>
              </View>
            ) : (
              <ScrollView showsVerticalScrollIndicator={false} style={{ maxHeight: 380 }}>
                {queueHistory.map((item) => {
                  const isApproved = item.status === 'approved';
                  const isDecoded = item.status === 'decoded';
                  const isError = item.status === 'error';

                  return (
                    <View key={item.id} style={styles.queueItemCard}>
                      <View style={{ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'flex-start' }}>
                        <View style={{ flex: 1 }}>
                          <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6, flexWrap: 'wrap' }}>
                            <Text style={styles.queueItemStt}>STT: {item.pallet_stt}</Text>
                            {item.pallet_tag && (
                              <View style={styles.queueTagBadge}>
                                <Text style={styles.queueTagText}>{item.pallet_tag}</Text>
                              </View>
                            )}
                            <Text style={{ color: '#94a3b8', fontSize: 11 }}>
                              {item.box_count} thùng • {item.box_weight} Kg
                            </Text>
                          </View>
                          {item.decoded_json?.productTitle && (
                            <Text style={styles.queueItemProd} numberOfLines={1}>
                              {item.decoded_json.productTitle}
                            </Text>
                          )}
                          <Text style={{ color: '#64748b', fontSize: 10, marginTop: 3 }}>
                            {new Date(item.created_at).toLocaleTimeString('vi-VN', { hour: '2-digit', minute: '2-digit' })}{' '}
                            {new Date(item.created_at).toLocaleDateString('vi-VN')}
                          </Text>
                        </View>

                        <View>
                          {isApproved ? (
                            <View style={[styles.queueStatusBadge, { backgroundColor: '#064e3b' }]}>
                              <Ionicons name="checkmark-circle" size={12} color="#34d399" />
                              <Text style={[styles.queueStatusText, { color: '#34d399' }]}>Đã duyệt</Text>
                            </View>
                          ) : isDecoded ? (
                            <View style={[styles.queueStatusBadge, { backgroundColor: '#312e81' }]}>
                              <Ionicons name="checkmark-done" size={12} color="#a5b4fc" />
                              <Text style={[styles.queueStatusText, { color: '#a5b4fc' }]}>Đã đọc số</Text>
                            </View>
                          ) : isError ? (
                            <View style={[styles.queueStatusBadge, { backgroundColor: '#4c0519' }]}>
                              <Ionicons name="alert-circle" size={12} color="#f43f5e" />
                              <Text style={[styles.queueStatusText, { color: '#f43f5e' }]}>Lỗi đọc</Text>
                            </View>
                          ) : (
                            <View style={[styles.queueStatusBadge, { backgroundColor: '#451a03' }]}>
                              <Ionicons name="time" size={12} color="#f59e0b" />
                              <Text style={[styles.queueStatusText, { color: '#f59e0b' }]}>Chờ duyệt</Text>
                            </View>
                          )}
                        </View>
                      </View>
                    </View>
                  );
                })}
              </ScrollView>
            )}

            <View style={[styles.modalActions, { justifyContent: 'flex-end', marginTop: 12 }]}>
              <TouchableOpacity
                style={styles.modalCancelBtn}
                onPress={() => setIsQueueHistoryModal(false)}
              >
                <Text style={styles.modalCancelText}>Đóng</Text>
              </TouchableOpacity>
            </View>
          </View>
        </View>
      </Modal>
    </View>
  );
}

const getStampStyles = (isDark: boolean) => StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: isDark ? '#0f172a' : '#ffffff',
  },
  centerContainer: {
    flex: 1,
    backgroundColor: isDark ? '#0f172a' : '#ffffff',
    justifyContent: 'center',
    alignItems: 'center',
    padding: 24,
  },
  permissionTitle: {
    fontSize: 18,
    fontWeight: '700',
    color: isDark ? '#f8fafc' : '#0f172a',
    marginTop: 16,
    marginBottom: 8,
  },
  permissionText: {
    fontSize: 14,
    color: isDark ? '#94a3b8' : '#64748b',
    textAlign: 'center',
    marginBottom: 20,
  },
  primaryBtn: {
    backgroundColor: '#059669',
    paddingHorizontal: 20,
    paddingVertical: 12,
    borderRadius: 12,
  },
  primaryBtnText: {
    color: '#ffffff',
    fontWeight: '700',
    fontSize: 14,
  },

  // Top Bar
  topBar: {
    backgroundColor: isDark ? 'rgba(15, 23, 42, 0.95)' : '#ffffff',
    paddingHorizontal: 16,
    paddingVertical: 10,
    borderBottomWidth: 1,
    borderBottomColor: isDark ? '#1e293b' : '#e2e8f0',
    ...(isDark ? {} : {
      shadowColor: '#059669',
      shadowOffset: { width: 0, height: 2 },
      shadowOpacity: 0.06,
      shadowRadius: 4,
      elevation: 2,
    }),
  },
  palletInfoRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
  },
  palletBadge: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: isDark ? '#1e293b' : '#f0fdf4',
    paddingHorizontal: 12,
    paddingVertical: 6,
    borderRadius: 10,
    borderWidth: 1,
    borderColor: isDark ? '#334155' : '#a7f3d0',
  },
  palletBadgeLabel: {
    fontSize: 10,
    fontWeight: '800',
    color: isDark ? '#fbbf24' : '#15803d',
    marginLeft: 4,
    marginRight: 6,
  },
  palletCodeText: {
    fontSize: 13,
    fontWeight: '700',
    color: isDark ? '#f8fafc' : '#0f172a',
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
    backgroundColor: isDark ? '#1e293b' : '#f0fdf4',
    justifyContent: 'center',
    alignItems: 'center',
    borderWidth: 1,
    borderColor: isDark ? '#334155' : '#bbf7d0',
  },
  iconButtonActive: {
    backgroundColor: isDark ? '#854d0e' : '#dcfce7',
    borderColor: isDark ? '#fbbf24' : '#10b981',
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
    backgroundColor: isDark ? 'rgba(239, 68, 68, 0.15)' : '#fee2e2',
    borderWidth: 1,
    borderColor: isDark ? '#ef4444' : '#fca5a5',
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
    color: isDark ? '#94a3b8' : '#475569',
  },
  progressHighlight: {
    color: isDark ? '#fbbf24' : '#059669',
    fontWeight: '700',
  },
  weightText: {
    fontSize: 12,
    color: isDark ? '#94a3b8' : '#475569',
  },
  progressBarBg: {
    height: 6,
    backgroundColor: isDark ? '#1e293b' : '#e2e8f0',
    borderRadius: 3,
    overflow: 'hidden',
  },
  progressBarFill: {
    height: '100%',
    backgroundColor: isDark ? '#fbbf24' : '#10b981',
  },
  progressBarFull: {
    backgroundColor: '#059669',
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
    backgroundColor: isDark ? 'rgba(15, 23, 42, 0.85)' : 'rgba(255, 255, 255, 0.92)',
    paddingHorizontal: 14,
    paddingVertical: 6,
    borderRadius: 20,
    marginBottom: 16,
    borderWidth: 1,
    borderColor: isDark ? 'rgba(251, 191, 36, 0.4)' : '#86efac',
  },
  reticleGuideText: {
    color: isDark ? '#f8fafc' : '#065f46',
    fontSize: 12,
    fontWeight: '700',
  },
  stampTargetFrame: {
    width: '90%',
    height: 140,
    borderRadius: 16,
    borderWidth: 1.5,
    borderColor: isDark ? 'rgba(251, 191, 36, 0.6)' : '#10b981',
    backgroundColor: isDark ? 'rgba(251, 191, 36, 0.04)' : 'rgba(16, 185, 129, 0.05)',
    justifyContent: 'center',
    paddingHorizontal: 16,
    position: 'relative',
  },
  stampTargetFrameScanning: {
    borderColor: '#10b981',
    backgroundColor: 'rgba(16, 185, 129, 0.12)',
  },
  corner: {
    position: 'absolute',
    width: 20,
    height: 20,
    borderColor: isDark ? '#fbbf24' : '#10b981',
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
    color: isDark ? '#fbbf24' : '#059669',
    backgroundColor: isDark ? 'rgba(15, 23, 42, 0.8)' : '#ffffff',
    paddingHorizontal: 6,
    paddingVertical: 2,
    borderRadius: 4,
    marginRight: 8,
  },
  lineGuideDash: {
    flex: 1,
    height: 1,
    backgroundColor: isDark ? 'rgba(251, 191, 36, 0.3)' : 'rgba(16, 185, 129, 0.4)',
    marginRight: 8,
  },
  lineGuideExample: {
    fontSize: 11,
    fontFamily: Platform.OS === 'ios' ? 'Menlo' : 'monospace',
    color: '#ffffff',
    fontWeight: '600',
    textShadowColor: 'rgba(0, 0, 0, 0.75)',
    textShadowOffset: { width: 0, height: 1 },
    textShadowRadius: 2,
  },
  reticleHintSub: {
    color: '#ffffff',
    fontSize: 11,
    marginTop: 14,
    backgroundColor: isDark ? 'rgba(15, 23, 42, 0.75)' : 'rgba(5, 150, 105, 0.85)',
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
    shadowOpacity: 0.25,
    shadowRadius: 6,
    elevation: 6,
  },
  bannerText: {
    color: '#ffffff',
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
    backgroundColor: isDark ? 'rgba(15, 23, 42, 0.7)' : 'rgba(255, 255, 255, 0.85)',
    justifyContent: 'center',
    alignItems: 'center',
  },
  scanningText: {
    color: isDark ? '#fbbf24' : '#059669',
    fontSize: 14,
    fontWeight: '700',
    marginTop: 12,
  },

  // Bottom Controls
  bottomControls: {
    backgroundColor: isDark ? 'rgba(15, 23, 42, 0.95)' : '#ffffff',
    paddingVertical: 16,
    paddingHorizontal: 24,
    borderTopWidth: 1,
    borderTopColor: isDark ? '#1e293b' : '#e2e8f0',
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
    color: isDark ? '#94a3b8' : '#059669',
    marginTop: 4,
  },
  shutterBtn: {
    width: 72,
    height: 72,
    borderRadius: 36,
    backgroundColor: isDark ? 'rgba(251, 191, 36, 0.3)' : 'rgba(16, 185, 129, 0.2)',
    justifyContent: 'center',
    alignItems: 'center',
    borderWidth: 2,
    borderColor: isDark ? '#fbbf24' : '#10b981',
  },
  shutterBtnDisabled: {
    opacity: 0.5,
  },
  shutterInner: {
    width: 58,
    height: 58,
    borderRadius: 29,
    backgroundColor: isDark ? '#fbbf24' : '#059669',
    justifyContent: 'center',
    alignItems: 'center',
  },

  // Modals
  modalBackdrop: {
    flex: 1,
    backgroundColor: 'rgba(0, 0, 0, 0.65)',
    justifyContent: 'center',
    alignItems: 'center',
    padding: 20,
  },
  confirmStampCard: {
    width: '100%',
    backgroundColor: isDark ? '#1e293b' : '#ffffff',
    borderRadius: 20,
    padding: 20,
    borderWidth: 1,
    borderColor: isDark ? '#334155' : '#e2e8f0',
  },
  confirmHeader: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    paddingBottom: 12,
    borderBottomWidth: 1,
    borderBottomColor: isDark ? '#334155' : '#e2e8f0',
  },
  confirmTitleRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
  },
  confirmTitle: {
    color: '#059669',
    fontWeight: '800',
    fontSize: 14,
    letterSpacing: 0.5,
  },
  stampResultBox: {
    marginVertical: 14,
    backgroundColor: isDark ? '#0f172a' : '#f8fafc',
    padding: 14,
    borderRadius: 14,
    borderWidth: 1,
    borderColor: isDark ? '#334155' : '#e2e8f0',
  },
  stampResultLine: {},
  stampLineLabel: {
    color: isDark ? '#94a3b8' : '#475569',
    fontSize: 10,
    fontWeight: '800',
    marginBottom: 4,
  },
  stampLineInput: {
    backgroundColor: isDark ? '#1e293b' : '#ffffff',
    color: isDark ? '#fbbf24' : '#047857',
    fontFamily: Platform.OS === 'ios' ? 'Menlo' : 'monospace',
    fontSize: 16,
    fontWeight: '800',
    paddingHorizontal: 12,
    paddingVertical: 8,
    borderRadius: 8,
    borderWidth: 1,
    borderColor: isDark ? '#475569' : '#cbd5e1',
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
    backgroundColor: isDark ? '#0f172a' : '#f8fafc',
    paddingHorizontal: 14,
    paddingVertical: 10,
    borderRadius: 12,
    borderWidth: 1,
    borderColor: isDark ? '#334155' : '#e2e8f0',
  },
  weightLabel: {
    color: isDark ? '#e2e8f0' : '#334155',
    fontSize: 13,
    fontWeight: '600',
  },
  weightInput: {
    backgroundColor: isDark ? '#1e293b' : '#ffffff',
    color: isDark ? '#f8fafc' : '#0f172a',
    fontSize: 15,
    fontWeight: '700',
    paddingHorizontal: 14,
    paddingVertical: 6,
    borderRadius: 8,
    width: 80,
    textAlign: 'center',
    borderWidth: 1,
    borderColor: isDark ? '#475569' : '#cbd5e1',
  },
  confirmActionRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
  },
  btnRescan: {
    paddingHorizontal: 16,
    paddingVertical: 12,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 6,
    borderRadius: 12,
    backgroundColor: isDark ? '#334155' : '#f1f5f9',
    borderWidth: 1,
    borderColor: isDark ? '#334155' : '#cbd5e1',
  },
  btnRescanText: {
    color: isDark ? '#e2e8f0' : '#475569',
    fontWeight: '700',
    fontSize: 13,
  },
  btnConfirmSave: {
    flex: 1,
    minWidth: 0,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 6,
    paddingVertical: 12,
    paddingHorizontal: 12,
    borderRadius: 12,
    backgroundColor: '#059669',
  },
  btnConfirmSaveText: {
    color: '#ffffff',
    fontWeight: '800',
    fontSize: 13,
  },

  modalCard: {
    width: '100%',
    backgroundColor: isDark ? '#1e293b' : '#ffffff',
    borderRadius: 18,
    padding: 16,
    borderWidth: 1,
    borderColor: isDark ? '#334155' : '#e2e8f0',
    ...(isDark ? {} : {
      shadowColor: '#000',
      shadowOffset: { width: 0, height: 4 },
      shadowOpacity: 0.12,
      shadowRadius: 12,
      elevation: 5,
    }),
  },
  modalHeader: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    marginBottom: 10,
  },
  modalTitle: {
    color: isDark ? '#f8fafc' : '#0f172a',
    fontWeight: '800',
    fontSize: 16,
  },
  inputLabel: {
    color: isDark ? '#94a3b8' : '#334155',
    fontSize: 11,
    fontWeight: '600',
    marginBottom: 3,
    marginTop: 4,
  },
  textInput: {
    backgroundColor: isDark ? '#0f172a' : '#ffffff',
    color: isDark ? '#f8fafc' : '#0f172a',
    fontSize: 14,
    fontWeight: '600',
    paddingHorizontal: 12,
    paddingVertical: 10,
    borderRadius: 10,
    borderWidth: 1,
    borderColor: isDark ? '#334155' : '#cbd5e1',
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
    backgroundColor: isDark ? '#334155' : '#f1f5f9',
    borderWidth: 1,
    borderColor: isDark ? '#334155' : '#cbd5e1',
  },
  modalCancelText: {
    color: isDark ? '#94a3b8' : '#475569',
    fontWeight: '600',
    fontSize: 13,
  },
  modalSaveBtn: {
    paddingHorizontal: 20,
    paddingVertical: 10,
    borderRadius: 10,
    backgroundColor: isDark ? '#fbbf24' : '#059669',
  },
  modalSaveText: {
    color: isDark ? '#0f172a' : '#ffffff',
    fontWeight: '800',
    fontSize: 13,
  },

  // Clone & Bulk styles
  quickStampCloneBanner: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: isDark ? 'rgba(251, 191, 36, 0.15)' : '#f0fdf4',
    borderWidth: 1,
    borderColor: isDark ? 'rgba(251, 191, 36, 0.5)' : '#86efac',
    borderRadius: 10,
    marginHorizontal: 16,
    marginBottom: 8,
    paddingHorizontal: 12,
    paddingVertical: 8,
    gap: 8,
  },
  quickStampCloneText: {
    flex: 1,
    color: isDark ? '#fbbf24' : '#047857',
    fontSize: 12,
    fontWeight: '700',
  },
  countInputRow: {
    marginBottom: 14,
  },
  countInput: {
    backgroundColor: isDark ? '#0f172a' : '#ffffff',
    color: isDark ? '#f8fafc' : '#0f172a',
    fontSize: 16,
    fontWeight: '700',
    paddingHorizontal: 12,
    paddingVertical: 8,
    borderRadius: 10,
    borderWidth: 1,
    borderColor: isDark ? '#334155' : '#cbd5e1',
  },
  countInputBulk: {
    borderColor: isDark ? '#fbbf24' : '#059669',
    color: isDark ? '#fbbf24' : '#059669',
  },
  bulkNoticeTag: {
    fontSize: 11,
    color: isDark ? '#fbbf24' : '#059669',
    fontWeight: '700',
  },
  quickChipsRow: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 6,
    marginTop: 8,
  },
  quickChip: {
    backgroundColor: isDark ? '#1e293b' : '#f8fafc',
    borderWidth: 1,
    borderColor: isDark ? '#334155' : '#e2e8f0',
    paddingHorizontal: 10,
    paddingVertical: 5,
    borderRadius: 8,
  },
  quickChipActive: {
    backgroundColor: isDark ? '#854d0e' : '#dcfce7',
    borderColor: isDark ? '#fbbf24' : '#10b981',
  },
  quickChipText: {
    color: isDark ? '#94a3b8' : '#64748b',
    fontSize: 11,
    fontWeight: '700',
  },
  quickChipActiveText: {
    color: isDark ? '#fbbf24' : '#047857',
    fontWeight: '800',
  },
  sampleBoxCard: {
    backgroundColor: isDark ? '#0f172a' : '#f8fafc',
    borderRadius: 10,
    padding: 10,
    marginBottom: 12,
    borderLeftWidth: 3,
    borderLeftColor: isDark ? '#fbbf24' : '#059669',
    borderWidth: 1,
    borderColor: isDark ? '#1e293b' : '#e2e8f0',
  },
  sampleBoxTitle: {
    color: isDark ? '#f8fafc' : '#0f172a',
    fontSize: 13,
    fontWeight: '700',
  },
  sampleBoxSub: {
    color: isDark ? '#94a3b8' : '#64748b',
    fontSize: 11,
    marginTop: 2,
  },
  sampleBoxMeta: {
    color: isDark ? '#cbd5e1' : '#475569',
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
    backgroundColor: isDark ? 'rgba(15, 23, 42, 0.85)' : '#ffffff',
    borderWidth: 1,
    borderColor: isDark ? 'rgba(248, 113, 113, 0.45)' : '#fca5a5',
    paddingHorizontal: 10,
    paddingVertical: 6,
    borderRadius: 999,
  },
  cameraTogglePillText: {
    color: isDark ? '#fecaca' : '#dc2626',
    fontSize: 11,
    fontWeight: '700',
  },
  cameraPausedContainer: {
    flex: 1,
    backgroundColor: isDark ? '#0b1220' : '#ffffff',
    justifyContent: 'center',
    alignItems: 'center',
    paddingHorizontal: 28,
  },
  cameraPausedIconCircle: {
    width: 72,
    height: 72,
    borderRadius: 36,
    backgroundColor: isDark ? '#1e293b' : '#f0fdf4',
    borderWidth: 1,
    borderColor: isDark ? '#334155' : '#bbf7d0',
    justifyContent: 'center',
    alignItems: 'center',
    marginBottom: 14,
  },
  cameraPausedTitle: {
    color: isDark ? '#f8fafc' : '#0f172a',
    fontSize: 16,
    fontWeight: '800',
    marginBottom: 6,
  },
  cameraPausedSub: {
    color: isDark ? '#94a3b8' : '#64748b',
    fontSize: 12,
    textAlign: 'center',
    lineHeight: 18,
    marginBottom: 18,
  },
  cameraEnableBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    backgroundColor: isDark ? '#fbbf24' : '#059669',
    paddingHorizontal: 20,
    paddingVertical: 11,
    borderRadius: 12,
  },
  cameraEnableBtnText: {
    color: isDark ? '#0f172a' : '#ffffff',
    fontSize: 14,
    fontWeight: '800',
  },
  noPalletTipBar: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    backgroundColor: isDark ? 'rgba(56, 189, 248, 0.1)' : '#f0fdf4',
    marginTop: 8,
    paddingHorizontal: 12,
    paddingVertical: 6,
    borderRadius: 8,
    borderWidth: 1,
    borderColor: isDark ? 'rgba(56, 189, 248, 0.25)' : '#86efac',
  },
  noPalletTipText: {
    color: isDark ? '#38bdf8' : '#166534',
    fontSize: 12,
    fontWeight: '600',
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
    backgroundColor: isDark ? 'rgba(56, 189, 248, 0.12)' : '#ecfdf5',
    paddingHorizontal: 10,
    paddingVertical: 6,
    borderRadius: 8,
    borderWidth: 1,
    borderColor: isDark ? 'rgba(56, 189, 248, 0.3)' : '#a7f3d0',
    gap: 6,
  },
  volumeKeyHintText: {
    color: isDark ? '#38bdf8' : '#047857',
    fontSize: 11,
    fontWeight: '700',
  },
  torchBtn: {
    padding: 7,
    borderRadius: 8,
    backgroundColor: isDark ? '#1e293b' : '#ffffff',
    borderWidth: 1,
    borderColor: isDark ? '#334155' : '#a7f3d0',
  },
  compactCameraBox: {
    height: 220,
    marginHorizontal: 16,
    borderRadius: 14,
    overflow: 'hidden',
    backgroundColor: '#000',
    position: 'relative',
    borderWidth: 1.5,
    borderColor: isDark ? '#334155' : '#86efac',
    ...(isDark ? {} : {
      shadowColor: '#059669',
      shadowOffset: { width: 0, height: 2 },
      shadowOpacity: 0.1,
      shadowRadius: 6,
      elevation: 3,
    }),
  },
  noPalletOverlay: {
    ...StyleSheet.absoluteFill,
    backgroundColor: isDark ? 'rgba(9, 13, 22, 0.92)' : '#ffffff',
    justifyContent: 'center',
    alignItems: 'center',
    padding: 20,
  },
  noPalletOverlayTitle: {
    color: isDark ? '#ffffff' : '#0f172a',
    fontSize: 16,
    fontWeight: '800',
    marginTop: 8,
  },
  noPalletOverlaySub: {
    color: isDark ? '#94a3b8' : '#64748b',
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
    backgroundColor: isDark ? '#10b981' : '#059669',
    paddingHorizontal: 18,
    paddingVertical: 9,
    borderRadius: 8,
    shadowColor: '#059669',
    shadowOffset: { width: 0, height: 2 },
    shadowOpacity: 0.2,
    shadowRadius: 4,
    elevation: 3,
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
    backgroundColor: isDark ? 'rgba(15, 23, 42, 0.35)' : 'rgba(255, 255, 255, 0.25)',
    borderRadius: 10,
    justifyContent: 'center',
    paddingHorizontal: 14,
    position: 'relative',
  },
  compactHintText: {
    marginTop: 8,
    color: '#ffffff',
    fontSize: 11,
    fontWeight: '700',
    backgroundColor: isDark ? 'rgba(15, 23, 42, 0.75)' : 'rgba(5, 150, 105, 0.85)',
    paddingHorizontal: 10,
    paddingVertical: 4,
    borderRadius: 8,
  },
  actionRow: {
    flexDirection: 'row',
    gap: 6,
    paddingHorizontal: 12,
    marginTop: 8,
    marginBottom: 8,
  },
  captureActionBtn: {
    flex: 1.15,
    backgroundColor: '#059669',
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 4,
    paddingVertical: 10,
    paddingHorizontal: 4,
    borderRadius: 8,
    shadowColor: '#059669',
    shadowOffset: { width: 0, height: 2 },
    shadowOpacity: 0.15,
    shadowRadius: 3,
    elevation: 2,
  },
  captureActionText: {
    color: '#ffffff',
    fontWeight: '700',
    fontSize: 12,
  },
  manualActionBtn: {
    flex: 1,
    backgroundColor: isDark ? '#0f2942' : '#059669',
    borderWidth: isDark ? 1.5 : 0,
    borderColor: isDark ? '#0284c7' : '#059669',
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 3,
    paddingVertical: 10,
    paddingHorizontal: 3,
    borderRadius: 8,
  },
  manualActionText: {
    color: isDark ? '#38bdf8' : '#ffffff',
    fontWeight: '700',
    fontSize: 11,
  },
  completeActionBtn: {
    flex: 1,
    backgroundColor: isDark ? '#7c3aed' : '#047857',
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 2,
    paddingVertical: 10,
    paddingHorizontal: 2,
    borderRadius: 8,
  },
  completeActionText: {
    color: '#fff',
    fontWeight: '700',
    fontSize: 11,
  },
  listHeaderRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    paddingHorizontal: 16,
    marginBottom: 6,
  },
  listHeaderTitle: {
    color: isDark ? '#94a3b8' : '#065f46',
    fontSize: 12,
    fontWeight: '800',
    textTransform: 'uppercase',
  },
  seeAllText: {
    color: isDark ? '#38bdf8' : '#059669',
    fontSize: 12,
    fontWeight: '700',
  },
  boxList: {
    flex: 1,
    paddingHorizontal: 16,
    backgroundColor: isDark ? 'transparent' : '#ffffff',
  },
  emptyBox: {
    alignItems: 'center',
    paddingVertical: 24,
  },
  emptyText: {
    color: isDark ? '#e2e8f0' : '#0f172a',
    fontSize: 14,
    fontWeight: '700',
    marginTop: 8,
  },
  emptySubText: {
    color: isDark ? '#64748b' : '#64748b',
    fontSize: 12,
    marginTop: 4,
    textAlign: 'center',
  },
  stampBoxCard: {
    backgroundColor: isDark ? '#131b2e' : '#ffffff',
    borderRadius: 10,
    padding: 10,
    marginBottom: 8,
    borderWidth: 1,
    borderColor: isDark ? '#1e293b' : '#e2e8f0',
    ...(isDark ? {} : {
      shadowColor: '#059669',
      shadowOffset: { width: 0, height: 1 },
      shadowOpacity: 0.05,
      shadowRadius: 3,
      elevation: 1,
    }),
  },
  stampBoxHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
  },
  stampBoxIndexBadge: {
    backgroundColor: isDark ? '#854d0e' : '#dcfce7',
    paddingHorizontal: 7,
    paddingVertical: 2,
    borderRadius: 6,
  },
  stampBoxIndexText: {
    color: isDark ? '#fbbf24' : '#15803d',
    fontSize: 11,
    fontWeight: '800',
  },
  stampBoxCodeText: {
    flex: 1,
    color: isDark ? '#e2e8f0' : '#0f172a',
    fontSize: 12,
    fontWeight: '700',
  },
  stampBoxWeightBadge: {
    backgroundColor: isDark ? '#064e3b' : '#ecfdf5',
    borderWidth: 1,
    borderColor: isDark ? '#064e3b' : '#a7f3d0',
    paddingHorizontal: 7,
    paddingVertical: 2,
    borderRadius: 6,
  },
  stampBoxWeightText: {
    color: isDark ? '#34d399' : '#047857',
    fontSize: 11,
    fontWeight: '700',
  },
  stampBoxTitle: {
    color: isDark ? '#f8fafc' : '#0f172a',
    fontSize: 13,
    fontWeight: '600',
    marginTop: 5,
  },
  stampBoxSub: {
    color: isDark ? '#94a3b8' : '#64748b',
    fontSize: 11,
    marginTop: 2,
  },
  uploadActionBtn: {
    flex: 1,
    backgroundColor: isDark ? '#3b0764' : '#059669',
    borderWidth: isDark ? 1.5 : 0,
    borderColor: isDark ? '#9333ea' : '#059669',
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 3,
    paddingVertical: 10,
    paddingHorizontal: 3,
    borderRadius: 8,
  },
  uploadActionText: {
    color: isDark ? '#f3e8ff' : '#ffffff',
    fontWeight: '700',
    fontSize: 11,
  },
  aiSendActionBtn: {
    flex: 1,
    backgroundColor: isDark ? '#4338ca' : '#059669',
    borderWidth: isDark ? 1.5 : 0,
    borderColor: isDark ? '#6366f1' : '#059669',
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 3,
    paddingVertical: 10,
    paddingHorizontal: 3,
    borderRadius: 8,
  },
  aiSendActionText: {
    color: '#ffffff',
    fontWeight: '800',
    fontSize: 11,
  },
  sendPreviewContainer: {
    width: '100%',
    height: 180,
    backgroundColor: isDark ? '#020617' : '#f8fafc',
    borderRadius: 12,
    overflow: 'hidden',
    position: 'relative',
    marginBottom: 12,
    borderWidth: 1,
    borderColor: isDark ? '#334155' : '#e2e8f0',
  },
  sendPreviewImage: {
    width: '100%',
    height: '100%',
  },
  driveBadgeOverlay: {
    position: 'absolute',
    bottom: 8,
    left: 8,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
    backgroundColor: 'rgba(5, 150, 105, 0.9)',
    paddingHorizontal: 8,
    paddingVertical: 4,
    borderRadius: 6,
  },
  driveBadgeText: {
    color: '#ffffff',
    fontSize: 10,
    fontWeight: '700',
  },
  sendPalletInfoBox: {
    backgroundColor: isDark ? '#1e293b' : '#f0fdf4',
    padding: 10,
    borderRadius: 10,
    marginBottom: 10,
    borderWidth: 1,
    borderColor: isDark ? '#334155' : '#bbf7d0',
  },
  sendPalletLabel: {
    color: isDark ? '#94a3b8' : '#15803d',
    fontSize: 11,
    fontWeight: '600',
  },
  sendPalletCode: {
    color: isDark ? '#38bdf8' : '#059669',
    fontSize: 16,
    fontWeight: '900',
    marginTop: 2,
  },
  sendPalletSub: {
    color: isDark ? '#fbbf24' : '#047857',
    fontSize: 11,
    marginTop: 2,
    fontWeight: '700',
  },
  sendExplainBox: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    gap: 6,
    backgroundColor: isDark ? 'rgba(56, 189, 248, 0.1)' : '#ecfdf5',
    padding: 10,
    borderRadius: 10,
    marginTop: 10,
    borderWidth: 1,
    borderColor: isDark ? 'rgba(56, 189, 248, 0.25)' : '#a7f3d0',
  },
  sendExplainText: {
    flex: 1,
    color: isDark ? '#bae6fd' : '#065f46',
    fontSize: 11,
    lineHeight: 16,
  },
  modalSendWebBtn: {
    paddingHorizontal: 18,
    paddingVertical: 10,
    borderRadius: 10,
    backgroundColor: '#059669',
  },
  modalSendWebText: {
    color: '#ffffff',
    fontWeight: '800',
    fontSize: 13,
  },
  queueItemCard: {
    backgroundColor: isDark ? '#1e293b' : '#ffffff',
    padding: 10,
    borderRadius: 10,
    marginBottom: 8,
    borderWidth: 1,
    borderColor: isDark ? '#334155' : '#e2e8f0',
  },
  queueItemStt: {
    color: isDark ? '#f8fafc' : '#0f172a',
    fontSize: 13,
    fontWeight: '800',
  },
  queueTagBadge: {
    backgroundColor: '#ea580c',
    paddingHorizontal: 5,
    paddingVertical: 1,
    borderRadius: 4,
  },
  queueTagText: {
    color: '#ffffff',
    fontSize: 10,
    fontWeight: '800',
  },
  queueItemProd: {
    color: isDark ? '#cbd5e1' : '#334155',
    fontSize: 11,
    marginTop: 2,
    fontWeight: '600',
  },
  queueStatusBadge: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
    paddingHorizontal: 7,
    paddingVertical: 3,
    borderRadius: 6,
  },
  queueStatusText: {
    fontSize: 10,
    fontWeight: '800',
  },
});
const baseStyles = getStampStyles(true);
const styles = StyleSheet.create(baseStyles as any);
