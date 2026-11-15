import React, { useEffect, useRef, useState } from 'react';
import {
  Modal,
  View,
  Text,
  TouchableOpacity,
  ScrollView,
  Image,
  StyleSheet,
  ActivityIndicator,
  SafeAreaView,
} from 'react-native';
import { CameraView, useCameraPermissions } from 'expo-camera';
import { Ionicons } from '@expo/vector-icons';
import type { DeliveryShift } from '../../services/operationsService';
import type { LocalPickedImage } from '../../services/operationImagesService';

interface Props {
  visible: boolean;
  openShifts: DeliveryShift[];
  initialShiftId: string | null;
  totalQueueCount: number;
  lastThumbUri?: string | null;
  onClose: () => void;
  onOpenQueue: () => void;
  onCaptured: (payload: { shift: DeliveryShift; image: LocalPickedImage }) => void;
}

export default function QuickSnapCameraModal({
  visible,
  openShifts,
  initialShiftId,
  totalQueueCount,
  lastThumbUri,
  onClose,
  onOpenQueue,
  onCaptured,
}: Props) {
  const [permission, requestPermission] = useCameraPermissions();
  const cameraRef = useRef<CameraView | null>(null);
  const [targetShiftId, setTargetShiftId] = useState<string>(initialShiftId || '');
  const [flash, setFlash] = useState<'off' | 'on'>('off');
  const [capturing, setCapturing] = useState(false);
  const [flashBlink, setFlashBlink] = useState(false);
  const [sessionCount, setSessionCount] = useState(0);
  const [sessionLastUri, setSessionLastUri] = useState<string | null>(null);

  useEffect(() => {
    if (!visible) return;
    setTargetShiftId(initialShiftId || openShifts[0]?.id || '');
    setSessionCount(0);
    setSessionLastUri(null);
    if (permission && !permission.granted) {
      void requestPermission();
    }
  }, [visible, initialShiftId, openShifts, permission, requestPermission]);

  const activeShift =
    openShifts.find(s => s.id === targetShiftId) || openShifts[0] || null;

  const handleShutter = async () => {
    if (!cameraRef.current || capturing || !activeShift) return;
    setCapturing(true);
    try {
      const pic = await cameraRef.current.takePictureAsync({
        quality: 0.72,
        skipProcessing: false,
      });
      if (pic?.uri) {
        setFlashBlink(true);
        setTimeout(() => setFlashBlink(false), 110);

        const img: LocalPickedImage = {
          localId: `qcam_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`,
          uri: pic.uri,
          originalUri: pic.uri,
          width: pic.width,
          height: pic.height,
          mimeType: 'image/jpeg',
        };
        setSessionLastUri(pic.uri);
        setSessionCount(c => c + 1);
        onCaptured({ shift: activeShift, image: img });
      }
    } catch (e) {
      console.warn('QuickSnapCameraModal takePicture error:', e);
    } finally {
      setCapturing(false);
    }
  };

  const previewThumb = sessionLastUri || lastThumbUri || null;

  return (
    <Modal visible={visible} animationType="fade" onRequestClose={onClose}>
      <SafeAreaView style={styles.container}>
        {!permission?.granted ? (
          <View style={styles.permBox}>
            <Ionicons name="camera-outline" size={44} color="#38bdf8" />
            <Text style={styles.permTitle}>Cần quyền Camera để chụp nhanh</Text>
            <TouchableOpacity onPress={requestPermission} style={styles.permBtn}>
              <Text style={styles.permBtnText}>Cấp quyền Camera</Text>
            </TouchableOpacity>
            <TouchableOpacity onPress={onClose} style={styles.permCloseBtn}>
              <Text style={styles.permCloseText}>Đóng</Text>
            </TouchableOpacity>
          </View>
        ) : (
          <View style={{ flex: 1 }}>
            <CameraView
              ref={cameraRef}
              style={StyleSheet.absoluteFill}
              facing="back"
              flash={flash}
            />

            {flashBlink && <View style={styles.shutterFlash} pointerEvents="none" />}

            {/* Thanh trên: Đóng + Flash + Dải chọn nhanh Công việc */}
            <View style={styles.topOverlay}>
              <View style={styles.topActions}>
                <TouchableOpacity onPress={onClose} style={styles.iconCircle}>
                  <Ionicons name="close" size={22} color="#fff" />
                </TouchableOpacity>

                <View style={styles.topBadge}>
                  <Text style={styles.topBadgeText}>
                    CHỤP NHANH{sessionCount > 0 ? ` • +${sessionCount}` : ''}
                  </Text>
                </View>

                <TouchableOpacity
                  onPress={() => setFlash(f => (f === 'off' ? 'on' : 'off'))}
                  style={[styles.iconCircle, flash === 'on' && styles.iconCircleActive]}
                >
                  <Ionicons
                    name={flash === 'on' ? 'flash' : 'flash-off'}
                    size={20}
                    color={flash === 'on' ? '#0f172a' : '#fff'}
                  />
                </TouchableOpacity>
              </View>

              {/* Dải chọn nhanh Công việc đang mở */}
              {openShifts.length > 0 && (
                <ScrollView
                  horizontal
                  showsHorizontalScrollIndicator={false}
                  contentContainerStyle={styles.shiftPillsRow}
                >
                  {openShifts.map(s => {
                    const isSel = activeShift?.id === s.id;
                    const label = s.summary_data?.job_name || s.notes || 'Công việc';
                    return (
                      <TouchableOpacity
                        key={s.id}
                        onPress={() => setTargetShiftId(s.id)}
                        style={[styles.shiftPill, isSel && styles.shiftPillActive]}
                      >
                        <View
                          style={[
                            styles.shiftDot,
                            { backgroundColor: isSel ? '#fff' : '#22c55e' },
                          ]}
                        />
                        <Text
                          style={[styles.shiftPillText, isSel && styles.shiftPillTextActive]}
                          numberOfLines={1}
                        >
                          {label}
                        </Text>
                      </TouchableOpacity>
                    );
                  })}
                </ScrollView>
              )}
            </View>

            {/* Thanh đáy: Thumbnail nhỏ góc trái + Nút chụp BỤP lớn ở giữa + Nút Xong */}
            <View style={styles.bottomOverlay}>
              <TouchableOpacity
                onPress={() => {
                  onClose();
                  onOpenQueue();
                }}
                disabled={!previewThumb && totalQueueCount === 0}
                style={styles.thumbSlot}
              >
                {previewThumb ? (
                  <View style={styles.thumbWrap}>
                    <Image source={{ uri: previewThumb }} style={styles.thumbImg} />
                    {totalQueueCount > 0 && (
                      <View style={styles.thumbBadge}>
                        <Text style={styles.thumbBadgeText}>{totalQueueCount}</Text>
                      </View>
                    )}
                  </View>
                ) : (
                  <View style={styles.thumbEmpty}>
                    <Ionicons name="images-outline" size={20} color="#94a3b8" />
                  </View>
                )}
              </TouchableOpacity>

              <TouchableOpacity
                onPress={handleShutter}
                disabled={capturing || !activeShift}
                activeOpacity={0.75}
                style={styles.shutterOuter}
              >
                <View style={styles.shutterInner}>
                  {capturing ? (
                    <ActivityIndicator size="small" color="#0f172a" />
                  ) : null}
                </View>
              </TouchableOpacity>

              <TouchableOpacity onPress={onClose} style={styles.doneBtn}>
                <Text style={styles.doneBtnText}>Xong</Text>
              </TouchableOpacity>
            </View>
          </View>
        )}
      </SafeAreaView>
    </Modal>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: '#000',
  },
  permBox: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    padding: 24,
    gap: 14,
  },
  permTitle: {
    color: '#fff',
    fontSize: 15,
    fontWeight: '800',
    textAlign: 'center',
  },
  permBtn: {
    paddingHorizontal: 20,
    paddingVertical: 12,
    borderRadius: 12,
    backgroundColor: '#0284c7',
  },
  permBtnText: {
    color: '#fff',
    fontWeight: '800',
    fontSize: 14,
  },
  permCloseBtn: {
    paddingHorizontal: 16,
    paddingVertical: 8,
  },
  permCloseText: {
    color: '#94a3b8',
    fontWeight: '700',
  },
  shutterFlash: {
    position: 'absolute',
    top: 0,
    left: 0,
    right: 0,
    bottom: 0,
    backgroundColor: 'rgba(255,255,255,0.65)',
  },
  topOverlay: {
    position: 'absolute',
    top: 0,
    left: 0,
    right: 0,
    paddingTop: 12,
    paddingBottom: 10,
    backgroundColor: 'rgba(0,0,0,0.48)',
  },
  topActions: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: 14,
  },
  iconCircle: {
    width: 40,
    height: 40,
    borderRadius: 20,
    backgroundColor: 'rgba(15,23,42,0.75)',
    alignItems: 'center',
    justifyContent: 'center',
  },
  iconCircleActive: {
    backgroundColor: '#fbbf24',
  },
  topBadge: {
    paddingHorizontal: 12,
    paddingVertical: 6,
    borderRadius: 999,
    backgroundColor: 'rgba(15,23,42,0.8)',
    borderWidth: 1,
    borderColor: 'rgba(56,189,248,0.45)',
  },
  topBadgeText: {
    color: '#7dd3fc',
    fontSize: 11,
    fontWeight: '900',
    letterSpacing: 0.4,
  },
  shiftPillsRow: {
    paddingHorizontal: 14,
    paddingTop: 10,
    gap: 8,
  },
  shiftPill: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    paddingHorizontal: 12,
    paddingVertical: 7,
    borderRadius: 999,
    backgroundColor: 'rgba(15,23,42,0.82)',
    borderWidth: 1,
    borderColor: 'rgba(148,163,184,0.35)',
    maxWidth: 210,
  },
  shiftPillActive: {
    backgroundColor: '#4f46e5',
    borderColor: '#a5b4fc',
  },
  shiftDot: {
    width: 7,
    height: 7,
    borderRadius: 4,
  },
  shiftPillText: {
    color: '#cbd5e1',
    fontSize: 12,
    fontWeight: '700',
  },
  shiftPillTextActive: {
    color: '#fff',
    fontWeight: '900',
  },
  bottomOverlay: {
    position: 'absolute',
    bottom: 0,
    left: 0,
    right: 0,
    paddingVertical: 20,
    paddingHorizontal: 24,
    backgroundColor: 'rgba(0,0,0,0.55)',
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
  },
  thumbSlot: {
    width: 58,
    height: 58,
    alignItems: 'center',
    justifyContent: 'center',
  },
  thumbWrap: {
    width: 54,
    height: 54,
    borderRadius: 10,
    overflow: 'visible',
    borderWidth: 2,
    borderColor: '#fff',
  },
  thumbImg: {
    width: 50,
    height: 50,
    borderRadius: 8,
  },
  thumbBadge: {
    position: 'absolute',
    top: -7,
    right: -7,
    minWidth: 22,
    height: 22,
    borderRadius: 11,
    backgroundColor: '#f59e0b',
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: 5,
    borderWidth: 1.5,
    borderColor: '#000',
  },
  thumbBadgeText: {
    color: '#0f172a',
    fontSize: 11,
    fontWeight: '900',
  },
  thumbEmpty: {
    width: 50,
    height: 50,
    borderRadius: 10,
    borderWidth: 1,
    borderColor: 'rgba(148,163,184,0.4)',
    backgroundColor: 'rgba(15,23,42,0.7)',
    alignItems: 'center',
    justifyContent: 'center',
  },
  shutterOuter: {
    width: 76,
    height: 76,
    borderRadius: 38,
    borderWidth: 4,
    borderColor: '#fff',
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: 'rgba(255,255,255,0.18)',
  },
  shutterInner: {
    width: 60,
    height: 60,
    borderRadius: 30,
    backgroundColor: '#fff',
    alignItems: 'center',
    justifyContent: 'center',
  },
  doneBtn: {
    minWidth: 58,
    paddingHorizontal: 14,
    paddingVertical: 10,
    borderRadius: 12,
    backgroundColor: 'rgba(30,41,59,0.9)',
    borderWidth: 1,
    borderColor: 'rgba(148,163,184,0.35)',
    alignItems: 'center',
  },
  doneBtnText: {
    color: '#fff',
    fontSize: 13,
    fontWeight: '800',
  },
});
