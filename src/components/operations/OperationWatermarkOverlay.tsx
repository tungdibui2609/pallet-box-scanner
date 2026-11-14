import React, { useEffect, useRef, useState } from 'react';
import { Image, StyleSheet, Text, View } from 'react-native';
import { captureRef } from 'react-native-view-shot';
import { registerWatermarkProcessor, WatermarkPayload } from '../../services/watermarkService';

interface RenderJob {
  payload: WatermarkPayload;
  width: number;
  height: number;
  verifyCode: string;
  resolve: (uri: string) => void;
}

const WEEKDAYS_VI = ['Chủ Nhật', 'Thứ Hai', 'Thứ Ba', 'Thứ Tư', 'Thứ Năm', 'Thứ Sáu', 'Thứ Bảy'];
const TARGET_WIDTH = 1080;

function getImageDimensions(uri: string, w?: number, h?: number): Promise<{ width: number; height: number }> {
  if (w && h && w > 0 && h > 0) {
    const ratio = h / w;
    return Promise.resolve({ width: TARGET_WIDTH, height: Math.max(600, Math.round(TARGET_WIDTH * ratio)) });
  }
  return new Promise((resolve) => {
    Image.getSize(
      uri,
      (imgW, imgH) => {
        const ratio = imgW > 0 ? imgH / imgW : 4 / 3;
        resolve({ width: TARGET_WIDTH, height: Math.max(600, Math.round(TARGET_WIDTH * ratio)) });
      },
      () => {
        resolve({ width: TARGET_WIDTH, height: Math.round(TARGET_WIDTH * (4 / 3)) });
      }
    );
  });
}

