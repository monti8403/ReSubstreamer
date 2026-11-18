import React, { useEffect } from 'react';
import { StyleSheet } from 'react-native';
import Animated, {
  Easing,
  interpolate,
  runOnJS,
  useAnimatedProps,
  useAnimatedStyle,
  useSharedValue,
  withDelay,
  withSequence,
  withTiming,
} from 'react-native-reanimated';
import Svg, { G, Path } from 'react-native-svg';

/** Stessa geometria di assets/logo-atrum.svg (viewBox 1024). */
const ICE = '#F4F6FA';
const BG = '#000000';
const VIEWBOX = 1024;
/** Deve combaciare con "imageWidth" di expo-splash-screen in app.json. */
export const SPLASH_LOGO_SIZE = 200;

const LOGO_PATH = 'M480 200H544V360H600L752 800H672L542 424H482L352 800H272L424 360H480Z';
const INNER_PATH = 'M498.9 595.0L525.1 595.0L554.5 680.0L469.5 680.0Z';
const LOGO_TRANSFORM = 'translate(0 12)';

/** Onde di risonanza: chevron squadrati che salgono dalla punta dello stelo. */
const CHEV_DX = 100;
const CHEV_DY = 70;

function chevronPath(y: number): string {
  'worklet';
  return `M${512 - CHEV_DX} ${y + CHEV_DY}L512 ${y}L${512 + CHEV_DX} ${y + CHEV_DY}`;
}

const AnimatedPath = Animated.createAnimatedComponent(Path);

type Props = {
  /** Chiamato appena l'overlay è montato e dipinto: qui si nasconde lo splash nativo. */
  onReady?: () => void;
  /** Se false l'animazione resta in attesa (es. font/DB non pronti). Default true. */
  canExit?: boolean;
  /** Chiamato a handoff completato: smonta l'overlay. */
  onFinish: () => void;
};

export function AtrumAnimatedSplash({ onReady, canExit = true, onFinish }: Props) {
  const pulse = useSharedValue(1);
  const ring1 = useSharedValue(0);
  const ring2 = useSharedValue(0);
  const exit = useSharedValue(0); // 0 = visibile, 1 = dissolto
  const introDone = useSharedValue(0);

  // Intro: frame 0 identico allo splash nativo, poi micro-impulso di risonanza.
  useEffect(() => {
    const ease = Easing.out(Easing.cubic);
    pulse.value = withSequence(
      withDelay(120, withTiming(1.035, { duration: 90, easing: ease })),
      withTiming(1, { duration: 220, easing: Easing.out(Easing.quad) }),
    );
    ring1.value = withDelay(140, withTiming(1, { duration: 420, easing: ease }));
    ring2.value = withDelay(
      230,
      withTiming(1, { duration: 420, easing: ease }, (done) => {
        if (done) introDone.value = 1;
      }),
    );
  }, [pulse, ring1, ring2, introDone]);

  // Handoff: parte solo a intro finita E app pronta.
  useEffect(() => {
    if (!canExit) return;
    const id = setInterval(() => {
      if (introDone.value === 1) {
        clearInterval(id);
        exit.value = withTiming(
          1,
          { duration: 220, easing: Easing.inOut(Easing.quad) },
          (done) => {
            if (done) runOnJS(onFinish)();
          },
        );
      }
    }, 16);
    return () => clearInterval(id);
  }, [canExit, exit, introDone, onFinish]);

  const containerStyle = useAnimatedStyle(() => ({ opacity: 1 - exit.value }));
  const logoStyle = useAnimatedStyle(() => ({
    transform: [{ scale: pulse.value * (1 + 0.04 * exit.value) }],
  }));

  const ring1Props = useAnimatedProps(() => ({
    d: chevronPath(interpolate(ring1.value, [0, 1], [150, 50])),
    opacity: interpolate(ring1.value, [0, 0.25, 1], [0, 0.85, 0]),
  }));
  const ring2Props = useAnimatedProps(() => ({
    d: chevronPath(interpolate(ring2.value, [0, 1], [150, 50])),
    opacity: interpolate(ring2.value, [0, 0.25, 1], [0, 0.55, 0]),
  }));

  return (
    <Animated.View
      style={[StyleSheet.absoluteFill, styles.container, containerStyle]}
      pointerEvents="auto"
      onLayout={onReady}
    >
      <Animated.View style={logoStyle}>
        <Svg width={SPLASH_LOGO_SIZE} height={SPLASH_LOGO_SIZE} viewBox={`0 0 ${VIEWBOX} ${VIEWBOX}`}>
          <G transform={LOGO_TRANSFORM}>
            <Path d={LOGO_PATH} fill={ICE} />
            <Path d={INNER_PATH} fill={ICE} />
            <G fill="none" stroke={ICE} strokeWidth={20} strokeLinecap="butt" strokeLinejoin="miter">
              <AnimatedPath animatedProps={ring1Props} />
              <AnimatedPath animatedProps={ring2Props} />
            </G>
          </G>
        </Svg>
      </Animated.View>
    </Animated.View>
  );
}

const styles = StyleSheet.create({
  container: {
    backgroundColor: BG,
    alignItems: 'center',
    justifyContent: 'center',
    zIndex: 9999,
  },
});