export default function OperationWatermarkOverlay() {
  const [job, setJob] = useState<RenderJob | null>(null);
  const viewRef = useRef<any>(null);
  const queueRef = useRef<Promise<void>>(Promise.resolve());
  const capturedRef = useRef(false);

  useEffect(() => {
    const processOne = (payload: WatermarkPayload): Promise<string> => {
      const task = queueRef.current.then(
        () =>
          new Promise<string>(async (resolve) => {
            try {
              const dims = await getImageDimensions(payload.uri, payload.width, payload.height);
              const verifyCode = Math.random().toString(36).substring(2, 10).toUpperCase();
              capturedRef.current = false;

              const timer = setTimeout(() => {
                if (!capturedRef.current) {
                  capturedRef.current = true;
                  setJob(null);
                  resolve(payload.uri);
                }
              }, 4500);

              setJob({
                payload,
                width: dims.width,
                height: dims.height,
                verifyCode,
                resolve: (outUri: string) => {
                  clearTimeout(timer);
                  setJob(null);
                  resolve(outUri);
                },
              });
            } catch {
              resolve(payload.uri);
            }
          })
      );
      queueRef.current = task.then(
        () => undefined,
        () => undefined
      );
      return task;
    };

    registerWatermarkProcessor(processOne);
    return () => {
      registerWatermarkProcessor(null);
    };
  }, []);

  const handleImageLoaded = () => {
    if (!job || capturedRef.current) return;
    setTimeout(async () => {
      if (!job || capturedRef.current || !viewRef.current) return;
      capturedRef.current = true;
      try {
        const uri = await captureRef(viewRef.current, {
          format: 'jpg',
          quality: 0.82,
          result: 'tmpfile',
          width: job.width,
          height: job.height,
        });
        job.resolve(uri || job.payload.uri);
      } catch (err) {
        console.warn('captureRef watermark error:', err);
        job.resolve(job.payload.uri);
      }
    }, 110);
  };

  if (!job) return null;

  const { payload, width, height } = job;
  const dt = payload.capturedAt || new Date();
  const hh = String(dt.getHours()).padStart(2, '0');
  const mm = String(dt.getMinutes()).padStart(2, '0');
  const dd = String(dt.getDate()).padStart(2, '0');
  const mo = String(dt.getMonth() + 1).padStart(2, '0');
  const timeStr = `${hh}:${mm}`;
  const dateStr = `${dd}/${mo}/${dt.getFullYear()}`;
  const weekdayStr = WEEKDAYS_VI[dt.getDay()];

  const dirLabel = payload.direction === 'in' ? 'NHẬP +' : payload.direction === 'out' ? 'XUẤT -' : '';
  const qtyStr =
    payload.quantity != null ? `${dirLabel}${payload.quantity}${payload.unit ? ` ${payload.unit}` : ''}` : '';

  return (
    <View style={styles.offscreen} pointerEvents="none">
      <View
        ref={viewRef}
        collapsable={false}
        style={{ width, height, backgroundColor: '#000', position: 'relative', overflow: 'hidden' }}
      >
        <Image
          source={{ uri: payload.uri }}
          style={{ width, height }}
          resizeMode="cover"
          onLoadEnd={handleImageLoaded}
          onError={() => {
            if (!capturedRef.current) {
              capturedRef.current = true;
              job.resolve(payload.uri);
            }
          }}
        />

        {/* Dải đóng dấu gọn sát đáy ảnh: bên trái nội dung (SP 1 dòng, SL 1 dòng), bên phải thời gian & NV */}
        <View style={styles.bottomBackdrop}>
          <View style={styles.leftContentColumn}>
            {payload.jobName ? (
              <Text style={styles.locationText} numberOfLines={1}>
                📍 {payload.jobName}
              </Text>
            ) : null}

            {payload.itemName ? (
              <Text style={styles.itemText} numberOfLines={1}>
                📦 {payload.itemName}
              </Text>
            ) : null}

            {qtyStr ? (
              <Text
                style={[
                  styles.qtyText,
                  payload.direction === 'out' ? { color: '#fda4af' } : { color: '#fbbf24' },
                ]}
                numberOfLines={1}
              >
                SL: {qtyStr}
              </Text>
            ) : null}
          </View>

          <View style={styles.rightMetaColumn}>
            <Text style={styles.timeText}>{timeStr}</Text>
            <Text style={styles.dateText}>{dateStr} • {weekdayStr}</Text>

            {payload.capturedByName ? (
              <Text style={styles.userText} numberOfLines={1}>
                👤 {payload.capturedByName}
              </Text>
            ) : null}
          </View>
        </View>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  offscreen: {
    position: 'absolute',
    left: -5000,
    top: 0,
  },
  bottomBackdrop: {
    position: 'absolute',
    left: 0,
    right: 0,
    bottom: 0,
    backgroundColor: 'rgba(0, 0, 0, 0.52)',
    paddingHorizontal: 18,
    paddingTop: 10,
    paddingBottom: 12,
    flexDirection: 'row',
    alignItems: 'flex-end',
    justifyContent: 'space-between',
    gap: 12,
  },
  leftContentColumn: {
    flex: 1,
    alignItems: 'flex-start',
    justifyContent: 'flex-end',
    gap: 2,
  },
  locationText: {
    color: '#ffffff',
    fontSize: 17,
    fontWeight: '700',
  },
  itemText: {
    color: '#fde68a',
    fontSize: 18,
    fontWeight: '700',
  },
  qtyText: {
    fontSize: 18,
    fontWeight: '800',
  },
  rightMetaColumn: {
    flexShrink: 0,
    alignItems: 'flex-end',
    justifyContent: 'flex-end',
    gap: 2,
  },
  timeText: {
    color: '#ffffff',
    fontSize: 22,
    fontWeight: '800',
    letterSpacing: -0.3,
    textAlign: 'right',
    textShadowColor: 'rgba(0,0,0,0.8)',
    textShadowOffset: { width: 0, height: 1 },
    textShadowRadius: 3,
  },
  dateText: {
    color: '#f1f5f9',
    fontSize: 14,
    fontWeight: '600',
    textAlign: 'right',
  },
  userText: {
    color: '#cbd5e1',
    fontSize: 14,
    fontWeight: '600',
    textAlign: 'right',
  },
});
